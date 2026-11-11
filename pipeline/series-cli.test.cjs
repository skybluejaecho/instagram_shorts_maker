const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { registerSeries, readCatalog } = require('./planning.cjs');

const voices = async () => [{ name: 'Microsoft Heami Desktop', culture: 'ko-KR', enabled: true }];
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-series-cli-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    assert.ok(path.basename(root).startsWith('shorts-series-cli-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pipeline = path.join(root, 'pipeline');
  fs.mkdirSync(pipeline);
  for (const name of fs.readdirSync(__dirname)) {
    if (name.endsWith('.cjs') && !name.endsWith('.test.cjs')) fs.copyFileSync(path.join(__dirname, name), path.join(pipeline, name));
  }
  for (const directory of ['series', 'story', 'content', 'visual']) {
    fs.mkdirSync(path.join(pipeline, directory));
    for (const name of fs.readdirSync(path.join(__dirname, directory))) {
      if (name.endsWith('.cjs') && !name.endsWith('.test.cjs')) fs.copyFileSync(path.join(__dirname, directory, name), path.join(pipeline, directory, name));
    }
  }
  // Only the local environment boundary is replaced. CLI, preflight and
  // registration are the actual modules. No process can synthesize or render.
  fs.writeFileSync(path.join(pipeline, 'series/voices.cjs'), 'exports.listInstalledVoices = async () => ' + JSON.stringify([{ name: 'Microsoft Heami Desktop', culture: 'ko-KR', enabled: true }]) + ';');
  fs.writeFileSync(path.join(pipeline, 'story/adapter.cjs'), 'exports.createStages = () => { throw Error("Production must never run during registration"); };');
  fs.mkdirSync(path.join(pipeline, 'generation'));
  fs.writeFileSync(path.join(pipeline, 'generation/provider.cjs'), 'throw Error("Models must never load during preflight");');
  const write = (name, value) => fs.writeFileSync(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  write('pipeline/episodes.json', {}); write('pipeline/batches.json', {});
  write('source.md', 'A local reference note.');
  const spec = { id: 'local', name: '로컬 시리즈', audience: '입문자', topics: ['자료구조'], tone: '간결하게',
    defaultDurationSeconds: 30, adapter: 'pipeline/story/adapter.cjs',
    contentReview: { mode: 'required', sources: [{ id: 'note', title: '로컬 참고 자료', path: 'source.md' }] } };
  write('series.json', spec);
  const command = (args, expectedCode = 0) => {
    const result = spawnSync(process.execPath, [path.join(pipeline, 'cli.cjs'), ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, expectedCode, result.stdout + result.stderr);
    return result.stdout;
  };
  return { root, pipeline, spec, write, command, catalogFile: path.join(root, 'planning/catalog.json') };
}

test('CLI check is read-only, exposes defaults and evidence without source text, then registration is idempotent', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.root, 'series.json'));
  const report = JSON.parse(f.command(['series', 'check', 'series.json', '--json']));
  assert.equal(report.canRegister, true);
  assert.equal(report.effective.renderProfile.speech.voice, 'Microsoft Heami Desktop');
  assert.deepEqual(report.effective.output, { width: 1080, height: 1920, fps: 30, durationSeconds: 30 });
  assert.equal(report.evidence.status, 'ready');
  assert.equal(Object.hasOwn(report.evidence.sources[0], 'content'), false);
  assert.equal(fs.existsSync(path.join(f.root, 'planning')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'runs')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'series.json')), before);
  assert.match(f.command(['series', 'register', 'series.json']), /Registered series: local/);
  const catalog = fs.readFileSync(f.catalogFile), mtime = fs.statSync(f.catalogFile).mtimeMs;
  assert.equal(readCatalog(f.root).series.local.renderProfile, undefined, 'Displayed defaults must not change the stored schema or media fingerprints.');
  f.command(['series', 'register', 'series.json']);
  assert.deepEqual(fs.readFileSync(f.catalogFile), catalog);
  assert.equal(fs.statSync(f.catalogFile).mtimeMs, mtime);
  assert.equal(fs.existsSync(path.join(f.root, 'runs')), false);
});

test('unsupported settings, unavailable voice and missing evidence all block registration without loading the adapter', t => {
  const f = fixture(t);
  f.spec.aspectRatio = '16:9';
  f.spec.renderProfile = { speech: { voice: 'Missing Korean Voice' } };
  f.spec.contentReview.sources[0].path = 'missing.md';
  f.write('series.json', f.spec);
  fs.writeFileSync(path.join(f.pipeline, 'story/adapter.cjs'), 'throw Error("Adapter must not load for an invalid series");');
  const report = JSON.parse(f.command(['series', 'check', 'series.json', '--json'], 1));
  assert.equal(report.canRegister, false);
  for (const field of ['aspectRatio', 'renderProfile.speech.voice', 'contentReview.sources[0].path']) assert.ok(report.errors.some(error => error.field === field), field);
  const output = f.command(['series', 'register', 'series.json'], 1);
  assert.match(output, /등록 불가/);
  assert.doesNotMatch(output, /Registered series|Adapter must not load/);
  assert.equal(fs.existsSync(f.catalogFile), false);
  assert.equal(fs.existsSync(path.join(f.root, 'runs')), false);
});

test('malformed JSON is a structured failed check and conflicting registration preserves existing catalog bytes', t => {
  const f = fixture(t);
  f.write('bad.json', '{broken');
  const report = JSON.parse(f.command(['series', 'check', 'bad.json', '--json'], 1));
  assert.equal(report.errors[0].code, 'SERIES_INPUT_INVALID');
  assert.equal(fs.existsSync(f.catalogFile), false);
  f.command(['series', 'register', 'series.json']);
  const before = fs.readFileSync(f.catalogFile);
  f.write('series.json', { ...f.spec, name: '다른 이름' });
  const conflict = JSON.parse(f.command(['series', 'check', 'series.json', '--json'], 1));
  assert.ok(conflict.errors.some(item => item.code === 'SERIES_CONFLICT'));
  f.command(['series', 'register', 'series.json'], 1);
  assert.deepEqual(fs.readFileSync(f.catalogFile), before);
});

test('registration blocks evidence changed after preflight and preserves the inspected input against caller mutation', async t => {
  const f = fixture(t);
  await assert.rejects(registerSeries(f.root, f.spec, { listVoices: voices, onPreflight: () => f.write('source.md', 'Changed after the completed check.') }), { code: 'SERIES_PREFLIGHT_CHANGED' });
  assert.equal(fs.existsSync(f.catalogFile), false);
  const expectedName = f.spec.name;
  await registerSeries(f.root, f.spec, { listVoices: async () => { f.spec.name = 'Changed by caller during asynchronous lookup'; return voices(); } });
  assert.equal(readCatalog(f.root).series.local.name, expectedName);
});

test('registration reports an invalid adapter export and creates no catalog', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.pipeline, 'story/adapter.cjs'), 'exports.value = 1;');
  await assert.rejects(registerSeries(f.root, f.spec, { listVoices: voices }), error => error.code === 'SERIES_PREFLIGHT_FAILED' &&
    error.report.errors.some(item => item.code === 'ADAPTER_LOAD_FAILED'));
  assert.equal(fs.existsSync(f.catalogFile), false);
});

test('CLI check and register report a damaged catalog without overwriting it', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.catalogFile));
  f.write('planning/catalog.json', '{broken');
  const before = fs.readFileSync(f.catalogFile);
  const report = JSON.parse(f.command(['series', 'check', 'series.json', '--json'], 1));
  assert.equal(report.canRegister, false);
  assert.ok(report.errors.some(item => item.code === 'CATALOG_UNREADABLE'));
  assert.match(f.command(['series', 'register', 'series.json'], 1), /CATALOG_UNREADABLE/);
  assert.deepEqual(fs.readFileSync(f.catalogFile), before);
});
