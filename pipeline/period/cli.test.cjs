const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// This fixture tests CLI orchestration and artifact identity, not real MP4 encoding.
const adapterSource = `
const fs = require('node:fs');
const path = require('node:path');
exports.createStages = ({ root, episodeFile }) => {
  const input = JSON.parse(fs.readFileSync(episodeFile, 'utf8'));
  const record = stage => fs.appendFileSync(path.join(root, 'executions.log'), input.text + ':' + stage + '\\n');
  return [
    { id: 'speech', inputs: () => ({ text: input.text }), outputs: ['narration.wav'],
      async run({ dir }) { record('speech'); fs.writeFileSync(path.join(dir, 'narration.wav'), input.text); } },
    { id: 'prepare', inputs: () => ({ title: input.title }), outputs: ['index.html'],
      async run({ dir, previous }) { record('prepare'); fs.writeFileSync(path.join(dir, 'index.html'),
        input.title + fs.readFileSync(path.join(previous.speech, 'narration.wav'), 'utf8')); } },
    { id: 'render', inputs: () => ({ fps: 30 }), outputs: ['video.mp4'],
      async run({ dir, previous }) {
        record('render');
        if (fs.existsSync(path.join(root, 'fail-' + input.text))) throw new Error('Controlled render failure ' + input.text);
        fs.copyFileSync(path.join(previous.prepare, 'index.html'), path.join(dir, 'video.mp4'));
      } },
    { id: 'verify', inputs: () => ({ valid: true }), outputs: ['report.json'],
      async run({ dir }) { record('verify'); fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ checked: true })); } }
  ];
};
`;

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-period-cli-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-period-cli-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.resolve(__dirname, '..');
  fs.cpSync(source, path.join(root, 'pipeline'), { recursive: true,
    filter: filename => fs.statSync(filename).isDirectory() || (filename.endsWith('.cjs') && !filename.endsWith('.test.cjs')) });
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  fs.writeFileSync(path.join(root, 'adapter.cjs'), adapterSource);
  // A manual period must never load the generation provider in this fixture.
  fs.writeFileSync(path.join(root, 'pipeline/generation/provider.cjs'), 'throw new Error("Unexpected model provider load");\n');
  write('pipeline/episodes.json', {});
  write('pipeline/batches.json', {});
  write('series.json', { id: 'cs', name: 'CS period fixture', audience: '입문자', topics: ['자료구조'],
    defaultDurationSeconds: 30, tone: '짧고 명확하게', adapter: 'adapter.cjs' });
  const planIds = ['ep01', 'ep02', 'ep03', 'ep04', 'ep05'];
  for (const id of planIds) write(id + '.json', { title: id + ' 제목', text: id });
  write('plans.json', planIds.map(id => ({ id, title: id + ' 제목', topicKey: id, objective: id + ' 개념 전달',
    angle: '간단한 예시', references: [], input: id + '.json' })));
  const spec = { id: 'five-days', seriesId: 'cs', startDate: '2026-11-16', days: 5,
    timezone: 'Asia/Seoul', times: ['19:00'], batchSize: 2, planIds };
  write('period.json', spec);
  const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  return { root, write, read, spec,
    command(args, code = 0) {
      const result = spawnSync(process.execPath, [path.join(root, 'pipeline/cli.cjs'), ...args], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, code, result.stdout + result.stderr);
      return result.stdout + result.stderr;
    },
  };
}

test('period CLI creates five daily slots, isolates failure, and retries only the failed episode', t => {
  const job = fixture(t);
  job.command(['series', 'register', 'series.json']);
  job.command(['plan', 'add', 'cs', 'plans.json']);
  assert.match(job.command(['period', 'create', 'period.json']), /5 episodes, 3 batches/);
  const initialCatalog = job.read('planning/catalog.json');
  assert.match(job.command(['period', 'create', 'period.json']), /Existing period/);
  assert.deepEqual(job.read('planning/catalog.json'), initialCatalog);
  assert.match(job.command(['period', 'list']), /five-days.*Asia\/Seoul/);
  const pending = job.command(['period', 'status', 'five-days']);
  assert.match(pending, /2026-11-16 19:00/);
  assert.match(pending, /2026-11-20 19:00/);
  assert.equal(fs.existsSync(path.join(job.root, 'executions.log')), false);
  assert.equal(new Set(initialCatalog.periods['five-days'].slots.map(slot => slot.scheduledFor)).size, 5);

  fs.writeFileSync(path.join(job.root, 'fail-ep03'), 'intentional test failure');
  const failedOutput = job.command(['period', 'run', 'five-days', '--jobs', '2'], 1);
  assert.match(failedOutput, /Controlled render failure ep03/);
  const state = id => job.read('runs/cs-' + id + '/state.json');
  const completed = ['ep01', 'ep02', 'ep04', 'ep05'];
  const before = new Map(completed.map(id => [id, state(id)]));
  for (const id of completed) assert.equal(state(id).status, 'ready_for_review');
  assert.equal(state('ep03').status, 'failed');
  const failedSpeech = state('ep03').stages.speech.dir;
  const failedPrepare = state('ep03').stages.prepare.dir;
  const failedCatalog = job.read('planning/catalog.json');
  const episodeIds = Object.keys(failedCatalog.episodes);
  assert.equal(episodeIds.length, 5);
  const attemptsBefore = fs.readFileSync(path.join(job.root, 'executions.log'), 'utf8');
  fs.unlinkSync(path.join(job.root, 'fail-ep03'));

  const retryOutput = job.command(['period', 'retry-failed', 'five-days', '--jobs', '2']);
  assert.match(retryOutput, /ready_for_review/);
  assert.match(retryOutput, /MP4:/);
  assert.match(retryOutput, /Revision:/);
  assert.equal(state('ep03').status, 'ready_for_review');
  assert.equal(state('ep03').stages.speech.dir, failedSpeech);
  assert.equal(state('ep03').stages.prepare.dir, failedPrepare);
  for (const id of completed) assert.deepEqual(state(id), before.get(id));
  const newTrace = fs.readFileSync(path.join(job.root, 'executions.log'), 'utf8').slice(attemptsBefore.length);
  assert.equal(newTrace, 'ep03:render\nep03:verify\n');
  assert.deepEqual(Object.keys(job.read('planning/catalog.json').episodes), episodeIds);
  assert.deepEqual(job.read('planning/catalog.json').periods['five-days'].slots, failedCatalog.periods['five-days'].slots);

  const allBefore = fs.readFileSync(path.join(job.root, 'executions.log'), 'utf8');
  job.command(['period', 'resume', 'five-days', '--jobs', '2']);
  job.command(['period', 'retry-failed', 'five-days']);
  assert.equal(fs.readFileSync(path.join(job.root, 'executions.log'), 'utf8'), allBefore);
  const catalogBytes = fs.readFileSync(path.join(job.root, 'planning/catalog.json'));
  job.command(['period', 'status', 'five-days']);
  assert.deepEqual(fs.readFileSync(path.join(job.root, 'planning/catalog.json')), catalogBytes);
});

test('period CLI validates flags and supports manual plan-only without model or media work', t => {
  const job = fixture(t);
  job.command(['series', 'register', 'series.json']);
  job.command(['plan', 'add', 'cs', 'plans.json']);
  job.command(['period', 'create', 'period.json']);
  for (const flags of [
    ['--jobs', '0'], ['--jobs', '9'], ['--attempts', '6'], ['--model'],
    ['--plan-only', '--plan-only'], ['--jobs', '2', '--jobs', '3'], ['--plan-only', '--jobs', '2'], ['--unknown'],
  ]) job.command(['period', 'run', 'five-days', ...flags], 1);
  assert.equal(fs.existsSync(path.join(job.root, 'executions.log')), false);
  job.command(['period', 'run', 'five-days', '--plan-only']);
  assert.equal(Object.keys(job.read('planning/catalog.json').episodes).length, 5);
  assert.equal(fs.existsSync(path.join(job.root, 'executions.log')), false);
  job.command(['period', 'resume', 'five-days']);
  assert.ok(fs.existsSync(path.join(job.root, 'executions.log')));
  job.command(['period', 'status', 'five-days', '--jobs', '2'], 1);
  job.command(['period', 'list', 'unexpected'], 1);
});
