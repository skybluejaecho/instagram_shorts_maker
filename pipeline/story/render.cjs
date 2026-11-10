function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function lineUnits(value) {
  return Math.max(...String(value).split('\n').map(line => [...line].reduce((sum, char) =>
    sum + (char === ' ' ? .32 : char.charCodeAt(0) < 128 ? .55 : 1), 0)), 1);
}

function keyframes(name, frames, duration) {
  const unique = new Map();
  for (const [time, css] of frames) {
    if (!Number.isFinite(time) || time < 0 || time > duration) throw new Error('Invalid animation time: ' + name);
    unique.set(time, css);
  }
  const stops = [...unique].sort(([a], [b]) => a - b)
    .map(([time, css]) => `${(time / duration * 100).toFixed(6)}%{${css}}`).join('');
  return `@keyframes ${name}{${stops}}`;
}

function poseFor(scene, index) {
  const count = scene.cards.length;
  let width;
  let height;
  let x;
  let y;
  if (scene.layout === 'stack') {
    width = 350;
    height = 132;
    x = 498 - width / 2;
    // Stack inputs follow insertion order; the last card sits at the top.
    y = 1020 - (count * height + (count - 1) * 20) / 2 + (count - 1 - index) * (height + 20);
  } else {
    width = Math.min(360, (804 - (count - 1) * 24) / count);
    height = count === 1 ? 240 : 176;
    const groupWidth = count * width + (count - 1) * 24;
    x = 498 - groupWidth / 2 + index * (width + 24);
    y = 1020 - height / 2;
  }
  const label = scene.cards[index].label;
  return { x, y, width, height, fontSize: Math.min(88, (width - 38) / lineUnits(label)) };
}

function poseCss(pose, shift = 0) {
  return `transform:translate(${pose.x}px,${pose.y + shift}px);width:${pose.width}px;height:${pose.height}px;font-size:${pose.fontSize}px;`;
}

function buildHtml(spec, timing) {
  const duration = spec.durationSeconds;
  const profile = spec.profile;
  const transition = profile.transitionSeconds;
  const colors = profile.colors;
  for (const color of Object.values(colors)) {
    if (!/^#[\da-f]{6}$/i.test(color)) throw new Error('Expected six-digit theme colors.');
  }
  if (!['Malgun Gothic', 'Arial'].includes(profile.fontFamily)) throw new Error('Unsupported font family.');
  if (!Number.isFinite(timing.durationSeconds) || timing.durationSeconds <= 0 || timing.durationSeconds > duration - 1) {
    throw new Error('Narration must leave at least one second for the final frame.');
  }
  const cueTime = cue => {
    const time = timing.wordStarts?.[cue];
    if (!Number.isFinite(time) || time < 0 || time > timing.durationSeconds) throw new Error('Missing or invalid spoken cue: ' + cue);
    return time;
  };
  const scenes = spec.scenes.map((scene, index) => {
    const onset = cueTime(scene.from);
    const start = index === 0 ? 0 : onset;
    const end = index + 1 < spec.scenes.length ? cueTime(spec.scenes[index + 1].from) : duration;
    if (end - start < transition + .2) throw new Error('Scene is too short for its transition: ' + scene.id);
    return { ...scene, start, end, cards: scene.cards || [], carry: scene.carry || [], actions: scene.actions || [] };
  });
  const timeline = {
    scenes: scenes.map(scene => ({ id: scene.id, type: scene.type, start: scene.start, end: scene.end, transitionSeconds: transition })),
    actions: [], cards: [],
  };
  for (const scene of scenes) {
    for (const action of scene.actions) {
      const at = cueTime(action.at);
      if (at < scene.start || at >= scene.end) throw new Error('Action cue is outside its scene: ' + action.at);
      timeline.actions.push({ sceneId: scene.id, at, cue: action.at, target: action.target, type: action.type });
    }
  }

  const css = [];
  const copy = scenes.map((scene, index) => {
    const fade = Math.min(.22, transition / 2);
    const frames = [[0, 'opacity:0;transform:translateY(12px);']];
    if (index === 0) frames.push([0, 'opacity:1;transform:translateY(0);']);
    else frames.push([scene.start, 'opacity:0;transform:translateY(12px);'],
      [scene.start + fade, 'opacity:1;transform:translateY(0);']);
    if (index === scenes.length - 1) frames.push([duration, 'opacity:1;transform:translateY(0);']);
    else frames.push([scene.end - .16, 'opacity:1;transform:translateY(0);'],
      [scene.end, 'opacity:0;transform:translateY(-8px);'], [duration, 'opacity:0;transform:translateY(-8px);']);
    css.push(keyframes('copy-' + index, frames, duration));
    const titleSize = Math.min(scene.type === 'question' ? 112 : 86, 804 / lineUnits(scene.headline));
    const bodySize = Math.min(48, 804 / lineUnits(scene.body || ''));
    return `<section class="scene ${scene.type} ${scene.cards.length ? 'has-cards' : ''}" data-scene-id="${escapeHtml(scene.id)}" style="animation-name:copy-${index}">
      <h1 style="font-size:${titleSize}px">${escapeHtml(scene.headline)}</h1>
      ${scene.body ? `<p style="font-size:${bodySize}px">${escapeHtml(scene.body)}</p>` : ''}
    </section>`;
  });

  const labels = new Map();
  scenes.forEach(scene => scene.cards.forEach(card => labels.set(card.id, card.label)));
  const cardMarkup = [...labels].map(([id, label], cardIndex) => {
    const poses = [];
    scenes.forEach((scene, index) => {
      const position = scene.cards.findIndex(card => card.id === id);
      if (position < 0) return;
      const previous = scenes[index - 1];
      const carried = scene.carry.includes(id) && previous?.cards.some(card => card.id === id);
      poses.push({ sceneId: scene.id, start: scene.start, end: scene.end,
        ...poseFor(scene, position), carried: Boolean(carried), sceneIndex: index });
    });
    timeline.cards.push({ id, label, poses });
    const first = poses[0];
    const movement = [[0, poseCss(first, 24)]];
    const opacity = [[0, 'opacity:0;']];
    const normal = `background:${colors.text};color:${colors.background};`;
    const highlighted = `background:${colors.accent};color:${colors.background};`;
    const paint = [[0, normal]];
    for (const [index, pose] of poses.entries()) {
      const previous = poses[index - 1];
      const next = poses[index + 1];
      movement.push([pose.start, poseCss(pose.carried ? previous : pose, pose.carried ? 0 : 24)]);
      if (pose.carried && scenes[previous.sceneIndex].layout !== scenes[pose.sceneIndex].layout) {
        // Establish separation on the destination axis before aligning the other axis.
        // Stack→row keeps each card's prior vertical band while setting its column width.
        // Row→stack keeps the prior column while setting the destination vertical band.
        const waypoint = scenes[pose.sceneIndex].layout === 'row'
          ? { ...previous, x: pose.x, width: pose.width, fontSize: pose.fontSize }
          : { ...previous, y: pose.y, height: pose.height, fontSize: Math.min(previous.fontSize, pose.fontSize) };
        pose.waypoint = { at: pose.start + transition / 2, x: waypoint.x, y: waypoint.y,
          width: waypoint.width, height: waypoint.height, fontSize: waypoint.fontSize };
        movement.push([pose.waypoint.at, poseCss(waypoint)]);
      }
      movement.push([pose.start + transition, poseCss(pose)]);
      const waitForCarry = !pose.carried && scenes[pose.sceneIndex].carry.length > 0;
      const appearAt = pose.start + (waitForCarry ? transition : 0);
      const visibleWindow = pose.end - appearAt;
      const fadeIn = Math.min(.22, transition / 2, visibleWindow / 3);
      opacity.push([pose.start, `opacity:${pose.carried ? 1 : 0};`],
        [appearAt, `opacity:${pose.carried ? 1 : 0};`], [appearAt + fadeIn, 'opacity:1;']);
      const carryForward = next?.carried && next.start === pose.end;
      const stop = carryForward || pose.end === duration ? pose.end : pose.end - Math.min(.16, visibleWindow / 3);
      movement.push([stop, poseCss(pose)]);
      opacity.push([stop, 'opacity:1;']);
      if (!carryForward && pose.end < duration) opacity.push([pose.end, 'opacity:0;']);
      paint.push([pose.start, normal]);
      for (const action of timeline.actions.filter(action => action.sceneId === pose.sceneId && action.target === id)) {
        paint.push([action.at, highlighted]);
      }
    }
    const last = poses.at(-1);
    movement.push([duration, poseCss(last)]);
    opacity.push([duration, `opacity:${last.end === duration ? 1 : 0};`]);
    paint.push([duration, paint.at(-1)[1]]);
    css.push(keyframes('move-' + cardIndex, movement, duration));
    css.push(keyframes('alpha-' + cardIndex, opacity, duration));
    css.push(keyframes('paint-' + cardIndex, paint, duration));
    return `<li class="card" data-card-id="${escapeHtml(id)}" style="animation-name:move-${cardIndex},alpha-${cardIndex},paint-${cardIndex}">${escapeHtml(label)}</li>`;
  });

  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(spec.title)}</title>
<style>
  @font-face{font-family:"Malgun Gothic";font-weight:700;src:local("Malgun Gothic Bold"),local("맑은 고딕 Bold")}
  *{box-sizing:border-box}body,h1,p,ol{margin:0;padding:0}
  main{--duration:${duration}s;position:relative;width:1080px;height:1920px;overflow:hidden;background:${colors.background};color:${colors.text};font-family:"${profile.fontFamily}",sans-serif;font-weight:700}
  .brand{position:absolute;left:96px;top:184px;width:804px;font-size:42px;line-height:1.2;color:${colors.accent};letter-spacing:-1px}
  .scene{position:absolute;inset:0;opacity:0;animation-duration:var(--duration);animation-timing-function:cubic-bezier(.2,.7,.3,1);animation-fill-mode:both}
  .scene h1,.scene p{position:absolute;left:96px;width:804px;white-space:pre-line;word-break:keep-all;overflow-wrap:anywhere}
  .scene h1{top:430px;line-height:1.25;letter-spacing:-2px}
  .scene p{top:1380px;line-height:1.5;color:${colors.muted};letter-spacing:-1px}
  .question h1{top:590px}.question p{top:1020px}
  .explanation h1{top:500px}.explanation p{top:920px}
  .conclusion:not(.has-cards) h1{top:590px}.conclusion:not(.has-cards) p{top:1020px}
  .card{position:absolute;left:0;top:0;z-index:2;list-style:none;display:flex;align-items:center;justify-content:center;text-align:center;white-space:pre-line;line-height:1.18;letter-spacing:-1px;border-radius:20px;padding:16px;opacity:0;animation-duration:var(--duration);animation-fill-mode:both;animation-timing-function:cubic-bezier(.42,0,.58,1),ease-out,steps(1,end);box-shadow:0 9px 0 rgba(0,0,0,.08)}
  ${css.join('\n')}
</style></head><body>
<main data-composition-id="story" data-start="0" data-duration="${duration}" data-width="1080" data-height="1920" data-fps="30" data-no-timeline>
  <div class="brand">${escapeHtml(profile.brand)}</div>
  ${copy.join('\n')}
  <ol aria-label="장면 카드">${cardMarkup.join('\n')}</ol>
  <audio id="narration-track" src="narration.wav" data-start="0" data-duration="${timing.durationSeconds}" data-track-index="1"></audio>
</main></body></html>`;
  return { html, timeline };
}

module.exports = { buildHtml };
