const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCatalog, registerSeries, addPlans, updatePlans, checkDuplicates, createBatchFromPlans } = require('./planning.cjs');

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-planning-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-planning-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'pipeline'));
  fs.writeFileSync(path.join(root, 'pipeline/episodes.json'), '{}');
  fs.writeFileSync(path.join(root, 'pipeline/batches.json'), '{}');
  fs.writeFileSync(path.join(root, 'adapter.cjs'), `
    const fs = require('node:fs');
    exports.createStages = ({episodeFile}) => {
      const input = JSON.parse(fs.readFileSync(episodeFile, 'utf8'));
      if (input.invalid) throw Error('Unsupported fixture input');
      return ['speech','prepare','render','verify'].map(id => ({
        id, inputs: () => input, outputs: [id + '.txt'], run: async () => {}
      }));
    };
  `);
  const series = { id: 'cs', name: 'CS', audience: '입문자', topics: ['자료 구조'],
    defaultDurationSeconds: 30, tone: '간단한 설명', adapter: 'adapter.cjs' };
  const input = (name, value = { durationSeconds: 30, text: name, title: name }) => {
    const file = name + '.json';
    fs.writeFileSync(path.join(root, file), JSON.stringify(value));
    return file;
  };
  const plan = (id, fields = {}) => ({ id, title: id, topicKey: id, objective: id + ' 핵심 지식',
    angle: '간단한 예시', references: ['https://example.com/' + id], ...fields });
  const catalogText = () => fs.readFileSync(path.join(root, 'planning/catalog.json'), 'utf8');
  return { root, series, input, plan, catalogText };
}

test('series and draft plans persist in order, with idempotent registration and valid schedule metadata', async t => {
  const job = fixture(t);
  assert.deepEqual(readCatalog(job.root).series, {});
  assert.equal(fs.existsSync(path.join(job.root, 'planning')), false);
  await registerSeries(job.root, job.series);
  const before = job.catalogText();
  await registerSeries(job.root, job.series);
  assert.equal(job.catalogText(), before);
  const plans = [job.plan('first', { scheduledFor: '2026-11-20T09:00:00+09:00' }), job.plan('second')];
  await addPlans(job.root, 'cs', plans);
  const catalog = readCatalog(job.root);
  assert.deepEqual(Object.keys(catalog.plans.cs), ['first', 'second']);
  assert.equal(catalog.plans.cs.first.seriesId, 'cs');
  assert.equal(catalog.plans.cs.first.scheduledFor, plans[0].scheduledFor);
  await assert.rejects(registerSeries(job.root, { ...job.series, name: 'Changed' }));
  await assert.rejects(addPlans(job.root, 'cs', [job.plan('first', { objective: 'Changed' })]));
  assert.deepEqual(checkDuplicates(job.root, 'cs'), []);
});

test('duplicate topic keys include planned and published history and remain scoped to the series', async t => {
  const job = fixture(t);
  await registerSeries(job.root, job.series);
  await registerSeries(job.root, { ...job.series, id: 'math' });
  await addPlans(job.root, 'cs', [
    job.plan('old', { topicKey: 'ＢＩＮＡＲＹ   Search', publishedAt: '2026-11-01T00:00:00Z' }),
    job.plan('new', { topicKey: '  binary search  ', input: job.input('new') }),
  ]);
  await addPlans(job.root, 'math', [job.plan('other', { topicKey: 'binary search' })]);
  assert.deepEqual(checkDuplicates(job.root, 'cs'), [{ topicKey: 'binary search', planIds: ['old', 'new'] }]);
  assert.deepEqual(checkDuplicates(job.root, 'math'), []);
  const before = job.catalogText();
  await assert.rejects(createBatchFromPlans(job.root, 'cs', 'blocked', { planIds: ['new'] }));
  assert.equal(job.catalogText(), before);
});

test('two series can register and materialize their own ep01 without affecting each other', async t => {
  const job = fixture(t);
  await registerSeries(job.root, job.series);
  await registerSeries(job.root, { ...job.series, id: 'math' });
  await addPlans(job.root, 'cs', [job.plan('ep01', { topicKey: 'shared-key', input: job.input('cs-input') })]);
  await addPlans(job.root, 'math', [job.plan('ep01', { topicKey: 'shared-key', input: job.input('math-input') })]);
  const cs = await createBatchFromPlans(job.root, 'cs', 'cs-first', { planIds: ['ep01'] });
  const math = await createBatchFromPlans(job.root, 'math', 'math-first', { count: 1 });
  assert.deepEqual(cs.episodeIds, ['cs-ep01']);
  assert.deepEqual(math.episodeIds, ['math-ep01']);
  const catalog = readCatalog(job.root);
  assert.equal(catalog.plans.cs.ep01.input, 'cs-input.json');
  assert.equal(catalog.plans.math.ep01.input, 'math-input.json');
  assert.deepEqual(checkDuplicates(job.root, 'cs'), []);
  assert.deepEqual(checkDuplicates(job.root, 'math'), []);
  await addPlans(job.root, 'cs', [job.plan('ep02', { topicKey: 'shared-key' })]);
  assert.deepEqual(checkDuplicates(job.root, 'cs'), [{ topicKey: 'shared-key', planIds: ['ep01', 'ep02'] }]);
  assert.deepEqual(checkDuplicates(job.root, 'math'), []);
});

test('a draft can gain production input through an atomic update before materialization', async t => {
  const job = fixture(t);
  await registerSeries(job.root, job.series);
  await addPlans(job.root, 'cs', [job.plan('draft'),
    job.plan('published', { publishedAt: '2026-11-01T00:00:00Z' })]);
  const ready = job.plan('draft', { input: job.input('draft') });
  const before = job.catalogText();
  await assert.rejects(updatePlans(job.root, 'cs', [ready, job.plan('missing')]));
  assert.equal(job.catalogText(), before);
  await updatePlans(job.root, 'cs', [ready]);
  assert.equal(readCatalog(job.root).plans.cs.draft.input, 'draft.json');
  const batch = await createBatchFromPlans(job.root, 'cs', 'draft-ready', { planIds: ['draft'] });
  assert.deepEqual(batch.episodeIds, ['cs-draft']);
  const materialized = job.catalogText();
  await assert.rejects(updatePlans(job.root, 'cs', [{ ...ready, title: 'Changed after production' }]));
  await assert.rejects(updatePlans(job.root, 'cs', [job.plan('published', { title: 'Changed published record' })]));
  assert.equal(job.catalogText(), materialized);
});

test('materializing a subset snapshots its inputs, supports retry, and leaves remaining plans for later batches', async t => {
  const job = fixture(t);
  await registerSeries(job.root, job.series);
  await addPlans(job.root, 'cs', [job.plan('draft'),
    job.plan('first', { input: job.input('first') }),
    job.plan('second', { input: job.input('second'), scheduledFor: '2026-12-01T12:00:00Z' }),
    job.plan('third', { input: job.input('third') }),
  ]);
  const firstBatch = await createBatchFromPlans(job.root, 'cs', 'two-days', { planIds: ['second', 'first'] });
  assert.deepEqual(firstBatch.episodeIds, ['cs-second', 'cs-first']);
  const before = readCatalog(job.root);
  assert.deepEqual(before.batches['two-days'], firstBatch.episodeIds);
  const file = path.join(job.root, before.episodes['cs-first'].episode);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    durationSeconds: 30, text: 'first', title: 'first', audience: job.series.audience, tone: job.series.tone,
  });
  job.input('first', { durationSeconds: 30, text: 'changed source' });
  const retry = await createBatchFromPlans(job.root, 'cs', 'two-days', { planIds: ['second', 'first'] });
  assert.equal(retry.reused, true);
  assert.deepEqual(readCatalog(job.root), before);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).text, 'first');
  const nextBatch = await createBatchFromPlans(job.root, 'cs', 'next-day', { count: 1 });
  assert.deepEqual(nextBatch.episodeIds, ['cs-third']);
  const repeatedCount = await createBatchFromPlans(job.root, 'cs', 'next-day', { count: 1 });
  assert.equal(repeatedCount.reused, true);
  assert.deepEqual(repeatedCount.episodeIds, ['cs-third']);
  await assert.rejects(createBatchFromPlans(job.root, 'cs', 'two-days', { planIds: ['first'] }));
  await assert.rejects(createBatchFromPlans(job.root, 'cs', 'draft-day', { planIds: ['draft'] }));
  await assert.rejects(createBatchFromPlans(job.root, 'cs', 'too-many', { count: 1 }));
});

test('duplicate keys also block a candidate matching an already materialized episode', async t => {
  const job = fixture(t);
  await registerSeries(job.root, job.series);
  await addPlans(job.root, 'cs', [job.plan('done', { input: job.input('done'), topicKey: 'stack' })]);
  await createBatchFromPlans(job.root, 'cs', 'first-batch', { count: 1 });
  await addPlans(job.root, 'cs', [job.plan('candidate', { input: job.input('candidate'), topicKey: ' STACK ' })]);
  assert.equal(checkDuplicates(job.root, 'cs').length, 1);
  await assert.rejects(createBatchFromPlans(job.root, 'cs', 'duplicate-batch', { planIds: ['candidate'] }));
  assert.deepEqual(Object.keys(readCatalog(job.root).episodes), ['cs-done']);
});

test('invalid selections, legacy collisions, and unsupported inputs never publish a partial batch', async t => {
  const job = fixture(t);
  await registerSeries(job.root, job.series);
  await addPlans(job.root, 'cs', [
    job.plan('valid', { input: job.input('valid') }),
    job.plan('invalid', { input: job.input('invalid', { invalid: true }) }),
    job.plan('published', { input: job.input('published'), publishedAt: '2026-11-02T00:00:00Z' }),
  ]);
  const before = job.catalogText();
  for (const options of [{ count: 0 }, { count: 99 }, {}, { count: 1, planIds: ['valid'] },
    { planIds: ['valid', 'valid'] }, { planIds: ['missing'] }, { planIds: ['published'] },
    { planIds: ['valid', 'invalid'] }]) {
    await assert.rejects(createBatchFromPlans(job.root, 'cs', 'rejected', options));
    assert.equal(job.catalogText(), before);
  }
  fs.writeFileSync(path.join(job.root, 'pipeline/batches.json'), JSON.stringify({ taken: [] }));
  await assert.rejects(createBatchFromPlans(job.root, 'cs', 'taken', { planIds: ['valid'] }));
  fs.writeFileSync(path.join(job.root, 'pipeline/episodes.json'), JSON.stringify({ 'cs-valid': { adapter: 'adapter.cjs', episode: 'valid.json' } }));
  await assert.rejects(createBatchFromPlans(job.root, 'cs', 'collision', { planIds: ['valid'] }));
  assert.equal(job.catalogText(), before);
  assert.deepEqual(readCatalog(job.root).episodes, {});
});

test('unsafe IDs, invalid dates, and conflicting concurrent updates are rejected without losing registered data', async t => {
  const job = fixture(t);
  await assert.rejects(registerSeries(job.root, { ...job.series, id: '../outside' }));
  await registerSeries(job.root, job.series);
  for (const scheduledFor of ['not-a-date', '2026-11-20T09:00:00', '2026-02-30T12:00:00Z']) {
    await assert.rejects(addPlans(job.root, 'cs', [job.plan('bad-date', { scheduledFor })]));
  }
  await assert.rejects(addPlans(job.root, 'cs', [job.plan('../outside')]));
  const first = job.plan('first');
  const second = job.plan('second');
  const results = await Promise.allSettled([addPlans(job.root, 'cs', [first]), addPlans(job.root, 'cs', [second])]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  // A competing writer may be refused by the exclusive lock. Retrying must merge with the persisted catalog.
  await addPlans(job.root, 'cs', [first]);
  await addPlans(job.root, 'cs', [second]);
  assert.deepEqual(Object.keys(readCatalog(job.root).plans.cs).sort(), ['first', 'second']);
});
