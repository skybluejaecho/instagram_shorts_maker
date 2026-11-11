const path = require('node:path');
const fs = require('node:fs');
const legacyEpisodes = require('./episodes.json');
const legacyBatches = require('./batches.json');
const { createTools } = require('./tools.cjs');
const { inspectEpisode } = require('./runner.cjs');
const { runProduction } = require('./production.cjs');
const { inspectBatch, runBatch } = require('./batch.cjs');
const { inspectReview, recordReview } = require('./review.cjs');
const { readCatalog, registerSeries, configureContentReview, configureVisualReview, addPlans, updatePlans, checkDuplicates, createBatchFromPlans } = require('./planning.cjs');

const root = path.join(__dirname, '..');
let episodes;
let batches;
let usage;
let productionContentChecker;
let productionRepairProvider;

function mergeRegistry(legacy, generated) {
  for (const id of Object.keys(generated)) {
    if (Object.hasOwn(legacy, id)) throw new Error('Duplicate registry ID: ' + id);
  }
  return { ...legacy, ...generated };
}

function loadRegistries() {
  const catalog = readCatalog(root);
  episodes = mergeRegistry(legacyEpisodes, catalog.episodes);
  batches = mergeRegistry(legacyBatches, catalog.batches);
  usage = [
  'node pipeline/cli.cjs <status|run> <episode-id>',
  'node pipeline/cli.cjs batch status <batch-id>',
  'node pipeline/cli.cjs batch <run|retry-failed> <batch-id> [--jobs 1..8]',
  'node pipeline/cli.cjs review list <batch-id>',
  'node pipeline/cli.cjs review approve <episode-id> --revision <revision>',
  'node pipeline/cli.cjs review request-changes <episode-id> --revision <revision> --target "scene" --note "request"',
  'node pipeline/cli.cjs review scenes <episode-id>',
  'node pipeline/cli.cjs review apply <episode-id> --request <request-id> [--scope visual|narration|both] [--attempts 1..5] [--model name]',
  'node pipeline/cli.cjs review revision <request-id>',
  'node pipeline/cli.cjs series <register <series.json>|list>',
  'node pipeline/cli.cjs series check <series.json> [--json]',
  'node pipeline/cli.cjs series sources <series-id> <content-review.json>',
  'node pipeline/cli.cjs series visual <series-id> <visual-review.json>',
  'node pipeline/cli.cjs visual audit <episode-id>',
  'node pipeline/cli.cjs content sources <series-id>',
  'node pipeline/cli.cjs content audit <series-id> --plans id1,id2 [--model name]',
  'node pipeline/cli.cjs plan <add|update> <series-id> <plans.json>',
  'node pipeline/cli.cjs plan <list|check> <series-id>',
  'node pipeline/cli.cjs plan audit <series-id> --plans id1,id2 [--model name]',
  'node pipeline/cli.cjs plan batch <series-id> <batch-id> <--plans id1,id2|--count N>',
  'node pipeline/cli.cjs generate <series-id> <batch-id> --count 1..10 [--plan-only] [--jobs 1..8] [--attempts 1..5] [--model name]',
  'node pipeline/cli.cjs generate status <batch-id>',
  'node pipeline/cli.cjs period create <period.json>',
  'node pipeline/cli.cjs period list',
  'node pipeline/cli.cjs period status <period-id>',
  'node pipeline/cli.cjs period <run|resume|retry-failed> <period-id> [--plan-only] [--jobs 1..8] [--attempts 1..5] [--model name]',
  'node pipeline/cli.cjs handoff <export|check> <handoff-id> [--json]',
  'Episodes: ' + Object.keys(episodes).join(', '),
  'Batches: ' + Object.keys(batches).join(', '),
  ].join('\n');
}

function readInput(filename) {
  return JSON.parse(fs.readFileSync(path.resolve(root, filename), 'utf8').replace(/^\uFEFF/, ''));
}

async function seriesCommand(args) {
  const [action, filename] = args;
  if (action === 'check') {
    if (![2, 3].includes(args.length) || (args.length === 3 && args[2] !== '--json')) throw new Error(usage);
    const { formatPreflight, inputError } = require('./series/report.cjs');
    let spec;
    let report;
    try { spec = readInput(filename); } catch (error) { report = inputError(error); }
    if (!report) report = await require('./series/preflight.cjs').checkSeries(root, spec);
    console.log(args[2] === '--json' ? JSON.stringify(report, null, 2) : formatPreflight(report));
    if (!report.canRegister) process.exitCode = 1;
    return;
  }
  if (action === 'visual' && args.length === 3) {
    await configureVisualReview(root, filename, readInput(args[2]));
    console.log('Updated visual review policy:', filename);
    return;
  }
  if (action === 'sources' && args.length === 3) {
    await configureContentReview(root, filename, readInput(args[2]));
    console.log('Updated content review policy:', filename);
    return;
  }
  if (action === 'register' && args.length === 2) {
    const { formatPreflight, inputError } = require('./series/report.cjs');
    let spec;
    try { spec = readInput(filename); }
    catch (error) { console.log(formatPreflight(inputError(error))); process.exitCode = 1; return; }
    try { await registerSeries(root, spec, { onPreflight: report => console.log(formatPreflight(report)) }); }
    catch (error) {
      if (error.code !== 'SERIES_PREFLIGHT_FAILED') throw error;
      process.exitCode = 1; return;
    }
    console.log('Registered series:', spec.id);
    return;
  }
  if (action !== 'list' || args.length !== 1) throw new Error(usage);
  const catalog = readCatalog(root);
  console.log('시리즈 | 이름 | 기본 길이 | 제작 템플릿');
  for (const [id, series] of Object.entries(catalog.series)) {
    console.log(`${id} | ${series.name} | ${series.defaultDurationSeconds}s | ${series.adapter}`);
  }
}

async function planCommand(args) {
  const [action, seriesId] = args;
  if (action === 'audit') return auditPlansCommand(args.slice(1));
  if (['add', 'update'].includes(action) && args.length === 3) {
    const plans = readInput(args[2]);
    if (action === 'add') await addPlans(root, seriesId, plans);
    else await updatePlans(root, seriesId, plans);
    console.log(`${action === 'add' ? 'Registered' : 'Updated'} ${plans.length} plans in ${seriesId}`);
    return;
  }
  if (action === 'batch' && args.length === 5) {
    const [, , batchId, flag, value] = args;
    let selection;
    if (flag === '--plans') selection = { planIds: value.split(',').map(id => id.trim()) };
    else if (flag === '--count' && /^[1-9]\d*$/.test(value)) selection = { count: Number(value) };
    else throw new Error(usage);
    const result = await createBatchFromPlans(root, seriesId, batchId, selection);
    console.log(`${result.reused ? 'Existing' : 'Created'} batch ${result.batchId}: ${result.episodeIds.join(', ')}`);
    console.log(`node pipeline/cli.cjs batch run ${result.batchId}`);
    return;
  }
  if (args.length !== 2 || !['list', 'check'].includes(action)) throw new Error(usage);
  const catalog = readCatalog(root);
  if (!Object.hasOwn(catalog.series, seriesId)) throw new Error('Unknown series: ' + seriesId);
  if (action === 'check') {
    const duplicates = await checkDuplicates(root, seriesId);
    for (const group of duplicates) console.log(`Duplicate ${group.topicKey}: ${group.planIds.join(', ')}`);
    if (duplicates.length) process.exitCode = 1;
    else console.log(`No duplicate topic keys in ${seriesId}`);
    return;
  }
  console.log('기획 | 주제 식별자 | 게시 예정 | 상태 | 회차 | 제목');
  for (const [id, plan] of Object.entries(catalog.plans[seriesId] || {})) {
    const generated = Object.entries(catalog.episodes).find(([, entry]) => entry.seriesId === seriesId && entry.planId === id);
    let status = plan.publishedAt ? 'published' : plan.input ? 'input_ready' : 'draft';
    if (generated && !plan.publishedAt) {
      try {
        const info = await inspectMember(generated[0]);
        status = info.current ? info.review.status : info.status === 'new' ? 'materialized' : info.status;
      } catch (error) { status = '확인 필요 — ' + error.message; }
    }
    console.log(`${id} | ${plan.topicKey} | ${plan.scheduledFor || '-'} | ${status} | ${generated?.[0] || '-'} | ${plan.title}`);
  }
}

function printNovelty(report) {
  if (!report) return;
  console.log(`의미 중복: ${report.status}`);
  for (const comparison of report.comparisons || []) {
    if (comparison.verdict !== 'distinct') console.log(`  ${comparison.candidateId} → ${comparison.reference.kind}/${comparison.reference.id}: ${comparison.verdict} — ${comparison.reason}`);
  }
  for (const profile of report.profiles || []) console.log(`  ${profile.planId}: ${profile.knowledge.core}`);
  if (report.reportPath) console.log('중복 검토 보고서:', report.reportPath);
}

function printContent(report) {
  if (!report) return;
  console.log(`내용 검증: ${report.status}`);
  for (const unit of report.units || []) {
    if (['contradicted', 'uncertain'].includes(unit.verdict)) console.log(`  ${unit.planId}/${unit.location || unit.unitId}: ${unit.verdict} — ${unit.reason}`);
  }
  for (const issue of report.issues || []) console.log(`  ${issue.sourceId || 'sources'}: ${issue.reason}`);
  for (const item of report.consistency || []) {
    if (item.verdict !== 'consistent') console.log(`  ${item.planId}/화면·낭독 일관성: ${item.verdict} — ${item.reason}`);
  }
  for (const source of report.sources || []) console.log(`  근거 ${source.id}: ${source.title} (${source.url || source.path})`);
  if (report.reportPath) console.log('Content report:', report.reportPath);
}

async function contentCommand(args) {
  const [action, seriesId, ...flags] = args;
  const catalog = readCatalog(root);
  if (!['sources', 'audit'].includes(action) || !Object.hasOwn(catalog.series, seriesId)) throw new Error(usage);
  const { readEvidenceBundle } = require('./content/sources.cjs');
  const series = catalog.series[seriesId];
  const bundle = readEvidenceBundle(root, series);
  if (action === 'sources') {
    if (flags.length) throw new Error(usage);
    console.log(`${seriesId}: ${bundle.mode} / ${bundle.status}`);
    for (const source of bundle.sources) console.log(`${source.id} | ${source.path} | SHA256 ${source.sha256}`);
    for (const issue of bundle.issues) console.log(`${issue.sourceId || 'sources'}: ${issue.reason}`);
    if (bundle.status === 'needs_review') process.exitCode = 1;
    return;
  }
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!['--plans', '--model'].includes(flags[i]) || Object.hasOwn(options, flags[i]) || !flags[i + 1]?.trim() || flags[i + 1].startsWith('--')) throw new Error(usage);
    options[flags[i]] = flags[i + 1];
  }
  const ids = (options['--plans'] || '').split(',').map(id => id.trim());
  if (!ids[0] || ids.length > 10 || new Set(ids).size !== ids.length) throw new Error('Choose 1–10 unique plans.');
  // Validates authoritative input paths (including real paths) before reading any selected story.
  require('./novelty/history.cjs').readSeriesHistory(root, catalog, seriesId);
  const entries = ids.map(id => {
    const plan = catalog.plans[seriesId]?.[id];
    if (!plan) throw new Error('Unknown plan: ' + id);
    const materialized = Object.values(catalog.episodes).find(entry => entry.seriesId === seriesId && entry.planId === id);
    const input = materialized?.episode || plan.input;
    if (!input) throw new Error('A complete story input is required for content audit: ' + id);
    const story = require('./story/spec.cjs').validateSpec({ title: plan.title, durationSeconds: series.defaultDurationSeconds, profile: series.renderProfile, ...readInput(input) });
    return { plan, story };
  });
  const check = require('./content/checker.cjs').createContentChecker({
    provider: require('./generation/provider.cjs').createCodexProvider({ model: options['--model'] }), log: console.log,
  });
  const report = await check({ series, entries, bundle, directory: path.join(root, 'runs', '_content', require('node:crypto').randomUUID()) });
  printContent(report);
  if (report.status !== 'passed') process.exitCode = 1;
}

async function auditPlansCommand(args) {
  const [seriesId, ...flags] = args;
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i];
    const value = flags[i + 1];
    if (!['--plans', '--model'].includes(flag) || Object.hasOwn(options, flag) || !value?.trim() || value.startsWith('--')) throw new Error(usage);
    options[flag] = value;
  }
  if (!options['--plans']) throw new Error(usage);
  const ids = options['--plans'].split(',').map(id => id.trim());
  if (!ids.length || ids.length > 10 || new Set(ids).size !== ids.length) throw new Error('Choose 1–10 unique plans.');
  const catalog = readCatalog(root);
  if (!Object.hasOwn(catalog.series, seriesId)) throw new Error('Unknown series: ' + seriesId);
  const { readSeriesHistory } = require('./novelty/history.cjs');
  const { createNoveltyChecker } = require('./novelty/checker.cjs');
  const { createCodexProvider } = require('./generation/provider.cjs');
  const { history } = readSeriesHistory(root, catalog, seriesId);
  const entries = ids.map(id => {
    const plan = history.find(plan => plan.id === id);
    if (!plan) throw new Error('Unknown plan in this series: ' + id);
    return { plan, ...(plan.narration ? { story: { narration: plan.narration } } : {}) };
  });
  const directory = path.join(root, 'runs', '_novelty', require('node:crypto').randomUUID());
  const check = createNoveltyChecker({ provider: createCodexProvider({ model: options['--model'] }), log: console.log });
  const report = await check({ series: catalog.series[seriesId], entries, history: history.filter(plan => !ids.includes(plan.id)), directory });
  printNovelty(report);
  if (report.status !== 'passed') process.exitCode = 1;
}

function loadEpisode(id, { contentChecker = productionContentChecker } = {}) {
  if (!Object.hasOwn(episodes, id)) throw new Error('Unknown episode: ' + id);
  const entry = episodes[id];
  const adapter = path.resolve(root, entry.adapter);
  const stages = require(adapter).createStages({ root, tools: createTools(root),
    sampleDir: path.dirname(adapter), episodeFile: path.resolve(root, entry.episode), contentChecker });
  return { workDir: path.join(root, 'runs', id), stages };
}

async function inspectMember(id) {
  const { workDir, stages } = loadEpisode(id);
  const { state, steps } = await inspectEpisode(workDir, stages);
  const review = await inspectReview(workDir, stages);
  const current = steps.every(step => step.current);
  const status = state.status === 'ready_for_review' && !current ? 'needs_rebuild' : state.status;
  const details = steps.map(step => {
    const record = state.stages[step.id];
    const label = step.current ? 'current' : !record ? 'pending' : record.status === 'done' ? 'needs_rebuild' : record.status;
    return { id: step.id, label, error: label === 'failed' ? record.error : undefined };
  });
  return { workDir, state, status, details, current, review };
}

async function runMember(id, options) {
  return runProduction({ root, episodeId: id, workDir: path.join(root, 'runs', id),
    createStages: overrides => { loadRegistries(); return loadEpisode(id, overrides).stages; },
    contentChecker: productionContentChecker, repairProvider: productionRepairProvider, ...options });
}

async function printBatch(id, ids, batch) {
  console.log(`Batch ${id} (${ids.length})`);
  console.log('회차 | 묶음 실행 | 시도 | 회차 단계 | 검토');
  for (const member of ids) {
    const record = batch.episodes[member];
    let detail;
    let contentRepair;
    let reviewStatus = '확인 필요';
    try {
      const episode = await inspectMember(member);
      contentRepair = episode.state.contentRepair;
      reviewStatus = episode.review.status;
      const step = episode.details.find(s => s.label !== 'current');
      detail = step ? `${step.id} (${step.label})` : episode.status;
      if (step?.label === 'running' && record.status === 'interrupted') detail = `${step.id} (중단 시점)`;
      if (step?.error && !record.error) detail += ` — ${step.error}`;
    } catch (error) {
      detail = '입력 확인 필요';
      if (!record.error) detail += ` — ${error.message}`;
    }
    const status = record.queued ? (record.attempts ? `queued (이전 ${record.status})` : 'queued') : record.status;
    console.log(`${member} | ${status} | ${record.attempts} | ${detail} | ${reviewStatus}${record.error ? ' — ' + record.error : ''}`);
    printContentRepair(contentRepair);
  }
}

async function batchCommand(args) {
  const [action, id, flag, value] = args;
  if (!['status', 'run', 'retry-failed'].includes(action) || !Object.hasOwn(batches, id)) throw new Error(usage);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('Invalid batch ID: ' + id);
  let jobs = 1;
  if (args.length !== 2) {
    if (action === 'status' || args.length !== 4 || flag !== '--jobs' || !/^[1-8]$/.test(value)) throw new Error(usage);
    jobs = Number(value);
  }
  const ids = batches[id];
  const workDir = path.join(root, 'runs', '_batches', id);
  if (action === 'status') return printBatch(id, ids, await inspectBatch(workDir, ids));
  const batch = await runBatch(workDir, ids, member => runMember(member, {
    log: message => console.log(`[${member}] ${message}`),
  }), { jobs, retryFailed: action === 'retry-failed' });
  await printBatch(id, ids, batch);
  if (ids.some(member => ['failed', 'needs_review'].includes(batch.episodes[member].status))) process.exitCode = 1;
}

function printReview(id, review, showStatus = true) {
  if (showStatus) console.log(`${id}: ${review.status}`);
  if (review.videoPath) console.log('MP4:', review.videoPath);
  if (review.reportPath) console.log('QA: ', review.reportPath);
  if (review.revision) console.log('Revision:', review.revision);
  printContentRepair(require('./run-state.cjs').readStateFile(path.join(root, 'runs', id))?.contentRepair);
  const contentStage = require('./run-state.cjs').readStateFile(path.join(root, 'runs', id))?.stages?.content;
  if (contentStage?.dir) console.log(`내용 검증 기록 (${contentStage.status}; 현재 검토 상태와 함께 확인):`, path.join(root, 'runs', id, contentStage.dir, 'report.json'));
  const visualStage = require('./run-state.cjs').readStateFile(path.join(root, 'runs', id))?.stages?.visual;
  if (visualStage?.dir) {
    const directory = path.join(root, 'runs', id, visualStage.dir);
    console.log(`화면 검수 기록 (${visualStage.status}; 현재 검토 상태와 함께 확인):`, path.join(directory, 'report.html'));
    if (fs.existsSync(path.join(directory, 'report.json'))) printVisual(readInput(path.join(directory, 'report.json')), directory, false);
  }
  if (review.latestRequest && review.status !== 'approved') {
    const label = review.latestRequest.revision === review.revision ? '수정 요청' : '이전 버전 수정 요청';
    console.log(`${label}: [${review.latestRequest.target}] ${review.latestRequest.note}`);
    console.log('Request:', review.latestRequest.id);
  }
}

function printContentRepair(repair) {
  if (!repair) return;
  console.log(`제작 문구 자동 수정: ${repair.status} (${repair.attempts}/2) — ${repair.reason || ''}`);
  if (repair.reportPath) console.log('자동 수정 기록:', repair.reportPath);
}

function printVisual(report, directory, paths = true) {
  console.log(`화면 검수: ${report.status} — 오류 ${(report.issues || []).filter(issue => issue.severity === 'error').length}, 경고 ${(report.issues || []).filter(issue => issue.severity === 'warning').length}`);
  for (const issue of report.issues || []) console.log(`  ${issue.severity}/${issue.code} | ${issue.sceneId || '-'} @ ${Number(issue.timeSeconds || 0).toFixed(2)}s | ${issue.reason}`);
  if (paths) {
    console.log('Visual report:', path.join(directory, 'report.html'));
    console.log('Visual JSON:', path.join(directory, 'report.json'));
  }
}

async function visualCommand(args) {
  const [action, id] = args;
  if (action !== 'audit' || args.length !== 2 || !Object.hasOwn(episodes, id)) throw new Error(usage);
  const entry = episodes[id];
  if (entry.adapter !== 'pipeline/story/adapter.cjs') throw new Error('Visual audit requires the common story adapter.');
  const { workDir, stages } = loadEpisode(id);
  const prepareIndex = stages.findIndex(stage => stage.id === 'prepare');
  const inspected = await inspectEpisode(workDir, stages.slice(0, prepareIndex + 1));
  if (prepareIndex < 0 || !inspected.steps.at(-1)?.current) throw new Error('Current prepared HTML is required. Run this episode first; a failed visual gate will preserve its prepared HTML.');
  const prepared = path.resolve(workDir, inspected.state.stages.prepare.dir);
  const real = path.relative(fs.realpathSync(workDir), fs.realpathSync(prepared));
  if (!real || real === '..' || real.startsWith('..' + path.sep) || path.isAbsolute(real)) throw new Error('Prepared artifact is outside the episode directory.');
  const { runVisualReview, resolveVisualPolicy } = require('./visual/runtime.cjs');
  const directory = path.join(root, 'runs', '_visual', 'audit-' + require('node:crypto').randomUUID());
  const report = await runVisualReview({ htmlFile: path.join(prepared, 'index.html'), timeline: readInput(path.join(prepared, 'timeline.json')),
    directory, policy: resolveVisualPolicy({ root, episodeFile: path.join(root, entry.episode) }) });
  printVisual(report, directory);
  if (report.status !== 'passed' && report.status !== 'warnings') process.exitCode = 1;
}

function printRevision(result) {
  console.log(`${result.episodeId}: ${result.status}${result.reused ? ' (기존 수정 결과)' : ''}`);
  console.log('Request:', result.requestId);
  if (result.summary) console.log('수정 요약:', result.summary);
  for (const change of result.changes || []) {
    console.log(`  ${change.section}/${change.id}/${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
  }
  if (result.oldVideoPath) console.log('이전 MP4:', result.oldVideoPath);
  if (result.newVideoPath) console.log('수정 MP4:', result.newVideoPath);
  if (result.newRevision) console.log('Revision:', result.newRevision);
  if (result.error) console.log('Error:', result.error);
}

async function revisionCommand(action, id, flags) {
  if (action === 'revision') {
    if (flags.length) throw new Error(usage);
    const state = await require('./revision/engine.cjs').inspectRevision(root, id);
    if (!state) return console.log(`${id}: not_started`);
    printRevision(state.result || state);
    if (state.contentReportFile) console.log('Content report:', path.join(root, 'runs', '_revisions', id, state.contentReportFile));
    for (const attempt of state.attempts || []) console.log(`  시도 ${attempt.id}: ${attempt.status}${attempt.error ? ' — ' + attempt.error : ''}`);
    if (state.error && state.result) console.log('Error:', state.error);
    return;
  }
  if (!Object.hasOwn(episodes, id)) throw new Error('Unknown episode: ' + id);
  const entry = episodes[id];
  if (entry.adapter !== 'pipeline/story/adapter.cjs') throw new Error('Automatic revisions and scene listing require pipeline/story/adapter.cjs.');
  const episodeFile = path.resolve(root, entry.episode);
  if (action === 'scenes') {
    if (flags.length) throw new Error(usage);
    const { validateSpec } = require('./story/spec.cjs');
    const spec = validateSpec(readInput(entry.episode));
    console.log('장면 ID | 화면 문구 | 낭독 큐');
    for (const [index, scene] of spec.scenes.entries()) {
      const start = spec.narration.findIndex(cue => cue.id === scene.from);
      const end = spec.scenes[index + 1] ? spec.narration.findIndex(cue => cue.id === spec.scenes[index + 1].from) : spec.narration.length;
      console.log(`${scene.id} | ${scene.headline.replace(/\n/g, ' / ')} | ${spec.narration.slice(start, end).map(cue => cue.id).join(', ')}`);
    }
    return;
  }
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i];
    const value = flags[i + 1];
    if (!['--request', '--scope', '--attempts', '--model'].includes(flag) || Object.hasOwn(options, flag) || !value?.trim() || value.startsWith('--')) throw new Error(usage);
    options[flag] = value;
  }
  if (!options['--request'] || !['visual', 'narration', 'both'].includes(options['--scope'] || 'both') ||
      (options['--attempts'] !== undefined && !/^[1-5]$/.test(options['--attempts']))) throw new Error(usage);
  const { reviseEpisode } = require('./revision/engine.cjs');
  const { createRevisionPreflight } = require('./revision/preflight.cjs');
  const { createCodexProvider } = require('./generation/provider.cjs');
  const log = message => console.log(`[revision] ${message}`);
  const provider = createCodexProvider({ model: options['--model'] });
  productionContentChecker = require('./content/checker.cjs').createContentChecker({ provider, log });
  const result = await reviseEpisode(root, { episodeId: id, episodeFile, workDir: path.join(root, 'runs', id),
    createStages: () => loadEpisode(id).stages,
    requestId: options['--request'], scope: options['--scope'] || 'both', maxAttempts: Number(options['--attempts'] || 3),
    provider, contentChecker: productionContentChecker, preflight: createRevisionPreflight(root, { log }), log,
  });
  printRevision(result);
}

async function reviewCommand(args) {
  const [action, id, ...flags] = args;
  if (['apply', 'revision', 'scenes'].includes(action)) return revisionCommand(action, id, flags);
  if (action === 'list') {
    if (args.length !== 2 || !Object.hasOwn(batches, id)) throw new Error(usage);
    for (const member of batches[id]) {
      try {
        const { workDir, stages } = loadEpisode(member);
        printReview(member, await inspectReview(workDir, stages));
      } catch (error) {
        console.log(`${member}: 확인 필요 — ${error.message}`);
        process.exitCode = 1;
      }
    }
    return;
  }
  if (!['approve', 'request-changes'].includes(action)) throw new Error(usage);
  const allowed = action === 'approve' ? ['--revision'] : ['--revision', '--target', '--note'];
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i];
    const value = flags[i + 1];
    if (!allowed.includes(flag) || Object.hasOwn(options, flag) || !value?.trim()) throw new Error(usage);
    options[flag] = value;
  }
  if (!allowed.every(flag => Object.hasOwn(options, flag))) throw new Error(usage);
  const { workDir, stages } = loadEpisode(id);
  const review = await recordReview(workDir, stages, {
    action, revision: options['--revision'], target: options['--target'], note: options['--note'],
  });
  printReview(id, review);
}

async function generateCommand(args) {
  const { generateBatch, inspectGeneration } = require('./generation/engine.cjs');
  if (args[0] === 'status' && args.length === 2) {
    const state = await inspectGeneration(root, args[1]);
    if (!state) return console.log(`${args[1]}: not_started`);
    console.log(`${args[1]}: ${state.status} (${state.seriesId}, ${state.count} episodes)`);
    for (const attempt of state.attempts) console.log(`  ${attempt.id}: ${attempt.status}${attempt.error ? ' — ' + attempt.error : ''}`);
    if (state.semanticReport) {
      console.log('마지막 완료된 의미 판정:');
      printNovelty(state.semanticReport);
    }
    if (state.contentReport) {
      console.log('마지막 완료된 내용 판정:');
      printContent(state.contentReport);
    }
    for (const issue of state.sourceIssues || []) console.log(`  ${issue.sourceId || 'sources'}: ${issue.reason}`);
    if (state.error) console.log('Error:', state.error);
    if (batches[args[1]]) console.log(`node pipeline/cli.cjs batch status ${args[1]}`);
    return;
  }
  const [seriesId, batchId, ...flags] = args;
  const options = {};
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (!['--count', '--plan-only', '--jobs', '--attempts', '--model'].includes(flag) || Object.hasOwn(options, flag)) throw new Error(usage);
    if (flag === '--plan-only') options[flag] = true;
    else {
      const value = flags[++i];
      if (!value || value.startsWith('--')) throw new Error(usage);
      options[flag] = value;
    }
  }
  if (!/^(?:[1-9]|10)$/.test(options['--count'] || '') ||
      (options['--jobs'] !== undefined && !/^[1-8]$/.test(options['--jobs'])) ||
      (options['--attempts'] !== undefined && !/^[1-5]$/.test(options['--attempts']))) throw new Error(usage);
  if (options['--plan-only'] && options['--jobs']) throw new Error('--jobs is used only when producing videos.');
  const { createCodexProvider } = require('./generation/provider.cjs');
  const { createSpeechPreflight } = require('./generation/preflight.cjs');
  const { createNoveltyChecker } = require('./novelty/checker.cjs');
  const { createContentChecker } = require('./content/checker.cjs');
  const log = message => console.log(`[generation] ${message}`);
  const provider = createCodexProvider({ model: options['--model'] });
  productionRepairProvider = provider;
  productionContentChecker = createContentChecker({ provider, log });
  const result = await generateBatch(root, {
    seriesId, batchId, count: Number(options['--count']), maxAttempts: Number(options['--attempts'] || 3),
    provider, noveltyCheck: createNoveltyChecker({ provider, log }), contentCheck: productionContentChecker, preflight: createSpeechPreflight(root, { log }), log,
  });
  console.log(`${result.reused ? 'Existing' : 'Generated'} batch ${result.batchId}: ${result.episodeIds.join(', ')}`);
  loadRegistries();
  if (options['--plan-only']) {
    console.log(`node pipeline/cli.cjs batch run ${result.batchId}`);
    return;
  }
  await batchCommand(['run', result.batchId, '--jobs', options['--jobs'] || '1']);
  await reviewCommand(['list', result.batchId]);
}

function printPeriod(result) {
  const { period, rows } = result;
  console.log(`Period ${period.id}: ${result.status} (${period.seriesId}, ${period.timezone}, ${rows.length} episodes)`);
  console.log('게시 예정(현지) | 회차 | 제작 묶음 | 상태 | 기획/제작 시도 | 단계 | 제목');
  const slots = new Map(period.slots.map(slot => [slot.id, slot]));
  for (const row of rows) {
    const slot = slots.get(row.slotId);
    const scheduled = slot ? `${slot.date} ${slot.localTime}` : row.scheduledFor;
    console.log(`${scheduled} | ${row.episodeId || row.planId || row.slotId} | ${row.batchId} | ${row.status} | ${row.planningAttempts || 0}/${row.attempts || 0} | ${row.phase || '-'} | ${row.title || '-'}`);
    if (row.error) console.log('  Error:', row.error);
    printContentRepair(row.contentRepair);
    if (row.generationReport) console.log('  기획 생성 기록:', row.generationReport);
    if (row.contentReport) console.log('  내용 검증:', row.contentReport);
    if (row.review?.videoPath) console.log('  MP4:', row.review.videoPath);
    if (row.review?.reportPath) console.log('  QA:', row.review.reportPath);
    if (row.review?.revision) console.log('  Revision:', row.review.revision);
    if (row.episodeId) {
      const visual = require('./run-state.cjs').readStateFile(path.join(root, 'runs', row.episodeId))?.stages?.visual;
      if (visual?.dir) console.log('  화면 검수:', path.join(root, 'runs', row.episodeId, visual.dir, 'report.html'));
    }
  }
  console.log('상태별 회차 수:', JSON.stringify(result.counts));
  if (result.reportPath) console.log('기간 보고서:', result.reportPath);
  if (rows.some(row => ['failed', 'needs_review', 'interrupted'].includes(row.status))) process.exitCode = 1;
}

async function periodCommand(args) {
  const [action, id, ...flags] = args;
  const { createPeriod, listPeriods } = require('./period/planning.cjs');
  if (action === 'create' && args.length === 2) {
    const { period, reused } = await createPeriod(root, readInput(id));
    console.log(`${reused ? 'Existing' : 'Created'} period ${period.id}: ${period.slots.length} episodes, ${period.groups.length} batches (${period.timezone})`);
    console.log(`node pipeline/cli.cjs period run ${period.id}`);
    return;
  }
  if (action === 'list' && args.length === 1) {
    console.log('기간 계획 | 시리즈 | 시작일 | 일수 | 시간대 | 회차 | 제작 묶음');
    for (const period of listPeriods(root)) {
      console.log(`${period.id} | ${period.seriesId} | ${period.startDate} | ${period.days} | ${period.timezone} | ${period.slots.length} | ${period.groups.length}`);
    }
    return;
  }
  const { runPeriod, inspectPeriod } = require('./period/engine.cjs');
  const inspect = async episodeId => { loadRegistries(); return inspectMember(episodeId); };
  if (action === 'status' && args.length === 2) return printPeriod(await inspectPeriod(root, id, { inspect }));
  if (!['run', 'resume', 'retry-failed'].includes(action) || !id) throw new Error(usage);
  const options = {};
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (!['--plan-only', '--jobs', '--attempts', '--model'].includes(flag) || Object.hasOwn(options, flag)) throw new Error(usage);
    if (flag === '--plan-only') options[flag] = true;
    else {
      const value = flags[++i];
      if (!value?.trim() || value.startsWith('--')) throw new Error(usage);
      options[flag] = value;
    }
  }
  if ((options['--jobs'] !== undefined && !/^[1-8]$/.test(options['--jobs'])) ||
      (options['--attempts'] !== undefined && !/^[1-5]$/.test(options['--attempts']))) throw new Error(usage);
  if (options['--plan-only'] && options['--jobs']) throw new Error('--jobs is used only when producing videos.');
  const log = message => console.log(`[period ${id}] ${message}`);
  let provider;
  const getProvider = () => provider ||= require('./generation/provider.cjs').createCodexProvider({ model: options['--model'] });
  const contentChecker = () => {
    productionRepairProvider = getProvider();
    return productionContentChecker ||= require('./content/checker.cjs').createContentChecker({ provider: productionRepairProvider, log });
  };
  const generate = async request => require('./generation/engine.cjs').generateBatch(root, {
    ...request, maxAttempts: Number(options['--attempts'] || 3), provider: getProvider(),
    noveltyCheck: require('./novelty/checker.cjs').createNoveltyChecker({ provider: getProvider(), log }),
    contentCheck: contentChecker(), preflight: require('./generation/preflight.cjs').createSpeechPreflight(root, { log }), log,
  });
  const execute = async episodeId => {
    loadRegistries();
    const catalog = readCatalog(root);
    if (catalog.series[catalog.episodes[episodeId]?.seriesId]?.contentReview?.mode === 'required') contentChecker();
    return runMember(episodeId, { log: message => console.log(`[${episodeId}] ${message}`) });
  };
  const result = await runPeriod(root, id, { retryFailed: action === 'retry-failed', resume: action === 'resume',
    planOnly: Boolean(options['--plan-only']), jobs: Number(options['--jobs'] || 1), generate, execute, inspect, log });
  printPeriod(result);
}

async function main(args) {
  // Transfer checks must also work when the local catalog is missing or damaged.
  if (args[0] === 'handoff') return require('./handoff/index.cjs').command(root, args.slice(1));
  // Preflight must be able to describe a broken catalog as a structured error.
  // It does not need production episode/batch registries to be loaded first.
  if (args[0] === 'series' && ['check', 'register'].includes(args[1])) {
    const valid = args[1] === 'register' ? args.length === 3 :
      args.length === 3 || (args.length === 4 && args[3] === '--json');
    if (!valid) throw new Error('node pipeline/cli.cjs series check <series.json> [--json]\nnode pipeline/cli.cjs series register <series.json>');
    return seriesCommand(args.slice(1));
  }
  loadRegistries();
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return console.log(usage);
  const [command, id] = args;
  if (command === 'batch') return batchCommand(args.slice(1));
  if (command === 'review') return reviewCommand(args.slice(1));
  if (command === 'series') return seriesCommand(args.slice(1));
  if (command === 'plan') return planCommand(args.slice(1));
  if (command === 'content') return contentCommand(args.slice(1));
  if (command === 'visual') return visualCommand(args.slice(1));
  if (command === 'generate') return generateCommand(args.slice(1));
  if (command === 'period') return periodCommand(args.slice(1));
  if (args.length !== 2 || !['run', 'status'].includes(command)) throw new Error(usage);
  if (command === 'run') await runMember(id);
  const info = await inspectMember(id);
  console.log(`${id}: ${info.current ? info.review.status : info.status}`);
  for (const step of info.details) console.log(`  ${step.id}: ${step.label}${step.error ? ' — ' + step.error : ''}`);
  printReview(id, info.review, false);
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
