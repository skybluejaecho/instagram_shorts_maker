const fs = require('node:fs');
const path = require('node:path');
const { normalizeProfile } = require('../story/spec.cjs');
const { normalizeContentReview, readEvidenceBundle } = require('../content/sources.cjs');
const { normalizeVisualReview } = require('../visual/policy.cjs');

const COMMON_ADAPTER = 'pipeline/story/adapter.cjs';
const SERIES_FIELDS = ['id', 'name', 'audience', 'topics', 'defaultDurationSeconds', 'tone', 'adapter', 'renderProfile', 'contentReview', 'visualReview'];
const PROFILE_FIELDS = ['brand', 'fontFamily', 'colors', 'transitionSeconds', 'speech'];
const COLOR_FIELDS = ['background', 'text', 'accent', 'muted'];
const SPEECH_FIELDS = ['voice', 'rate'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const readable = value => typeof value === 'string' && Boolean(value.trim());

// Registration checks inspect only declared local files and voice metadata.
// In particular, inspecting an adapter must never execute its top-level code.
function inspectAdapter(root, name) {
  if (!readable(name) || path.isAbsolute(name) || path.win32.isAbsolute(name)) throw Error('Adapter must be a repository-relative file.');
  const file = path.resolve(root, name.trim());
  const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
  };
  if (!inside(path.resolve(root), file)) throw Error('Adapter must stay inside the repository.');
  if (!fs.statSync(file).isFile()) throw Error('Adapter must be a file.');
  if (!inside(fs.realpathSync(root), fs.realpathSync(file))) throw Error('Adapter resolves outside the repository.');
  return path.relative(path.resolve(root), file).split(path.sep).join('/');
}

function normalizerField(message) {
  const names = [
    ['series ID', 'id'], ['Series name', 'name'], ['Audience', 'audience'], ['Topics', 'topics'],
    ['Tone', 'tone'], ['defaultDurationSeconds', 'defaultDurationSeconds'], ['renderProfile', 'renderProfile'],
    ['visualReview', 'visualReview'], ['Visual review', 'visualReview'], ['contentReview', 'contentReview'],
    ['content review', 'contentReview'], ['Content source', 'contentReview'], ['Adapter', 'adapter'],
  ];
  return names.find(([part]) => message.includes(part))?.[1] || 'series';
}

async function checkSeries(root, spec, options = {}) {
  const errors = [], warnings = [], checks = [];
  const report = { version: 1, status: 'failed', canRegister: false,
    seriesId: typeof spec?.id === 'string' ? spec.id : null, errors, warnings, checks, effective: {} };
  const error = (code, field, message) => errors.push({ code, field, message });
  const warn = (code, field, message) => warnings.push({ code, field, message });
  const check = (id, beforeErrors, beforeWarnings, message) => checks.push({ id,
    status: errors.length > beforeErrors ? 'failed' : warnings.length > beforeWarnings ? 'warnings' : 'passed', message });
  const unsupported = (value, allowed, prefix) => {
    if (!object(value)) return;
    for (const key of Object.keys(value)) if (!allowed.includes(key)) {
      error('UNSUPPORTED_FIELD', prefix ? prefix + '.' + key : key, '현재 지원하지 않는 설정입니다: ' + (prefix ? prefix + '.' : '') + key);
    }
  };
  if (!object(spec)) {
    error('INVALID_SERIES', 'series', '시리즈 명세는 JSON 객체여야 합니다.');
    checks.push({ id: 'settings', status: 'failed', message: '시리즈 기본 설정' });
    return report;
  }

  let startErrors = errors.length, startWarnings = warnings.length;
  unsupported(spec, SERIES_FIELDS, '');
  if (typeof spec.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(spec.id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(spec.id)) {
    error('INVALID_ID', 'id', '시리즈 ID는 소문자 영문·숫자·밑줄·하이픈으로 작성하고 Windows 예약 이름을 피해야 합니다.');
  }
  for (const field of ['name', 'audience', 'tone']) if (!readable(spec[field])) error('REQUIRED_TEXT', field, field + '에 비어 있지 않은 문구가 필요합니다.');
  if (!Array.isArray(spec.topics) || !spec.topics.length || spec.topics.some(topic => !readable(topic))) error('INVALID_TOPICS', 'topics', '주제 목록에는 비어 있지 않은 문구가 하나 이상 필요합니다.');
  if (!Number.isFinite(spec.defaultDurationSeconds) || spec.defaultDurationSeconds <= 0) error('INVALID_DURATION', 'defaultDurationSeconds', '영상 길이는 양수여야 합니다.');
  check('settings', startErrors, startWarnings, '시리즈 기본 설정과 지원 필드');

  startErrors = errors.length; startWarnings = warnings.length;
  let adapterPath;
  try { adapterPath = inspectAdapter(root, spec.adapter); }
  catch (cause) {
    const message = ['ENOENT', 'ENOTDIR'].includes(cause.code) ? '제작 어댑터 파일이 없습니다.' : cause.message;
    error('INVALID_ADAPTER', 'adapter', message);
  }
  const common = adapterPath === COMMON_ADAPTER ||
    (process.platform === 'win32' && adapterPath?.toLowerCase() === COMMON_ADAPTER);
  if (common && adapterPath !== COMMON_ADAPTER) error('ADAPTER_CASE_MISMATCH', 'adapter', '공통 어댑터 경로는 pipeline/story/adapter.cjs로 지정해야 합니다.');
  report.adapterScope = common ? 'common-story' : 'custom';
  if (!common && !errors.some(item => item.field === 'adapter')) {
    warn('CUSTOM_ADAPTER_SCOPE', 'adapter', '맞춤 어댑터는 파일 경로와 공통 등록 항목만 확인합니다. 상세 제작 설정·음성·출력 규격과 실행 가능 여부는 이 점검 범위 밖입니다.');
  }
  check('adapter', startErrors, startWarnings, '어댑터 파일과 점검 범위');

  if (common) {
    startErrors = errors.length; startWarnings = warnings.length;
    const seconds = spec.defaultDurationSeconds;
    if (Number.isFinite(seconds) && seconds > 0 && (seconds < 4 || seconds > 90 || Math.abs(seconds * 30 - Math.round(seconds * 30)) > .00001)) {
      error('UNSUPPORTED_DURATION', 'defaultDurationSeconds', '공통 장면 영상은 4~90초이며 30fps 프레임 단위여야 합니다.');
    }
    report.effective.output = { width: 1080, height: 1920, fps: 30, durationSeconds: seconds };
    const profile = spec.renderProfile === undefined ? {} : spec.renderProfile;
    if (!object(profile)) error('INVALID_PROFILE', 'renderProfile', 'renderProfile은 객체여야 합니다.');
    if (object(profile)) {
      unsupported(profile, PROFILE_FIELDS, 'renderProfile');
      for (const field of ['brand', 'fontFamily', 'transitionSeconds']) {
        if (!Object.hasOwn(profile, field)) continue;
        try { normalizeProfile({ [field]: profile[field] }); }
        catch (cause) { error('UNSUPPORTED_PROFILE', 'renderProfile.' + field, cause.message); }
      }
      for (const [group, allowed] of [['colors', COLOR_FIELDS], ['speech', SPEECH_FIELDS]]) {
        if (!Object.hasOwn(profile, group)) continue;
        if (!object(profile[group])) { error('INVALID_PROFILE', 'renderProfile.' + group, group + '는 객체여야 합니다.'); continue; }
        unsupported(profile[group], allowed, 'renderProfile.' + group);
        for (const field of allowed) if (Object.hasOwn(profile[group], field)) {
          try { normalizeProfile({ [group]: { [field]: profile[group][field] } }); }
          catch (cause) { error('UNSUPPORTED_PROFILE', `renderProfile.${group}.${field}`, cause.message); }
        }
      }
      try { report.effective.renderProfile = normalizeProfile(profile); }
      catch { /* Individual invalid fields are already listed above. */ }
    }
    check('profile', startErrors, startWarnings, '공통 영상 길이·디자인·음성 설정');

    startErrors = errors.length; startWarnings = warnings.length;
    let requested;
    if (object(profile) && (profile.speech === undefined || object(profile.speech))) {
      const supplied = profile.speech || {};
      try { requested = normalizeProfile({ speech: Object.hasOwn(supplied, 'voice') ? { voice: supplied.voice } : {} }).speech.voice; }
      catch { /* Invalid voice text is already reported by the profile check. */ }
    }
    if (requested !== undefined) {
      report.voice = { requested, installed: [] };
      try {
        const listVoices = options.listVoices || require('./voices.cjs').listInstalledVoices;
        const installed = await listVoices();
        if (!Array.isArray(installed) || installed.some(voice => !object(voice) || !readable(voice.name) || !readable(voice.culture) || typeof voice.enabled !== 'boolean')) throw Error('음성 조회 결과의 형식이 올바르지 않습니다.');
        report.voice.installed = installed.map(({ name, culture, enabled }) => ({ name, culture, enabled }));
        const matching = installed.filter(voice => voice.name === requested);
        if (!matching.length) error('VOICE_NOT_INSTALLED', 'renderProfile.speech.voice', '설치된 음성 목록에 요청한 음성이 없습니다: ' + requested);
        else if (!matching.some(voice => voice.enabled)) error('VOICE_DISABLED', 'renderProfile.speech.voice', '요청한 음성이 비활성화되어 있습니다: ' + requested);
        else if (!matching.some(voice => voice.enabled && voice.culture === 'ko-KR')) error('VOICE_LANGUAGE_UNSUPPORTED', 'renderProfile.speech.voice', '공통 장면 제작에는 활성화된 ko-KR 한국어 음성이 필요합니다: ' + requested);
      } catch (cause) {
        error('VOICE_DISCOVERY_FAILED', 'renderProfile.speech.voice', '설치 음성 목록을 확인할 수 없습니다. ' + cause.message);
      }
      check('voice', startErrors, startWarnings, '설치된 Windows 한국어 음성');
    } else checks.push({ id: 'voice', status: 'skipped', message: '음성 설정 오류를 먼저 해결해야 설치 여부를 확인할 수 있습니다.' });
  } else {
    if (spec.renderProfile !== undefined && !object(spec.renderProfile)) error('INVALID_PROFILE', 'renderProfile', 'renderProfile은 객체여야 합니다.');
    checks.push({ id: 'profile', status: 'skipped', message: '맞춤 어댑터의 제작 설정은 별도 확인이 필요합니다.' });
    checks.push({ id: 'voice', status: 'skipped', message: '맞춤 어댑터의 음성 환경은 별도 확인이 필요합니다.' });
  }

  startErrors = errors.length; startWarnings = warnings.length;
  try {
    const policy = normalizeContentReview(spec.contentReview);
    report.effective.contentReview = policy;
    if (policy.mode === 'off') warn('CONTENT_REVIEW_DISABLED', 'contentReview.mode', '내용·근거 검증이 꺼져 있습니다. 지식 시리즈는 required와 실제 근거 자료 등록을 권장합니다.');
    if (!common && policy.mode === 'required') error('CONTENT_ADAPTER_UNSUPPORTED', 'contentReview.mode', '필수 내용 검증은 공통 장면 어댑터에서만 지원합니다.');
    const bundle = readEvidenceBundle(root, { contentReview: policy });
    report.evidence = { mode: bundle.mode, status: bundle.status, sourceHash: bundle.sourceHash,
      sources: bundle.sources.map(({ content, ...metadata }) => metadata), issues: bundle.issues };
    for (const issue of bundle.issues) {
      const index = policy.sources.findIndex(source => source.id === issue.sourceId);
      error('EVIDENCE_UNAVAILABLE', index < 0 ? 'contentReview.sources' : `contentReview.sources[${index}].path`, issue.reason);
    }
  } catch (cause) { error('INVALID_CONTENT_POLICY', 'contentReview', cause.message); }
  check('evidence', startErrors, startWarnings, '등록 근거 자료의 경로·본문·읽기 가능 여부');

  startErrors = errors.length; startWarnings = warnings.length;
  if (common || spec.visualReview !== undefined) {
    try {
      const policy = normalizeVisualReview(spec.visualReview);
      report.effective.visualReview = policy;
      if (policy.mode === 'off') warn('VISUAL_REVIEW_DISABLED', 'visualReview.mode', '화면·가독성 검수가 꺼져 있습니다.');
      if (!common && policy.mode === 'required') error('VISUAL_ADAPTER_UNSUPPORTED', 'visualReview.mode', '필수 화면 검수는 공통 장면 어댑터에서만 지원합니다.');
    } catch (cause) { error('INVALID_VISUAL_POLICY', 'visualReview', cause.message); }
    check('visual', startErrors, startWarnings, '화면·가독성 검수 정책');
  } else checks.push({ id: 'visual', status: 'skipped', message: '맞춤 어댑터의 화면 검수는 별도 확인이 필요합니다.' });

  const { normalizeSeries, readCatalog } = require('../planning.cjs');
  try { report.normalized = normalizeSeries(root, spec); }
  catch (cause) {
    const field = normalizerField(cause.message);
    if (!errors.length || (field !== 'series' && !errors.some(item => item.field === field || item.field.startsWith(field + '.')))) error('INVALID_SERIES', field, cause.message);
  }
  startErrors = errors.length; startWarnings = warnings.length;
  if (report.normalized) {
    try {
      const registered = readCatalog(root).series;
      const existing = Object.hasOwn(registered, report.normalized.id) ? registered[report.normalized.id] : undefined;
      report.existing = Boolean(existing);
      if (existing && JSON.stringify(existing) !== JSON.stringify(report.normalized)) error('SERIES_CONFLICT', 'id', '같은 ID의 시리즈가 다른 설정으로 등록되어 있습니다. 새 ID를 사용하거나 지원하는 정책 변경 명령을 사용하세요.');
    } catch (cause) { error('CATALOG_UNREADABLE', 'catalog', '시리즈 카탈로그를 읽을 수 없습니다. ' + cause.message); }
    check('catalog', startErrors, startWarnings, '기존 시리즈 ID와 설정 충돌');
  } else checks.push({ id: 'catalog', status: 'skipped', message: '설정 오류를 해결한 뒤 기존 시리즈와 비교합니다.' });
  report.status = errors.length ? 'failed' : warnings.length ? 'warnings' : 'passed';
  report.canRegister = errors.length === 0;
  return report;
}

module.exports = { checkSeries, COMMON_ADAPTER };
