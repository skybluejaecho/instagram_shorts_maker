const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readCatalog } = require('../planning.cjs');
const { readEvidenceBundle } = require('../content/sources.cjs');
const { writerIsActive } = require('../run-state.cjs');

const json = value => JSON.stringify(value, null, 2) + '\n';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const exclusions = ['.git/ at any depth', 'node_modules/ at any depth', '.hyperframes/ at any depth',
  '.env and .env.* except *.example', 'secrets/ and .secrets/ at any depth', '/backups/', '/local/handoffs/'];

function identifier(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(id) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)) throw Error('Invalid handoff ID.');
  return id;
}

function relativeFile(value) {
  if (typeof value !== 'string' || !value || /[\\:\x00-\x1f]/.test(value) ||
      path.isAbsolute(value) || path.win32.isAbsolute(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw Error('Handoff paths must be safe repository-relative paths.');
  }
  return value;
}

function localPath(root, relative) {
  relativeFile(relative);
  let file = root;
  for (const part of relative.split('/')) {
    file = path.join(file, part);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw Error('Handoff does not follow links or junctions: ' + relative);
  }
  return file;
}

function excluded(relative) {
  const parts = relative.toLowerCase().split('/');
  if (parts.some(part => ['.git', 'node_modules', '.hyperframes', 'secrets', '.secrets'].includes(part))) return true;
  if (parts[0] === 'backups' || (parts[0] === 'local' && parts[1] === 'handoffs')) return true;
  const name = parts.at(-1);
  return (name === '.env' || name.startsWith('.env.')) && !name.endsWith('.example');
}

function digestFile(file) {
  const before = fs.statSync(file);
  if (!before.isFile()) throw Error('Expected a regular file: ' + file);
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  const after = fs.statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('File changed during handoff: ' + file);
  return { bytes: after.size, sha256: digest.digest('hex') };
}

function inventory(root) {
  const files = [];
  const issues = [];
  function walk(relative) {
    const directory = relative ? localPath(root, relative) : root;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (excluded(name)) continue;
      try {
        relativeFile(name);
        if (entry.isSymbolicLink()) throw Error('Links/junctions must be replaced with local files before transfer.');
        if (entry.isDirectory()) walk(name);
        else if (entry.isFile()) files.push({ path: name, ...digestFile(localPath(root, name)) });
        else throw Error('Unsupported filesystem entry.');
      } catch (error) { issues.push({ path: name, reason: error.message }); }
    }
  }
  walk('');
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), issues };
}

function summaryOf(root, files, issues) {
  // Validate all path components before the catalog reader can open the file.
  localPath(root, 'planning/catalog.json');
  const catalog = readCatalog(root);
  const known = new Set(files.map(file => file.path));
  function reference(file, label) {
    try {
      relativeFile(file);
      if (!known.has(file)) throw Error('Referenced file is missing or excluded from the transfer.');
    } catch (error) { issues.push({ path: file, reason: label + ': ' + error.message }); }
  }
  function optional(relative) {
    if (!known.has(relative)) return undefined;
    try { return read(localPath(root, relative)); }
    catch (error) { issues.push({ path: relative, reason: error.message }); return undefined; }
  }
  const series = Object.values(catalog.series).map(spec => {
    reference(spec.adapter, 'Series adapter');
    let evidence;
    try {
      const bundle = readEvidenceBundle(root, spec);
      evidence = { mode: bundle.mode, status: bundle.status, sourceHash: bundle.sourceHash,
        sources: bundle.sources.map(({ content, ...source }) => source), issues: bundle.issues };
      for (const source of spec.contentReview?.sources || []) reference(source.path, 'Evidence');
      for (const issue of bundle.issues) issues.push({ path: 'series/' + spec.id, reason: issue.reason });
    } catch (error) { issues.push({ path: 'series/' + spec.id, reason: error.message }); }
    const notes = ['BRIEF.md', 'DECISIONS.md'].map(name => `local/series/${spec.id}/${name}`).filter(file => known.has(file));
    return { ...spec, evidence, handoffNotes: notes };
  });
  const legacy = optional('pipeline/episodes.json') || {};
  const episodes = Object.entries({ ...legacy, ...catalog.episodes }).map(([id, entry]) => {
    identifier(id);
    reference(entry.adapter, 'Episode adapter');
    reference(entry.episode, 'Episode input');
    const statePath = `runs/${id}/state.json`;
    const reviewPath = `runs/${id}/review.json`;
    const state = optional(statePath);
    const review = optional(reviewPath);
    const stages = Object.entries(state?.stages || {}).map(([stageId, stage]) => {
      const outputs = Object.keys(stage.outputs || {}).map(file => `runs/${id}/${stage.dir}/${file}`);
      for (const file of outputs) reference(file, 'Stage output');
      return { id: stageId, status: stage.status, error: stage.error, outputs };
    });
    return { id, ...entry, title: catalog.plans[entry.seriesId]?.[entry.planId]?.title,
      recordedStatus: state?.status || 'not_started', statePath: state ? statePath : null,
      reviewPath: review ? reviewPath : null, lastReviewEvent: review?.history?.at(-1) || null,
      stages, contentRepair: state?.contentRepair };
  });
  for (const plans of Object.values(catalog.plans)) {
    for (const plan of Object.values(plans)) if (plan.input) reference(plan.input, 'Plan input');
  }
  const journals = files.filter(file => /^runs\/_(generation|batches|periods|revisions|content-repairs)\//.test(file.path) && file.path.endsWith('/state.json'))
    .map(file => {
      const state = optional(file.path);
      return { path: file.path, status: state?.status, reason: state?.reason || state?.error,
        updatedAt: state?.updatedAt, attempts: Array.isArray(state?.attempts) ? state.attempts.length : undefined };
    });
  return { catalogPath: known.has('planning/catalog.json') ? 'planning/catalog.json' : null,
    series, episodes, periods: Object.values(catalog.periods || {}), batches: catalog.batches, journals };
}

const cell = value => String(value ?? '-').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function markdown(manifest) {
  const { summary } = manifest;
  const lines = ['# 제작 작업 인수인계', '', `생성 시각: ${manifest.createdAt}`, `인수인계 ID: ${manifest.id}`, '',
    '**이 문서는 생성 시점의 요약이며 원본 JSON·음성·영상과 함께 이동해야 합니다.**',
    '파일 목록과 SHA-256은 manifest.json에 있습니다. 이 명령은 백업 파일 복사나 업로드를 수행하지 않았습니다.',
    '자동 생성 모델은 이 Markdown이나 저장소 전체를 자동으로 읽지 않습니다. 등록된 시리즈 설정·회차 이력·근거 자료가 실제 입력입니다.', '',
    '## 새 PC에서 시작', '', '1. 이전 PC의 모든 제작·기획·수정·승인 작업을 종료하고 마지막 변경 후 인수인계를 생성합니다.',
    '2. manifest의 모든 파일과 이 인수인계 폴더를 같은 저장소 상대경로로 복사합니다. Git clone만으로 운영 데이터는 복원되지 않습니다.',
    `3. 저장소 루트에서 \`node pipeline/cli.cjs handoff check ${manifest.id}\`를 실행합니다. 누락·변조가 있으면 재개 전에 복구합니다.`,
    '4. Windows, Node.js, HyperFrames, FFmpeg·ffprobe, Chrome, 한국어 System.Speech 음성·글꼴을 준비합니다. 파일 점검은 이 도구들의 동작 검사가 아닙니다.',
    '5. 필요한 인증은 새 PC에서 별도로 설정합니다. 현재 외부 모델 실행 허용 여부를 먼저 확인하고 임의로 생성·재개 명령을 실행하지 않습니다.',
    '6. 아래 원본과 상태 조회를 확인한 뒤 실패 원인을 해결하고 기존 기간·묶음 ID로 재개합니다. 새로운 제작 기간에만 새 ID를 사용합니다.',
    '7. Drive 등은 종료된 작업의 운반·백업에 사용합니다. 두 PC에서 같은 운영 상태를 동시에 편집·실행하지 않습니다.', '',
    '## 자료와 결정 사항', '',
    '시리즈별 수동 문서는 local/series/<시리즈 ID>/BRIEF.md와 DECISIONS.md에 보관할 수 있습니다. planning/examples/series-brief.md를 출발점으로 사용합니다.',
    '원하는 규칙은 지원되는 시리즈 설정·회차 명세에 반영하고, 사실 근거는 contentReview.sources에 명시적으로 등록합니다. 임의 문서가 자동 입력되는 것으로 간주하지 않습니다.', '',
    '## 시리즈', '', '| ID | 이름 | 주제 | 근거 상태 | 수동 문서 |', '| --- | --- | --- | --- | --- |'];
  for (const series of summary.series) lines.push(`| ${cell(series.id)} | ${cell(series.name)} | ${cell(series.topics?.join(', '))} | ${cell(series.evidence?.status)} | ${cell(series.handoffNotes.join(', '))} |`);
  for (const series of summary.series) {
    lines.push('', `### ${cell(series.id)} 자료`, '', `대상: ${cell(series.audience)} / 말투: ${cell(series.tone)} / 길이: ${series.defaultDurationSeconds}초`,
      `제작 어댑터: ${cell(series.adapter)}`);
    for (const source of series.evidence?.sources || []) lines.push(`- ${cell(source.path)} — SHA-256: ${source.sha256}`);
    for (const issue of series.evidence?.issues || []) lines.push(`- 확인 필요: ${cell(issue.reason)}`);
  }
  lines.push('', '## 기간과 제작 묶음', '', '| 기간 ID | 시리즈 | 게시 슬롯 수 | 묶음 수 | 다음 조회 |', '| --- | --- | --- | --- | --- |');
  for (const period of summary.periods) lines.push(`| ${cell(period.id)} | ${cell(period.seriesId)} | ${period.slots?.length ?? 0} | ${period.groups?.length ?? 0} | node pipeline/cli.cjs period status ${cell(period.id)} |`);
  lines.push('', '## 회차별 기록', '', '아래 상태는 저장된 기록입니다. 실제 재사용·승인 유효성은 새 PC의 status/review list로 다시 확인합니다.', '',
    '| 회차 | 기록된 상태 | 마지막 검토 행동 | 원본 입력 |', '| --- | --- | --- | --- |');
  for (const episode of summary.episodes) lines.push(`| ${cell(episode.id)} | ${cell(episode.recordedStatus)} | ${cell(episode.lastReviewEvent?.action)} | ${cell(episode.episode)} |`);
  for (const episode of summary.episodes) {
    const failures = episode.stages.filter(stage => stage.error);
    if (failures.length || episode.lastReviewEvent?.action === 'request-changes') {
      lines.push('', `- ${cell(episode.id)}: ${failures.map(stage => cell(stage.id + ': ' + stage.error)).join('; ')}`);
      if (episode.lastReviewEvent?.action === 'request-changes') lines.push(`  - 마지막 수정 요청(현재 유효성 재확인): ${cell(episode.lastReviewEvent.note)}`);
    }
  }
  lines.push('', '## 생성·수정·기간 기록', '');
  for (const journal of summary.journals) lines.push(`- ${cell(journal.path)}: ${cell(journal.status)}${journal.reason ? ' — ' + cell(journal.reason) : ''}`);
  lines.push('', '## 이동 점검 결과', '', `파일 ${manifest.files.length}개 / ${manifest.files.reduce((sum, file) => sum + file.bytes, 0)} bytes`,
    '현재 소스·자료·산출물은 상대경로로 비교합니다. 과거 보고서에 남은 이전 PC의 절대경로는 역사 기록이며 파일 전체 치환을 하지 않습니다.',
    '이전 PC와 다른 OS·음성·도구로 새 영상을 재현하는 것은 별도 검증이 필요합니다. 파일 검사 통과가 영상 품질이나 실행 환경 통과를 뜻하지 않습니다.', '');
  for (const issue of manifest.issues) lines.push(`- 확인 필요: ${cell(issue.path)} — ${cell(issue.reason)}`);
  if (!manifest.issues.length) lines.push('생성 시 확인된 파일 누락·자료 오류 없음. 실제 복사 후 check가 필요합니다.');
  lines.push('', '제외 항목: ' + exclusions.join(', '), '', '기본 제외 규칙은 모든 비밀정보를 자동 탐지하지 않습니다. 자료·실행 로그가 포함된 인수인계는 비공개로 보관합니다.', '');
  return lines.join('\n');
}

async function createHandoff(root, id, { probeWriter = writerIsActive } = {}) {
  root = fs.realpathSync(root);
  identifier(id);
  const directory = localPath(root, `local/handoffs/${id}`);
  if (fs.existsSync(directory)) throw Error('Handoff ID already exists; use a new ID.');
  const first = inventory(root);
  const directories = new Set(first.files.filter(file => file.path.endsWith('/state.json')).map(file => path.dirname(localPath(root, file.path))));
  if (fs.existsSync(path.join(root, 'planning'))) directories.add(localPath(root, 'planning'));
  // The production gate has no state.json and spans the gaps between episode stages.
  const production = localPath(root, 'runs/_production');
  if (fs.existsSync(production)) {
    for (const entry of fs.readdirSync(production, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) directories.add(localPath(root, 'runs/_production/' + entry.name));
    }
  }
  for (const workDir of directories) {
    const active = await probeWriter(workDir);
    if (active !== false) throw Error('Stop running work before handoff; writer active or unverifiable: ' + workDir);
  }
  const summary = summaryOf(root, first.files, first.issues);
  // Detect changes during collection. This is not a repository-wide lock: writers must stay stopped.
  const final = inventory(root);
  if (json(first.files) !== json(final.files)) throw Error('Workspace changed during handoff. Stop writes and try again.');
  const manifest = { version: 1, id, createdAt: new Date().toISOString(),
    origin: { root, node: process.version, platform: process.platform, arch: process.arch },
    exclusions, files: first.files, issues: first.issues, summary };
  const document = markdown(manifest);
  manifest.handoffSha256 = sha(document);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'HANDOFF.md'), document, { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'manifest.json'), json(manifest), { flag: 'wx' });
  return { directory, manifest };
}

function checkHandoff(root, id) {
  root = fs.realpathSync(root);
  identifier(id);
  const directory = localPath(root, `local/handoffs/${id}`);
  const manifest = read(localPath(root, `local/handoffs/${id}/manifest.json`));
  if (manifest?.version !== 1 || manifest.id !== id || typeof manifest.origin?.root !== 'string' ||
      !Array.isArray(manifest.files) || !manifest.files.length || !Array.isArray(manifest.issues) ||
      !/^[a-f0-9]{64}$/.test(manifest.handoffSha256)) throw Error('Invalid handoff manifest.');
  const seen = new Set();
  for (const file of manifest.files) {
    relativeFile(file.path);
    const key = file.path.toLowerCase();
    if (seen.has(key) || excluded(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('Invalid or duplicate handoff file entry.');
    seen.add(key);
  }
  const report = { status: 'passed', rootChanged: path.resolve(manifest.origin.root) !== root,
    filesChecked: 0, missing: [], changed: [], issues: [...manifest.issues], unexpectedFiles: [] };
  try {
    if (sha(fs.readFileSync(localPath(root, `local/handoffs/${id}/HANDOFF.md`))) !== manifest.handoffSha256) report.changed.push('local/handoffs/' + id + '/HANDOFF.md');
  } catch (error) { report.issues.push({ path: path.join(directory, 'HANDOFF.md'), reason: error.message }); }
  for (const file of manifest.files) {
    try {
      const actual = digestFile(localPath(root, file.path));
      report.filesChecked++;
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) report.changed.push(file.path);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) report.missing.push(file.path);
      else report.issues.push({ path: file.path, reason: error.message });
    }
  }
  const current = inventory(root);
  const latest = new Map(current.files.map(file => [file.path, file]));
  for (const file of manifest.files) {
    const actual = latest.get(file.path);
    if (!actual) report.missing.push(file.path);
    else if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) report.changed.push(file.path);
  }
  report.missing = [...new Set(report.missing)];
  report.changed = [...new Set(report.changed)];
  report.unexpectedFiles = current.files.filter(file => !seen.has(file.path.toLowerCase())).map(file => file.path);
  report.issues.push(...current.issues);
  if (report.missing.length || report.changed.length || report.issues.length) report.status = 'failed';
  return report;
}

async function command(root, args) {
  const [action, id, flag] = args;
  if (!['export', 'check'].includes(action) || !id || args.length > 3 || (flag && flag !== '--json')) {
    throw Error('node pipeline/cli.cjs handoff <export|check> <handoff-id> [--json]');
  }
  if (action === 'export') {
    const { directory, manifest } = await createHandoff(root, id);
    const result = { directory, files: manifest.files.length, issues: manifest.issues, copiedFiles: false };
    console.log(flag ? json(result) : `인수인계: ${path.join(directory, 'HANDOFF.md')}\n파일 ${result.files}개, 확인 필요 ${result.issues.length}건. 실제 파일 복사는 별도입니다.`);
    if (manifest.issues.length) process.exitCode = 1;
  } else {
    const report = checkHandoff(root, id);
    console.log(flag ? json(report) : `이동 파일 검사: ${report.status}\n검사 ${report.filesChecked}, 누락 ${report.missing.length}, 변경 ${report.changed.length}, 오류 ${report.issues.length}, 추가 ${report.unexpectedFiles.length}\n루트 변경: ${report.rootChanged}\n${[...report.missing, ...report.changed, ...report.issues.map(issue => `${issue.path}: ${issue.reason}`)].join('\n')}`);
    if (report.status !== 'passed') process.exitCode = 1;
  }
}

module.exports = { createHandoff, checkHandoff, command };
