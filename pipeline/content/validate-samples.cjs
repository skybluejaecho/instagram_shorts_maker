const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createContentChecker, collectUnits } = require('./checker.cjs');
const { readEvidenceBundle } = require('./sources.cjs');
const { createCodexProvider } = require('../generation/provider.cjs');
const { validateSpec } = require('../story/spec.cjs');

const json = value => JSON.stringify(value, null, 2) + '\n';
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function buildCases(root) {
  const base = readJson(path.join(root, 'samples/story/series.json'));
  const series = { ...base, contentReview: readJson(path.join(root, 'samples/content/policy.json')) };
  const queue = readJson(path.join(root, 'samples/story/queue.json'));
  const stack = readJson(path.join(root, 'samples/story/stack.json'));
  const candidate = (id, source, objective) => ({
    plan: { id, title: source.title, topicKey: `content-validation.${id}`, objective,
      angle: '기존 CS 검증본의 A와 B 예시', references: [] },
    story: validateSpec({ ...structuredClone(source), profile: series.renderProfile }),
  });
  const correct = candidate('correct-queue', queue, '큐의 선입선출 순서를 이해한다.');
  const wrongSource = structuredClone(stack);
  wrongSource.narration.find(cue => cue.id === 'idea').text = '스택은 먼저 들어간 값을 먼저 꺼내는 선입선출 자료 구조입니다.';
  Object.assign(wrongSource.scenes.find(scene => scene.id === 'definition'), {
    headline: '스택은 먼저 온\n값부터 꺼내요', body: '스택은 선입선출\nFIFO 순서입니다.',
  });
  const incorrect = candidate('incorrect-stack', wrongSource, '스택의 꺼내는 순서를 이해한다.');
  const unsupportedSource = structuredClone(queue);
  unsupportedSource.narration.find(cue => cue.id === 'finish').text = '덱으로 만든 큐는 모든 작업에서 리스트로 만든 큐보다 정확히 열 배 빠릅니다.';
  Object.assign(unsupportedSource.scenes.find(scene => scene.id === 'summary'), {
    headline: '덱 큐는 언제나\n정확히 10배 빠름', body: '모든 작업에서 같은 차이',
  });
  const unsupported = candidate('unsupported-queue', unsupportedSource, '큐의 순서와 처리 속도를 설명한다.');
  return { series, cases: [
    { id: 'supported', description: '기존 큐 예제의 대본·장면을 변경하지 않고 근거 자료에 대조한다.', entries: [correct],
      expected: { status: 'passed', correctionPlanIds: [], reviewPlanIds: [] } },
    { id: 'contradicted', description: '기존 스택 예제의 정의만 의도적으로 FIFO로 바꿔 자료 및 다른 장면과의 모순을 검증한다.', entries: [incorrect],
      expected: { status: 'corrections', correctionPlanIds: ['incorrect-stack'], reviewPlanIds: [] } },
    { id: 'unsupported', description: '기존 큐 예제의 마지막 장면에 근거 없는 모든 작업의 10배 성능 주장을 추가한다.', entries: [unsupported],
      expected: { status: 'needs_review', reviewPlanIds: ['unsupported-queue'] } },
  ] };
}

// Explicit live model evaluation. It does not write the planning catalog, source examples, or videos.
async function main() {
  const root = path.resolve(__dirname, '../..');
  const { series, cases } = buildCases(root);
  const bundle = readEvidenceBundle(root, series);
  assert.equal(bundle.status, 'ready', 'Registered reference documents must be readable for the live evaluation.');
  const directory = path.join(root, 'runs', '_content', 'validation-' + randomUUID().slice(0, 12));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'cases.json'), json({ description: '의도적으로 변형한 검증 데이터이며 새로운 게시 회차가 아닙니다.', series, cases }));
  const check = createContentChecker({ provider: createCodexProvider(), log: console.log });
  const summary = { version: 1, liveModel: true, sourceHash: bundle.sourceHash, createdAt: new Date().toISOString(),
    description: '기존 CS 예제와 등록된 로컬 근거 스냅샷을 실제 모델로 검증한다. 자동 사실 검증의 일반적인 정확도 측정은 아니다.', results: [] };
  const save = () => fs.writeFileSync(path.join(directory, 'validation.json'), json(summary));
  let mismatch = false;
  for (const fixture of cases) {
    console.log(`[content-evaluation] ${fixture.id}: ${collectUnits(fixture.entries).length} text units`);
    try {
      const report = await check({ series, entries: fixture.entries, bundle, directory: path.join(directory, fixture.id) });
      const actual = { status: report.status, correctionPlanIds: report.correctionPlanIds, reviewPlanIds: report.reviewPlanIds };
      let matchesExpected = true;
      for (const [key, expected] of Object.entries(fixture.expected)) {
        if (JSON.stringify(actual[key]) !== JSON.stringify(expected)) matchesExpected = false;
      }
      mismatch ||= !matchesExpected;
      summary.results.push({ caseId: fixture.id, description: fixture.description, expected: fixture.expected, actual, matchesExpected,
        reportPath: report.reportPath, unresolved: report.units.filter(unit => ['contradicted', 'uncertain'].includes(unit.verdict))
          .map(({ location, claim, verdict, reason }) => ({ location, claim, verdict, reason })) });
      console.log(`[content-evaluation] ${fixture.id}: ${report.status}; expected=${matchesExpected}`);
    } catch (error) {
      mismatch = true;
      summary.results.push({ caseId: fixture.id, expected: fixture.expected, actual: { error: error.message, code: error.code }, matchesExpected: false });
      console.log(`[content-evaluation] ${fixture.id}: ${error.code || 'failed'}; ${error.message}`);
    }
    save();
  }
  const missingSeries = structuredClone(series);
  missingSeries.contentReview.sources[0].path = 'samples/content/sources/_intentionally_missing_source.txt';
  const missingBundle = readEvidenceBundle(root, missingSeries);
  let modelCalls = 0;
  const missing = await createContentChecker({ provider: async () => { modelCalls++; throw new Error('Unavailable sources must not call the model.'); } })({
    series: missingSeries, entries: cases[0].entries, bundle: missingBundle, directory: path.join(directory, 'unavailable-source'),
  });
  const missingMatches = missing.status === 'needs_review' && modelCalls === 0 && missing.reviewPlanIds.includes('correct-queue');
  mismatch ||= !missingMatches;
  summary.results.push({ caseId: 'unavailable-source', liveModel: false, expected: { status: 'needs_review', modelCalls: 0 },
    actual: { status: missing.status, modelCalls, reviewPlanIds: missing.reviewPlanIds }, matchesExpected: missingMatches, reportPath: missing.reportPath });
  summary.passed = !mismatch;
  summary.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ passed: summary.passed, results: summary.results.map(({ caseId, actual, matchesExpected }) => ({ caseId, actual, matchesExpected })),
    validationPath: path.join(directory, 'validation.json') }, null, 2));
  assert.equal(summary.passed, true, 'Live content review results did not match the evaluation cases. Inspect validation.json before proceeding.');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildCases };
