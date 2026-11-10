const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { lockWorkDir, readStateFile, saveState, writerIsActive } = require('../run-state.cjs');
const { runEpisode } = require('../runner.cjs');
const { inspectReview } = require('../review.cjs');
const contract = require('./contract.cjs');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const active = new Set(['generating', 'content_check', 'preflighting', 'applying', 'rendering']);
const runtimeFailure = error => error.generationRetryable === false ||
  ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EMFILE', 'ENFILE', 'EIO'].includes(error.code);

const preflightFailureStatus = error => error.code === 'CONTENT_REVIEW_REQUIRED' ? 'needs_review'
  : typeof error.code === 'string' && error.code.startsWith('CONTENT_') ? 'content_failed' : 'preflight_failed';

function requestIdentifier(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) {
    throw new Error('A full review request ID is required.');
  }
  return value;
}

function inside(root, file, label, mustExist = true) {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the repository.`);
  }
  const anchor = mustExist ? absolute : path.dirname(absolute);
  const real = path.relative(fs.realpathSync(root), fs.realpathSync(anchor));
  if (real === '..' || real.startsWith('..' + path.sep) || path.isAbsolute(real)) {
    throw new Error(`${label} resolves outside the repository.`);
  }
  return absolute;
}

function revisionDirectory(root, requestId) {
  return path.join(root, 'runs', '_revisions', requestIdentifier(requestId));
}

function readJson(bytes) {
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

function readArtifact(directory, file, digest) {
  const absolute = inside(directory, file, 'Revision artifact');
  const bytes = fs.readFileSync(absolute);
  if (hash(bytes) !== digest) throw new Error('Saved revision artifact changed; refusing to apply it.');
  return bytes;
}

function sameFile(file, digest) {
  return hash(fs.readFileSync(file)) === digest;
}

function fail(directory, state, error, status = 'failed') {
  state.status = status;
  state.error = error.message;
  state.updatedAt = new Date().toISOString();
  saveState(directory, state);
}

function resultFrom(state, reused = false) {
  return { requestId: state.requestId, episodeId: state.episodeId, status: state.status,
    changes: state.changes, summary: state.summary, oldVideoPath: state.oldVideoPath,
    newVideoPath: state.newVideoPath, oldRevision: state.oldRevision,
    newRevision: state.newRevision, reused };
}

async function reviseEpisode(root, {
  episodeId, episodeFile, workDir, createStages, requestId, scope = 'both',
  provider, preflight, contentChecker, maxAttempts = 3, log = () => {},
}) {
  root = fs.realpathSync(root);
  if (typeof episodeId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,119}$/.test(episodeId)) throw new Error('Invalid episode ID.');
  requestIdentifier(requestId);
  if (!['visual', 'narration', 'both'].includes(scope)) throw new Error('Revision scope must be visual, narration or both.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error('maxAttempts must be 1–5.');
  if (typeof createStages !== 'function' || typeof preflight !== 'function') throw new Error('Revision requires stage creation and speech timing preflight.');
  episodeFile = inside(root, episodeFile, 'Episode input');
  if (!fs.statSync(episodeFile).isFile()) throw new Error('Episode input must be a file.');
  const expectedWorkDir = path.join(root, 'runs', episodeId);
  if (path.resolve(workDir) !== expectedWorkDir) throw new Error('Episode work directory does not match its ID.');
  workDir = inside(root, expectedWorkDir, 'Episode work directory');
  const directory = revisionDirectory(root, requestId);
  fs.mkdirSync(directory, { recursive: true });
  inside(root, directory, 'Revision directory');
  const releaseRevision = await lockWorkDir(directory, 'Revision request');
  let state;
  try {
    state = readStateFile(directory);
    const relativeInput = path.relative(root, episodeFile).split(path.sep).join('/');
    if (state && (state.version !== 1 || state.episodeId !== episodeId || state.requestId !== requestId ||
        state.scope !== scope || state.episodeFile !== relativeInput || !Array.isArray(state.attempts))) {
      throw new Error('Revision journal belongs to a different request, episode or scope.');
    }

    const releaseEpisode = await lockWorkDir(workDir, 'Episode');
    try {
      if (state?.status === 'ready_for_review') {
        if (!sameFile(episodeFile, state.afterSha256)) throw new Error('This request was already applied, but the episode input has changed. Use the current review request.');
        const current = await inspectReview(workDir, createStages());
        if (current.revision !== state.newRevision) throw new Error('This request was already applied, but its output changed. Rebuild or review the current episode.');
        return { ...resultFrom(state, true), status: current.status };
      }

      if (!state) {
        const current = await inspectReview(workDir, createStages());
        const request = current.history.find(event => event.id === requestId);
        if (!request || request.action !== 'request-changes') throw new Error('Unknown change request for this episode.');
        if (current.status !== 'changes_requested' || current.revision !== request.revision || current.latestDecision?.id !== requestId) {
          throw new Error('Change request is stale or superseded. Review the current video and submit a new request.');
        }
        const before = fs.readFileSync(episodeFile);
        // Validate the source before invoking any model; the contract also resolves the target.
        const source = readJson(before);
        contract.buildPrompt({ source, request, scope });
        const beforeFile = path.join(directory, 'before.json');
        if (fs.existsSync(beforeFile)) {
          if (hash(fs.readFileSync(beforeFile)) !== hash(before)) throw new Error('An incomplete revision snapshot does not match the current input.');
        } else fs.writeFileSync(beforeFile, before, { flag: 'wx' });
        state = { version: 1, episodeId, episodeFile: relativeInput, requestId, scope, request,
          sourceFile: 'before.json', sourceSha256: hash(before), oldRevision: current.revision,
          oldVideoPath: current.videoPath, oldReportPath: current.reportPath,
          status: 'new', attempts: [], createdAt: new Date().toISOString() };
        saveState(directory, state);
      }

      const source = readJson(readArtifact(directory, state.sourceFile, state.sourceSha256));
      async function assertUnapplied() {
        if (!sameFile(episodeFile, state.sourceSha256)) throw new Error('Episode input changed since this request started. No revision was applied.');
        const current = await inspectReview(workDir, createStages());
        if (current.status !== 'changes_requested' || current.revision !== state.oldRevision || current.latestDecision?.id !== requestId) {
          throw new Error('The reviewed video or latest decision changed. No revision was applied.');
        }
      }

      const afterAlreadyPublished = state.afterSha256 && sameFile(episodeFile, state.afterSha256);
      if (afterAlreadyPublished) {
        readArtifact(directory, state.afterFile, state.afterSha256);
        const review = await inspectReview(workDir, createStages());
        if (review.latestDecision?.id !== requestId) throw new Error('A newer review decision superseded this revision.');
        state.status = 'applied';
        delete state.error;
        saveState(directory, state);
        log('저장된 수정 명세로 영상 제작을 재개합니다.');
      } else {
        await assertUnapplied();
        let assertContentCurrent = () => {};
        let previous;
        let feedback = state.error;
        const prior = state.pending || state.accepted || [...state.attempts].reverse().find(attempt => attempt.candidateFile);
        if (prior) previous = readJson(readArtifact(directory, prior.candidateFile, prior.candidateSha256));

        async function validateCandidate(candidate, attempt) {
          const revision = contract.applyRevision(candidate, { source, request: state.request, scope });
          state.pending = { candidateFile: attempt.candidateFile, candidateSha256: attempt.candidateSha256 };
          state.status = 'content_check';
          attempt.status = 'content_check';
          saveState(directory, state);
          const checkDir = path.join(directory, `check-${randomUUID().slice(0, 8)}`);
          fs.mkdirSync(checkDir);
          try {
            const content = await require('../content/runtime.cjs').reviewEpisodeContent({ root, episodeFile,
              story: revision.story, directory: path.join(checkDir, 'content'), checker: contentChecker, provider, log });
            assertContentCurrent = content?.assertCurrent || (() => {});
            if (content) {
              state.contentReportFile = path.relative(directory, path.join(checkDir, 'content', 'report.json')).split(path.sep).join('/');
              state.contentSourceHash = content.report.sourceHash;
              attempt.contentReportFile = state.contentReportFile;
            }
          } catch (error) {
            if (error.contentReportPath) {
              state.contentReportFile = path.relative(directory, error.contentReportPath).split(path.sep).join('/');
              attempt.contentReportFile = state.contentReportFile;
            }
            throw error;
          }
          state.status = 'preflighting';
          attempt.status = 'preflighting';
          saveState(directory, state);
          await preflight({ source, story: revision.story, changes: revision.changes, request: state.request,
            directory: checkDir, workDir, stages: createStages() });
          assertContentCurrent();
          // Only story fields originate from the contract. Preserve catalog-specific metadata.
          const bytes = json({ ...source, ...revision.story });
          const afterFile = `after-${randomUUID().slice(0, 8)}.json`;
          fs.writeFileSync(path.join(directory, afterFile), bytes, { flag: 'wx' });
          state.afterFile = afterFile;
          state.afterSha256 = hash(bytes);
          state.changes = revision.changes;
          state.summary = revision.summary;
          state.accepted = { candidateFile: attempt.candidateFile, candidateSha256: attempt.candidateSha256 };
          delete state.pending;
          delete state.error;
          attempt.status = 'accepted';
          attempt.finishedAt = new Date().toISOString();
          delete attempt.error;
          state.status = 'validated';
          saveState(directory, state);
        }

        let validated = false;
        const resumable = state.pending || state.accepted;
        if (resumable) {
          const attempt = state.attempts.find(item => item.candidateFile === resumable.candidateFile);
          if (!attempt) throw new Error('Revision candidate has no attempt record.');
          log('저장된 수정 후보의 검증을 재개합니다.');
          try {
            await validateCandidate(previous, attempt);
            validated = true;
          } catch (error) {
            attempt.error = error.message;
            if (error.code === 'REVISION_UNSUPPORTED') {
              attempt.status = 'unsupported';
              fail(directory, state, error, 'unsupported');
              throw error;
            }
            if (runtimeFailure(error)) {
              attempt.status = preflightFailureStatus(error);
              fail(directory, state, error, attempt.status);
              throw error;
            }
            attempt.status = 'rejected';
            feedback = error.message;
            delete state.pending;
            delete state.accepted;
            delete state.afterFile;
            delete state.afterSha256;
            fail(directory, state, error);
          }
        }

        for (let index = 0; !validated && index < maxAttempts; index++) {
          if (typeof provider !== 'function') throw new Error('A revision model provider is required.');
          await assertUnapplied();
          const attempt = { id: state.attempts.length + 1, status: 'generating',
            directory: `attempt-${state.attempts.length + 1}-${randomUUID().slice(0, 8)}`,
            startedAt: new Date().toISOString() };
          const attemptDir = path.join(directory, attempt.directory);
          fs.mkdirSync(attemptDir);
          state.attempts.push(attempt);
          state.status = 'generating';
          delete state.error;
          saveState(directory, state);
          log(`수정 명세 생성 ${index + 1}/${maxAttempts} (누적 ${attempt.id})`);
          let candidate;
          try {
            candidate = await provider({ prompt: contract.buildPrompt({ source, request: state.request, scope, feedback, previous }),
              schema: contract.outputSchema, directory: path.join(attemptDir, 'provider') });
            const bytes = json(candidate);
            attempt.candidateFile = attempt.directory + '/candidate.json';
            fs.writeFileSync(path.join(directory, attempt.candidateFile), bytes, { flag: 'wx' });
            attempt.candidateSha256 = hash(bytes);
            saveState(directory, state);
          } catch (error) {
            attempt.status = 'provider_failed';
            attempt.error = error.message;
            fail(directory, state, error, 'provider_failed');
            throw error;
          }
          try {
            await validateCandidate(candidate, attempt);
            validated = true;
          } catch (error) {
            attempt.error = error.message;
            attempt.finishedAt = new Date().toISOString();
            if (error.code === 'REVISION_UNSUPPORTED') {
              attempt.status = 'unsupported';
              fail(directory, state, error, 'unsupported');
              throw error;
            }
            if (runtimeFailure(error)) {
              attempt.status = preflightFailureStatus(error);
              fail(directory, state, error, attempt.status);
              throw error;
            }
            attempt.status = 'rejected';
            delete state.pending;
            feedback = error.message;
            previous = candidate;
            fail(directory, state, error);
            log('수정 후보 자동 보완: ' + error.message);
          }
        }
        if (!validated) throw new Error(`Revision did not pass validation after ${maxAttempts} attempts: ${state.error}`);

        await assertUnapplied();
        assertContentCurrent();
        const after = readArtifact(directory, state.afterFile, state.afterSha256);
        state.status = 'applying';
        saveState(directory, state);
        const temporary = path.join(path.dirname(episodeFile), `revision-${randomUUID()}.tmp`);
        try {
          fs.writeFileSync(temporary, after, { flag: 'wx' });
          if (!sameFile(episodeFile, state.sourceSha256)) throw new Error('Episode input changed immediately before publication.');
          assertContentCurrent();
          fs.renameSync(temporary, episodeFile);
        } finally {
          if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
        state.status = 'applied';
        state.appliedAt = new Date().toISOString();
        saveState(directory, state);
      }
    } catch (error) {
      if (state && !['ready_for_review', 'failed', 'provider_failed', 'preflight_failed', 'content_failed', 'needs_review', 'unsupported'].includes(state.status)) fail(directory, state, error, 'conflict');
      throw error;
    } finally {
      await releaseEpisode();
    }

    try {
      if (!sameFile(episodeFile, state.afterSha256)) throw new Error('Episode input changed before rendering this revision.');
      state.status = 'rendering';
      saveState(directory, state);
      // runEpisode owns its episode lock. Each stage additionally checks that a manual edit did
      // not replace this request's input while the rendering process was waiting or running.
      const guard = () => {
        if (!sameFile(episodeFile, state.afterSha256)) throw new Error('Episode input changed while rendering this revision.');
      };
      const stages = createStages().map(stage => ({ ...stage,
        inputs: async () => { guard(); return stage.inputs(); },
        run: async context => { guard(); await stage.run(context); guard(); },
      }));
      await runEpisode(workDir, stages, { log });
      const releaseFinal = await lockWorkDir(workDir, 'Episode');
      try {
        guard();
        const current = await inspectReview(workDir, createStages());
        if (current.latestDecision?.id !== requestId || current.status !== 'ready_for_review' || !current.revision || current.revision === state.oldRevision) {
          throw new Error('The completed video or review decision changed; this revision is not ready for review.');
        }
        state.status = 'ready_for_review';
        state.newRevision = current.revision;
        state.newVideoPath = current.videoPath;
        state.newReportPath = current.reportPath;
        state.completedAt = new Date().toISOString();
        delete state.error;
        saveState(directory, state);
        return resultFrom(state);
      } finally { await releaseFinal(); }
    } catch (error) {
      fail(directory, state, error, 'render_failed');
      throw error;
    }
  } finally {
    await releaseRevision();
  }
}

async function inspectRevision(root, requestId) {
  const directory = revisionDirectory(root, requestId);
  const state = readStateFile(directory);
  if (!state) return undefined;
  if (active.has(state.status) && await writerIsActive(directory) === false) {
    return { ...state, previousStatus: state.status, status: 'interrupted' };
  }
  return state;
}

module.exports = { reviseEpisode, inspectRevision };
