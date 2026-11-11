const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerSeries: registerActualSeries, readCatalog, commitGeneratedBatch } = require('../planning.cjs');
// Registration probes only the injected local voice inventory in these logic tests.
const registerSeries = (root, spec) => registerActualSeries(root, spec, {
  listVoices: async () => [{ name: 'Microsoft Heami Desktop', culture: 'ko-KR', enabled: true }],
});
const { generateBatch, inspectGeneration } = require('../generation/engine.cjs');
const { validateGenerated } = require('../generation/contract.cjs');
const { createPeriod, readPeriod } = require('./planning.cjs');
const { runPeriod } = require('./engine.cjs');

function proposal(suffix) {
  const scene = (id, type, from, headline) => ({ id, type, from, headline,
    body: null, cards: [], layout: 'row', carry: [], actions: [] });
  return { title: '자료 확인 ' + suffix, topicKey: 'stack.' + suffix,
    objective: '자료 확인 동작 ' + suffix, angle: '확인 전후에 남은 값을 비교한다.',
    story: { narration: [{ id: 'hook', text: '맨 위 값을 확인하면 자료가 사라질까요?' },
      { id: 'answer', text: '값을 읽기만 하므로 자료는 그대로 남아 있습니다.' }],
    scenes: [scene('question', 'question', 'hook', '확인하면 사라질까?'),
      scene('finish', 'conclusion', 'answer', '자료는 그대로')] } };
}

test('automatic period runs real generation commits sequentially, attaches schedules, and reuses them', async t => {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-period-generation-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-period-generation-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const adapterDirectory = path.join(root, 'pipeline/story');
  fs.mkdirSync(adapterDirectory, { recursive: true });
  fs.writeFileSync(path.join(root, 'pipeline/episodes.json'), '{}');
  fs.writeFileSync(path.join(root, 'pipeline/batches.json'), '{}');
  // Adapter validation remains real; media work is deliberately excluded here.
  fs.writeFileSync(path.join(adapterDirectory, 'adapter.cjs'), 'exports.createStages = () => [{id:"render",inputs:()=>({}),outputs:["video.mp4"],run:async()=>{throw Error("Unexpected media execution");}}];');
  const series = { id: 'cs', name: '기간 자동 생성 검증', audience: '입문자', topics: ['자료구조'],
    defaultDurationSeconds: 30, tone: '짧은 설명', adapter: 'pipeline/story/adapter.cjs' };
  await registerSeries(root, series);
  await createPeriod(root, { id: 'three-days', seriesId: 'cs', startDate: '2026-11-16', days: 3, batchSize: 2 });

  const catalogText = () => fs.readFileSync(path.join(root, 'planning/catalog.json'), 'utf8');
  const empty = catalogText();
  const wrongCount = validateGenerated({ episodes: [proposal('wrong-count')] }, {
    series, history: [], count: 1, batchId: 'three-days-b01',
  });
  await assert.rejects(commitGeneratedBatch(root, 'cs', 'three-days-b01', wrongCount,
    { requestKey: 'a'.repeat(64) }), /does not match its period reservation/);
  assert.equal(catalogText(), empty, 'A generated commit with the wrong reserved count must remain unpublished.');
  assert.equal(fs.existsSync(path.join(root, 'planning/inputs')), false);

  const calls = { generate: [], provider: [], novelty: [], preflight: [] };
  const inspect = async episodeId => {
    assert.ok(readCatalog(root).episodes[episodeId]);
    return { current: false, status: 'new', state: { status: 'new', stages: {} }, details: [], review: { status: 'unavailable' } };
  };
  const generate = async request => {
    calls.generate.push(request);
    return generateBatch(root, { ...request, maxAttempts: 1,
      provider: async ({ prompt, schema }) => {
        assert.equal(schema.additionalProperties, false);
        calls.provider.push({ batchId: request.batchId, prompt });
        return { episodes: Array.from({ length: request.count }, (_, i) => proposal(request.batchId + '-' + (i + 1))) };
      },
      noveltyCheck: async ({ entries, history }) => {
        calls.novelty.push({ batchId: request.batchId, history: structuredClone(history) });
        // This test checks orchestration, so semantic verdicts are deterministic stubs.
        return { status: 'passed', duplicatePlanIds: [], reviewPlanIds: [],
          profiles: entries.map(entry => ({ planId: entry.plan.id,
            knowledge: { core: entry.plan.objective, example: entry.plan.angle } })),
          comparisons: entries.flatMap(entry => history.map(previous => ({ candidateId: entry.plan.id,
            reference: { kind: 'history', id: previous.id }, verdict: 'distinct', reason: 'Fixture topic is distinct.' }))) };
      },
      preflight: async (entries, directory) => {
        assert.ok(fs.statSync(directory).isDirectory());
        assert.ok(entries.every(entry => entry.story.durationSeconds === 30));
        calls.preflight.push({ batchId: request.batchId, planIds: entries.map(entry => entry.plan.id) });
      },
    });
  };
  const options = { generate, inspect, planOnly: true, log() {} };
  const planned = await runPeriod(root, 'three-days', options);
  assert.equal(planned.status, 'planned');
  assert.equal(planned.counts.input_ready, 3);
  assert.deepEqual(calls.generate.map(call => [call.batchId, call.count]), [['three-days-b01', 2], ['three-days-b02', 1]]);
  assert.equal(calls.provider.length, 2);
  assert.equal(calls.preflight.length, 2);
  assert.deepEqual(calls.novelty[0].history, []);
  assert.deepEqual(calls.novelty[1].history.map(entry => entry.id), ['three-days-b01-01', 'three-days-b01-02']);
  assert.ok(calls.novelty[1].history.every(entry => entry.scheduledFor && entry.contentHash && entry.narration.length === 2));
  assert.match(calls.provider[1].prompt, /three-days-b01-01/);
  assert.match(calls.provider[1].prompt, /three-days-b01-02/);

  const period = readPeriod(root, 'three-days');
  const catalog = readCatalog(root);
  assert.equal(Object.keys(catalog.episodes).length, 3);
  assert.equal(Object.keys(catalog.generations).length, 2);
  for (const [index, slot] of period.slots.entries()) {
    assert.equal(slot.scheduledFor, `2026-11-${16 + index}T10:00:00.000Z`);
    assert.equal(catalog.plans.cs[slot.planId].scheduledFor, slot.scheduledFor);
    assert.equal(catalog.episodes[slot.episodeId].scheduledFor, slot.scheduledFor);
    assert.ok(catalog.batches[slot.batchId].includes(slot.episodeId));
  }
  for (const group of period.groups) assert.equal((await inspectGeneration(root, group.id)).status, 'committed');
  const beforeReplay = catalogText();
  const callCounts = Object.fromEntries(Object.entries(calls).map(([name, values]) => [name, values.length]));
  const replay = await runPeriod(root, 'three-days', { ...options, resume: true });
  assert.equal(replay.status, 'planned');
  assert.equal(catalogText(), beforeReplay);
  assert.deepEqual(Object.fromEntries(Object.entries(calls).map(([name, values]) => [name, values.length])), callCounts);
});
