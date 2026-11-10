const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { readCatalog, commitGeneratedBatch } = require('../planning.cjs');
const { lockWorkDir, readStateFile, saveState, writerIsActive } = require('../run-state.cjs');
const { readSeriesHistory } = require('../novelty/history.cjs');
const contract = require('./contract.cjs');

const activeStatuses = ['generating', 'semantic_check', 'content_check', 'preflighting', 'committing'];
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(value) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value)) {
    throw new Error(`${label} must be a safe identifier of at most 48 characters.`);
  }
}

function workDirectory(root, batchId) {
  identifier(batchId, 'Batch ID');
  return path.join(root, 'runs', '_generation', batchId);
}

function requestHash(series, count) {
  return hash(JSON.stringify({ contractVersion: 1, seriesId: series.id, count, series }));
}

function readContext(root, seriesId, batchId, count, requestKey) {
  const catalog = readCatalog(root);
  if (!Object.hasOwn(catalog.series, seriesId)) throw new Error('Unknown series: ' + seriesId);
  const series = catalog.series[seriesId];
  if (series.adapter !== 'pipeline/story/adapter.cjs') {
    throw new Error('Automatic generation currently requires the pipeline/story/adapter.cjs series adapter.');
  }
  contract.validateGenerationSeries(series);
  if (requestKey && requestHash(series, count) !== requestKey) {
    throw new Error('Series settings changed during this generation. Use a new batch ID.');
  }
  const recorded = catalog.generations?.[batchId];
  if (recorded) {
    if (recorded.seriesId !== seriesId || recorded.requestKey !== (requestKey || requestHash(series, count))) {
      throw new Error('Batch ID already exists with a different generation request.');
    }
    if (!Array.isArray(recorded.episodeIds) || recorded.episodeIds.length !== count ||
        JSON.stringify(catalog.batches[batchId]) !== JSON.stringify(recorded.episodeIds) ||
        recorded.episodeIds.some(id => !Object.hasOwn(catalog.episodes, id))) {
      throw new Error('Generated batch registry is incomplete; repair the catalog before retrying.');
    }
  } else {
    if (Object.hasOwn(catalog.batches, batchId)) throw new Error('Batch ID already belongs to another batch: ' + batchId);
    let legacy;
    try { legacy = JSON.parse(fs.readFileSync(path.join(root, 'pipeline', 'batches.json'), 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (legacy && Object.hasOwn(legacy, batchId)) throw new Error('Batch ID already belongs to a legacy batch: ' + batchId);
  }
  // Completed historical runs remain reusable without loading every original input again.
  return { series, recorded, ...(recorded ? { history: [], historyHash: null } : readSeriesHistory(root, catalog, seriesId)) };
}

function stateFile(workDir, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Invalid generation artifact path.');
  const file = path.resolve(workDir, relative);
  const inside = path.relative(workDir, file);
  if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) {
    throw new Error('Generation artifact is outside its run directory.');
  }
  const actual = path.relative(fs.realpathSync(workDir), fs.realpathSync(file));
  if (actual === '..' || actual.startsWith('..' + path.sep) || path.isAbsolute(actual)) {
    throw new Error('Generation artifact resolves outside its run directory.');
  }
  return file;
}

function readCandidate(workDir, record) {
  const bytes = fs.readFileSync(stateFile(workDir, record.candidatePath));
  if (hash(bytes) !== record.candidateSha256) throw new Error('Saved generation candidate changed; refusing to commit it.');
  return JSON.parse(bytes.toString('utf8'));
}

function candidateRecord(attempt) {
  return { candidatePath: attempt.candidatePath, candidateSha256: attempt.candidateSha256, directory: attempt.directory };
}

function rememberFailure(workDir, state, error, status = 'failed') {
  state.status = status;
  state.error = error.message;
  state.updatedAt = new Date().toISOString();
  saveState(workDir, state);
}

function validateReport(report, entries) {
  if (!report || !['passed', 'duplicates', 'needs_review'].includes(report.status) ||
      !Array.isArray(report.comparisons) || !Array.isArray(report.profiles)) throw new Error('Invalid semantic review report.');
  const ids = new Set(entries.map(entry => entry.plan.id));
  for (const field of ['duplicatePlanIds', 'reviewPlanIds']) {
    if (!Array.isArray(report[field]) || new Set(report[field]).size !== report[field].length || report[field].some(id => !ids.has(id))) {
      throw new Error('Semantic review returned unknown or duplicate plan IDs.');
    }
  }
  if ((report.status === 'passed' && (report.duplicatePlanIds.length || report.reviewPlanIds.length)) ||
      (report.status === 'duplicates' && (!report.duplicatePlanIds.length || report.reviewPlanIds.length)) ||
      (report.status === 'needs_review' && !report.reviewPlanIds.length)) throw new Error('Semantic review status contradicts its decisions.');
  if (report.status === 'passed' && report.comparisons.some(item => item.verdict !== 'distinct' || !ids.has(item.candidateId))) {
    throw new Error('Passed semantic review contains unresolved comparisons.');
  }
  if (report.profiles.length !== ids.size || new Set(report.profiles.map(item => item.planId)).size !== ids.size ||
      report.profiles.some(item => !ids.has(item.planId) || !item.knowledge ||
        !['core', 'example'].every(key => typeof item.knowledge[key] === 'string' && item.knowledge[key].trim()))) {
    throw new Error('Semantic review must provide one knowledge profile per candidate.');
  }
  return report;
}

async function generateBatch(root, {
  seriesId, batchId, count = 3, provider, maxAttempts = 3, preflight, noveltyCheck, contentCheck, log = () => {},
}) {
  identifier(seriesId, 'Series ID');
  const workDir = workDirectory(root, batchId);
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Generation count must be 1–10.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error('maxAttempts must be 1–5 per invocation.');
  if (typeof preflight !== 'function') throw new Error('A speech and scene timing preflight is required before production.');
  const initial = readContext(root, seriesId, batchId, count);
  const requestKey = requestHash(initial.series, count);
  fs.mkdirSync(workDir, { recursive: true });
  const release = await lockWorkDir(workDir, 'Generation');
  try {
    const context = readContext(root, seriesId, batchId, count, requestKey);
    let state = readStateFile(workDir);
    if (state && (state.version !== 1 || state.requestKey !== requestKey || !Array.isArray(state.attempts))) {
      throw new Error('Generation journal belongs to another request or unsupported version. Use a new batch ID.');
    }
    if (!state) state = { version: 1, seriesId, batchId, count, requestKey, status: 'new', attempts: [], createdAt: new Date().toISOString() };
    if (context.recorded) {
      state.status = 'committed';
      state.episodeIds = context.recorded.episodeIds;
      delete state.error;
      saveState(workDir, state);
      log('기존 자동 생성 묶음을 재사용합니다.');
      return { batchId, episodeIds: context.recorded.episodeIds, reused: true };
    }
    if (typeof noveltyCheck !== 'function') throw new Error('A semantic novelty check is required before generating new episodes.');
    const contentRequired = context.series.contentReview?.mode === 'required';
    if (contentRequired && typeof contentCheck !== 'function') throw new Error('A source-grounded content check is required for this series.');
    // Disabled/legacy series keep their existing request identity and do not imply factual verification.
    const readEvidence = series => contentRequired ? require('../content/sources.cjs').readEvidenceBundle(root, series) : undefined;

    const clearPending = () => {
      for (const name of ['accepted', 'preflightPending', 'semanticPending', 'contentPending', 'reviewPending']) delete state[name];
    };
    let pending = state.accepted || state.preflightPending || state.contentPending || state.semanticPending || state.reviewPending || state.repair?.base;
    // Recover an interrupted attempt saved just before assigning its pending pointer.
    if (!pending && ['generating', 'semantic_check', 'content_check', 'preflighting'].includes(state.status)) {
      pending = [...state.attempts].reverse().find(attempt => attempt.candidatePath);
    }
    let previous;
    const last = [...state.attempts].reverse().find(attempt => attempt.candidatePath);
    if (last) previous = readCandidate(workDir, last);
    let feedback = state.error;
    let calls = 0;

    while (true) {
      if (pending) {
        const record = candidateRecord(pending);
        const candidate = readCandidate(workDir, record);
        const attempt = state.attempts.find(item => item.candidatePath === record.candidatePath);
        if (!attempt) throw new Error('Saved candidate has no generation attempt.');
        let current;
        let entries;
        try {
          current = readContext(root, seriesId, batchId, count, requestKey);
        } catch (error) {
          // Missing or changed history/configuration cannot be repaired by rewriting a candidate.
          state.semanticPending = record;
          attempt.status = 'semantic_failed'; attempt.error = error.message;
          rememberFailure(workDir, state, error, 'semantic_failed');
          throw error;
        }
        try {
          entries = contract.validateGenerated(candidate, { ...current, count, batchId, checkDuplicates: false });
        } catch (error) {
          attempt.status = 'rejected'; attempt.error = error.message;
          clearPending();
          feedback = error.message; previous = candidate;
          rememberFailure(workDir, state, error);
          pending = null;
          continue;
        }

        let report;
        const semanticDir = path.join(workDir, 'semantic-' + randomUUID().slice(0, 8));
        fs.mkdirSync(semanticDir);
        state.semanticPending = record;
        state.status = 'semantic_check'; attempt.status = 'semantic_check';
        saveState(workDir, state);
        log('기존 회차와 새 묶음의 의미 중복을 검사합니다.');
        try {
          report = validateReport(await noveltyCheck({ series: current.series, history: current.history, entries, directory: semanticDir }), entries);
          const reportFile = path.join(semanticDir, 'decision.json');
          fs.writeFileSync(reportFile, json(report));
          state.semanticReport = report;
          state.semanticReportFile = path.relative(workDir, reportFile).split(path.sep).join('/');
          state.semanticHistoryHash = current.historyHash;
          state.semanticCandidateSha256 = record.candidateSha256;
          attempt.semanticReportFile = state.semanticReportFile;
          saveState(workDir, state);
          if (readContext(root, seriesId, batchId, count, requestKey).historyHash !== current.historyHash) {
            throw Object.assign(new Error('Series history changed during semantic review. Retry to compare the saved candidate against current history.'), { code: 'SEMANTIC_HISTORY_CHANGED' });
          }
        } catch (error) {
          attempt.status = 'semantic_failed'; attempt.error = error.message;
          rememberFailure(workDir, state, error, 'semantic_failed');
          throw error;
        }

        if (report.status === 'needs_review') {
          clearPending(); state.reviewPending = record;
          delete state.repair;
          attempt.status = 'needs_review';
          const error = new Error('Semantic review needs human review: ' + report.reviewPlanIds.join(', ') + '. No speech or video was produced.');
          attempt.error = error.message;
          rememberFailure(workDir, state, error, 'needs_review');
          throw error;
        }
        if (report.status === 'duplicates') {
          clearPending();
          state.repair = { base: record, planIds: report.duplicatePlanIds, feedback: report.comparisons.filter(item => item.verdict === 'duplicate') };
          attempt.status = 'rejected';
          const error = new Error('Semantic duplicates require replacement: ' + report.duplicatePlanIds.join(', '));
          attempt.error = error.message;
          feedback = state.repair.feedback; previous = candidate;
          rememberFailure(workDir, state, error, 'needs_review');
          log('중복 회차만 다시 기획합니다: ' + report.duplicatePlanIds.join(', '));
          pending = null;
          continue;
        }
        delete state.repair;
        const profiles = new Map(report.profiles.map(profile => [profile.planId, profile.knowledge]));
        entries = entries.map(entry => ({ ...entry, plan: { ...entry.plan, knowledge: profiles.get(entry.plan.id) } }));
        let contentReport;
        let evidenceBundle;
        if (contentRequired) {
          const contentDir = path.join(workDir, 'content-' + randomUUID().slice(0, 8));
          fs.mkdirSync(contentDir);
          state.contentPending = record;
          delete state.semanticPending;
          state.status = 'content_check'; attempt.status = 'content_check';
          saveState(workDir, state);
          log('실제 근거 자료와 대본·화면의 핵심 주장을 검증합니다.');
          try {
            evidenceBundle = readEvidence(current.series);
            const { validateContentReport } = require('../content/checker.cjs');
            contentReport = validateContentReport(await contentCheck({ series: current.series, entries, bundle: evidenceBundle, directory: contentDir }), entries, evidenceBundle);
            const reportFile = path.join(contentDir, 'decision.json');
            fs.writeFileSync(reportFile, json(contentReport));
            state.contentReport = contentReport;
            state.contentReportFile = path.relative(workDir, reportFile).split(path.sep).join('/');
            state.contentSourceHash = evidenceBundle.sourceHash;
            state.contentCandidateSha256 = record.candidateSha256;
            attempt.contentReportFile = state.contentReportFile;
            delete state.sourceIssues;
            saveState(workDir, state);
            if (readEvidence(current.series).sourceHash !== evidenceBundle.sourceHash) {
              throw Object.assign(new Error('Evidence sources changed during content review. Retry to check the saved candidate against current sources.'), { code: 'CONTENT_SOURCES_CHANGED' });
            }
          } catch (error) {
            attempt.status = 'content_failed'; attempt.error = error.message;
            rememberFailure(workDir, state, error, 'content_failed');
            throw error;
          }
          if (contentReport.status === 'needs_review') {
            clearPending(); state.reviewPending = record;
            attempt.status = 'needs_review';
            const error = new Error('Content review needs human review: ' + contentReport.reviewPlanIds.join(', ') + '. No speech or video was produced.');
            attempt.error = error.message;
            rememberFailure(workDir, state, error, 'needs_review');
            throw error;
          }
          if (contentReport.status === 'corrections') {
            clearPending();
            state.repair = { base: record, planIds: contentReport.correctionPlanIds,
              feedback: { kind: 'content', sourceHash: evidenceBundle.sourceHash,
                units: contentReport.units.filter(unit => contentReport.correctionPlanIds.includes(unit.planId) && unit.verdict === 'contradicted'),
                consistency: contentReport.consistency.filter(item => contentReport.correctionPlanIds.includes(item.planId) && item.verdict !== 'consistent') } };
            attempt.status = 'rejected';
            const error = new Error('Content corrections required: ' + contentReport.correctionPlanIds.join(', '));
            attempt.error = error.message;
            feedback = state.repair.feedback; previous = candidate;
            rememberFailure(workDir, state, error, 'needs_review');
            log('내용 오류가 있는 회차만 수정합니다: ' + contentReport.correctionPlanIds.join(', '));
            pending = null;
            continue;
          }
          if (contentReport.status !== 'passed') throw new Error('A required content check cannot be disabled.');
        }
        state.preflightPending = record;
        delete state.semanticPending; delete state.contentPending; delete state.reviewPending;
        state.status = 'preflighting'; attempt.status = 'preflighting';
        saveState(workDir, state);
        const checkDir = path.join(workDir, 'check-' + randomUUID().slice(0, 8));
        fs.mkdirSync(checkDir);
        try {
          await preflight(entries, checkDir);
        } catch (error) {
          attempt.status = error.generationRetryable === false ? 'preflight_failed' : 'rejected';
          attempt.error = error.message;
          if (error.generationRetryable === false || typeof error.code === 'string') {
            rememberFailure(workDir, state, error, 'preflight_failed');
            throw error;
          }
          clearPending();
          if (typeof error.planId === 'string' && entries.some(entry => entry.plan.id === error.planId)) {
            state.repair = { base: record, planIds: [error.planId], feedback: { kind: 'timing', message: error.message } };
          }
          feedback = error.message; previous = candidate;
          rememberFailure(workDir, state, error);
          pending = null;
          log('생성 결과 자동 수정: ' + error.message);
          continue;
        }
        clearPending(); state.accepted = record;
        attempt.status = 'accepted'; attempt.finishedAt = new Date().toISOString(); delete attempt.error;
        state.status = 'committing'; delete state.error;
        saveState(workDir, state);
        try {
          // Series defaults are part of this request even if a catalog was edited during synthesis.
          readContext(root, seriesId, batchId, count, requestKey);
          if (contentRequired && readEvidence(current.series).sourceHash !== evidenceBundle.sourceHash) {
            throw Object.assign(new Error('Evidence sources changed after content review. Retry to check the saved candidate against current sources.'), { code: 'CONTENT_SOURCES_CHANGED' });
          }
          // The catalog checks the exact reviewed history under its lock, after potentially slow TTS.
          const result = await commitGeneratedBatch(root, seriesId, batchId, entries, {
            requestKey, expectedHistoryHash: current.historyHash,
            noveltyReport: { ...report, reportPath: path.relative(root, path.join(workDir, state.semanticReportFile)).split(path.sep).join('/'),
              historyHash: current.historyHash, candidateSha256: record.candidateSha256 },
            ...(contentRequired ? { expectedSourceHash: evidenceBundle.sourceHash,
              contentReport: { ...contentReport, reportPath: path.relative(root, path.join(workDir, state.contentReportFile)).split(path.sep).join('/'),
                candidateSha256: record.candidateSha256 } } : {}),
          });
          state.status = 'committed'; state.episodeIds = result.episodeIds; state.updatedAt = new Date().toISOString();
          saveState(workDir, state);
          return result;
        } catch (error) {
          rememberFailure(workDir, state, error, 'commit_failed');
          throw error;
        }
      }

      if (calls >= maxAttempts) {
        const error = new Error(`Generation did not pass validation after ${maxAttempts} attempts: ${state.error}. See ${workDir}`);
        rememberFailure(workDir, state, error, state.repair ? 'needs_review' : 'failed');
        throw error;
      }
      if (typeof provider !== 'function') throw new Error('A generation model provider is required.');
      const current = readContext(root, seriesId, batchId, count, requestKey);
      let evidenceBundle;
      if (contentRequired) {
        try {
          evidenceBundle = readEvidence(current.series);
        } catch (error) {
          rememberFailure(workDir, state, error, 'content_failed');
          throw error;
        }
        if (evidenceBundle.status !== 'ready') {
          state.sourceIssues = evidenceBundle.issues;
          state.contentSourceHash = evidenceBundle.sourceHash;
          const sourceFile = 'sources-' + randomUUID().slice(0, 8) + '.json';
          fs.writeFileSync(path.join(workDir, sourceFile), json(evidenceBundle));
          state.sourceBundleFile = sourceFile;
          const error = new Error('Content review requires readable evidence sources before generation. See the saved source issues.');
          rememberFailure(workDir, state, error, 'needs_review');
          throw error;
        }
        delete state.sourceIssues;
      }
      const repair = state.repair;
      const base = repair ? readCandidate(workDir, repair.base) : null;
      const ids = Array.from({ length: count }, (_, index) => `${batchId}-${String(index + 1).padStart(2, '0')}`);
      const replaceIndices = repair ? ids.map((id, index) => repair.planIds.includes(id) ? index : -1).filter(index => index >= 0) : [];
      if (repair && (!replaceIndices.length || replaceIndices.length !== repair.planIds.length)) throw new Error('Saved replacement slots are invalid.');
      const attempt = { id: state.attempts.length + 1, status: 'generating',
        directory: `attempts/${String(state.attempts.length + 1).padStart(3, '0')}-${randomUUID().slice(0, 8)}`,
        startedAt: new Date().toISOString(), ...(repair ? { replacedPlanIds: replaceIndices.map(index => ids[index]) } : {}) };
      const directory = path.join(workDir, attempt.directory);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'context.json'), json({ series: current.series, history: current.history, count, replacementPlanIds: attempt.replacedPlanIds || [],
        ...(evidenceBundle ? { evidenceBundle } : {}) }));
      state.attempts.push(attempt); state.status = 'generating'; delete state.error;
      saveState(workDir, state);
      calls++;
      log(`기획·대본·장면 생성 ${calls}/${maxAttempts} (누적 ${attempt.id}${repair ? ', 교체 ' + replaceIndices.length + '편' : ''})`);
      let response;
      try {
        response = await provider({
          prompt: repair ? contract.buildReplacementPrompt({ series: current.series, history: current.history, count, batchId,
            previous: base, replacePlanIds: replaceIndices.map(index => ids[index]), feedback: repair.feedback, evidenceBundle })
            : contract.buildPrompt({ ...current, count, feedback, previous, evidenceBundle }),
          schema: contract.outputSchema, directory: path.join(directory, 'provider'),
        });
      } catch (error) {
        attempt.status = 'provider_failed'; attempt.error = error.message;
        rememberFailure(workDir, state, error);
        throw error;
      }
      let candidate = response;
      if (repair) {
        try {
          // Validate replacement response independently; it may never touch retained slots.
          contract.validateGenerated(response, { series: current.series, history: [], count: replaceIndices.length, batchId, checkDuplicates: false });
          candidate = structuredClone(base);
          replaceIndices.forEach((index, offset) => { candidate.episodes[index] = response.episodes[offset]; });
        } catch (error) {
          fs.writeFileSync(path.join(directory, 'replacement-response.json'), json(response));
          attempt.status = 'rejected'; attempt.error = error.message;
          state.repair.feedback = { ...(['timing', 'content'].includes(repair.feedback?.kind) ? { kind: repair.feedback.kind } : {}),
            error: error.message, previousResponse: response, priorFeedback: repair.feedback };
          rememberFailure(workDir, state, error, 'needs_review');
          continue;
        }
      }
      const bytes = json(candidate);
      attempt.candidatePath = attempt.directory + '/candidate.json';
      fs.writeFileSync(path.join(workDir, attempt.candidatePath), bytes, { flag: 'wx' });
      attempt.candidateSha256 = hash(bytes);
      pending = candidateRecord(attempt);
      state.semanticPending = pending;
      saveState(workDir, state);
    }
  } finally {
    await release();
  }
}

async function inspectGeneration(root, batchId) {
  const directory = workDirectory(root, batchId);
  const state = readStateFile(directory);
  if (!state) return undefined;
  if (activeStatuses.includes(state.status) && await writerIsActive(directory) === false) {
    return { ...state, previousStatus: state.status, status: 'interrupted' };
  }
  return state;
}

module.exports = { generateBatch, inspectGeneration };
