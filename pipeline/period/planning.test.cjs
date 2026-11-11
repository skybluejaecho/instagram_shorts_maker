const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerSeries: registerActualSeries, addPlans, updatePlans, readCatalog, createBatchFromPlans, editCatalog, saveCatalog } = require('../planning.cjs');
// Registration probes only the injected local voice inventory in these logic tests.
const registerSeries = (root, spec) => registerActualSeries(root, spec, {
  listVoices: async () => [{ name: 'Microsoft Heami Desktop', culture: 'ko-KR', enabled: true }],
});
const { createPeriod, readPeriod, listPeriods, attachPeriodBatch, normalizeSpec, createSlots } = require('./planning.cjs');

async function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-period-plans-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    assert.ok(path.basename(root).startsWith('shorts-period-plans-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'pipeline/story'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pipeline/story/adapter.cjs'), `exports.createStages = () => [{id:'render',inputs:()=>({}),outputs:['video.mp4'],run:async()=>{}}];`);
  fs.writeFileSync(path.join(root, 'pipeline/batches.json'), '{}');
  const series = { id: 'cs', name: 'CS', audience: '초보', topics: ['자료구조'], defaultDurationSeconds: 30,
    tone: '간결하게', adapter: 'pipeline/story/adapter.cjs' };
  await registerSeries(root, series);
  const plans = Array.from({ length: 7 }, (_, index) => ({ id: `p${index + 1}`, title: `제목 ${index + 1}`,
    topicKey: `topic.${index + 1}`, objective: `지식 ${index + 1}`, angle: '예시', references: [], input: `p${index + 1}.json` }));
  for (const plan of plans) fs.writeFileSync(path.join(root, plan.input), JSON.stringify({ title: plan.title, durationSeconds: 30 }));
  await addPlans(root, 'cs', plans);
  const spec = { id: 'week', seriesId: 'cs', startDate: '2026-11-09', days: 5, planIds: plans.slice(0, 5).map(plan => plan.id) };
  return { root, spec, plans, series, bytes: () => fs.readFileSync(path.join(root, 'planning/catalog.json'), 'utf8') };
}

test('five local days produce five stable reservations, groups, and idempotent storage', async t => {
  const f = await fixture(t);
  const { period, reused } = await createPeriod(f.root, { ...f.spec, batchSize: 2 });
  assert.equal(reused, false);
  assert.equal(period.timezone, 'Asia/Seoul');
  assert.deepEqual(period.slots.map(slot => slot.date), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
  assert.equal(period.slots[0].scheduledFor, '2026-11-09T10:00:00.000Z');
  assert.deepEqual(period.groups.map(group => [group.id, group.slotIds.length]), [['week-b01', 2], ['week-b02', 2], ['week-b03', 1]]);
  assert.equal(new Set(period.slots.map(slot => slot.scheduledFor)).size, 5);
  const bytes = f.bytes();
  const again = await createPeriod(f.root, { ...f.spec, batchSize: 2, times: ['19:00'], weekdays: [7, 6, 5, 4, 3, 2, 1] });
  assert.equal(again.reused, true);
  assert.equal(f.bytes(), bytes);
  assert.deepEqual(readPeriod(f.root, 'week'), period);
  assert.deepEqual(listPeriods(f.root), [period]);
  await assert.rejects(createPeriod(f.root, { ...f.spec, batchSize: 3 }), /different settings/);
  assert.equal(f.bytes(), bytes);
});

test('weekday cadence and multiple times sort by local date without shifting calendar days', () => {
  const spec = normalizeSpec({ id: 'months', seriesId: 'cs', startDate: '2028-02-28', days: 5,
    timezone: 'Asia/Seoul', times: ['23:00', '00:15'], weekdays: [5, 1, 3] });
  const { slots } = createSlots(spec);
  assert.deepEqual(slots.map(slot => `${slot.date} ${slot.localTime}`), [
    '2028-02-28 00:15', '2028-02-28 23:00', '2028-03-01 00:15', '2028-03-01 23:00', '2028-03-03 00:15', '2028-03-03 23:00']);
  assert.equal(slots[0].scheduledFor, '2028-02-27T15:15:00.000Z');
});

test('daily local times retain their hour across DST and reject ambiguous or absent local times', () => {
  const make = (startDate, days = 1, time = '19:00', timezone = 'America/New_York') => createSlots(normalizeSpec({ id: 'dst', seriesId: 'cs', startDate, days, times: [time], timezone }));
  const spring = make('2026-03-07', 3);
  assert.equal(Date.parse(spring.slots[1].scheduledFor) - Date.parse(spring.slots[0].scheduledFor), 23 * 3600000);
  const fall = make('2026-10-31', 3);
  assert.equal(Date.parse(fall.slots[1].scheduledFor) - Date.parse(fall.slots[0].scheduledFor), 25 * 3600000);
  assert.throws(() => make('2026-03-08', 1, '02:30'), /Nonexistent/);
  assert.throws(() => make('2026-11-01', 1, '01:30'), /Ambiguous/);
  assert.throws(() => make('2011-12-30', 1, '19:00', 'Pacific/Apia'), /Nonexistent/);
});

test('strict calendar configuration rejects malformed input and excessive or empty calendars', () => {
  const valid = { id: 'valid', seriesId: 'cs', startDate: '2026-11-09', days: 5 };
  for (const extra of [{ id: '../bad' }, { id: 'con' }, { id: 'a'.repeat(41) }, { timezone: 'Mars/City' },
    { days: 0 }, { days: 367 }, { days: 1.5 }, { startDate: '2026-02-29' }, { startDate: '2026-13-01' },
    { times: ['24:00'] }, { times: ['9:00'] }, { times: [] }, { times: ['19:00', '19:00'] },
    { weekdays: [0] }, { weekdays: [1, 1] }, { batchSize: 11 }, { planIds: ['p', 'p'] }, { surprise: true }]) {
    assert.throws(() => normalizeSpec({ ...valid, ...extra }), JSON.stringify(extra));
  }
  assert.throws(() => createSlots(normalizeSpec({ ...valid, days: 1, weekdays: [7] })), /no posting slots/);
  assert.throws(() => createSlots(normalizeSpec({ ...valid, days: 366, times: ['09:00', '19:00'] })), /366 posting/);
  assert.throws(() => createSlots(normalizeSpec({ ...valid, planIds: ['p'] })), /exactly 5/);
});

test('reservation rejects overlapping slots or reused plans, while other series remain independent', async t => {
  const f = await fixture(t);
  await createPeriod(f.root, f.spec);
  const before = f.bytes();
  await assert.rejects(createPeriod(f.root, { id: 'overlap', seriesId: 'cs', startDate: '2026-11-13', days: 2 }), /already reserved/);
  await assert.rejects(createPeriod(f.root, { ...f.spec, id: 'reuse', startDate: '2026-12-01' }), /Plan already reserved/);
  assert.equal(f.bytes(), before);
  await registerSeries(f.root, { ...f.series, id: 'other' });
  assert.equal((await createPeriod(f.root, { id: 'other-week', seriesId: 'other', startDate: f.spec.startDate, days: 5 })).period.slots.length, 5);
});

test('existing plan schedules compare instants rather than timezone string spelling', async t => {
  const f = await fixture(t);
  await updatePlans(f.root, 'cs', [{ ...f.plans[0], scheduledFor: '2026-11-09T19:00:00+09:00' }]);
  const before = f.bytes();
  await assert.rejects(createPeriod(f.root, { id: 'automatic', seriesId: 'cs', startDate: '2026-11-09', days: 1 }), /already belongs/);
  await assert.rejects(createPeriod(f.root, { ...f.spec, startDate: '2026-11-10' }), /different posting time/);
  assert.equal(f.bytes(), before);
  await createPeriod(f.root, f.spec);
});

test('reserved schedules and plans cannot be taken by generic planning commands', async t => {
  const f = await fixture(t);
  await createPeriod(f.root, f.spec);
  const before = f.bytes();
  await assert.rejects(updatePlans(f.root, 'cs', [{ ...f.plans[0], scheduledFor: '2026-11-10T19:00:00+09:00' }]), /reserved period/);
  await assert.rejects(updatePlans(f.root, 'cs', [{ ...f.plans[0], publishedAt: '2026-11-01T10:00:00Z' }]), /reserved period/);
  await assert.rejects(updatePlans(f.root, 'cs', [{ ...f.plans[5], scheduledFor: '2026-11-09T10:00:00Z' }]), /reserved period/);
  await assert.rejects(createBatchFromPlans(f.root, 'cs', 'steal', { planIds: ['p1'] }), /another period batch/);
  assert.equal(f.bytes(), before);
  const free = await createBatchFromPlans(f.root, 'cs', 'available', { count: 2 });
  assert.deepEqual(free.episodeIds, ['cs-p6', 'cs-p7']);
  await updatePlans(f.root, 'cs', [{ ...f.plans[0], title: '개선한 제목' }]);
  assert.equal(readCatalog(f.root).plans.cs.p1.title, '개선한 제목');
});

test('period batch attachment recovers a materialization gap and preserves video input bytes', async t => {
  const f = await fixture(t);
  await createPeriod(f.root, f.spec);
  await createBatchFromPlans(f.root, 'cs', 'week-b01', { planIds: f.spec.planIds });
  assert.equal(readPeriod(f.root, 'week').slots[0].episodeId, undefined);
  const input = path.join(f.root, readCatalog(f.root).episodes['cs-p1'].episode);
  const bytes = fs.readFileSync(input);
  const period = await attachPeriodBatch(f.root, 'week', 'week-b01');
  assert.deepEqual(period.slots.map(slot => slot.episodeId), ['cs-p1', 'cs-p2', 'cs-p3', 'cs-p4', 'cs-p5']);
  const catalog = readCatalog(f.root);
  for (const slot of period.slots) {
    assert.equal(catalog.plans.cs[slot.planId].scheduledFor, slot.scheduledFor);
    assert.equal(catalog.episodes[slot.episodeId].scheduledFor, slot.scheduledFor);
  }
  assert.deepEqual(fs.readFileSync(input), bytes);
  const complete = f.bytes();
  await attachPeriodBatch(f.root, 'week', 'week-b01');
  assert.equal(f.bytes(), complete);
  assert.equal((await createPeriod(f.root, f.spec)).reused, true);
});

test('automatic groups bind generated episode order atomically and leave other groups pending', async t => {
  const f = await fixture(t);
  const { period } = await createPeriod(f.root, { id: 'auto', seriesId: 'cs', startDate: '2026-12-01', days: 3, batchSize: 2 });
  await editCatalog(f.root, catalog => {
    for (const id of ['p6', 'p7']) catalog.episodes['cs-' + id] = { seriesId: 'cs', planId: id, episode: id + '.json' };
    catalog.batches['auto-b01'] = ['cs-p6', 'cs-p7'];
    saveCatalog(f.root, catalog);
  });
  const attached = await attachPeriodBatch(f.root, period.id, 'auto-b01');
  assert.deepEqual(attached.slots.map(slot => slot.planId), ['p6', 'p7', undefined]);
  assert.equal(readPeriod(f.root, 'auto').slots[1].episodeId, 'cs-p7');
});

test('invalid batch attachment does not write a partial schedule', async t => {
  const f = await fixture(t);
  await createPeriod(f.root, f.spec);
  await createBatchFromPlans(f.root, 'cs', 'week-b01', { planIds: f.spec.planIds });
  await editCatalog(f.root, catalog => {
    catalog.episodes['cs-p5'].seriesId = 'wrong';
    saveCatalog(f.root, catalog);
  });
  const before = f.bytes();
  await assert.rejects(attachPeriodBatch(f.root, 'week', 'week-b01'), /does not match/);
  assert.equal(f.bytes(), before);
  assert.equal(readPeriod(f.root, 'week').slots[0].episodeId, undefined);
});

test('initial plan reservations require input-ready unproduced plans and free batch IDs', async t => {
  const f = await fixture(t);
  await createBatchFromPlans(f.root, 'cs', 'existing', { planIds: ['p1'] });
  await assert.rejects(createPeriod(f.root, f.spec), /unproduced/);
  fs.writeFileSync(path.join(f.root, 'pipeline/batches.json'), JSON.stringify({ 'future-b01': ['legacy'] }));
  await assert.rejects(createPeriod(f.root, { id: 'future', seriesId: 'cs', startDate: '2026-12-01', days: 1 }), /already in use/);
  fs.mkdirSync(path.join(f.root, 'runs/_generation/incomplete-b01'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'runs/_generation/incomplete-b01/state.json'), '{}');
  await assert.rejects(createPeriod(f.root, { id: 'incomplete', seriesId: 'cs', startDate: '2026-12-01', days: 1 }), /already in use/);
  assert.equal(listPeriods(f.root).length, 0);
});

test('immutable stored slots reject manual schedule edits', async t => {
  const f = await fixture(t);
  await createPeriod(f.root, f.spec);
  await editCatalog(f.root, catalog => {
    catalog.periods.week.slots[0].scheduledFor = '2026-12-01T10:00:00.000Z';
    saveCatalog(f.root, catalog);
  });
  assert.throws(() => readPeriod(f.root, 'week'), /Immutable/);
});
