const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateSpec } = require('../story/spec.cjs');
const { outputSchema, buildPrompt, applyRevision } = require('./contract.cjs');

function source() {
  return { version: 1, title: '스택에서 확인과 제거', durationSeconds: 30,
    audience: '입문자', profile: { brand: '배우는 시간', speech: { voice: 'Microsoft Heami Desktop', rate: 1 } },
    narration: [
      { id: 'hook', text: '스택에서 확인하면 값이 사라질까요?' },
      { id: 'show', text: '에이를 넣은 뒤 그 위에 비를 넣었습니다.' },
      { id: 'peek', text: '비가 꼭대기에 있다는 것을 확인해도 두 값은 남습니다.' },
      { id: 'again', text: '다시 확인해도 여전히 비가 맨 위에 있습니다.' },
      { id: 'finish', text: '확인은 값을 보존하고, 꺼내기는 값을 제거합니다.' },
    ],
    scenes: [
      { id: 'question', type: 'question', from: 'hook', headline: '확인하면 사라질까?' },
      { id: 'values', type: 'cards', from: 'show', headline: 'A 위에 B', layout: 'stack',
        cards: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { id: 'read', type: 'cards', from: 'peek', headline: 'B를 읽어도 남아요', body: '두 카드를 그대로 둡니다.',
        layout: 'stack', cards: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], carry: ['a', 'b'],
        actions: [{ type: 'highlight', target: 'b', at: 'peek' }] },
      { id: 'result', type: 'conclusion', from: 'finish', headline: '확인과 제거는 달라요', body: '확인 · 그대로 두기\n꺼내기 · 제거하기' },
    ] };
}
const options = (scope = 'both', target = 'read') => ({ source: source(), request: { target, note: '핵심 문장을 더 짧게 해 주세요.' }, scope });
const patch = edits => ({ summary: '핵심 문장을 짧게 다듬었습니다.', edits });
const scene = (id = 'read', field = 'headline', value = '확인해도 그대로') => ({ section: 'scene', id, field, value });
const narration = (id = 'peek', value = '비가 맨 위에 있어도 확인은 값을 제거하지 않습니다.') => ({ section: 'narration', id, field: 'text', value });

test('a visual revision preserves narration, all production settings, IDs, layout and original input', () => {
  const args = options('visual');
  const before = structuredClone(args.source);
  const normalized = validateSpec(args.source);
  const result = applyRevision(patch([scene(), scene('read', 'body', null)]), args);
  assert.deepEqual(args.source, before);
  assert.deepEqual(result.story.narration, normalized.narration);
  assert.deepEqual(result.story.profile, normalized.profile);
  assert.equal(result.story.durationSeconds, normalized.durationSeconds);
  assert.equal(result.story.title, normalized.title);
  assert.deepEqual(result.story.scenes.map(({ headline, body, ...rest }) => rest), normalized.scenes.map(({ headline, body, ...rest }) => rest));
  assert.deepEqual(result.changes, [
    { section: 'scene', id: 'read', field: 'headline', before: 'B를 읽어도 남아요', after: '확인해도 그대로' },
    { section: 'scene', id: 'read', field: 'body', before: '두 카드를 그대로 둡니다.', after: null },
  ]);
  assert.equal(Object.hasOwn(result.story.scenes[2], 'body'), false);
});

test('scene narration scope includes all its cues and excludes both neighbouring scenes', () => {
  const args = options('narration');
  const result = applyRevision(patch([narration('again', '다시 읽어도 두 값은 남습니다.'), narration()]), args);
  assert.deepEqual(result.story.scenes, validateSpec(args.source).scenes);
  assert.deepEqual(result.changes.map(change => change.id), ['peek', 'again']);
  for (const id of ['show', 'finish', 'missing']) {
    assert.throws(() => applyRevision(patch([narration(id)]), args), /outside the requested scene/);
  }
});

test('episode scope permits several text targets and produces a deterministic source-order diff', () => {
  const args = options('both', 'episode');
  const edits = [narration('finish', '확인은 그대로, 꺼내기는 제거입니다.'), scene('result'), scene('question')];
  const first = applyRevision(patch(edits), args);
  const second = applyRevision(patch([...edits].reverse()), args);
  assert.deepEqual(first, second);
  assert.deepEqual(first.changes.map(({ section, id }) => [section, id]), [['scene', 'question'], ['scene', 'result'], ['narration', 'finish']]);
});

test('scope and target validation block unrelated changes and unsupported target names', () => {
  assert.throws(() => applyRevision(patch([narration()]), options('visual')), /visual-only/);
  assert.throws(() => applyRevision(patch([scene()]), options('narration')), /narration-only/);
  assert.throws(() => applyRevision(patch([scene('result')]), options()), /outside the requested target/);
  assert.throws(() => applyRevision(patch([scene()]), options('invalid')), /scope/);
  assert.throws(() => buildPrompt(options('both', '마지막 장면')), /exact scene ID or episode/);
  assert.throws(() => buildPrompt({ ...options(), request: { target: 'read', note: ' ' } }), /note/);
});

test('strict patch schema rejects protected settings, new IDs, duplicate edits and unsupported fields', () => {
  const changes = [
    value => { value.profile = { speech: { rate: 10 } }; },
    value => { value.edits[0].field = 'layout'; },
    value => { value.edits[0].section = 'profile'; },
    value => { value.edits[0].command = 'execute'; },
    value => { value.edits[0].id = '../path'; },
    value => { value.edits[0].id = 'new-scene'; },
    value => { value.edits.push({ ...value.edits[0] }); },
    value => { value.edits[0].field = 'text'; },
    value => { value.edits[0].value = null; },
    value => { delete value.edits[0].value; },
  ];
  for (const change of changes) {
    const value = patch([scene()]);
    change(value);
    assert.throws(() => applyRevision(value, options()), change.toString());
  }
  assert.throws(() => applyRevision(patch([{ ...narration(), field: 'body' }]), options()), /text field only/);
});

test('empty, unchanged and normalization-only edits are rejected as no-ops', () => {
  assert.throws(() => applyRevision({ summary: '카드 이동 속도는 이 단계에서 지원하지 않습니다.', edits: [] }, options()),
    { code: 'REVISION_UNSUPPORTED', message: /No applicable text edits.*카드 이동/ });
  assert.throws(() => applyRevision(patch([scene('read', 'headline', ' B를 읽어도 남아요 ')]), options()), /no change after normalization/);
  assert.throws(() => applyRevision(patch([scene('question', 'body', null)]), options('both', 'episode')), /no change/);
  assert.throws(() => applyRevision(patch([narration('peek', ' 비가  꼭대기에 있다는 것을 확인해도 두 값은 남습니다. ')]), options()), /no change/);
});

test('final rendering and speech constraints reject oversized or unspoken text', () => {
  assert.throws(() => applyRevision(patch([scene('read', 'headline', '한'.repeat(15))]), options()), /Headline/);
  for (const value of [null, '...', '😀', '  ', '텍스트\u0000']) {
    assert.throws(() => applyRevision(patch([narration('peek', value)]), options()));
  }
  const updated = applyRevision(patch([narration('peek', '비가  맨 위에 있습니다.\n읽어도 남습니다.')]), options());
  assert.equal(updated.changes[0].after, '비가 맨 위에 있습니다. 읽어도 남습니다.');
});

test('schema requires every object property and forbids additions', () => {
  const visit = schema => {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(visit);
    }
    if (schema.type === 'array') visit(schema.items);
  };
  visit(outputSchema);
});

test('highlighted cue revisions preserve the first spoken token while ordinary cues remain flexible', () => {
  for (const text of ['확인하면 비가 맨 위에 있습니다.', '비를 확인해도 값은 그대로입니다.']) {
    assert.throws(() => applyRevision(patch([narration('peek', text)]), options('narration')),
      /Highlighted narration cue 'peek'.*first spoken token '비가'/);
  }
  assert.doesNotThrow(() => applyRevision(patch([narration('peek', '“비가” 맨 위에 있음을 확인합니다.')]), options('narration')));
  assert.doesNotThrow(() => applyRevision(patch([narration('again', '이어서 다시 확인해도 두 값이 남습니다.')]), options('narration')));
  const normalized = options('narration');
  normalized.source.narration[2].text = 'Ｂ가 맨 위에 있습니다.';
  assert.doesNotThrow(() => applyRevision(patch([narration('peek', 'B가 맨 위에 있고 그대로 남습니다.')]), normalized));
  assert.ok(buildPrompt(options('narration')).includes('"firstSpokenToken": "비가"'));
});

test('prompt contains exact editable scope, immutable source, real timing limits and original-relative repair feedback', () => {
  const args = options('narration');
  const original = structuredClone(args.source);
  const prompt = buildPrompt({ ...args, feedback: 'Measured speech=31s', previous: patch([narration()]) });
  assert.ok(prompt.includes('"narrationIds": [\n    "peek",\n    "again"\n  ]'));
  assert.ok(prompt.includes('"sceneIds": []'));
  assert.ok(prompt.includes('24–29초'));
  assert.ok(prompt.includes('Measured speech=31s'));
  assert.ok(prompt.includes('항상 아래 원본 회차에 직접 적용되는 완전한 패치'));
  assert.ok(prompt.includes('edits=[]'));
  assert.deepEqual(args.source, original);
});
