const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerSeries: registerActualSeries, addPlans, editCatalog, saveCatalog } = require('../planning.cjs');
// Registration probes only the injected local voice inventory in these logic tests.
const registerSeries = (root, spec) => registerActualSeries(root, spec, {
  listVoices: async () => [{ name: 'Microsoft Heami Desktop', culture: 'ko-KR', enabled: true }],
});
const { createPeriod, readPeriod } = require('./planning.cjs');
const { runPeriod, inspectPeriod, reportHtml } = require('./engine.cjs');
const { saveState, lockWorkDir } = require('../run-state.cjs');

async function fixture(t, { count = 5, auto = false, batchSize = 2 } = {}) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-period-engine-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-period-engine-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const adapter = auto ? 'pipeline/story/adapter.cjs' : 'adapter.cjs';
  fs.mkdirSync(path.dirname(path.join(root, adapter)), { recursive: true });
  fs.writeFileSync(path.join(root, adapter), 'exports.createStages = () => [{id:"render",inputs:()=>({}),outputs:["video.mp4"],run:async()=>{}}];');
  fs.writeFileSync(path.join(root, 'input.json'), '{}');
  await registerSeries(root, { id: 'cs', name: 'CS', audience: 'beginner', topics: ['CS'], defaultDurationSeconds: 30, tone: 'plain', adapter });
  const plan = id => ({ id, title: 'Title ' + id, topicKey: id, objective: id, angle: 'example', references: [], input: 'input.json' });
  const plans = Array.from({ length: count }, (_, i) => plan('p' + (i + 1)));
  if (!auto) await addPlans(root, 'cs', plans);
  const { period } = await createPeriod(root, { id: 'five', seriesId: 'cs', startDate: '2026-11-16', days: count,
    batchSize, ...(!auto ? { planIds: plans.map(p => p.id) } : {}) });
  const outcomes = new Map();
  const calls = [];
  const inspect = async id => {
    const status = outcomes.get(id) || 'new';
    return { current: status === 'ready_for_review', status, details: [{ id: 'render', label: status === 'new' ? 'pending' : status === 'ready_for_review' ? 'current' : status }],
      review: { status: status === 'ready_for_review' ? status : 'unavailable' } };
  };
  const execute = async id => { calls.push(id); outcomes.set(id, 'ready_for_review'); };
  const generate = async ({ batchId, count: n }) => {
    const p = Array.from({ length: n }, (_, i) => plan(`${batchId}-${i + 1}`));
    // Fake only the costly generation boundary. Its own contract/commit tests
    // cover validation; this test exercises scheduler recovery after publication.
    return editCatalog(root, catalog => {
      const episodeIds = p.map(row => 'cs-' + row.id);
      for (const [i, row] of p.entries()) {
        catalog.plans.cs[row.id] = { ...row, seriesId: 'cs' };
        catalog.episodes[episodeIds[i]] = { seriesId: 'cs', planId: row.id, adapter, episode: 'input.json' };
      }
      catalog.batches[batchId] = episodeIds;
      saveCatalog(root, catalog);
      return { batchId, episodeIds };
    });
  };
  return { root, period, calls, outcomes, inspect, execute, generate, options: { inspect, execute, generate, log() {} } };
}

test('five slots survive one failure; retry only the failure, resume no current episodes', async t => {
  const f = await fixture(t);
  let fail = true;
  const options = { ...f.options, jobs: 2, execute: async id => {
    if (id === 'cs-p3' && fail) { f.calls.push(id); f.outcomes.set(id, 'failed'); throw Error('controlled render failure'); }
    return f.execute(id);
  } };
  const first = await runPeriod(f.root, 'five', options);
  assert.equal(first.status, 'failed');
  assert.equal(first.counts.ready_for_review, 4);
  assert.equal(first.counts.failed, 1);
  assert.equal(first.rows[2].error, 'controlled render failure');
  assert.equal(new Set(first.rows.map(row => row.episodeId)).size, 5);
  assert.ok(fs.existsSync(first.reportPath));
  f.calls.length = 0; fail = false;
  const second = await runPeriod(f.root, 'five', { ...options, retryFailed: true });
  assert.deepEqual(f.calls, ['cs-p3']);
  assert.equal(second.status, 'ready_for_review');
  assert.deepEqual(second.rows.map(row => row.attempts), [1, 1, 2, 1, 1]);
  f.calls.length = 0;
  const third = await runPeriod(f.root, 'five', { ...options, resume: true });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(third.rows.map(row => row.attempts), [1, 1, 2, 1, 1]);
});

test('plan-only binds all schedules without production and resume executes them', async t => {
  const f = await fixture(t);
  const planned = await runPeriod(f.root, 'five', { ...f.options, planOnly: true });
  assert.equal(planned.status, 'planned');
  assert.deepEqual(f.calls, []);
  assert.equal(planned.counts.input_ready, 5);
  const again = await createPeriod(f.root, { id: 'five', seriesId: 'cs', startDate: '2026-11-16', days: 5, batchSize: 2, planIds: ['p1', 'p2', 'p3', 'p4', 'p5'] });
  assert.equal(again.reused, true);
  const finished = await runPeriod(f.root, 'five', { ...f.options, resume: true });
  assert.equal(finished.counts.ready_for_review, 5);
});

test('a production content hold remains needs_review and only the held episode is retried', async t => {
  const f = await fixture(t, { count: 2 });
  const first = await runPeriod(f.root, 'five', { ...f.options, execute: async id => {
    if (id === 'cs-p1') {
      f.outcomes.set(id, 'needs_review');
      throw Object.assign(Error('Missing source support'), { code: 'CONTENT_REVIEW_REQUIRED' });
    }
    return f.execute(id);
  } });
  assert.equal(first.status, 'needs_review');
  assert.equal(first.rows[0].status, 'needs_review');
  assert.equal(first.rows[1].status, 'ready_for_review');
  f.calls.length = 0;
  const next = await runPeriod(f.root, 'five', { ...f.options, retryFailed: true });
  assert.deepEqual(f.calls, ['cs-p1']);
  assert.equal(next.status, 'ready_for_review');
});

test('planning hold is isolated to its group; retry plans only that group and produces its new episodes', async t => {
  const f = await fixture(t, { auto: true });
  const generationCalls = [];
  let fail = true;
  const generate = async request => {
    generationCalls.push(request.batchId);
    if (request.batchId === 'five-b02' && fail) {
      const dir = path.join(f.root, 'runs', '_generation', request.batchId);
      fs.mkdirSync(dir, { recursive: true });
      saveState(dir, { status: 'needs_review' });
      throw Error('source needs human review');
    }
    return f.generate(request);
  };
  const first = await runPeriod(f.root, 'five', { ...f.options, generate });
  assert.equal(first.counts.ready_for_review, 3);
  assert.equal(first.counts.needs_review, 2);
  assert.deepEqual(generationCalls, ['five-b01', 'five-b02', 'five-b03']);
  generationCalls.length = 0; f.calls.length = 0; fail = false;
  const second = await runPeriod(f.root, 'five', { ...f.options, generate, retryFailed: true });
  assert.deepEqual(generationCalls, ['five-b02']);
  assert.equal(f.calls.length, 2);
  assert.equal(second.counts.ready_for_review, 5);
});

test('recovers a committed batch before schedule attachment without generating again', async t => {
  const f = await fixture(t, { count: 1, auto: true });
  await f.generate({ batchId: 'five-b01', count: 1 });
  assert.equal(readPeriod(f.root, 'five').slots[0].episodeId, undefined);
  const done = await runPeriod(f.root, 'five', { ...f.options, generate: () => { throw Error('must not regenerate'); } });
  assert.equal(done.status, 'ready_for_review');
});

test('resume rebuilds stale results; retry-failed does not silently rebuild successful stale episodes', async t => {
  const f = await fixture(t, { count: 2 });
  await runPeriod(f.root, 'five', f.options);
  f.outcomes.set('cs-p1', 'needs_rebuild'); f.calls.length = 0;
  const retry = await runPeriod(f.root, 'five', { ...f.options, retryFailed: true });
  assert.deepEqual(f.calls, []);
  assert.equal(retry.counts.needs_rebuild, 1);
  const resumed = await runPeriod(f.root, 'five', { ...f.options, resume: true });
  assert.deepEqual(f.calls, ['cs-p1']);
  assert.equal(resumed.counts.ready_for_review, 2);
});

test('period lock blocks concurrent execution and status exposes active/queued rows', { timeout: 15000 }, async t => {
  const f = await fixture(t, { count: 3 });
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const running = runPeriod(f.root, 'five', { ...f.options, execute: async id => {
    entered.resolve(); await release.promise; return f.execute(id);
  } });
  try {
    await Promise.race([entered.promise, running]);
    const view = await inspectPeriod(f.root, 'five', { inspect: f.inspect });
    assert.equal(view.counts.running, 1);
    assert.equal(view.counts.queued, 2);
    await assert.rejects(runPeriod(f.root, 'five', f.options), /already running/);
  } finally { release.resolve(); await running; }
});

test('abandoned production is interrupted and resume retains completed rows', async t => {
  const f = await fixture(t, { count: 2 });
  await runPeriod(f.root, 'five', { ...f.options, planOnly: true });
  const dir = path.join(f.root, 'runs/_periods/five/production');
  fs.mkdirSync(dir, { recursive: true });
  saveState(dir, { version: 1, runId: 'crashed', episodes: {
    'cs-p1': { status: 'running', attempts: 1 }, 'cs-p2': { status: 'ready_for_review', attempts: 1 },
  } });
  f.outcomes.set('cs-p2', 'ready_for_review');
  assert.equal((await inspectPeriod(f.root, 'five', { inspect: f.inspect })).rows[0].status, 'interrupted');
  const done = await runPeriod(f.root, 'five', { ...f.options, resume: true });
  assert.deepEqual(f.calls, ['cs-p1']);
  assert.deepEqual(done.rows.map(row => row.attempts), [2, 1]);
});

test('inspection errors remain isolated and are retriable without hiding good episodes', async t => {
  const f = await fixture(t, { count: 2 });
  await runPeriod(f.root, 'five', f.options);
  const view = await inspectPeriod(f.root, 'five', { inspect: id => {
    if (id === 'cs-p1') throw Error('bad input');
    return f.inspect(id);
  } });
  assert.equal(view.rows[0].status, 'failed');
  assert.equal(view.rows[1].status, 'ready_for_review');
});

test('a live individual episode remains running and is not dispatched by period resume', async t => {
  const f = await fixture(t, { count: 1 });
  await runPeriod(f.root, 'five', { ...f.options, planOnly: true });
  const dir = path.join(f.root, 'runs/cs-p1');
  fs.mkdirSync(dir, { recursive: true });
  const release = await lockWorkDir(dir, 'Episode');
  f.outcomes.set('cs-p1', 'running');
  try {
    assert.equal((await inspectPeriod(f.root, 'five', { inspect: f.inspect })).rows[0].status, 'running');
    const resumed = await runPeriod(f.root, 'five', { ...f.options, resume: true });
    assert.deepEqual(f.calls, []);
    assert.equal(resumed.status, 'running');
  } finally { await release(); }
  assert.equal((await inspectPeriod(f.root, 'five', { inspect: f.inspect })).rows[0].status, 'interrupted');
});

test('invalid execution options fail before creating artifacts and reports escape inputs', async t => {
  const f = await fixture(t, { count: 1 });
  for (const options of [{ jobs: 0 }, { jobs: 9 }, { retryFailed: true, resume: true }]) {
    await assert.rejects(runPeriod(f.root, 'five', { ...f.options, ...options }));
  }
  assert.equal(fs.existsSync(path.join(f.root, 'runs')), false);
  const result = await inspectPeriod(f.root, 'five', { inspect: f.inspect });
  result.rows[0].title = '<script>alert(1)</script>';
  assert.ok(reportHtml(result).includes('&lt;script&gt;'));
  assert.ok(!reportHtml(result).includes('<script>'));
});
