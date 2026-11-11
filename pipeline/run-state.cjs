const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function readStateFile(workDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(workDir, 'state.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function saveState(workDir, state) {
  const temporary = path.join(workDir, `state-${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(temporary, path.join(workDir, 'state.json'));
}

function lockEndpoint(workDir) {
  let canonical = fs.realpathSync(workDir);
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const name = 'shorts-' + createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  if (process.platform === 'win32') return '\\\\.\\pipe\\' + name;
  if (process.platform === 'linux') return '\0' + name;
  return path.join(os.tmpdir(), name + '.sock');
}

async function lockWorkDir(workDir, kind) {
  // The OS releases the endpoint when the writer exits, including after a crash.
  const server = net.createServer(connection => connection.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(error.code === 'EADDRINUSE' ? new Error(`${kind} is already running: ${workDir}`) : error));
    server.listen(lockEndpoint(workDir), resolve);
  });
  return () => new Promise(resolve => server.close(resolve));
}

async function writerIsActive(workDir) {
  const endpoint = lockEndpoint(workDir);
  return new Promise((resolve, reject) => {
    const probe = net.createConnection(endpoint);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', error => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(false);
      else if (error.code === 'EPERM' || error.code === 'EACCES') resolve(undefined);
      else reject(error);
    });
  });
}

module.exports = { readStateFile, saveState, lockWorkDir, writerIsActive };
