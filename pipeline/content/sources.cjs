const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const readable = value => typeof value === 'string' && value.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);

function normalizeContentReview(value) {
  if (value === undefined) return { mode: 'off', sources: [] };
  if (!object(value) || Object.keys(value).some(key => !['mode', 'sources'].includes(key)) ||
      !['required', 'off'].includes(value.mode) || !Array.isArray(value.sources) || value.sources.length > 20) {
    throw new Error('contentReview requires mode required/off and at most 20 sources.');
  }
  const seen = new Set();
  const sources = value.sources.map(source => {
    if (!object(source) || Object.keys(source).some(key => !['id', 'title', 'path', 'url'].includes(key)) ||
        typeof source.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(source.id) || seen.has(source.id)) {
      throw new Error('Content source IDs must be unique, safe identifiers.');
    }
    seen.add(source.id);
    if (!readable(source.title) || source.title.length > 250 || !readable(source.path) ||
        path.isAbsolute(source.path) || path.win32.isAbsolute(source.path) || source.path.includes(':') ||
        source.path.split(/[\\/]/).some(segment => segment === '..' || !segment) ||
        !/\.(md|txt)$/i.test(source.path)) throw new Error('Content sources require a title and repository-relative .md/.txt file.');
    let url;
    if (source.url !== undefined) {
      if (!readable(source.url) || source.url.length > 2000) throw new Error('Invalid content source URL.');
      let parsed;
      try { parsed = new URL(source.url); } catch { throw new Error('Invalid content source URL.'); }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Content source URL must be HTTP(S) without credentials.');
      url = parsed.href;
    }
    return { id: source.id, title: source.title.trim(), path: source.path.replaceAll('\\', '/'), ...(url ? { url } : {}) };
  });
  if (value.mode === 'off' && sources.length) throw new Error('Disabled content review cannot retain ignored sources.');
  return { mode: value.mode, sources };
}

function inside(root, file) {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Source is outside the repository.');
  const actual = path.relative(fs.realpathSync(root), fs.realpathSync(absolute));
  if (!actual || actual === '..' || actual.startsWith('..' + path.sep) || path.isAbsolute(actual)) throw new Error('Source resolves outside the repository.');
  return absolute;
}

// Only explicitly registered local evidence is read. URLs record attribution; they are not fetched implicitly.
function readEvidenceBundle(root, series) {
  const policy = normalizeContentReview(series.contentReview);
  const sources = [];
  const issues = [];
  const manifest = [];
  let total = 0;
  if (policy.mode === 'required' && !policy.sources.length) issues.push({ sourceId: null, reason: 'No evidence sources are configured.' });
  for (const source of policy.sources) {
    try {
      const file = inside(root, source.path);
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error('Source must be a text file within 128 KiB.');
      const bytes = fs.readFileSync(file);
      total += bytes.length;
      if (bytes.length > MAX_SOURCE_BYTES || total > MAX_BUNDLE_BYTES) throw new Error('Evidence bundle exceeds its size limit (512 KiB total).');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
      if (!readable(content)) throw new Error('Source must contain readable, nonempty UTF-8 text.');
      const sha256 = hash(bytes);
      sources.push({ ...source, content, sha256, bytes: bytes.length });
      manifest.push({ ...source, sha256 });
    } catch (error) {
      // A missing/unreadable source is visible and blocks required review. Never silently omit it.
      const reason = ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'Source file is missing.' :
        ['EACCES', 'EPERM'].includes(error.code) ? 'Source file cannot be read.' : error.message;
      issues.push({ sourceId: source.id, reason });
      manifest.push({ ...source, error: reason });
    }
  }
  return { mode: policy.mode, status: policy.mode === 'off' ? 'disabled' : issues.length ? 'needs_review' : 'ready',
    sourceHash: hash(JSON.stringify({ mode: policy.mode, manifest, issues })), sources, issues };
}

module.exports = { normalizeContentReview, readEvidenceBundle, MAX_SOURCE_BYTES, MAX_BUNDLE_BYTES };
