const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { readStateFile, saveState, lockWorkDir } = require('./run-state.cjs');

function readState(workDir) {
  const state = readStateFile(workDir);
  if (state === undefined) return { version: 1, status: 'new', stages: {} };
  if (state?.version !== 1 || !state.stages) throw new Error('Unsupported episode state');
  return state;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function outputHashes(directory, files) {
  const hashes = {};
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(directory, file));
    if (!bytes.length) throw new Error(`Empty stage output: ${file}`);
    hashes[file] = hash(bytes);
  }
  return hashes;
}

function stageKey(stage, inputs, upstream) {
  return hash(JSON.stringify([stage.id, inputs, upstream?.key, upstream?.outputs]));
}

function matches(record, key, workDir, stage) {
  if (!record || record.status !== 'done' || record.key !== key) return false;
  try {
    const hashes = outputHashes(path.join(workDir, record.dir), stage.outputs);
    return stage.outputs.every(file => record.outputs[file] === hashes[file]) &&
      (typeof stage.validateOutputs !== 'function' || stage.validateOutputs(path.join(workDir, record.dir)) === true);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.message.startsWith('Empty stage output:')) return false;
    throw error;
  }
}

async function inspectEpisode(workDir, stages) {
  const state = readState(workDir);
  const steps = [];
  let upstream;
  let current = true;
  for (const stage of stages) {
    const record = state.stages[stage.id];
    const key = stageKey(stage, await stage.inputs(), upstream);
    current = current && matches(record, key, workDir, stage);
    steps.push({ id: stage.id, current });
    if (!stage.validationOnly) upstream = record;
  }
  return { state, steps };
}

async function runEpisode(workDir, stages, { log = console.log } = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  const release = await lockWorkDir(workDir, 'Episode');
  try {
    const state = readState(workDir);
    const previous = {};
    let upstream;
    let rebuild = false;
    for (const stage of stages) {
      const record = state.stages[stage.id];
      let next;
      try {
        const key = stageKey(stage, await stage.inputs(), upstream);
        if (!rebuild && matches(record, key, workDir, stage)) {
          log(`[reuse] ${stage.id}`);
          if (!stage.validationOnly) upstream = record;
          previous[stage.id] = path.join(workDir, record.dir);
          continue;
        }
        // Validation gates must pass before work can continue, but their reports do
        // not change media inputs. Rechecking evidence must not resynthesize speech.
        if (!stage.validationOnly) rebuild = true;
        next = { status: 'running', key, dir: `artifacts/${stage.id}/${randomUUID()}` };
        state.stages[stage.id] = next;
        state.status = 'running';
        saveState(workDir, state);
        log(`[run]   ${stage.id}`);
        const dir = path.join(workDir, next.dir);
        fs.mkdirSync(dir, { recursive: true });
        await stage.run({ dir, previous });
        next.outputs = outputHashes(dir, stage.outputs);
        if (typeof stage.validateOutputs === 'function' && stage.validateOutputs(dir) !== true) {
          throw new Error('Stage output integrity validation failed: ' + stage.id);
        }
        next.status = 'done';
        saveState(workDir, state);
        if (!stage.validationOnly) upstream = next;
        previous[stage.id] = dir;
      } catch (error) {
        state.stages[stage.id] = { ...next, status: 'failed', error: error.message };
        state.status = 'failed';
        saveState(workDir, state);
        throw new Error(`${stage.id}: ${error.message}`, { cause: error });
      }
    }
    if (state.status !== 'ready_for_review') {
      state.status = 'ready_for_review';
      saveState(workDir, state);
    }
    return state;
  } finally {
    await release();
  }
}

module.exports = { inspectEpisode, runEpisode };
