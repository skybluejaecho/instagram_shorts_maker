const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const adapterSource = `
const fs = require('node:fs');
const path = require('node:path');
exports.createStages = ({ episodeFile }) => {
  const input = JSON.parse(fs.readFileSync(episodeFile, 'utf8'));
  return [
    { id: 'speech', inputs: () => ({ text: input.text }), outputs: ['narration.wav'],
      async run({ dir }) { fs.writeFileSync(path.join(dir, 'narration.wav'), input.text); } },
    { id: 'prepare', inputs: () => ({ title: input.title }), outputs: ['index.html'],
      async run({ dir, previous }) {
        const speech = fs.readFileSync(path.join(previous.speech, 'narration.wav'), 'utf8');
        fs.writeFileSync(path.join(dir, 'index.html'), input.title + ' ' + speech);
      } },
    { id: 'render', inputs: () => ({ fps: 30 }), outputs: ['video.mp4'],
      async run({ dir, previous }) { fs.copyFileSync(path.join(previous.prepare, 'index.html'), path.join(dir, 'video.mp4')); } },
    { id: 'verify', inputs: () => ({ required: true }), outputs: ['report.json'],
      async run({ dir }) { fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ checked: true })); } }
  ];
};
`;

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-review-cli-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-review-cli-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pipeline = path.join(root, 'pipeline');
  fs.mkdirSync(pipeline);
  for (const name of fs.readdirSync(__dirname)) {
    if (name.endsWith('.cjs') && !name.endsWith('.test.cjs')) {
      fs.copyFileSync(path.join(__dirname, name), path.join(pipeline, name));
    }
  }
  fs.writeFileSync(path.join(root, 'adapter.cjs'), adapterSource);
  const entries = {};
  for (const id of ['one', 'two']) {
    entries[id] = { adapter: 'adapter.cjs', episode: id + '.json' };
    fs.writeFileSync(path.join(root, id + '.json'), JSON.stringify({ text: id + ' voice', title: id + ' title' }));
  }
  fs.writeFileSync(path.join(pipeline, 'episodes.json'), JSON.stringify(entries));
  fs.writeFileSync(path.join(pipeline, 'batches.json'), JSON.stringify({ pair: ['one', 'two'] }));
  const { inspectReview } = require(path.join(pipeline, 'review.cjs'));
  const { createStages } = require(path.join(root, 'adapter.cjs'));
  return {
    root,
    command(args, expectedCode = 0) {
      const result = spawnSync(process.execPath, [path.join(pipeline, 'cli.cjs'), ...args], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, expectedCode, result.stdout + result.stderr);
      return result.stdout + result.stderr;
    },
    review(id) {
      return inspectReview(path.join(root, 'runs', id), createStages({ episodeFile: path.join(root, id + '.json') }));
    },
    state(id) {
      return JSON.parse(fs.readFileSync(path.join(root, 'runs', id, 'state.json'), 'utf8'));
    },
  };
}

test('CLI preserves approval of one episode while a requested visual revision rebuilds its sibling', async t => {
  const job = fixture(t);
  const initial = job.command(['review', 'list', 'pair']);
  assert.match(initial, /one/);
  assert.match(initial, /two/);
  assert.equal(fs.existsSync(path.join(job.root, 'runs')), false);

  job.command(['batch', 'run', 'pair']);
  const first = await job.review('one');
  const second = await job.review('two');
  const before = job.state('two');
  const list = job.command(['review', 'list', 'pair']);
  assert.ok(list.includes(first.revision));
  assert.ok(list.includes(second.videoPath));
  job.command(['review', 'approve', 'one', '--revision', first.revision]);
  const target = '마지막 장면';
  const note = '전환 시간을 0.8초로 늘려줘';
  job.command(['review', 'request-changes', 'two', '--revision', second.revision, '--target', target, '--note', note]);
  const status = job.command(['batch', 'status', 'pair']);
  assert.match(status, /one[^\r\n]*approved/);
  assert.match(status, /two[^\r\n]*changes_requested/);
  assert.ok(job.command(['status', 'two']).includes(note));

  job.command(['run', 'two']);
  assert.equal((await job.review('two')).status, 'changes_requested');
  const source = path.join(job.root, 'two.json');
  const input = JSON.parse(fs.readFileSync(source, 'utf8'));
  input.title = 'new visual';
  fs.writeFileSync(source, JSON.stringify(input));
  assert.match(job.command(['status', 'two']), /needs_rebuild/);
  job.command(['review', 'approve', 'two', '--revision', second.revision], 1);
  const output = job.command(['run', 'two']);
  assert.match(output, /\[reuse\] speech/);
  assert.equal(job.state('two').stages.speech.dir, before.stages.speech.dir);

  const revised = await job.review('two');
  assert.equal(revised.status, 'ready_for_review');
  assert.notEqual(revised.revision, second.revision);
  assert.equal(revised.latestRequest.note, note);
  assert.equal(revised.latestRequest.target, target);
  job.command(['review', 'approve', 'two', '--revision', second.revision], 1);
  assert.equal((await job.review('two')).status, 'ready_for_review');
  assert.equal((await job.review('one')).status, 'approved');
  assert.equal((await job.review('one')).revision, first.revision);
});

test('CLI rejects incomplete or ambiguous decisions without recording a review', async t => {
  const job = fixture(t);
  job.command(['run', 'one']);
  const review = await job.review('one');
  const valid = ['review', 'request-changes', 'one', '--revision', review.revision];
  job.command(['review', 'approve', 'one'], 1);
  job.command(['review', 'approve', 'one', '--revision', review.revision, '--revision', review.revision], 1);
  job.command([...valid, '--note', 'change it'], 1);
  job.command([...valid, '--target', 'ending'], 1);
  job.command([...valid, '--target', 'ending', '--note', '   '], 1);
  assert.equal((await job.review('one')).history.length, 0);
});
