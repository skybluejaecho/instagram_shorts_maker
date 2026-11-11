const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createMediaStages } = require('../../pipeline/media-stages.cjs');

function fileHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createStages({ sampleDir, episodeFile, tools }) {
  const { beats } = JSON.parse(fs.readFileSync(episodeFile, 'utf8').replace(/^\uFEFF/, ''));
  const synth = path.join(sampleDir, 'synthesize.ps1');
  const prepare = path.join(sampleDir, 'prepare.cjs');
  const audioFiles = ['narration.wav', 'timing.json'];
  const compositionFiles = ['index.html', 'narration.wav'];
  const rate = 2;
  const videoSpec = { width: 1080, height: 1920, fps: 30, durationSeconds: 15, requireAudio: true };

  return [
    {
      id: 'speech',
      inputs: () => ({ beats, rate, voice: 'Microsoft Heami Desktop', script: fileHash(synth) }),
      outputs: audioFiles.map(name => 'voice/' + name),
      async run({ dir }) {
        const script = path.join(dir, 'script.json');
        fs.writeFileSync(script, JSON.stringify({ beats }));
        await tools.powershell(synth, ['-OutputDirectory', path.join(dir, 'voice'), '-Rate', String(rate), '-EpisodePath', script]);
      },
    },
    {
      id: 'prepare',
      inputs: () => ({ prepare: fileHash(prepare), template: fileHash(path.join(sampleDir, 'template.html')),
        motion: fileHash(path.join(sampleDir, '../shared/motion.css')) }),
      outputs: compositionFiles,
      async run({ dir, previous }) {
        for (const name of audioFiles) {
          fs.copyFileSync(path.join(previous.speech, 'voice', name), path.join(dir, name));
        }
        await tools.node(prepare, [dir]);
      },
    },
    ...createMediaStages(tools, videoSpec, compositionFiles),
  ];
}

module.exports = { createStages };
