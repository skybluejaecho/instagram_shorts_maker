const { normalizeVisualReview, WIDTH, HEIGHT } = require('./policy.cjs');

const round = value => Number(value.toFixed(6));
const EPSILON = .00001;
const BOUNDS_TOLERANCE = 2;
const roles = ['headline', 'body', 'card', 'brand'];

function finite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
}

function scenesOf(timeline) {
  if (!timeline || !Array.isArray(timeline.scenes) || timeline.scenes.length < 1 || timeline.scenes.length > 12) throw new Error('Visual checking requires 1–12 timeline scenes.');
  const seen = new Set();
  let end = 0;
  for (const scene of timeline.scenes) {
    if (typeof scene.id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(scene.id) || seen.has(scene.id)) throw new Error('Visual timeline scene IDs must be unique and safe.');
    seen.add(scene.id);
    for (const key of ['start', 'end', 'transitionSeconds']) finite(scene[key], `Scene ${scene.id} ${key}`);
    if (Math.abs(scene.start - end) > EPSILON || scene.end <= scene.start || scene.start < 0 || scene.end > 90 || scene.transitionSeconds <= 0 || scene.transitionSeconds > 1.5) {
      throw new Error('Visual timeline must be contiguous, ordered and within 90 seconds with positive transitions.');
    }
    end = scene.end;
  }
  return timeline.scenes;
}

function stableWindow(scene) {
  const start = scene.start + scene.transitionSeconds + .25;
  const end = scene.end - .2;
  return { start, end, available: Math.max(0, end - start) };
}

function createSamplePlan(timeline, policy) {
  const settings = normalizeVisualReview(policy);
  const scenes = scenesOf(timeline);
  if (settings.mode === 'off') return [];
  const samples = [];
  for (const [index, scene] of scenes.entries()) {
    const prefix = 'scene-' + String(index + 1).padStart(2, '0');
    const add = (phase, ordinal, time) => samples.push({ id: `${prefix}-${phase}-${ordinal}`, sceneId: scene.id, phase, timeSeconds: round(time) });
    for (const [i, fraction] of [.25, .5, .9].entries()) add('transition', i + 1,
      scene.start + Math.min(scene.transitionSeconds * fraction, (scene.end - scene.start) * .9));
    const window = stableWindow(scene);
    if (window.available > EPSILON) {
      [window.start, (window.start + window.end) / 2, window.end].forEach((time, i) => add('stable', i + 1, time));
    }
  }
  return samples;
}

function rectangle(value, label) {
  if (!value || typeof value !== 'object') throw new Error(`${label} needs a rectangle.`);
  for (const key of ['x', 'y', 'width', 'height']) finite(value[key], `${label}.${key}`);
  if (value.width < 0 || value.height < 0) throw new Error(`${label} has negative dimensions.`);
  return value;
}

function union(rects) {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map(rect => rect.x));
  const y = Math.min(...rects.map(rect => rect.y));
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x,
    height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
}

function outside(inner, outer, tolerance = BOUNDS_TOLERANCE) {
  return inner.x < outer.x - tolerance || inner.y < outer.y - tolerance ||
    inner.x + inner.width > outer.x + outer.width + tolerance || inner.y + inner.height > outer.y + outer.height + tolerance;
}

function intersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

function validateCapture(capture, expected) {
  if (!capture || capture.width !== WIDTH || capture.height !== HEIGHT || !Array.isArray(capture.samples) || capture.samples.length !== expected.length) {
    throw new Error('Visual capture must cover every planned sample at 1080×1920.');
  }
  const ids = new Set();
  for (const sample of capture.samples) {
    const planned = expected.find(item => item.id === sample.id);
    if (!planned || ids.has(sample.id) || planned.sceneId !== sample.sceneId || planned.phase !== sample.phase ||
        !Number.isFinite(sample.timeSeconds) || Math.abs(planned.timeSeconds - sample.timeSeconds) > EPSILON) throw new Error('Visual capture contains a missing, repeated or mismatched sample.');
    ids.add(sample.id);
    if (typeof sample.screenshot !== 'string' || !/^frames\/[a-z0-9_-]+\.png$/.test(sample.screenshot)) throw new Error('Visual sample screenshot must be a safe relative frames/*.png path.');
    const root = rectangle(sample.rootRect, 'Composition');
    if (Math.abs(root.x) > EPSILON || Math.abs(root.y) > EPSILON || Math.abs(root.width - WIDTH) > EPSILON || Math.abs(root.height - HEIGHT) > EPSILON) {
      throw new Error('Composition bounds do not match the intended viewport.');
    }
    if (!Array.isArray(sample.elements) || !sample.elements.length) throw new Error('Visual capture cannot have empty element measurements.');
    const elementIds = new Set();
    for (const element of sample.elements) {
      if (typeof element.id !== 'string' || !element.id.trim() || elementIds.has(element.id) || !roles.includes(element.role) ||
          typeof element.text !== 'string' || typeof element.visible !== 'boolean') throw new Error('Invalid or duplicate visual element measurement.');
      elementIds.add(element.id);
      rectangle(element.rect, 'Element');
      if (!Array.isArray(element.textRects) || !Array.isArray(element.clipRects)) throw new Error('Visual elements require text and clipping rectangles.');
      element.textRects.forEach(rect => rectangle(rect, 'Text'));
      element.clipRects.forEach(rect => rectangle(rect, 'Clip'));
      for (const key of ['fontSize', 'lineHeight', 'opacity', 'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight']) finite(element[key], `Element ${key}`);
      if (element.fontSize <= 0 || element.lineHeight <= 0 || element.opacity < 0 || element.opacity > 1 + EPSILON ||
          ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight'].some(key => element[key] < 0)) throw new Error('Invalid visual element size or opacity.');
    }
    if (!sample.elements.some(element => element.role === 'headline' && element.sceneId === sample.sceneId)) throw new Error('Visual capture is missing the expected scene headline.');
  }
}

function textUnits(text) {
  return [...text].reduce((sum, char) => /[\p{L}\p{N}]/u.test(char) ? sum + (char.codePointAt(0) < 128 ? .55 : 1) : sum, 0);
}

function analyzeLayout({ timeline, policy, capture }) {
  const settings = normalizeVisualReview(policy);
  const scenes = scenesOf(timeline);
  if (settings.mode === 'off') return { version: 1, status: 'disabled', policy: settings, issues: [], counts: { errors: 0, warnings: 0 }, scenes: [], samples: [] };
  const expected = createSamplePlan(timeline, settings);
  validateCapture(capture, expected);
  const viewport = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  const safe = { x: settings.safeArea.left, y: settings.safeArea.top,
    width: WIDTH - settings.safeArea.left - settings.safeArea.right,
    height: HEIGHT - settings.safeArea.top - settings.safeArea.bottom };
  const issues = [];
  const add = (sample, severity, code, elementIds, reason, rects = []) => issues.push({ severity, code, sceneId: sample.sceneId,
    timeSeconds: sample.timeSeconds, sampleId: sample.id, phase: sample.phase, elementIds, reason, rects });
  const summaries = [];
  for (const sample of capture.samples) {
    const visible = sample.elements.filter(element => element.visible && element.opacity >= .95 && element.rect.width > 0 && element.rect.height > 0);
    if (sample.phase === 'stable' && !visible.some(element => element.role === 'headline' && element.sceneId === sample.sceneId &&
        element.text.trim() && element.textRects.some(rect => rect.width > 0 && rect.height > 0))) {
      add(sample, 'error', 'missing_visible_headline', [], '장면이 안정된 시점에 해당 장면의 제목이 보이지 않습니다.');
    }
    if (sample.phase === 'stable') for (const element of visible) {
      const contentRects = element.role === 'card' ? [element.rect, ...element.textRects] : element.textRects;
      const displayed = union(contentRects) || element.rect;
      if (outside(displayed, viewport)) add(sample, 'error', 'outside_viewport', [element.id], '보이는 내용이 영상 화면 밖으로 나갑니다.', [displayed, viewport]);
      else if (outside(displayed, safe)) add(sample, 'error', 'outside_safe_area', [element.id], '보이는 내용이 시리즈에 설정한 안전영역을 벗어납니다.', [displayed, safe]);
      const clipped = element.textRects.filter(text => element.clipRects.some(clip => outside(text, clip)));
      if (clipped.length) add(sample, 'error', 'text_clipped', [element.id], '글자 영역 일부가 상위 요소의 잘림 영역 밖에 있습니다.', [union(clipped), ...element.clipRects]);
      // Range rectangles describe font ascent/descent, which can legitimately
      // overhang an auto-height line box even with overflow:visible (Malgun Gothic
      // is one example). That is not clipped text. Real clipping is tested above
      // against actual clipping ancestors; a card is a deliberately fixed box.
      const overflow = element.textRects.filter(text => text.x < element.rect.x - 4 ||
        text.x + text.width > element.rect.x + element.rect.width + 4 ||
        (element.role === 'card' && outside(text, element.rect, 4)));
      if (overflow.length || element.scrollWidth > element.clientWidth + 2 ||
          (element.role === 'card' && element.scrollHeight > element.clientHeight + 2)) {
        add(sample, 'error', 'text_overflow', [element.id], '글자가 배정된 요소 영역을 넘칩니다.', [element.rect, ...(overflow.length ? [union(overflow)] : [])]);
      }
      if (element.text.trim() && element.fontSize < settings.minFontPx[element.role]) add(sample, 'warning', 'small_font', [element.id],
        `글자 크기 ${round(element.fontSize)}px가 ${element.role} 기준 ${settings.minFontPx[element.role]}px보다 작습니다.`, [displayed]);
    }
    for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
      const left = visible[i], right = visible[j];
      // A transition naturally fades between copies. Only persistent card collisions
      // are useful diagnostics there; their movement is never a blocking error.
      if (sample.phase === 'transition' && (left.role !== 'card' || right.role !== 'card')) continue;
      const a = left.role === 'card' ? left.rect : union(left.textRects) || left.rect;
      const b = right.role === 'card' ? right.rect : union(right.textRects) || right.rect;
      const overlap = intersection(a, b);
      if (overlap && overlap.width > settings.overlapTolerancePx && overlap.height > settings.overlapTolerancePx) {
        add(sample, 'warning', sample.phase === 'transition' ? 'transition_overlap' : 'element_overlap', [left.id, right.id],
          sample.phase === 'transition' ? '전환 중 카드가 겹칩니다. 의도한 움직임인지 확인하세요.' : '보이는 요소가 겹칩니다. 의도한 배치인지 확인하세요.', [a, b, overlap]);
      }
    }
  }
  for (const scene of scenes) {
    const samples = capture.samples.filter(sample => sample.sceneId === scene.id);
    const stable = samples.filter(sample => sample.phase === 'stable');
    const representative = stable[Math.floor(stable.length / 2)] || samples[Math.floor(samples.length / 2)];
    const window = stableWindow(scene);
    const texts = [...new Set((stable.length ? stable : samples).flatMap(sample => sample.elements)
      .filter(element => element.sceneId === scene.id && ['headline', 'body'].includes(element.role) && element.visible && element.opacity >= .95)
      .map(element => element.text.trim().replace(/\s+/g, ' ')).filter(Boolean))];
    const units = texts.reduce((sum, text) => sum + textUnits(text), 0);
    const readingSeconds = units / settings.charsPerSecond;
    if (!stable.length) add(representative, 'warning', 'no_stable_window', [], '전환이 끝난 뒤 충분히 안정된 검사 구간이 없습니다. 전환 화면만 측정했습니다.');
    if (scene.end - scene.start < settings.minSceneSeconds) add(representative, 'warning', 'short_scene', [],
      `장면 길이 ${round(scene.end - scene.start)}초가 최소 권장 ${settings.minSceneSeconds}초보다 짧습니다.`);
    if (units > 0 && readingSeconds > window.available + .05) add(representative, 'warning', 'reading_time', [],
      `표시 문구의 추정 읽기 시간 ${round(readingSeconds)}초에 비해 안정된 표시 구간은 ${round(window.available)}초입니다.`);
    summaries.push({ sceneId: scene.id, start: scene.start, end: scene.end, stableStart: round(window.start), stableEnd: round(window.end),
      stableSeconds: round(window.available), textUnits: round(units), estimatedReadingSeconds: round(readingSeconds),
      representativeSampleId: representative.id, screenshot: representative.screenshot });
  }
  const counts = { errors: issues.filter(issue => issue.severity === 'error').length, warnings: issues.filter(issue => issue.severity === 'warning').length };
  return { version: 1, status: counts.errors ? 'failed' : counts.warnings ? 'warnings' : 'passed', width: WIDTH, height: HEIGHT,
    policy: settings, counts, issues, scenes: summaries, samples: capture.samples,
    limitations: [
      '고정 시점의 DOM·글자 영역을 측정한 검사입니다. 모든 영상 프레임의 미적 품질이나 가독성을 보장하지 않습니다.',
      '전환 중에는 의도적인 이동을 오류로 판정하지 않으며 카드 겹침만 경고합니다.',
      '읽기 시간은 문구 길이와 시리즈 설정에 따른 추정이며 실제 독자의 이해 속도를 측정하지 않습니다.',
      '안전영역은 시리즈의 여백 설정이며 특정 플랫폼의 최신 UI 규격을 자동 반영하지 않습니다.',
    ] };
}

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
function imagePath(value) {
  if (!/^frames\/[a-z0-9_-]+\.png$/.test(value || '')) throw new Error('Report image path must be a relative frame PNG.');
  return value;
}

function frameMarkup(sample, rects = [], elementIds = []) {
  const legends = [];
  const overlays = rects.map((value, index) => {
    rectangle(value, 'Report overlay');
    const visible = intersection(value, { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    if (!visible) return '';
    const color = index === 0 ? '#e12f36' : '#2875dc';
    const label = elementIds[index] || (index ? `검사 경계 ${index}` : '측정 영역');
    legends.push(`<div class="legend-item"><span class="swatch" style="border-color:${color};border-style:${index ? 'dashed' : 'solid'}" aria-hidden="true"></span><span><code>${escape(label)}</code><br><span class="meta">x ${escape(round(value.x))}, y ${escape(round(value.y))} · ${escape(round(value.width))} × ${escape(round(value.height))}px</span></span></div>`);
    return `<rect x="${round(visible.x)}" y="${round(visible.y)}" width="${round(visible.width)}" height="${round(visible.height)}" fill="none" stroke="${color}" stroke-width="7"${index ? ' stroke-dasharray="18 10"' : ''}/>`;
  }).join('');
  return `<div class="frame"><img src="${imagePath(sample.screenshot)}" alt="${escape(sample.sceneId)} ${escape(sample.timeSeconds)}초 화면">${overlays ? `<svg aria-label="문제 위치 표시" viewBox="0 0 ${WIDTH} ${HEIGHT}">${overlays}</svg>` : ''}</div>${legends.length ? `<div class="legend" aria-label="위치 표시 범례">${legends.join('')}</div>` : ''}`;
}

function renderReportHtml(report) {
  if (!report || !Array.isArray(report.scenes) || !Array.isArray(report.issues) || !Array.isArray(report.samples)) throw new Error('A visual report is required.');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>화면·가독성 검수</title><style>
  body{font-family:system-ui,sans-serif;background:#f4f6f8;color:#18222a;margin:0;padding:24px;line-height:1.6}main{max-width:1200px;margin:auto}h1{margin:0}header,p{margin-bottom:18px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px}.scene{background:white;border-radius:12px;padding:16px}.frame{position:relative;aspect-ratio:9/16;overflow:hidden;background:#102b36}.frame img,.frame svg{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:contain}.frame svg{pointer-events:none}.issue .frame{max-width:320px}.legend{margin:10px 0 16px}.legend-item{display:flex;align-items:flex-start;gap:8px;margin:6px 0}.swatch{display:inline-block;flex:0 0 24px;height:16px;border-width:3px;margin-top:5px}.issue{padding:14px;margin:12px 0;background:white;border-left:5px solid #c78215}.error{border-color:#bf3e3e}code{word-break:break-all}.reason{font-weight:600}a{color:#245da8}.meta{color:#52616c;font-size:14px}details{margin-top:10px}li{margin-bottom:6px}
  </style></head><body><main><header><h1>화면·가독성 검수</h1><p><strong>${escape(report.status)}</strong> · 오류 ${escape(report.counts?.errors ?? 0)}개 · 경고 ${escape(report.counts?.warnings ?? 0)}개</p></header>
  <div class="grid">${report.scenes.map(scene => {
    const sample = report.samples.find(item => item.id === scene.representativeSampleId);
    if (!sample) throw new Error('Representative visual sample is missing.');
    imagePath(scene.screenshot);
    return `<article class="scene"><h2>${escape(scene.sceneId)}</h2><a href="${imagePath(scene.screenshot)}">${frameMarkup(sample)}</a><p class="meta">${escape(round(scene.start))}–${escape(round(scene.end))}초 · 안정 구간 ${escape(scene.stableSeconds)}초<br>추정 읽기 시간 ${escape(scene.estimatedReadingSeconds)}초</p></article>`;
  }).join('')}</div>
  <h2>확인할 항목</h2>${report.issues.length ? report.issues.map(issue => {
    const sample = report.samples.find(sample => sample.id === issue.sampleId);
    return `<article class="issue ${issue.severity === 'error' ? 'error' : ''}"><div class="reason">${escape(issue.reason)}</div><div class="meta">${escape(issue.sceneId)} · ${escape(issue.timeSeconds)}초 · ${escape(issue.phase)} · ${escape(issue.code)}</div><p>요소: <code>${escape(issue.elementIds.join(', ') || '장면 전체')}</code></p>${sample ? `<a href="${imagePath(sample.screenshot)}">해당 시점 원본 이미지</a><details><summary>화면에서 문제 위치 보기</summary>${frameMarkup(sample, issue.rects || [], issue.elementIds)}</details>` : ''}<details><summary>측정 위치</summary><pre>${escape(JSON.stringify(issue.rects || [], null, 2))}</pre></details></article>`;
  }).join('') : '<p>설정된 검사 기준에서 문제가 발견되지 않았습니다.</p>'}
  <details><summary>전체 검사 시점과 전환 화면 (${report.samples.length}개)</summary><div class="grid">${report.samples.map(sample => `<article class="scene"><h3>${escape(sample.sceneId)} · ${escape(sample.timeSeconds)}초</h3><p class="meta">${escape(sample.phase)}</p><a href="${imagePath(sample.screenshot)}">${frameMarkup(sample)}</a></article>`).join('')}</div></details>
  <h2>검사 범위</h2><ul>${(report.limitations || []).map(value => `<li>${escape(value)}</li>`).join('')}</ul></main></body></html>`;
}

module.exports = { createSamplePlan, analyzeLayout, renderReportHtml };
