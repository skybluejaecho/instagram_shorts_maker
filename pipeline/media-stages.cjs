const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function implementation() {
  // A renderer/verification fix must invalidate an old successful result even
  // when the prepared composition and requested video dimensions are unchanged.
  return ['media-stages.cjs', 'tools.cjs'].map(file => [file,
    createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex')]);
}

function createMediaStages(tools, videoSpec, compositionOutputs) {
  return [
    {
      id: 'render',
      inputs: () => ({ renderer: 'hyperframes', fps: videoSpec.fps, implementation: implementation() }),
      outputs: ['video.mp4'],
      async run({ dir, previous }) {
        // HyperFrames writes bookkeeping beside index.html. Keep the prepared stage immutable.
        const composition = path.join(dir, 'composition');
        fs.mkdirSync(composition);
        for (const name of compositionOutputs) {
          fs.copyFileSync(path.join(previous.prepare, name), path.join(composition, name));
        }
        await tools.render(composition, path.join(dir, 'video.mp4'), videoSpec.fps);
      },
    },
    {
      id: 'verify',
      inputs: () => ({ ...videoSpec, implementation: implementation() }),
      outputs: ['report.json'],
      async run({ dir, previous }) {
        const report = await tools.verify(path.join(previous.render, 'video.mp4'), videoSpec);
        fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      },
    },
  ];
}

module.exports = { createMediaStages };
