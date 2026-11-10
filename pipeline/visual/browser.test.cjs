const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createLocalServer, validateSamples, captureLayout, browserExecutable } = require('./browser.cjs');

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-visual-browser-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    assert.ok(path.basename(root).startsWith('shorts-visual-browser-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const htmlFile = path.join(source, 'index.html');
  fs.writeFileSync(htmlFile, '<!doctype html><main>한글</main>');
  return { root, source, htmlFile };
}

function request(url, { pathname, host, method = 'GET' } = {}) {
  const base = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: base.hostname, port: base.port, path: pathname || base.pathname,
      method, headers: { Host: host || base.host } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject); req.end();
  });
}

test('local audit server serves only its document and contained safe assets without enabling scripts', async t => {
  const { source, htmlFile } = fixture(t);
  fs.writeFileSync(path.join(source, 'font.woff2'), 'controlled-font-fixture');
  fs.writeFileSync(path.join(source, 'private.json'), '{"secret":"never served"}');
  fs.writeFileSync(path.join(source, 'other.html'), '<p>unregistered document</p>');
  const server = await createLocalServer(htmlFile);
  try {
    const document = await request(server.url);
    assert.equal(document.status, 200);
    assert.match(document.body, /한글/);
    assert.match(document.headers['content-security-policy'], /script-src 'none'/);
    assert.match(document.headers['content-security-policy'], /connect-src 'none'/);
    assert.equal((await request(server.origin + '/' + server.token + '/font.woff2')).status, 200);
    assert.equal((await request(server.origin + '/' + server.token + '/private.json')).status, 403);
    assert.equal((await request(server.origin + '/' + server.token + '/other.html')).status, 403);
    assert.equal((await request(server.url, { host: 'example.com' })).status, 403);
    assert.equal((await request(server.url, { method: 'POST' })).status, 403);
    assert.equal((await request(server.url, { pathname: '/wrong-token/index.html' })).status, 403);
    assert.equal((await request(server.url, { pathname: '/' + server.token + '/%2e%2e/private.json' })).status, 403);
    assert.equal((await request(server.url, { pathname: '/' + server.token + '/..%5cprivate.json' })).status, 403);
  } finally { await server.close(); }
});

test('the local asset server rejects realpath escapes through directory junctions', async t => {
  const { root, source, htmlFile } = fixture(t);
  const external = path.join(root, 'external');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'image.svg'), '<svg/>');
  fs.symlinkSync(external, path.join(source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const server = await createLocalServer(htmlFile);
  try { assert.equal((await request(server.origin + '/' + server.token + '/escape/image.svg')).status, 403); }
  finally { await server.close(); }
});

test('sampling rejects unsafe output names, duplicate IDs and invalid times before starting a browser', () => {
  const sample = { id: 'scene-01-stable-1', sceneId: 'question', phase: 'stable', timeSeconds: 0.1 };
  assert.doesNotThrow(() => validateSamples([sample]));
  for (const patch of [{ id: '../escape' }, { id: 'con' }, { timeSeconds: NaN }, { timeSeconds: -1 }, { phase: 'unknown' }, { sceneId: '' }]) {
    assert.throws(() => validateSamples([{ ...sample, ...patch }]));
  }
  assert.throws(() => validateSamples([sample, sample]));
  assert.throws(() => validateSamples([]));
  assert.throws(() => browserExecutable('relative.exe'), /absolute/);
});

test('a browser setup failure cannot overwrite prior evidence or mutate the input document', async t => {
  const { root, htmlFile } = fixture(t);
  const before = fs.readFileSync(htmlFile);
  const directory = path.join(root, 'audit');
  fs.mkdirSync(path.join(directory, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'frames', 'sample.png'), 'existing evidence');
  await assert.rejects(captureLayout({ htmlFile, directory, samples: [{ id: 'sample', sceneId: 'scene', phase: 'stable', timeSeconds: 0 }] }), /already exists/);
  assert.equal(fs.readFileSync(path.join(directory, 'frames', 'sample.png'), 'utf8'), 'existing evidence');
  assert.deepEqual(fs.readFileSync(htmlFile), before);
  await assert.rejects(captureLayout({ htmlFile, directory: path.join(root, 'other-audit'), browserPath: path.join(root, 'missing.exe'),
    samples: [{ id: 'sample', sceneId: 'scene', phase: 'stable', timeSeconds: 0 }] }), /existing absolute executable/);
  assert.deepEqual(fs.readFileSync(htmlFile), before);
});

test('real Chrome samples paused CSS animation, inherited visibility, text bounds and full-resolution evidence',
  { skip: process.env.VISUAL_BROWSER_TEST !== '1' }, async t => {
    const { root, htmlFile } = fixture(t);
    fs.writeFileSync(htmlFile, `<!doctype html><html lang="ko"><meta charset="utf-8"><style>
      body,h1,p{margin:0}main{position:relative;width:1080px;height:1920px;overflow:hidden;font-family:"Malgun Gothic",sans-serif}
      .scene{position:absolute;inset:0}.scene h1{position:absolute;left:100px;top:100px;font-size:60px;line-height:1.2}
      .scene p{position:absolute;left:100px;top:250px;width:300px;height:30px;overflow:hidden;font-size:40px;line-height:1.2}
      .first{animation:hide 2s linear both}.second{animation:show 2s linear both}.second h1{top:400px}
      .brand{position:absolute;left:100px;top:20px;font-size:30px}
      .card{position:absolute;left:0;top:800px;width:200px;height:100px;font-size:50px;animation:move 2s linear both;opacity:.5}
      @keyframes hide{0%,49%{opacity:1}50%,100%{opacity:0}}@keyframes show{0%,49%{opacity:0}50%,100%{opacity:1}}
      @keyframes move{from{transform:translateX(20px)}to{transform:translateX(220px)}}
      </style><main data-composition-id="test"><div class="brand">한글 검증</div>
      <section class="scene first" data-scene-id="first"><h1>정상 제목</h1><p>잘림을 검사할 여러 줄의 본문입니다.</p></section>
      <section class="scene second" data-scene-id="second"><h1>다음 장면</h1></section>
      <div class="card" data-card-id="a">A</div></main>
      <script>document.querySelector('h1').textContent='실행되면 실패';</script></html>`);
    const before = fs.readFileSync(htmlFile);
    const directory = path.join(root, 'capture');
    const capture = await captureLayout({ htmlFile, directory, samples: [
      { id: 'first-stable', sceneId: 'first', phase: 'stable', timeSeconds: .25 },
      { id: 'second-stable', sceneId: 'second', phase: 'stable', timeSeconds: 1.5 },
    ] });
    assert.equal(capture.width, 1080);
    assert.equal(capture.height, 1920);
    assert.equal(capture.samples.length, 2);
    const first = capture.samples[0];
    const second = capture.samples[1];
    const title = first.elements.find(element => element.id === 'first-headline');
    assert.equal(title.visible, true);
    assert.equal(title.text, '정상 제목');
    assert.ok(title.textRects.length);
    assert.equal(second.elements.find(element => element.id === 'first-headline').visible, false);
    assert.equal(second.elements.find(element => element.id === 'second-headline').visible, true);
    assert.ok(Math.abs(first.elements.find(element => element.id === 'card-a').rect.x - 45) < .1);
    assert.ok(Math.abs(second.elements.find(element => element.id === 'card-a').rect.x - 170) < .1);
    const body = first.elements.find(element => element.id === 'first-body');
    assert.ok(body.clipRects.some(box => Math.abs(box.height - 30) < .1));
    assert.ok(body.scrollHeight > body.clientHeight);
    for (const sample of capture.samples) {
      const png = fs.readFileSync(path.join(directory, sample.screenshot));
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert.equal(png.readUInt32BE(16), 1080);
      assert.equal(png.readUInt32BE(20), 1920);
    }
    assert.deepEqual(fs.readFileSync(htmlFile), before);
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith('.browser-profile-')), false);
  });
