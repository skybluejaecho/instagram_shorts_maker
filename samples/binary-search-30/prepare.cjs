const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const version = process.argv[2] || 'v3';
if (!['v2', 'v3'].includes(version)) throw new Error('Choose storyboard version v2 or v3.');
const audioDir = process.argv[3] || path.join(__dirname, 'generated');
const output = process.argv[4] || path.join(audioDir, 'storyboard-' + version);
const episodeFile = process.argv[5] || path.join(__dirname, 'episode.json');
const episode = JSON.parse(fs.readFileSync(episodeFile, 'utf8').replace(/^\uFEFF/, ''));
const timing = JSON.parse(fs.readFileSync(path.join(audioDir, 'timing.json'), 'utf8').replace(/^\uFEFF/, ''));
const wav = fs.readFileSync(path.join(audioDir, 'narration.wav'));
if (createHash('sha256').update(wav).digest('hex') !== timing.audioSha256) {
  throw new Error('Narration does not match the recorded speech cues.');
}
const script = episode.beats.map(beat => beat.narration.trim()).join(' ');
if (timing.text.trim().replace(/\s+/g, ' ') !== script) {
  throw new Error('The approved script has changed. Synthesize it again.');
}
if (!Number.isFinite(timing.durationSeconds) || timing.durationSeconds <= 0 ||
    timing.durationSeconds > episode.durationSeconds - 1) {
  throw new Error('Leave at least one second after the narration for the closing frame.');
}

const values = {
  motionStyles: fs.readFileSync(path.join(__dirname, '../shared/motion.css'), 'utf8'),
  durationSeconds: episode.durationSeconds,
  voiceDuration: timing.durationSeconds,
  target: episode.target,
};
episode.values.forEach((value, i) => {
  values['cell' + i] = value;
});
episode.counterexampleValues.forEach((value, i) => {
  values['counter' + i] = value;
});
let previous = -1;
for (const beat of episode.beats) {
  const onset = timing.wordStarts?.[beat.id];
  if (!Number.isFinite(onset) || onset <= previous || onset > timing.durationSeconds) {
    throw new Error('Missing or out-of-order spoken word: ' + beat.id);
  }
  values[beat.id] = onset;
  const captionKey = 'caption' + beat.id[0].toUpperCase() + beat.id.slice(1);
  values[captionKey] = beat.narration.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  previous = onset;
}
// Plan the cuts by narration cue. Seconds only become available after TTS.
const starts = episode.shots.map(shot => shot.from === 'start' ? 0 : timing.wordStarts[shot.from]);
if (starts[0] !== 0) throw new Error('The opening must start at frame zero.');
episode.shots.forEach((shot, i) => {
  const start = starts[i];
  const end = starts[i + 1] ?? episode.durationSeconds;
  if (![start, end].every(Number.isFinite) || start < 0 || start >= end || end > episode.durationSeconds) {
    throw new Error('Invalid storyboard boundary: ' + shot.id);
  }
  values[shot.id + 'In'] = start;
  values[shot.id + 'Out'] = end;
  values[shot.id + 'Title'] = shot.headline.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  if (!Number.isFinite(shot.transitionSeconds) || shot.transitionSeconds < 0 || shot.transitionSeconds >= end - start) {
    throw new Error('Transition must fit within shot: ' + shot.id);
  }
  values[shot.id + 'Move'] = shot.transitionSeconds;
});
if (version === 'v3') {
  const { buildContinuity } = require('./continuity.cjs');
  Object.assign(values, buildContinuity(values, episode));
}
const templateName = version === 'v3' ? 'continuity-template.html' : 'storyboard-template.html';
const template = fs.readFileSync(path.join(__dirname, templateName), 'utf8');
const html = template.replace(/{{(\w+)}}/g, (_, name) => {
  if (!Object.hasOwn(values, name)) throw new Error('Unknown template field: ' + name);
  return String(values[name]);
});
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'narration.wav'), wav);
fs.writeFileSync(path.join(output, 'index.html'), html);
