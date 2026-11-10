const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { registerSeries, addPlans, readCatalog } = require('../../pipeline/planning.cjs');
const { createPeriod } = require('../../pipeline/period/planning.cjs');
const { readEvidenceBundle } = require('../../pipeline/content/sources.cjs');
const root = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8').replace(/^\uFEFF/, ''));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

async function main() {
  const config = read('samples/period-auto/run.json');
  const catalog = readCatalog(root);
  const directory = path.resolve(root, config.evidenceDirectory);
  const snapshotDirectory = path.join(__dirname, 'history');
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(snapshotDirectory, { recursive: true });
  const series = { ...catalog.series['story-demo'], id: config.seriesId,
    name: 'CS 신규 자동 기획·기간 제작 통합 검증', contentReview: read('samples/period-auto/content-policy.json') };
  const evidence = readEvidenceBundle(root, series);
  if (evidence.status !== 'ready') throw new Error(JSON.stringify(evidence.issues));
  const imported = [];
  const history = Object.values(catalog.plans['story-demo']).map(plan => {
    const materialized = Object.values(catalog.episodes).find(episode => episode.seriesId === 'story-demo' && episode.planId === plan.id);
    const sourcePath = materialized?.episode || plan.input;
    const bytes = fs.readFileSync(path.resolve(root, sourcePath));
    const destination = path.join(snapshotDirectory, plan.id + '.json');
    if (fs.existsSync(destination)) {
      if (hash(fs.readFileSync(destination)) !== hash(bytes)) throw new Error('Historical source changed after pilot setup: ' + plan.id);
    } else fs.writeFileSync(destination, bytes, { flag: 'wx' });
    const input = path.relative(root, destination).split(path.sep).join('/');
    imported.push({ sourceSeriesId: 'story-demo', sourcePlanId: plan.id, sourcePath,
      input, sha256: hash(bytes), destinationPlanId: 'history-' + plan.id });
    return { id: 'history-' + plan.id, title: plan.title, topicKey: plan.topicKey, objective: plan.objective,
      angle: plan.angle, references: plan.references, ...(plan.knowledge ? { knowledge: plan.knowledge } : {}), input };
  });
  await registerSeries(root, series);
  await addPlans(root, series.id, history);
  const created = await createPeriod(root, read('samples/period-auto/period.json'));
  const manifest = { version: 1, purpose: 'Live generation from new topics, with immutable copies of seven existing CS episodes as duplicate-detection history. Imported history is not newly generated or newly published.',
    series, period: created.period, importedHistory: imported,
    sources: evidence.sources.map(({ id, title, path: sourcePath, url, sha256 }) => ({ id, title, path: sourcePath, url, sha256 })) };
  const setupPath = path.join(directory, 'setup.json');
  if (!fs.existsSync(setupPath)) fs.writeFileSync(setupPath, json(manifest), { flag: 'wx' });
  fs.writeFileSync(path.join(__dirname, 'series.json'), json(series));
  fs.writeFileSync(path.join(__dirname, 'history-plans.json'), json(history));
  const interventionsPath = path.join(directory, 'interventions.json');
  if (!fs.existsSync(interventionsPath)) fs.writeFileSync(interventionsPath, json([
    { phase: 'setup', actor: 'assistant', category: 'configuration', action: '기존 CS 디자인·음성과 3일 일정, 묶음 크기 2를 설정하고 기존 7편 이력의 현재 입력을 복사했다.', requiredUserInput: false },
    { phase: 'setup', actor: 'assistant', category: 'source_curation', action: '기존 Python·Qt 자료와 공식 deque 문서의 로컬 참고 노트를 required 근거로 등록했다. 주제나 새 대본은 직접 지정하지 않았다.', requiredUserInput: false },
    { phase: 'final_review', actor: 'user', category: 'approval', status: 'pending', action: '완성 영상의 설명·발음·시각적 흐름을 확인하고 최종 승인 또는 수정 요청을 남긴다.' }
  ]), { flag: 'wx' });
  console.log(json({ periodId: created.period.id, reused: created.reused, historyCount: history.length, sourceCount: evidence.sources.length, evidenceDirectory: directory }));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
