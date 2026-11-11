const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

function currentContext(root, episodeFile, story) {
  if (!root) return undefined;
  const { readCatalog } = require('../planning.cjs');
  const catalog = readCatalog(root);
  const file = path.resolve(episodeFile);
  const matches = Object.entries(catalog.episodes).filter(([, episode]) =>
    path.resolve(root, episode.episode) === file);
  if (!matches.length) return undefined; // Legacy inputs and not-yet-published catalog snapshots.
  if (matches.length !== 1) throw new Error('Episode input is assigned to multiple catalog episodes.');
  const [episodeId, episode] = matches[0];
  const series = catalog.series[episode.seriesId];
  if (!series) throw new Error('Episode has an unknown series.');
  if (series.contentReview === undefined || series.contentReview.mode === 'off') return undefined;
  if (series.contentReview.mode !== 'required') throw new Error('Episode has an invalid content review policy.');
  const plan = catalog.plans[episode.seriesId]?.[episode.planId];
  if (!plan) throw new Error('Episode has an unknown content plan.');
  const { readEvidenceBundle } = require('./sources.cjs');
  const bundle = readEvidenceBundle(root, series);
  const entries = [{ plan, story }];
  // Visual thresholds are checked by the independent visual gate; they do not
  // change a factual claim or its evidence and must not spend another model call.
  const { visualReview, ...contentSeries } = series;
  const fingerprint = hash(JSON.stringify({ episodeId, episode, series: contentSeries, plan, sourceHash: bundle.sourceHash, sourceStatus: bundle.status, issues: bundle.issues }));
  return { episodeId, series, entries, bundle, fingerprint };
}

function assertContext(root, episodeFile, story, initial) {
  const current = currentContext(root, episodeFile, story);
  if (!current || current.fingerprint !== initial.fingerprint) {
    throw Object.assign(new Error('Content sources or series settings changed during validation. Re-run with the current sources.'), {
      code: 'CONTENT_SOURCES_CHANGED', generationRetryable: false,
    });
  }
}

function checkerFor(options) {
  if (options.checker) return options.checker;
  const { createContentChecker } = require('./checker.cjs');
  const { createCodexProvider } = require('../generation/provider.cjs');
  return createContentChecker({ provider: options.provider || createCodexProvider(), log: options.log || (() => {}) });
}

function reportError(report, directory) {
  const unresolved = (report.units || []).filter(unit => ['contradicted', 'uncertain'].includes(unit.verdict))
    .map(unit => `${unit.location || unit.unitId}: ${unit.reason}`).slice(0, 12);
  for (const item of report.consistency || []) {
    if (item.verdict !== 'consistent') unresolved.push(`${item.planId}: ${item.reason}`);
  }
  const message = `Content validation ${report.status}. ${unresolved.join('; ')} Report: ${path.join(directory, 'report.json')}`;
  if (report.status === 'corrections') return Object.assign(new Error(message), { contentReportPath: path.join(directory, 'report.json') });
  return Object.assign(new Error(message), {
    code: 'CONTENT_REVIEW_REQUIRED', generationRetryable: false, contentReportPath: path.join(directory, 'report.json'),
  });
}

// Called before a revision's speech preflight as well as by the first production stage.
// It never changes the episode, source documents, catalog, or human review decision.
async function reviewEpisodeContent({ root, episodeFile, story, directory, checker, provider, log }) {
  const context = currentContext(root, episodeFile, story);
  if (!context) return undefined;
  fs.mkdirSync(directory, { recursive: true });
  const check = checkerFor({ checker, provider, log });
  const report = await check({ series: context.series, entries: context.entries, bundle: context.bundle, directory });
  require('./checker.cjs').validateContentReport(report, context.entries, context.bundle);
  fs.writeFileSync(path.join(directory, 'report.json'), json(report));
  assertContext(root, episodeFile, story, context);
  if (report.status !== 'passed') throw reportError(report, directory);
  return { report, assertCurrent: () => assertContext(root, episodeFile, story, context) };
}

function createContentStages({ root, episodeFile, story, stages, checker, provider, log }) {
  const initial = currentContext(root, episodeFile, story);
  if (!initial) return stages;
  const inputHash = hash(fs.readFileSync(episodeFile));
  const implementation = ['runtime.cjs', 'sources.cjs', 'checker.cjs'].map(file =>
    [file, hash(fs.readFileSync(path.join(__dirname, file)))]);
  const guard = () => {
    if (hash(fs.readFileSync(episodeFile)) !== inputHash) {
      throw Object.assign(new Error('Episode input changed during content-checked production. Re-run this episode.'), {
        code: 'CONTENT_INPUT_CHANGED', generationRetryable: false,
      });
    }
    assertContext(root, episodeFile, story, initial);
  };
  return [
    {
      id: 'content',
      validationOnly: true,
      inputs: () => {
        guard();
        return { entryHash: require('./checker.cjs').contentEntryHash(initial.entries),
          contextHash: initial.fingerprint, implementation };
      },
      outputs: ['report.json'],
      async run({ dir }) {
        guard();
        await reviewEpisodeContent({ root, episodeFile, story, directory: dir, checker, provider, log });
        guard();
      },
    },
    ...stages.map(stage => ({ ...stage,
      inputs: async () => { guard(); return stage.inputs(); },
      run: async context => { guard(); await stage.run(context); guard(); },
    })),
  ];
}

module.exports = { createContentStages, reviewEpisodeContent };
