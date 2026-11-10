const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createContentStages, reviewEpisodeContent } = require('./runtime.cjs');
const { createContentChecker } = require('./checker.cjs');
const { runEpisode, inspectEpisode } = require('../runner.cjs');
const { createStages } = require('../story/adapter.cjs');
const { validateSpec } = require('../story/spec.cjs');

const quiet = () => {};
const evidence = 'A stack removes the most recently added item first.';

function checker(control, verdict = 'supported') {
  return createContentChecker({ provider: async ({ schema }) => {
    control.push('content');
    return { units: schema.properties.units.items.properties.unitId.enum.map(unitId => ({
      unitId, verdict, claim: '스택의 후입선출 순서', reason: '자료의 순서 정의와 대조한 테스트 판정입니다.',
      evidence: verdict === 'uncertain' ? [] : [{ sourceId: 'stack', quote: evidence }],
    })), consistency: schema.properties.consistency.items.properties.planId.enum.map(planId => ({
      planId, verdict: 'consistent', reason: '화면과 낭독이 같은 순서입니다.',
    })) };
  } });
}

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-content-runtime-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-content-runtime-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceFile = path.join(root, 'evidence.txt');
  fs.writeFileSync(sourceFile, evidence);
  const story = validateSpec({ version: 1, title: '스택의 순서', durationSeconds: 12,
    narration: [{ id: 'hook', text: '스택은 무엇부터 꺼낼까요?' }, { id: 'end', text: '마지막에 넣은 값부터 꺼냅니다.' }],
    scenes: [{ id: 'question', type: 'question', from: 'hook', headline: '무엇부터 꺼낼까요?' },
      { id: 'end', type: 'conclusion', from: 'end', headline: '마지막 입력부터' }] });
  const episodeFile = path.join(root, 'episode.json');
  fs.writeFileSync(episodeFile, JSON.stringify(story));
  fs.mkdirSync(path.join(root, 'planning'));
  const catalogFile = path.join(root, 'planning/catalog.json');
  const catalog = { version: 1, series: { cs: { id: 'cs', name: 'CS 테스트',
    contentReview: { mode: 'required', sources: [{ id: 'stack', title: 'Stack definition', path: 'evidence.txt' }] } } },
    plans: { cs: { order: { id: 'order', title: story.title, objective: '스택의 후입선출을 이해한다.', angle: '두 카드 예시', references: [] } } },
    episodes: { 'cs-order': { seriesId: 'cs', planId: 'order', episode: 'episode.json', adapter: 'pipeline/story/adapter.cjs' } }, batches: {} };
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  const calls = [];
  const workDir = path.join(root, 'runs/cs-order');
  const stages = ['speech', 'prepare', 'render', 'verify'].map(id => ({ id,
    inputs: () => id === 'speech' ? { narration: story.narration } : id === 'prepare' ? { scenes: story.scenes } : { id }, outputs: ['output.txt'],
    async run({ dir }) { calls.push(id); fs.writeFileSync(path.join(dir, 'output.txt'), id); } }));
  const options = { root, episodeFile, story, stages, checker: checker(calls) };
  return { root, sourceFile, story, episodeFile, catalogFile, catalog, calls, workDir, stages, options,
    make: more => createContentStages({ ...options, ...more }),
    run: more => runEpisode(workDir, createContentStages({ ...options, ...more }), { log: quiet }) };
}

test('required production checks evidence before speech; unchanged status and rerun invoke no model', async t => {
  const job = fixture(t);
  const stages = job.make();
  assert.deepEqual(stages.map(stage => stage.id), ['content', 'speech', 'prepare', 'render', 'verify']);
  await inspectEpisode(job.workDir, stages);
  assert.deepEqual(job.calls, []);
  const state = await job.run();
  assert.deepEqual(job.calls, ['content', 'speech', 'prepare', 'render', 'verify']);
  const report = JSON.parse(fs.readFileSync(path.join(job.workDir, state.stages.content.dir, 'report.json')));
  assert.equal(report.status, 'passed');
  job.calls.length = 0;
  await job.run();
  assert.deepEqual(job.calls, []);
});

test('unavailable or uncertain evidence blocks speech and preserves a report', async t => {
  const job = fixture(t);
  await assert.rejects(job.run({ checker: checker(job.calls, 'uncertain') }), /Content validation needs_review/);
  assert.deepEqual(job.calls, ['content']);
  const other = fixture(t);
  fs.unlinkSync(other.sourceFile);
  await assert.rejects(other.run(), /Content validation needs_review/);
  assert.deepEqual(other.calls, []);
  const state = JSON.parse(fs.readFileSync(path.join(other.workDir, 'state.json')));
  const report = JSON.parse(fs.readFileSync(path.join(other.workDir, state.stages.content.dir, 'report.json')));
  assert.equal(report.status, 'needs_review');
  assert.equal(report.issues[0].sourceId, 'stack');
});

test('source or episode edits invalidate the content stage and old ready status', async t => {
  const job = fixture(t);
  await job.run();
  job.calls.length = 0;
  fs.appendFileSync(job.sourceFile, '\nA source revision.');
  const inspected = await inspectEpisode(job.workDir, job.make());
  assert.equal(inspected.steps[0].current, false);
  await job.run();
  assert.deepEqual(job.calls, ['content']);
  const held = job.make();
  const changed = structuredClone(job.story);
  changed.scenes[1].headline = '직접 바꾼 문구';
  fs.writeFileSync(job.episodeFile, JSON.stringify(changed));
  assert.throws(() => held[0].inputs(), /Episode input changed/);
});

test('visual-only review thresholds do not invalidate factual evidence or media caches', async t => {
  const job = fixture(t);
  await job.run();
  job.calls.length = 0;
  job.catalog.series.cs.visualReview = { charsPerSecond: 9, minFontPx: { body: 36 } };
  fs.writeFileSync(job.catalogFile, JSON.stringify(job.catalog));
  const inspected = await inspectEpisode(job.workDir, job.make());
  assert.ok(inspected.steps.every(step => step.current));
  await job.run();
  assert.deepEqual(job.calls, []);
});

test('visual changes recheck content and reuse speech; narration changes still rebuild audio', async t => {
  const job = fixture(t);
  const first = await job.run();
  job.calls.length = 0;
  job.story.scenes[1].headline = '나중 입력부터';
  fs.writeFileSync(job.episodeFile, JSON.stringify(job.story));
  const visual = await job.run();
  assert.deepEqual(job.calls, ['content', 'prepare', 'render', 'verify']);
  assert.equal(visual.stages.speech.dir, first.stages.speech.dir);
  job.calls.length = 0;
  job.story.narration[1].text = '가장 나중에 넣은 값이 먼저 나옵니다.';
  fs.writeFileSync(job.episodeFile, JSON.stringify(job.story));
  const spoken = await job.run();
  assert.deepEqual(job.calls, ['content', 'speech', 'prepare', 'render', 'verify']);
  assert.notEqual(spoken.stages.speech.dir, first.stages.speech.dir);
});

test('a failed content recheck blocks reuse of already-completed media', async t => {
  const job = fixture(t);
  const first = await job.run();
  job.calls.length = 0;
  fs.appendFileSync(job.sourceFile, '\nDifferent source revision.');
  await assert.rejects(job.run({ checker: checker(job.calls, 'uncertain') }), /Content validation needs_review/);
  assert.deepEqual(job.calls, ['content']);
  const inspected = await inspectEpisode(job.workDir, job.make());
  assert.equal(inspected.state.status, 'failed');
  assert.equal(inspected.state.stages.speech.dir, first.stages.speech.dir);
  assert.equal(inspected.steps.every(step => !step.current), true);
});

test('source changes after content review stop downstream production instead of using a stale pass', async t => {
  const job = fixture(t);
  const stages = job.stages.map(stage => stage.id === 'speech' ? { ...stage,
    async run(context) { await stage.run(context); fs.appendFileSync(job.sourceFile, '\nChanged while speaking.'); } } : stage);
  await assert.rejects(job.run({ stages }), /sources or series settings changed/);
  assert.deepEqual(job.calls, ['content', 'speech']);
});

test('off policy preserves legacy stages and the story adapter enables the gate only when required', async t => {
  const job = fixture(t);
  assert.equal(createStages({ root: job.root, episodeFile: job.episodeFile, tools: {}, contentChecker: checker(job.calls) })[0].id, 'content');
  job.catalog.series.cs.contentReview = { mode: 'off', sources: [] };
  fs.writeFileSync(job.catalogFile, JSON.stringify(job.catalog));
  assert.equal(job.make(), job.stages);
  const stages = createStages({ root: job.root, episodeFile: job.episodeFile, tools: {} });
  assert.deepEqual(stages.map(stage => stage.id), ['speech', 'prepare', 'visual', 'render', 'verify']);
  await job.run();
  assert.deepEqual(job.calls, ['speech', 'prepare', 'render', 'verify']);
});

test('revision precheck inspects its proposed story and exposes a source freshness guard', async t => {
  const job = fixture(t);
  const changed = structuredClone(job.story);
  changed.scenes[1].headline = '나중 값 먼저';
  let checked;
  const base = checker(job.calls);
  const result = await reviewEpisodeContent({ ...job.options, story: changed, directory: path.join(job.root, 'revision-content'),
    checker: async options => { checked = options.entries[0].story; return base(options); } });
  assert.equal(checked.scenes[1].headline, '나중 값 먼저');
  assert.equal(result.report.status, 'passed');
  result.assertCurrent();
  fs.appendFileSync(job.sourceFile, '\nUpdated evidence.');
  assert.throws(result.assertCurrent, /sources or series settings changed/);
  assert.equal(JSON.parse(fs.readFileSync(job.episodeFile)).scenes[1].headline, job.story.scenes[1].headline);
});
