const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { registerSeries, readCatalog } = require('../planning.cjs');
const { generateBatch } = require('../generation/engine.cjs');
const { createCodexProvider } = require('../generation/provider.cjs');
const { createNoveltyChecker } = require('../novelty/checker.cjs');
const { createContentChecker } = require('./checker.cjs');
const { createSpeechPreflight } = require('../generation/preflight.cjs');
const { createStages } = require('../story/adapter.cjs');
const { createTools } = require('../tools.cjs');
const { runEpisode } = require('../runner.cjs');
const { inspectReview } = require('../review.cjs');

const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function rawEpisode(source, topicKey, objective) {
  return { title: source.title, topicKey, objective, angle: '기존 A/B 카드 예시로 순서를 설명한다.', story: {
    narration: source.narration,
    scenes: source.scenes.map(scene => ({ id: scene.id, type: scene.type, from: scene.from, headline: scene.headline,
      body: scene.body || null, cards: scene.cards || [], layout: scene.layout || 'row', carry: scene.carry || [], actions: scene.actions || [] })),
  } };
}

// Explicit live evaluation: first candidate is a controlled corruption of existing examples.
// All judgments, corrections, actual TTS, and production are performed by the real pipeline.
async function main() {
  const root = path.resolve(__dirname, '../..');
  const series = { ...read(path.join(root, 'samples/story/series.json')), id: 'content-cs-demo',
    name: '근거 기반 내용 검증용 CS 예제', contentReview: read(path.join(root, 'samples/content/policy.json')) };
  await registerSeries(root, series);
  const batchId = 'content-cs-01';
  const workDir = path.join(root, 'runs/_generation', batchId);
  const statePath = path.join(workDir, 'state.json');
  let seedPending = !fs.existsSync(statePath) || read(statePath).attempts.length === 0;
  const queue = rawEpisode(read(path.join(root, 'samples/story/queue.json')), 'queue.fifo', '먼저 들어온 값을 먼저 꺼내는 큐의 순서를 이해한다.');
  const stack = rawEpisode(read(path.join(root, 'samples/story/stack.json')), 'stack.lifo', '나중에 넣은 값을 먼저 꺼내는 스택의 순서를 이해한다.');
  const wrong = stack.story.scenes.find(scene => scene.id === 'remove');
  wrong.headline = '먼저 온 A가\n먼저 나옵니다';
  wrong.body = '꺼내는 순서  A → B';
  const provider = createCodexProvider();
  const log = console.log;
  const result = await generateBatch(root, { seriesId: series.id, batchId, count: 2, maxAttempts: 5,
    provider: async request => {
      if (seedPending) { seedPending = false; log('검증용 입력: 기존 큐 회차 + 화면 순서 오류를 넣은 스택 회차'); return { episodes: [queue, stack] }; }
      return provider(request);
    },
    noveltyCheck: createNoveltyChecker({ provider, log }), contentCheck: createContentChecker({ provider, log }),
    preflight: createSpeechPreflight(root, { log }), log,
  });
  const state = read(statePath);
  assert.equal(state.status, 'committed');
  const reports = state.attempts.filter(attempt => attempt.contentReportFile).map(attempt => ({ attempt, report: read(path.join(workDir, attempt.contentReportFile)) }));
  assert.ok(reports.some(({ report }) => report.status === 'corrections' && report.correctionPlanIds.includes(batchId + '-02')), 'Controlled stack error should be detected.');
  assert.equal(state.contentReport.status, 'passed');
  const preservation = [];
  for (let i = 1; i < state.attempts.length; i++) {
    const attempt = state.attempts[i];
    if (!attempt.replacedPlanIds || !attempt.candidatePath) continue;
    const previous = state.attempts.slice(0, i).reverse().find(item => item.candidatePath);
    const before = read(path.join(workDir, previous.candidatePath));
    const after = read(path.join(workDir, attempt.candidatePath));
    for (let index = 0; index < 2; index++) if (!attempt.replacedPlanIds.includes(`${batchId}-${String(index + 1).padStart(2, '0')}`)) {
      assert.deepEqual(after.episodes[index], before.episodes[index]);
    }
    preservation.push({ attempt: attempt.id, changed: attempt.replacedPlanIds, otherEpisodesPreserved: true });
  }
  const catalog = readCatalog(root);
  const episodeId = result.episodeIds[1];
  const entry = catalog.episodes[episodeId];
  const episodeDir = path.join(root, 'runs', episodeId);
  const stages = createStages({ root, episodeFile: path.join(root, entry.episode), tools: createTools(root) });
  await runEpisode(episodeDir, stages, { log });
  const review = await inspectReview(episodeDir, stages);
  assert.equal(review.status, 'ready_for_review');
  const summary = { description: 'Live controlled-error workflow using existing CS examples. First input is seeded; judgments/repairs/TTS/render are real.',
    batchId, attempts: state.attempts.length, contentStatus: state.contentReport.status, partialRepairs: preservation,
    contentReport: state.contentReport.reportPath, episodeIds: result.episodeIds,
    renderedEpisodeId: episodeId, videoPath: review.videoPath, qaPath: review.reportPath, reviewStatus: review.status,
    references: catalog.plans[series.id][batchId + '-02'].references };
  const directory = path.join(root, 'runs/_content/workflow-cs-01');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
