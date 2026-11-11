const fs = require('node:fs');
const path = require('node:path');
const { validateSpec, validateTiming } = require('./spec.cjs');
const { buildHtml } = require('./render.cjs');

const [input, audioDirectory, output] = process.argv.slice(2);
if (!input || !audioDirectory || !output) throw new Error('Expected episode JSON, speech directory and output directory.');
const spec = validateSpec(JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, '')));
const wav = fs.readFileSync(path.join(audioDirectory, 'narration.wav'));
const timing = JSON.parse(fs.readFileSync(path.join(audioDirectory, 'timing.json'), 'utf8').replace(/^\uFEFF/, ''));
validateTiming(spec, timing, wav);
const { html, timeline } = buildHtml(spec, timing);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'index.html'), html);
fs.writeFileSync(path.join(output, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'narration.wav'), wav);
