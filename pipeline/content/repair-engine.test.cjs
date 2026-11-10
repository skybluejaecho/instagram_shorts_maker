const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { collectUnits, contentEntryHash, validateContentReport } = require('./checker.cjs');
const { readEvidenceBundle } = require('./sources.cjs');
const { validateSpec } = require('../story/spec.cjs');
const { repairProductionContent, getRepairHold, getRepairResume } = require('./repair-engine.cjs');

const quote = 'A full Python deque with maxlen discards an item from the opposite end when append or appendleft adds an item.';
const sourceText = quote + ' The insert operation raises IndexError if it would exceed maxlen.';
const initialUnresolved = ['plan.title', 'story.title', 'story.scenes[0].headline'];
const json = value => JSON.stringify(value, null, 2) + '\n';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : json(value));
}

function reportFor({ entries, bundle }, unresolved = []) {
  const unavailable = bundle.status !== 'ready';
  const units = collectUnits(entries).map(unit => {
    const uncertain = unavailable || unresolved.includes(unit.location);
    return { ...unit, verdict: uncertain ? 'uncertain' : 'supported', claim: unit.text,
      reason: uncertain ? '연산을 한정하는 조건을 확인해야 한다.' : '등록 자료에 나타난 append 조건을 확인했다.',
      evidence: uncertain ? [] : [{ sourceId: 'deque', quote }] };
  });
  const held = units.some(unit => unit.verdict === 'uncertain');
  const report = { version: 1, status: held ? 'needs_review' : 'passed', candidateCount: entries.length,
    entryHash: contentEntryHash(entries), sourceHash: bundle.sourceHash, units,
    consistency: entries.map(({ plan }) => ({ planId: plan.id, verdict: unavailable ? 'uncertain' : 'consistent', reason: '동일한 append 예시다.' })),
    correctionPlanIds: [], reviewPlanIds: held ? entries.map(entry => entry.plan.id) : [],
    sources: bundle.sources.map(({ id, title, path: sourcePath, url, sha256 }) => ({ id, title, path: sourcePath, ...(url ? { url } : {}), sha256 })) };
  validateContentReport(report, entries, bundle);
  return report;
}

function fixture(t, { missing = false, unresolved = initialUnresolved } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-content-repair-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('shorts-content-repair-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const episodeId = 'bounded';
  const inputFile = path.join(root, 'planning', 'inputs', 'bounded.json');
  const catalogFile = path.join(root, 'planning', 'catalog.json');
  const sourceFile = path.join(root, 'sources', 'deque.md');
  const rawStory = { version: 1, title: '가득 찬 deque에 넣으면?', durationSeconds: 30,
    audience: 'CS 입문자', tone: '차분하게', profile: { brand: 'CS 한 장', speech: { rate: 1 } },
    narration: [{ id: 'hook', text: '가득 찬  파이썬 데크에서 append를 하면 어떻게 될까요?' },
      { id: 'result', text: '반대쪽 값을 버리고 최대 길이를 유지합니다.  ' }],
    scenes: [{ id: 'question', type: 'question', from: 'hook', headline: '가득 찬 deque에\n더 넣으면?' },
      { id: 'result', type: 'conclusion', from: 'result', headline: '반대쪽을 버려요', body: '길이는 그대로  ' }] };
  const plan = { id: episodeId, seriesId: 'cs', title: rawStory.title, topicKey: 'deque.maxlen',
    objective: '가득 찬 maxlen deque의 append 동작을 이해한다.', angle: 'A와 B 뒤에 C를 추가한다.',
    knowledge: { core: '가득 찬 deque의 append는 반대쪽을 버린다.', example: 'AB에서 BC가 된다.' },
    references: ['https://docs.python.org/3/library/collections.html'], input: 'planning/inputs/bounded.json',
    scheduledFor: '2026-11-23T10:00:00.000Z' };
  const series = { id: 'cs', name: 'CS 한 장', audience: 'CS 입문자', topics: ['자료구조'], tone: '차분하게',
    adapter: 'pipeline/story/adapter.cjs', defaultDurationSeconds: 30,
    contentReview: { mode: 'required', sources: [{ id: 'deque', title: 'Python deque', path: 'sources/deque.md', url: plan.references[0] }] } };
  const catalog = { version: 1, series: { cs: series }, plans: { cs: { [episodeId]: plan } },
    episodes: { [episodeId]: { seriesId: 'cs', planId: episodeId, episode: plan.input, adapter: series.adapter } }, batches: {} };
  write(catalogFile, catalog);
  write(inputFile, rawStory);
  if (!missing) write(sourceFile, sourceText);
  const bundle = readEvidenceBundle(root, series);
  const entry = { plan, story: validateSpec(rawStory) };
  const report = reportFor({ entries: [entry], bundle }, unresolved);
  write(path.join(root, 'runs', episodeId, 'artifacts', 'content', 'initial', 'report.json'), report);
  write(path.join(root, 'runs', episodeId, 'state.json'), { version: 1, status: 'failed',
    stages: { content: { status: 'failed', dir: 'artifacts/content/initial' } } });
  // An unrelated completed episode is never part of a repair transaction.
  const completedFile = path.join(root, 'runs', 'completed', 'state.json');
  write(completedFile, { status: 'complete', stages: { render: { status: 'complete', fingerprint: 'untouched' } } });
  const originalInput = fs.readFileSync(inputFile);
  const completedBytes = fs.readFileSync(completedFile);
  const proposal = { disposition: 'condition_omission', reason: '이미 설명된 Python maxlen deque의 append 조건을 제목과 첫 화면에 명시한다.',
    edits: [{ target: 'title', sceneId: null, value: '가득 찬 maxlen deque에 append하면?' },
      { target: 'headline', sceneId: 'question', value: '가득 찬 deque에\nappend하면?' },
      { target: 'body', sceneId: 'question', value: 'Python · maxlen=2' }],
    anchors: [collectUnits([entry]).find(unit => unit.location === 'story.narration[1].text').unitId],
    evidence: [{ sourceId: 'deque', quote }] };
  const f = { root, episodeId, inputFile, catalogFile, sourceFile, series, entry, rawStory, bundle, proposal, originalInput, completedFile, completedBytes };
  f.journal = () => {
    const directory = path.join(root, 'runs', '_content-repairs', episodeId);
    const { key } = read(path.join(directory, 'active.json'));
    return read(path.join(directory, key, 'state.json'));
  };
  return f;
}

test('one checked repair synchronizes titles while preserving raw narration, profile, metadata and completed episodes', async t => {
  const f = fixture(t);
  let proposals = 0, checks = 0;
  const result = await repairProductionContent({ ...f,
    provider: async () => { proposals++; return f.proposal; },
    checker: async request => { checks++; return reportFor(request); } });
  assert.equal(result.status, 'applied');
  assert.equal(result.attempts, 1);
  assert.equal(proposals, 1);
  assert.equal(checks, 1);
  const savedBase = read(path.join(path.dirname(result.reportPath), 'base.json'));
  assert.equal(savedBase.inputFile, 'planning/inputs/bounded.json');
  const after = read(f.inputFile), catalog = read(f.catalogFile);
  assert.equal(after.title, f.proposal.edits[0].value);
  assert.equal(catalog.plans.cs.bounded.title, after.title);
  assert.equal(after.scenes[0].body, 'Python · maxlen=2');
  for (const key of ['narration', 'profile', 'audience', 'tone', 'durationSeconds']) assert.deepEqual(after[key], f.rawStory[key]);
  assert.deepEqual(after.scenes[1], f.rawStory.scenes[1]);
  assert.deepEqual({ ...catalog.plans.cs.bounded, title: f.entry.plan.title }, f.entry.plan);
  assert.deepEqual(fs.readFileSync(f.completedFile), f.completedBytes);
  assert.equal(getRepairHold(f), undefined);
  assert.equal(getRepairResume(f), true);
  const rerun = await repairProductionContent({ ...f,
    provider: async () => assert.fail('Applied repair must not request a new proposal'),
    checker: async () => assert.fail('Applied repair must not recheck identical content') });
  assert.equal(rerun.status, 'applied');
  assert.equal(rerun.attempts, 1);
  const cachedReport = await rerun.checker({ entries: [{ plan: catalog.plans.cs.bounded, story: validateSpec(after) }], bundle: f.bundle });
  assert.equal(cachedReport.status, 'passed');
  write(f.sourceFile, sourceText + ' Changed evidence.');
  await assert.rejects(() => rerun.checker({ entries: [{ plan: catalog.plans.cs.bounded, story: validateSpec(after) }], bundle: f.bundle }), { code: 'CONTENT_REPAIR_CONFLICT' });
});

test('two rejected candidates produce a persistent hold and reruns make zero model or checker calls', async t => {
  const f = fixture(t);
  let proposals = 0, checks = 0;
  const result = await repairProductionContent({ ...f,
    provider: async () => { proposals++; return f.proposal; },
    checker: async request => { checks++; return reportFor(request, initialUnresolved); } });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.attempts, 2);
  assert.equal(proposals, 2);
  assert.equal(checks, 2);
  assert.deepEqual(fs.readFileSync(f.inputFile), f.originalInput);
  assert.equal(read(f.catalogFile).plans.cs.bounded.title, f.entry.plan.title);
  assert.deepEqual(getRepairHold(f), result);
  assert.equal(getRepairResume(f), false);
  const rerun = await repairProductionContent({ ...f,
    provider: async () => assert.fail('A capped repair is permanently held for this input'),
    checker: async () => assert.fail('A capped repair must not recheck') });
  assert.deepEqual(rerun, result);
  assert.deepEqual(f.journal().attempts.map(attempt => attempt.status), ['rejected', 'rejected']);
});

test('changing visual review policy does not reset the exhausted content repair limit', async t => {
  const f = fixture(t);
  let proposals = 0;
  const held = await repairProductionContent({ ...f,
    provider: async () => { proposals++; return f.proposal; },
    checker: async request => reportFor(request, initialUnresolved) });
  assert.equal(held.status, 'needs_review');
  assert.equal(held.attempts, 2);
  assert.equal(proposals, 2);
  const catalog = read(f.catalogFile);
  catalog.series.cs.visualReview = { mode: 'required' };
  write(f.catalogFile, catalog);
  assert.deepEqual(getRepairHold(f), held);
  assert.equal(getRepairResume(f), false);
  const rerun = await repairProductionContent({ ...f,
    provider: async () => assert.fail('A visual policy edit must not authorize another content repair'),
    checker: async () => assert.fail('An exhausted content repair must remain held') });
  assert.deepEqual(rerun, held);
  assert.deepEqual(fs.readFileSync(f.inputFile), f.originalInput);
});

test('a second cumulative proposal can pass after the first candidate recheck fails', async t => {
  const f = fixture(t);
  const prompts = [];
  let checks = 0;
  const second = structuredClone(f.proposal);
  second.edits[2].value = 'Python · append · maxlen=2';
  const result = await repairProductionContent({ ...f,
    provider: async ({ prompt }) => { prompts.push(prompt); return prompts.length === 1 ? f.proposal : second; },
    checker: async request => reportFor(request, ++checks === 1 ? ['story.scenes[0].headline'] : []) });
  assert.equal(result.status, 'applied');
  assert.equal(result.attempts, 2);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /needs_review/);
  assert.ok(prompts[1].includes(f.proposal.edits[2].value));
  assert.equal(read(f.inputFile).scenes[0].body, second.edits[2].value);
  assert.equal(read(f.inputFile).title, second.edits[0].value);
  assert.deepEqual(f.journal().attempts.map(attempt => attempt.status), ['rejected', 'accepted']);
});

test('unavailable evidence and unresolved narration remain held without requesting a proposal', async t => {
  for (const settings of [{ missing: true }, { unresolved: ['story.narration[1].text'] }]) {
    const f = fixture(t, settings);
    const result = await repairProductionContent({ ...f,
      provider: async () => assert.fail('Evidence and narration are outside automatic wording repair'),
      checker: async () => assert.fail('No candidate exists to check') });
    assert.equal(result.status, 'needs_review');
    assert.equal(result.attempts, 0);
    assert.deepEqual(fs.readFileSync(f.inputFile), f.originalInput);
    assert.deepEqual(getRepairHold(f), result);
  }
});

test('a model classification of insufficient evidence holds the original input without candidate recheck', async t => {
  const f = fixture(t);
  let proposals = 0;
  const result = await repairProductionContent({ ...f,
    provider: async () => { proposals++; return { disposition: 'insufficient_evidence', reason: '등록 자료로 확인할 수 없다.', edits: [], anchors: [], evidence: [] }; },
    checker: async () => assert.fail('Insufficient evidence must not be rewritten into a different topic') });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.attempts, 1);
  assert.equal(proposals, 1);
  assert.deepEqual(fs.readFileSync(f.inputFile), f.originalInput);
});

test('new unresolved narration in a candidate stops repair immediately rather than spending a second proposal', async t => {
  const f = fixture(t);
  let proposals = 0;
  const result = await repairProductionContent({ ...f,
    provider: async () => { proposals++; return f.proposal; },
    checker: async request => reportFor(request, ['story.narration[0].text']) });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.attempts, 1);
  assert.equal(proposals, 1);
  assert.deepEqual(fs.readFileSync(f.inputFile), f.originalInput);
});

test('source changes during proposal generation conflict without publishing a candidate', async t => {
  const f = fixture(t);
  await assert.rejects(() => repairProductionContent({ ...f,
    provider: async () => { write(f.sourceFile, sourceText + ' New source version.'); return f.proposal; },
    checker: async () => assert.fail('The source snapshot changed before checking') }), { code: 'CONTENT_REPAIR_CONFLICT' });
  assert.deepEqual(fs.readFileSync(f.inputFile), f.originalInput);
  assert.equal(read(f.catalogFile).plans.cs.bounded.title, f.entry.plan.title);
});

test('input edits during candidate checking conflict and preserve the concurrent edit', async t => {
  const f = fixture(t);
  const concurrent = { ...f.rawStory, audience: '수동 수정된 대상 독자' };
  await assert.rejects(() => repairProductionContent({ ...f,
    provider: async () => f.proposal,
    checker: async request => { write(f.inputFile, concurrent); return reportFor(request); } }), { code: 'CONTENT_REPAIR_CONFLICT' });
  assert.deepEqual(read(f.inputFile), concurrent);
  assert.equal(read(f.catalogFile).plans.cs.bounded.title, f.entry.plan.title);
});

test('checker transport failure resumes the saved candidate without another proposal', async t => {
  const f = fixture(t);
  let proposals = 0, firstCandidate;
  await assert.rejects(() => repairProductionContent({ ...f,
    provider: async () => { proposals++; return f.proposal; },
    checker: async request => { firstCandidate = structuredClone(request.entries); throw new Error('checker transport unavailable'); } }), /checker transport unavailable/);
  assert.equal(proposals, 1);
  assert.equal(f.journal().status, 'failed');
  assert.equal(f.journal().pending, 1);
  assert.equal(getRepairResume(f), true);
  assert.deepEqual(fs.readFileSync(f.inputFile), f.originalInput);
  const result = await repairProductionContent({ ...f,
    provider: async () => assert.fail('A pending candidate must be reused'),
    checker: async request => { assert.deepEqual(request.entries, firstCandidate); return reportFor(request); } });
  assert.equal(result.status, 'applied');
  assert.equal(result.attempts, 1);
  assert.equal(proposals, 1);
});

test('interrupted two-file publication resumes the accepted candidate without model or checker calls', async t => {
  const f = fixture(t);
  const rename = fs.renameSync;
  const failure = t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(to) === f.catalogFile) throw Object.assign(new Error('simulated catalog publication interruption'), { code: 'EIO' });
    return rename(from, to);
  });
  await assert.rejects(() => repairProductionContent({ ...f, provider: async () => f.proposal, checker: async request => reportFor(request) }), /simulated catalog publication interruption/);
  failure.mock.restore();
  assert.equal(read(f.inputFile).title, f.proposal.edits[0].value);
  assert.equal(read(f.catalogFile).plans.cs.bounded.title, f.entry.plan.title);
  assert.equal(f.journal().status, 'publishing');
  assert.equal(getRepairResume(f), true);
  const result = await repairProductionContent({ ...f,
    provider: async () => assert.fail('Publishing recovery already has an accepted candidate'),
    checker: async () => assert.fail('Publishing recovery already has a passed report') });
  assert.equal(result.status, 'applied');
  assert.equal(result.attempts, 1);
  assert.equal(read(f.catalogFile).plans.cs.bounded.title, read(f.inputFile).title);
  assert.deepEqual(read(f.inputFile).narration, f.rawStory.narration);
  assert.equal(f.journal().status, 'applied');
});

async function rewindToSavedReport(f) {
  const result = await repairProductionContent({ ...f, provider: async () => f.proposal, checker: async request => reportFor(request) });
  assert.equal(result.status, 'applied');
  const state = read(result.reportPath);
  state.status = 'checking'; state.pending = 1; state.attempts[0].status = 'checking';
  delete state.publication;
  write(result.reportPath, state);
  fs.writeFileSync(f.inputFile, f.originalInput);
  const catalog = read(f.catalogFile);
  catalog.plans.cs.bounded = f.entry.plan;
  write(f.catalogFile, catalog);
  return { directory: path.dirname(result.reportPath), state };
}

test('a saved passed report resumes publication and reuses orphaned after-files without new calls', async t => {
  const f = fixture(t);
  const { directory } = await rewindToSavedReport(f);
  const preparedInput = fs.readFileSync(path.join(directory, 'after-input.json'));
  const preparedPlan = fs.readFileSync(path.join(directory, 'after-plan.json'));
  assert.equal(getRepairResume(f), true);
  const result = await repairProductionContent({ ...f,
    provider: async () => assert.fail('Saved candidate already exists'),
    checker: async () => assert.fail('Saved passed report must be reused') });
  assert.equal(result.status, 'applied');
  assert.equal(result.attempts, 1);
  assert.deepEqual(fs.readFileSync(f.inputFile), preparedInput);
  assert.deepEqual(read(f.catalogFile).plans.cs.bounded, JSON.parse(preparedPlan));
  assert.deepEqual(fs.readFileSync(path.join(directory, 'after-input.json')), preparedInput);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'after-plan.json')), preparedPlan);
});

test('a changed saved report cannot authorize publication or silently trigger a replacement review', async t => {
  const f = fixture(t);
  const { directory, state } = await rewindToSavedReport(f);
  fs.appendFileSync(path.join(directory, state.attempts[0].reportFile), '\n');
  await assert.rejects(() => repairProductionContent({ ...f,
    provider: async () => assert.fail('Tampering does not authorize a replacement proposal'),
    checker: async () => assert.fail('Tampering does not authorize a replacement report') }), /Saved repair artifact changed/);
  assert.deepEqual(fs.readFileSync(f.inputFile), f.originalInput);
  assert.equal(read(f.catalogFile).plans.cs.bounded.title, f.entry.plan.title);
});

async function interruptPublication(t, f, target) {
  const rename = fs.renameSync;
  const failure = t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(to) === target) throw Object.assign(new Error('simulated relocation interruption'), { code: 'EIO' });
    return rename(from, to);
  });
  try {
    await assert.rejects(() => repairProductionContent({ ...f,
      provider: async () => f.proposal, checker: async request => reportFor(request) }), /simulated relocation interruption/);
  } finally { failure.mock.restore(); }
  assert.equal(f.journal().status, 'publishing');
}

function repairFiles(f) {
  const home = path.join(f.root, 'runs', '_content-repairs', f.episodeId);
  const { key } = read(path.join(home, 'active.json'));
  return { base: path.join(home, key, 'base.json'), state: path.join(home, key, 'state.json') };
}

function rewriteFixtureBase(f, update) {
  const files = repairFiles(f);
  const base = read(files.base);
  update(base);
  const bytes = json(base);
  write(files.base, bytes);
  const state = read(files.state);
  state.baseHash = createHash('sha256').update(bytes).digest('hex');
  write(files.state, state);
}

test('moving an interrupted publication resumes both new and legacy journals without touching the old workspace', async t => {
  for (const legacy of [false, true]) {
    for (const afterInput of [false, true]) {
      await t.test(`${legacy ? 'legacy absolute' : 'relative'} input, ${afterInput ? 'input written' : 'input not yet written'}`, async t => {
        const original = fixture(t);
        await interruptPublication(t, original, afterInput ? original.catalogFile : original.inputFile);
        // Recreate the prior journal representation; no production data is involved.
        if (legacy) rewriteFixtureBase(original, base => { base.inputFile = original.inputFile; });
        const originalFiles = repairFiles(original);
        const oldInput = fs.readFileSync(original.inputFile), oldCatalog = fs.readFileSync(original.catalogFile);
        const oldState = fs.readFileSync(originalFiles.state), oldBase = fs.readFileSync(originalFiles.base);
        const moved = fixture(t);
        fs.cpSync(original.root, moved.root, { recursive: true });
        assert.notEqual(moved.root, original.root);
        assert.equal(getRepairResume(moved), true);
        const result = await repairProductionContent({ ...moved,
          provider: async () => assert.fail('Relocation must reuse the accepted proposal'),
          checker: async () => assert.fail('Relocation must reuse the saved passed report') });
        assert.equal(result.status, 'applied');
        assert.equal(result.attempts, 1);
        assert.equal(read(moved.inputFile).title, moved.proposal.edits[0].value);
        assert.equal(read(moved.catalogFile).plans.cs.bounded.title, read(moved.inputFile).title);
        assert.deepEqual(read(moved.inputFile).narration, moved.rawStory.narration);
        assert.deepEqual(fs.readFileSync(moved.completedFile), moved.completedBytes);
        assert.deepEqual(fs.readFileSync(repairFiles(moved).base), oldBase);
        for (const [file, before] of [[original.inputFile, oldInput], [original.catalogFile, oldCatalog],
          [originalFiles.state, oldState], [originalFiles.base, oldBase]]) assert.deepEqual(fs.readFileSync(file), before);
      });
    }
  }
});

test('relocated publication still verifies the base hash and rejects an escaping catalog-relative input', async t => {
  for (const tamperHash of [true, false]) {
    await t.test(tamperHash ? 'changed bytes' : 'unsafe saved relative input', async t => {
      const original = fixture(t);
      await interruptPublication(t, original, original.inputFile);
      const moved = fixture(t);
      fs.cpSync(original.root, moved.root, { recursive: true });
      if (tamperHash) fs.appendFileSync(repairFiles(moved).base, '\n');
      else rewriteFixtureBase(moved, base => { base.episode.episode = '../outside.json'; });
      await assert.rejects(() => repairProductionContent({ ...moved,
        provider: async () => assert.fail('Invalid journals cannot call a model'),
        checker: async () => assert.fail('Invalid journals cannot call a checker') }),
      tamperHash ? /Saved repair artifact changed/ : /Saved repair input must be repository relative/);
      for (const f of [original, moved]) {
        assert.deepEqual(fs.readFileSync(f.inputFile), f.originalInput);
        assert.equal(read(f.catalogFile).plans.cs.bounded.title, f.entry.plan.title);
      }
    });
  }
});
