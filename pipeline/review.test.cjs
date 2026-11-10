const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runEpisode } = require('./runner.cjs');
const { inspectReview, recordReview } = require('./review.cjs');

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const workDir = fs.mkdtempSync(path.join(parent, 'shorts-review-test-'));
  t.after(() => {
    assert.equal(path.dirname(workDir), parent);
    assert.ok(path.basename(workDir).startsWith('shorts-review-test-'));
    fs.rmSync(workDir, { recursive: true, force: true });
  });
  const inputs = { narration: 'spoken words', title: 'first scene' };
  const calls = [];
  const stages = [
    {
      id: 'speech', inputs: () => ({ text: inputs.narration }), outputs: ['narration.wav'],
      async run({ dir }) {
        calls.push('speech');
        fs.writeFileSync(path.join(dir, 'narration.wav'), inputs.narration);
      },
    },
    {
      id: 'prepare', inputs: () => ({ title: inputs.title }), outputs: ['index.html'],
      async run({ dir, previous }) {
        calls.push('prepare');
        const voice = fs.readFileSync(path.join(previous.speech, 'narration.wav'), 'utf8');
        fs.writeFileSync(path.join(dir, 'index.html'), inputs.title + voice);
      },
    },
    {
      id: 'render', inputs: () => ({ fps: 30 }), outputs: ['video.mp4'],
      async run({ dir, previous }) {
        calls.push('render');
        fs.copyFileSync(path.join(previous.prepare, 'index.html'), path.join(dir, 'video.mp4'));
      },
    },
    {
      id: 'verify', inputs: () => ({ frames: 900 }), outputs: ['report.json'],
      async run({ dir }) {
        calls.push('verify');
        fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ frames: 900 }));
      },
    },
  ];
  return {
    workDir, inputs, stages, calls,
    run: () => runEpisode(workDir, stages, { log() {} }),
    inspect: () => inspectReview(workDir, stages),
    record: decision => recordReview(workDir, stages, decision),
    historyFile: path.join(workDir, 'review.json'),
  };
}

test('existing completed episodes enter review without writes; approvals survive unchanged reruns', async t => {
  const job = fixture(t);
  await job.run();
  const initial = await job.inspect();
  assert.equal(initial.status, 'ready_for_review');
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(initial.videoPath), true);
  assert.equal(fs.existsSync(initial.reportPath), true);
  assert.deepEqual(initial.history, []);
  assert.equal(fs.existsSync(job.historyFile), false);

  const decision = { action: 'approve', revision: initial.revision };
  assert.equal((await job.record(decision)).status, 'approved');
  const persisted = fs.readFileSync(job.historyFile, 'utf8');
  await job.record(decision);
  assert.equal(fs.readFileSync(job.historyFile, 'utf8'), persisted);
  job.calls.length = 0;
  await job.run();
  const resumed = await job.inspect();
  assert.deepEqual(job.calls, []);
  assert.equal(resumed.status, 'approved');
  assert.equal(resumed.revision, initial.revision);
  assert.equal(resumed.history.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(job.workDir, 'state.json'), 'utf8')).status, 'ready_for_review');
});

test('episodes without an active visual gate retain the exact legacy revision fingerprint', async t => {
  const job = fixture(t);
  const state = await job.run();
  const { render, verify } = state.stages;
  const expected = createHash('sha256').update(JSON.stringify({
    renderDirectory: render.dir, renderKey: render.key, video: render.outputs['video.mp4'],
    verificationKey: verify.key, report: verify.outputs['report.json'],
  })).digest('hex');
  assert.equal((await job.inspect()).revision, expected);
});

test('visual policy and warning changes require fresh approval even when the MP4 is reused', async t => {
  const job = fixture(t);
  let policy = 'normal';
  let imageValid = true;
  const visual = { id: 'visual', validationOnly: true, inputs: () => ({ policy }), outputs: ['report.json'],
    validateOutputs: () => imageValid,
    async run({ dir }) {
      job.calls.push('visual');
      fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ status: policy === 'normal' ? 'passed' : 'warnings', policy }));
    } };
  job.stages.splice(2, 0, visual);
  const first = await job.run();
  const original = await job.inspect();
  await job.record({ action: 'approve', revision: original.revision });
  job.calls.length = 0;
  await job.run();
  assert.deepEqual(job.calls, []);
  assert.equal((await job.inspect()).status, 'approved');
  policy = 'stricter text size';
  assert.equal((await job.inspect()).status, 'needs_rebuild');
  await assert.rejects(job.record({ action: 'approve', revision: original.revision }), /current.*verified|Rebuild/i);
  const rechecked = await job.run();
  assert.deepEqual(job.calls, ['visual']);
  assert.equal(rechecked.stages.render.dir, first.stages.render.dir);
  const changed = await job.inspect();
  assert.equal(changed.videoPath, original.videoPath);
  assert.notEqual(changed.revision, original.revision);
  assert.equal(changed.status, 'ready_for_review');
  await assert.rejects(job.record({ action: 'approve', revision: original.revision }), /revision has changed/i);
  await job.record({ action: 'approve', revision: changed.revision });
  assert.equal((await job.inspect()).status, 'approved');
  imageValid = false;
  assert.equal((await job.inspect()).status, 'needs_rebuild');
  await assert.rejects(job.record({ action: 'approve', revision: changed.revision }), /current.*verified|Rebuild/i);
});

test('changed content evidence requires fresh approval while unchanged media remains reusable', async t => {
  const job = fixture(t);
  let evidence = 'initial reference';
  job.stages.unshift({ id: 'content', validationOnly: true,
    inputs: () => ({ evidence }), outputs: ['report.json'],
    async run({ dir }) {
      job.calls.push('content');
      fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ status: 'passed', evidence }));
    } });
  const first = await job.run();
  const original = await job.inspect();
  await job.record({ action: 'approve', revision: original.revision });
  job.calls.length = 0;
  await job.run();
  assert.deepEqual(job.calls, []);
  assert.equal((await job.inspect()).status, 'approved');

  evidence = 'corrected reference';
  assert.equal((await job.inspect()).status, 'needs_rebuild');
  const checked = await job.run();
  assert.deepEqual(job.calls, ['content']);
  assert.equal(checked.stages.speech.dir, first.stages.speech.dir);
  assert.equal(checked.stages.render.dir, first.stages.render.dir);
  const current = await job.inspect();
  assert.equal(current.videoPath, original.videoPath);
  assert.notEqual(current.revision, original.revision);
  assert.equal(current.status, 'ready_for_review');
  await assert.rejects(job.record({ action: 'approve', revision: original.revision }), /revision has changed/i);
  await job.record({ action: 'approve', revision: current.revision });
  assert.equal((await job.inspect()).status, 'approved');
});

test('enabling a content gate does not inherit a prior approval without evidence review', async t => {
  const job = fixture(t);
  await job.run();
  const legacy = await job.inspect();
  const approved = await job.record({ action: 'approve', revision: legacy.revision });
  job.calls.length = 0;
  job.stages.unshift({ id: 'content', validationOnly: true,
    inputs: () => ({ required: true }), outputs: ['report.json'],
    async run({ dir }) {
      job.calls.push('content');
      fs.writeFileSync(path.join(dir, 'report.json'), '{"status":"passed"}');
    } });
  assert.equal((await job.inspect()).status, 'needs_rebuild');
  await job.run();
  assert.deepEqual(job.calls, ['content']);
  const current = await job.inspect();
  assert.equal(current.videoPath, legacy.videoPath);
  assert.notEqual(current.revision, legacy.revision);
  assert.equal(current.status, 'ready_for_review');
  assert.deepEqual(current.history, approved.history);
  await assert.rejects(job.record({ action: 'approve', revision: legacy.revision }), /revision has changed/i);
});

test('a targeted change request survives no-op runs and a new video returns to review with its history', async t => {
  const job = fixture(t);
  const first = await job.run();
  const original = await job.inspect();
  await job.record({ action: 'approve', revision: original.revision });
  const request = { action: 'request-changes', revision: original.revision,
    target: 'counterexample', note: '마지막 장면 전환을 조금 느리게' };
  const requested = await job.record(request);
  assert.equal(requested.status, 'changes_requested');
  assert.equal(requested.latestRequest.target, request.target);
  assert.equal(requested.latestRequest.note, request.note);
  await job.run();
  assert.equal((await job.inspect()).status, 'changes_requested');

  job.inputs.title = 'revised last scene';
  assert.equal((await job.inspect()).status, 'needs_rebuild');
  await assert.rejects(job.record({ action: 'approve', revision: original.revision }));
  job.calls.length = 0;
  const rebuilt = await job.run();
  const revised = await job.inspect();
  assert.deepEqual(job.calls, ['prepare', 'render', 'verify']);
  assert.equal(rebuilt.stages.speech.dir, first.stages.speech.dir);
  assert.equal(revised.status, 'ready_for_review');
  assert.notEqual(revised.revision, original.revision);
  assert.equal(revised.latestRequest.note, request.note);
  assert.deepEqual(revised.history.map(event => event.action), ['approve', 'request-changes']);
  await assert.rejects(job.record({ action: 'approve', revision: original.revision }), /revision/i);
  const accepted = await job.record({ action: 'approve', revision: revised.revision });
  assert.equal(accepted.status, 'approved');
  assert.equal(accepted.history.length, 3);
});

test('blank requests and absent or stale revision tokens cannot create a decision', async t => {
  const job = fixture(t);
  await job.run();
  const { revision } = await job.inspect();
  for (const decision of [
    { action: 'approve' },
    { action: 'approve', revision: '' },
    { action: 'approve', revision: '0'.repeat(64) },
    { action: 'request-changes', revision, target: 'episode', note: ' \n\t ' },
    { action: 'request-changes', revision, target: ' ', note: 'Change the last scene' },
    { action: 'unsupported', revision },
  ]) await assert.rejects(job.record(decision));
  assert.equal(fs.existsSync(job.historyFile), false);
  assert.equal((await job.inspect()).status, 'ready_for_review');
});

test('missing, altered, and failed artifacts prevent approval and preserve the prior decision', async t => {
  const job = fixture(t);
  await job.run();
  const current = await job.inspect();
  await job.record({ action: 'approve', revision: current.revision });
  const reviewBefore = fs.readFileSync(job.historyFile, 'utf8');
  fs.writeFileSync(current.videoPath, 'corrupt video');
  assert.equal((await job.inspect()).status, 'needs_rebuild');
  await assert.rejects(job.record({ action: 'approve', revision: current.revision }));
  await job.run();
  const repaired = await job.inspect();
  assert.equal(repaired.status, 'ready_for_review');
  assert.notEqual(repaired.revision, current.revision);
  fs.unlinkSync(repaired.reportPath);
  await assert.rejects(job.record({ action: 'approve', revision: repaired.revision }));
  const verify = job.stages[3];
  verify.run = async () => { throw Error('verification failed'); };
  await assert.rejects(job.run(), /verification failed/);
  const failed = await job.inspect();
  assert.notEqual(failed.status, 'approved');
  assert.equal(failed.revision, null);
  await assert.rejects(job.record({ action: 'approve', revision: repaired.revision }));
  assert.equal(fs.readFileSync(job.historyFile, 'utf8'), reviewBefore);
});

test('review decisions share the episode writer lock and cannot approve while a render is active', { timeout: 15_000 }, async t => {
  const job = fixture(t);
  await job.run();
  const prior = await job.inspect();
  await job.record({ action: 'approve', revision: prior.revision });
  const historyBefore = fs.readFileSync(job.historyFile, 'utf8');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const render = job.stages[2];
  const original = render.run;
  render.run = async context => {
    entered.resolve();
    await release.promise;
    await original(context);
  };
  job.inputs.title = 'new version';
  const running = job.run();
  try {
    await Promise.race([entered.promise, running]);
    await assert.rejects(job.record({ action: 'approve', revision: prior.revision }), /already running/i);
    assert.equal(fs.readFileSync(job.historyFile, 'utf8'), historyBefore);
  } finally {
    release.resolve();
    await running;
  }
  assert.equal((await job.inspect()).status, 'ready_for_review');
});

test('revising one episode preserves a sibling approval and corrupt review storage fails closed', async t => {
  const revised = fixture(t);
  const sibling = fixture(t);
  await revised.run();
  await sibling.run();
  const original = await revised.inspect();
  const unchanged = await sibling.inspect();
  await revised.record({ action: 'request-changes', revision: original.revision, target: 'episode', note: 'Adjust the final scene' });
  await sibling.record({ action: 'approve', revision: unchanged.revision });
  const siblingHistory = fs.readFileSync(sibling.historyFile, 'utf8');
  revised.inputs.title = 'corrected';
  await revised.run();
  assert.equal((await revised.inspect()).status, 'ready_for_review');
  assert.equal((await sibling.inspect()).status, 'approved');
  assert.equal(fs.readFileSync(sibling.historyFile, 'utf8'), siblingHistory);
  fs.writeFileSync(revised.historyFile, '{invalid');
  await assert.rejects(revised.inspect());
  await assert.rejects(revised.record({ action: 'approve', revision: original.revision }));
  assert.equal(fs.readFileSync(revised.historyFile, 'utf8'), '{invalid');
});
