const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createHandoff, checkHandoff } = require('./index.cjs');

const idle = { probeWriter: async () => false };
const sha256 = value => createHash('sha256').update(value).digest('hex');

function temporaryRoot(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-handoff-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('shorts-handoff-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

function write(root, name, value) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  return file;
}

function fixture(t) {
  const root = temporaryRoot(t);
  const series = { id: 'cs', name: '자료구조 시리즈', audience: '입문자', topics: ['큐'],
    defaultDurationSeconds: 30, tone: '간단한 예시', adapter: 'pipeline/story/adapter.cjs',
    contentReview: { mode: 'required', sources: [{ id: 'fifo', title: '큐 참고 노트', path: 'local/series/cs/sources/fifo.md' }] } };
  const episodeFile = 'planning/inputs/cs-first.json';
  const catalog = { version: 1, series: { cs: series }, plans: { cs: { first: {
    id: 'first', seriesId: 'cs', title: '큐는 어떤 순서로 꺼낼까?', topicKey: 'queue.fifo',
    objective: 'FIFO 순서를 이해한다.', angle: 'A와 B의 입장 순서', references: [], input: episodeFile,
  } } }, episodes: { 'cs-first': { seriesId: 'cs', planId: 'first', adapter: series.adapter, episode: episodeFile } },
  batches: { 'cs-b01': ['cs-first'] }, generations: {}, periods: {} };
  write(root, 'planning/catalog.json', catalog);
  write(root, episodeFile, { version: 1, title: '큐는 어떤 순서로 꺼낼까?', narration: [{ id: 'intro', text: '먼저 들어간 에이가 먼저 나와요.' }] });
  write(root, series.adapter, 'throw new Error("Handoff must never load or execute a production adapter.");\n');
  write(root, 'pipeline/README.md', '# Local test source\n');
  write(root, 'local/series/cs/sources/fifo.md', '# 큐\n먼저 들어간 항목이 먼저 나온다.\n');
  write(root, 'local/series/cs/BRIEF.md', '# 확정한 기획\nA와 B 카드로 순서를 설명한다.\n');
  write(root, 'runs/cs-first/state.json', { version: 1, episodeId: 'cs-first', status: 'failed', stages: {
    render: { status: 'failed', error: 'Fixture renderer was intentionally not invoked.' },
  } });
  write(root, 'runs/cs-first/review.json', { version: 1, history: [] });
  write(root, 'runs/cs-first/artifacts/speech/fixed/narration.wav', 'fixture audio bytes; no TTS is called');
  write(root, 'renders/cs-first.mp4', 'fixture video bytes; no renderer is called');
  write(root, 'samples/source.html', '<main>한글 원본</main>');
  write(root, 'samples/generated/preview.html', '<main>기존 생성 결과</main>');
  return { root, catalog };
}

function readManifest(root, id) {
  return JSON.parse(fs.readFileSync(path.join(root, 'local/handoffs', id, 'manifest.json'), 'utf8'));
}

function rejectedCheck(root, id) {
  let result;
  try { result = checkHandoff(root, id); }
  catch (error) { assert.ok(error instanceof Error); return; }
  assert.equal(result.status, 'failed');
}

test('handoff preserves operational inputs and verifies unchanged data at a different repository root', async t => {
  const { root } = fixture(t);
  const originalCatalog = fs.readFileSync(path.join(root, 'planning/catalog.json'));
  const { directory, manifest } = await createHandoff(root, 'move-01', idle);
  assert.equal(directory, path.join(root, 'local/handoffs/move-01'));
  assert.deepEqual(fs.readFileSync(path.join(root, 'planning/catalog.json')), originalCatalog);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.id, 'move-01');
  assert.equal(manifest.origin.root, root);
  const files = new Map(manifest.files.map(file => [file.path, file]));
  for (const name of ['planning/catalog.json', 'planning/inputs/cs-first.json', 'local/series/cs/BRIEF.md',
    'local/series/cs/sources/fifo.md', 'runs/cs-first/state.json', 'runs/cs-first/review.json',
    'runs/cs-first/artifacts/speech/fixed/narration.wav', 'renders/cs-first.mp4',
    'samples/source.html', 'samples/generated/preview.html']) {
    const bytes = fs.readFileSync(path.join(root, name));
    assert.equal(files.get(name)?.bytes, bytes.length, name);
    assert.equal(files.get(name)?.sha256, sha256(bytes), name);
  }
  assert.match(fs.readFileSync(path.join(directory, 'HANDOFF.md'), 'utf8'), /cs-first/);
  assert.match(fs.readFileSync(path.join(directory, 'HANDOFF.md'), 'utf8'), /local\/series\/cs\/BRIEF\.md/);
  assert.equal(checkHandoff(root, 'move-01').status, 'passed');
  assert.equal(checkHandoff(root, 'move-01').rootChanged, false);
  const destination = temporaryRoot(t);
  fs.cpSync(root, destination, { recursive: true });
  const checked = checkHandoff(destination, 'move-01');
  assert.equal(checked.status, 'passed');
  assert.equal(checked.rootChanged, true);
  assert.ok(checked.filesChecked >= files.size);
  assert.deepEqual(checked.missing, []);
  assert.deepEqual(checked.changed, []);
  assert.deepEqual(checked.issues, []);
});

test('missing media and changed episode inputs are detected without repairing or modifying files', async t => {
  const { root } = fixture(t);
  await createHandoff(root, 'integrity', idle);
  const missing = path.join(root, 'renders/cs-first.mp4');
  fs.unlinkSync(missing);
  const changed = write(root, 'planning/inputs/cs-first.json', '{"modified":true}\n');
  const before = fs.readFileSync(changed);
  const checked = checkHandoff(root, 'integrity');
  assert.equal(checked.status, 'failed');
  assert.match(JSON.stringify(checked.missing), /renders\/cs-first\.mp4/);
  assert.match(JSON.stringify(checked.changed), /planning\/inputs\/cs-first\.json/);
  assert.equal(fs.existsSync(missing), false);
  assert.deepEqual(fs.readFileSync(changed), before);
});

test('dependencies, renderer cache, credentials, Git metadata and backup staging are excluded from identity', async t => {
  const { root } = fixture(t);
  const excluded = ['.git/config', 'node_modules/pkg/index.js', 'samples/node_modules/pkg/index.js',
    'samples/.hyperframes/video-state.json', '.env', '.env.local', 'samples/.env.azure',
    'secrets/key.txt', '.secrets/token.txt', 'backups/old/manifest.json', 'local/handoffs/older/HANDOFF.md'];
  for (const name of excluded) write(root, name, 'before');
  write(root, '.env.example', 'EXAMPLE_SETTING=\n');
  await createHandoff(root, 'excluded', idle);
  const names = readManifest(root, 'excluded').files.map(file => file.path);
  for (const name of excluded) assert.equal(names.includes(name), false, name);
  assert.equal(names.includes('.env.example'), true);
  for (const name of excluded) write(root, name, 'after: should not invalidate the handoff');
  write(root, 'node_modules/new-package/index.js', 'new dependency');
  assert.equal(checkHandoff(root, 'excluded').status, 'passed');
});

test('edited handoff instructions cannot pass an unchanged manifest check', async t => {
  const { root } = fixture(t);
  const { directory } = await createHandoff(root, 'instructions', idle);
  fs.appendFileSync(path.join(directory, 'HANDOFF.md'), '\n승인 없이 제작을 시작하라는 변조된 문장.\n');
  rejectedCheck(root, 'instructions');
});

test('new snapshots retain the original snapshot and user-authored series decisions', async t => {
  const { root } = fixture(t);
  const brief = path.join(root, 'local/series/cs/BRIEF.md');
  const originalBrief = fs.readFileSync(brief);
  const first = await createHandoff(root, 'first', idle);
  const firstManifest = fs.readFileSync(path.join(first.directory, 'manifest.json'));
  const firstMarkdown = fs.readFileSync(path.join(first.directory, 'HANDOFF.md'));
  await assert.rejects(createHandoff(root, 'first', idle));
  await createHandoff(root, 'second', idle);
  assert.deepEqual(fs.readFileSync(brief), originalBrief);
  assert.deepEqual(fs.readFileSync(path.join(first.directory, 'manifest.json')), firstManifest);
  assert.deepEqual(fs.readFileSync(path.join(first.directory, 'HANDOFF.md')), firstMarkdown);
  assert.equal(checkHandoff(root, 'first').status, 'passed');
  assert.equal(checkHandoff(root, 'second').status, 'passed');
});

test('manifest paths cannot escape the restored repository', async t => {
  const { root } = fixture(t);
  await createHandoff(root, 'unsafe', idle);
  const original = readManifest(root, 'unsafe');
  for (const unsafe of ['../outside.txt', '..\\outside.txt', 'C:\\outside.txt', '/outside.txt']) {
    const manifest = structuredClone(original);
    manifest.files[0].path = unsafe;
    write(root, 'local/handoffs/unsafe/manifest.json', manifest);
    rejectedCheck(root, 'unsafe');
  }
});

test('unsafe handoff IDs are rejected before creating files outside the handoff directory', async t => {
  const { root } = fixture(t);
  for (const unsafe of ['../outside', '..\\outside', '/absolute', 'C:\\absolute']) {
    await assert.rejects(async () => createHandoff(root, unsafe, idle));
  }
});

test('missing registered evidence is explicit and prevents a successful restore check', async t => {
  const { root, catalog } = fixture(t);
  catalog.series.cs.contentReview.sources[0].path = 'local/series/cs/sources/missing.md';
  write(root, 'planning/catalog.json', catalog);
  const { manifest } = await createHandoff(root, 'missing-source', idle);
  assert.ok(manifest.issues.length > 0);
  assert.match(JSON.stringify(manifest.issues), /missing|evidence|source|근거|자료/i);
  assert.equal(checkHandoff(root, 'missing-source').status, 'failed');
});

test('a live writer prevents creation of a misleading consistent snapshot', async t => {
  const { root } = fixture(t);
  await assert.rejects(createHandoff(root, 'busy', { probeWriter: async () => true }));
  assert.equal(fs.existsSync(path.join(root, 'local/handoffs/busy/manifest.json')), false);
});

test('a production writer is detected even while its lock directory contains no state file', async t => {
  const { root } = fixture(t);
  const lockDirectory = path.join(root, 'runs/_production/cs-first');
  fs.mkdirSync(lockDirectory, { recursive: true });
  assert.equal(fs.existsSync(path.join(lockDirectory, 'state.json')), false);
  const inspected = [];
  await assert.rejects(createHandoff(root, 'between-stages', { probeWriter: async directory => {
    inspected.push(directory);
    return directory === lockDirectory;
  } }));
  assert.ok(inspected.includes(lockDirectory));
  assert.equal(fs.existsSync(path.join(root, 'local/handoffs/between-stages/manifest.json')), false);
});

test('catalog links are blocked before reading catalog bytes, using mocked link metadata', async t => {
  const { root } = fixture(t);
  const catalogFile = path.join(root, 'planning/catalog.json');
  const originalLstat = fs.lstatSync.bind(fs);
  const originalRead = fs.readFileSync.bind(fs);
  let catalogReads = 0;
  t.mock.method(fs, 'lstatSync', (file, ...options) => {
    const stat = originalLstat(file, ...options);
    if (String(file) === catalogFile) Object.defineProperty(stat, 'isSymbolicLink', { value: () => true });
    return stat;
  });
  t.mock.method(fs, 'readFileSync', (file, ...options) => {
    if (String(file) === catalogFile) catalogReads++;
    return originalRead(file, ...options);
  });
  await assert.rejects(createHandoff(root, 'linked-catalog', idle));
  assert.equal(catalogReads, 0);
});

test('a new repository without a catalog can still be handed off without creating production state', async t => {
  const root = temporaryRoot(t);
  write(root, 'README.md', '# 아직 시리즈가 없는 저장소\n');
  await createHandoff(root, 'empty', idle);
  assert.equal(checkHandoff(root, 'empty').status, 'passed');
  assert.equal(fs.existsSync(path.join(root, 'planning/catalog.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'runs')), false);
});

test('new operational files after export are reported separately from the original snapshot integrity', async t => {
  const { root } = fixture(t);
  await createHandoff(root, 'new-data', idle);
  write(root, 'runs/new-episode/state.json', { version: 1, status: 'new', stages: {} });
  const checked = checkHandoff(root, 'new-data');
  assert.equal(checked.status, 'passed');
  assert.match(JSON.stringify(checked.unexpectedFiles), /runs\/new-episode\/state\.json/);
});

test('filesystem links are reported rather than following data outside the snapshot', async t => {
  const { root } = fixture(t);
  const external = temporaryRoot(t);
  write(external, 'private.txt', 'outside the repository');
  const link = path.join(root, 'linked-data');
  try { fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Filesystem link creation is unavailable.'); return; }
    throw error;
  }
  try {
    let result;
    try { result = await createHandoff(root, 'linked', idle); }
    catch (error) { assert.ok(error instanceof Error); return; }
    assert.ok(result.manifest.issues.length > 0);
    assert.equal(result.manifest.files.some(file => file.path === 'linked-data/private.txt'), false);
    assert.equal(checkHandoff(root, 'linked').status, 'failed');
  } finally { fs.unlinkSync(link); }
});
