const { createHash } = require('node:crypto');

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function text(value, label, maxLength = 250) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\x00-\x08\x0b-\x1f]/.test(value)) {
    throw new Error(`${label} must contain readable text within ${maxLength} characters.`);
  }
  return value.trim();
}

function displayText(value, label, lines, width) {
  const result = text(value, label);
  const parts = result.split('\n');
  const units = part => [...part].reduce((sum, char) => sum + (char.codePointAt(0) < 128 ? .55 : 1), 0);
  if (parts.length > lines || parts.some(part => units(part) > width)) {
    throw new Error(`${label} exceeds the supported ${lines} lines / ${width} visual units per line.`);
  }
  return result;
}

function array(value, label, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${label} needs ${min}–${max} entries.`);
  return value;
}

function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}.`);
}

function fields(value, supported, label) {
  for (const key of Object.keys(value)) {
    if (!supported.includes(key)) throw new Error(`Unsupported ${label} field: ${key}`);
  }
}

function normalizeProfile(value = {}) {
  object(value, 'Profile');
  fields(value, ['brand', 'fontFamily', 'colors', 'transitionSeconds', 'speech'], 'profile');
  const defaults = { background: '#102b36', text: '#f5f4ee', accent: '#a8edc7', muted: '#a5b8bd' };
  const colors = { ...defaults, ...object(value.colors ?? {}, 'Colors') };
  for (const [name, color] of Object.entries(colors)) {
    if (!Object.hasOwn(defaults, name) || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`Invalid color: ${name}`);
  }
  const fontFamily = value.fontFamily ?? 'Malgun Gothic';
  if (!['Malgun Gothic', 'Arial'].includes(fontFamily)) throw new Error('Unsupported font family.');
  const transitionSeconds = value.transitionSeconds ?? .55;
  if (!Number.isFinite(transitionSeconds) || transitionSeconds < .15 || transitionSeconds > 1.5) throw new Error('Transition must be 0.15–1.5 seconds.');
  const speech = { voice: 'Microsoft Heami Desktop', rate: 2, ...object(value.speech ?? {}, 'Speech') };
  fields(speech, ['voice', 'rate'], 'speech');
  text(speech.voice, 'Voice', 80);
  if (!Number.isInteger(speech.rate) || speech.rate < -10 || speech.rate > 10) throw new Error('Speech rate must be an integer from -10 to 10.');
  return { brand: displayText(value.brand ?? 'CS 한 장', 'Brand', 1, 20), fontFamily, colors,
    transitionSeconds, speech };
}

function validateSpec(source) {
  object(source, 'Episode');
  if (source.version !== 1) throw new Error('Story specification version 1 is required.');
  const title = text(source.title, 'Title', 80);
  const durationSeconds = source.durationSeconds;
  if (!Number.isFinite(durationSeconds) || durationSeconds < 4 || durationSeconds > 90 ||
      Math.abs(durationSeconds * 30 - Math.round(durationSeconds * 30)) > .00001) {
    throw new Error('Duration must be 4–90 seconds in whole 30fps frames.');
  }
  const profile = normalizeProfile(source.profile);
  const narration = array(source.narration, 'Narration', 40, 1).map(item => {
    object(item, 'Narration cue');
    fields(item, ['id', 'text'], 'narration');
    return { id: identifier(item.id, 'narration cue ID'), text: text(item.text, 'Narration text').replace(/\s+/g, ' ') };
  });
  unique(narration.map(item => item.id), 'narration cue ID');
  const cueIndex = new Map(narration.map((item, i) => [item.id, i]));
  const labels = new Map();
  const scenes = array(source.scenes, 'Scenes', 12, 2).map(scene => {
    object(scene, 'Scene');
    fields(scene, ['id', 'type', 'from', 'headline', 'body', 'cards', 'layout', 'carry', 'actions'], 'scene');
    const id = identifier(scene.id, 'scene ID');
    if (!['question', 'explanation', 'cards', 'conclusion'].includes(scene.type)) throw new Error(`Unsupported scene type: ${scene.type}`);
    if (!cueIndex.has(scene.from)) throw new Error(`Unknown scene cue: ${scene.from}`);
    const headline = displayText(scene.headline, 'Headline', 2, 14);
    const body = scene.body === undefined ? undefined : displayText(scene.body, 'Body', 3, 24);
    const cards = array(scene.cards ?? [], 'Cards', 4, scene.type === 'cards' ? 1 : 0).map(card => {
      object(card, 'Card');
      fields(card, ['id', 'label'], 'card');
      const cardId = identifier(card.id, 'card ID');
      const label = displayText(card.label, 'Card label', 1, 5);
      if (label.length > 8) throw new Error('Card label exceeds 8 characters.');
      if (labels.has(cardId) && labels.get(cardId) !== label) throw new Error(`Card identity changed label: ${cardId}`);
      labels.set(cardId, label);
      return { id: cardId, label };
    });
    unique(cards.map(card => card.id), 'card ID in scene');
    if (cards.length && !['cards', 'conclusion'].includes(scene.type)) throw new Error('Cards require a cards or conclusion scene.');
    const layout = scene.layout ?? 'row';
    if (!['row', 'stack'].includes(layout)) throw new Error('Unsupported card layout.');
    const carry = array(scene.carry ?? [], 'Carry targets', 4).map(value => identifier(value, 'carry target'));
    unique(carry, 'carry target');
    const actions = array(scene.actions ?? [], 'Actions', 40).map(action => {
      object(action, 'Action');
      fields(action, ['type', 'target', 'at'], 'action');
      if (action.type !== 'highlight') throw new Error('Unsupported animation action.');
      if (!cards.some(card => card.id === action.target)) throw new Error(`Unknown action target: ${action.target}`);
      if (!cueIndex.has(action.at)) throw new Error(`Unknown action cue: ${action.at}`);
      return { type: 'highlight', target: action.target, at: action.at };
    });
    return { id, type: scene.type, from: scene.from, headline, ...(body === undefined ? {} : { body }),
      cards, layout, carry, actions };
  });
  unique(scenes.map(scene => scene.id), 'scene ID');
  if (scenes[0].from !== narration[0].id) throw new Error('First scene must start with the first narration cue.');
  scenes.forEach((scene, i) => {
    const start = cueIndex.get(scene.from);
    const end = cueIndex.get(scenes[i + 1]?.from) ?? narration.length;
    if (start >= end) throw new Error('Scene cues must be in increasing order.');
    for (const id of scene.carry) {
      if (!scene.cards.some(card => card.id === id) || !scenes[i - 1]?.cards.some(card => card.id === id)) {
        throw new Error(`Carry target must exist in both adjacent scenes: ${id}`);
      }
    }
    if (scene.carry.length && scene.layout === scenes[i - 1].layout) {
      const carriedOrder = cards => cards.filter(card => scene.carry.includes(card.id)).map(card => card.id).join(',');
      if (carriedOrder(scene.cards) !== carriedOrder(scenes[i - 1].cards)) {
        throw new Error('Carried cards must preserve order within the same layout. Change layout or introduce the cards again.');
      }
    }
    for (const action of scene.actions) {
      const at = cueIndex.get(action.at);
      if (at < start || at >= end) throw new Error(`Action cue is outside its scene: ${action.at}`);
    }
  });
  return { version: 1, title, durationSeconds, profile, narration, scenes };
}

function validateTiming(spec, timing, wav) {
  object(timing, 'Timing');
  const normalize = value => value.trim().replace(/\s+/g, ' ');
  if (typeof timing.text !== 'string' || normalize(timing.text) !== spec.narration.map(cue => cue.text).join(' ')) {
    throw new Error('Speech text does not match this episode.');
  }
  if (createHash('sha256').update(wav).digest('hex') !== timing.audioSha256) throw new Error('Speech audio does not match its timing.');
  if (timing.voice !== spec.profile.speech.voice || timing.rate !== spec.profile.speech.rate) throw new Error('Speech voice or rate changed.');
  if (!Number.isFinite(timing.durationSeconds) || timing.durationSeconds <= 0 || timing.durationSeconds > spec.durationSeconds - 1) {
    throw new Error('Narration must fit the video with at least one second for the final hold.');
  }
  let previousMark = -1;
  let previousWord = -1;
  spec.narration.forEach((cue, i) => {
    const mark = timing.marks?.[cue.id];
    const word = timing.wordStarts?.[cue.id];
    const nextMark = timing.marks?.[spec.narration[i + 1]?.id] ?? timing.durationSeconds;
    if (![mark, word, nextMark].every(Number.isFinite) || mark < 0 || word < 0 || mark <= previousMark || word <= previousWord ||
        word < mark || word >= nextMark || word > timing.durationSeconds) throw new Error(`Invalid speech cue timing: ${cue.id}`);
    previousMark = mark;
    previousWord = word;
  });
  spec.scenes.forEach((scene, i) => {
    const start = i === 0 ? 0 : timing.wordStarts[scene.from];
    const end = i + 1 < spec.scenes.length ? timing.wordStarts[spec.scenes[i + 1].from] : spec.durationSeconds;
    if (end - start < spec.profile.transitionSeconds + .2) throw new Error(`Scene is too short for its transition: ${scene.id}`);
    for (const action of scene.actions) {
      if (scene.carry.length && !scene.carry.includes(action.target) &&
          timing.wordStarts[action.at] < start + spec.profile.transitionSeconds) {
        throw new Error(`Highlight a new card after the carried cards settle: ${action.target}`);
      }
    }
  });
  return timing;
}

module.exports = { validateSpec, validateTiming, normalizeProfile };
