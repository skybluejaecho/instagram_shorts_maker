const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerSeries: registerActualSeries, configureVisualReview, readCatalog } = require('./planning.cjs');
// Registration probes only the injected local voice inventory in these logic tests.
const registerSeries = (root, spec) => registerActualSeries(root, spec, {
  listVoices: async () => [{ name: 'Microsoft Heami Desktop', culture: 'ko-KR', enabled: true }],
});

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-visual-policy-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), parent); assert.ok(path.basename(root).startsWith('shorts-visual-policy-')); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'pipeline/story'), { recursive: true });
  const adapter = 'exports.createStages = () => [{id:"render",inputs:()=>({}),outputs:[],run:async()=>{}}];';
  fs.writeFileSync(path.join(root, 'pipeline/story/adapter.cjs'), adapter);
  fs.writeFileSync(path.join(root, 'custom.cjs'), adapter);
  const spec = { id: 'demo', name: 'CS', audience: '입문자', topics: ['스택'], defaultDurationSeconds: 30, tone: '간단하게', adapter: 'pipeline/story/adapter.cjs' };
  return { root, spec };
}

test('series visual settings preserve defaults and only update the selected policy', async t => {
  const { root, spec } = fixture(t);
  await registerSeries(root, { ...spec, visualReview: { safeArea: { top: 140 }, charsPerSecond: 10 } });
  const before = readCatalog(root);
  assert.equal(before.series.demo.visualReview.safeArea.top, 140);
  assert.equal(before.series.demo.visualReview.safeArea.left, 96);
  await configureVisualReview(root, 'demo', { charsPerSecond: 14, minFontPx: { body: 40 } });
  const after = readCatalog(root);
  assert.equal(after.series.demo.visualReview.charsPerSecond, 14);
  assert.equal(after.series.demo.visualReview.minFontPx.body, 40);
  delete before.series.demo.visualReview;
  delete after.series.demo.visualReview;
  assert.deepEqual(after, before);
});

test('invalid or unsupported visual policies cannot alter the catalog', async t => {
  const { root, spec } = fixture(t);
  await registerSeries(root, spec);
  await registerSeries(root, { ...spec, id: 'custom', adapter: 'custom.cjs' });
  const before = readCatalog(root);
  await assert.rejects(configureVisualReview(root, 'demo', { safeArea: { left: 1000, right: 1000 } }));
  await assert.rejects(configureVisualReview(root, 'demo', { characterPerSecond: 10 }));
  await assert.rejects(configureVisualReview(root, 'custom', { mode: 'required' }), /supports.*only/);
  await assert.rejects(registerSeries(root, { ...spec, id: 'new', adapter: 'custom.cjs', visualReview: {} }), error =>
    error.code === 'SERIES_PREFLIGHT_FAILED' && error.report.errors.some(issue => issue.field === 'visualReview.mode'));
  assert.deepEqual(readCatalog(root), before);
  await configureVisualReview(root, 'demo', { mode: 'off' });
  assert.equal(readCatalog(root).series.demo.visualReview.mode, 'off');
});
