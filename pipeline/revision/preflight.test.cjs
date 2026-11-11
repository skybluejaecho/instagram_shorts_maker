const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateSpec } = require('../story/spec.cjs');
const { createRevisionPreflight } = require('./preflight.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t, starts = [.1, 4.2, 8.3]) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-revision-preflight-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-revision-preflight-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = validateSpec({ version: 1, title: '스택 예제', durationSeconds: 12,
    narration: [{ id: 'hook', text: '무엇부터 꺼낼까요?' }, { id: 'idea', text: '마지막 값을 먼저 꺼냅니다.' },
      { id: 'finish', text: '스택의 순서를 기억하세요.' }],
    scenes: [{ id: 'question', type: 'question', from: 'hook', headline: '무엇부터 꺼낼까?' },
      { id: 'example', type: 'explanation', from: 'idea', headline: '마지막 값 먼저' },
      { id: 'end', type: 'conclusion', from: 'finish', headline: '순서 기억하기' }] });
  const workDir = path.join(root, 'runs/episode');
  const speechDir = 'artifacts/speech/fixture';
  const voice = path.join(workDir, speechDir, 'voice');
  fs.mkdirSync(voice, { recursive: true });
  const wav = Buffer.from('unchanged deterministic narration bytes');
  const timing = { text: source.narration.map(cue => cue.text).join(' '), voice: source.profile.speech.voice,
    rate: source.profile.speech.rate, durationSeconds: 10, audioSha256: hash(wav),
    marks: Object.fromEntries(source.narration.map((cue, i) => [cue.id, starts[i] - .05])),
    wordStarts: Object.fromEntries(source.narration.map((cue, i) => [cue.id, starts[i]])) };
  fs.writeFileSync(path.join(voice, 'narration.wav'), wav);
  fs.writeFileSync(path.join(voice, 'timing.json'), JSON.stringify(timing));
  const stage = { id: 'speech', inputs: () => ({ narration: source.narration, speech: source.profile.speech }),
    outputs: ['voice/narration.wav', 'voice/timing.json'], run: async () => { throw new Error('Must not run old speech.'); } };
  const state = { version: 1, status: 'ready_for_review', stages: { speech: { status: 'done', dir: speechDir,
    key: hash(JSON.stringify([stage.id, stage.inputs(), undefined, undefined])),
    outputs: Object.fromEntries(stage.outputs.map(file => [file, hash(fs.readFileSync(path.join(workDir, speechDir, file)))])) } } };
  const stateFile = path.join(workDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const snapshot = () => [stateFile, path.join(voice, 'narration.wav'), path.join(voice, 'timing.json')]
    .map(file => fs.readFileSync(file).toString('base64'));
  return { root, source, workDir, voice, state, stateFile, timing, wav, stages: [stage], snapshot,
    input: story => ({ source, story, directory: path.join(root, 'revision/preview'), workDir, stages: [stage] }) };
}

test('visual preflight reuses verified speech, builds a revised preview, and preserves old artifacts byte for byte', async t => {
  const job = fixture(t);
  const story = structuredClone(job.source);
  story.scenes[2].headline = '마지막 값부터';
  const before = job.snapshot();
  const preflight = createRevisionPreflight(job.root, { speechPreflight: async () => { throw new Error('Unexpected synthesis'); } });
  const args = job.input(story);
  const result = await preflight(args);
  assert.equal(result.reusedSpeech, true);
  assert.equal(result.audioSha256, hash(job.wav));
  assert.equal(result.speechSeconds, 10);
  assert.match(fs.readFileSync(path.join(args.directory, 'preview.html'), 'utf8'), /마지막 값부터/);
  assert.deepEqual(fs.readFileSync(path.join(args.directory, 'narration.wav')), job.wav);
  assert.deepEqual(job.snapshot(), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(args.directory, 'preflight.json'))), result);
});

test('visual preflight finds speech after a current content validation stage', async t => {
  const job = fixture(t);
  const directory = 'artifacts/content/fixture';
  fs.mkdirSync(path.join(job.workDir, directory), { recursive: true });
  fs.writeFileSync(path.join(job.workDir, directory, 'report.json'), '{"status":"passed"}');
  const stage = { id: 'content', validationOnly: true, inputs: () => ({ sourceHash: 'test-source' }), outputs: ['report.json'],
    run: async () => { throw new Error('Must not run validation during inspection'); } };
  const record = { status: 'done', dir: directory, key: hash(JSON.stringify([stage.id, stage.inputs(), undefined, undefined])),
    outputs: { 'report.json': hash(fs.readFileSync(path.join(job.workDir, directory, 'report.json'))) } };
  job.state.stages.content = record;
  const speech = job.stages[0];
  job.state.stages.speech.key = hash(JSON.stringify([speech.id, speech.inputs(), undefined, undefined]));
  fs.writeFileSync(job.stateFile, JSON.stringify(job.state));
  const args = { ...job.input(job.source), stages: [stage, speech] };
  const result = await createRevisionPreflight(job.root)(args);
  assert.equal(result.reusedSpeech, true);
  stage.inputs = () => ({ sourceHash: 'changed-source' });
  assert.equal((await createRevisionPreflight(job.root)(args)).reusedSpeech, true);
  speech.inputs = () => ({ narration: 'changed' });
  await assert.rejects(createRevisionPreflight(job.root)(args), /Saved speech is stale or changed/);
});

test('narration change delegates new speech measurement with the revised script and retains the baseline', async t => {
  const job = fixture(t);
  const story = structuredClone(job.source);
  story.narration[1].text = '가장 나중에 넣은 값부터 꺼내요.';
  const before = job.snapshot();
  let calls = 0;
  const preflight = createRevisionPreflight(job.root, { speechPreflight: async (entries, directory) => {
    calls++;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].plan.id, 'revision');
    assert.equal(entries[0].story.narration[1].text, story.narration[1].text);
    assert.deepEqual(entries[0].story.profile, job.source.profile);
    assert.equal(directory, job.input(story).directory);
    return [{ planId: 'revision', speechSeconds: 10.4, videoSeconds: 12, sceneCount: 3 }];
  } });
  const result = await preflight(job.input(story));
  assert.equal(calls, 1);
  assert.equal(result.reusedSpeech, false);
  assert.equal(result.speechSeconds, 10.4);
  assert.deepEqual(job.snapshot(), before);
});

test('stale, altered, or mismatched baseline speech stops without model-repair classification', async t => {
  for (const kind of ['hash', 'timing', 'stage']) {
    const job = fixture(t);
    if (kind === 'hash') fs.appendFileSync(path.join(job.voice, 'narration.wav'), 'corruption');
    if (kind === 'timing') {
      job.timing.text += ' 다른 대본';
      fs.writeFileSync(path.join(job.voice, 'timing.json'), JSON.stringify(job.timing));
      job.state.stages.speech.outputs['voice/timing.json'] = hash(fs.readFileSync(path.join(job.voice, 'timing.json')));
      fs.writeFileSync(job.stateFile, JSON.stringify(job.state));
    }
    if (kind === 'stage') job.stages[0].inputs = () => ({ changed: true });
    const preflight = createRevisionPreflight(job.root, { speechPreflight: async () => { throw new Error('Unexpected synthesis'); } });
    await assert.rejects(preflight(job.input(job.source)), error => error.generationRetryable === false, kind);
  }
});

test('a timing defect in the new story is repairable while existing audio remains untouched', async t => {
  const job = fixture(t, [.1, 1.2, 8.3]);
  const story = structuredClone(job.source);
  story.profile.transitionSeconds = 1.5;
  const before = job.snapshot();
  await assert.rejects(createRevisionPreflight(job.root)(job.input(story)), error => {
    assert.match(error.message, /too short for its transition/);
    assert.notEqual(error.generationRetryable, false);
    return true;
  });
  assert.deepEqual(job.snapshot(), before);
});

test('escaped speech paths and destinations inside old episode artifacts are rejected', async t => {
  const job = fixture(t);
  const preflight = createRevisionPreflight(job.root);
  await assert.rejects(preflight({ ...job.input(job.source), directory: path.join(job.workDir, 'preview') }), error => {
    assert.equal(error.generationRetryable, false);
    assert.match(error.message, /separate directory/);
    return true;
  });
  job.state.stages.speech.dir = '../outside';
  fs.writeFileSync(job.stateFile, JSON.stringify(job.state));
  await assert.rejects(preflight(job.input(job.source)), error => {
    assert.equal(error.generationRetryable, false);
    assert.match(error.message, /outside the episode/);
    return true;
  });
});

test('new synthesis I/O failures stop for environment recovery while measured timing failures remain repairable', async t => {
  const job = fixture(t);
  const story = structuredClone(job.source);
  story.narration[1].text = '조금 더 쉬운 설명으로 바꿉니다.';
  const preflight = createRevisionPreflight(job.root, { speechPreflight: async () => {
    const error = new Error('EPERM: cannot write synthesis output');
    error.code = 'EPERM';
    throw error;
  } });
  await assert.rejects(preflight(job.input(story)), error => error.generationRetryable === false);
  const timingFailure = createRevisionPreflight(job.root, { speechPreflight: async () => {
    throw new Error('Narration must fit the video with at least one second for the final hold.');
  } });
  await assert.rejects(timingFailure(job.input(story)), error => error.generationRetryable !== false);
});
