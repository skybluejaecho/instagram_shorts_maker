const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { registerSeries, addPlans, createBatchFromPlans, readCatalog } = require('../planning.cjs');
const { runProduction } = require('../production.cjs');
const { inspectEpisode } = require('../runner.cjs');
const { inspectReview } = require('../review.cjs');
const { createStages } = require('../story/adapter.cjs');
const { validateSpec } = require('../story/spec.cjs');
const { createTools } = require('../tools.cjs');
const { createCodexProvider } = require('../generation/provider.cjs');
const { createContentChecker, validateContentReport } = require('./checker.cjs');

const json = value => JSON.stringify(value, null, 2) + '\n';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function fileRecord(file) {
  const stat = fs.statSync(file);
  return { path: path.resolve(file), bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: sha(fs.readFileSync(file)) };
}

function existingEpisodeSnapshot(root, episodeId) {
  const catalog = readCatalog(root);
  const entry = catalog.episodes[episodeId];
  assert.ok(entry, 'Required original episode must exist: ' + episodeId);
  const stateFile = path.join(root, 'runs', episodeId, 'state.json');
  const state = read(stateFile);
  const files = { input: fileRecord(path.resolve(root, entry.episode)), state: fileRecord(stateFile) };
  for (const [stageId, record] of Object.entries(state.stages)) {
    if (record.status !== 'done') continue;
    for (const name of Object.keys(record.outputs || {})) files[stageId + '/' + name] = fileRecord(path.join(root, 'runs', episodeId, record.dir, name));
  }
  const reviewFile = path.join(root, 'runs', episodeId, 'review.json');
  if (fs.existsSync(reviewFile)) files.review = fileRecord(reviewFile);
  return { entry, plan: catalog.plans[entry.seriesId][entry.planId], state, files };
}

async function seedActualSpeech(root, sourceEpisodeId, episodeId, tools) {
  const catalog = readCatalog(root);
  const sourceState = read(path.join(root, 'runs', sourceEpisodeId, 'state.json'));
  const sourceRecord = sourceState.stages.speech;
  assert.equal(sourceRecord.status, 'done');
  const targetDir = path.join(root, 'runs', episodeId);
  assert.equal(fs.existsSync(path.join(targetDir, 'state.json')), false, 'Speech seeding only applies to a fresh validation episode.');
  const relative = 'artifacts/speech/imported-existing-speech';
  for (const name of Object.keys(sourceRecord.outputs)) {
    const source = path.join(root, 'runs', sourceEpisodeId, sourceRecord.dir, name);
    const destination = path.join(targetDir, relative, name);
    assert.equal(sha(fs.readFileSync(source)), sourceRecord.outputs[name]);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    const stat = fs.statSync(source);
    fs.utimesSync(destination, stat.atime, stat.mtime);
  }
  const record = { ...structuredClone(sourceRecord), dir: relative };
  fs.writeFileSync(path.join(targetDir, 'state.json'), json({ version: 1, status: 'new', stages: { speech: record } }), { flag: 'wx' });
  const entry = catalog.episodes[episodeId];
  const speech = createStages({ root, episodeFile: path.resolve(root, entry.episode), tools }).find(stage => stage.id === 'speech');
  const inspection = await inspectEpisode(targetDir, [speech]);
  assert.equal(inspection.steps[0].current, true, 'Copied real speech must match the current narration, voice and synthesis implementation.');
  return { sourceEpisodeId, sourceRecord, targetRecord: record, verifiedCurrent: true,
    files: Object.fromEntries(Object.keys(record.outputs).map(name => [name, fileRecord(path.join(targetDir, relative, name))])) };
}

function callCounts(events, phase) {
  const counts = {};
  for (const event of events.filter(event => event.phase === phase && event.event === 'start')) counts[event.kind] = (counts[event.kind] || 0) + 1;
  return counts;
}

function renderReport(directory, report) {
  const link = (file, label) => file ? `<a href="${html(path.relative(directory, file).split(path.sep).map(encodeURIComponent).join('/'))}">${html(label)}</a>` : '';
  const repaired = report.repaired;
  const gap = report.insufficient;
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>제작 단계 제목·화면 자동 보완 검증</title>
<style>body{font:16px/1.65 "Malgun Gothic",Arial,sans-serif;max-width:1300px;margin:32px auto;padding:0 24px;background:#f2f6f8;color:#193442}section{background:white;border-radius:12px;margin:20px 0;padding:24px}h1{font-size:30px}h2{font-size:22px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7f9;padding:16px}a{display:inline-block;margin:4px 14px 4px 0;color:#086d9f}.status{font-weight:bold;color:${report.passed ? '#087245' : '#a43b22'}}table{border-collapse:collapse;width:100%}td,th{text-align:left;border-bottom:1px solid #d7e2e8;padding:10px;vertical-align:top}code{overflow-wrap:anywhere}</style>
<h1>제작 단계 제목·화면 자동 보완 검증</h1><p class="status">${report.passed ? '자동 보완·음성 재사용·근거 부족 보류 검증 통과' : '미완료 / 확인 필요'}</p>
<section><h2>검증 방식</h2><p>이전 CS maxlen 회차의 실제 보류 보고서를 같은 대본·근거 해시에 대조해 첫 검사 결과로 재생했습니다. 자동 보완 모델과 수정 후 내용 검증, 실제 Chrome 화면 검수, MP4 제작은 새로 실행했습니다. 이전 결과를 새 모델 판정이라고 표시하지 않습니다.</p><p>음성은 완성된 원본 회차의 실제 WAV·타이밍과 stage key를 검증용 회차에 복사했습니다. 생성 입력과 일치하는 현재 캐시임을 확인한 뒤, 자동 보완에서 재합성하지 않고 재사용하는지 검사했습니다. 원본 세 회차의 입력·영상·검토 상태는 변경하지 않았습니다.</p></section>
<section><h2>자동 보완 결과</h2><p>수정 전: ${html(repaired?.beforeTitle)}</p><p>수정 후: ${html(repaired?.afterTitle)}</p><p>상태: ${html(repaired?.review?.status)} · 보완 모델 호출 ${html(report.counts?.repair?.['model:repair'] || 0)}회 · 음성 합성 ${html(report.counts?.repair?.['tool:powershell'] || 0)}회</p>${link(repaired?.review?.videoPath, '보완된 MP4')}${link(repaired?.review?.reportPath, '기술 검수')}${link(repaired?.visualReportPath, '화면 검수')}${link(repaired?.contentReportPath, '내용 검증')}${link(repaired?.repairReportPath, '자동 보완 기록')}<pre>${html(JSON.stringify(report.speechReuse, null, 2))}</pre></section>
<section><h2>근거 부족과 재실행</h2><p>두 번째 복사본에는 deque 내용을 뒷받침하지 않는 Qt 실행 취소 자료만 등록하여 실제 내용 검증을 실행했습니다.</p><table><tr><th>항목</th><th>결과</th></tr><tr><td>근거 부족</td><td>${html(gap?.status)} · 보완 호출 ${html(report.counts?.insufficient?.['model:repair'] || 0)}회 · 입력 변경 ${html(gap?.inputChanged)}</td></tr><tr><td>같은 보류 재실행</td><td>새 모델·미디어 호출 ${html(report.replay?.heldStartCalls)}</td></tr><tr><td>완료 회차 재실행</td><td>새 모델·단계·미디어 호출 ${html(report.replay?.completedStartCalls)}</td></tr><tr><td>기존 완료 회차</td><td>${html(report.originalPreservation?.length)}편의 입력·상태·모든 단계 파일 경로·SHA256·수정 시간 동일</td></tr></table>${link(gap?.contentReportPath, '근거 부족 내용 보고서')}${link(gap?.repairReportPath, '검토 대기 기록')}</section>
<section><h2>기록과 최종 확인</h2><p>보완은 최대 두 번으로 제한됩니다. 이번 실제 사례의 실행 횟수는 위에 표시하며, 한계 소진·범위 밖 변경 등은 별도 자동 테스트로 검사합니다. 완성 영상은 사람의 최종 승인을 기다립니다.</p>${link(path.join(directory, 'validation.json'), '전체 검증 증거')}${link(path.join(directory, 'events.json'), '호출 기록')}${link(path.join(directory, 'originals-before.json'), '원본 회차 보존 기준')}${report.error ? `<pre>${html(report.error)}</pre>` : ''}</section></html>`;
}

async function main() {
  if (process.argv.length > 2) throw Error('This live validation accepts no arguments and creates a new isolated run.');
  const root = path.resolve(__dirname, '../..');
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 6);
  const suffix = randomUUID().slice(0, 8);
  const directory = path.join(root, 'runs', '_content-repairs', 'validation-' + runId);
  fs.mkdirSync(directory, { recursive: true });
  const write = (name, data) => fs.writeFileSync(path.join(directory, name), json(data));
  const events = [];
  let phase = 'setup';
  const event = (kind, action, details = {}) => { const entry = { at: new Date().toISOString(), phase, kind, event: action, ...details }; events.push(entry); fs.appendFileSync(path.join(directory, 'events.ndjson'), JSON.stringify(entry) + '\n'); };
  const log = message => { event('log', 'message', { message }); console.log(message); };
  const track = (kind, fn) => async (...args) => { event(kind, 'start'); try { const value = await fn(...args); event(kind, 'done'); return value; } catch (error) { event(kind, 'failed', { error: error.message }); throw error; } };
  const originalIds = ['cs-auto-live-cs-auto-live-01-b01-01', 'cs-auto-live-cs-auto-live-01-b01-02', 'cs-auto-live-cs-auto-live-01-b02-01'];
  const originalsBefore = Object.fromEntries(originalIds.map(id => [id, existingEpisodeSnapshot(root, id)]));
  write('originals-before.json', originalsBefore);
  const result = { version: 1, createdAt: new Date().toISOString(), directory, passed: false };
  try {
    const fixtureDir = path.join(root, 'samples/content-repair');
    const provenance = read(path.join(fixtureDir, 'provenance.json'));
    for (const item of provenance.inputs) assert.equal(sha(fs.readFileSync(path.resolve(root, item.fixture))), item.sha256);
    write('fixture-provenance.json', provenance);
    const originalPlan = read(path.join(fixtureDir, 'original-plan.json'));
    const originalStory = read(path.join(fixtureDir, 'original-episode.json'));
    const archivedReport = read(path.join(fixtureDir, 'archived-hold-report.json'));
    const template = readCatalog(root).series['cs-auto-live'];
    const cases = {};
    for (const [name, contentReview] of [['repair', template.contentReview], ['insufficient', { mode: 'required', sources: template.contentReview.sources.filter(source => source.id === 'qt-undo') }]]) {
      const seriesId = (name === 'repair' ? 'repair-cs-' : 'repair-gap-') + suffix;
      const series = { ...template, id: seriesId, name: `자동 문구 보완 검증 (${name})`, contentReview };
      await registerSeries(root, series);
      const { seriesId: omittedSeries, input: omittedInput, scheduledFor: omittedDate, ...basePlan } = originalPlan;
      await addPlans(root, seriesId, [{ ...basePlan, input: 'samples/content-repair/original-episode.json' }]);
      const batch = await createBatchFromPlans(root, seriesId, (name === 'repair' ? 'repair-ok-' : 'repair-gap-') + suffix, { planIds: [basePlan.id] });
      cases[name] = { seriesId, episodeId: batch.episodeIds[0], batchId: batch.batchId };
    }
    result.cases = cases;
    write('cases.json', cases);
    const actualProvider = createCodexProvider();
    const actualChecker = createContentChecker({ provider: track('model:content', actualProvider), log });
    const repairProvider = track('model:repair', actualProvider);
    const originalTools = createTools(root);
    const tools = Object.fromEntries(Object.entries(originalTools).map(([name, fn]) => [name, track('tool:' + name, fn)]));
    const seed = await seedActualSpeech(root, originalIds[0], cases.repair.episodeId, tools);
    write('seeded-speech.json', seed);
    const repairBefore = existingEpisodeSnapshot(root, cases.repair.episodeId);
    write('repair-before.json', repairBefore);
    let archivedReplayPending = true;
    const repairChecker = async options => {
      if (archivedReplayPending) {
        archivedReplayPending = false;
        validateContentReport(archivedReport, options.entries, options.bundle);
        assert.equal(archivedReport.entryHash, require('./checker.cjs').contentEntryHash(options.entries));
        event('archived_hold_replay', 'used', { source: provenance.inputs.find(item => item.fixture.endsWith('archived-hold-report.json')).source,
          entryHash: archivedReport.entryHash, sourceHash: archivedReport.sourceHash, createdAt: archivedReport.createdAt });
        log('기존 실제 보류 판정을 입력·근거 해시에 대조해 재생합니다. 수정 후보와 재검사는 실제 모델을 사용합니다.');
        return structuredClone(archivedReport);
      }
      return actualChecker(options);
    };
    const make = (episodeId, contentChecker) => {
      const entry = readCatalog(root).episodes[episodeId];
      return createStages({ root, episodeFile: path.resolve(root, entry.episode), tools, contentChecker })
        .map(stage => ({ ...stage, run: track('stage:' + stage.id, stage.run) }));
    };
    const run = (episodeId, contentChecker) => runProduction({ root, episodeId, workDir: path.join(root, 'runs', episodeId), contentChecker, repairProvider, log,
      createStages: ({ contentChecker: supplied = contentChecker } = {}) => make(episodeId, supplied) });
    phase = 'repair';
    await run(cases.repair.episodeId, repairChecker);
    assert.equal(archivedReplayPending, false);
    const repaired = existingEpisodeSnapshot(root, cases.repair.episodeId);
    const repairedEntry = readCatalog(root).episodes[cases.repair.episodeId];
    const repairedStory = read(path.resolve(root, repairedEntry.episode));
    const normalizedOriginal = validateSpec(originalStory);
    const normalizedAfter = validateSpec(repairedStory);
    assert.deepEqual(normalizedAfter.narration, normalizedOriginal.narration);
    assert.deepEqual(normalizedAfter.profile, normalizedOriginal.profile);
    assert.equal(repaired.plan.topicKey, originalPlan.topicKey);
    assert.equal(repaired.plan.objective, originalPlan.objective);
    assert.equal(repaired.plan.title, repairedStory.title);
    assert.notEqual(repaired.files.input.sha256, repairBefore.files.input.sha256, 'The broad text must be changed by the repair model.');
    const repairCounts = callCounts(events, phase);
    assert.ok(repairCounts['model:repair'] >= 1 && repairCounts['model:repair'] <= 2, 'Live repair must request one or two proposals.');
    assert.equal(repairCounts['tool:powershell'] || 0, 0, 'Existing speech must not be synthesized again.');
    assert.equal(repairCounts['tool:render'], 1, 'The repaired video must be rendered for real.');
    assert.deepEqual(repaired.state.stages.speech, seed.targetRecord);
    for (const [name, record] of Object.entries(seed.files)) assert.deepEqual(fileRecord(path.join(root, 'runs', cases.repair.episodeId, seed.targetRecord.dir, name)), record);
    const review = await inspectReview(path.join(root, 'runs', cases.repair.episodeId), make(cases.repair.episodeId, actualChecker));
    assert.equal(review.status, 'ready_for_review');
    const technical = read(review.reportPath);
    assert.deepEqual(technical, { width: 1080, height: 1920, fps: 30, frames: 900, durationSeconds: 30, videoCodec: 'h264', audioCodec: 'aac' });
    const contentReportPath = path.join(root, 'runs', cases.repair.episodeId, repaired.state.stages.content.dir, 'report.json');
    const visualReportPath = path.join(root, 'runs', cases.repair.episodeId, repaired.state.stages.visual.dir, 'report.html');
    assert.equal(read(contentReportPath).status, 'passed');
    result.repaired = { episodeId: cases.repair.episodeId, beforeTitle: originalPlan.title, afterTitle: repaired.plan.title, review,
      contentReportPath, visualReportPath, repairReportPath: repaired.state.contentRepair?.reportPath, snapshot: repaired, technical };
    result.speechReuse = { sourceEpisodeId: originalIds[0], originalSpeechHash: seed.sourceRecord.outputs['voice/narration.wav'],
      copiedSpeechHash: seed.targetRecord.outputs['voice/narration.wav'], synthesisCalls: 0, stageRecordUnchanged: true, files: seed.files };
    write('repair-result.json', result.repaired);
    phase = 'repair-replay';
    await run(cases.repair.episodeId, actualChecker);
    const completedStarts = events.filter(item => item.phase === phase && item.event === 'start');
    assert.equal(completedStarts.length, 0, 'An unchanged completed episode must invoke no models, tools or stage execution.');
    assert.deepEqual(existingEpisodeSnapshot(root, cases.repair.episodeId), repaired);
    phase = 'insufficient';
    const gapEntry = readCatalog(root).episodes[cases.insufficient.episodeId];
    const gapBefore = fileRecord(path.resolve(root, gapEntry.episode));
    let gapError;
    try { await run(cases.insufficient.episodeId, actualChecker); } catch (error) { gapError = error; }
    assert.ok(gapError, 'Insufficient evidence must not publish a video.');
    assert.equal(gapError.code, 'CONTENT_REVIEW_REQUIRED');
    const gap = existingEpisodeSnapshot(root, cases.insufficient.episodeId);
    assert.equal(gap.state.status, 'needs_review');
    assert.deepEqual(fileRecord(path.resolve(root, gapEntry.episode)), gapBefore);
    const gapCounts = callCounts(events, phase);
    assert.ok(gapCounts['model:content'] >= 1, 'The insufficient-evidence judgment must be made by the actual checker.');
    assert.equal(gapCounts['model:repair'] || 0, 0, 'Missing narration support is outside safe wording repair scope.');
    assert.equal(Object.keys(gapCounts).filter(name => name.startsWith('tool:')).length, 0, 'Insufficient evidence must block all media work.');
    const gapReportPath = path.join(root, 'runs', cases.insufficient.episodeId, gap.state.stages.content.dir, 'report.json');
    assert.equal(read(gapReportPath).status, 'needs_review');
    result.insufficient = { episodeId: cases.insufficient.episodeId, status: gap.state.status, error: gapError.message, inputChanged: false,
      contentReportPath: gapReportPath, repairReportPath: gap.state.contentRepair?.reportPath, snapshot: gap };
    phase = 'insufficient-replay';
    await assert.rejects(run(cases.insufficient.episodeId, actualChecker), error => error.code === 'CONTENT_REVIEW_REQUIRED');
    const heldStarts = events.filter(item => item.phase === phase && item.event === 'start');
    assert.equal(heldStarts.length, 0, 'Unchanged held evidence must not trigger another model or media call.');
    assert.deepEqual(fileRecord(path.resolve(root, gapEntry.episode)), gapBefore);
    result.replay = { completedStartCalls: completedStarts.length, heldStartCalls: heldStarts.length };
    const originalsAfter = Object.fromEntries(originalIds.map(id => [id, existingEpisodeSnapshot(root, id)]));
    assert.deepEqual(originalsAfter, originalsBefore, 'The three existing completed originals must remain exactly unchanged.');
    write('originals-after.json', originalsAfter);
    result.originalPreservation = originalIds.map(episodeId => ({ episodeId, unchanged: true }));
    result.passed = true;
  } catch (error) {
    result.error = error.stack || error.message;
    result.failedPhase = phase;
    console.error(result.error);
    const current = Object.fromEntries(originalIds.map(id => [id, existingEpisodeSnapshot(root, id)]));
    write('originals-after-failure.json', current);
    result.originalsUnchangedOnFailure = JSON.stringify(current) === JSON.stringify(originalsBefore);
  }
  result.counts = Object.fromEntries(['repair', 'repair-replay', 'insufficient', 'insufficient-replay'].map(name => [name, callCounts(events, name)]));
  result.events = events;
  write('events.json', events);
  write('validation.json', result);
  fs.writeFileSync(path.join(directory, 'index.html'), renderReport(directory, result));
  console.log(json({ passed: result.passed, report: path.join(directory, 'index.html'), evidence: path.join(directory, 'validation.json'), cases: result.cases, counts: result.counts }));
  if (!result.passed) process.exitCode = 1;
  return result;
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main, existingEpisodeSnapshot, seedActualSpeech, renderReport };
