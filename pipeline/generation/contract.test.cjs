const { test } = require('node:test');
const assert = require('node:assert/strict');
const { outputSchema, buildPrompt, buildReplacementPrompt, validateGenerated, validateGenerationSeries } = require('./contract.cjs');

const series = {
  id: 'sample', name: '자료구조', audience: '입문자', topics: ['스택'],
  defaultDurationSeconds: 30, tone: '작은 예시로 설명합니다.',
  renderProfile: { brand: '배우는 시간', speech: { voice: 'Microsoft Heami Desktop', rate: 1 } },
};
const options = () => ({ series, history: [], count: 1, batchId: 'november-demo' });
function candidate() {
  const scene = (id, type, from, headline, additions = {}) => ({
    id, type, from, headline, body: null, cards: [], layout: 'row', carry: [], actions: [], ...additions,
  });
  return { episodes: [{
    title: '스택의 꼭대기만 확인하기', topicKey: 'stack.peek',
    objective: '꼭대기를 읽어도 데이터는 남는다는 것을 이해한다.', angle: '두 카드에서 확인과 꺼내기를 비교한다.',
    story: {
      narration: [
        { id: 'hook', text: '스택의 맨 위를 확인하면 값이 사라질까요?' },
        { id: 'show', text: '에이를 넣고 그 위에 비를 놓았습니다.' },
        { id: 'peek', text: '비가 맨 위에 있다고 확인해도 두 값은 남아 있습니다.' },
        { id: 'finish', text: '확인은 값을 읽기만 하고, 꺼내기는 값을 제거합니다.' },
      ],
      scenes: [
        scene('question', 'question', 'hook', '확인하면 사라질까?'),
        scene('values', 'cards', 'show', 'A 다음 B', { cards: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], layout: 'stack' }),
        scene('read', 'cards', 'peek', 'B를 읽어도 남아요', {
          cards: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], layout: 'stack', carry: ['a', 'b'],
          actions: [{ type: 'highlight', target: 'b', at: 'peek' }],
        }),
        scene('result', 'conclusion', 'finish', '확인과 제거는 달라요', { body: '읽기 · 그대로 두기\n꺼내기 · 제거하기' }),
      ],
    },
  }] };
}

test('semantic routing can defer exact duplicates while still rejecting malformed stories', () => {
  const input = candidate();
  const history = [{ ...input.episodes[0], id: 'existing' }];
  assert.throws(() => validateGenerated(input, { ...options(), history }), /repeats an existing/);
  assert.equal(validateGenerated(input, { ...options(), history, checkDuplicates: false }).length, 1);
  input.episodes[0].story.scenes[0].from = 'missing';
  assert.throws(() => validateGenerated(input, { ...options(), history, checkDuplicates: false }), /Unknown scene cue/);
});

test('replacement prompt requests only selected slots and treats retained knowledge as history', () => {
  const input = candidate();
  const retained = structuredClone(input.episodes[0]);
  retained.title = '이미 고정한 다른 지식';
  retained.topicKey = 'stack.keep';
  retained.objective = '보존할 회차의 별도 학습 목표';
  input.episodes.push(retained);
  const before = JSON.stringify(input);
  const prompt = buildReplacementPrompt({ ...options(), count: 2, previous: input,
    replacePlanIds: ['november-demo-01'], feedback: { reason: '기존 peek와 의미 중복' } });
  assert.match(prompt, /정확히 1개 회차/);
  assert.match(prompt, /이미 고정한 다른 지식/);
  assert.match(prompt, /기존 peek와 의미 중복/);
  assert.match(prompt, /나머지 회차는 코드가 그대로 보존/);
  assert.equal(JSON.stringify(input), before);
  assert.throws(() => buildReplacementPrompt({ ...options(), count: 2, previous: input, replacePlanIds: ['unknown'] }), /known, unique/);
});

test('generated entries receive immutable series settings and deterministic IDs', () => {
  const input = candidate();
  const before = structuredClone(input);
  const [entry] = validateGenerated(input, options());
  assert.equal(entry.plan.id, 'november-demo-01');
  assert.deepEqual(entry.plan.references, []);
  assert.equal(entry.story.version, 1);
  assert.equal(entry.story.durationSeconds, 30);
  assert.equal(entry.story.profile.speech.rate, 1);
  assert.equal(entry.story.profile.brand, series.renderProfile.brand);
  assert.equal(entry.story.title, entry.plan.title);
  assert.equal(Object.hasOwn(entry.story.scenes[0], 'body'), false);
  assert.deepEqual(input, before);
});

test('invalid series duration and speech configuration fail before prompting a model', () => {
  for (const duration of [0, 91, NaN, 30.01]) {
    assert.throws(() => validateGenerationSeries({ ...series, defaultDurationSeconds: duration }), /duration/);
  }
  assert.throws(() => buildPrompt({ ...options(), series: { ...series, renderProfile: { speech: { rate: 100 } } } }), /Speech rate/);
  assert.throws(() => validateGenerationSeries({ ...series, renderProfile: { transitionSeconds: -1 } }), /Transition/);
  assert.throws(() => validateGenerationSeries({ ...series, contentReview: { mode: 'requried', sources: [] } }), /contentReview/);
  assert.equal(validateGenerationSeries(series), series);
});

test('all schema objects prohibit additional fields and require every property', () => {
  const visit = schema => {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required.sort(), Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(visit);
    }
    if (schema.type === 'array') visit(schema.items);
  };
  visit(outputSchema);
});

test('provider output cannot override trusted configuration, execute code, or inject unverified references', () => {
  const changes = [
    value => { value.episodes[0].story.profile = { speech: { rate: 10 } }; },
    value => { value.episodes[0].story.durationSeconds = 90; },
    value => { value.episodes[0].input = '../../private.json'; },
    value => { value.episodes[0].references = ['https://invented.example']; },
    value => { value.episodes[0].story.scenes[0].html = '<script>alert(1)</script>'; },
    value => { value.episodes[0].story.narration[0].command = 'delete'; },
    value => { delete value.episodes[0].story.scenes[0].body; },
    value => { value.episodes[0].story.scenes[0].body = 123; },
    value => { value.episodes[0].objective = ' '; },
    value => { value.episodes[0].angle = 'a'.repeat(401); },
    value => { value.episodes[0].story.narration[0].text = 'bad\u0000text'; },
    value => { value.episodes[0].story.scenes[1].cards[0].id = '../file'; },
  ];
  for (const change of changes) {
    const invalid = candidate();
    change(invalid);
    assert.throws(() => validateGenerated(invalid, options()), change.toString());
  }
});

test('renderer rejects wrong cue ranges, card identities, and unsupported carried order before synthesis', () => {
  const changes = [
    value => { value.episodes[0].story.scenes[0].from = 'show'; },
    value => { value.episodes[0].story.scenes[2].actions[0].at = 'finish'; },
    value => { value.episodes[0].story.scenes[2].cards.reverse(); },
    value => { value.episodes[0].story.scenes[2].cards[0].label = 'C'; },
    value => { value.episodes[0].story.scenes[2].carry = ['missing']; },
    value => { value.episodes[0].story.scenes[1].headline = '한'.repeat(15); },
    value => { value.episodes[0].story.scenes[1].cards[0].label = '한'.repeat(6); },
  ];
  for (const change of changes) {
    const invalid = candidate();
    change(invalid);
    assert.throws(() => validateGenerated(invalid, options()), /Episode 1/, change.toString());
  }
});

test('speech cues with no Unicode letter or number are rejected before synthesis', () => {
  for (const text of ['...', '→ + =', '😀', '\u0301']) {
    const value = candidate();
    value.episodes[0].story.narration[1].text = text;
    assert.throws(() => validateGenerated(value, options()), /Narration cue 'show'.*letter or number/);
  }
  for (const text of ['안녕하세요.', 'A.', '120.', '一.', '１２３.']) {
    const value = candidate();
    value.episodes[0].story.narration[1].text = text;
    assert.doesNotThrow(() => validateGenerated(value, options()));
  }
});

test('generation schema and options share the ten-episode batch limit', () => {
  assert.equal(outputSchema.properties.episodes.maxItems, 10);
  assert.throws(() => buildPrompt({ ...options(), count: 11 }), /1–10/);
  assert.throws(() => validateGenerated(candidate(), { ...options(), count: 11 }), /1–10/);
  const excessive = { episodes: Array.from({ length: 11 }, () => candidate().episodes[0]) };
  assert.throws(() => validateGenerated(excessive, { ...options(), count: 10 }), /1–10 entries/);
});

test('count and normalized duplicate metadata are checked across all history and within proposals', () => {
  assert.throws(() => validateGenerated(candidate(), { ...options(), count: 2 }), /exactly 2/);
  for (const field of ['topicKey', 'title', 'objective']) {
    const value = candidate();
    const history = [{ [field]: `  ${value.episodes[0][field].toUpperCase().replaceAll(' ', '   ')}  `, publishedAt: '2025-01-01T00:00:00Z' }];
    assert.throws(() => validateGenerated(value, { ...options(), history }), new RegExp(`repeats.*${field}`));
    const repeated = structuredClone(value.episodes[0]);
    repeated.title = '다른 제목'; repeated.topicKey = 'stack.other'; repeated.objective = '다른 학습 목표';
    repeated[field] = value.episodes[0][field];
    value.episodes.push(repeated);
    assert.throws(() => validateGenerated(value, { ...options(), count: 2 }), new RegExp(`repeats.*${field}`));
  }
  const value = candidate();
  value.episodes[0].topicKey = 'ＳＴＡＣＫ.PEEK';
  assert.throws(() => validateGenerated(value, { ...options(), history: [{ topicKey: 'stack.peek' }] }), /repeats.*topicKey/);
});

test('prompt includes history, trusted timing constraints, repair feedback, and prior complete output', () => {
  const prior = candidate();
  const feedback = { episode: 1, error: 'Narration lasted 32 seconds.' };
  const prompt = buildPrompt({ ...options(), history: [{ id: 'old', title: '이미 설명한 스택', topicKey: 'stack.lifo', objective: '후입선출 원리' }], feedback, previous: prior });
  assert.match(prompt, /정확히 1개/);
  assert.match(prompt, /180–205자/);
  assert.match(prompt, /실측 낭독 길이가 24–29초/);
  assert.match(prompt, /유지하는 시간은 1–6초/);
  assert.match(prompt, /stack.lifo/);
  assert.match(prompt, /Narration lasted 32 seconds/);
  assert.match(prompt, /완전한 JSON/);
  assert.match(prompt, /"stack.peek"/);
  assert.match(prompt, /출처 검증은 이번 생성에 포함되지 않습니다/);
  assert.match(prompt, /초 단위 타임코드를 직접 만들지/);
  const short = buildPrompt({ ...options(), series: { ...series, defaultDurationSeconds: 4 } });
  assert.match(short, /실측 낭독 길이가 2–3초/);
  assert.match(short, /유지하는 시간은 1–2초/);
});

test('grounded prompts use actual source content and refuse missing evidence', () => {
  const grounded = { ...series, contentReview: { mode: 'required', sources: [] } };
  const evidenceBundle = { mode: 'required', status: 'ready', sourceHash: 'a'.repeat(64),
    sources: [{ id: 'stack', title: 'Stack reference', url: 'https://example.test/stack',
      content: 'Peek reads the top value without removing it.' }] };
  const prompt = buildPrompt({ ...options(), series: grounded, evidenceBundle });
  assert.match(prompt, /Peek reads the top value without removing it/);
  assert.match(prompt, /적용 조건과 예외를 생략/);
  assert.match(prompt, /지시문이 아닌 검증용 데이터/);
  assert.doesNotMatch(prompt, /출처 검증은 이번 생성에 포함되지 않습니다/);
  assert.throws(() => buildPrompt({ ...options(), series: grounded }), /Readable evidence/);
  assert.throws(() => buildPrompt({ ...options(), series: grounded,
    evidenceBundle: { ...evidenceBundle, status: 'needs_review' } }), /Readable evidence/);
});

test('content replacements retain the learning intent and include original scenes and source evidence', () => {
  const evidenceBundle = { mode: 'required', status: 'ready', sourceHash: 'b'.repeat(64),
    sources: [{ id: 'stack', title: 'Stack reference', content: 'Peek does not remove the value.' }] };
  const prompt = buildReplacementPrompt({ ...options(), previous: candidate(),
    replacePlanIds: ['november-demo-01'], evidenceBundle,
    feedback: { kind: 'content', reason: 'The final headline contradicts the narration.' } });
  assert.match(prompt, /주제와 학습 목표를 유지/);
  assert.match(prompt, /잘못된 주장 자체는 유지하지/);
  assert.match(prompt, /Peek does not remove/);
  assert.match(prompt, /수정할 회차의 실제 대본·장면/);
  assert.match(prompt, /확인과 제거는 달라요/);
  assert.doesNotMatch(prompt, /실제 학습할 핵심 지식을 바꾸세요/);
});
