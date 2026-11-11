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
        const voice = fs.readFileSync(path.join(previous.speech, 'narration.wav'), 'utf8');
        fs.writeFileSync(path.join(dir, 'index.html'), input.title + ' ' + voice);
      } },
    { id: 'render', inputs: () => ({ fps: 30 }), outputs: ['video.mp4'],
      async run({ dir, previous }) { fs.copyFileSync(path.join(previous.prepare, 'index.html'), path.join(dir, 'video.mp4')); } },
    { id: 'verify', inputs: () => ({ valid: true }), outputs: ['report.json'],
      async run({ dir }) { fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ checked: true })); } }
  ];
};
`;

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-planning-cli-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-planning-cli-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pipeline = path.join(root, 'pipeline');
  fs.mkdirSync(pipeline);
  for (const name of fs.readdirSync(__dirname)) {
    if (name.endsWith('.cjs') && !name.endsWith('.test.cjs')) {
      fs.copyFileSync(path.join(__dirname, name), path.join(pipeline, name));
    }
  }
  // Registration now performs local configuration/evidence checks. Copy their
  // dependencies; this custom adapter fixture must not invoke voice synthesis.
  for (const name of ['series', 'story', 'visual', 'content']) {
    fs.cpSync(path.join(__dirname, name), path.join(pipeline, name), { recursive: true,
      filter: filename => fs.statSync(filename).isDirectory() || (filename.endsWith('.cjs') && !filename.endsWith('.test.cjs')) });
  }
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  fs.writeFileSync(path.join(root, 'adapter.cjs'), adapterSource);
  write('pipeline/episodes.json', { legacy: { adapter: 'adapter.cjs', episode: 'legacy.json' } });
  write('pipeline/batches.json', { 'legacy-batch': ['legacy'] });
  write('legacy.json', { title: '기존 회차', text: '기존 낭독문' });
  write('series.json', { id: 'cs', name: 'CS 개념', audience: '입문자', topics: ['자료구조'],
    defaultDurationSeconds: 30, tone: '짧고 명확하게', adapter: 'adapter.cjs' });
  const catalog = () => JSON.parse(fs.readFileSync(path.join(root, 'planning/catalog.json'), 'utf8'));
  const { inspectReview } = require(path.join(pipeline, 'review.cjs'));
  const { createStages } = require(path.join(root, 'adapter.cjs'));
  return {
    root, write, catalog,
    command(args, expectedCode = 0) {
      const result = spawnSync(process.execPath, [path.join(pipeline, 'cli.cjs'), ...args], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, expectedCode, result.stdout + result.stderr);
      return result.stdout + result.stderr;
    },
    review(id) {
      return inspectReview(path.join(root, 'runs', id), createStages({ episodeFile: path.join(root, catalog().episodes[id].episode) }));
    },
  };
}

function plan(id, extra = {}) {
  return { id, title: id + ' 개념', topicKey: id, objective: id + '의 동작 설명',
    angle: '그림 한 가지로 설명', references: ['https://example.com/' + id], ...extra };
}

test('planning CLI turns selected plans into reusable production inputs and a reviewable batch', async t => {
  const job = fixture(t);
  job.command(['series', 'list']);
  assert.equal(fs.existsSync(path.join(job.root, 'planning')), false);
  job.command(['series', 'register', 'series.json']);
  assert.match(job.command(['series', 'list']), /cs/);
  job.write('arrays.json', { text: '배열 낭독문' });
  job.write('stack.json', { title: '명시한 제목', text: '스택 낭독문', durationSeconds: 15 });
  job.write('queue.json', { text: '큐 낭독문' });
  job.write('plans.json', [
    plan('arrays', { input: 'arrays.json', scheduledFor: '2026-11-10T10:00:00+09:00' }),
    plan('stack', { input: 'stack.json' }),
    plan('draft'),
    plan('queue', { input: 'queue.json' }),
  ]);
  job.command(['plan', 'add', 'cs', 'plans.json']);
  const list = job.command(['plan', 'list', 'cs']);
  assert.match(list, /arrays/);
  assert.match(list, /draft/);
  job.command(['plan', 'check', 'cs']);
  job.command(['plan', 'batch', 'cs', 'first-two', '--plans', 'arrays,stack']);
  let catalog = job.catalog();
  assert.deepEqual(catalog.batches['first-two'], ['cs-arrays', 'cs-stack']);
  const arrayPath = path.join(job.root, catalog.episodes['cs-arrays'].episode);
  const snapshot = JSON.parse(fs.readFileSync(arrayPath, 'utf8'));
  assert.equal(snapshot.title, 'arrays 개념');
  assert.equal(snapshot.audience, '입문자');
  assert.equal(snapshot.tone, '짧고 명확하게');
  assert.equal(snapshot.durationSeconds, 30);
  const stack = JSON.parse(fs.readFileSync(path.join(job.root, catalog.episodes['cs-stack'].episode), 'utf8'));
  assert.equal(stack.title, '명시한 제목');
  assert.equal(stack.durationSeconds, 15);
  assert.equal(catalog.episodes['cs-queue'], undefined);

  job.write('arrays.json', { text: '원본 기획의 후속 수정' });
  job.command(['plan', 'batch', 'cs', 'first-two', '--plans', 'arrays,stack']);
  assert.deepEqual(JSON.parse(fs.readFileSync(arrayPath, 'utf8')), snapshot);
  job.command(['batch', 'run', 'first-two', '--jobs', '2']);
  const review = await job.review('cs-arrays');
  assert.equal(review.status, 'ready_for_review');
  const reviewList = job.command(['review', 'list', 'first-two']);
  assert.ok(reviewList.includes(review.revision));
  assert.ok(reviewList.includes(review.videoPath));
  job.command(['review', 'approve', 'cs-arrays', '--revision', review.revision]);
  assert.match(job.command(['batch', 'status', 'first-two']), /cs-arrays[^\r\n]*approved/);

  job.command(['plan', 'batch', 'cs', 'next-one', '--count', '1']);
  catalog = job.catalog();
  assert.deepEqual(catalog.batches['next-one'], ['cs-queue']);
  assert.equal(catalog.episodes['cs-draft'], undefined);
  job.write('draft-input.json', { text: '구체화한 초안 낭독문' });
  job.write('draft-update.json', [plan('draft', { input: 'draft-input.json' })]);
  job.command(['plan', 'update', 'cs', 'draft-update.json']);
  job.command(['plan', 'batch', 'cs', 'last-draft', '--count', '1']);
  catalog = job.catalog();
  assert.deepEqual(catalog.batches['last-draft'], ['cs-draft']);
  job.write('draft-update.json', [plan('draft', { title: '제작 후 변경 시도', input: 'draft-input.json' })]);
  job.command(['plan', 'update', 'cs', 'draft-update.json'], 1);
  assert.deepEqual(job.catalog(), catalog);
  job.command(['batch', 'run', 'legacy-batch']);
  assert.match(job.command(['status', 'legacy']), /ready_for_review/);
});

test('CLI duplicate checks and invalid selections leave generated registries unchanged', t => {
  const job = fixture(t);
  job.command(['series', 'register', 'series.json']);
  job.write('topic.json', { title: '주제', text: '낭독문' });
  job.write('plans.json', [
    plan('new', { topicKey: 'Binary-Search', input: 'topic.json' }),
    plan('history', { topicKey: ' binary-search ', publishedAt: '2026-10-01T10:00:00+09:00' }),
  ]);
  job.command(['plan', 'add', 'cs', 'plans.json']);
  const duplicates = job.command(['plan', 'check', 'cs'], 1);
  assert.match(duplicates, /new/);
  assert.match(duplicates, /history/);
  const before = job.catalog();
  job.command(['plan', 'batch', 'cs', 'blocked', '--plans', 'new'], 1);
  job.command(['plan', 'batch', 'cs', 'too-many', '--count', '2'], 1);
  job.command(['plan', 'batch', 'cs', 'ambiguous', '--count', '1', '--count', '2'], 1);
  job.command(['plan', 'batch', 'cs', 'ambiguous', '--plans', 'new', '--count', '1'], 1);
  job.command(['plan', 'batch', 'cs', 'empty', '--plans', ''], 1);
  assert.deepEqual(job.catalog(), before);
  assert.deepEqual(before.episodes, {});
  assert.deepEqual(before.batches, {});
});

test('CLI keeps the same local episode number independent across two series', t => {
  const job = fixture(t);
  job.command(['series', 'register', 'series.json']);
  job.write('math-series.json', { id: 'math', name: '수학 개념', audience: '입문자', topics: ['비율'],
    defaultDurationSeconds: 15, tone: '짧고 명확하게', adapter: 'adapter.cjs' });
  job.command(['series', 'register', 'math-series.json']);
  job.write('cs-input.json', { title: 'CS 첫 회차', text: '자료구조 낭독문' });
  job.write('math-input.json', { title: '수학 첫 회차', text: '비율 낭독문' });
  job.write('cs-plans.json', [plan('ep01', { input: 'cs-input.json' })]);
  job.write('math-plans.json', [plan('ep01', { input: 'math-input.json' })]);
  job.command(['plan', 'add', 'cs', 'cs-plans.json']);
  job.command(['plan', 'add', 'math', 'math-plans.json']);
  job.command(['plan', 'check', 'cs']);
  job.command(['plan', 'check', 'math']);
  job.command(['plan', 'batch', 'cs', 'cs-first', '--count', '1']);
  job.command(['plan', 'batch', 'math', 'math-first', '--count', '1']);
  const catalog = job.catalog();
  assert.deepEqual(catalog.batches['cs-first'], ['cs-ep01']);
  assert.deepEqual(catalog.batches['math-first'], ['math-ep01']);
  const cs = JSON.parse(fs.readFileSync(path.join(job.root, catalog.episodes['cs-ep01'].episode), 'utf8'));
  const math = JSON.parse(fs.readFileSync(path.join(job.root, catalog.episodes['math-ep01'].episode), 'utf8'));
  assert.equal(cs.text, '자료구조 낭독문');
  assert.equal(cs.durationSeconds, 30);
  assert.equal(math.text, '비율 낭독문');
  assert.equal(math.durationSeconds, 15);
});
