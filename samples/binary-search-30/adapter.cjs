const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createMediaStages } = require('../../pipeline/media-stages.cjs');

function sourceHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createStages({ root, sampleDir = path.join(root, 'samples', 'binary-search-30'),
                        episodeFile = path.join(sampleDir, 'episode.json'), tools }) {
  // A run uses one snapshot even if the source is edited while the voice is being produced.
  const episode = JSON.parse(fs.readFileSync(episodeFile, 'utf8').replace(/^\uFEFF/, ''));
  const beats = episode.beats.map(({ id, narration }) => ({ id, narration: narration.trim() }));
  const synthFile = path.join(sampleDir, 'synthesize.ps1');
  const prepareFile = path.join(sampleDir, 'prepare.cjs');
  const rate = 2;
  const fps = 30;
  const videoSpec = { width: 1080, height: 1920, fps, durationSeconds: episode.durationSeconds,
                      requireAudio: true };
  const audioOutputs = ['narration.wav', 'timing.json'];
  const compositionOutputs = ['index.html', 'narration.wav'];

  return [
    {
      id: 'speech',
      inputs: () => ({ beats, rate, voice: 'Microsoft Heami Desktop', script: sourceHash(synthFile) }),
      outputs: audioOutputs,
      async run({ dir }) {
        const input = path.join(dir, 'script.json');
        const voiceDir = path.join(dir, 'voice');
        fs.writeFileSync(input, JSON.stringify({ beats }));
        await tools.powershell(synthFile, ['-OutputDirectory', voiceDir, '-Rate', String(rate),
                                          '-EpisodePath', input]);
        for (const name of audioOutputs) {
          fs.renameSync(path.join(voiceDir, name), path.join(dir, name));
        }
        fs.rmdirSync(voiceDir);
        fs.unlinkSync(input);
      },
    },
    {
      id: 'prepare',
      inputs: () => ({
        episode,
        prepare: sourceHash(prepareFile),
        template: sourceHash(path.join(sampleDir, 'continuity-template.html')),
        continuity: sourceHash(path.join(sampleDir, 'continuity.cjs')),
        motion: sourceHash(path.join(sampleDir, '../shared/motion.css')),
      }),
      outputs: compositionOutputs,
      async run({ dir, previous }) {
        const input = path.join(dir, 'episode.json');
        fs.writeFileSync(input, JSON.stringify(episode));
        await tools.node(prepareFile, ['v3', previous.speech, dir, input]);
        fs.unlinkSync(input);
      },
    },
    ...createMediaStages(tools, videoSpec, compositionOutputs),
  ];
}

module.exports = { createStages };
