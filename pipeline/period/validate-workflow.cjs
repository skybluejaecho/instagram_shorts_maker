const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { registerSeries, addPlans, readCatalog } = require('../planning.cjs');
const { createPeriod, readPeriod } = require('./planning.cjs');
const { runPeriod } = require('./engine.cjs');
const { createStages } = require('../story/adapter.cjs');
const { createTools } = require('../tools.cjs');
const { runEpisode, inspectEpisode } = require('../runner.cjs');
const { inspectReview } = require('../review.cjs');

const json = value => JSON.stringify(value, null, 2) + '\n';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const relativeLink = (directory, file) => path.relative(directory, file).split(path.sep).map(encodeURIComponent).join('/');

function createInspector(root, tools) {
  const stagesFor = episodeId => {
    const entry = readCatalog(root).episodes[episodeId];
    assert.ok(entry, 'Materialized episode should exist: ' + episodeId);
    return createStages({ root, episodeFile: path.resolve(root, entry.episode), tools });
  };
  const inspect = async episodeId => {
    const workDir = path.join(root, 'runs', episodeId);
    const stages = stagesFor(episodeId);
    const { state, steps } = await inspectEpisode(workDir, stages);
    const current = steps.every(step => step.current);
    const review = await inspectReview(workDir, stages);
    const status = state.status === 'ready_for_review' && !current ? 'needs_rebuild' : state.status;
    const details = steps.map(step => {
      const record = state.stages[step.id];
      const label = step.current ? 'current' : !record ? 'pending' : record.status === 'done' ? 'needs_rebuild' : record.status;
      return { id: step.id, label, ...(label === 'failed' ? { error: record.error } : {}) };
    });
    return { workDir, stages, state, current, review, status, details };
  };
  return { stagesFor, inspect };
}

async function snapshot(inspect, episodeIds) {
  const records = {};
  for (const episodeId of episodeIds) {
    const info = await inspect(episodeId);
    const videoPath = info.review.videoPath;
    const video = videoPath ? { path: videoPath, sha256: sha(fs.readFileSync(videoPath)),
      mtimeMs: fs.statSync(videoPath).mtimeMs, bytes: fs.statSync(videoPath).size } : null;
    records[episodeId] = { state: info.state, status: info.status, current: info.current, review: info.review, video,
      visualReport: info.state.stages.visual?.status === 'done' ? path.join(info.workDir, info.state.stages.visual.dir, 'report.html') : null,
      metadata: info.review.reportPath ? read(info.review.reportPath) : null };
  }
  return records;
}

function renderSummary(directory, report) {
  const rows = report.episodeIds.map((id, index) => {
    const item = report.finalSnapshot[id];
    const slot = report.slots[index];
    const first = report.firstRun.rows.find(row => row.episodeId === id);
    const retry = report.retryRun.rows.find(row => row.episodeId === id);
    const link = (label, file) => file ? `<a href="${html(relativeLink(directory, file))}">${html(label)}</a>` : '—';
    return `<tr><td>${html(slot.date)} ${html(slot.localTime)}<small>${html(report.timezone)}</small></td><td>${html(report.titles[index])}<small>${html(id)}</small></td><td>${html(first.status)}<small>시도 ${html(first.attempts)}</small></td><td>${html(retry.status)}<small>시도 ${html(retry.attempts)}</small></td><td>${link('MP4', item.video.path)} · ${link('화면 검수', item.visualReport)} · ${link('기술 검수', item.review.reportPath)}</td></tr>`;
  }).join('\n');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>5일치 CS 제작 실행 검증</title><style>body{font:16px/1.6 "Malgun Gothic",sans-serif;color:#193344;background:#f4f7f9;max-width:1280px;margin:40px auto;padding:0 24px}h1{font-size:30px}section{background:white;padding:24px;border-radius:12px;margin:20px 0}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:12px;border-bottom:1px solid #d8e2e7;vertical-align:top}small{display:block;color:#63747e;font-size:12px;overflow-wrap:anywhere}a{color:#066b9f}.scroll{overflow:auto}.pass{font-weight:bold;color:#08734a}code{overflow-wrap:anywhere}li{margin:6px 0}</style><h1>5일치 CS 제작 실행 검증</h1><p class="pass">${report.passed ? '통과' : '실패'} · 5일 × 하루 1편 · 30초 / 1080×1920 / 30fps</p><section><p>기존 CS 검증용 대본 다섯 개를 별도 시리즈로 복사해 실제 Windows Heami 음성, HTML 화면 검수, HyperFrames MP4 제작 및 ffprobe 검수를 실행했습니다. 이번 검증은 실행 관리 기능을 확인하며 새 대본 생성·내용 재검증·실제 게시·자동 승인을 수행하지 않습니다.</p><ul><li>세 번째 회차의 render 단계에서 검증용 오류를 한 번 발생시켜도 나머지 네 편은 완료됩니다.</li><li>retry-failed는 실패한 한 회차만 실행합니다. 완료된 네 MP4의 경로·SHA256·수정 시간이 모두 동일합니다.</li><li>실패 회차도 기존 speech·prepare·visual 결과를 재사용하고 render부터 재개합니다.</li><li>완료 후 resume를 다시 실행해 회차 실행 호출 0회를 확인했습니다.</li></ul></section><section class="scroll"><table><thead><tr><th>게시 예정</th><th>회차</th><th>첫 실행</th><th>실패 회차 재개</th><th>검토</th></tr></thead><tbody>${rows}</tbody></table></section><section><p>모든 회차는 사람의 최종 확인을 기다리는 <code>ready_for_review</code> 상태입니다. 예정일과 제작 시간은 분리돼 있습니다.</p><p><a href="validation.json">검증 증거 JSON</a> · <a href="events.json">실행·단계별 이벤트</a>${report.periodReportPath ? ` · <a href="${html(relativeLink(directory, report.periodReportPath))}">기간 실행 보고서</a>` : ''}</p><p><code>node pipeline/cli.cjs period status ${html(report.periodId)}</code></p></section></html>`;
}

async function main() {
  if (process.argv.length > 2) throw new Error('This validation creates a fresh isolated run; it accepts no arguments.');
  const root = path.resolve(__dirname, '../..');
  const suffix = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 6);
  const periodId = 'cs-five-' + suffix;
  const seriesId = 'period-cs-' + suffix;
  const directory = path.join(root, 'runs', '_periods', 'validation-' + suffix);
  fs.mkdirSync(directory, { recursive: true });
  const write = (filename, data) => fs.writeFileSync(path.join(directory, filename), json(data));
  const events = [];
  let phase = 'setup';
  const log = message => {
    const event = { at: new Date().toISOString(), phase, message };
    events.push(event);
    fs.appendFileSync(path.join(directory, 'events.ndjson'), JSON.stringify(event) + '\n');
    console.log(message);
  };
  try {
    const provenance = read(path.join(root, 'samples/period/provenance.json'));
    for (const input of provenance.inputs) assert.equal(sha(fs.readFileSync(path.resolve(root, input.fixture))), input.sha256, 'Fixture must match copied source: ' + input.id);
    const series = { ...read(path.join(root, 'samples/period/series.json')), id: seriesId };
    const plans = read(path.join(root, 'samples/period/plans.json'));
    await registerSeries(root, series);
    await addPlans(root, seriesId, plans);
    const spec = { ...read(path.join(root, 'samples/period/five-days.json')), id: periodId, seriesId };
    const created = await createPeriod(root, spec);
    assert.equal(created.reused, false);
    const again = await createPeriod(root, spec);
    assert.equal(again.reused, true);
    assert.deepEqual(again.period, created.period, 'Recreating same plan must not add slots.');
    assert.equal(created.period.slots.length, 5);
    assert.equal(new Set(created.period.slots.map(slot => slot.scheduledFor)).size, 5);
    assert.deepEqual(created.period.slots.map(slot => slot.date), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
    assert.ok(created.period.slots.every(slot => slot.localTime === '19:00' && slot.scheduledFor === `${slot.date}T10:00:00.000Z`));
    assert.deepEqual(created.period.groups.map(group => group.slotIds.length), [2, 2, 1]);
    const tools = createTools(root);
    const { stagesFor, inspect } = createInspector(root, tools);
    const calls = [];
    const stageCalls = [];
    let failEpisodeId;
    let injected = false;
    const execute = async episodeId => {
      calls.push({ phase, episodeId });
      log(`[episode] ${episodeId}`);
      const stages = stagesFor(episodeId).map(stage => ({ ...stage, run: async context => {
        stageCalls.push({ phase, episodeId, stage: stage.id });
        if (phase === 'first' && episodeId === failEpisodeId && stage.id === 'render' && !injected) {
          injected = true;
          log('[controlled failure] third episode render fails once; other episodes must continue');
          throw new Error('VALIDATION_CONTROLLED_RENDER_FAILURE: one-time failure before invoking HyperFrames');
        }
        return stage.run(context);
      } }));
      return runEpisode(path.join(root, 'runs', episodeId), stages, { log: message => log(`[${episodeId}] ${message}`) });
    };
    const options = { jobs: 2, inspect, execute, log, generate: async () => { throw new Error('Explicit CS plan mode must not invoke generation.'); } };
    phase = 'plan-only';
    const planned = await runPeriod(root, periodId, { ...options, planOnly: true });
    write('planned.json', planned);
    assert.equal(calls.length, 0);
    const attached = readPeriod(root, periodId);
    const episodeIds = attached.slots.map(slot => slot.episodeId);
    assert.equal(episodeIds.length, 5);
    assert.ok(episodeIds.every(id => typeof id === 'string'));
    assert.equal(new Set(episodeIds).size, 5);
    failEpisodeId = episodeIds[2];
    const catalog = readCatalog(root);
    for (const slot of attached.slots) {
      assert.equal(catalog.episodes[slot.episodeId].scheduledFor, slot.scheduledFor);
      assert.equal(catalog.plans[seriesId][slot.planId].scheduledFor, slot.scheduledFor);
    }
    const repeatPlanned = await runPeriod(root, periodId, { ...options, planOnly: true });
    assert.deepEqual(readPeriod(root, periodId).slots, attached.slots, 'Planning replay must not create new episodes.');
    assert.equal(calls.length, 0);
    write('planned-replay.json', repeatPlanned);
    phase = 'first';
    const firstRun = await runPeriod(root, periodId, options);
    write('first-run.json', firstRun);
    const firstSnapshot = await snapshot(inspect, episodeIds);
    write('first-snapshot.json', firstSnapshot);
    assert.equal(injected, true, 'Controlled error must reach third episode render.');
    assert.deepEqual(new Set(calls.filter(call => call.phase === 'first').map(call => call.episodeId)), new Set(episodeIds));
    assert.equal(firstRun.rows.filter(row => row.status === 'failed').length, 1, 'Only injected episode should fail.');
    assert.equal(firstRun.rows.find(row => row.episodeId === failEpisodeId).status, 'failed');
    const completedIds = episodeIds.filter(id => id !== failEpisodeId);
    for (const id of completedIds) {
      assert.equal(firstSnapshot[id].review.status, 'ready_for_review', 'Other episode must complete: ' + id);
      assert.ok(firstSnapshot[id].video);
    }
    assert.equal(firstSnapshot[failEpisodeId].state.stages.render.status, 'failed');
    for (const stage of ['speech', 'prepare', 'visual']) assert.equal(firstSnapshot[failEpisodeId].state.stages[stage].status, 'done');
    phase = 'retry-failed';
    const retryRun = await runPeriod(root, periodId, { ...options, retryFailed: true });
    write('retry-run.json', retryRun);
    assert.deepEqual(calls.filter(call => call.phase === 'retry-failed').map(call => call.episodeId), [failEpisodeId], 'Retry should execute the failed episode only.');
    const finalSnapshot = await snapshot(inspect, episodeIds);
    write('final-snapshot.json', finalSnapshot);
    const reuse = completedIds.map(id => {
      assert.deepEqual(finalSnapshot[id].video, firstSnapshot[id].video, 'Completed MP4 path/hash/mtime must remain unchanged: ' + id);
      assert.deepEqual(finalSnapshot[id].state, firstSnapshot[id].state, 'Completed episode state must remain untouched: ' + id);
      assert.equal(retryRun.rows.find(row => row.episodeId === id).attempts, firstRun.rows.find(row => row.episodeId === id).attempts);
      return { episodeId: id, video: finalSnapshot[id].video, unchanged: true };
    });
    for (const stage of ['speech', 'prepare', 'visual']) assert.deepEqual(finalSnapshot[failEpisodeId].state.stages[stage], firstSnapshot[failEpisodeId].state.stages[stage], 'Failed episode must reuse completed ' + stage);
    assert.deepEqual(stageCalls.filter(call => call.phase === 'retry-failed').map(call => call.stage), ['render', 'verify']);
    assert.equal(retryRun.rows.find(row => row.episodeId === failEpisodeId).attempts, firstRun.rows.find(row => row.episodeId === failEpisodeId).attempts + 1);
    for (const id of episodeIds) {
      assert.equal(finalSnapshot[id].current, true);
      assert.equal(finalSnapshot[id].review.status, 'ready_for_review');
      assert.deepEqual(finalSnapshot[id].metadata, { width: 1080, height: 1920, fps: 30, frames: 900, durationSeconds: 30, videoCodec: 'h264', audioCodec: 'aac' });
    }
    phase = 'resume-complete';
    const resumed = await runPeriod(root, periodId, { ...options, resume: true });
    write('resume-complete.json', resumed);
    assert.equal(calls.filter(call => call.phase === 'resume-complete').length, 0, 'Resume after all episodes are current must not execute any episode.');
    assert.deepEqual(await snapshot(inspect, episodeIds), finalSnapshot);
    const report = { version: 1, passed: true, description: 'Real 5-day CS production using existing copied scripts; no generation, factual recheck, publishing, or approval.',
      createdAt: new Date().toISOString(), periodId, seriesId, timezone: spec.timezone, episodeIds, titles: plans.map(plan => plan.title), slots: attached.slots,
      controlledFailure: { episodeId: failEpisodeId, stage: 'render', injections: 1 },
      firstRun, retryRun, resumed, firstSnapshot, finalSnapshot, reuse,
      failedEpisodeReusedStages: ['speech', 'prepare', 'visual'], retryExecutedStages: ['render', 'verify'],
      completedResumeExecuteCalls: 0, calls, stageCalls, provenance,
      periodReportPath: resumed.reportPath || retryRun.reportPath || null };
    write('validation.json', report);
    write('events.json', events);
    fs.writeFileSync(path.join(directory, 'index.html'), renderSummary(directory, report));
    console.log(json({ passed: true, periodId, seriesId, report: path.join(directory, 'index.html'),
      evidence: path.join(directory, 'validation.json'), failedEpisodeId: failEpisodeId,
      firstRun: firstRun.counts, retryRun: retryRun.counts, reusedMp4Count: reuse.length, finalVideos: episodeIds.map(id => finalSnapshot[id].video.path) }));
  } catch (error) {
    write('failure.json', { phase, message: error.message, stack: error.stack, periodId, seriesId, events });
    throw error;
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { createInspector, snapshot, renderSummary, main };
