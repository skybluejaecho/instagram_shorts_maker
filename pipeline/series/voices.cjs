const path = require('node:path');
const childProcess = require('node:child_process');

const TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 256 * 1024;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseVoices(stdout) {
  let voices;
  try { voices = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim()); }
  catch { throw failure('VOICE_PROBE_RESPONSE_INVALID', '설치된 음성 목록 응답을 읽을 수 없습니다. Windows System.Speech 환경을 확인해 주세요.'); }
  const readable = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
  if (!Array.isArray(voices) || voices.length > 500 || voices.some(voice =>
    !voice || typeof voice !== 'object' || Array.isArray(voice) ||
    Object.keys(voice).some(key => !['name', 'culture', 'enabled'].includes(key)) ||
    !readable(voice.name, 250) || !readable(voice.culture, 80) || typeof voice.enabled !== 'boolean')) {
    throw failure('VOICE_PROBE_RESPONSE_INVALID', '설치된 음성 목록의 형식이 올바르지 않습니다. Windows System.Speech 환경을 확인해 주세요.');
  }
  // Preserve the exact installed voice names used by SelectVoice in synthesis.
  return voices.map(({ name, culture, enabled }) => ({ name, culture, enabled }));
}

async function listInstalledVoices({ platform = process.platform, execFile = childProcess.execFile } = {}) {
  if (platform !== 'win32') throw failure('VOICE_PLATFORM_UNSUPPORTED', '공통 한국어 음성 제작에는 Windows와 설치된 System.Speech 한국어 음성이 필요합니다.');
  if (typeof execFile !== 'function') throw new TypeError('execFile must be a function.');
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(__dirname, 'voices.ps1');
  const stdout = await new Promise((resolve, reject) => {
    execFile(executable, ['-NoProfile', '-NonInteractive', '-File', script], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES,
    }, (error, output) => {
      if (!error) return resolve(output);
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(failure('VOICE_PROBE_OUTPUT_LIMIT', '설치된 음성 목록 응답이 허용 크기를 초과했습니다. Windows 음성 환경을 확인해 주세요.'));
      if (error.killed || error.code === 'ETIMEDOUT') return reject(failure('VOICE_PROBE_TIMEOUT', '설치된 음성 목록 조회가 15초 안에 끝나지 않았습니다. Windows 음성 환경을 확인한 뒤 다시 시도해 주세요.'));
      if (error.code === 'ENOENT') return reject(failure('VOICE_PROBE_FAILED', 'Windows PowerShell을 찾을 수 없어 음성 목록을 조회하지 못했습니다. Windows 설치 경로를 확인해 주세요.'));
      reject(failure('VOICE_PROBE_FAILED', '설치된 음성 목록을 조회하지 못했습니다. Windows PowerShell의 System.Speech 접근 권한과 설치 상태를 확인해 주세요.'));
    });
  });
  return parseVoices(stdout);
}

module.exports = { listInstalledVoices };
