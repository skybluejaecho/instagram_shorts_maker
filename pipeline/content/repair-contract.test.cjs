const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectUnits, contentEntryHash } = require('./checker.cjs');
const { eligibility, outputSchema, buildPrompt, applyProposal } = require('./repair-contract.cjs');

const sourceText = 'A full Python deque with maxlen discards an item from the opposite end when append or appendleft adds an item. The insert operation raises IndexError if it would exceed maxlen.';
const quote = 'A full Python deque with maxlen discards an item from the opposite end when append or appendleft adds an item.';

function fixture({ unresolved = ['plan.title', 'story.title', 'story.scenes[0].headline'], verdict = 'uncertain', consistency = 'consistent', noAnchors = false, missing = false } = {}) {
  const entry = {
    plan: { id: 'bounded', seriesId: 'cs', title: '가득 찬 deque에 넣으면?', topicKey: 'deque.maxlen',
      objective: '가득 찬 maxlen deque의 append 동작을 이해한다.', angle: 'A와 B 뒤에 C를 추가한다.',
      knowledge: { core: '가득 찬 deque의 append는 반대쪽을 버린다.', example: 'AB에서 BC가 된다.' }, references: ['https://docs.python.org/3/library/collections.html'],
      input: 'planning/inputs/bounded.json', scheduledFor: '2026-11-23T10:00:00.000Z' },
    story: { version: 1, title: '가득 찬 deque에 넣으면?', durationSeconds: 30, audience: 'CS 입문자', tone: '차분하게',
      narration: [{ id: 'hook', text: '가득 찬 파이썬 데크에서 append를 하면 어떻게 될까요?' },
        { id: 'result', text: '반대쪽 값을 버리고 최대 길이를 유지합니다.' }],
      scenes: [{ id: 'question', type: 'question', from: 'hook', headline: '가득 찬 deque에\n더 넣으면?' },
        { id: 'result', type: 'conclusion', from: 'result', headline: '반대쪽을 버려요', body: '길이는 그대로' }] },
  };
  const bundle = { mode: 'required', status: missing ? 'needs_review' : 'ready', sourceHash: 'a'.repeat(64),
    issues: missing ? [{ sourceId: 'deque', reason: 'Source unavailable' }] : [],
    sources: missing ? [] : [{ id: 'deque', title: 'Python deque', path: 'sources/deque.md',
      url: 'https://docs.python.org/3/library/collections.html', sha256: 'b'.repeat(64), content: sourceText }] };
  const units = collectUnits([entry]).map(unit => {
    const decision = missing || unresolved.includes(unit.location) ? missing ? 'uncertain' : verdict
      : noAnchors && (unit.location === 'plan.objective' || unit.location.startsWith('story.narration')) ? 'not_factual' : 'supported';
    return { ...unit, verdict: decision, claim: unit.text, reason: unresolved.includes(unit.location) ? 'append와 다른 연산을 구분하는 조건이 빠졌다.' : '등록 자료와 대조했다.',
      evidence: ['uncertain', 'not_factual'].includes(decision) ? [] : [{ sourceId: 'deque', quote }] };
  });
  const actualConsistency = missing ? 'uncertain' : consistency;
  const uncertain = units.some(unit => unit.verdict === 'uncertain') || actualConsistency === 'uncertain';
  const contradicted = units.some(unit => unit.verdict === 'contradicted') || actualConsistency === 'contradicted';
  const report = { version: 1, status: uncertain ? 'needs_review' : contradicted ? 'corrections' : 'passed',
    candidateCount: 1, entryHash: contentEntryHash([entry]), sourceHash: bundle.sourceHash,
    units, consistency: [{ planId: entry.plan.id, verdict: actualConsistency, reason: '화면·낭독 일관성 판정' }],
    correctionPlanIds: contradicted ? [entry.plan.id] : [], reviewPlanIds: uncertain ? [entry.plan.id] : [],
    sources: bundle.sources.map(({ id, title, path, url, sha256 }) => ({ id, title, path, url, sha256 })) };
  const scope = eligibility({ entries: [entry], bundle, report });
  const proposal = { disposition: 'condition_omission', reason: '이미 설명된 Python maxlen deque의 append 조건을 제목과 첫 화면에 명시한다.',
    edits: [{ target: 'title', sceneId: null, value: '가득 찬 maxlen deque에 append하면?' },
      { target: 'headline', sceneId: 'question', value: '가득 찬 deque에\nappend하면?' },
      { target: 'body', sceneId: 'question', value: 'Python · maxlen=2' }],
    anchors: [units.find(unit => unit.location === 'story.narration[1].text').unitId], evidence: [{ sourceId: 'deque', quote }] };
  return { entry, bundle, report, scope, proposal, series: { id: 'cs', name: 'CS 한 장', audience: '입문자', topics: ['큐'] } };
}

test('held title and headline may clarify grounded conditions while preserving every fixed field', () => {
  const f = fixture();
  const original = structuredClone(f.entry);
  assert.equal(f.scope.eligible, true);
  assert.equal(f.scope.allowTitle, true);
  assert.deepEqual(f.scope.allowedScenes, ['question']);
  const result = applyProposal(f.proposal, f);
  assert.equal(result.status, 'candidate');
  assert.equal(result.entry.plan.title, result.entry.story.title);
  assert.equal(result.entry.story.scenes[0].body, 'Python · maxlen=2');
  assert.deepEqual(result.entry.story.narration, original.story.narration);
  assert.deepEqual(result.entry.story.scenes[1], original.story.scenes[1]);
  assert.equal(result.entry.story.audience, original.story.audience);
  assert.equal(result.entry.story.tone, original.story.tone);
  for (const key of ['topicKey', 'objective', 'angle', 'knowledge', 'references', 'input', 'scheduledFor']) assert.deepEqual(result.entry.plan[key], original.plan[key]);
  assert.deepEqual(f.entry, original);
  assert.deepEqual(result.changes.map(change => change.location), ['plan.title', 'story.title', 'story.scenes[0].headline', 'story.scenes[0].body']);
});

test('missing sources, unresolved fixed claims, inconsistent scenes and absent factual anchors remain held', () => {
  for (const settings of [
    { missing: true }, { unresolved: ['story.narration[1].text'] }, { unresolved: ['plan.objective'] },
    { consistency: 'uncertain' }, { consistency: 'contradicted' }, { noAnchors: true }, { unresolved: [] },
  ]) {
    const f = fixture(settings);
    assert.equal(f.scope.eligible, false, JSON.stringify(settings));
    assert.equal(applyProposal(f.proposal, f).status, 'needs_review');
    assert.throws(() => buildPrompt(f), /not eligible/);
  }
});

test('an unsupported card claim cannot be repaired by changing the nearby headline', () => {
  const f = fixture();
  f.entry.story.scenes[1].cards = [{ id: 'a', label: 'A' }];
  const unit = { unitId: 'e0-u99', planId: f.entry.plan.id, location: 'story.scenes[1].cards[0].label', text: 'A', sceneId: 'result', cardId: 'a' };
  // Rebuild unit IDs exactly as the checker would after adding the card.
  f.report.units = collectUnits([f.entry]).map(item => ({ ...item, verdict: item.location === unit.location ? 'uncertain' : 'supported',
    claim: item.text, reason: '검증용 판정', evidence: item.location === unit.location ? [] : [{ sourceId: 'deque', quote }] }));
  f.report.entryHash = contentEntryHash([f.entry]);
  const scope = eligibility({ entries: [f.entry], bundle: f.bundle, report: f.report });
  assert.equal(scope.eligible, false);
  assert.match(scope.reason, /unsupported field/);
});

test('forged reports and widened or stale scopes cannot authorize more edits', () => {
  const f = fixture();
  const badReport = structuredClone(f.report); badReport.entryHash = 'f'.repeat(64);
  assert.throws(() => eligibility({ entries: [f.entry], bundle: f.bundle, report: badReport }), /does not match/);
  assert.throws(() => applyProposal(f.proposal, { ...f, scope: { ...f.scope, allowedScenes: ['question', 'result'] } }), /scope does not match/);
  const changed = structuredClone(f.entry); changed.story.narration[1].text = '다르게 고친 낭독';
  assert.throws(() => applyProposal(f.proposal, { ...f, entry: changed }), /does not match/);
});

test('model classification can hold genuinely insufficient evidence without changing input', () => {
  const f = fixture();
  for (const disposition of ['insufficient_evidence', 'out_of_scope']) {
    const response = { disposition, reason: '새 성능 수치를 뒷받침할 자료가 없어 보류한다.', edits: [], anchors: [], evidence: [] };
    const result = applyProposal(response, f);
    assert.equal(result.status, 'needs_review');
    assert.deepEqual(result.entry, f.entry);
    assert.deepEqual(result.changes, []);
    assert.throws(() => applyProposal({ ...response, edits: f.proposal.edits }, f), /held repair/);
  }
});

test('real evidence quotes and supported fixed anchors are mandatory and unique', () => {
  const f = fixture();
  for (const update of [
    { evidence: [] }, { evidence: [{ sourceId: 'made-up', quote }] },
    { evidence: [{ sourceId: 'deque', quote: 'A translated or fabricated assertion.' }] },
    { evidence: [f.proposal.evidence[0], f.proposal.evidence[0]] },
    { anchors: [] }, { anchors: ['unknown'] }, { anchors: [f.report.units[0].unitId] },
    { anchors: [f.proposal.anchors[0], f.proposal.anchors[0]] },
  ]) assert.throws(() => applyProposal({ ...f.proposal, ...update }, f));
  const spaced = { ...f.proposal, evidence: [{ sourceId: 'deque', quote: quote.replaceAll(' ', '\r\n ') }] };
  assert.equal(applyProposal(spaced, f).status, 'candidate');
});

test('extra fields, narration edits, scene escapes and duplicate fields are rejected', () => {
  const f = fixture();
  for (const proposal of [
    { ...f.proposal, story: f.entry.story },
    { ...f.proposal, edits: [{ target: 'narration', sceneId: 'hook', value: '새 낭독' }] },
    { ...f.proposal, edits: [{ target: 'headline', sceneId: 'result', value: '다른 장면' }] },
    { ...f.proposal, edits: [{ target: 'title', sceneId: 'question', value: '제목' }] },
    { ...f.proposal, edits: [{ target: 'headline', sceneId: null, value: '제목' }] },
    { ...f.proposal, edits: [f.proposal.edits[0], f.proposal.edits[0]] },
    { ...f.proposal, edits: [{ target: 'body', sceneId: 'question', value: null }] },
    { ...f.proposal, edits: [{ target: 'body', sceneId: 'question', value: '   ' }] },
  ]) assert.throws(() => applyProposal(proposal, f));
});

test('only originally held titles may be edited and only originally held scenes are in scope', () => {
  const screen = fixture({ unresolved: ['story.scenes[0].headline'] });
  assert.equal(screen.scope.allowTitle, false);
  assert.throws(() => applyProposal(screen.proposal, screen), /Title repair/);
  const title = fixture({ unresolved: ['plan.title'] });
  assert.deepEqual(title.scope.allowedScenes, []);
  assert.throws(() => applyProposal(title.proposal, title), /Scene repair/);
  const result = applyProposal({ ...title.proposal, edits: [title.proposal.edits[0]] }, title);
  assert.equal(result.entry.plan.title, result.entry.story.title);
});

test('no-op edits and oversized or excessive-line text cannot pass the contract', () => {
  const f = fixture();
  for (const edit of [
    { target: 'title', sceneId: null, value: f.entry.plan.title },
    { target: 'headline', sceneId: 'question', value: '  ' + f.entry.story.scenes[0].headline + '  ' },
    { target: 'title', sceneId: null, value: 'a'.repeat(81) },
    { target: 'headline', sceneId: 'question', value: '가'.repeat(15) },
    { target: 'headline', sceneId: 'question', value: '하나\n둘\n셋' },
    { target: 'body', sceneId: 'question', value: '가'.repeat(25) },
    { target: 'body', sceneId: 'question', value: '하나\n둘\n셋\n넷' },
  ]) assert.throws(() => applyProposal({ ...f.proposal, edits: [edit] }, f));
  assert.throws(() => applyProposal({ ...f.proposal, edits: [] }, f), /real text change/);
});

test('prompt contains bounded source-grounded instructions and every retry applies to the original', () => {
  const f = fixture();
  const prompt = buildPrompt({ ...f, previous: { candidate: 'previous candidate' }, feedback: { reason: 'still ambiguous' } });
  for (const expected of ['insufficient_evidence', 'out_of_scope', '원본 회차에 직접 적용', '낭독', '입문자']) {
    assert.ok(prompt.includes(expected), expected);
  }
  assert.ok(prompt.includes(sourceText));
  assert.ok(prompt.includes('previous candidate'));
  assert.ok(prompt.includes('still ambiguous'));
  assert.ok(prompt.includes('story.narration[1].text'));
});

test('schema objects require every declared field and reject additional fields', () => {
  function visit(schema) {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, Object.keys(schema.properties));
      Object.values(schema.properties).forEach(visit);
    }
    if (schema.items) visit(schema.items);
  }
  visit(outputSchema);
});
