const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { readCatalog, editCatalog, saveCatalog } = require('../planning.cjs');
const { readStateFile, saveState, lockWorkDir } = require('../run-state.cjs');
const { validateSpec } = require('../story/spec.cjs');
const { readEvidenceBundle } = require('./sources.cjs');
const { validateContentReport, contentEntryHash, createContentChecker } = require('./checker.cjs');
const contract = require('./repair-contract.cjs');

const MAX_ATTEMPTS = 2;
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => hash(json(value));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function optional(file) { try { return read(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }
function identifier(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)) throw Error('Invalid repair episode ID.');
}
function contained(base, target, exists = true) {
  const file = path.resolve(base, target);
  const check = (parent, child) => {
    const relative = path.relative(parent, child);
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw Error('Repair artifact escapes its directory.');
  };
  check(path.resolve(base), file);
  if (exists) check(fs.realpathSync(base), fs.realpathSync(file));
  return file;
}
function atomic(file, bytes) {
  const temporary = file + '-' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function writeOnce(file, bytes) {
  try { fs.writeFileSync(file, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !fs.readFileSync(file).equals(Buffer.from(bytes))) throw error;
  }
}
function verificationHash() {
  return digest(['runtime.cjs', 'sources.cjs', 'checker.cjs'].map(file => [file, hash(fs.readFileSync(path.join(__dirname, file)))]));
}
function context(root, episodeId) {
  identifier(episodeId);
  const catalog = readCatalog(root);
  const episode = catalog.episodes[episodeId];
  const series = episode && catalog.series[episode.seriesId];
  const plan = episode && catalog.plans[episode.seriesId]?.[episode.planId];
  if (!episode || !series || !plan) throw Error('Unknown repair episode or plan: ' + episodeId);
  if (episode.adapter !== 'pipeline/story/adapter.cjs' || series.contentReview?.mode !== 'required') return undefined;
  if (path.isAbsolute(episode.episode)) throw Error('Episode input must be repository relative.');
  const inputFile = contained(root, episode.episode);
  const bytes = fs.readFileSync(inputFile);
  const rawStory = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const story = validateSpec(rawStory);
  const bundle = readEvidenceBundle(root, series);
  const { visualReview: ignoredVisualPolicy, ...contentSeries } = series;
  const invariantHash = digest({ episode, series: contentSeries, sourceHash: bundle.sourceHash, sourceStatus: bundle.status, verification: verificationHash() });
  const inputHash = hash(bytes);
  const key = digest({ version: 1, episodeId, inputHash, plan, invariantHash });
  return { key, episodeId, episode, series, plan, story, rawStory, inputFile, inputHash, bundle, invariantHash };
}
function home(root, id) { identifier(id); return path.join(root, 'runs', '_content-repairs', id); }
function caseDirectory(root, id, key) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error('Invalid repair journal key.');
  return path.join(home(root, id), key);
}
function loadCase(directory) {
  const state = readStateFile(directory);
  if (state && (state.version !== 1 || !Array.isArray(state.attempts) || state.attempts.length > MAX_ATTEMPTS ||
      !/^[a-f0-9]{64}$/.test(state.key) || state.attempts.some((attempt, i) => attempt.id !== i + 1))) throw Error('Invalid repair journal.');
  return state;
}
function result(state, directory) {
  return { status: state.status, reason: state.reason || '', reportPath: path.join(directory, 'state.json'), attempts: state.attempts.length };
}
function getRepairHold({ root, episodeId }) {
  const current = context(root, episodeId);
  if (!current) return undefined;
  const directory = caseDirectory(root, episodeId, current.key);
  const state = loadCase(directory);
  return state?.status === 'needs_review' ? result(state, directory) : undefined;
}
function matchesPublication(current, state, base, allowBefore = false) {
  return current.invariantHash === base.invariantHash &&
    (current.inputHash === state.publication?.inputHash || (allowBefore && current.inputHash === base.inputHash)) &&
    (digest(current.plan) === state.publication?.planHash || (allowBefore && digest(current.plan) === digest(base.plan)));
}
function getRepairResume({ root, episodeId }) {
  const current = context(root, episodeId);
  if (!current) return false;
  const active = optional(path.join(home(root, episodeId), 'active.json'));
  if (active) {
    const directory = caseDirectory(root, episodeId, active.key);
    const state = loadCase(directory);
    if (state && ['publishing', 'applied'].includes(state.status)) {
      const base = JSON.parse(checkedFile(directory, state.baseFile, state.baseHash));
      if (matchesPublication(current, state, base, state.status === 'publishing')) return true;
    }
  }
  const state = loadCase(caseDirectory(root, episodeId, current.key));
  return Boolean(state && !['needs_review', 'applied', 'publishing'].includes(state.status));
}
function assertBase(root, episodeId, base) {
  const current = context(root, episodeId);
  if (!current || current.key !== base.key) throw Object.assign(Error('Repair input, plan, series or sources changed. The saved candidate was not applied.'), { code: 'CONTENT_REPAIR_CONFLICT' });
  return current;
}
function checkedFile(directory, name, expectedHash) {
  const file = contained(directory, name);
  const bytes = fs.readFileSync(file);
  if (!expectedHash || hash(bytes) !== expectedHash) throw Error('Saved repair artifact changed: ' + name);
  return bytes;
}
function hold(directory, state, reason) {
  state.status = 'needs_review'; state.reason = reason; state.updatedAt = new Date().toISOString();
  delete state.pending;
  saveState(directory, state);
  return result(state, directory);
}
function initialReport(root, episodeId, current) {
  const workDir = path.join(root, 'runs', episodeId);
  const state = readStateFile(workDir);
  const stage = state?.stages?.content;
  if (!stage || stage.status !== 'failed' || typeof stage.dir !== 'string') throw Error('Automatic repair requires a failed production content check.');
  const file = contained(workDir, path.join(stage.dir, 'report.json'));
  const report = read(file);
  validateContentReport(report, [{ plan: current.plan, story: current.story }], current.bundle);
  if (!['needs_review', 'corrections'].includes(report.status)) throw Error('Only a held or contradicted content report can enter repair.');
  return report;
}

function publicationInput(root, base) {
  const relative = base.episode?.episode;
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
      relative.includes(':') || relative.split(/[\\/]/).some(part => !part || part === '..')) {
    throw Error('Saved repair input must be repository relative.');
  }
  const file = contained(root, relative);
  if (typeof base.inputFile !== 'string' || !base.inputFile) throw Error('Saved repair input is missing.');
  // Older hash-verified journals retain the original PC's absolute inputFile.
  // It is provenance only: the saved catalog-relative input selects the new
  // workspace file. Never read, write or rewrite the historical absolute path.
  if (!path.isAbsolute(base.inputFile) && !path.win32.isAbsolute(base.inputFile) &&
      contained(root, base.inputFile) !== file) throw Error('Saved repair input paths do not match.');
  return file;
}

// The input file and catalog title are two files. A durable publication record
// lets a later invocation complete an interrupted pair without another model call.
async function publish(root, episodeId, directory, state, base) {
  const publication = state.publication;
  const afterBytes = checkedFile(directory, publication.inputFile, publication.inputHash);
  const afterPlan = JSON.parse(checkedFile(directory, publication.planFile, publication.planHash));
  const inputFile = publicationInput(root, base);
  await editCatalog(root, catalog => {
    const current = context(root, episodeId);
    if (!current || current.invariantHash !== base.invariantHash || current.inputFile !== inputFile) {
      throw Object.assign(Error('Repair sources or series changed before publication.'), { code: 'CONTENT_REPAIR_CONFLICT' });
    }
    const beforeInput = current.inputHash === base.inputHash;
    const afterInput = current.inputHash === publication.inputHash;
    const beforePlan = digest(current.plan) === digest(base.plan);
    const alreadyPlan = digest(current.plan) === digest(afterPlan);
    if ((!beforeInput && !afterInput) || (!beforePlan && !alreadyPlan)) throw Object.assign(Error('Repair publication conflicts with a newer edit.'), { code: 'CONTENT_REPAIR_CONFLICT' });
    if (beforeInput) atomic(current.inputFile, afterBytes);
    if (!alreadyPlan) {
      catalog.plans[base.episode.seriesId][base.episode.planId] = afterPlan;
      // Leave the publishing journal intact on failure. Recovery accepts only
      // the exact recorded before/after hashes, never arbitrary later edits.
      saveCatalog(root, catalog);
    }
  });
  state.status = 'applied';
  state.reason = '허용된 제목·화면 문구를 보완하고 내용 재검수를 통과했습니다.';
  state.updatedAt = new Date().toISOString();
  saveState(directory, state);
  return appliedResult(root, episodeId, directory, state, base);
}

function appliedResult(root, episodeId, directory, state, base) {
  const current = context(root, episodeId);
  const publication = state.publication;
  const plan = JSON.parse(checkedFile(directory, publication.planFile, publication.planHash));
  if (!current || current.invariantHash !== base.invariantHash || current.inputHash !== publication.inputHash || digest(current.plan) !== digest(plan)) {
    throw Object.assign(Error('The repaired input or evidence changed before production resumed.'), { code: 'CONTENT_REPAIR_CONFLICT' });
  }
  const report = JSON.parse(checkedFile(directory, publication.reportFile, publication.reportHash));
  validateContentReport(report, [{ plan: current.plan, story: current.story }], current.bundle);
  if (report.status !== 'passed') throw Error('Only a passed candidate report can resume production.');
  const expectedKey = current.key;
  return { ...result(state, directory), inputHash: current.inputHash,
    // The unchanged, just-validated candidate is recorded by the normal content
    // stage. This avoids a redundant stochastic judgment of identical bytes.
    checker: async request => {
      const fresh = context(root, episodeId);
      if (!fresh || fresh.key !== expectedKey || contentEntryHash(request.entries) !== report.entryHash || request.bundle.sourceHash !== report.sourceHash) {
        throw Object.assign(Error('Validated repair no longer matches the production input.'), { code: 'CONTENT_REPAIR_CONFLICT' });
      }
      validateContentReport(report, request.entries, request.bundle);
      return report;
    } };
}

async function repairProductionContent({ root, episodeId, checker, provider, log = () => {} }) {
  identifier(episodeId);
  const workDir = path.join(root, 'runs', episodeId);
  const release = await lockWorkDir(workDir, 'Episode');
  try {
    let current = context(root, episodeId);
    if (!current) throw Error('Automatic repair requires a registered common-story episode with required content review.');
    const parent = home(root, episodeId);
    fs.mkdirSync(parent, { recursive: true });
    const active = optional(path.join(parent, 'active.json'));
    if (active) {
      const activeDirectory = caseDirectory(root, episodeId, active.key);
      const prior = loadCase(activeDirectory);
      if (prior && ['publishing', 'applied'].includes(prior.status)) {
        const saved = JSON.parse(checkedFile(activeDirectory, prior.baseFile, prior.baseHash));
        if (prior.status === 'publishing' && matchesPublication(current, prior, saved, true)) return await publish(root, episodeId, activeDirectory, prior, saved);
        if (prior.status === 'applied' && matchesPublication(current, prior, saved)) return appliedResult(root, episodeId, activeDirectory, prior, saved);
      }
    }
    const directory = caseDirectory(root, episodeId, current.key);
    fs.mkdirSync(directory, { recursive: true });
    let state = loadCase(directory);
    if (!state) {
      const report = initialReport(root, episodeId, current);
      const scope = contract.eligibility({ entries: [{ plan: current.plan, story: current.story }], report, bundle: current.bundle });
      const base = { ...current, inputFile: current.episode.episode, scope, report };
      // bundle includes actual source text; all evidence belongs to this run.
      const bytes = json(base);
      // No request can start until state.json exists. Replacing an orphaned
      // setup snapshot here therefore cannot reset an already-counted attempt.
      atomic(path.join(directory, 'base.json'), bytes);
      atomic(path.join(directory, 'before-input.json'), fs.readFileSync(current.inputFile));
      state = { version: 1, key: current.key, episodeId, status: 'new', attempts: [], baseFile: 'base.json', baseHash: hash(bytes), createdAt: new Date().toISOString() };
      saveState(directory, state);
    }
    atomic(path.join(parent, 'active.json'), json({ key: state.key }));
    const base = JSON.parse(checkedFile(directory, state.baseFile, state.baseHash));
    if (state.key !== current.key || base.key !== current.key) throw Error('Repair journal belongs to a different input.');
    if (state.status === 'needs_review') return result(state, directory);
    if (!base.scope.eligible) return hold(directory, state, base.scope.reason);
    const model = provider || require('../generation/provider.cjs').createCodexProvider();
    const check = checker || createContentChecker({ provider: model, log });
    const entry = { plan: base.plan, story: base.story };
    while (true) {
      assertBase(root, episodeId, base);
      let attempt;
      if (state.pending) {
        attempt = state.attempts.find(item => item.id === state.pending);
        if (!attempt?.candidateFile) throw Error('Pending repair candidate is missing.');
      } else {
        if (state.attempts.length >= MAX_ATTEMPTS) return hold(directory, state, '자동 문구 수정·재검수 2회 한도에 도달했습니다. 후보와 실패 이유를 확인해 주세요.');
        attempt = { id: state.attempts.length + 1, status: 'requesting', directory: `attempt-${state.attempts.length + 1}`, startedAt: new Date().toISOString() };
        state.attempts.push(attempt); state.status = 'requesting';
        fs.mkdirSync(path.join(directory, attempt.directory), { recursive: true });
        saveState(directory, state);
        log(`제작 문구 자동 수정 ${attempt.id}/${MAX_ATTEMPTS}`);
        let proposal;
        try {
          proposal = await model({ schema: contract.outputSchema,
            prompt: contract.buildPrompt({ series: base.series, entry, bundle: base.bundle, report: base.report, scope: base.scope, previous: state.previous, feedback: state.feedback }),
            directory: path.join(directory, attempt.directory, 'provider') });
          assertBase(root, episodeId, base);
          const bytes = json(proposal);
          attempt.proposalFile = attempt.directory + '/proposal.json'; attempt.proposalHash = hash(bytes);
          fs.writeFileSync(path.join(directory, attempt.proposalFile), bytes, { flag: 'wx' });
          saveState(directory, state);
        } catch (error) {
          attempt.status = 'provider_failed'; attempt.error = error.message; state.status = 'failed';
          saveState(directory, state); throw error;
        }
        let candidate;
        try { candidate = contract.applyProposal(proposal, { entry, bundle: base.bundle, report: base.report, scope: base.scope }); }
        catch (error) {
          attempt.status = 'rejected'; attempt.error = error.message; state.feedback = { error: error.message }; state.status = 'retrying';
          saveState(directory, state); continue;
        }
        if (candidate.status === 'needs_review') {
          attempt.status = 'held'; attempt.reason = candidate.reason;
          return hold(directory, state, candidate.reason);
        }
        // Production checks normalized story objects. Canonical property order
        // matters to its existing byte hash, including a newly added body.
        candidate.entry.story = validateSpec(candidate.entry.story);
        const candidateBytes = json(candidate.entry);
        attempt.candidateFile = attempt.directory + '/candidate.json'; attempt.candidateHash = hash(candidateBytes);
        attempt.changes = candidate.changes; attempt.evidence = candidate.evidence;
        fs.writeFileSync(path.join(directory, attempt.candidateFile), candidateBytes, { flag: 'wx' });
        attempt.status = 'checking'; state.pending = attempt.id; state.status = 'checking';
        saveState(directory, state);
      }
      const candidate = JSON.parse(checkedFile(directory, attempt.candidateFile, attempt.candidateHash));
      let report;
      try {
        assertBase(root, episodeId, base);
        if (attempt.reportFile && attempt.reportHash) {
          // A completed judgment is durable even when publication was
          // interrupted. Do not pay for or change that identical judgment.
          report = JSON.parse(checkedFile(directory, attempt.reportFile, attempt.reportHash));
        } else {
          const checkDirectory = path.join(directory, `check-${attempt.id}-${randomUUID().slice(0, 8)}`);
          fs.mkdirSync(checkDirectory);
          report = await check({ series: base.series, entries: [candidate], bundle: base.bundle, directory: checkDirectory });
          validateContentReport(report, [candidate], base.bundle);
          assertBase(root, episodeId, base);
          const bytes = json(report);
          const reportFile = path.relative(directory, path.join(checkDirectory, 'report.json')).split(path.sep).join('/');
          fs.writeFileSync(path.join(directory, reportFile), bytes, { flag: 'wx' });
          attempt.reportFile = reportFile; attempt.reportHash = hash(bytes);
          saveState(directory, state);
        }
        validateContentReport(report, [candidate], base.bundle);
        assertBase(root, episodeId, base);
      } catch (error) {
        state.status = 'failed'; attempt.status = 'check_failed'; attempt.error = error.message;
        saveState(directory, state); throw error;
      }
      if (report.status !== 'passed') {
        attempt.status = 'rejected'; attempt.error = 'Candidate content check: ' + report.status;
        state.previous = candidate; state.feedback = { report }; delete state.pending;
        const possible = contract.eligibility({ entries: [candidate], bundle: base.bundle, report });
        if (!possible.eligible) return hold(directory, state, possible.reason);
        if ((possible.allowTitle && !base.scope.allowTitle) || possible.allowedScenes.some(id => !base.scope.allowedScenes.includes(id))) {
          return hold(directory, state, '수정 후보에 원래 허용 범위를 벗어난 새 문제가 발견됐습니다.');
        }
        state.status = 'retrying'; saveState(directory, state); continue;
      }
      // Keep raw metadata and formatting-independent values from the source.
      // Only the contract's four permitted text locations reach publication.
      const rawStory = structuredClone(base.rawStory);
      const plan = structuredClone(base.plan);
      for (const change of attempt.changes) {
        if (change.location === 'plan.title') plan.title = change.after;
        else if (change.location === 'story.title') rawStory.title = change.after;
        else {
          const match = /^story\.scenes\[(\d+)\]\.(headline|body)$/.exec(change.location);
          if (!match) throw Error('Unexpected publication change location.');
          rawStory.scenes[Number(match[1])][match[2]] = change.after;
        }
      }
      const normalized = validateSpec(rawStory);
      if (contentEntryHash([{ plan, story: normalized }]) !== report.entryHash) throw Error('Publication differs from the checked candidate.');
      const inputBytes = json(rawStory), planBytes = json(plan);
      writeOnce(path.join(directory, 'after-input.json'), inputBytes);
      writeOnce(path.join(directory, 'after-plan.json'), planBytes);
      state.publication = { inputFile: 'after-input.json', inputHash: hash(inputBytes), planFile: 'after-plan.json', planHash: hash(planBytes), reportFile: attempt.reportFile, reportHash: attempt.reportHash };
      state.status = 'publishing'; attempt.status = 'accepted'; delete state.pending;
      saveState(directory, state);
      return await publish(root, episodeId, directory, state, base);
    }
  } finally { await release(); }
}

module.exports = { repairProductionContent, getRepairHold, getRepairResume, MAX_ATTEMPTS };
