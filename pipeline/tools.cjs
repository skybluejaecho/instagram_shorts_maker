const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const windows = process.platform === 'win32';
const localAppData = windows ? [...new Set([
  process.env.LOCALAPPDATA, path.join(os.homedir(), 'AppData', 'Local'),
].filter(Boolean))] : [];

function isFile(location) {
  return fs.statSync(location, { throwIfNoEntry: false })?.isFile();
}

function directories(location) {
  try {
    return fs.readdirSync(location, { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => path.join(location, entry.name)).sort();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return [];
    throw error;
  }
}

function fromPath(name) {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .map(dir => path.join(dir.replace(/^"|"$/g, ''), name)).find(isFile);
}

function override(name) {
  if (!process.env[name]) return undefined;
  const location = path.resolve(process.env[name]);
  if (!isFile(location)) throw Error(`${name} does not point to a file: ${location}`);
  return location;
}

function mediaTool(name) {
  const envName = `HYPERFRAMES_${name.toUpperCase()}_PATH`;
  const filename = name + (windows ? '.exe' : '');
  const installed = override(envName) || fromPath(filename);
  if (installed) return installed;
  for (const base of localAppData) {
    const packages = directories(path.join(base, 'Microsoft', 'WinGet', 'Packages'));
    for (const pkg of packages.filter(p => /ffmpeg/i.test(path.basename(p)))) {
      const binary = [pkg, ...directories(pkg)].map(p => path.join(p, 'bin', filename)).find(isFile);
      if (binary) return binary;
    }
  }
  throw Error(`Cannot find ${name}. Install FFmpeg or set ${envName} to its executable.`);
}

function hyperframes(root) {
  const explicit = override('HYPERFRAMES_CLI');
  if (explicit) {
    if (/\.(?:cmd|bat|ps1)$/i.test(explicit)) {
      throw Error('HYPERFRAMES_CLI must point to the Node entry (bin/hyperframes.mjs) or a native executable.');
    }
    return /\.(?:mjs|cjs|js)$/i.test(explicit) ? [process.execPath, explicit] : [explicit];
  }
  const candidates = [path.join(root, 'node_modules', 'hyperframes')];
  const native = fromPath(windows ? 'hyperframes.exe' : 'hyperframes');
  if (windows && process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'hyperframes'));
  const caches = new Set([process.env.npm_config_cache, ...localAppData.map(p => path.join(p, 'npm-cache')), path.join(os.homedir(), '.npm')].filter(Boolean));
  for (const cache of caches) {
    for (const entry of directories(path.join(cache, '_npx'))) candidates.push(path.join(entry, 'node_modules', 'hyperframes'));
  }
  for (const dir of candidates) {
    const manifest = path.join(dir, 'package.json');
    if (!isFile(manifest)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.hyperframes;
    if (pkg.name === 'hyperframes' && bin && isFile(path.resolve(dir, bin))) return [process.execPath, path.resolve(dir, bin)];
  }
  if (native) return [native];
  throw Error('Cannot find HyperFrames. Install hyperframes locally or set HYPERFRAMES_CLI to its Node entry.');
}

function chrome() {
  const explicit = override('HYPERFRAMES_BROWSER_PATH');
  if (explicit) return explicit;
  if (windows) return [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], ...localAppData]
    .filter(Boolean).map(p => path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(isFile);
  return fromPath('google-chrome') || fromPath('chromium');
}

function mediaEnv(names) {
  const env = { ...process.env };
  const dirs = [];
  for (const name of names) {
    const binary = mediaTool(name);
    env[`HYPERFRAMES_${name.toUpperCase()}_PATH`] = binary;
    dirs.push(path.dirname(binary));
  }
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') || 'PATH';
  env[key] = [...new Set(dirs), env[key]].filter(Boolean).join(path.delimiter);
  return env;
}

function execute(cwd, command, args, { env = process.env, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env, windowsHide: true, shell: false,
      stdio: ['ignore', capture ? 'pipe' : process.stderr, process.stderr],
    });
    let output = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; });
    }
    child.once('error', error => reject(Error(`Cannot start ${command}: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (code === 0) resolve(output);
      else reject(Error(`${path.basename(command)} exited ${signal ? `on signal ${signal}` : `with code ${code}`}`));
    });
  });
}

function rate(ratio) {
  const [n, d] = String(ratio).split('/').map(Number);
  return n / d;
}

function createTools(root) {
  const resolvePath = location => path.resolve(root, location);
  return {
    node(scriptPath, args = []) {
      return execute(root, process.execPath, [resolvePath(scriptPath), ...args]);
    },
    powershell(scriptPath, args = []) {
      if (!windows) throw Error('Windows PowerShell and a Korean System.Speech voice are required for this narration.');
      const powerShell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      return execute(root, powerShell, ['-NoProfile', '-NonInteractive', '-File', resolvePath(scriptPath), ...args], { env: mediaEnv(['ffprobe']) });
    },
    async render(compositionDir, outputPath, fps = 30) {
      const [command, ...prefix] = hyperframes(root);
      const output = resolvePath(outputPath);
      const env = mediaEnv(['ffmpeg', 'ffprobe']);
      const browser = chrome();
      if (browser) env.HYPERFRAMES_BROWSER_PATH = browser;
      fs.mkdirSync(path.dirname(output), { recursive: true });
      await execute(root, command, [...prefix, 'render', resolvePath(compositionDir), '--workers', '1', '--fps', String(fps), '--output', output], { env });
      if (!isFile(output) || fs.statSync(output).size === 0) throw Error(`Render did not produce a video: ${output}`);
    },
    async verify(videoPath, { width, height, fps, durationSeconds, requireAudio = true }) {
      if (![width, height, fps, durationSeconds].every(value => Number.isFinite(value) && value > 0)) {
        throw Error('Expected positive width, height, fps and durationSeconds for verification.');
      }
      const output = await execute(root, mediaTool('ffprobe'), ['-v', 'error', '-count_frames', '-show_entries',
        'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,duration',
        '-of', 'json', resolvePath(videoPath)], { capture: true });
      const { streams = [], format } = JSON.parse(output);
      const video = streams.find(stream => stream.codec_type === 'video');
      const audio = streams.find(stream => stream.codec_type === 'audio');
      if (!video) throw Error('MP4 has no video stream.');
      const metadata = {
        width: video.width, height: video.height, fps: rate(video.avg_frame_rate), frames: Number(video.nb_read_frames),
        durationSeconds: Number(format?.duration), videoCodec: video.codec_name, audioCodec: audio?.codec_name || null,
      };
      const expectedFrames = Math.round(fps * durationSeconds);
      const fullDuration = seconds => Number.isFinite(seconds) && Math.abs(seconds - durationSeconds) <= .5 / fps;
      if (metadata.width !== width || metadata.height !== height || metadata.videoCodec !== 'h264' ||
          ![metadata.fps, rate(video.r_frame_rate)].every(actual => Number.isFinite(actual) && Math.abs(actual - fps) <= .0001) ||
          metadata.frames !== expectedFrames || !fullDuration(metadata.durationSeconds) || !fullDuration(Number(video.duration)) ||
          (requireAudio && (audio?.codec_name !== 'aac' || !(Number(audio.nb_read_frames) > 0)))) {
        throw Error(`MP4 does not meet ${width}×${height}, ${fps} fps, ${expectedFrames} frames, ${durationSeconds}s${requireAudio ? ' with AAC' : ''}: ${JSON.stringify(metadata)}`);
      }
      return metadata;
    },
  };
}

module.exports = { createTools };
