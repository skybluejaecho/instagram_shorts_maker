const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runEpisode, inspectEpisode } = require('./runner.cjs');

test('media implementation changes invalidate rendering and verification while preserving prepared assets', async t => {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-media-cache-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-media-cache-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const moduleFile = path.join(root, 'media-stages.cjs');
  const toolsFile = path.join(root, 'tools.cjs');
  fs.copyFileSync(require.resolve('./media-stages.cjs'), moduleFile);
  fs.copyFileSync(require.resolve('./tools.cjs'), toolsFile);
  const { createMediaStages } = require(moduleFile);
  const calls = [];
  const tools = {
    async render(composition, output) {
      calls.push('render');
      fs.copyFileSync(path.join(composition, 'index.html'), output);
    },
    async verify() { calls.push('verify'); return { checked: true }; },
  };
  const stages = () => [
    { id: 'prepare', inputs: () => ({ title: 'fixed' }), outputs: ['index.html'],
      async run({ dir }) { calls.push('prepare'); fs.writeFileSync(path.join(dir, 'index.html'), '<main>fixed</main>'); } },
    ...createMediaStages(tools, { width: 1080, height: 1920, fps: 30, durationSeconds: 2 }, ['index.html']),
  ];
  const workDir = path.join(root, 'episode');
  const run = () => runEpisode(workDir, stages(), { log() {} });
  const first = await run();
  assert.deepEqual(calls, ['prepare', 'render', 'verify']);
  calls.length = 0;
  await run();
  assert.deepEqual(calls, []);

  for (const file of [toolsFile, moduleFile]) {
    fs.appendFileSync(file, '\n// Simulate a media implementation update.\n');
    assert.deepEqual((await inspectEpisode(workDir, stages())).steps.map(step => step.current), [true, false, false]);
    calls.length = 0;
    const updated = await run();
    assert.deepEqual(calls, ['render', 'verify']);
    assert.equal(updated.stages.prepare.dir, first.stages.prepare.dir);
    calls.length = 0;
    await run();
    assert.deepEqual(calls, []);
  }
});
