const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const assetTypes = {
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); }
  catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return false; throw error; }
}

function directories(directory) {
  try { return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(directory, entry.name)).sort(); }
  catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return []; throw error; }
}

function browserExecutable(explicit) {
  const configured = explicit || process.env.HYPERFRAMES_BROWSER_PATH;
  if (configured) {
    if (!path.isAbsolute(configured) || !isFile(configured)) throw new Error('Visual browser path must name an existing absolute executable.');
    return configured;
  }
  const candidates = [];
  if (process.platform === 'win32') {
    for (const base of new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA,
      path.join(os.homedir(), 'AppData', 'Local')].filter(Boolean))) {
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else {
    for (const base of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const name of ['google-chrome', 'chromium', 'chromium-browser']) candidates.push(path.join(base, name));
    }
    if (process.platform === 'darwin') candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  }
  const found = candidates.find(isFile);
  if (!found) throw new Error('Chrome is unavailable. Set HYPERFRAMES_BROWSER_PATH to the installed browser.');
  return found;
}

async function loadPuppeteer(explicit) {
  const configured = explicit || process.env.VISUAL_PUPPETEER_PATH;
  const candidates = [];
  const resolveAt = directory => {
    try { candidates.push(createRequire(path.join(directory, '__visual_resolve__.cjs')).resolve('puppeteer-core')); }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  };
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error('VISUAL_PUPPETEER_PATH must be absolute.');
    let location = configured;
    if (fs.statSync(location).isDirectory()) {
      const manifest = JSON.parse(fs.readFileSync(path.join(location, 'package.json'), 'utf8'));
      if (manifest.name !== 'puppeteer-core') throw new Error('VISUAL_PUPPETEER_PATH must reference puppeteer-core.');
      location = path.resolve(location, manifest.main);
    }
    if (!isFile(location)) throw new Error('VISUAL_PUPPETEER_PATH does not name an installed module.');
    candidates.push(location);
  } else {
    resolveAt(__dirname);
    resolveAt(process.cwd());
    if (process.env.HYPERFRAMES_CLI) resolveAt(path.dirname(path.resolve(process.env.HYPERFRAMES_CLI)));
    if (process.env.APPDATA) resolveAt(path.join(process.env.APPDATA, 'npm', 'node_modules', 'hyperframes'));
    const localDirs = [process.env.LOCALAPPDATA, path.join(os.homedir(), 'AppData', 'Local')].filter(Boolean);
    const caches = new Set([process.env.npm_config_cache, ...localDirs.map(dir => path.join(dir, 'npm-cache')), path.join(os.homedir(), '.npm')].filter(Boolean));
    for (const cache of caches) for (const entry of directories(path.join(cache, '_npx'))) resolveAt(path.join(entry, 'node_modules', 'hyperframes'));
  }
  const file = [...new Set(candidates)].find(isFile);
  if (!file) throw new Error('Installed puppeteer-core is unavailable. Use the existing HyperFrames installation or set VISUAL_PUPPETEER_PATH. No package is downloaded automatically.');
  const imported = await import(pathToFileURL(file).href);
  const puppeteer = imported.default || imported;
  if (typeof puppeteer.launch !== 'function') throw new Error('The configured visual browser module does not export launch().');
  return { puppeteer, modulePath: file };
}

// Requests can read only the main document and safe assets inside its actual folder.
// A random route and exact Host check avoid exposing the directory to other web origins.
async function createLocalServer(htmlFile) {
  const requested = path.resolve(htmlFile);
  const file = fs.realpathSync(requested);
  if (!fs.statSync(file).isFile() || !/\.html?$/i.test(file)) throw new Error('Visual inspection needs an existing HTML document.');
  const root = fs.realpathSync(path.dirname(file));
  const token = randomUUID();
  const sockets = new Set();
  const denied = [];
  let origin;
  const server = http.createServer((request, response) => {
    const reject = status => { response.writeHead(status); response.end(); };
    if (!origin || request.headers.host !== new URL(origin).host || !['GET', 'HEAD'].includes(request.method)) return reject(403);
    let url;
    let decoded;
    try { url = new URL(request.url, origin); decoded = decodeURIComponent(url.pathname); }
    catch { return reject(400); }
    const prefix = '/' + token + '/';
    if (!decoded.startsWith(prefix)) return reject(403);
    const name = decoded.slice(prefix.length);
    if (!name || /[\x00-\x1f\\:]/.test(name) || name.split('/').some(segment => segment === '..' || segment === '.' || !segment)) return reject(403);
    const target = path.resolve(root, ...name.split('/'));
    let actual;
    try { actual = fs.realpathSync(target); }
    catch { return reject(404); }
    if (!within(root, target) || !within(root, actual)) return reject(403);
    const mime = actual === file ? 'text/html; charset=utf-8' : assetTypes[path.extname(actual).toLowerCase()];
    let stat;
    try { stat = fs.statSync(actual); } catch { return reject(404); }
    if (!mime || !stat.isFile()) { if (denied.length < 50) denied.push(name); return reject(403); }
    if (stat.size > 32 * 1024 * 1024) return reject(413);
    response.writeHead(200, {
      'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
    });
    if (request.method === 'HEAD') return response.end();
    const stream = fs.createReadStream(actual);
    stream.once('error', () => response.destroy());
    stream.pipe(response);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: origin + '/' + token + '/' + encodeURIComponent(path.basename(file)), token, denied,
    async close() {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}

function validateSamples(samples) {
  if (!Array.isArray(samples) || !samples.length || samples.length > 200) throw new Error('Visual inspection requires 1–200 samples.');
  const ids = new Set();
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object' || !/^[a-z0-9][a-z0-9_-]{0,100}$/.test(sample.id || '') ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sample.id) || ids.has(sample.id) ||
        typeof sample.sceneId !== 'string' || !sample.sceneId || !['stable', 'transition'].includes(sample.phase) ||
        !Number.isFinite(sample.timeSeconds) || sample.timeSeconds < 0 || sample.timeSeconds > 3600) throw new Error('Invalid or duplicate visual sample.');
    ids.add(sample.id);
  }
}

function timeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds); })])
    .finally(() => clearTimeout(timer));
}

async function closeBrowser(browser) {
  if (!browser) return;
  try { await timeout(browser.close(), 10000, 'Browser close'); }
  catch {
    const processHandle = browser.process();
    if (!processHandle?.pid) return;
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        child.once('close', resolve); child.once('error', resolve);
        setTimeout(() => { child.kill(); resolve(); }, 5000).unref();
      });
    } else processHandle.kill('SIGKILL');
  }
}

// This function is serialized into the page by Puppeteer. It never executes page code.
function collectDom(sample) {
  const rect = box => ({ x: box.x, y: box.y, width: box.width, height: box.height });
  const main = document.querySelector('main[data-composition-id]') || document.querySelector('main');
  if (!main) throw new Error('The inspected HTML has no main composition element.');
  const elements = [];
  for (const element of main.querySelectorAll('.brand, .scene h1, .scene p, .card')) {
    const style = getComputedStyle(element);
    const scene = element.closest('[data-scene-id]');
    const role = element.classList.contains('card') ? 'card' : element.classList.contains('brand') ? 'brand' : element.tagName === 'H1' ? 'headline' : 'body';
    const sceneId = scene?.getAttribute('data-scene-id') || (role === 'card' ? sample.sceneId : undefined);
    const cardId = element.getAttribute('data-card-id') || undefined;
    let opacity = 1;
    let displayed = true;
    const clipRects = [];
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const computed = getComputedStyle(ancestor);
      opacity *= Number(computed.opacity);
      if (computed.display === 'none' || computed.visibility === 'hidden' || computed.visibility === 'collapse' || computed.contentVisibility === 'hidden') displayed = false;
      const clipX = ['hidden', 'clip', 'scroll', 'auto'].includes(computed.overflowX);
      const clipY = ['hidden', 'clip', 'scroll', 'auto'].includes(computed.overflowY);
      if (clipX || clipY) {
        const box = ancestor.getBoundingClientRect();
        clipRects.push({ x: clipX ? box.x : -1e9, y: clipY ? box.y : -1e9,
          width: clipX ? box.width : 2e9, height: clipY ? box.height : 2e9, clipX, clipY });
      }
    }
    const box = element.getBoundingClientRect();
    const textRects = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (!textNode.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(textNode);
      for (const box of range.getClientRects()) if (box.width > 0 && box.height > 0) textRects.push(rect(box));
    }
    const fontSize = Number.parseFloat(style.fontSize) || 16;
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.2;
    elements.push({ id: role === 'card' ? `card-${cardId}` : role === 'brand' ? 'brand' : `${sceneId}-${role}`,
      role, ...(sceneId ? { sceneId } : {}), ...(cardId ? { cardId } : {}), text: element.textContent.trim(),
      rect: rect(box), textRects, fontSize, lineHeight, fontFamily: style.fontFamily,
      fontLoadCheck: document.fonts.check(`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, element.textContent || '한글'),
      opacity, visible: displayed && opacity > .01 && box.width > 0 && box.height > 0,
      clipRects, clientWidth: element.clientWidth, clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight });
  }
  return { rootRect: rect(main.getBoundingClientRect()), elements, fontStatus: document.fonts.status,
    fontFaces: [...document.fonts].map(face => ({ family: face.family, status: face.status })) };
}

async function captureLayout({ htmlFile, directory, samples, width = 1080, height = 1920, browserPath, puppeteerPath } = {}) {
  validateSamples(samples);
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 64 && value <= 8192)) throw new Error('Visual viewport dimensions must be 64–8192 pixels.');
  if (typeof htmlFile !== 'string' || typeof directory !== 'string') throw new Error('Visual input and output paths are required.');
  const input = fs.realpathSync(path.resolve(htmlFile));
  const output = path.resolve(directory);
  fs.mkdirSync(output, { recursive: true });
  const actualOutput = fs.realpathSync(output);
  if (actualOutput === fs.realpathSync(path.dirname(input))) throw new Error('Visual evidence must be saved in a separate output directory.');
  const frames = path.join(output, 'frames');
  fs.mkdirSync(frames, { recursive: true });
  if (!within(actualOutput, fs.realpathSync(frames))) throw new Error('Visual frames resolve outside the audit directory.');
  for (const sample of samples) if (fs.existsSync(path.join(frames, sample.id + '.png'))) throw new Error('Visual evidence already exists. Use a new audit directory.');
  const executablePath = browserExecutable(browserPath);
  const { puppeteer, modulePath } = await loadPuppeteer(puppeteerPath);
  const profile = fs.mkdtempSync(path.join(output, '.browser-profile-'));
  let server;
  let browser;
  const blockedRequests = [];
  const resourceErrors = [];
  try {
    server = await createLocalServer(input);
    browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile, timeout: 30000,
      protocolTimeout: 30000, args: ['--lang=ko-KR', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(20000);
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      const permitted = url.startsWith(server.origin + '/' + server.token + '/') || (url.startsWith('data:') && request.resourceType() === 'image');
      if (!permitted && blockedRequests.length < 50) blockedRequests.push({ url: url.slice(0, 1000), type: request.resourceType() });
      (permitted ? request.continue() : request.abort('blockedbyclient')).catch(() => {});
    });
    page.on('response', response => { if (response.status() >= 400 && resourceErrors.length < 50) resourceErrors.push({ url: response.url(), status: response.status() }); });
    const navigation = await page.goto(server.url, { waitUntil: 'load' });
    if (!navigation || navigation.status() !== 200) throw new Error('The local visual inspection document did not load.');
    await timeout(page.evaluate(async () => {
      document.querySelectorAll('audio,video').forEach(media => { media.pause(); media.muted = true; });
      await document.fonts.ready;
      for (const animation of document.getAnimations()) animation.pause();
    }), 20000, 'Font and animation initialization');
    const captured = [];
    for (const sample of samples) {
      await timeout(page.evaluate(time => {
        for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = time * 1000; }
        window.scrollTo(0, 0);
        document.documentElement.getBoundingClientRect();
      }, sample.timeSeconds), 20000, 'Animation sampling');
      const layout = await timeout(page.evaluate(collectDom, sample), 20000, 'DOM inspection');
      const screenshot = `frames/${sample.id}.png`;
      await timeout(page.screenshot({ path: path.join(output, screenshot), type: 'png', fullPage: false, captureBeyondViewport: false }), 20000, 'Screenshot');
      captured.push({ ...sample, ...layout, screenshot });
    }
    return { browser: { product: await browser.version(), executablePath, puppeteerModule: modulePath, headless: true,
      pageScriptsDisabled: true, externalRequestsBlocked: true, fontAvailabilityNotGuaranteed: true },
      width, height, samples: captured, blockedRequests, resourceErrors, deniedAssets: server.denied };
  } finally {
    await closeBrowser(browser);
    if (server) await server.close();
    // This directory was freshly created above. Check both its lexical and actual
    // containment before recursive cleanup; never delete a caller-owned directory.
    if (fs.existsSync(profile) && path.dirname(profile) === output && path.basename(profile).startsWith('.browser-profile-') &&
        within(actualOutput, fs.realpathSync(profile))) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch { /* Chrome may retain a Windows file handle briefly; no user profile is used. */ }
    }
  }
}

module.exports = { captureLayout, createLocalServer, validateSamples, browserExecutable, loadPuppeteer };
