const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVisualStages, runVisualReview, resolveVisualPolicy, validateVisualOutputs } = require('./runtime.cjs');
const { runEpisode, inspectEpisode } = require('../runner.cjs');

const quiet = () => {};
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
const timeline = { scenes: [
  { id: 'first', type: 'question', start: 0, end: 5, transitionSeconds: .5 },
  { id: 'last', type: 'conclusion', start: 5, end: 10, transitionSeconds: .5 },
], cards: [], actions: [] };

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-visual-runtime-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-visual-runtime-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const episodeFile = path.join(root, 'episode.json');
  fs.writeFileSync(episodeFile, JSON.stringify({ title: 'CS example' }));
  fs.mkdirSync(path.join(root, 'planning'));
  const catalogFile = path.join(root, 'planning/catalog.json');
  const catalog = { version: 1, series: { cs: { id: 'cs' } }, plans: {},
    episodes: { 'cs-example': { seriesId: 'cs', planId: 'example', episode: 'episode.json', adapter: 'pipeline/story/adapter.cjs' } }, batches: {} };
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  const workDir = path.join(root, 'runs/cs-example');
  const calls = [];
  const controls = { mode: 'normal', markup: 'first', narration: 'same voice' };
  const stages = [
    { id: 'speech', inputs: () => controls.narration, outputs: ['audio.wav'], async run({ dir }) { calls.push('speech'); fs.writeFileSync(path.join(dir, 'audio.wav'), 'voice'); } },
    { id: 'prepare', inputs: () => controls.markup, outputs: ['index.html', 'timeline.json'], async run({ dir }) {
      calls.push('prepare'); fs.writeFileSync(path.join(dir, 'index.html'), '<html>' + controls.markup + '</html>');
      fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(timeline));
    } },
    { id: 'render', inputs: () => 'renderer', outputs: ['video.mp4'], async run({ dir }) { calls.push('render'); fs.writeFileSync(path.join(dir, 'video.mp4'), 'video'); } },
    { id: 'verify', inputs: () => 'spec', outputs: ['report.json'], async run({ dir }) { calls.push('verify'); fs.writeFileSync(path.join(dir, 'report.json'), '{}'); } },
  ];
  async function capture({ directory, samples, width, height }) {
    calls.push('visual');
    fs.mkdirSync(path.join(directory, 'frames'), { recursive: true });
    const observed = samples.map(sample => {
      const screenshot = `frames/${sample.id}.png`;
      fs.writeFileSync(path.join(directory, screenshot), tinyPng);
      const rect = controls.mode === 'overflow' ? { x: 1010, y: 500, width: 400, height: 100 } : { x: 120, y: 500, width: 500, height: 100 };
      const element = { id: sample.sceneId + '-headline', role: 'headline', sceneId: sample.sceneId, text: '두 카드',
        rect, textRects: [rect], fontSize: controls.mode === 'small' ? 20 : 80, lineHeight: 100, opacity: 1, visible: true,
        clipRects: [{ x: 0, y: 0, width, height }], clientWidth: rect.width, clientHeight: rect.height,
        scrollWidth: rect.width, scrollHeight: rect.height };
      return { ...sample, screenshot, rootRect: { x: 0, y: 0, width, height }, elements: [element] };
    });
    return { width, height, browser: { name: 'controlled test capture' }, samples: observed };
  }
  const options = { root, episodeFile, stages, capture };
  const make = more => createVisualStages({ ...options, ...more });
  return { root, episodeFile, workDir, catalogFile, catalog, controls, calls, capture, options, make,
    run: more => runEpisode(workDir, make(more), { log: quiet }) };
}

test('visual review runs after prepared HTML and before rendering; unchanged status and reruns use no browser', async t => {
  const job = fixture(t);
  assert.deepEqual(job.make().map(stage => stage.id), ['speech', 'prepare', 'visual', 'render', 'verify']);
  await inspectEpisode(job.workDir, job.make());
  assert.deepEqual(job.calls, []);
  const first = await job.run();
  assert.deepEqual(job.calls, ['speech', 'prepare', 'visual', 'render', 'verify']);
  const directory = path.join(job.workDir, first.stages.visual.dir);
  assert.equal(validateVisualOutputs(directory), true);
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json')));
  assert.equal(report.status, 'passed');
  assert.ok(report.samples.length > timeline.scenes.length);
  assert.ok(fs.readFileSync(path.join(directory, 'report.html'), 'utf8').includes('frames/'));
  job.calls.length = 0;
  assert.equal((await inspectEpisode(job.workDir, job.make())).steps.every(step => step.current), true);
  await job.run();
  assert.deepEqual(job.calls, []);
});

test('hard layout errors preserve screenshots and report while stopping MP4 production', async t => {
  const job = fixture(t);
  job.controls.mode = 'overflow';
  await assert.rejects(job.run(), /Visual review failed/);
  assert.deepEqual(job.calls, ['speech', 'prepare', 'visual']);
  const state = JSON.parse(fs.readFileSync(path.join(job.workDir, 'state.json')));
  assert.equal(state.stages.visual.status, 'failed');
  const directory = path.join(job.workDir, state.stages.visual.dir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'report.json'))).status, 'failed');
  assert.equal(validateVisualOutputs(directory), true);
});

test('readability warnings remain visible and allow rendering for human review', async t => {
  const job = fixture(t);
  job.controls.mode = 'small';
  const result = await job.run();
  assert.equal(result.status, 'ready_for_review');
  const report = JSON.parse(fs.readFileSync(path.join(job.workDir, result.stages.visual.dir, 'report.json')));
  assert.equal(report.status, 'warnings');
  assert.ok(report.issues.some(issue => issue.severity === 'warning'));
  assert.ok(job.calls.includes('render'));
});

test('policy-only changes recheck layout without resynthesizing or re-rendering unchanged media', async t => {
  const job = fixture(t);
  const before = await job.run();
  job.calls.length = 0;
  job.catalog.series.cs.visualReview = { minFontPx: { headline: 90 } };
  fs.writeFileSync(job.catalogFile, JSON.stringify(job.catalog));
  const inspected = await inspectEpisode(job.workDir, job.make());
  assert.equal(inspected.steps.find(step => step.id === 'visual').current, false);
  const after = await job.run();
  assert.deepEqual(job.calls, ['visual']);
  assert.equal(after.stages.speech.dir, before.stages.speech.dir);
  assert.equal(after.stages.render.dir, before.stages.render.dir);
});

test('missing or altered screenshot outputs invalidate the gate but reuse current media after successful recheck', async t => {
  const job = fixture(t);
  let result = await job.run();
  for (const corrupt of ['delete', 'replace']) {
    const directory = path.join(job.workDir, result.stages.visual.dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'frames.json')));
    const file = path.join(directory, manifest.files[0].path);
    if (corrupt === 'delete') fs.unlinkSync(file); else fs.writeFileSync(file, 'not the captured image');
    assert.equal(validateVisualOutputs(directory), false);
    assert.equal((await inspectEpisode(job.workDir, job.make())).steps.find(step => step.id === 'visual').current, false);
    job.calls.length = 0;
    result = await job.run();
    assert.deepEqual(job.calls, ['visual']);
  }
});

test('new prepared HTML invalidates layout while unchanged narration remains cached', async t => {
  const job = fixture(t);
  const before = await job.run();
  job.calls.length = 0;
  job.controls.markup = 'updated headline';
  const after = await job.run();
  assert.deepEqual(job.calls, ['prepare', 'visual', 'render', 'verify']);
  assert.equal(before.stages.speech.dir, after.stages.speech.dir);
});

test('policy changes during capture or rendering cannot publish a stale visual pass', async t => {
  const job = fixture(t);
  const changedCapture = async options => {
    const result = await job.capture(options);
    job.catalog.series.cs.visualReview = { minFontPx: { headline: 90 } };
    fs.writeFileSync(job.catalogFile, JSON.stringify(job.catalog));
    return result;
  };
  await assert.rejects(job.run({ capture: changedCapture }), /policy changed/);
  assert.deepEqual(job.calls, ['speech', 'prepare', 'visual']);
});

test('disabled policy explicitly omits validation; malformed or escaped screenshot artifacts never pass', async t => {
  const job = fixture(t);
  job.catalog.series.cs.visualReview = { mode: 'off' };
  fs.writeFileSync(job.catalogFile, JSON.stringify(job.catalog));
  assert.equal(resolveVisualPolicy(job.options).mode, 'off');
  assert.equal(job.make(), job.options.stages);
  const htmlFile = path.join(job.root, 'prepared.html');
  fs.writeFileSync(htmlFile, '<html></html>');
  await assert.rejects(runVisualReview({ htmlFile, timeline, directory: path.join(job.root, 'audit'),
    capture: async options => {
      const result = await job.capture(options);
      result.samples[0].screenshot = '../escaped.png';
      return result;
    } }), /screenshot|relative|frames/i);
});
