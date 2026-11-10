const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { readCatalog } = require('../planning.cjs');
const { readPeriod } = require('./planning.cjs');
const { runPeriod, inspectPeriod } = require('./engine.cjs');
const { generateBatch } = require('../generation/engine.cjs');
const { createCodexProvider } = require('../generation/provider.cjs');
const { createNoveltyChecker } = require('../novelty/checker.cjs');
const { createContentChecker } = require('../content/checker.cjs');
const { createSpeechPreflight } = require('../generation/preflight.cjs');
const { createStages } = require('../story/adapter.cjs');
const { createTools } = require('../tools.cjs');
const { inspectEpisode } = require('../runner.cjs');
const { runProduction } = require('../production.cjs');
const { inspectReview } = require('../review.cjs');

const json = value => JSON.stringify(value, null, 2) + '\n';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function contained(root, value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) throw Error('Use a repository-relative path.');
  const file = path.resolve(root, value);
  const relative = path.relative(root, file);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw Error('Path is outside repository.');
  return file;
}

function fileRecord(file) {
  const bytes = fs.readFileSync(file);
  const stat = fs.statSync(file);
  return { path: file, sha256: hash(bytes), bytes: stat.size, mtimeMs: stat.mtimeMs };
}

function optionalJson(file) {
  try { return read(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function summarizeCalls(events) {
  const counts = {};
  for (const event of events.filter(event => event.event === 'start')) {
    counts[event.phase] ||= {};
    counts[event.phase][event.kind] = (counts[event.phase][event.kind] || 0) + 1;
  }
  return counts;
}

function generationEvidence(root, period) {
  return period.groups.map(group => {
    const directory = path.join(root, 'runs', '_generation', group.id);
    const state = optionalJson(path.join(directory, 'state.json'));
    return { batchId: group.id, directory, state, stateFile: state ? fileRecord(path.join(directory, 'state.json')) : null,
      report: state ? { status: state.status, error: state.error, attempts: state.attempts.map(attempt => ({
        id: attempt.id, status: attempt.status, error: attempt.error, replacedPlanIds: attempt.replacedPlanIds,
        directory: path.join(directory, attempt.directory), candidatePath: attempt.candidatePath,
        semanticReportFile: attempt.semanticReportFile, contentReportFile: attempt.contentReportFile,
      })), semanticReport: state.semanticReport, contentReport: state.contentReport } : null };
  });
}

async function snapshot(root, periodId, inspect) {
  const period = readPeriod(root, periodId);
  const catalog = readCatalog(root);
  const catalogFile = path.join(root, 'planning/catalog.json');
  const episodes = {};
  for (const slot of period.slots.filter(slot => slot.episodeId)) {
    const id = slot.episodeId;
    const entry = catalog.episodes[id];
    const info = await inspect(id);
    const outputs = {};
    for (const [stageId, stage] of Object.entries(info.state.stages)) {
      if (stage.status !== 'done') continue;
      outputs[stageId] = {};
      for (const filename of Object.keys(stage.outputs || {})) outputs[stageId][filename] = fileRecord(path.join(root, 'runs', id, stage.dir, filename));
    }
    const reportFor = stageId => {
      const stage = info.state.stages[stageId];
      return stage?.dir ? optionalJson(path.join(root, 'runs', id, stage.dir, 'report.json')) : null;
    };
    episodes[id] = { input: fileRecord(path.resolve(root, entry.episode)), plan: catalog.plans[period.seriesId][slot.planId],
      entry, state: info.state, current: info.current, status: info.status, review: info.review, outputs,
      technical: reportFor('verify'), visual: reportFor('visual'), content: reportFor('content') };
  }
  return { period, catalog: fileRecord(catalogFile), episodes, generation: generationEvidence(root, period) };
}

function humanReviewPoints(view, snapshots, interventions) {
  const points = [];
  for (const row of view.rows) {
    if (['failed', 'needs_review', 'interrupted'].includes(row.status)) points.push({ type: 'blocked', episodeId: row.episodeId,
      batchId: row.batchId, phase: row.phase, reason: row.error || row.status });
    const visual = snapshots?.episodes[row.episodeId]?.visual;
    for (const issue of visual?.issues || []) if (issue.severity === 'warning') points.push({ type: 'visual_warning',
      episodeId: row.episodeId, sceneId: issue.sceneId, timeSeconds: issue.timeSeconds, code: issue.code, reason: issue.reason });
    if (row.current) points.push({ type: 'final_approval', episodeId: row.episodeId,
      reason: '최종 영상·한국어 발음·이해도·시각적 완성도는 사람이 확인해야 하며 자동 승인하지 않았습니다.' });
  }
  return { recordedInterventions: interventions, requiredChecks: points,
    distinction: '모델의 자동 생성·수정은 자동 처리입니다. 에이전트의 소스·설정·코드·대본 수정은 별도 개입 기록이며 사람 확인 필요 항목과 구분합니다.' };
}

function renderHtml(directory, report) {
  const link = (file, label) => file && fs.existsSync(file) ? `<a href="${escape(path.relative(directory, file).split(path.sep).map(encodeURIComponent).join('/'))}">${escape(label)}</a>` : '';
  const rows = report.view?.rows || [];
  const generation = report.snapshot?.generation || [];
  const problems = report.humanReview?.requiredChecks || [];
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CS 3일 자동 기획·제작 검증</title>
<style>body{font:16px/1.65 "Malgun Gothic",Arial,sans-serif;margin:32px auto;padding:0 24px;max-width:1380px;background:#f3f6f8;color:#193443}h1{font-size:30px}section{background:white;padding:24px;border-radius:12px;margin:20px 0}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:12px;border-bottom:1px solid #d8e2e8;vertical-align:top;text-align:left}small{display:block;color:#526977;overflow-wrap:anywhere}a{display:inline-block;margin:4px 12px 4px 0;color:#076a9b}.scroll{overflow:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f7f9;padding:16px}code{overflow-wrap:anywhere}.status{font-weight:bold;color:${report.passed ? '#087346' : '#a34321'}}</style>
<h1>CS 3일 자동 기획·제작 검증</h1><p class="status">${report.passed ? '제작·재사용 검증 통과' : '미완료 / 확인 필요'} · ${escape(report.periodId)}</p>
<p>${escape(report.createdAt)} · ${escape(report.phase)} · 기존 이력을 비교해 새 주제·대본을 실제 모델로 생성했습니다. 새 회차를 미리 작성하거나 가짜 모델 응답을 주입하지 않았습니다.</p>
<section class="scroll"><table><thead><tr><th>게시 예정</th><th>회차 / 제목</th><th>상태</th><th>검토 자료</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(row.date)} ${escape(row.localTime)}<small>${escape(report.view.period.timezone)}</small></td><td>${escape(row.title || row.slotId)}<small>${escape(row.episodeId || row.batchId)}</small></td><td>${escape(row.status)}<small>${escape(row.phase)} · 기획 ${row.planningAttempts} / 제작 ${row.attempts}</small>${escape(row.error || '')}</td><td>${link(row.review?.videoPath, 'MP4')}${link(row.review?.reportPath, '기술 검수')}${link(row.visualReport && path.join(path.dirname(row.visualReport), 'report.html'), '화면 검수')}${link(row.contentReport, '내용 검증')}</td></tr>`).join('')}</tbody></table></section>
<section><h2>재실행 검증</h2><p>${report.reuse?.passed ? '전체 run 재실행에서 생성·모델·TTS·렌더 호출 0회, 기존 기획·음성·MP4·단계 상태를 보존했습니다. 완료 후 resume는 회차 실행도 0회입니다.' : '세 회차가 모두 검수를 완료한 뒤 재실행 검증을 수행합니다.'}</p><pre>${escape(JSON.stringify(report.callCounts, null, 2))}</pre></section>
<section><h2>자동 생성·수정 기록</h2>${generation.map(group => `<h3>${escape(group.batchId)} — ${escape(group.report?.status || '미시작')}</h3>${link(group.stateFile?.path, '생성 상태·판정 기록')}<pre>${escape(JSON.stringify(group.report?.attempts || [], null, 2))}</pre>`).join('')}</section>
<section><h2>개입과 최종 확인</h2><p>기록된 운영 개입과 자동 검수의 보류·경고를 구분합니다. 마지막 영상 승인은 사람의 확인을 기다립니다.</p><h3>운영 개입 기록</h3><pre>${escape(JSON.stringify(report.humanReview?.recordedInterventions || [], null, 2))}</pre><h3>확인이 필요한 항목</h3><ul>${problems.map(point => `<li>${escape(point.episodeId || point.batchId || '')} · ${escape(point.type)} · ${escape(point.reason)}</li>`).join('')}</ul></section>
<section><p>${link(path.join(directory, 'report.json'), '전체 증거 JSON')}${link(path.join(directory, 'events.json'), '이 실행의 호출·단계 이벤트')}${link(path.join(directory, 'before-replay.json'), '재실행 전 스냅샷')}${link(path.join(directory, 'after-replay.json'), '재실행 후 스냅샷')}${link(report.view?.reportPath, '기간 현황')}</p>${report.error ? `<pre>${escape(report.error)}</pre>` : ''}<p>내용 검증은 등록 자료에 대한 모델 판정이며 화면 검수는 표본 시각 검사입니다. 실제 게시·자동 승인은 수행하지 않았습니다.</p></section></html>`;
}

async function main(argv = process.argv.slice(2)) {
  const root = path.resolve(__dirname, '../..');
  const [configName, mode = 'run'] = argv;
  if (argv.length > 2 || !['run', 'verify'].includes(mode) || !configName) throw Error('Usage: node pipeline/period/validate-auto.cjs <run.json> [run|verify]');
  const config = read(contained(root, configName));
  if (config.jobs !== undefined && (!Number.isInteger(config.jobs) || config.jobs < 1 || config.jobs > 8)) throw Error('jobs must be 1–8.');
  if (config.maxAttempts !== undefined && (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 5)) throw Error('maxAttempts must be 1–5.');
  const period = readPeriod(root, config.periodId);
  if (period.seriesId !== config.seriesId || period.slots.length !== 3 || period.planIds) throw Error('Use an automatic three-episode period with the configured series.');
  const base = contained(root, config.evidenceDirectory);
  fs.mkdirSync(base, { recursive: true });
  const invocation = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8);
  const directory = path.join(base, 'invocations', invocation);
  fs.mkdirSync(directory, { recursive: true });
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), json(value));
  const events = [];
  let phase = mode === 'verify' ? 'verify-existing' : 'production';
  const event = (kind, action, details = {}) => {
    const value = { at: new Date().toISOString(), phase, kind, event: action, ...details };
    events.push(value);
    fs.appendFileSync(path.join(directory, 'events.ndjson'), JSON.stringify(value) + '\n');
    return value;
  };
  const log = message => { event('log', 'message', { message }); console.log(message); };
  const track = (kind, fn, detailsFor = () => ({})) => async (...args) => {
    const details = detailsFor(...args);
    const start = Date.now();
    event(kind, 'start', details);
    try { const value = await fn(...args); event(kind, 'done', { ...details, elapsedMs: Date.now() - start }); return value; }
    catch (error) { event(kind, 'failed', { ...details, elapsedMs: Date.now() - start, error: error.message }); throw error; }
  };
  const provider = createCodexProvider();
  const providerFor = kind => track('model:' + kind, provider, request => ({ directory: request.directory }));
  const noveltyCheck = createNoveltyChecker({ provider: providerFor('novelty'), log });
  const contentCheck = createContentChecker({ provider: providerFor('content-generation'), log });
  const productionCheck = createContentChecker({ provider: providerFor('content-production'), log });
  const preflight = track('preflight', createSpeechPreflight(root, { log }), (entries, dir) => ({ directory: dir, planIds: entries.map(entry => entry.plan.id) }));
  const originalTools = createTools(root);
  const tools = Object.fromEntries(Object.entries(originalTools).map(([name, fn]) => [name,
    track('tool:' + name, fn, (...args) => ({ target: args[0] }))]));
  const stagesFor = (id, { contentChecker = productionCheck } = {}) => {
    const entry = readCatalog(root).episodes[id];
    if (!entry) throw Error('Unknown episode: ' + id);
    return createStages({ root, episodeFile: path.resolve(root, entry.episode), tools, contentChecker });
  };
  const inspect = async id => {
    const stages = stagesFor(id);
    const workDir = path.join(root, 'runs', id);
    const { state, steps } = await inspectEpisode(workDir, stages);
    const current = steps.length > 0 && steps.every(step => step.current);
    const review = await inspectReview(workDir, stages);
    return { state, current, review, status: state.status === 'ready_for_review' && !current ? 'needs_rebuild' : state.status,
      details: steps.map(step => ({ id: step.id, label: step.current ? 'current' : !state.stages[step.id] ? 'pending' : state.stages[step.id].status === 'done' ? 'needs_rebuild' : state.stages[step.id].status,
        error: state.stages[step.id]?.error })) };
  };
  const execute = track('execute', async id => {
    return runProduction({ root, episodeId: id, workDir: path.join(root, 'runs', id),
      createStages: overrides => stagesFor(id, overrides).map(stage => ({ ...stage, run: track('stage:' + stage.id, stage.run, context => ({ episodeId: id, directory: context.dir })) })),
      contentChecker: productionCheck, repairProvider: providerFor('content-repair'),
      log: message => log(`[${id}] ${message}`) });
  }, id => ({ episodeId: id }));
  const generate = track('generate', request => generateBatch(root, { ...request, provider: providerFor('generation'),
    noveltyCheck, contentCheck, preflight, maxAttempts: config.maxAttempts || 3, log }), request => request);
  const options = { generate, execute, inspect, jobs: config.jobs || 2, log };
  let view;
  let currentSnapshot;
  let reuse;
  let failure;
  try {
    write('configuration.json', { config, mode, initialPeriod: period });
    view = mode === 'verify' ? await inspectPeriod(root, config.periodId, { inspect }) : await runPeriod(root, config.periodId, options);
    write('production-view.json', view);
    currentSnapshot = await snapshot(root, config.periodId, inspect);
    write('production-snapshot.json', currentSnapshot);
    if (view.rows.length === 3 && view.rows.every(row => row.current)) {
      const before = currentSnapshot;
      write('before-replay.json', before);
      phase = 'full-replay';
      const replay = await runPeriod(root, config.periodId, options);
      write('full-replay-view.json', replay);
      const after = await snapshot(root, config.periodId, inspect);
      write('after-replay.json', after);
      assert.deepEqual(after, before, 'Full replay must preserve catalog, generation journals, episode inputs, all stage files and state.');
      const replayStarts = events.filter(item => item.phase === phase && item.event === 'start');
      assert.equal(replayStarts.filter(item => item.kind === 'execute').length, 3);
      assert.equal(replayStarts.filter(item => item.kind !== 'execute').length, 0, 'Replay must invoke no generator, model, TTS, media tool or stage execution.');
      phase = 'resume-complete';
      const resumed = await runPeriod(root, config.periodId, { ...options, resume: true });
      write('resume-view.json', resumed);
      assert.equal(events.filter(item => item.phase === phase && item.event === 'start').length, 0, 'Completed resume must execute nothing.');
      assert.deepEqual(await snapshot(root, config.periodId, inspect), before);
      for (const episode of Object.values(after.episodes)) {
        assert.equal(episode.content?.status, 'passed', 'Actual source-grounded content check must pass.');
        assert.ok(['passed', 'warnings'].includes(episode.visual?.status), 'Actual browser visual check must complete.');
        assert.deepEqual(episode.technical, { width: 1080, height: 1920, fps: 30, frames: 900, durationSeconds: 30, videoCodec: 'h264', audioCodec: 'aac' });
        assert.equal(episode.review.status, 'ready_for_review', 'Final human approval remains pending.');
      }
      reuse = { passed: true, fullReplayExecuteCalls: 3, fullReplayModelCalls: 0, fullReplaySpeechCalls: 0, fullReplayRenderCalls: 0,
        fullReplayGenerationCalls: 0, completeResumeExecuteCalls: 0,
        unchanged: ['catalog', 'generation journals', 'episode input JSON', 'episode state', 'all declared stage outputs, paths, SHA256 and mtimes'],
        episodes: Object.entries(after.episodes).map(([id, info]) => ({ id, narration: info.outputs.speech['voice/narration.wav'], video: info.outputs.render['video.mp4'] })) };
      view = resumed;
      currentSnapshot = after;
    } else failure = 'Three current, verified videos are required before replay validation. See blocking rows and recorded reports.';
  } catch (error) {
    failure = error.stack || error.message;
    event('validation', 'failed', { error: error.message });
    try { view = await inspectPeriod(root, config.periodId, { inspect }); } catch { /* Preserve the original failure. */ }
    try { currentSnapshot = await snapshot(root, config.periodId, inspect); } catch { /* Incomplete stages remain in period state. */ }
  }
  const interventions = optionalJson(path.join(base, 'interventions.json')) || [];
  const report = { version: 1, passed: Boolean(reuse?.passed && !failure), periodId: config.periodId, seriesId: config.seriesId,
    createdAt: new Date().toISOString(), invocation, directory, phase, mode, error: failure, view,
    snapshot: currentSnapshot, reuse, callCounts: summarizeCalls(events), events,
    humanReview: humanReviewPoints(view || { rows: [] }, currentSnapshot, interventions),
    limitations: ['Model factual judgment is grounded in registered local notes, not a guarantee of all facts.',
      'Visual review measures fixed sample instants, not every video frame.', 'Preflight TTS and production TTS are separate first-run syntheses; completed replay invokes neither.',
      'Final human approval and posting were not performed.'] };
  write('events.json', events);
  write('report.json', report);
  fs.writeFileSync(path.join(directory, 'index.html'), renderHtml(directory, report));
  const manifestFile = path.join(base, 'manifest.json');
  const manifest = optionalJson(manifestFile) || { version: 1, periodId: config.periodId, invocations: [] };
  if (manifest.periodId !== config.periodId) throw Error('Evidence directory belongs to another period.');
  manifest.invocations.push({ invocation, directory, passed: report.passed, createdAt: report.createdAt, report: path.join(directory, 'report.json') });
  fs.writeFileSync(manifestFile, json(manifest));
  fs.writeFileSync(path.join(base, 'latest.json'), json({ ...manifest.invocations.at(-1), index: path.join(directory, 'index.html') }));
  fs.writeFileSync(path.join(base, 'index.html'), `<!doctype html><html lang="ko"><meta charset="utf-8"><title>CS 자동 기획 검증 이력</title><style>body{font:18px/1.6 "Malgun Gothic",sans-serif;margin:40px}li{margin:12px 0}</style><h1>CS 3일 자동 기획·제작 검증 이력</h1><p>각 실행의 실패·보류·수정 및 재사용 증거를 보존합니다.</p><ul>${[...manifest.invocations].reverse().map(item => `<li><a href="${escape(path.relative(base, path.join(item.directory, 'index.html')).split(path.sep).join('/'))}">${escape(item.createdAt)} — ${item.passed ? '통과' : '미완료 / 확인 필요'}</a></li>`).join('')}</ul></html>`);
  console.log(json({ passed: report.passed, periodId: config.periodId, status: view?.status, counts: view?.counts,
    report: path.join(directory, 'index.html'), evidence: path.join(directory, 'report.json'), index: path.join(base, 'index.html'), callCounts: report.callCounts }));
  if (!report.passed) process.exitCode = 1;
  return report;
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main, snapshot, summarizeCalls, renderHtml };
