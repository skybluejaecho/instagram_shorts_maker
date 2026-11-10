const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { validateSpec } = require('../story/spec.cjs');
const { buildHtml } = require('../story/render.cjs');
const { runVisualReview, createVisualStages } = require('./runtime.cjs');
const { normalizeVisualReview } = require('./policy.cjs');
const { runEpisode } = require('../runner.cjs');

const json = value => JSON.stringify(value, null, 2) + '\n';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const style = (html, css) => html.replace('</head>', `<style>${css}</style></head>`);

function buildCases(root) {
  const profile = read(path.join(root, 'samples/story/series.json')).renderProfile;
  const compile = (name, starts) => {
    const spec = validateSpec({ ...read(path.join(root, `samples/story/${name}.json`)), profile });
    // Isolated visual fixtures use explicit synthetic cue times, not an invented TTS result.
    const timing = { durationSeconds: 28, wordStarts: Object.fromEntries(spec.narration.map((cue, index) => [cue.id, starts?.[index] ?? index * 5 + .1])) };
    const result = buildHtml(spec, timing);
    return { ...result, html: result.html.replace(/<audio\b[^>]*>[\s\S]*?<\/audio>/g, ''), spec };
  };
  const stack = compile('stack');
  const queue = compile('queue');
  const short = compile('stack', [.1, 1.0, 10.1, 15.1, 20.1, 25.1]);
  return [
    { id: 'normal-stack', name: '정상 스택·장면 전환', ...stack, expected: { errors: false } },
    { id: 'normal-queue', name: '정상 큐·장면 전환', ...queue, expected: { errors: false } },
    { id: 'long-title', name: '긴 제목의 화면 밖 넘침', ...stack,
      html: style(stack.html.replace(/(<h1\b[^>]*>)[\s\S]*?(<\/h1>)/, '$1' + '아주 긴 제목을 반복하여 화면을 넘깁니다. '.repeat(6) + '$2'), '.question h1{white-space:nowrap!important}'),
      expected: { errors: true, anyCodes: ['outside_viewport', 'text_overflow'] } },
    { id: 'clipped-title', name: '제목 상자 내부 글자 잘림', ...stack,
      html: style(stack.html, '.question h1{height:36px!important;overflow:hidden!important}'),
      expected: { errors: true, codes: ['text_clipped'] } },
    { id: 'overlap', name: '제목과 카드 겹침', ...stack,
      html: style(stack.html, '.scene[data-scene-id="insert"] h1{top:990px!important}'),
      expected: { errors: false, codes: ['element_overlap'] } },
    { id: 'short-scene', name: '짧은 장면·읽기 시간 부족', ...short,
      expected: { errors: false, codes: ['short_scene', 'reading_time'] } },
    { id: 'small-font', name: '본문 글자 크기 부족', ...stack,
      html: style(stack.html, '.scene[data-scene-id="definition"] p{font-size:18px!important}'),
      expected: { errors: false, codes: ['small_font'] } },
    { id: 'safe-area', name: '안전영역 밖 브랜드 문구', ...stack,
      html: style(stack.html, '.brand{top:20px!important}'),
      expected: { errors: true, codes: ['outside_safe_area'] } },
  ];
}

async function main() {
  const root = path.resolve(__dirname, '../..');
  const directory = path.join(root, 'runs/_visual', 'validation-' + randomUUID().slice(0, 12));
  fs.mkdirSync(directory, { recursive: true });
  const summary = { version: 1, realBrowser: true,
    description: '기존 CS 입력과 공통 HTML 렌더러를 실제 Chrome으로 검사한다. 분리 검증용 합성 타임라인을 사용하며 오류는 복사본 HTML/CSS에만 의도적으로 넣었다. 원본 영상과 기획을 수정하지 않는다.',
    createdAt: new Date().toISOString(), results: [] };
  const cases = buildCases(root);
  const save = () => fs.writeFileSync(path.join(directory, 'validation.json'), json(summary));
  for (const fixture of cases) {
    const inputDir = path.join(directory, fixture.id, 'input');
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, 'index.html'), fixture.html);
    fs.writeFileSync(path.join(inputDir, 'timeline.json'), json(fixture.timeline));
    const auditDir = path.join(directory, fixture.id, 'audit');
    const report = await runVisualReview({ htmlFile: path.join(inputDir, 'index.html'), timeline: fixture.timeline, directory: auditDir, policy: normalizeVisualReview() });
    const codes = [...new Set(report.issues.map(issue => issue.code))];
    const errors = report.issues.filter(issue => issue.severity === 'error').length;
    const matchesExpected = Boolean(errors) === fixture.expected.errors &&
      (fixture.expected.codes || []).every(code => codes.includes(code)) &&
      (!fixture.expected.anyCodes || fixture.expected.anyCodes.some(code => codes.includes(code)));
    summary.results.push({ id: fixture.id, name: fixture.name, expected: fixture.expected, status: report.status, counts: report.counts, codes, matchesExpected,
      reportPath: path.join(auditDir, 'report.html'), jsonPath: path.join(auditDir, 'report.json') });
    console.log(`${fixture.id}: ${report.status}, ${JSON.stringify(report.counts)}, expected=${matchesExpected}`);
    save();
  }
  // Exercise the actual production gate with real Chrome and assert that render is never reached.
  const blockedDir = path.join(directory, 'blocked-production');
  const episodeFile = path.join(directory, 'blocked-episode.json');
  const failedFixture = cases.find(item => item.id === 'clipped-title');
  fs.writeFileSync(episodeFile, json(failedFixture.spec));
  let renderCalls = 0;
  const stages = createVisualStages({ root, episodeFile, stages: [
    { id: 'prepare', inputs: () => ({ fixture: 'clipped-title' }), outputs: ['index.html', 'timeline.json'],
      async run({ dir }) { fs.writeFileSync(path.join(dir, 'index.html'), failedFixture.html); fs.writeFileSync(path.join(dir, 'timeline.json'), json(failedFixture.timeline)); } },
    { id: 'render', inputs: () => ({}), outputs: ['unexpected.txt'], async run({ dir }) { renderCalls++; fs.writeFileSync(path.join(dir, 'unexpected.txt'), 'must not render'); } },
  ] });
  await assert.rejects(runEpisode(blockedDir, stages, { log: () => {} }), /Visual review failed/);
  assert.equal(renderCalls, 0);
  summary.productionGate = { renderCalls, blockedBeforeMp4: true, statePath: path.join(blockedDir, 'state.json') };
  summary.passed = summary.results.every(result => result.matchesExpected);
  summary.finishedAt = new Date().toISOString();
  save();
  fs.writeFileSync(path.join(directory, 'index.html'), `<!doctype html><html lang="ko"><meta charset="utf-8"><title>화면 검수 실제 검증</title><style>body{font:18px system-ui;max-width:1100px;margin:48px auto;padding:24px;background:#102b36;color:#f5f4ee}a{color:#a8edc7}table{border-collapse:collapse;width:100%}td,th{padding:14px;border-bottom:1px solid #557078;text-align:left}</style><h1>화면·가독성 실제 검증</h1><p>${escape(summary.description)}</p><table><tr><th>사례</th><th>결과</th><th>오류 / 경고</th><th>보고서</th></tr>${summary.results.map(result => `<tr><td>${escape(result.name)}</td><td>${escape(result.status)}</td><td>${result.counts.errors} / ${result.counts.warnings}</td><td><a href="${result.id}/audit/report.html">장면·문제 위치 보기</a></td></tr>`).join('')}</table><p>실제 제작 경로의 오류 차단: 렌더 호출 ${renderCalls}회.</p></html>`);
  console.log(json({ passed: summary.passed, directory, report: path.join(directory, 'index.html') }));
  assert.equal(summary.passed, true, 'Inspect real browser reports: some cases did not match expected outcomes.');
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { buildCases };
