const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateSpec } = require('./spec.cjs');
const { createMediaStages } = require('../media-stages.cjs');

function sourceHash(filename) {
  return createHash('sha256').update(fs.readFileSync(path.join(__dirname, filename))).digest('hex');
}

function createStages({ root, episodeFile, tools, contentChecker, visualCapture }) {
  const spec = validateSpec(JSON.parse(fs.readFileSync(episodeFile, 'utf8').replace(/^\uFEFF/, '')));
  const videoSpec = { width: 1080, height: 1920, fps: 30, durationSeconds: spec.durationSeconds, requireAudio: true };
  let stages = [
    {
      id: 'speech',
      inputs: () => ({ narration: spec.narration, speech: spec.profile.speech, synth: sourceHash('synthesize.ps1') }),
      outputs: ['voice/narration.wav', 'voice/timing.json'],
      async run({ dir }) {
        const input = path.join(dir, 'speech-input.json');
        fs.writeFileSync(input, JSON.stringify({ ...spec.profile.speech,
          beats: spec.narration.map(cue => ({ id: cue.id, narration: cue.text })) }));
        await tools.powershell(path.join(__dirname, 'synthesize.ps1'), ['-EpisodePath', input, '-OutputDirectory', path.join(dir, 'voice')]);
      },
    },
    {
      id: 'prepare',
      inputs: () => ({ spec, prepare: sourceHash('prepare.cjs'), validator: sourceHash('spec.cjs'), renderer: sourceHash('render.cjs') }),
      outputs: ['index.html', 'narration.wav', 'timeline.json'],
      async run({ dir, previous }) {
        const input = path.join(dir, 'episode.json');
        fs.writeFileSync(input, JSON.stringify(spec));
        await tools.node(path.join(__dirname, 'prepare.cjs'), [input, path.join(previous.speech, 'voice'), dir]);
      },
    },
    ...createMediaStages(tools, videoSpec, ['index.html', 'narration.wav']),
  ];
  stages = require('../visual/runtime.cjs').createVisualStages({ root, episodeFile, stages, capture: visualCapture });
  // Existing standalone adapters and pre-publication catalog validation need no model
  // dependency. Resolve the optional content stage only for a registered required series.
  if (!root) return stages;
  const catalogFile = path.join(root, 'planning', 'catalog.json');
  if (!fs.existsSync(catalogFile)) return stages;
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8').replace(/^\uFEFF/, ''));
  const episode = Object.values(catalog.episodes || {}).find(entry => path.resolve(root, entry.episode) === path.resolve(episodeFile));
  if (!episode) return stages;
  const policy = catalog.series?.[episode.seriesId]?.contentReview;
  if (policy === undefined || policy.mode === 'off') return stages;
  return require('../content/runtime.cjs').createContentStages({ root, episodeFile, story: spec, stages, checker: contentChecker });
}

module.exports = { createStages };
