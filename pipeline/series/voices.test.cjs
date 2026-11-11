const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { listInstalledVoices } = require('./voices.cjs');

const inventory = [
  { name: 'Microsoft Heami Desktop', culture: 'ko-KR', enabled: true },
  { name: 'Disabled Korean Voice', culture: 'ko-KR', enabled: false },
  { name: 'Microsoft David Desktop', culture: 'en-US', enabled: true },
];
const returning = stdout => (_file, _args, _options, callback) => callback(null, stdout);
const failing = error => (_file, _args, _options, callback) => callback(error, '', 'private diagnostic must not be exposed');

test('enumerates voices with the production PowerShell host, a fixed script and bounded hidden execution', async () => {
  let calls = 0;
  const voices = await listInstalledVoices({ platform: 'win32', execFile: (file, args, options, callback) => {
    calls++;
    assert.equal(file, path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'voices.ps1')]);
    assert.deepEqual(options, { shell: false, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024 });
    callback(null, '\uFEFF' + JSON.stringify(inventory) + '\r\n');
  } });
  assert.equal(calls, 1);
  assert.deepEqual(voices, inventory);
});

test('empty and single-voice inventories preserve their array shape', async () => {
  assert.deepEqual(await listInstalledVoices({ platform: 'win32', execFile: returning('[]') }), []);
  assert.deepEqual(await listInstalledVoices({ platform: 'win32', execFile: returning(JSON.stringify(inventory.slice(0, 1))) }), inventory.slice(0, 1));
});

test('unsupported hosts do not launch a process', async () => {
  await assert.rejects(listInstalledVoices({ platform: 'linux', execFile: () => assert.fail('No process should start') }), { code: 'VOICE_PLATFORM_UNSUPPORTED' });
});

test('process failures have useful stable codes without copying subprocess diagnostics', async () => {
  for (const [error, code] of [
    [{ code: 'ENOENT' }, 'VOICE_PROBE_FAILED'],
    [{ code: 'EACCES' }, 'VOICE_PROBE_FAILED'],
    [{ code: 1 }, 'VOICE_PROBE_FAILED'],
    [{ code: 'ETIMEDOUT' }, 'VOICE_PROBE_TIMEOUT'],
    [{ killed: true, signal: 'SIGTERM' }, 'VOICE_PROBE_TIMEOUT'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, 'VOICE_PROBE_OUTPUT_LIMIT'],
  ]) await assert.rejects(listInstalledVoices({ platform: 'win32', execFile: failing(error) }), actual => {
    assert.equal(actual.code, code);
    assert.ok(!actual.message.includes('private diagnostic'));
    return true;
  });
});

test('invalid inventories cannot be treated as a successful environment check', async () => {
  for (const value of [
    'not-json', '{}', 'null', JSON.stringify(inventory[0]), '[null]', '[[]]',
    JSON.stringify([{ ...inventory[0], enabled: 'true' }]),
    JSON.stringify([{ name: 'Voice', enabled: true }]),
    JSON.stringify([{ ...inventory[0], name: '  ' }]),
    JSON.stringify([{ ...inventory[0], culture: 'ko-KR\n' }]),
    JSON.stringify([{ ...inventory[0], path: 'unexpected' }]),
    JSON.stringify(Array.from({ length: 501 }, () => inventory[0])),
  ]) await assert.rejects(listInstalledVoices({ platform: 'win32', execFile: returning(value) }), { code: 'VOICE_PROBE_RESPONSE_INVALID' });
});
