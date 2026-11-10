const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const windows = process.platform === 'win32';
const maxAnswerBytes = 2 * 1024 * 1024;
const maxStreamBytes = 8 * 1024 * 1024;

function isFile(file) {
  try { return fs.statSync(file).isFile(); }
  catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return false; throw error; }
}

function executableCommand(explicit) {
  let executable = explicit || process.env.CODEX_CLI;
  if (!executable) {
    const filename = windows ? 'codex.exe' : 'codex';
    const paths = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
      .map(dir => path.join(dir.replace(/^"|"$/g, ''), filename));
    if (windows) {
      for (const base of new Set([process.env.LOCALAPPDATA, path.join(os.homedir(), 'AppData', 'Local')].filter(Boolean))) {
        paths.push(path.join(base, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
      }
      if (process.env.APPDATA) paths.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    }
    executable = paths.find(isFile);
  }
  if (!executable) throw new Error('Codex CLI is unavailable. Install Codex, sign in with codex login, or set CODEX_CLI to its executable.');
  const location = path.resolve(executable);
  if (!isFile(location)) throw new Error('CODEX_CLI must point to an existing executable or Node entry file.');
  if (/\.(cmd|bat|ps1)$/i.test(location)) throw new Error('CODEX_CLI must be a native executable or a .js/.cjs/.mjs entry, not a shell wrapper.');
  return /\.(js|cjs|mjs)$/i.test(location) ? [process.execPath, location] : [location];
}

function failureCategory(stderr) {
  if (/access is denied|permission denied|액세스가 거부|os error (?:5|13)\b|unable to open database file|read-only file system|operation not permitted/i.test(stderr)) return 'permissions';
  if (/unauthorized|authentication|not logged in|login required|401/i.test(stderr)) return 'authentication';
  if (/rate.?limit|quota|usage.?limit|429/i.test(stderr)) return 'rate_limit';
  if (/network|connection|connect|dns|resolve host|proxy|stream disconnected/i.test(stderr)) return 'network';
  if (/config|unknown (?:option|feature)|unexpected argument|invalid value|model.*(?:not found|not supported|unavailable)/i.test(stderr)) return 'configuration';
  return 'process';
}

function killTree(child) {
  if (!child.pid) return;
  if (windows) {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    killer.once('error', () => child.kill('SIGKILL'));
    killer.once('close', code => { if (code !== 0) child.kill('SIGKILL'); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  }
}

function invoke(command, args, { directory, prompt, timeoutMs, metadata }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: directory, windowsHide: true, shell: false,
      detached: !windows, stdio: ['pipe', 'pipe', 'pipe'] });
    let failed;
    let stderr = '';
    let pending = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer;
    let forceTimer;
    let done = false;
    function finish(error, code, signal) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      Object.assign(metadata, { exitCode: code ?? null, signal: signal ?? null, stdoutBytes, stderrBytes });
      if (error) reject(error); else resolve();
    }
    function stop(message, category) {
      if (failed) return;
      metadata.errorCategory = category;
      failed = new Error(message);
      killTree(child);
      // Do not leave a caller hung if a platform fails to close inherited pipes.
      forceTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref();
        finish(failed, null, null);
      }, 5000);
    }
    timer = setTimeout(() => stop(`Codex generation timed out after ${timeoutMs} ms. Retry this generation or increase the provider timeoutMs setting.`, 'timeout'), timeoutMs);
    child.once('error', error => {
      metadata.errorCategory = 'start';
      finish(new Error(`Could not start Codex (${error.code || 'process error'}). Check CODEX_CLI and executable permissions.`));
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxStreamBytes) return stop('Codex output exceeded the generation output limit.', 'output_limit');
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
          metadata.usage = Object.fromEntries(Object.entries(event.usage).filter(([key, value]) => /^[a-z_]+$/.test(key) && Number.isFinite(value)));
        }
        if (['error', 'turn.failed'].includes(event.type)) {
          const message = event.message || event.error?.message;
          if (typeof message === 'string') stderr = (stderr + '\n' + message).slice(-65536);
        }
        if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'collab_tool_call'].includes(event.item?.type)) {
          stop('Codex attempted a tool action during text-only generation. No generated result was accepted.', 'unexpected_tool');
        }
      }
    });
    child.stderr.on('data', chunk => {
      stderrBytes += Buffer.byteLength(chunk);
      // Only classify diagnostics; do not persist raw stderr, environment values or session tokens.
      stderr = (stderr + chunk).slice(-65536);
      if (stderrBytes > maxStreamBytes) stop('Codex diagnostics exceeded the generation output limit.', 'output_limit');
    });
    child.stdin.on('error', () => {}); // A failed launch/early exit is handled by error/close.
    child.once('close', (code, signal) => {
      if (failed) return finish(failed, code, signal);
      if (code !== 0) {
        metadata.errorCategory = failureCategory(stderr);
        const hint = {
          permissions: 'Codex could not initialize its local state. Run this command with access to the Codex user state directory and network.',
          authentication: 'Run codex login, then retry.',
          rate_limit: 'Check the Codex usage limit, then retry later.',
          network: 'Check connectivity and proxy settings, then retry.',
          configuration: 'Check the installed Codex version and selected model.',
          process: 'Check codex login status and Codex CLI availability, then retry.',
        }[metadata.errorCategory];
        return finish(new Error(`Codex generation failed (${metadata.errorCategory}; exit ${code ?? signal}). ${hint}`), code, signal);
      }
      finish(null, code, signal);
    });
    child.stdin.end(prompt, 'utf8');
  });
}

function createCodexProvider({ executable, model = process.env.SHORTS_CODEX_MODEL, timeoutMs = 300000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1800000) throw new Error('Codex timeoutMs must be an integer from 100 to 1800000.');
  if (model !== undefined && (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(model))) throw new Error('Invalid Codex model name.');
  return async function generate({ prompt, schema, directory }) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A nonempty generation prompt is required.');
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('A generation JSON schema is required.');
    if (typeof directory !== 'string' || !directory) throw new Error('A generation directory is required.');
    const dir = path.resolve(directory);
    fs.mkdirSync(dir, { recursive: true });
    const answerFile = path.join(dir, 'answer.json');
    const schemaFile = path.join(dir, 'schema.json');
    const promptFile = path.join(dir, 'prompt.txt');
    const metadataFile = path.join(dir, 'provider.json');
    // Never accept an answer left by a previous/crashed invocation.
    if ([answerFile, schemaFile, promptFile, metadataFile].some(file => fs.existsSync(file))) {
      throw new Error('Generation directory already contains provider artifacts. Use a new attempt directory.');
    }
    fs.writeFileSync(promptFile, prompt, { flag: 'wx' });
    fs.writeFileSync(schemaFile, JSON.stringify(schema, null, 2) + '\n', { flag: 'wx' });
    const started = Date.now();
    const metadata = { provider: 'codex-cli', model: model || 'cli-default', startedAt: new Date(started).toISOString(), status: 'running' };
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
    try {
      const [command, ...prefix] = executableCommand(executable);
      const args = [...prefix, '-a', 'never', 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--color', 'never', '--json', '--output-schema', schemaFile, '--output-last-message', answerFile,
        '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0'];
      for (const feature of ['shell_tool', 'apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'in_app_browser', 'skill_search', 'goals']) {
        args.push('--disable', feature);
      }
      if (model) args.push('--model', model);
      args.push('-');
      await invoke(command, args, { directory: dir, prompt, timeoutMs, metadata });
      if (!isFile(answerFile) || fs.statSync(answerFile).size === 0) throw new Error('Codex completed without an answer. No generated result was accepted.');
      if (fs.statSync(answerFile).size > maxAnswerBytes) throw new Error('Codex answer exceeded the generation size limit.');
      let answer;
      try { answer = JSON.parse(fs.readFileSync(answerFile, 'utf8').replace(/^\uFEFF/, '')); }
      catch { throw new Error('Codex answer was not valid JSON. Retry generation with the validation feedback.'); }
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('Codex answer must be a JSON object.');
      metadata.status = 'succeeded';
      return answer;
    } catch (error) {
      metadata.status = 'failed';
      metadata.errorCategory ||= 'response';
      // All public errors above are controlled summaries; diagnostic contains no raw model/CLI stderr.
      metadata.diagnostic = {
        permissions: 'The local Codex state or app-server could not initialize under the current filesystem permissions.',
        authentication: 'Codex authentication was rejected. Run codex login.',
        rate_limit: 'Codex usage or request limits prevented generation.',
        network: 'Codex could not complete its network connection.',
        configuration: 'Codex rejected the invocation configuration or selected model.',
        process: 'Codex exited before completing generation.',
        start: 'The Codex executable could not be started.',
        timeout: 'Codex did not finish before the configured timeout.',
        unexpected_tool: 'A tool action was observed during text-only generation.',
        output_limit: 'Codex output exceeded the configured size limit.',
        response: 'The Codex answer or local provider artifact could not be accepted.',
      }[metadata.errorCategory];
      throw error;
    } finally {
      metadata.durationMs = Date.now() - started;
      fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2) + '\n');
    }
  };
}

module.exports = { createCodexProvider };
