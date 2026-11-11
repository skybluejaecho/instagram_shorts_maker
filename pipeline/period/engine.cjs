const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { readCatalog, createBatchFromPlans } = require('../planning.cjs');
const { readStateFile, saveState, lockWorkDir, writerIsActive } = require('../run-state.cjs');
const { inspectBatch, runBatch } = require('../batch.cjs');
const { readPeriod, attachPeriodBatch } = require('./planning.cjs');

function directory(root, id) {
  // readPeriod validates the identifier before it can become a filesystem path.
  readPeriod(root, id);
  return path.join(root, 'runs', '_periods', id);
}

function requestKey(period) {
  const { id, seriesId, startDate, days, timezone, times, weekdays, batchSize, planIds } = period;
  return createHash('sha256').update(JSON.stringify({ id, seriesId, startDate, days, timezone, times, weekdays, batchSize, planIds })).digest('hex');
}

function journal(workDir, period) {
  const state = readStateFile(workDir);
  if (!state) return { version: 1, requestKey: requestKey(period), groups: {} };
  if (state.version !== 1 || state.requestKey !== requestKey(period) || !state.groups || Array.isArray(state.groups)) {
    throw new Error('Period journal does not match its immutable plan.');
  }
  for (const record of Object.values(state.groups)) {
    if (!['planning', 'ready', 'failed', 'needs_review', 'interrupted'].includes(record?.status) ||
        !Number.isSafeInteger(record.attempts) || record.attempts < 1) throw new Error('Invalid period planning journal.');
  }
  return state;
}

async function defaultInspect(root, id) {
  const entry = readCatalog(root).episodes[id];
  if (!entry) throw new Error('Unknown episode: ' + id);
  const adapter = path.resolve(root, entry.adapter);
  const stages = require(adapter).createStages({ root, episodeFile: path.resolve(root, entry.episode),
    sampleDir: path.dirname(adapter), tools: require('../tools.cjs').createTools(root) });
  const workDir = path.join(root, 'runs', id);
  const { state, steps } = await require('../runner.cjs').inspectEpisode(workDir, stages);
  const review = await require('../review.cjs').inspectReview(workDir, stages);
  return { state, current: steps.length > 0 && steps.every(step => step.current), status: state.status, review,
    details: steps.map(step => ({ id: step.id, label: step.current ? 'current' : state.stages[step.id]?.status === 'done'
      ? 'needs_rebuild' : state.stages[step.id]?.status || 'pending', error: state.stages[step.id]?.error })) };
}

function summaryStatus(rows) {
  if (rows.some(row => ['planning', 'running', 'queued'].includes(row.status))) return 'running';
  if (rows.some(row => row.status === 'failed')) return 'failed';
  if (rows.some(row => row.status === 'needs_review')) return 'needs_review';
  if (rows.some(row => row.status === 'interrupted')) return 'interrupted';
  if (rows.every(row => row.status === 'approved')) return 'approved';
  if (rows.every(row => ['ready_for_review', 'approved', 'changes_requested'].includes(row.status))) {
    return rows.some(row => row.status === 'changes_requested') ? 'changes_requested' : 'ready_for_review';
  }
  if (rows.every(row => row.status === 'input_ready')) return 'planned';
  if (rows.every(row => row.status === 'pending')) return 'pending';
  return 'partial';
}

async function inspectPeriod(root, id, { inspect = episodeId => defaultInspect(root, episodeId) } = {}) {
  const period = readPeriod(root, id);
  const workDir = directory(root, id);
  const state = journal(workDir, period);
  const catalog = readCatalog(root);
  const active = Object.values(state.groups).some(group => group.status === 'planning') &&
    fs.existsSync(workDir) ? await writerIsActive(workDir) : false;
  const ids = period.slots.filter(slot => slot.episodeId).map(slot => slot.episodeId);
  const batch = ids.length ? await inspectBatch(path.join(workDir, 'production'), ids) : { episodes: {} };
  const rows = [];
  for (const slot of period.slots) {
    const planning = state.groups[slot.batchId];
    const plan = catalog.plans[period.seriesId]?.[slot.planId];
    const row = { slotId: slot.id, date: slot.date, localTime: slot.localTime, scheduledFor: slot.scheduledFor,
      batchId: slot.batchId, planId: slot.planId, episodeId: slot.episodeId, title: plan?.title || '',
      status: planning?.status || 'pending', phase: 'planning', attempts: 0, planningAttempts: planning?.attempts || 0 };
    if (row.status === 'planning' && active === false) row.status = 'interrupted';
    if (!slot.episodeId) {
      if (planning?.error) row.error = planning.error;
      if (planning?.generationReport) row.generationReport = planning.generationReport;
      rows.push(row);
      continue;
    }
    const record = batch.episodes[slot.episodeId];
    row.attempts = record.attempts;
    row.phase = 'production';
    try {
      const info = await inspect(slot.episodeId);
      row.current = info.current === true;
      row.review = info.review;
      row.details = info.details || [];
      if (info.state?.contentRepair) row.contentRepair = info.state.contentRepair;
      const episodeDir = path.join(root, 'runs', slot.episodeId);
      const externalRunning = info.status === 'running' && fs.existsSync(episodeDir) &&
        await writerIsActive(episodeDir) !== false;
      if (record.queued || record.status === 'running') {
        row.status = record.queued ? 'queued' : 'running';
      } else if (externalRunning) {
        row.status = 'running';
      } else if (info.current) {
        row.status = info.review?.status || 'ready_for_review';
        row.phase = 'review';
      } else if (info.status === 'needs_review' || record.status === 'needs_review') {
        row.status = 'needs_review';
        row.error = info.state?.contentRepair?.reason || row.details.find(step => step.label === 'failed')?.error || record.error || 'Content needs human review.';
      } else if (info.status === 'failed' || record.status === 'failed') {
        row.status = 'failed';
        row.error = row.details.find(step => step.label === 'failed')?.error || record.error || 'Episode production failed.';
      } else if (record.status === 'interrupted' || info.status === 'running') {
        row.status = 'interrupted';
      } else row.status = info.status === 'new' ? 'input_ready' : 'needs_rebuild';
      const next = row.details.find(step => step.label !== 'current');
      if (next && row.phase !== 'review') row.phase = next.id;
      for (const stageId of ['content', 'visual', 'verify']) {
        const stage = info.state?.stages?.[stageId];
        if (stage?.dir && stage.outputs?.['report.json']) row[stageId + 'Report'] = path.resolve(root, 'runs', slot.episodeId, stage.dir, 'report.json');
      }
    } catch (error) {
      row.status = 'failed'; row.error = error.message;
    }
    rows.push(row);
  }
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  return { version: 1, period, checkedAt: new Date().toISOString(), rows, counts, status: summaryStatus(rows),
    reportPath: fs.existsSync(path.join(workDir, 'report.html')) ? path.join(workDir, 'report.html') : undefined };
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function reportHtml(result) {
  const link = (file, label) => file ? `<a href="${escape(pathToFileURL(file).href)}">${escape(label)}</a>` : '';
  const generationLinks = result.rows.filter(row => row.generationReport)
    .filter((row, index, rows) => rows.findIndex(other => other.batchId === row.batchId) === index)
    .map(row => link(row.generationReport, row.batchId + ' 기획 기록')).join(' ');
  const repairLinks = result.rows.filter(row => row.contentRepair?.reportPath)
    .map(row => link(row.contentRepair.reportPath, `${row.episodeId} 문구 수정 ${row.contentRepair.attempts}/2 (${row.contentRepair.status})`)).join(' ');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(result.period.id)} 제작 현황</title><style>body{font-family:Malgun Gothic,Arial,sans-serif;background:#f3f5f7;color:#172b37;margin:24px;line-height:1.6}main{max-width:1400px;margin:auto}.scroll{overflow:auto}table{border-collapse:collapse;background:white;width:100%}th,td{border:1px solid #d7dee4;padding:12px;text-align:left;vertical-align:top}small{display:block;color:#526271}a{display:inline-block;margin:4px 12px 4px 0}code{overflow-wrap:anywhere}h1{font-size:28px}.failed,.needs_review{background:#fff1ee}</style>
<main><h1>${escape(result.period.id)} — ${escape(result.status)}</h1><p>${escape(result.period.startDate)}부터 ${result.period.days}일 · ${escape(result.period.timezone)} · ${result.rows.length}편</p>
<p>게시 예정과 제작 실행은 별개입니다. 아래는 ${escape(result.checkedAt)} 기준 결과이며, 실제 게시와 최종 승인은 별도로 진행합니다.</p><p>${escape(JSON.stringify(result.counts))}</p><div class="scroll"><table><thead><tr><th>게시 예정</th><th>회차</th><th>진행 상태</th><th>결과 / 검토</th></tr></thead><tbody>
${result.rows.map(row => `<tr class="${escape(row.status)}"><td>${escape(row.date)} ${escape(row.localTime)}<small>${escape(row.scheduledFor)}</small></td><td>${escape(row.title || row.slotId)}<small><code>${escape(row.episodeId || row.batchId)}</code></small></td><td>${escape(row.status)}<small>단계 ${escape(row.phase)} · 제작 시도 ${row.attempts} · 기획 시도 ${row.planningAttempts}</small>${row.error ? `<p>${escape(row.error)}</p>` : ''}</td><td>${link(row.review?.videoPath, 'MP4')}${link(row.review?.reportPath, '기술 검수')}${link(row.visualReport && path.join(path.dirname(row.visualReport), 'report.html'), '화면 검수')}${link(row.contentReport, '내용 검증')}<small>${escape(row.review?.status || '')}</small>${row.review?.revision ? `<small>Revision <code>${escape(row.review.revision)}</code></small>` : ''}</td></tr>`).join('\n')}
</tbody></table></div><p>${generationLinks}</p><p>${repairLinks}</p></main></html>`;
}

function writeReport(workDir, result) {
  result.reportPath = path.join(workDir, 'report.html');
  for (const [name, bytes] of [['report.json', JSON.stringify(result, null, 2) + '\n'], ['report.html', reportHtml(result)]]) {
    const temporary = path.join(workDir, `${name}-${randomUUID()}.tmp`);
    try { fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, path.join(workDir, name)); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}

async function runPeriod(root, id, { retryFailed = false, resume = false, planOnly = false, jobs = 1,
  generate, execute, inspect = episodeId => defaultInspect(root, episodeId), log = console.log } = {}) {
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8) throw new Error('jobs must be an integer from 1 to 8.');
  if ([retryFailed, resume, planOnly].some(value => typeof value !== 'boolean') || (retryFailed && resume)) throw new Error('Choose run, resume or retry-failed.');
  let period = readPeriod(root, id);
  const workDir = directory(root, id);
  fs.mkdirSync(workDir, { recursive: true });
  const release = await lockWorkDir(workDir, 'Period');
  try {
    const state = journal(workDir, period);
    for (const group of Object.values(state.groups)) if (group.status === 'planning') group.status = 'interrupted';
    const newlyLinked = new Set();
    // Sequential planning means each generated group sees all earlier committed
    // topics. A held group never prevents other groups from being attempted.
    for (const group of period.groups) {
      const slots = group.slotIds.map(slotId => period.slots.find(slot => slot.id === slotId));
      if (slots.every(slot => slot.episodeId)) continue;
      const previous = state.groups[group.id];
      const catalog = readCatalog(root);
      if (retryFailed && !catalog.batches[group.id] && !['failed', 'needs_review'].includes(previous?.status)) continue;
      const record = { status: 'planning', attempts: (previous?.attempts || 0) + 1 };
      state.groups[group.id] = record;
      saveState(workDir, state);
      log(`[period] ${group.id}: planning (attempt ${record.attempts})`);
      try {
        // A committed batch can exist after a crash before schedule attachment.
        // Recover that exact batch, without another model/TTS call.
        if (!catalog.batches[group.id]) {
          if (group.planIds) await createBatchFromPlans(root, period.seriesId, group.id, { planIds: group.planIds });
          else {
            if (typeof generate !== 'function') throw new Error('Automatic period planning requires a generation callback.');
            await generate({ seriesId: period.seriesId, batchId: group.id, count: group.slotIds.length });
          }
        }
        period = await attachPeriodBatch(root, id, group.id);
        for (const slot of period.slots.filter(slot => slot.batchId === group.id)) newlyLinked.add(slot.episodeId);
        record.status = 'ready';
      } catch (error) {
        let generation;
        try { generation = readStateFile(path.join(root, 'runs', '_generation', group.id)); } catch { /* Keep the original failure. */ }
        record.status = generation?.status === 'needs_review' ? 'needs_review' : 'failed';
        record.error = error.message;
        record.generationReport = generation ? path.join(root, 'runs', '_generation', group.id, 'state.json') : undefined;
      }
      saveState(workDir, state);
      log(`[period] ${group.id}: ${record.status}${record.error ? ' — ' + record.error : ''}`);
    }
    let view = await inspectPeriod(root, id, { inspect });
    if (!planOnly) {
      const selected = view.rows.filter(row => row.episodeId && !['running', 'queued'].includes(row.status) && (retryFailed
        ? !row.current && (['failed', 'needs_review'].includes(row.status) || newlyLinked.has(row.episodeId))
        : resume ? !row.current : true)).map(row => row.episodeId);
      if (selected.length) {
        if (typeof execute !== 'function') throw new Error('Period production requires an execute callback.');
        await runBatch(path.join(workDir, 'production'), selected, execute, { jobs, log });
      } else log('[period] no episodes need execution');
      view = await inspectPeriod(root, id, { inspect });
    }
    writeReport(workDir, view);
    return view;
  } finally { await release(); }
}

module.exports = { runPeriod, inspectPeriod, reportHtml };
