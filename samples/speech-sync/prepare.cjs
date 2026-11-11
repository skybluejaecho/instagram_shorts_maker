const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Keep the HTML, WAV and timing from the same synthesis in one render directory.
const directory = path.resolve(process.argv[2] || path.join(__dirname, 'generated'));
const timing = JSON.parse(fs.readFileSync(path.join(directory, 'timing.json'), 'utf8'));
const wav = fs.readFileSync(path.join(directory, 'narration.wav'));
if (timing.audioSha256 && createHash('sha256').update(wav).digest('hex') !== timing.audioSha256) {
  throw new Error('The WAV and bookmarks belong to different synthesis runs.');
}
const { startSeconds, endSeconds, durationSeconds } = timing;
if (![startSeconds, endSeconds, durationSeconds].every(Number.isFinite) ||
    startSeconds < 0 || startSeconds >= endSeconds || endSeconds > durationSeconds) {
  throw new Error('Expected two ordered bookmarks inside the narration.');
}

const fps = 30;
const values = {
  riseStart: startSeconds,
  riseLength: endSeconds - startSeconds,
  audioLength: durationSeconds,
  filmLength: Math.ceil((durationSeconds + 1) * fps) / fps,
};
const template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const html = template.replace(/{{(\w+)}}/g, (_, key) => {
  if (!Object.hasOwn(values, key)) throw new Error('Unknown template field: ' + key);
  return String(values[key]);
});
fs.writeFileSync(path.join(directory, 'index.html'), html);
