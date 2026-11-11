const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateSpec, validateTiming } = require('./story/spec.cjs');
const { buildHtml } = require('./story/render.cjs');
const { createStages } = require('./story/adapter.cjs');
const { registerSeries: registerActualSeries, addPlans, createBatchFromPlans, readCatalog } = require('./planning.cjs');
// Registration probes only the injected local voice inventory in these logic tests.
const registerSeries = (root, spec) => registerActualSeries(root, spec, {
  listVoices: async () => [{ name: 'Microsoft Heami Desktop', culture: 'ko-KR', enabled: true }],
});

function episode() {
  return {
    version: 1, title: '스택의 순서', durationSeconds: 30,
    narration: [
      { id: 'hook', text: '스택은 어떤 순서로 꺼낼까요?' },
      { id: 'idea', text: '마지막에 넣은 값이 먼저 나옵니다.' },
      { id: 'show', text: '첫째를 넣고 둘째를 넣습니다.' },
      { id: 'move', text: '둘째를 먼저 꺼냅니다.' },
      { id: 'finish', text: '마지막 입력이 먼저 나오는 순서입니다.' },
    ],
    scenes: [
      { id: 'question', type: 'question', from: 'hook', headline: '무엇이 먼저 나올까요?' },
      { id: 'explain', type: 'explanation', from: 'idea', headline: '마지막 입력부터', body: '카드 두 장으로 확인해요.' },
      { id: 'insert', type: 'cards', from: 'show', headline: '차례로 넣기', layout: 'row',
        cards: [{ id: 'a', label: '첫째' }, { id: 'b', label: '둘째' }],
        actions: [{ type: 'highlight', target: 'a', at: 'show' }] },
      { id: 'remove', type: 'cards', from: 'move', headline: '둘째가 먼저', layout: 'row',
        cards: [{ id: 'a', label: '첫째' }, { id: 'b', label: '둘째' }], carry: ['a', 'b'],
        actions: [{ type: 'highlight', target: 'b', at: 'move' }] },
      { id: 'result', type: 'conclusion', from: 'finish', headline: '마지막 입력부터 꺼내기' },
    ],
  };
}

function audio(spec, starts = [0.1, 4.2, 9.3, 14.4, 21.5]) {
  const wav = Buffer.from('deterministic fixture audio bytes');
  return { wav, timing: {
    voice: 'Microsoft Heami Desktop', rate: 2, durationSeconds: 24,
    text: spec.narration.map(cue => cue.text.trim()).join(' '),
    audioSha256: createHash('sha256').update(wav).digest('hex'),
    marks: Object.fromEntries(spec.narration.map((cue, i) => [cue.id, starts[i] - 0.05])),
    wordStarts: Object.fromEntries(spec.narration.map((cue, i) => [cue.id, starts[i]])),
  } };
}

function temporary(t) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-story-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-story-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function planningFixture(t) {
  const root = temporary(t);
  const pipeline = path.join(root, 'pipeline');
  fs.mkdirSync(pipeline);
  fs.cpSync(path.join(__dirname, 'story'), path.join(pipeline, 'story'), { recursive: true });
  fs.cpSync(path.join(__dirname, 'visual'), path.join(pipeline, 'visual'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'media-stages.cjs'), path.join(pipeline, 'media-stages.cjs'));
  fs.writeFileSync(path.join(pipeline, 'episodes.json'), '{}');
  fs.writeFileSync(path.join(pipeline, 'batches.json'), '{}');
  return root;
}

test('story validation rejects unusable scenes and references before any production command', () => {
  assert.doesNotThrow(() => validateSpec(episode()));
  const invalidChanges = [
    spec => { delete spec.title; },
    spec => { spec.scenes[0].type = 'arbitrary-html'; },
    spec => { spec.scenes[1].from = 'missing-cue'; },
    spec => { spec.scenes[3].actions[0].at = 'show'; },
    spec => { spec.scenes[3].actions[0].target = 'missing-card'; },
    spec => { spec.scenes[3].carry = ['missing-card']; },
    spec => { spec.scenes[2].carry = ['a']; },
    spec => { spec.scenes[3].cards[0].label = '다른 값'; },
    spec => { spec.scenes[3].cards.reverse(); },
    spec => { spec.scenes[2].layout = 'stack'; spec.scenes[3].layout = 'stack'; spec.scenes[3].cards.reverse(); },
    spec => { spec.narration[1].id = spec.narration[0].id; },
    spec => { spec.scenes[1].headline = '가'.repeat(500); },
    spec => { spec.profile = { colors: { background: 'red; background:url(secret)' } }; },
    spec => { spec.profile = { fontFamily: 'Malgun Gothic; color:red' }; },
    spec => { spec.profile = { transitionSeconds: -1 }; },
    spec => { spec.scenes[0].headine = 'misspelled field'; },
    spec => { spec.narration[0].test = 'misspelled field'; },
    spec => { spec.profile = { transitionSecond: 0.55 }; },
    spec => { spec.scenes[2].actions[0].cue = 'show'; },
  ];
  for (const change of invalidChanges) {
    const invalid = episode();
    change(invalid);
    assert.throws(() => validateSpec(invalid), change.toString());
  }
});

test('speech timeline validation binds cue times and script to the exact audio', () => {
  const spec = validateSpec(episode());
  const { wav, timing } = audio(spec);
  assert.doesNotThrow(() => validateTiming(spec, timing, wav));
  assert.throws(() => validateTiming(spec, timing, Buffer.from('different audio')));
  const changes = [
    value => { value.text += ' another script'; },
    value => { delete value.wordStarts.show; },
    value => { value.wordStarts.move = 2; },
    value => { value.marks.hook = -0.1; },
    value => { value.durationSeconds = 31; },
    value => { value.wordStarts.finish = 28; },
  ];
  for (const change of changes) {
    const invalid = structuredClone(timing);
    change(invalid);
    assert.throws(() => validateTiming(spec, invalid, wav), change.toString());
  }
});

test('the same renderer builds different episode content and escapes markup', () => {
  const first = validateSpec(episode());
  const secondInput = episode();
  secondInput.title = '큐의 순서';
  secondInput.scenes[0].headline = '<b>큐 & 순서</b>';
  secondInput.scenes[1].headline = '먼저 들어온 값부터';
  const second = validateSpec(secondInput);
  const one = buildHtml(first, audio(first).timing);
  const two = buildHtml(second, audio(second).timing);
  assert.notEqual(one.html, two.html);
  assert.match(two.html, /&lt;b&gt;큐 &amp; 순서&lt;\/b&gt;/);
  assert.equal(two.html.includes('<b>큐 & 순서</b>'), false);
  assert.match(one.html, /data-width="1080"/);
  assert.match(one.html, /data-height="1920"/);
  assert.match(one.html, /data-fps="30"/);
  assert.equal((one.html.match(/data-card-id="a"/g) || []).length, 1);
  assert.equal((one.html.match(/data-card-id="b"/g) || []).length, 1);
  assert.equal(one.timeline.cards.find(card => card.id === 'a').poses.find(pose => pose.sceneId === 'remove').carried, true);
  assert.equal(one.timeline.actions.find(action => action.cue === 'move').at, audio(first).timing.wordStarts.move);
  assert.equal(/NaN|undefined/.test(one.html), false);
});

test('a newly entering card can be highlighted after carried cards settle', () => {
  const input = episode();
  input.narration.splice(4, 0, { id: 'settled', text: '셋째를 강조합니다.' });
  input.scenes[3].cards.push({ id: 'c', label: '셋째' });
  input.scenes[3].actions = [{ type: 'highlight', target: 'c', at: 'move' }];
  const starts = [0.1, 4.2, 9.3, 14.4, 15.2, 21.5];
  const early = validateSpec(input);
  const earlyAudio = audio(early, starts);
  assert.throws(() => validateTiming(early, earlyAudio.timing, earlyAudio.wav));
  input.scenes[3].actions[0].at = 'settled';
  const settled = validateSpec(input);
  const validAudio = audio(settled, starts);
  assert.doesNotThrow(() => validateTiming(settled, validAudio.timing, validAudio.wav));
});

test('visual edits preserve the speech input while narration edits invalidate it', t => {
  const root = temporary(t);
  const file = path.join(root, 'episode.json');
  const input = episode();
  const stages = () => {
    fs.writeFileSync(file, JSON.stringify(input));
    return createStages({ root, sampleDir: path.join(__dirname, 'story'), episodeFile: file, tools: {} });
  };
  const original = stages();
  assert.deepEqual(original.map(stage => stage.id), ['speech', 'prepare', 'visual', 'render', 'verify']);
  const speech = original[0].inputs();
  const visual = original[1].inputs();
  input.scenes[0].headline = '어느 카드가 먼저일까요?';
  const changedVisual = stages();
  assert.deepEqual(changedVisual[0].inputs(), speech);
  assert.notDeepEqual(changedVisual[1].inputs(), visual);
  input.narration[0].text = '스택에서 어느 카드가 먼저 나올까요?';
  assert.notDeepEqual(stages()[0].inputs(), speech);
});

test('carried cards stay separated throughout stack and row layout changes', () => {
  const interpolate = (from, to, fraction) => Object.fromEntries(['x', 'y', 'width', 'height']
    .map(field => [field, from[field] + (to[field] - from[field]) * fraction]));
  const separated = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x ||
    a.y + a.height <= b.y || b.y + b.height <= a.y;
  for (const [beforeCount, afterCount] of [[2, 2], [4, 4], [4, 3], [3, 2]]) {
    for (const fromLayout of ['stack', 'row']) {
      const input = episode();
      const from = input.scenes[2];
      const to = input.scenes[3];
      from.layout = fromLayout;
      to.layout = fromLayout === 'stack' ? 'row' : 'stack';
      from.cards = ['a', 'b', 'c', 'd'].slice(0, beforeCount).map(id => ({ id, label: id.toUpperCase() }));
      to.cards = from.cards.slice(0, afterCount).reverse();
      to.carry = to.cards.map(card => card.id);
      const spec = validateSpec(input);
      const { timeline } = buildHtml(spec, audio(spec).timing);
      const carried = to.carry.map(id => {
        const poses = timeline.cards.find(card => card.id === id).poses;
        const start = poses.find(pose => pose.sceneId === from.id);
        const finish = poses.find(pose => pose.sceneId === to.id);
        assert.ok(finish.waypoint, `${fromLayout} to ${to.layout} needs a separated intermediate position`);
        assert.equal(finish.waypoint.at, finish.start + spec.profile.transitionSeconds / 2);
        return [start, finish.waypoint, finish];
      });
      for (const phase of [0, 1]) {
        for (let sample = 0; sample <= 20; sample++) {
          const boxes = carried.map(poses => interpolate(poses[phase], poses[phase + 1], sample / 20));
          for (let left = 0; left < boxes.length; left++) {
            for (let right = left + 1; right < boxes.length; right++) {
              assert.ok(separated(boxes[left], boxes[right]),
                `${fromLayout} to ${to.layout}, ${beforeCount}→${afterCount} cards, phase ${phase}, step ${sample}`);
            }
          }
        }
      }
    }
  }
});

test('planning refuses to publish a batch containing an invalid story input', async t => {
  const root = planningFixture(t);
  await registerSeries(root, { id: 'cs', name: 'CS', audience: '입문자', topics: ['자료구조'],
    defaultDurationSeconds: 30, tone: '간결한 설명', adapter: 'pipeline/story/adapter.cjs' });
  const invalid = episode();
  invalid.scenes[0].from = 'unknown';
  fs.writeFileSync(path.join(root, 'invalid.json'), JSON.stringify(invalid));
  await addPlans(root, 'cs', [{ id: 'first', title: '스택', topicKey: 'stack', objective: '스택 순서',
    angle: '두 장의 카드', references: [], input: 'invalid.json' }]);
  const before = readCatalog(root);
  await assert.rejects(createBatchFromPlans(root, 'cs', 'blocked', { planIds: ['first'] }));
  assert.deepEqual(readCatalog(root), before);
  assert.deepEqual(readCatalog(root).episodes, {});
});

test('series rendering settings reach generated stories while explicit episode profiles take precedence', async t => {
  const root = planningFixture(t);
  const renderProfile = { brand: '자료구조', fontFamily: 'Arial', colors: { accent: '#e2b65c' }, transitionSeconds: 0.8 };
  await registerSeries(root, { id: 'cs', name: 'CS', audience: '입문자', topics: ['자료구조'],
    defaultDurationSeconds: 30, tone: '간결한 설명', adapter: 'pipeline/story/adapter.cjs', renderProfile });
  const base = episode();
  const override = { ...episode(), profile: { brand: '회차 자체', colors: { accent: '#76aaff' }, transitionSeconds: 0.3 } };
  fs.writeFileSync(path.join(root, 'inherited.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(root, 'override.json'), JSON.stringify(override));
  await addPlans(root, 'cs', ['inherited', 'override'].map(id => ({ id, title: id, topicKey: id,
    objective: '자료구조 설명', angle: '카드 예시', references: [], input: id + '.json' })));
  await createBatchFromPlans(root, 'cs', 'theme-check', { planIds: ['inherited', 'override'] });
  const catalog = readCatalog(root);
  const generated = id => JSON.parse(fs.readFileSync(path.join(root, catalog.episodes['cs-' + id].episode), 'utf8'));
  assert.deepEqual(generated('inherited').profile, renderProfile);
  assert.deepEqual(generated('override').profile, override.profile);
  const inheritedSpec = validateSpec(generated('inherited'));
  const rendered = buildHtml(inheritedSpec, audio(inheritedSpec).timing);
  assert.match(rendered.html, /#e2b65c/);
  assert.match(rendered.html, /자료구조/);
  assert.ok(rendered.timeline.scenes.every(scene => scene.transitionSeconds === 0.8));
});
