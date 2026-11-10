const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNoveltyChecker } = require('./checker.cjs');

const series = { id: 'cs', name: 'CS 지식', audience: '입문자', topics: ['스택', '큐'] };
function plan(id, values = {}) {
  return { id, title: id + ' 설명', topicKey: 'knowledge.' + id,
    objective: id + ' 고유 학습 목표', angle: id + ' 예시로 설명', ...values };
}
function entry(id, values = {}) {
  return { plan: plan(id, values), story: { narration: [{ id: 'first', text: id + '에 대한 설명입니다.' }] } };
}
function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'shorts-novelty-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('shorts-novelty-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function answer(args, verdicts = {}) {
  const context = JSON.parse(fs.readFileSync(path.join(path.dirname(args.directory), 'context.json'), 'utf8'));
  const ids = args.schema.properties.profiles.items.properties.planId.enum;
  return { profiles: ids.map(id => ({ planId: id, knowledge: { core: id + '의 핵심 원리', example: id + '의 예시' } })),
    decisions: context.pairs.map(pair => ({ pairId: pair.pairId, verdict: verdicts[pair.pairId] || 'distinct',
      reason: verdicts[pair.pairId] === 'duplicate' ? '표현은 다르지만 배우는 핵심 원리가 같습니다.'
        : verdicts[pair.pairId] === 'uncertain' ? '이전 회차의 학습 목표가 모호하여 구분할 수 없습니다.' : '새로 배우는 원리가 구체적으로 다릅니다.' })) };
}

test('exact normalized duplicates are decided locally and cannot be overturned by a model', async t => {
  const directory = fixture(t);
  let inspected;
  const check = createNoveltyChecker({ provider: async args => {
    inspected = JSON.parse(fs.readFileSync(path.join(path.dirname(args.directory), 'context.json')));
    return answer(args);
  } });
  const result = await check({ series, directory,
    history: [plan('old', { topicKey: 'ＳＴＡＣＫ   PEEK', publishedAt:'2026-11-01T00:00:00Z' })],
    entries: [entry('new', { topicKey: ' stack peek ' })] });
  assert.equal(inspected.pairs.length, 0);
  assert.equal(inspected.exact.length, 1);
  assert.equal(result.status, 'duplicates');
  assert.deepEqual(result.duplicatePlanIds, ['new']);
  assert.equal(result.comparisons[0].method, 'exact');
  assert.equal(result.comparisons[0].reference.id, 'old');
  assert.deepEqual(result.reviewPlanIds, []);
  assert.equal(result.factChecked, false);
});

test('paraphrased same knowledge is rejected while a new principle in the same field passes', async t => {
  const directory = fixture(t);
  const check = createNoveltyChecker({ provider: async args => answer(args, { 'c0-h0': 'duplicate' }) });
  const result = await check({ series, directory,
    history: [plan('lifo', { title:'스택은 후입선출', objective:'나중에 넣은 값을 먼저 꺼낸다.', narration:['에이 다음 비를 넣으면 비가 먼저 나옵니다.'] })],
    entries: [entry('paraphrase', { title:'마지막 손님부터 나온다', objective:'스택에 가장 늦게 들어온 값이 가장 먼저 나온다.' }),
      entry('peek', { title:'꺼내지 않고 확인', objective:'스택의 맨 위를 읽어도 데이터는 제거되지 않는다.' })] });
  assert.equal(result.status, 'duplicates');
  assert.deepEqual(result.duplicatePlanIds, ['paraphrase']);
  assert.equal(result.comparisons.length, 3);
  assert.equal(result.comparisons.find(item => item.pairId === 'c1-h0').verdict, 'distinct');
  assert.equal(result.profiles.length, 2);
  assert.deepEqual(result.profiles.map(item => item.planId), ['paraphrase', 'peek']);
});

test('intra-batch duplicates replace only the later candidate, preserving the first', async t => {
  const directory = fixture(t);
  const result = await createNoveltyChecker({ provider: async args => answer(args, { 'c1-c0':'duplicate' }) })({
    series, directory, history: [], entries: [entry('first'), entry('second'), entry('third')] });
  assert.equal(result.comparisons.length, 3);
  assert.deepEqual(result.duplicatePlanIds, ['second']);
  const pair = result.comparisons.find(item => item.pairId === 'c1-c0');
  assert.deepEqual(pair.reference, { kind:'candidate', id:'first' });
  assert.equal(pair.candidateId, 'second');
});

test('ambiguous comparisons explicitly hold for review and include the comparison reason', async t => {
  const directory = fixture(t);
  const result = await createNoveltyChecker({ provider: async args => answer(args, { 'c0-h0':'uncertain' }) })({
    series, directory, history:[plan('vague')], entries:[entry('new')] });
  assert.equal(result.status, 'needs_review');
  assert.deepEqual(result.reviewPlanIds, ['new']);
  assert.deepEqual(result.duplicatePlanIds, []);
  assert.match(result.comparisons[0].reason, /모호/);
});

test('all history chunks and candidate pairs are checked without silently dropping old episodes', async t => {
  const directory = fixture(t);
  const calls = [];
  const result = await createNoveltyChecker({ provider: async args => {
    const context = JSON.parse(fs.readFileSync(path.join(path.dirname(args.directory), 'context.json')));
    calls.push(context);
    const response = answer(args);
    response.profiles[0].knowledge.core = '첫 청크 ' + calls.length;
    return response;
  } })({ series, directory, history:Array.from({ length:45 }, (_, index) => plan('old-' + index)),
    entries:[entry('one'), entry('two')] });
  assert.deepEqual(calls.map(item => item.history.length), [20, 20, 5]);
  assert.deepEqual(calls.map(item => item.historyOffset), [0, 20, 40]);
  assert.equal(result.comparisons.length, 91);
  assert.equal(new Set(result.comparisons.map(pair => pair.pairId)).size, 91);
  assert.equal(result.comparisons.filter(pair => pair.reference.kind === 'candidate').length, 1);
  assert.equal(result.profiles[0].knowledge.core, '첫 청크 1');
  assert.equal(result.historyCount, 45);
  assert.equal(result.status, 'passed');
});

test('missing, repeated or hallucinated decisions and profiles fail closed with audit evidence', async t => {
  for (const [label, mutate] of [
    ['missing', value => value.decisions.pop()],
    ['unknown-pair', value => { value.decisions[0].pairId = 'imaginary'; }],
    ['repeated-pair', value => { value.decisions[1] = { ...value.decisions[0] }; }],
    ['unknown-profile', value => { value.profiles[0].planId = 'imaginary'; }],
    ['repeated-profile', value => { value.profiles[1] = { ...value.profiles[0] }; }],
    ['blank-reason', value => { value.decisions[0].reason = '   '; }],
    ['extra-field', value => { value.approved = true; }],
  ]) {
    await t.test(label, async sub => {
      const directory = fixture(sub);
      const check = createNoveltyChecker({ provider: async args => { const value = answer(args); mutate(value); return value; } });
      await assert.rejects(check({ series, directory, history:[plan('old')], entries:[entry('first'),entry('second')] }), error => {
        assert.equal(error.code, 'NOVELTY_CHECK_FAILED');
        assert.equal(error.generationRetryable, false);
        return true;
      });
      const audit = path.join(directory, fs.readdirSync(directory)[0]);
      assert.ok(fs.existsSync(path.join(audit, 'failure.json')));
      assert.ok(!fs.existsSync(path.join(audit, 'report.json')));
    });
  }
});

test('a model cannot override a deterministic duplicate by returning its excluded pair', async t => {
  const directory = fixture(t);
  const check = createNoveltyChecker({ provider: async args => {
    const value = answer(args);
    value.decisions.push({ pairId:'c0-h0', verdict:'distinct', reason:'모델의 잘못된 덮어쓰기' });
    return value;
  } });
  await assert.rejects(check({ series, directory, history:[plan('old', { topicKey:'same' })],
    entries:[entry('new', { topicKey:'same' })] }), /every expected/);
});

test('audit artifacts survive repeated checks and records bind normalized source, output and decisions', async t => {
  const directory = fixture(t);
  const args = { series, directory, history:[], entries:[entry('new')] };
  const check = createNoveltyChecker({ provider: async args => answer(args) });
  const first = await check(args);
  const text = fs.readFileSync(first.reportPath, 'utf8');
  const second = await check(args);
  assert.equal(first.inputHash, second.inputHash);
  assert.notEqual(first.reportDirectory, second.reportDirectory);
  assert.equal(fs.readFileSync(first.reportPath, 'utf8'), text);
  assert.equal(first.status, 'passed');
  assert.ok(fs.existsSync(path.join(first.reportDirectory, 'source.json')));
  assert.match(first.evidence[0].responseSha256, /^[a-f0-9]{64}$/);
  assert.ok(first.reportPath.startsWith(path.resolve(directory) + path.sep));
});
