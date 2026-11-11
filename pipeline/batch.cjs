const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { readStateFile, saveState, lockWorkDir, writerIsActive } = require('./run-state.cjs');

const statuses = new Set(['pending', 'running', 'ready_for_review', 'failed', 'needs_review', 'interrupted']);
const maxJobs = 8;

function validateIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('A batch needs at least one episode ID.');
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('Invalid episode ID: ' + id);
    if (seen.has(id)) throw new Error('Duplicate episode ID: ' + id);
    seen.add(id);
  }
}

function readBatch(workDir) {
  const state = readStateFile(workDir);
  if (state === undefined) return { version: 1, episodes: {} };
  if (state?.version !== 1 || !state.episodes || typeof state.episodes !== 'object' || Array.isArray(state.episodes)) {
    throw new Error('Unsupported batch state: ' + workDir);
  }
  for (const [id, record] of Object.entries(state.episodes)) {
    if (!statuses.has(record?.status) || !Number.isSafeInteger(record.attempts) || record.attempts < 0) {
      throw new Error('Invalid batch state for episode: ' + id);
    }
  }
  return state;
}

function activeMembers(state, ids, includeQueue = false) {
  const queued = new Set(includeQueue ? state.queue : []);
  return { version: 1, episodes: Object.fromEntries(ids.map(id => {
    const row = Object.hasOwn(state.episodes, id) ? state.episodes[id] : { status: 'pending', attempts: 0 };
    return [id, queued.has(id) ? { ...row, queued: true } : row];
  })) };
}

function markInterrupted(state) {
  let changed = false;
  for (const record of Object.values(state.episodes)) {
    if (record.status === 'running') {
      record.status = 'interrupted';
      changed = true;
    }
  }
  return changed;
}

async function inspectBatch(workDir, ids) {
  validateIds(ids);
  const snapshot = readBatch(workDir);
  const view = activeMembers(snapshot, ids, true);
  const transient = Object.values(view.episodes).some(row => row.queued || row.status === 'running');
  // A status process with different Windows privileges may be unable to probe a live writer.
  if (!transient || await writerIsActive(workDir) !== false) return view;
  const latest = readBatch(workDir);
  if (latest.runId !== snapshot.runId) {
    // A different run started after the probe. Its queue and attempts may be active.
    return activeMembers(latest, ids, true);
  }
  markInterrupted(latest);
  return activeMembers(latest, ids);
}

async function runBatch(workDir, ids, execute, { retryFailed = false, jobs = 1, log = console.log } = {}) {
  validateIds(ids);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > maxJobs) throw new Error(`jobs must be an integer from 1 to ${maxJobs}.`);
  fs.mkdirSync(workDir, { recursive: true });
  const release = await lockWorkDir(workDir, 'Batch');
  try {
    const state = readBatch(workDir);
    // We now own the only writer lock. Any previous writer's running records were abandoned.
    if (markInterrupted(state) || state.queue) {
      delete state.queue;
      saveState(workDir, state);
    }
    const members = activeMembers(state, ids).episodes;
    // Keep removed members' outcomes on disk. A manifest edit must not erase their retry history.
    Object.assign(state.episodes, members);
    const selected = retryFailed ? ids.filter(id => ['failed', 'needs_review'].includes(members[id].status)) : ids;
    if (!selected.length) {
      log('[batch] no failed or held episodes to retry');
      return activeMembers(state, ids);
    }

    state.runId = randomUUID();
    const queue = [...selected];
    state.queue = queue;
    async function runOne(id) {
      const record = { status: 'running', attempts: state.episodes[id].attempts + 1 };
      state.episodes[id] = record;
      saveState(workDir, state);
      log(`[batch] ${id}: running (attempt ${record.attempts})`);
      try {
        await execute(id);
        record.status = 'ready_for_review';
      } catch (error) {
        record.status = error?.code === 'CONTENT_REVIEW_REQUIRED' ? 'needs_review' : 'failed';
        record.error = error?.message ?? String(error);
      }
      saveState(workDir, state);
      log(`[batch] ${id}: ${record.status}${record.error ? ' — ' + record.error : ''}`);
    }

    let fatal;
    async function worker() {
      while (!fatal && queue.length) {
        const id = queue.shift();
        if (!queue.length) delete state.queue;
        try {
          await runOne(id);
        } catch (error) {
          // Storage failures stop dispatch; active workers must settle before unlock.
          fatal = error;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(jobs, selected.length) }, worker));
    if (fatal) throw fatal;
    return activeMembers(state, ids);
  } finally {
    await release();
  }
}

module.exports = { inspectBatch, runBatch };
