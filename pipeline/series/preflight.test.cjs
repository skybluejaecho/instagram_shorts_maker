const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkSeries } = require('./preflight.cjs');

const korean = { name: 'Microsoft Heami Desktop', culture: 'ko-KR', enabled: true };
const voices = async () => [korean, { name: 'English Voice', culture: 'en-US', enabled: true }];
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-series-preflight-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    assert.ok(path.basename(root).startsWith('shorts-series-preflight-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'pipeline/story'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pipeline/story/adapter.cjs'), 'throw new Error("Preflight must not execute adapters");');
  fs.writeFileSync(path.join(root, 'custom.cjs'), 'throw new Error("Preflight must not execute custom adapters");');
  fs.mkdirSync(path.join(root, 'sources'));
  fs.writeFileSync(path.join(root, 'sources/reference.md'), '# Reference\nDeque append removes the item at the opposite end when full.');
  const spec = { id: 'my-cs', name: '나의 CS', audience: '입문자', topics: ['자료구조'], tone: '간단하게',
    defaultDurationSeconds: 30, adapter: 'pipeline/story/adapter.cjs',
    contentReview: { mode: 'required', sources: [{ id: 'reference', title: 'Reference', path: 'sources/reference.md', url: 'https://example.com/reference' }] } };
  const run = changed => checkSeries(root, changed === undefined ? spec : changed, { listVoices: voices });
  return { root, spec, run };
}

function snapshot(root) {
  const records = {};
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) visit(file);
      else records[path.relative(root, file)] = { bytes: fs.readFileSync(file).toString('base64'), mtimeMs: stat.mtimeMs };
    }
  }
  visit(root);
  return records;
}

test('a new common series exposes effective defaults without executing its adapter or writing a catalog', async t => {
  const { root, spec, run } = fixture(t);
  const before = snapshot(root), original = structuredClone(spec);
  const report = await run();
  assert.equal(report.status, 'passed');
  assert.equal(report.canRegister, true);
  assert.equal(report.existing, false);
  assert.equal(report.effective.renderProfile.speech.voice, korean.name);
  assert.equal(report.effective.renderProfile.speech.rate, 2);
  assert.deepEqual(report.effective.output, { width: 1080, height: 1920, fps: 30, durationSeconds: 30 });
  assert.equal(report.effective.visualReview.mode, 'required');
  assert.equal(report.evidence.status, 'ready');
  assert.match(report.evidence.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(report.evidence.sources[0].content, undefined);
  assert.equal(report.normalized.renderProfile, undefined, 'Effective defaults must not silently alter the saved series shape.');
  assert.deepEqual(spec, original);
  assert.deepEqual(snapshot(root), before);
  assert.equal(fs.existsSync(path.join(root, 'planning')), false);
  assert.equal(fs.existsSync(path.join(root, 'runs')), false);
});

test('constructor is a valid new series ID and only own catalog entries count as existing', async t => {
  const { root, spec, run } = fixture(t);
  const requested = { ...spec, id: 'constructor' };
  const fresh = await run(requested);
  assert.equal(fresh.canRegister, true);
  assert.equal(fresh.existing, false);

  fs.mkdirSync(path.join(root, 'planning'));
  fs.writeFileSync(path.join(root, 'planning/catalog.json'), JSON.stringify({ version: 1,
    series: { constructor: fresh.normalized }, plans: {}, episodes: {}, batches: {} }));
  const registered = await run(requested);
  assert.equal(registered.canRegister, true);
  assert.equal(registered.existing, true);
  const changed = await run({ ...requested, name: 'Changed name' });
  assert.equal(changed.canRegister, false);
  assert.ok(changed.errors.some(error => error.code === 'SERIES_CONFLICT'));
});

test('unsupported settings, missing voice and missing evidence are reported together with actionable fields', async t => {
  const { spec, run } = fixture(t);
  const bad = structuredClone(spec);
  Object.assign(bad, { width: 1920, language: 'en-US', defaultDurationSeconds: 3 });
  bad.renderProfile = { fontFamily: 'Unknown Font', bgm: 'music.mp3', colors: { text: 'red', typo: '#ffffff' },
    speech: { voice: 'Missing Voice', rate: 11, provider: 'azure' }, transitionSeconds: 10 };
  bad.contentReview.sources[0].path = 'sources/missing.md';
  const report = await run(bad);
  assert.equal(report.canRegister, false);
  for (const field of ['width', 'language', 'defaultDurationSeconds', 'renderProfile.bgm', 'renderProfile.fontFamily',
    'renderProfile.colors.text', 'renderProfile.colors.typo', 'renderProfile.speech.rate', 'renderProfile.speech.provider',
    'renderProfile.speech.voice', 'renderProfile.transitionSeconds', 'contentReview.sources[0].path']) {
    assert.ok(report.errors.some(error => error.field === field), field);
  }
  assert.ok(report.errors.some(error => error.code === 'VOICE_NOT_INSTALLED'));
  assert.ok(report.errors.some(error => error.code === 'EVIDENCE_UNAVAILABLE'));
});

test('disabled and non-Korean voices fail differently from voice discovery errors', async t => {
  const { root, spec } = fixture(t);
  for (const [installed, code] of [
    [[], 'VOICE_NOT_INSTALLED'], [[{ ...korean, enabled: false }], 'VOICE_DISABLED'],
    [[{ ...korean, culture: 'en-US' }], 'VOICE_LANGUAGE_UNSUPPORTED'], [[{ ...korean, enabled: 'yes' }], 'VOICE_DISCOVERY_FAILED'],
  ]) {
    const report = await checkSeries(root, spec, { listVoices: async () => installed });
    assert.ok(report.errors.some(error => error.code === code), code);
  }
  const report = await checkSeries(root, spec, { listVoices: async () => { throw Error('Local PowerShell unavailable'); } });
  assert.ok(report.errors.some(error => error.code === 'VOICE_DISCOVERY_FAILED' && error.message.includes('PowerShell')));
});

test('the requested voice is checked exactly and an explicit enabled Korean voice can be used', async t => {
  const { root, spec } = fixture(t);
  spec.renderProfile = { speech: { voice: 'Other Korean', rate: -2 } };
  const report = await checkSeries(root, spec, { listVoices: async () => [{ name: 'Other Korean', culture: 'ko-KR', enabled: true }] });
  assert.equal(report.status, 'passed');
  assert.equal(report.voice.requested, 'Other Korean');
  assert.equal(report.normalized.renderProfile.speech.rate, -2);
  const missing = await checkSeries(root, spec, { listVoices: async () => [{ name: 'Other Korean Extra', culture: 'ko-KR', enabled: true }] });
  assert.ok(missing.errors.some(error => error.code === 'VOICE_NOT_INSTALLED'));
});

test('missing, empty, oversized and invalid UTF-8 evidence blocks registration without leaking source content', async t => {
  const { root, spec, run } = fixture(t);
  const file = path.join(root, 'sources/reference.md');
  for (const bytes of [Buffer.alloc(0), Buffer.from([0xc3, 0x28]), Buffer.alloc(128 * 1024 + 1, 65)]) {
    fs.writeFileSync(file, bytes);
    const report = await run();
    assert.equal(report.status, 'failed');
    assert.ok(report.errors.some(error => error.field === 'contentReview.sources[0].path'));
    assert.equal(report.evidence.sources.length, 0);
  }
  fs.unlinkSync(file);
  assert.equal((await run()).canRegister, false);
  const empty = structuredClone(spec); empty.contentReview.sources = [];
  assert.ok((await run(empty)).errors.some(error => error.field === 'contentReview.sources'));
});

test('unsafe source and adapter paths are rejected locally', async t => {
  const { root, spec, run } = fixture(t);
  const source = structuredClone(spec); source.contentReview.sources[0].path = '../reference.md';
  assert.ok((await run(source)).errors.some(error => error.field === 'contentReview'));
  for (const adapter of ['../adapter.cjs', path.join(root, 'custom.cjs'), 'missing.cjs']) {
    const report = await run({ ...spec, adapter });
    assert.ok(report.errors.some(error => error.field === 'adapter'), adapter);
  }
});

test('equivalent common adapter paths still enforce profile and installed-voice checks', async t => {
  const { root, spec } = fixture(t);
  for (const adapter of ['./pipeline/story/adapter.cjs', 'pipeline/./story/adapter.cjs', 'pipeline/story/../story/adapter.cjs']) {
    const report = await checkSeries(root, { ...spec, adapter, renderProfile: { fontFamily: 'Unknown Font' } }, { listVoices: async () => [] });
    assert.equal(report.adapterScope, 'common-story', adapter);
    assert.ok(report.errors.some(error => error.code === 'VOICE_NOT_INSTALLED'), adapter);
    assert.ok(report.errors.some(error => error.field === 'renderProfile.fontFamily'), adapter);
  }
  if (process.platform === 'win32') {
    const report = await checkSeries(root, { ...spec, adapter: 'PIPELINE/story/adapter.cjs' }, { listVoices: voices });
    assert.ok(report.errors.some(error => error.code === 'ADAPTER_CASE_MISMATCH'));
    assert.equal(report.canRegister, false);
  }
});

test('adapter junctions outside the root are rejected without reading the target module', async t => {
  const { root, spec, run } = fixture(t);
  const parent = fs.realpathSync(os.tmpdir());
  const outside = fs.mkdtempSync(path.join(parent, 'shorts-preflight-outside-'));
  t.after(() => {
    assert.equal(path.dirname(outside), parent);
    assert.ok(path.basename(outside).startsWith('shorts-preflight-outside-'));
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outside, 'adapter.cjs'), 'throw Error("never execute")');
  fs.symlinkSync(outside, path.join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  const report = await run({ ...spec, adapter: 'external/adapter.cjs' });
  assert.ok(report.errors.some(error => error.field === 'adapter'));
});

test('content and visual review can be explicitly off but are visible warnings', async t => {
  const { spec, run } = fixture(t);
  const off = { ...spec, contentReview: { mode: 'off', sources: [] }, visualReview: { mode: 'off' } };
  const report = await run(off);
  assert.equal(report.status, 'warnings');
  assert.equal(report.canRegister, true);
  assert.ok(report.warnings.some(item => item.code === 'CONTENT_REVIEW_DISABLED'));
  assert.ok(report.warnings.some(item => item.code === 'VISUAL_REVIEW_DISABLED'));
  const { contentReview, visualReview, ...missing } = spec;
  const defaults = await run(missing);
  assert.equal(defaults.effective.contentReview.mode, 'off');
  assert.equal(defaults.effective.visualReview.mode, 'required');
  assert.ok(defaults.warnings.some(item => item.code === 'CONTENT_REVIEW_DISABLED'));
});

test('custom adapters preserve their own profile vocabulary and explicitly mark unverified scope', async t => {
  const { root, spec } = fixture(t);
  const { contentReview, ...custom } = spec;
  custom.adapter = 'custom.cjs'; custom.renderProfile = { customFeature: true };
  const report = await checkSeries(root, custom, { listVoices: async () => assert.fail('Custom adapters must not request common-story voice checks') });
  assert.equal(report.canRegister, true);
  assert.equal(report.adapterScope, 'custom');
  assert.ok(report.warnings.some(item => item.code === 'CUSTOM_ADAPTER_SCOPE'));
  assert.equal(report.checks.find(check => check.id === 'voice').status, 'skipped');
  assert.deepEqual(report.normalized.renderProfile, { customFeature: true });
  const required = await checkSeries(root, { ...custom, contentReview }, { listVoices: voices });
  assert.ok(required.errors.some(item => item.code === 'CONTENT_ADAPTER_UNSUPPORTED'));
});

test('catalog comparison is read-only, accepts identical registration and reports conflicting settings', async t => {
  const { root, spec, run } = fixture(t);
  const initial = await run();
  fs.mkdirSync(path.join(root, 'planning'));
  const catalog = { version: 1, series: { [spec.id]: initial.normalized }, plans: { [spec.id]: {} }, episodes: {}, batches: {} };
  fs.writeFileSync(path.join(root, 'planning/catalog.json'), JSON.stringify(catalog));
  const before = snapshot(root);
  const reused = await run();
  assert.equal(reused.canRegister, true); assert.equal(reused.existing, true);
  const conflict = await run({ ...spec, name: 'Changed Name' });
  assert.ok(conflict.errors.some(error => error.code === 'SERIES_CONFLICT'));
  assert.deepEqual(snapshot(root), before);
});

test('malformed basic, nested and visual settings produce failures without throwing', async t => {
  const { run, spec } = fixture(t);
  for (const value of [null, [], 'series', { ...spec, id: 'CON' }, { ...spec, topics: [] },
    { ...spec, defaultDurationSeconds: 30.01 }, { ...spec, renderProfile: { speech: [] } },
    { ...spec, renderProfile: { colors: [] } }, { ...spec, visualReview: { safeArea: { left: 1000, right: 1000 } } },
    { ...spec, visualReview: { typo: true } }]) {
    const report = await run(value);
    assert.equal(report.canRegister, false, JSON.stringify(value));
    assert.ok(report.errors.length);
  }
});
