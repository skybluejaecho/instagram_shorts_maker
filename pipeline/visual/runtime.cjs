const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeVisualReview } = require('./policy.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function policyContext({ root, episodeFile }) {
  let match;
  let series;
  if (root) {
    const catalogFile = path.join(root, 'planning', 'catalog.json');
    if (fs.existsSync(catalogFile)) {
      const catalog = readJson(catalogFile);
      const matches = Object.entries(catalog.episodes || {}).filter(([, episode]) =>
        path.resolve(root, episode.episode) === path.resolve(episodeFile));
      if (matches.length > 1) throw new Error('Episode input is assigned to multiple visual review contexts.');
      if (matches.length) {
        match = matches[0];
        series = catalog.series?.[match[1].seriesId];
        if (!series) throw new Error('Visual review episode has an unknown series.');
      }
    }
  }
  const policy = normalizeVisualReview(series?.visualReview);
  return { policy, fingerprint: hash(json({ episode: match || null, policy })) };
}

function resolveVisualPolicy(options) {
  return policyContext(options).policy;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function frameFile(directory, relative) {
  if (typeof relative !== 'string' || !/^frames\/[a-zA-Z0-9_-]+\.png$/.test(relative)) {
    throw new Error('Visual screenshot must use a safe relative frames/*.png path.');
  }
  const file = path.resolve(directory, relative);
  if (!inside(path.resolve(directory), file) || !inside(fs.realpathSync(directory), fs.realpathSync(file))) {
    throw new Error('Visual screenshot resolves outside its report directory.');
  }
  return file;
}

function screenshotManifest(directory, samples) {
  if (!Array.isArray(samples) || !samples.length) throw new Error('Visual report has no screenshot samples.');
  const paths = new Set();
  return samples.map(sample => {
    const relative = sample.screenshot;
    if (paths.has(relative)) throw new Error('Visual screenshots must have unique artifact paths.');
    paths.add(relative);
    const bytes = fs.readFileSync(frameFile(directory, relative));
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error('Visual screenshot is not a nonempty PNG: ' + relative);
    }
    return { sampleId: sample.id, path: relative, sha256: hash(bytes) };
  });
}

function validateVisualOutputs(directory) {
  try {
    const report = readJson(path.join(directory, 'report.json'));
    const frames = readJson(path.join(directory, 'frames.json'));
    if (!['passed', 'warnings', 'failed'].includes(report.status) || frames.version !== 1 || !Array.isArray(frames.files)) return false;
    const actual = screenshotManifest(directory, report.samples);
    return JSON.stringify(frames.files) === JSON.stringify(actual);
  } catch { return false; }
}

// A standalone audit preserves failures as reviewable artifacts; production decides whether to stop.
async function runVisualReview({ htmlFile, timeline, directory, policy, capture }) {
  policy = normalizeVisualReview(policy);
  if (policy.mode === 'off') throw new Error('Visual review is disabled for this series.');
  const { createSamplePlan, analyzeLayout, renderReportHtml } = require('./checker.cjs');
  const htmlBytes = fs.readFileSync(htmlFile);
  const samples = createSamplePlan(timeline, policy);
  fs.mkdirSync(directory, { recursive: true });
  const collect = capture || require('./browser.cjs').captureLayout;
  try {
    const measurement = await collect({ htmlFile: path.resolve(htmlFile), directory: path.resolve(directory), samples, width: 1080, height: 1920 });
    if (hash(fs.readFileSync(htmlFile)) !== hash(htmlBytes)) throw new Error('Prepared HTML changed while its layout was being inspected.');
    const result = analyzeLayout({ timeline, policy, capture: measurement });
    const report = { ...result, version: 1, createdAt: new Date().toISOString(),
      source: { htmlFile: path.resolve(htmlFile), htmlSha256: hash(htmlBytes), timelineSha256: hash(json(timeline)) },
      policy, browser: measurement.browser, reportPath: path.resolve(directory, 'report.json'),
      htmlReportPath: path.resolve(directory, 'report.html') };
    const files = screenshotManifest(directory, report.samples);
    fs.writeFileSync(path.join(directory, 'capture.json'), json(measurement));
    fs.writeFileSync(path.join(directory, 'frames.json'), json({ version: 1, files }));
    fs.writeFileSync(path.join(directory, 'report.json'), json(report));
    fs.writeFileSync(path.join(directory, 'report.html'), renderReportHtml(report));
    if (!validateVisualOutputs(directory)) throw new Error('Visual report screenshot integrity could not be verified.');
    return report;
  } catch (error) {
    fs.writeFileSync(path.join(directory, 'failure.json'), json({ error: error.message, htmlSha256: hash(htmlBytes), createdAt: new Date().toISOString() }));
    throw error;
  }
}

function createVisualStages({ root, episodeFile, stages, capture }) {
  const initial = policyContext({ root, episodeFile });
  if (initial.policy.mode === 'off') return stages;
  const prepareIndex = stages.findIndex(stage => stage.id === 'prepare');
  const renderIndex = stages.findIndex(stage => stage.id === 'render');
  if (prepareIndex < 0 || renderIndex <= prepareIndex) throw new Error('Visual review requires prepare before render.');
  const inputHash = hash(fs.readFileSync(episodeFile));
  const implementation = ['runtime.cjs', 'policy.cjs', 'checker.cjs', 'browser.cjs'].map(file =>
    [file, hash(fs.readFileSync(path.join(__dirname, file)))]);
  function guard() {
    if (hash(fs.readFileSync(episodeFile)) !== inputHash) throw new Error('Episode input changed during visual-checked production. Re-run this episode.');
    if (policyContext({ root, episodeFile }).fingerprint !== initial.fingerprint) throw new Error('Visual review policy changed during production. Re-run with the current policy.');
  }
  function guardPrepared(previous) {
    const report = readJson(path.join(previous.visual, 'report.json'));
    if (!['passed', 'warnings'].includes(report.status) ||
        hash(fs.readFileSync(path.join(previous.prepare, 'index.html'))) !== report.source?.htmlSha256 ||
        hash(json(readJson(path.join(previous.prepare, 'timeline.json')))) !== report.source?.timelineSha256) {
      throw new Error('Prepared HTML or timeline changed after visual review. Re-run the episode.');
    }
  }
  const visual = {
    id: 'visual', validationOnly: true,
    inputs: () => { guard(); return { policy: initial.policy, implementation }; },
    outputs: ['report.json', 'report.html', 'frames.json'],
    validateOutputs: validateVisualOutputs,
    async run({ dir, previous }) {
      guard();
      const timeline = readJson(path.join(previous.prepare, 'timeline.json'));
      const report = await runVisualReview({ htmlFile: path.join(previous.prepare, 'index.html'), timeline,
        directory: dir, policy: initial.policy, capture });
      guard();
      if (report.status === 'failed') {
        throw Object.assign(new Error(`Visual review failed. Inspect ${report.htmlReportPath}`), {
          code: 'VISUAL_REVIEW_FAILED', reportPath: report.reportPath,
        });
      }
    },
  };
  return [...stages.slice(0, renderIndex), visual,
    ...stages.slice(renderIndex).map(stage => ({ ...stage,
      inputs: async () => { guard(); return stage.inputs(); },
      run: async context => { guard(); guardPrepared(context.previous); await stage.run(context); guardPrepared(context.previous); guard(); },
    })),
  ];
}

module.exports = { createVisualStages, runVisualReview, resolveVisualPolicy, validateVisualOutputs };
