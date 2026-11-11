const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runProduction } = require('./production.cjs');
const { readStateFile } = require('./run-state.cjs');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const quiet = () => {};

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-production-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-production-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'planning'));
  const episodeFile = path.join(root, 'episode.json');
  const put = title => fs.writeFileSync(episodeFile, JSON.stringify({ title, narration: 'fixed speech' }));
  put('clear');
  fs.writeFileSync(path.join(root, 'planning/catalog.json'), JSON.stringify({ version: 1,
    series: { cs: { id: 'cs', contentReview: { mode: 'required', sources: [] } } },
    episodes: { 'cs-one': { seriesId: 'cs', planId: 'one', adapter: 'pipeline/story/adapter.cjs', episode: 'episode.json' } },
    plans: { cs: { one: {} } }, batches: {} }));
  const calls = [];
  let transportFailure = false;
  let held;
  const checker = async () => {
    calls.push('checker');
    if (transportFailure) throw Error('network unavailable');
    return { status: JSON.parse(fs.readFileSync(episodeFile)).title === 'broad' ? 'needs_review' : 'passed' };
  };
  const createStages = ({ contentChecker = checker } = {}) => {
    const input = JSON.parse(fs.readFileSync(episodeFile));
    return [
      { id: 'content', validationOnly: true, inputs: () => ({ title: input.title }), outputs: ['report.json'],
        async run({ dir }) {
          calls.push('content');
          const report = await contentChecker();
          const file = path.join(dir, 'report.json');
          fs.writeFileSync(file, JSON.stringify(report));
          if (report.status !== 'passed') throw Object.assign(new Error('Content validation needs_review'), { contentReportPath: file });
        } },
      ...['speech', 'prepare', 'visual', 'render', 'verify'].map(id => ({ id, ...(id === 'visual' ? { validationOnly: true } : {}),
        inputs: () => id === 'speech' ? { narration: input.narration } : id === 'prepare' ? { title: input.title } : { id },
        outputs: [id + '.txt'], async run({ dir }) { calls.push(id); fs.writeFileSync(path.join(dir, id + '.txt'), id); } })),
    ];
  };
  const workDir = path.join(root, 'runs/cs-one');
  const repairEngine = {
    getRepairHold: () => held,
    async repairProductionContent() {
      calls.push('repair'); put('clarified');
      return { status: 'applied', attempts: 1, reason: 'Added the missing condition.', reportPath: path.join(root, 'repair.json'),
        inputHash: sha(fs.readFileSync(episodeFile)), checker: async () => { calls.push('memo'); return { status: 'passed' }; } };
    },
  };
  const options = { root, episodeId: 'cs-one', workDir, createStages, contentChecker: checker, repairEngine, log: quiet };
  return { root, episodeFile, workDir, calls, put, options, repairEngine,
    hold: result => { held = result; }, failTransport: () => { transportFailure = true; } };
}

test('a checked title repair reloads stages, preserves speech and reuses everything on another run', async t => {
  const f = fixture(t);
  const first = await runProduction(f.options);
  f.put('broad'); f.calls.length = 0;
  const repaired = await runProduction(f.options);
  assert.deepEqual(f.calls, ['content', 'checker', 'repair', 'content', 'memo', 'prepare', 'visual', 'render', 'verify']);
  assert.deepEqual(repaired.stages.speech, first.stages.speech);
  assert.equal(repaired.status, 'ready_for_review');
  assert.equal(repaired.contentRepair.status, 'applied');
  const bytes = fs.readFileSync(path.join(f.workDir, 'state.json'));
  f.calls.length = 0;
  await runProduction(f.options);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(fs.readFileSync(path.join(f.workDir, 'state.json')), bytes);
});

test('an unresolved repair becomes needs_review and unchanged retry makes no checker or repair calls', async t => {
  const f = fixture(t);
  f.put('broad');
  const outcome = { status: 'needs_review', attempts: 2, reason: 'Insufficient evidence.', reportPath: path.join(f.root, 'repair.json') };
  f.repairEngine.repairProductionContent = async () => { f.calls.push('repair'); f.hold(outcome); return outcome; };
  await assert.rejects(runProduction(f.options), error => error.code === 'CONTENT_REVIEW_REQUIRED');
  assert.deepEqual(f.calls, ['content', 'checker', 'repair']);
  assert.equal(readStateFile(f.workDir).status, 'needs_review');
  const bytes = fs.readFileSync(path.join(f.workDir, 'state.json'));
  f.calls.length = 0;
  await assert.rejects(runProduction(f.options), /Insufficient evidence/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(fs.readFileSync(path.join(f.workDir, 'state.json')), bytes);
});

test('model transport failures do not enter text repair', async t => {
  const f = fixture(t); f.failTransport();
  await assert.rejects(runProduction(f.options), /network unavailable/);
  assert.deepEqual(f.calls, ['content', 'checker']);
  assert.equal(readStateFile(f.workDir).status, 'failed');
});

test('an interrupted candidate resumes before another original content judgment', async t => {
  const f = fixture(t); f.put('broad');
  const repair = f.repairEngine.repairProductionContent;
  f.repairEngine.repairProductionContent = async () => { throw Error('candidate check connection lost'); };
  await assert.rejects(runProduction(f.options), /connection lost/);
  f.repairEngine.getRepairResume = () => true;
  f.repairEngine.repairProductionContent = repair;
  f.calls.length = 0;
  const result = await runProduction(f.options);
  assert.deepEqual(f.calls, ['repair', 'content', 'memo', 'speech', 'prepare', 'visual', 'render', 'verify']);
  assert.equal(result.status, 'ready_for_review');
});

test('publication recovery finishes before loading stages even if an ordinary checker would pass', async t => {
  const f = fixture(t);
  const first = await runProduction(f.options);
  f.put('broad');
  f.repairEngine.repairProductionContent = async () => { f.put('clarified'); throw Error('catalog publication interrupted'); };
  await assert.rejects(runProduction(f.options), /publication interrupted/);
  let published = false;
  f.repairEngine.getRepairResume = () => true;
  f.repairEngine.repairProductionContent = async () => {
    f.calls.push('recover-publication'); published = true;
    return { status: 'applied', attempts: 1, reason: 'Recovered the catalog title.',
      inputHash: sha(fs.readFileSync(f.episodeFile)), checker: async () => { f.calls.push('memo'); return { status: 'passed' }; } };
  };
  const createStages = f.options.createStages;
  f.calls.length = 0;
  const result = await runProduction({ ...f.options, createStages: options => {
    assert.equal(published, true); return createStages(options);
  } });
  assert.deepEqual(f.calls, ['recover-publication', 'content', 'memo', 'prepare', 'visual', 'render', 'verify']);
  assert.deepEqual(result.stages.speech, first.stages.speech);
});

test('production lock blocks a competing wrapper during candidate repair', { timeout: 15000 }, async t => {
  const f = fixture(t); f.put('broad');
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const realRepair = f.repairEngine.repairProductionContent;
  f.repairEngine.repairProductionContent = async (...args) => { entered.resolve(); await release.promise; return realRepair(...args); };
  const running = runProduction(f.options);
  try {
    await Promise.race([entered.promise, running]);
    await assert.rejects(runProduction(f.options), /already running/);
  } finally { release.resolve(); await running; }
});

test('input edits after repair publication cannot be overwritten or reported as a successful repair', async t => {
  const f = fixture(t); f.put('broad');
  f.repairEngine.repairProductionContent = async () => {
    f.put('clarified'); const inputHash = sha(fs.readFileSync(f.episodeFile));
    f.put('changed externally');
    return { status: 'applied', attempts: 1, reason: 'condition', inputHash };
  };
  await assert.rejects(runProduction(f.options), /input changed/);
  assert.equal(JSON.parse(fs.readFileSync(f.episodeFile)).title, 'changed externally');
  assert.equal(readStateFile(f.workDir).contentRepair, undefined);
});
