const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerSeries: registerActualSeries, addPlans, readCatalog, commitGeneratedBatch } = require('./planning.cjs');
// Registration probes only the injected local voice inventory in these logic tests.
const registerSeries = (root, spec) => registerActualSeries(root, spec, {
  listVoices: async () => [{ name: 'Microsoft Heami Desktop', culture: 'ko-KR', enabled: true }],
});
const { validateSpec } = require('./story/spec.cjs');
const { readSeriesHistory } = require('./novelty/history.cjs');
const { configureContentReview } = require('./planning.cjs');
const { readEvidenceBundle } = require('./content/sources.cjs');
const { createContentChecker, collectUnits } = require('./content/checker.cjs');

async function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-generated-commit-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-generated-commit-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'pipeline/story'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pipeline/story/adapter.cjs'), `
    exports.createStages = ({episodeFile}) => {
      const spec = JSON.parse(require('node:fs').readFileSync(episodeFile));
      if (spec.title === 'adapter-failure') throw Error('adapter rejection');
      return [{id:'render', inputs:()=>spec, outputs:['video.mp4'], run:async()=>{}}];
    };`);
  await registerSeries(root, { id: 'demo', name: 'Demo', audience: '입문자', topics: ['스택'],
    defaultDurationSeconds: 30, tone: '간결하게', adapter: 'pipeline/story/adapter.cjs' });
  return root;
}

function entry(id) {
  const plan = { id, title: id, topicKey: id + '.topic', objective: id + ' 학습 목표', angle: '두 카드 예시', references: [] };
  return { plan, story: validateSpec({ version: 1, title: id, durationSeconds: 30,
    narration: [{ id: 'start', text: '첫 문장입니다.' }, { id: 'end', text: '마무리 문장입니다.' }],
    scenes: [{ id: 'intro', type: 'question', from: 'start', headline: '질문' },
      { id: 'ending', type: 'conclusion', from: 'end', headline: '정리' }] }) };
}

const requestKey = 'a'.repeat(64);

test('generated plans, snapshots, provenance and batch commit together and resume without duplicates', async t => {
  const root = await fixture(t);
  const entries = [entry('one'), entry('two')];
  const result = await commitGeneratedBatch(root, 'demo', 'generated', entries, { requestKey });
  assert.deepEqual(result, { batchId: 'generated', episodeIds: ['demo-one', 'demo-two'], reused: false });
  const catalog = readCatalog(root);
  assert.deepEqual(Object.keys(catalog.plans.demo), ['one', 'two']);
  assert.equal(catalog.generations.generated.referencesVerified, false);
  assert.equal(catalog.episodes['demo-one'].episode, catalog.plans.demo.one.input);
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, catalog.plans.demo.one.input)));
  assert.equal(snapshot.narration[0].text, '첫 문장입니다.');
  assert.equal(snapshot.profile.speech.voice, 'Microsoft Heami Desktop');
  const before = fs.readFileSync(path.join(root, 'planning/catalog.json'), 'utf8');
  assert.equal((await commitGeneratedBatch(root, 'demo', 'generated', entries, { requestKey })).reused, true);
  assert.equal(fs.readFileSync(path.join(root, 'planning/catalog.json'), 'utf8'), before);
  await assert.rejects(commitGeneratedBatch(root, 'demo', 'generated', entries, { requestKey: 'b'.repeat(64) }), /different request/);
});

test('adapter rejection in a later episode leaves no partial generated batch or inputs', async t => {
  const root = await fixture(t);
  const before = readCatalog(root);
  await assert.rejects(commitGeneratedBatch(root, 'demo', 'failed', [entry('one'), entry('adapter-failure')], { requestKey }), /adapter rejection/);
  assert.deepEqual(readCatalog(root), before);
  assert.deepEqual(fs.readdirSync(path.join(root, 'planning/inputs')), []);
});

test('commit rechecks newly-added history and fixed production defaults before exposing generated plans', async t => {
  const root = await fixture(t);
  const proposed = entry('next');
  await addPlans(root, 'demo', [{ ...entry('existing').plan, topicKey: 'ＮＥＸＴ.topic' }]);
  const before = readCatalog(root);
  await assert.rejects(commitGeneratedBatch(root, 'demo', 'race', [proposed], { requestKey }), /duplicates current history/);
  const modified = entry('different');
  modified.story.durationSeconds = 20;
  await assert.rejects(commitGeneratedBatch(root, 'demo', 'changed-duration', [modified], { requestKey }), /series production settings/);
  assert.deepEqual(readCatalog(root), before);
});

test('semantic publication rechecks current metadata and edited source content under the catalog lock', async t => {
  const root = await fixture(t);
  const old = entry('old');
  fs.writeFileSync(path.join(root, 'old.json'), JSON.stringify(old.story));
  await addPlans(root, 'demo', [{...old.plan,input:'old.json'}]);
  const expected = readSeriesHistory(root, readCatalog(root), 'demo').historyHash;
  await addPlans(root, 'demo', [entry('concurrent').plan]);
  const before = readCatalog(root);
  await assert.rejects(commitGeneratedBatch(root, 'demo', 'race', [entry('new')], {requestKey,expectedHistoryHash:expected}),
    error => error.code === 'SEMANTIC_HISTORY_CHANGED');
  assert.deepEqual(readCatalog(root), before);
  const fresh = readSeriesHistory(root, before, 'demo').historyHash;
  old.story.narration[0].text = '이력 입력이 검수 뒤 바뀌었습니다.';
  fs.writeFileSync(path.join(root, 'old.json'), JSON.stringify(old.story));
  await assert.rejects(commitGeneratedBatch(root, 'demo', 'race', [entry('new')], {requestKey,expectedHistoryHash:fresh}),
    error => error.code === 'SEMANTIC_HISTORY_CHANGED');
  assert.deepEqual(readCatalog(root), before);
});

test('passed semantic profiles preserve knowledge and traceable report provenance atomically', async t => {
  const root = await fixture(t);
  const proposed = entry('new');
  proposed.plan.knowledge = {core:'값을 제거하지 않고 맨 위 값을 읽는다.',example:'A 위 B를 확인해도 두 값이 남는다.'};
  const expectedHistoryHash = readSeriesHistory(root, readCatalog(root), 'demo').historyHash;
  const reportFile = path.join(root, 'semantic-report.json');
  fs.writeFileSync(reportFile, JSON.stringify({status:'passed'}));
  const noveltyReport = {status:'passed',duplicatePlanIds:[],reviewPlanIds:[],comparisons:[],
    profiles:[{planId:'new',knowledge:proposed.plan.knowledge}],reportPath:reportFile,inputHash:'c'.repeat(64)};
  await commitGeneratedBatch(root, 'demo', 'semantic', [proposed], {requestKey,expectedHistoryHash,noveltyReport});
  const catalog = readCatalog(root);
  assert.deepEqual(catalog.plans.demo.new.knowledge, proposed.plan.knowledge);
  assert.equal(catalog.generations.semantic.novelty.reportPath, 'semantic-report.json');
  assert.equal(catalog.generations.semantic.novelty.historyHash, expectedHistoryHash);
  assert.match(catalog.generations.semantic.novelty.reportHash, /^[a-f0-9]{64}$/);
  assert.equal(catalog.generations.semantic.referencesVerified, false);
});

test('invalid knowledge or a rejected/mismatched semantic report cannot publish a batch', async t => {
  const root = await fixture(t);
  const proposed = entry('new');
  const knowledge = {core:'핵심 지식',example:'두 카드'};
  proposed.plan.knowledge = knowledge;
  const expectedHistoryHash = readSeriesHistory(root, readCatalog(root), 'demo').historyHash;
  const report = {status:'passed',duplicatePlanIds:[],reviewPlanIds:[],comparisons:[],profiles:[{planId:'new',knowledge}]};
  const before = readCatalog(root);
  await assert.rejects(commitGeneratedBatch(root, 'demo', 'rejected', [proposed],
    {requestKey,expectedHistoryHash,noveltyReport:{...report,status:'needs_review'}}), /passed semantic report/);
  await assert.rejects(commitGeneratedBatch(root, 'demo', 'mismatch', [proposed],
    {requestKey,expectedHistoryHash,noveltyReport:{...report,profiles:[{planId:'wrong',knowledge}]}}), /profiles must match/);
  await assert.rejects(addPlans(root, 'demo', [{...entry('bad').plan,knowledge:{...knowledge,extra:'unsupported'}}]), /only core and example/);
  await assert.rejects(addPlans(root, 'demo', [{...entry('bad').plan,knowledge:{core:'x'.repeat(1001),example:'example'}}]), /1000/);
  await assert.rejects(addPlans(root, 'demo', [{...entry('bad').plan,knowledge:{core:'valid',example:'  '}}]), /must contain text/);
  assert.deepEqual(readCatalog(root), before);
});

test('an existing input edited during adapter preparation aborts publication and cleans new snapshots', async t => {
  const root = await fixture(t);
  const old = entry('old');
  fs.writeFileSync(path.join(root, 'old.json'), JSON.stringify(old.story));
  await addPlans(root, 'demo', [{...old.plan,input:'old.json'}]);
  const expectedHistoryHash = readSeriesHistory(root, readCatalog(root), 'demo').historyHash;
  const adapter = require(path.join(root, 'pipeline/story/adapter.cjs'));
  const original = adapter.createStages;
  adapter.createStages = context => {
    fs.writeFileSync(path.join(root, 'old.json'), JSON.stringify({...old.story,narration:[{id:'cue',text:'중간에 수정된 낭독'}]}));
    return original(context);
  };
  const before = readCatalog(root);
  await assert.rejects(commitGeneratedBatch(root, 'demo', 'race', [entry('next')], {requestKey,expectedHistoryHash}),
    error => error.code === 'SEMANTIC_HISTORY_CHANGED');
  assert.deepEqual(readCatalog(root), before);
  assert.deepEqual(fs.readdirSync(path.join(root, 'planning/inputs')), []);
});

async function reviewedContent(t) {
  const root = await fixture(t);
  fs.writeFileSync(path.join(root, 'source.md'), 'Controlled source for commit boundary testing.');
  await configureContentReview(root, 'demo', { mode: 'required', sources: [{ id: 'source', title: 'Test source', path: 'source.md', url: 'https://example.com/source' }] });
  const series = readCatalog(root).series.demo;
  const entries = [entry('reviewed')];
  const bundle = readEvidenceBundle(root, series);
  const check = createContentChecker({ provider: async () => ({
    units: collectUnits(entries).map(unit => ({ unitId: unit.unitId, verdict: 'supported', claim: 'Mock claim', reason: 'Mock verification for commit guard.',
      evidence: [{ sourceId: 'source', quote: 'Controlled source for commit boundary testing.' }] })),
    consistency: [{ planId: 'reviewed', verdict: 'consistent', reason: 'Mock consistency.' }],
  }) });
  const contentReport = await check({ series, entries, bundle, directory: path.join(root, 'content-audit') });
  return { root, entries, bundle, contentReport };
}

test('required content policy cannot publish without a matching passed report; verified source references persist', async t => {
  const { root, entries, bundle, contentReport } = await reviewedContent(t);
  const options = { requestKey, expectedSourceHash: bundle.sourceHash };
  await assert.rejects(commitGeneratedBatch(root, 'demo', 'checked', entries, options), /passed content report/);
  const altered = structuredClone(entries);
  altered[0].story.narration[0].text = 'Unreviewed new assertion.';
  await assert.rejects(commitGeneratedBatch(root, 'demo', 'checked', altered, { ...options, contentReport }), /does not match/);
  await commitGeneratedBatch(root, 'demo', 'checked', entries, { ...options, contentReport });
  const catalog = readCatalog(root);
  assert.deepEqual(catalog.plans.demo.reviewed.references, ['https://example.com/source']);
  assert.equal(catalog.generations.checked.referencesVerified, true);
  assert.equal(catalog.generations.checked.contentReview.sourceHash, bundle.sourceHash);
  assert.ok(catalog.generations.checked.contentReview.reportPath);
});

test('changed evidence aborts generated publication, including changes during adapter preparation', async t => {
  const { root, entries, bundle, contentReport } = await reviewedContent(t);
  const options = { requestKey, expectedSourceHash: bundle.sourceHash, contentReport };
  const before = readCatalog(root);
  fs.writeFileSync(path.join(root, 'source.md'), 'Edited evidence.');
  await assert.rejects(commitGeneratedBatch(root, 'demo', 'checked', entries, options), error => error.code === 'CONTENT_SOURCES_CHANGED');
  assert.deepEqual(readCatalog(root), before);
  fs.writeFileSync(path.join(root, 'source.md'), 'Controlled source for commit boundary testing.');
  const adapter = require(path.join(root, 'pipeline/story/adapter.cjs'));
  const original = adapter.createStages;
  adapter.createStages = context => {
    fs.writeFileSync(path.join(root, 'source.md'), 'Changed during preparation.');
    return original(context);
  };
  await assert.rejects(commitGeneratedBatch(root, 'demo', 'checked', entries, options), error => error.code === 'CONTENT_SOURCES_CHANGED');
  assert.deepEqual(readCatalog(root), before);
  assert.deepEqual(fs.readdirSync(path.join(root, 'planning/inputs')), []);
});

test('required content policy refuses unsupported adapters at registration and policy updates', async t => {
  const root = await fixture(t);
  fs.copyFileSync(path.join(root, 'pipeline/story/adapter.cjs'), path.join(root, 'pipeline/custom.cjs'));
  const spec = { id: 'custom', name: 'Custom', audience: '입문자', topics: ['CS'], defaultDurationSeconds: 30,
    tone: '간결하게', adapter: 'pipeline/custom.cjs' };
  const policy = { mode: 'required', sources: [] };
  await assert.rejects(registerSeries(root, { ...spec, contentReview: policy }), error =>
    error.code === 'SERIES_PREFLIGHT_FAILED' && error.report.errors.some(issue => issue.field === 'contentReview.mode'));
  await registerSeries(root, spec);
  const before = readCatalog(root);
  await assert.rejects(configureContentReview(root, 'custom', policy), /supports.*only/);
  assert.deepEqual(readCatalog(root), before);
});
