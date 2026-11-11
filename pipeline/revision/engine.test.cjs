const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reviseEpisode, inspectRevision } = require('./engine.cjs');
const { runEpisode } = require('../runner.cjs');
const { inspectReview, recordReview } = require('../review.cjs');
const { validateSpec } = require('../story/spec.cjs');

const quiet = () => {};
const visual = () => ({ summary: '마지막 화면의 문구를 줄였습니다.', edits: [
  { section: 'scene', id: 'ending', field: 'headline', value: '맨 위만 확인' },
] });
const spoken = () => ({ summary: '마지막 낭독을 쉽게 바꿨습니다.', edits: [
  { section: 'narration', id: 'finish', field: 'text', value: '값을 꺼내지 않고 맨 위에 무엇이 있는지 보는 방법입니다.' },
] });

function contentFixture(job) {
  const quote = 'Peek returns the top value without removing it.';
  const sourceFile = path.join(job.root, 'evidence.txt');
  fs.writeFileSync(sourceFile, quote);
  fs.mkdirSync(path.join(job.root, 'planning'));
  fs.writeFileSync(path.join(job.root, 'planning/catalog.json'), JSON.stringify({ version: 1,
    series: { cs: { id: 'cs', name: 'CS', contentReview: { mode: 'required',
      sources: [{ id: 'peek', title: 'Peek', path: 'evidence.txt' }] } } },
    plans: { cs: { peek: { id: 'peek', title: '스택의 값 확인', objective: '제거 없이 확인한다.', angle: '스택 예시', references: [] } } },
    episodes: { 'sample-episode': { episode: 'episode.json', seriesId: 'cs', planId: 'peek' } }, batches: {} }));
  return { sourceFile, check: (verdict = 'supported', callback = () => {}) => require('../content/checker.cjs').createContentChecker({
    provider: async ({ schema }) => {
      callback();
      return { units: schema.properties.units.items.properties.unitId.enum.map(unitId => ({ unitId, verdict,
        claim: '제거 없이 맨 위 확인', reason: '제공된 정의를 확인한 테스트 판정입니다.',
        evidence: verdict === 'uncertain' ? [] : [{ sourceId: 'peek', quote }] })),
        consistency: [{ planId: 'peek', verdict: 'consistent', reason: '화면과 낭독의 설명이 일치합니다.' }] };
    },
  }) };
}

async function fixture(t, { scope = 'visual', target = 'ending' } = {}) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-revision-engine-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-revision-engine-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const episodeId = 'sample-episode';
  const workDir = path.join(root, 'runs', episodeId);
  const episodeFile = path.join(root, 'episode.json');
  const input = { version: 1, title: '스택의 값 확인', durationSeconds: 30, customMetadata: { retained: true },
    narration: [{ id: 'hook', text: '맨 위 값을 꺼내야 확인할 수 있을까요?' }, { id: 'finish', text: '픽은 값을 제거하지 않고 확인합니다.' }],
    scenes: [{ id: 'opening', type: 'question', from: 'hook', headline: '꺼내야 할까요?' },
      { id: 'ending', type: 'conclusion', from: 'finish', headline: '보존하며 확인해요', body: '맨 위 값을 제거하지 않아요' }] };
  fs.writeFileSync(episodeFile, JSON.stringify(input, null, 2) + '\n');
  const calls = [];
  const control = { failRender: false };
  const createStages = () => {
    const spec = validateSpec(JSON.parse(fs.readFileSync(episodeFile)));
    return [
      { id: 'speech', inputs: () => ({ narration: spec.narration, speech: spec.profile.speech }), outputs: ['voice.wav'],
        async run({ dir }) { calls.push('speech'); fs.writeFileSync(path.join(dir, 'voice.wav'), JSON.stringify(spec.narration)); } },
      { id: 'prepare', inputs: () => spec, outputs: ['index.html'],
        async run({ dir, previous }) {
          calls.push('prepare');
          fs.writeFileSync(path.join(dir, 'index.html'), JSON.stringify(spec) + fs.readFileSync(path.join(previous.speech, 'voice.wav'), 'utf8'));
        } },
      { id: 'render', inputs: () => ({ fps: 30 }), outputs: ['video.mp4'],
        async run({ dir, previous }) {
          calls.push('render');
          if (control.failRender) throw new Error('Fixture render failed');
          fs.copyFileSync(path.join(previous.prepare, 'index.html'), path.join(dir, 'video.mp4'));
        } },
      { id: 'verify', inputs: () => ({ frames: 900 }), outputs: ['report.json'],
        async run({ dir }) { calls.push('verify'); fs.writeFileSync(path.join(dir, 'report.json'), '{"frames":900}'); } },
    ];
  };
  const initialState = await runEpisode(workDir, createStages(), { log: quiet });
  const originalReview = await inspectReview(workDir, createStages());
  const requested = await recordReview(workDir, createStages(), { action: 'request-changes', revision: originalReview.revision,
    target, note: scope === 'narration' ? '마지막 낭독을 더 쉽게 바꿔 주세요.' : '마지막 화면 문구를 줄여 주세요.' });
  const requestId = requested.latestRequest.id;
  calls.length = 0;
  const options = { episodeId, episodeFile, workDir, createStages, requestId, scope, preflight: async () => {}, log: quiet };
  return { root, workDir, episodeFile, createStages, initialState, originalReview, requestId, options, calls, control,
    source: fs.readFileSync(episodeFile, 'utf8'),
    state: () => inspectRevision(root, requestId),
    review: () => inspectReview(workDir, createStages()),
    run: more => reviseEpisode(root, { ...options, provider: async () => scope === 'narration' ? spoken() : visual(), ...more }),
  };
}

test('visual revision preserves speech, source metadata and old video; repeat request does not call model or render', async t => {
  const job = await fixture(t);
  let modelCalls = 0;
  const result = await job.run({ provider: async () => { modelCalls++; return visual(); } });
  assert.equal(result.status, 'ready_for_review');
  assert.deepEqual(job.calls, ['prepare', 'render', 'verify']);
  const state = JSON.parse(fs.readFileSync(path.join(job.workDir, 'state.json')));
  assert.equal(state.stages.speech.dir, job.initialState.stages.speech.dir);
  assert.equal(fs.existsSync(result.oldVideoPath), true);
  assert.notEqual(result.newVideoPath, result.oldVideoPath);
  assert.notEqual(result.newRevision, result.oldRevision);
  const modified = JSON.parse(fs.readFileSync(job.episodeFile));
  assert.equal(modified.scenes[1].headline, '맨 위만 확인');
  assert.deepEqual(modified.customMetadata, { retained: true });
  assert.deepEqual((await job.review()).history.map(event => event.action), ['request-changes']);
  job.calls.length = 0;
  const reused = await job.run({ provider: async () => { throw new Error('Must not regenerate'); } });
  assert.equal(reused.reused, true);
  assert.equal(modelCalls, 1);
  assert.deepEqual(job.calls, []);
});

test('narration revision rebuilds speech and dependent stages and stays pending human review', async t => {
  const job = await fixture(t, { scope: 'narration' });
  let checked;
  const result = await job.run({ preflight: async context => { checked = context; } });
  assert.deepEqual(job.calls, ['speech', 'prepare', 'render', 'verify']);
  assert.equal(checked.changes[0].section, 'narration');
  assert.equal(checked.request.id, job.requestId);
  assert.equal(result.status, 'ready_for_review');
  assert.equal((await job.review()).status, 'ready_for_review');
});

test('required content review holds an uncertain revision before TTS and resumes its saved candidate', async t => {
  const job = await fixture(t);
  const content = contentFixture(job);
  let modelCalls = 0;
  let preflightCalls = 0;
  await assert.rejects(job.run({ provider: async () => { modelCalls++; return visual(); },
    contentChecker: content.check('uncertain'), preflight: async () => { preflightCalls++; } }),
  error => error.code === 'CONTENT_REVIEW_REQUIRED');
  assert.equal(modelCalls, 1);
  assert.equal(preflightCalls, 0);
  assert.equal((await job.state()).status, 'needs_review');
  assert.ok((await job.state()).contentReportFile);
  assert.equal(fs.readFileSync(job.episodeFile, 'utf8'), job.source);
  assert.deepEqual(job.calls, []);
  const result = await job.run({ provider: async () => { throw new Error('Must reuse pending patch'); },
    contentChecker: content.check(), preflight: async () => { preflightCalls++; } });
  assert.equal(result.status, 'ready_for_review');
  assert.equal(preflightCalls, 1);
});

test('contradicted revision receives bounded content feedback before speech preflight', async t => {
  const job = await fixture(t);
  const content = contentFixture(job);
  let checks = 0;
  let patchCalls = 0;
  let preflightCalls = 0;
  let repairPrompt;
  const result = await job.run({ provider: async ({ prompt }) => { patchCalls++; repairPrompt = prompt; return visual(); },
    contentChecker: async options => content.check(++checks === 1 ? 'contradicted' : 'supported')(options),
    preflight: async () => { preflightCalls++; } });
  assert.equal(result.status, 'ready_for_review');
  assert.equal(checks, 2);
  assert.equal(patchCalls, 2);
  assert.equal(preflightCalls, 1);
  assert.match(repairPrompt, /Content validation corrections/);
});

test('revision content validation uses the supplied model provider', async t => {
  const job = await fixture(t);
  contentFixture(job);
  const calls = [];
  const result = await job.run({ provider: async ({ schema }) => {
    if (schema.properties.edits) { calls.push('patch'); return visual(); }
    calls.push('content');
    return { units: schema.properties.units.items.properties.unitId.enum.map(unitId => ({ unitId, verdict: 'supported',
      claim: '제거 없이 맨 위 확인', reason: '제공된 정의가 지지합니다.',
      evidence: [{ sourceId: 'peek', quote: 'Peek returns the top value without removing it.' }] })),
      consistency: [{ planId: 'peek', verdict: 'consistent', reason: '화면과 음성이 일치합니다.' }] };
  } });
  assert.equal(result.status, 'ready_for_review');
  assert.deepEqual(calls, ['patch', 'content']);
});

test('sources changed during revision TTS prevent publication and preserve the candidate', async t => {
  const job = await fixture(t);
  const content = contentFixture(job);
  await assert.rejects(job.run({ contentChecker: content.check(), preflight: async () => {
    fs.appendFileSync(content.sourceFile, '\nUpdated reference.');
  } }), error => error.code === 'CONTENT_SOURCES_CHANGED');
  assert.equal((await job.state()).status, 'content_failed');
  assert.equal(fs.readFileSync(job.episodeFile, 'utf8'), job.source);
  assert.deepEqual(job.calls, []);
});

test('invalid patches and measured timing errors receive bounded repair without touching original inputs', async t => {
  const job = await fixture(t);
  let calls = 0;
  const bad = { summary: 'Unrelated scene', edits: [{ section: 'scene', id: 'opening', field: 'headline', value: '다른 질문' }] };
  await assert.rejects(job.run({ maxAttempts: 2, provider: async () => { calls++; return bad; } }), /did not pass validation/);
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(job.episodeFile, 'utf8'), job.source);
  assert.equal((await job.review()).revision, job.originalReview.revision);
  assert.deepEqual(job.calls, []);
  let repairPrompt;
  const result = await job.run({ provider: async ({ prompt }) => { repairPrompt = prompt; return visual(); } });
  assert.match(repairPrompt, /Unrelated scene/);
  assert.equal(result.status, 'ready_for_review');
});

test('runtime preflight failure preserves candidate and resumes without another model request', async t => {
  const job = await fixture(t);
  let calls = 0;
  await assert.rejects(job.run({ provider: async () => { calls++; return visual(); }, preflight: async () => {
    const error = new Error('Voice is missing'); error.generationRetryable = false; throw error;
  } }), /Voice is missing/);
  assert.equal((await job.state()).status, 'preflight_failed');
  assert.equal(fs.readFileSync(job.episodeFile, 'utf8'), job.source);
  const result = await job.run({ provider: async () => { calls++; return visual(); } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'ready_for_review');
});

test('render failure preserves published candidate and resumes only failed downstream stages', async t => {
  const job = await fixture(t);
  let calls = 0;
  job.control.failRender = true;
  await assert.rejects(job.run({ provider: async () => { calls++; return visual(); } }), /Fixture render failed/);
  assert.equal((await job.state()).status, 'render_failed');
  assert.equal(JSON.parse(fs.readFileSync(job.episodeFile)).scenes[1].headline, '맨 위만 확인');
  assert.equal(fs.existsSync(job.originalReview.videoPath), true);
  job.control.failRender = false;
  job.calls.length = 0;
  const result = await job.run({ provider: async () => { calls++; return visual(); } });
  assert.equal(calls, 1);
  assert.deepEqual(job.calls, ['render', 'verify']);
  assert.equal(result.status, 'ready_for_review');
});

test('stale approval, superseding review and concurrent manual source changes cannot be overwritten', async t => {
  const job = await fixture(t);
  await recordReview(job.workDir, job.createStages(), { action: 'approve', revision: job.originalReview.revision });
  let calls = 0;
  await assert.rejects(job.run({ provider: async () => { calls++; return visual(); } }), /stale or superseded/);
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(job.episodeFile, 'utf8'), job.source);

  const other = await fixture(t);
  const changed = JSON.parse(other.source); changed.scenes[0].headline = '직접 수정한 질문';
  await assert.rejects(other.run({ provider: async () => {
    fs.writeFileSync(other.episodeFile, JSON.stringify(changed));
    return visual();
  } }), /input changed/);
  assert.equal(JSON.parse(fs.readFileSync(other.episodeFile)).scenes[0].headline, '직접 수정한 질문');
  assert.equal(JSON.parse(fs.readFileSync(other.episodeFile)).scenes[1].headline, '보존하며 확인해요');
  assert.deepEqual(other.calls, []);
});

test('saved candidate integrity and retry scope are verified before resuming', async t => {
  const job = await fixture(t);
  await assert.rejects(job.run({ preflight: async () => {
    const error = new Error('Missing voice'); error.generationRetryable = false; throw error;
  } }), /Missing voice/);
  const state = await job.state();
  const directory = path.join(job.root, 'runs/_revisions', job.requestId);
  await assert.rejects(job.run({ scope: 'both' }), /different request, episode or scope/);
  fs.appendFileSync(path.join(directory, state.pending.candidateFile), '\n');
  await assert.rejects(job.run(), /artifact changed/);
  assert.equal(fs.readFileSync(job.episodeFile, 'utf8'), job.source);
});

test('revision locks block duplicate application and reviews while model work is active', async t => {
  const job = await fixture(t);
  let started;
  let release;
  const ready = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const running = job.run({ provider: async () => { started(); await held; return visual(); } });
  await ready;
  try {
    assert.equal((await job.state()).status, 'generating');
    await assert.rejects(job.run(), /already running/);
    await assert.rejects(recordReview(job.workDir, job.createStages(), { action: 'approve', revision: job.originalReview.revision }), /already running/);
  } finally { release(); }
  await running;
});

test('unsupported requests stop after one model answer and preserve the reviewed input', async t => {
  const job = await fixture(t);
  let calls = 0;
  await assert.rejects(job.run({ provider: async () => {
    calls++; return { summary: '현재 텍스트 수정으로는 전환 속도를 바꿀 수 없습니다.', edits: [] };
  } }), error => error.code === 'REVISION_UNSUPPORTED');
  assert.equal(calls, 1);
  assert.equal((await job.state()).status, 'unsupported');
  assert.equal(fs.readFileSync(job.episodeFile, 'utf8'), job.source);
});

test('an orphan initial snapshot can resume after the first journal write fails', async t => {
  const job = await fixture(t);
  const journalFile = path.join(job.root, 'runs', '_revisions', job.requestId, 'state.json');
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (to === journalFile) throw new Error('Fixture initial journal write failed');
    return rename.call(fs, from, to);
  };
  try {
    await assert.rejects(job.run(), /initial journal write failed/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(journalFile), false);
  assert.equal(fs.existsSync(path.join(path.dirname(journalFile), 'before.json')), true);
  assert.equal((await job.run()).status, 'ready_for_review');
});

test('publication survives a journal failure after atomic input replacement without regenerating', async t => {
  const job = await fixture(t);
  const journalFile = path.join(job.root, 'runs', '_revisions', job.requestId, 'state.json');
  const rename = fs.renameSync;
  let interrupted = false;
  let calls = 0;
  fs.renameSync = function (from, to) {
    if (!interrupted && to === journalFile && JSON.parse(fs.readFileSync(from)).status === 'applied') {
      interrupted = true;
      throw new Error('Fixture journal interrupted after publication');
    }
    return rename.call(fs, from, to);
  };
  try {
    await assert.rejects(job.run({ provider: async () => { calls++; return visual(); } }), /interrupted after publication/);
  } finally { fs.renameSync = rename; }
  assert.equal(interrupted, true);
  assert.equal(JSON.parse(fs.readFileSync(job.episodeFile)).scenes[1].headline, '맨 위만 확인');
  assert.equal(fs.existsSync(job.originalReview.videoPath), true);
  assert.equal((await job.run({ provider: async () => { calls++; return visual(); } })).status, 'ready_for_review');
  assert.equal(calls, 1);
});

test('reapplying an old completed request cannot overwrite later inputs or alter its historical result', async t => {
  const job = await fixture(t);
  await job.run();
  const completed = await job.state();
  const input = JSON.parse(fs.readFileSync(job.episodeFile));
  input.scenes[1].body = '사용자가 새로 고친 문구';
  fs.writeFileSync(job.episodeFile, JSON.stringify(input));
  await assert.rejects(job.run(), /already applied/);
  assert.deepEqual(await job.state(), completed);
  assert.equal(JSON.parse(fs.readFileSync(job.episodeFile)).scenes[1].body, '사용자가 새로 고친 문구');
});

test('artifact storage failures preserve a pending candidate instead of spending model repairs', async t => {
  const job = await fixture(t);
  const write = fs.writeFileSync;
  let calls = 0;
  fs.writeFileSync = function (file, ...args) {
    if (path.basename(String(file)).startsWith('after-')) {
      const error = new Error('Fixture disk full'); error.code = 'ENOSPC'; throw error;
    }
    return write.call(fs, file, ...args);
  };
  try {
    await assert.rejects(job.run({ provider: async () => { calls++; return visual(); } }), /disk full/);
  } finally { fs.writeFileSync = write; }
  assert.equal((await job.state()).status, 'preflight_failed');
  assert.equal(fs.readFileSync(job.episodeFile, 'utf8'), job.source);
  assert.equal(calls, 1);
  await job.run({ provider: async () => { calls++; return visual(); } });
  assert.equal(calls, 1);
});
