const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'generated-final');
const timing = JSON.parse(fs.readFileSync(path.join(outputDir, 'timing.json'), 'utf8').replace(/^\uFEFF/, ''));
const wav = fs.readFileSync(path.join(outputDir, 'narration.wav'));
if (timing.audioSha256 !== createHash('sha256').update(wav).digest('hex')) {
  throw new Error('Narration and timing must come from the same synthesis.');
}

const { wordStarts, durationSeconds: voiceDuration } = timing;
// A bookmark before a word can fall in the preceding pause.
// Use the engine's word-start event for the numbers the viewer sees.
for (const name of ['low', 'partial', 'full', 'conclusion']) {
  if (!Number.isFinite(wordStarts?.[name])) throw new Error('Missing word onset: ' + name);
}
const marks = { ...timing.marks, ...wordStarts };
const anchors = ['hook', 'drop-start', 'low', 'partial-start', 'partial', 'recovery-start', 'full', 'conclusion'];
const times = anchors.map(anchor => marks[anchor]);
if (!Number.isFinite(voiceDuration) || voiceDuration > 14 || !times.every((t, i) =>
    Number.isFinite(t) && t >= 0 && t <= voiceDuration && (i === 0 || t > times[i - 1]))) {
  throw new Error('Expected ordered speech cues and at least a second for the final hold.');
}

const values = {
  motionStyles: fs.readFileSync(path.join(__dirname, '../shared/motion.css'), 'utf8'),
  voiceDuration, dropStart: marks['drop-start'], low: marks.low,
  partialStart: marks['partial-start'], partial: marks.partial,
  recoveryStart: marks['recovery-start'], full: marks.full, conclusion: marks.conclusion,
};
const template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const html = template.replace(/{{(\w+)}}/g, (_, name) => {
  if (!Object.hasOwn(values, name)) throw new Error('Unknown template value: ' + name);
  return String(values[name]);
});
fs.writeFileSync(path.join(outputDir, 'index.html'), html);
