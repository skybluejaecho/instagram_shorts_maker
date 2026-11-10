const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVisualReview } = require('./policy.cjs');
const { createSamplePlan, analyzeLayout, renderReportHtml } = require('./checker.cjs');

const rect = (x, y, width, height) => ({ x, y, width, height });
function element(id, role, sceneId, bounds, text = '설명을 확인해요') {
  return { id, role, sceneId, text, rect: bounds, textRects: [{ ...bounds }], fontSize: role === 'headline' ? 80 : 42,
    lineHeight: 96, opacity: 1, visible: true, clipRects: [rect(0, 0, 1080, 1920)],
    clientWidth: bounds.width, clientHeight: bounds.height, scrollWidth: bounds.width, scrollHeight: bounds.height };
}

function fixture(options = {}) {
  const timeline = options.timeline || { scenes: [
    { id: 'intro', start: 0, end: 5, transitionSeconds: .55 },
    { id: 'ending', start: 5, end: 10, transitionSeconds: .55 },
  ] };
  const policy = normalizeVisualReview(options.policy);
  const capture = { width: 1080, height: 1920, browser: { name: 'unit-fixture' }, samples: createSamplePlan(timeline, policy).map(sample => ({
    ...sample, screenshot: 'frames/' + sample.id + '.png', rootRect: rect(0, 0, 1080, 1920), elements: [
      element('headline-' + sample.sceneId, 'headline', sample.sceneId, rect(100, 500, 500, 100), '스택의 순서'),
      element('body-' + sample.sceneId, 'body', sample.sceneId, rect(100, 1380, 500, 70), '나중에 넣은 값부터'),
      element('brand', 'brand', undefined, rect(100, 184, 180, 50), 'CS 한 장'),
    ],
  })) };
  return { timeline, policy, capture };
}

function stableSamples(value) { return value.capture.samples.filter(sample => sample.phase === 'stable'); }
function move(item, bounds) {
  Object.assign(item, { rect: bounds, textRects: [{ ...bounds }], clientWidth: bounds.width, clientHeight: bounds.height,
    scrollWidth: bounds.width, scrollHeight: bounds.height });
}

test('visual policy merges per-series thresholds, is immutable, and rejects unsafe numbers or typo settings', () => {
  const partial = { safeArea: { left: 80 }, minFontPx: { headline: 60 } };
  const original = structuredClone(partial);
  const result = normalizeVisualReview(partial);
  assert.equal(result.mode, 'required');
  assert.equal(result.safeArea.left, 80);
  assert.equal(result.safeArea.right, 96);
  assert.equal(result.minFontPx.headline, 60);
  assert.deepEqual(partial, original);
  result.safeArea.right = 500;
  assert.equal(normalizeVisualReview().safeArea.right, 96);
  for (const invalid of [null, [], { mode: 'warning' }, { safeArea: { left: 600, right: 600 } }, { safeArea: { top: -1 } },
    { minFontPx: { card: 0 } }, { minFontPx: { typo: 30 } }, { charsPerSecond: Infinity }, { charsPerSecond: '12' },
    { minSceneSeconds: 0 }, { overlapTolerancePx: -1 }, { minFont: 20 }]) assert.throws(() => normalizeVisualReview(invalid));
});

test('sampling separates stable views from transitions and requires contiguous finite timelines', () => {
  const value = fixture();
  const first = createSamplePlan(value.timeline, value.policy);
  assert.deepEqual(first, createSamplePlan(value.timeline, value.policy));
  assert.equal(first.length, 12);
  assert.equal(first[0].id, 'scene-01-transition-1');
  assert.deepEqual(first.filter(sample => sample.sceneId === 'intro' && sample.phase === 'stable').map(sample => sample.timeSeconds), [.8, 2.8, 4.8]);
  for (const change of [scene => { scene.start = .1; }, scene => { scene.end = Infinity; }, scene => { scene.transitionSeconds = NaN; }, scene => { scene.id = '../escape'; }]) {
    const timeline = structuredClone(value.timeline);
    change(timeline.scenes[0]);
    assert.throws(() => createSamplePlan(timeline, value.policy));
  }
  assert.deepEqual(createSamplePlan(value.timeline, { mode: 'off' }), []);
});

test('normal scene measurements pass and produce escaped standalone HTML with per-scene screenshots', () => {
  const value = fixture();
  const before = structuredClone(value);
  const report = analyzeLayout(value);
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.counts, { errors: 0, warnings: 0 });
  assert.equal(report.scenes.length, 2);
  assert.equal(report.scenes[0].representativeSampleId, 'scene-01-stable-2');
  assert.deepEqual(value, before);
  report.limitations.push('<script>alert(1)</script>');
  const html = renderReportHtml(report);
  assert.match(html, /frames\/scene-01-stable-2\.png/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  report.scenes[0].screenshot = 'https://example.com/tracker.png';
  assert.throws(() => renderReportHtml(report), /relative/);
});

test('off policy is disabled and never masquerades as a successful visual inspection', () => {
  const value = fixture();
  const result = analyzeLayout({ timeline: value.timeline, policy: { mode: 'off' } });
  assert.equal(result.status, 'disabled');
  assert.deepEqual(result.samples, []);
});

test('viewport and safe-area escapes fail stable scenes with precise time, element and rectangle evidence', () => {
  const value = fixture();
  move(stableSamples(value)[0].elements[0], rect(-40, 500, 500, 100));
  move(stableSamples(value)[1].elements[1], rect(100, 1710, 500, 80));
  const report = analyzeLayout(value);
  assert.equal(report.status, 'failed');
  const viewport = report.issues.find(issue => issue.code === 'outside_viewport');
  const safe = report.issues.find(issue => issue.code === 'outside_safe_area');
  assert.deepEqual(viewport.elementIds, ['headline-intro']);
  assert.equal(viewport.timeSeconds, .8);
  assert.equal(viewport.rects[0].x, -40);
  assert.equal(safe.sceneId, 'intro');
  const html = renderReportHtml(report);
  assert.match(html, /<svg aria-label="문제 위치 표시"/);
  assert.match(html, /<code>headline-intro<\/code>/);
  assert.match(html, /aria-label="위치 표시 범례"/);
  assert.equal(html.includes('<text '), false);
  assert.match(html, /전체 검사 시점과 전환 화면/);
});

test('text clipping and long glyph overflow fail even when the containing box fits the viewport', () => {
  const value = fixture();
  const clipped = stableSamples(value)[0].elements[1];
  clipped.clipRects.push(rect(100, 1380, 250, 70));
  const overflow = stableSamples(value)[1].elements[0];
  overflow.textRects = [rect(100, 500, 720, 100)];
  overflow.scrollWidth = 720;
  const report = analyzeLayout(value);
  assert.equal(report.status, 'failed');
  assert.ok(report.issues.some(issue => issue.code === 'text_clipped'));
  assert.ok(report.issues.some(issue => issue.code === 'text_overflow'));
});

test('normal Korean ascent/descent overhang is allowed when auto-height text is not clipped', () => {
  const value = fixture();
  for (const sample of stableSamples(value)) {
    const headline = sample.elements[0];
    Object.assign(headline, { rect: rect(96, 590, 804, 255.375),
      textRects: [rect(96, 585, 559.453125, 136), rect(96, 712.6875, 779.234375, 136)],
      fontSize: 102.16, lineHeight: 127.7, clientWidth: 804, clientHeight: 255, scrollWidth: 804, scrollHeight: 259 });
    const brand = sample.elements[2];
    Object.assign(brand, { rect: rect(96, 184, 804, 50.390625), textRects: [rect(96, 181, 158.125, 56)],
      fontSize: 42, lineHeight: 50.4, clientWidth: 804, clientHeight: 50, scrollWidth: 804, scrollHeight: 53 });
  }
  const report = analyzeLayout(value);
  assert.equal(report.status, 'passed');
  // The same measured glyphs really are clipped if an explicit clipping box is added.
  const headline = stableSamples(value)[0].elements[0];
  headline.clipRects.push(rect(96, 590, 804, 100));
  assert.ok(analyzeLayout(value).issues.some(issue => issue.code === 'text_clipped'));
});

test('fixed card boxes still reject vertical text overflow', () => {
  const value = fixture();
  const sample = stableSamples(value)[0];
  const card = element('card-small', 'card', sample.sceneId, rect(300, 900, 350, 50), 'A');
  card.textRects = [rect(320, 880, 120, 100)];
  card.scrollHeight = 100;
  sample.elements.push(card);
  assert.ok(analyzeLayout(value).issues.some(issue => issue.code === 'text_overflow' && issue.elementIds.includes('card-small')));
});

test('font size and intentional-looking overlap remain warnings with configurable thresholds', () => {
  const value = fixture();
  const first = stableSamples(value)[0];
  first.elements[0].fontSize = 40;
  move(first.elements[1], rect(200, 530, 300, 70));
  const report = analyzeLayout(value);
  assert.equal(report.status, 'warnings');
  assert.equal(report.counts.errors, 0);
  assert.ok(report.issues.some(issue => issue.code === 'small_font'));
  assert.ok(report.issues.some(issue => issue.code === 'element_overlap'));
  const relaxed = analyzeLayout({ ...value, policy: { ...value.policy, minFontPx: { ...value.policy.minFontPx, headline: 30 } } });
  assert.equal(relaxed.issues.some(issue => issue.code === 'small_font'), false);
});

test('box overlap alone does not warn for disjoint real text, and inactive copies are ignored', () => {
  const value = fixture();
  for (const sample of stableSamples(value)) {
    move(sample.elements[1], rect(100, 500, 500, 100));
    sample.elements[0].textRects = [rect(100, 500, 100, 40)];
    sample.elements[1].textRects = [rect(350, 550, 100, 40)];
    const hidden = element('old-title', 'headline', 'old', rect(-1000, -1000, 500, 100));
    hidden.opacity = .3;
    sample.elements.push(hidden);
  }
  const report = analyzeLayout(value);
  assert.equal(report.status, 'passed');
});

test('expected entrance/exit positions cannot hard-fail transitions, but card collisions warn', () => {
  const value = fixture();
  const sample = value.capture.samples.find(sample => sample.phase === 'transition');
  move(sample.elements[0], rect(-700, 500, 500, 100));
  sample.elements.push(element('card-a', 'card', sample.sceneId, rect(300, 900, 350, 132), 'A'));
  sample.elements.push(element('card-b', 'card', sample.sceneId, rect(350, 940, 350, 132), 'B'));
  const report = analyzeLayout(value);
  assert.equal(report.status, 'warnings');
  assert.equal(report.counts.errors, 0);
  assert.ok(report.issues.some(issue => issue.code === 'transition_overlap' && issue.phase === 'transition'));
});

test('short scenes, no settled sampling window and insufficient reading time warn rather than silently pass', () => {
  const value = fixture({ timeline: { scenes: [{ id: 'short', start: 0, end: 1, transitionSeconds: .55 }] } });
  for (const sample of value.capture.samples) sample.elements[0].text = '스택은 같은 끝에서 추가하고 마지막에 넣은 값을 먼저 꺼내는 자료구조입니다';
  const report = analyzeLayout(value);
  assert.equal(report.status, 'warnings');
  assert.ok(report.issues.some(issue => issue.code === 'no_stable_window'));
  assert.ok(report.issues.some(issue => issue.code === 'short_scene'));
  assert.ok(report.issues.some(issue => issue.code === 'reading_time'));
  assert.equal(report.scenes[0].stableSeconds, 0);
});

test('missing visible stable headline fails even with structurally complete measurements', () => {
  const value = fixture();
  stableSamples(value)[0].elements[0].visible = false;
  const report = analyzeLayout(value);
  assert.equal(report.status, 'failed');
  assert.ok(report.issues.some(issue => issue.code === 'missing_visible_headline'));
  const blank = fixture();
  stableSamples(blank)[0].elements[0].text = ' ';
  stableSamples(blank)[0].elements[0].textRects = [];
  assert.ok(analyzeLayout(blank).issues.some(issue => issue.code === 'missing_visible_headline'));
});

test('missing, forged or nonfinite browser samples cannot be accepted as a visual pass', async t => {
  const changes = {
    missing: value => { value.capture.samples.pop(); },
    duplicate: value => { value.capture.samples[1] = value.capture.samples[0]; },
    wrongTime: value => { value.capture.samples[0].timeSeconds += 1; },
    wrongPhase: value => { value.capture.samples[0].phase = 'stable'; },
    wrongSize: value => { value.capture.width = 540; },
    rootShifted: value => { value.capture.samples[0].rootRect.x = 50; },
    noElements: value => { value.capture.samples[0].elements = []; },
    missingHeadline: value => { value.capture.samples[0].elements.shift(); },
    repeatedElement: value => { value.capture.samples[0].elements.push(value.capture.samples[0].elements[0]); },
    nonfiniteGlyph: value => { value.capture.samples[0].elements[0].textRects[0].x = NaN; },
    missingRect: value => { delete value.capture.samples[0].elements[0].textRects; },
    badFont: value => { value.capture.samples[0].elements[0].fontSize = -1; },
    escapedImage: value => { value.capture.samples[0].screenshot = '../secret.png'; },
  };
  for (const [name, mutate] of Object.entries(changes)) await t.test(name, () => {
    const value = fixture(); mutate(value); assert.throws(() => analyzeLayout(value));
  });
});
