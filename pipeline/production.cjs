const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readCatalog } = require('./planning.cjs');
const { runEpisode } = require('./runner.cjs');
const { readStateFile, saveState, lockWorkDir } = require('./run-state.cjs');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function productionEntry(root, episodeId) {
  const catalog = readCatalog(root);
  const entry = catalog.episodes[episodeId];
  const series = entry && catalog.series[entry.seriesId];
  if (entry?.adapter !== 'pipeline/story/adapter.cjs' || series?.contentReview?.mode !== 'required') return undefined;
  const input = path.resolve(root, entry.episode);
  const inside = path.relative(fs.realpathSync(root), fs.realpathSync(input));
  if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error('Production input resolves outside repository.');
  return { input, inputHash: hash(fs.readFileSync(input)) };
}

function heldError(result) {
  return Object.assign(new Error(`Content repair needs_review: ${result.reason || 'Human review is required.'}${result.reportPath ? ' Report: ' + result.reportPath : ''}`), {
    code: 'CONTENT_REVIEW_REQUIRED', contentRepairReport: result.reportPath,
  });
}

async function recordRepair({ root, episodeId, workDir, result, expectedInputHash }) {
  const release = await lockWorkDir(workDir, 'Episode');
  try {
    const current = productionEntry(root, episodeId);
    if (!current || current.inputHash !== expectedInputHash) throw Object.assign(new Error('Episode input changed before recording its content repair result.'), { code: 'CONTENT_INPUT_CHANGED' });
    const state = readStateFile(workDir);
    if (!state?.stages) throw new Error('Content repair needs an existing episode state.');
    const record = { status: result.status, reason: result.reason, reportPath: result.reportPath, attempts: result.attempts };
    if (result.status === 'needs_review') state.status = 'needs_review';
    if (JSON.stringify(state.contentRepair) !== JSON.stringify(record)) {
      state.contentRepair = record;
      saveState(workDir, state);
    } else if (result.status === 'needs_review' && readStateFile(workDir).status !== 'needs_review') saveState(workDir, state);
  } finally { await release(); }
}

function isContentDecisionFailure(workDir, error) {
  const state = readStateFile(workDir);
  const content = state?.stages?.content;
  const reported = error?.cause?.contentReportPath || error?.contentReportPath;
  if (!reported || content?.status !== 'failed' || !content.dir) return false;
  const expected = path.resolve(workDir, content.dir, 'report.json');
  if (path.resolve(reported) !== expected) return false;
  const report = JSON.parse(fs.readFileSync(expected, 'utf8'));
  return ['corrections', 'needs_review'].includes(report.status);
}

// This is the normal production entry point. The low-level runner stays usable
// by revision preflight and audits that must never modify the episode input.
async function runProduction({ root, episodeId, workDir = path.join(root, 'runs', episodeId), createStages,
  contentChecker, repairProvider, log = console.log, repairEngine } = {}) {
  if (typeof root !== 'string' || !root || typeof episodeId !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(episodeId)) throw new Error('A repository root and safe episode ID are required.');
  if (typeof createStages !== 'function') throw new Error('Production requires a fresh createStages callback.');
  const lockDir = path.join(root, 'runs', '_production', episodeId);
  fs.mkdirSync(lockDir, { recursive: true });
  const release = await lockWorkDir(lockDir, 'Production');
  try {
    const initial = productionEntry(root, episodeId);
    const engine = initial ? repairEngine || require('./content/repair-engine.cjs') : undefined;
    async function repairAndResume(beforeRepair) {
      const result = await engine.repairProductionContent({ root, episodeId, checker: contentChecker,
        provider: repairProvider, log });
      if (!result || !['applied', 'needs_review'].includes(result.status)) throw new Error('Invalid content repair outcome.');
      if (result.status === 'needs_review') {
        await recordRepair({ root, episodeId, workDir, result, expectedInputHash: beforeRepair.inputHash });
        log(`[content-repair] needs_review (${result.attempts}/2): ${result.reason}`);
        throw heldError(result);
      }
      log(`[content-repair] applied (${result.attempts}/2): ${result.reason}`);
      // Rebuild all stage closures after publication. The memo checker supplied
      // by the repair engine accepts only the exact checked input/source pair.
      // Existing speech remains reusable because narration is fixed by contract.
      try {
        const current = productionEntry(root, episodeId);
        if (!result.inputHash || current.inputHash !== result.inputHash) throw Object.assign(new Error('Episode input changed after content repair publication.'), { code: 'CONTENT_INPUT_CHANGED' });
        await runEpisode(workDir, await createStages({ contentChecker: result.checker || contentChecker }), { log });
      } finally {
        await recordRepair({ root, episodeId, workDir, result, expectedInputHash: result.inputHash });
      }
      return readStateFile(workDir);
    }
    if (engine) {
      const held = await engine.getRepairHold({ root, episodeId });
      if (held) {
        await recordRepair({ root, episodeId, workDir, result: held, expectedInputHash: initial.inputHash });
        log(`[content-repair] needs_review: ${held.reason}`);
        throw heldError(held);
      }
      // Finish a durable candidate/publication before loading ordinary stages.
      // Otherwise a fresh check could accept a half-published title pair and
      // skip recovery, or spend a new model call on an already checked candidate.
      if (await engine.getRepairResume?.({ root, episodeId })) return await repairAndResume(initial);
    }
    try {
      return await runEpisode(workDir, await createStages({ contentChecker }), { log });
    } catch (error) {
      if (!engine || !isContentDecisionFailure(workDir, error)) throw error;
      return await repairAndResume(productionEntry(root, episodeId));
    }
  } finally { await release(); }
}

module.exports = { runProduction };
