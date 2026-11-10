const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runBatch, inspectBatch } = require('./batch.cjs');

const quiet = { log() {} };
const ready = { status: 'ready_for_review' };

test('content review holds stay distinct from failures and do not prevent other episodes', async t => {
  const dir = temporaryBatch(t);
  const calls = [];
  const first = await runBatch(dir, ['held', 'good'], async id => {
    calls.push(id);
    if (id === 'held') throw Object.assign(Error('missing evidence'), { code: 'CONTENT_REVIEW_REQUIRED' });
  }, quiet);
  assert.equal(first.episodes.held.status, 'needs_review');
  assert.equal(first.episodes.good.status, 'ready_for_review');
  calls.length = 0;
  await runBatch(dir, ['held', 'good'], async id => { calls.push(id); }, { ...quiet, retryFailed: true });
  assert.deepEqual(calls, ['held']);
});

function temporaryBatch(t) {
  const parent = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 'shorts-batch-test-'));
  t.after(() => {
    assert.equal(path.dirname(dir), parent);
    assert.ok(path.basename(dir).startsWith('shorts-batch-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('failed episodes do not stop the batch; retry runs only failed episodes once', async t => {
  const dir = temporaryBatch(t);
  const ids = ['early', 'broken', 'late'];
  const calls = [];
  const attempt = await runBatch(dir, ids, async id => {
    calls.push(id);
    if (id === 'broken') throw Error('bad narration');
    return ready;
  }, quiet);
  assert.deepEqual(calls, ids);
  assert.deepEqual(ids.map(id => attempt.episodes[id].status), ['ready_for_review', 'failed', 'ready_for_review']);
  const recorded = await inspectBatch(dir, ids);
  assert.match(recorded.episodes.broken.error, /bad narration/);
  assert.deepEqual(ids.map(id => recorded.episodes[id].attempts), [1, 1, 1]);

  calls.length = 0;
  const failedAgain = await runBatch(dir, ids, async id => {
    calls.push(id);
    if (calls.length === 1) throw Error('still broken');
    return ready;
  }, { ...quiet, retryFailed: true });
  assert.deepEqual(calls, ['broken']);
  assert.equal(failedAgain.episodes.broken.status, 'failed');
  assert.match(failedAgain.episodes.broken.error, /still broken/);

  calls.length = 0;
  const retry = await runBatch(dir, ids, async id => { calls.push(id); return ready; }, { ...quiet, retryFailed: true });
  assert.deepEqual(calls, ['broken']);
  assert.deepEqual(ids.map(id => retry.episodes[id].attempts), [1, 3, 1]);
  assert.equal(retry.episodes.broken.status, 'ready_for_review');
  calls.length = 0;
  await runBatch(dir, ids, async id => { calls.push(id); return ready; }, { ...quiet, retryFailed: true });
  assert.deepEqual(calls, []);
});

test('live status reports active and queued episodes; a second command cannot claim the batch',
  { timeout: 15_000 }, async t => {
    const dir = temporaryBatch(t);
    const ids = ['one', 'two', 'three', 'four'];
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let active = 0;
    let peak = 0;
    const exec = async () => {
      active++;
      peak = Math.max(peak, active);
      if (active === 2) entered.resolve();
      await release.promise;
      active--;
      return ready;
    };
    const owner = runBatch(dir, ids, exec, { ...quiet, jobs: 2 });
    try {
      await Promise.race([entered.promise, owner]);
      const rows = Object.values((await inspectBatch(dir, ids)).episodes);
      assert.equal(rows.filter(row => row.status === 'running').length, 2);
      assert.equal(rows.filter(row => row.status === 'pending').length, 2);
      await assert.rejects(runBatch(dir, ids, async () => ready, quiet));
    } finally {
      release.resolve();
      await owner;
    }
    assert.equal(peak, 2);
    const finished = await inspectBatch(dir, ids);
    assert.deepEqual(ids.map(id => finished.episodes[id].attempts), [1, 1, 1, 1]);
    assert.ok(ids.every(id => finished.episodes[id].status === 'ready_for_review'));
  });

test('invalid membership and worker counts fail before touching an episode', async t => {
  const dir = temporaryBatch(t);
  const calls = [];
  const exec = async id => { calls.push(id); return ready; };
  await assert.rejects(runBatch(dir, ['same', 'same'], exec, quiet));
  await assert.rejects(runBatch(dir, ['../outside'], exec, quiet));
  for (const jobs of [0, -1, 1.5, 9]) {
    await assert.rejects(runBatch(dir, ['one'], exec, { ...quiet, jobs }));
  }
  assert.deepEqual(calls, []);
});

test('waiting members of a repeat run show as queued without losing their last result', { timeout: 15_000 }, async t => {
  const dir = temporaryBatch(t);
  const ids = ['slow', 'completed', 'failed'];
  await runBatch(dir, ids, async id => {
    if (id === 'failed') throw Error('first attempt');
    return ready;
  }, quiet);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const repeat = runBatch(dir, ids, async id => {
    if (id === 'slow') { entered.resolve(); await release.promise; }
    return ready;
  }, quiet);
  try {
    await Promise.race([entered.promise, repeat]);
    const { episodes } = await inspectBatch(dir, ids);
    assert.equal(episodes.slow.status, 'running');
    assert.equal(episodes.completed.queued, true);
    assert.equal(episodes.completed.status, 'ready_for_review');
    assert.equal(episodes.failed.queued, true);
    assert.equal(episodes.failed.status, 'failed');
    assert.equal(episodes.failed.attempts, 1);
  } finally {
    release.resolve();
    await repeat;
  }
  const final = await inspectBatch(dir, ids);
  assert.ok(ids.every(id => !final.episodes[id].queued && final.episodes[id].status === 'ready_for_review'));
});

test('changing batch membership keeps prior failures and never retries a newly added episode', async t => {
  const dir = temporaryBatch(t);
  await runBatch(dir, ['kept', 'removed'], async id => {
    if (id === 'removed') throw Error('renderer failed');
    return ready;
  }, quiet);
  const calls = [];
  const retry = ids => runBatch(dir, ids, async id => { calls.push(id); return ready; }, { ...quiet, retryFailed: true });
  const changed = await retry(['kept', 'new']);
  assert.deepEqual(calls, []);
  assert.equal(changed.episodes.new.status, 'pending');
  assert.equal(changed.episodes.new.attempts, 0);

  const restored = await retry(['new', 'removed', 'kept']);
  assert.deepEqual(calls, ['removed']);
  assert.equal(restored.episodes.removed.attempts, 2);
  assert.equal(restored.episodes.kept.attempts, 1);
  assert.equal(restored.episodes.new.status, 'pending');
});

test('process loss distinguishes interrupted and pending work from a recorded failure', async t => {
  const dir = temporaryBatch(t);
  const ids = ['completed', 'failed', 'crashed', 'queued'];
  // Exit after the batch marked the third episode running. No timers or race with file writes.
  const script = `
    const { runBatch } = require(process.argv[1]);
    const ids = JSON.parse(process.argv[3]);
    runBatch(process.argv[2], ids, async id => {
      if (id === 'failed') throw Error('expected failure');
      if (id === 'crashed') process.exit(17);
      return { status: 'ready_for_review' };
    }, { jobs: 1, log() {} }).catch(error => { console.error(error); process.exitCode = 1; });`;
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('./batch.cjs'), dir, JSON.stringify(ids)],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 17, child.stderr);
  const status = await inspectBatch(dir, ids);
  assert.deepEqual(ids.map(id => status.episodes[id].status), ['ready_for_review', 'failed', 'interrupted', 'pending']);
  const calls = [];
  await runBatch(dir, ids, async id => { calls.push(id); return ready; }, { ...quiet, retryFailed: true });
  assert.deepEqual(calls, ['failed']);
  const resumed = await runBatch(dir, ids, async () => ready, quiet);
  assert.ok(ids.every(id => resumed.episodes[id].status === 'ready_for_review'));
});
