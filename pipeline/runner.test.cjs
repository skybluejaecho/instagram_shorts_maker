const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runEpisode, inspectEpisode } = require('./runner.cjs');

function fixture(t) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-runner-test-'));
  t.after(() => {
    assert.equal(path.dirname(workDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(workDir).startsWith('shorts-runner-test-'));
    fs.rmSync(workDir, { recursive: true, force: true });
  });
  const inputs = { narration: 'one', title: 'first' };
  const calls = [];
  const stages = [
    {
      id: 'speech',
      inputs: () => ({ text: inputs.narration }),
      outputs: ['narration.wav'],
      async run({ dir }) {
        calls.push('speech');
        fs.writeFileSync(path.join(dir, 'narration.wav'), inputs.narration);
      },
    },
    {
      id: 'prepare',
      inputs: () => ({ title: inputs.title }),
      outputs: ['index.html'],
      async run({ dir, previous }) {
        calls.push('prepare');
        const text = fs.readFileSync(path.join(previous.speech, 'narration.wav'), 'utf8');
        fs.writeFileSync(path.join(dir, 'index.html'), inputs.title + ' ' + text);
      },
    },
    {
      id: 'render',
      inputs: () => ({ fps: 30 }),
      outputs: ['video.mp4'],
      async run({ dir, previous }) {
        calls.push('render');
        fs.copyFileSync(path.join(previous.prepare, 'index.html'), path.join(dir, 'video.mp4'));
      },
    },
  ];
  const options = { log() {} };
  return {
    workDir, inputs, stages, calls,
    run: () => runEpisode(workDir, stages, options),
    inspect: () => inspectEpisode(workDir, stages),
  };
}

test('unchanged run reuses every stage; a visual edit only rebuilds HTML and video', async t => {
  const job = fixture(t);
  const first = await job.run();
  assert.equal(first.status, 'ready_for_review');
  assert.deepEqual(job.calls, ['speech', 'prepare', 'render']);
  job.calls.length = 0;
  await job.run();
  assert.deepEqual(job.calls, []);

  job.inputs.title = 'edited';
  assert.deepEqual((await job.inspect()).steps.map(step => step.current), [true, false, false]);
  const edited = await job.run();
  assert.deepEqual(job.calls, ['prepare', 'render']);
  assert.equal(edited.stages.speech.dir, first.stages.speech.dir);
  const video = path.join(job.workDir, edited.stages.render.dir, 'video.mp4');
  assert.equal(fs.readFileSync(video, 'utf8'), 'edited one');

  job.inputs.narration = 'two';
  job.calls.length = 0;
  await job.run();
  assert.deepEqual(job.calls, ['speech', 'prepare', 'render']);
});

test('modified or missing stage artifacts are detected before reuse', async t => {
  const job = fixture(t);
  const first = await job.run();
  // Same file size: cache validation must check content too.
  fs.writeFileSync(path.join(job.workDir, first.stages.speech.dir, 'narration.wav'), 'bad');
  assert.equal((await job.inspect()).steps[0].current, false);
  job.calls.length = 0;
  const repaired = await job.run();
  assert.ok(job.calls.includes('speech'));
  assert.equal(fs.readFileSync(path.join(job.workDir, repaired.stages.speech.dir, 'narration.wav'), 'utf8'), 'one');

  fs.unlinkSync(path.join(job.workDir, repaired.stages.render.dir, 'video.mp4'));
  job.calls.length = 0;
  assert.deepEqual((await job.inspect()).steps.map(step => step.current), [true, true, false]);
  await job.run();
  assert.deepEqual(job.calls, ['render']);
});

test('stage-specific artifact validation runs before marking done and before reusing a stage', async t => {
  const job = fixture(t);
  let valid = false;
  let checked = 0;
  job.stages[1].validateOutputs = directory => {
    checked++;
    assert.ok(fs.existsSync(path.join(directory, 'index.html')));
    return valid;
  };
  await assert.rejects(job.run(), /output integrity validation failed/);
  assert.deepEqual(job.calls, ['speech', 'prepare']);
  assert.equal((await job.inspect()).state.stages.prepare.status, 'failed');
  valid = true;
  job.calls.length = 0;
  await job.run();
  assert.deepEqual(job.calls, ['prepare', 'render']);
  const previousChecks = checked;
  job.calls.length = 0;
  await job.run();
  assert.ok(checked > previousChecks);
  assert.deepEqual(job.calls, []);
});

test('validation-only gates block stale output but do not invalidate unchanged media caches', async t => {
  const job = fixture(t);
  let evidence = 'first source';
  let allowed = true;
  const gate = { id: 'content', validationOnly: true, inputs: () => ({ evidence, title: job.inputs.title }),
    outputs: ['report.json'], async run({ dir }) {
      job.calls.push('content');
      if (!allowed) throw new Error('Content needs review');
      fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ evidence, title: job.inputs.title }));
    } };
  job.stages.unshift(gate);
  const first = await job.run();
  assert.deepEqual(job.calls, ['content', 'speech', 'prepare', 'render']);
  job.calls.length = 0;
  evidence = 'updated source';
  assert.deepEqual((await job.inspect()).steps.map(step => step.current), [false, false, false, false]);
  const reviewed = await job.run();
  assert.deepEqual(job.calls, ['content']);
  assert.equal(reviewed.stages.speech.dir, first.stages.speech.dir);
  assert.equal(reviewed.stages.render.dir, first.stages.render.dir);
  assert.deepEqual((await job.inspect()).steps.map(step => step.current), [true, true, true, true]);
  job.calls.length = 0;
  job.inputs.title = 'new title';
  const revised = await job.run();
  assert.deepEqual(job.calls, ['content', 'prepare', 'render']);
  assert.equal(revised.stages.speech.dir, first.stages.speech.dir);
  job.calls.length = 0;
  allowed = false;
  evidence = 'unverified source';
  await assert.rejects(job.run(), /Content needs review/);
  assert.deepEqual(job.calls, ['content']);
  assert.equal((await job.inspect()).state.status, 'failed');
  allowed = true;
  job.calls.length = 0;
  await job.run();
  assert.deepEqual(job.calls, ['content']);
});

test('a failed stage cannot publish partial output and resumes from that stage', async t => {
  const job = fixture(t);
  const prepare = job.stages[1];
  const original = prepare.run;
  prepare.run = async ({ dir }) => {
    job.calls.push('prepare');
    fs.writeFileSync(path.join(dir, 'index.html'), 'partial');
    throw new Error('interrupted preparation');
  };
  await assert.rejects(job.run());
  const failed = await job.inspect();
  assert.equal(failed.state.status, 'failed');
  assert.equal(failed.state.stages.prepare.status, 'failed');
  assert.deepEqual(failed.steps.map(step => step.current), [true, false, false]);
  assert.deepEqual(job.calls, ['speech', 'prepare']);

  prepare.run = original;
  job.calls.length = 0;
  const resumed = await job.run();
  assert.equal(resumed.status, 'ready_for_review');
  assert.deepEqual(job.calls, ['prepare', 'render']);
  assert.equal(fs.readFileSync(path.join(job.workDir, resumed.stages.render.dir, 'video.mp4'), 'utf8'), 'first one');
});

test('two simultaneous commands cannot publish over each other', async t => {
  const job = fixture(t);
  const speech = job.stages[0];
  const original = speech.run;
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  speech.run = async context => {
    entered.resolve();
    await gate.promise;
    await original(context);
  };
  const owner = job.run();
  await entered.promise;
  try {
    await assert.rejects(job.run());
  } finally {
    gate.resolve();
    await owner;
  }
  assert.deepEqual(job.calls, ['speech', 'prepare', 'render']);
  assert.equal((await job.inspect()).state.status, 'ready_for_review');
});
