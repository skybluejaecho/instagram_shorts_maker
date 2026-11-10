const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeContentReview, readEvidenceBundle, MAX_SOURCE_BYTES } = require('./sources.cjs');

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-content-sources-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    assert.ok(path.basename(root).startsWith('shorts-content-sources-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'source.md'), '스택은 후입선출이다.');
  const series = { contentReview: { mode: 'required', sources: [{ id: 'stack', title: 'Stack note', path: 'source.md', url: 'https://example.com/stack' }] } };
  return { root, series };
}

test('evidence snapshots bind actual bytes, metadata and source order without fetching URLs', t => {
  const { root, series } = fixture(t);
  const first = readEvidenceBundle(root, series);
  assert.equal(first.status, 'ready');
  assert.equal(first.sources[0].content, '스택은 후입선출이다.');
  assert.deepEqual(first, readEvidenceBundle(root, series));
  fs.writeFileSync(path.join(root, 'source.md'), '\uFEFF스택은 후입선출이다.\r\n큐는 선입선출이다.\r\n');
  const windowsText = readEvidenceBundle(root, series);
  assert.equal(windowsText.status, 'ready');
  assert.equal(windowsText.sources[0].content, '스택은 후입선출이다.\r\n큐는 선입선출이다.\r\n');
  fs.writeFileSync(path.join(root, 'source.md'), '스택은 나중에 넣은 값을 먼저 꺼낸다.');
  const second = readEvidenceBundle(root, series);
  assert.notEqual(second.sourceHash, first.sourceHash);
  assert.notEqual(second.sources[0].sha256, first.sources[0].sha256);
  series.contentReview.sources[0].url = 'https://example.com/revised';
  assert.notEqual(readEvidenceBundle(root, series).sourceHash, second.sourceHash);
});

test('legacy series are explicitly disabled; required missing sources hold rather than silently skip', t => {
  const { root, series } = fixture(t);
  assert.equal(readEvidenceBundle(root, {}).status, 'disabled');
  assert.equal(readEvidenceBundle(root, { contentReview: { mode: 'required', sources: [] } }).status, 'needs_review');
  series.contentReview.sources.push({ id: 'missing', title: 'Missing', path: 'missing.txt' });
  const result = readEvidenceBundle(root, series);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.sources.length, 1);
  assert.equal(result.issues[0].sourceId, 'missing');
});

test('unsafe paths, duplicate IDs, unsupported metadata and credential URLs are rejected', () => {
  const source = { id: 'one', title: 'One', path: 'source.md' };
  for (const file of ['../escape.md', '/absolute.md', 'C:\\secret.md', 'a/../b.md', 'file.txt:stream', 'script.cjs']) {
    assert.throws(() => normalizeContentReview({ mode: 'required', sources: [{ ...source, path: file }] }));
  }
  assert.throws(() => normalizeContentReview({ mode: 'required', sources: [source, source] }));
  assert.throws(() => normalizeContentReview({ mode: 'required', sources: [{ ...source, url: 'https://user:pass@example.com' }] }));
  assert.throws(() => normalizeContentReview({ mode: 'required', sources: [{ ...source, content: 'unread content' }] }));
  assert.throws(() => normalizeContentReview({ mode: 'off', sources: [source] }));
});

test('empty, invalid UTF-8 and oversized sources hold with a visible reason', t => {
  const { root, series } = fixture(t);
  for (const bytes of [Buffer.from('  '), Buffer.from([0xff, 0xfe]), Buffer.alloc(MAX_SOURCE_BYTES + 1, 65)]) {
    fs.writeFileSync(path.join(root, 'source.md'), bytes);
    const result = readEvidenceBundle(root, series);
    assert.equal(result.status, 'needs_review');
    assert.equal(result.sources.length, 0);
    assert.ok(result.issues[0].reason);
  }
});

test('a directory junction outside the repository cannot become evidence', t => {
  const { root, series } = fixture(t);
  fs.symlinkSync(path.dirname(root), path.join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  series.contentReview.sources[0].path = 'outside/' + path.basename(root) + '/source.md';
  // This path resolves back inside, so use a second sibling as the actual escape target.
  const sibling = fs.mkdtempSync(path.join(path.dirname(root), 'shorts-content-external-'));
  t.after(() => { assert.equal(path.dirname(sibling), path.dirname(root)); fs.rmSync(sibling, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(sibling, 'external.md'), 'external');
  series.contentReview.sources[0].path = 'outside/' + path.basename(sibling) + '/external.md';
  const result = readEvidenceBundle(root, series);
  assert.equal(result.status, 'needs_review');
  assert.match(result.issues[0].reason, /outside/);
});
