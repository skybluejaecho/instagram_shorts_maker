const line = value => String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ');

function formatPreflight(report) {
  const result = [`시리즈 사전 점검: ${line(report.seriesId || '(ID 없음)')} — ${line(report.status)}`];
  for (const item of report.checks || []) result.push(`  ${line(item.id)}: ${line(item.status)} — ${line(item.message)}`);
  for (const [kind, items] of [['오류', report.errors], ['안내', report.warnings]]) {
    for (const item of items || []) result.push(`  ${kind} [${line(item.code)}] ${line(item.field)}: ${line(item.message)}`);
  }
  if (report.effective && Object.keys(report.effective).length) {
    result.push('적용 설정:', JSON.stringify(report.effective, null, 2));
  }
  result.push(report.canRegister ? '등록 가능. 점검은 새 기획·음성 합성·영상 제작을 실행하지 않습니다.' : '등록 불가. 오류 항목을 보완한 뒤 다시 점검하세요.');
  return result.join('\n');
}

function inputError(error) {
  return { version: 1, seriesId: null, status: 'failed', canRegister: false,
    errors: [{ code: 'SERIES_INPUT_INVALID', field: '$', message: `시리즈 JSON 파일을 읽을 수 없습니다: ${error.message}` }],
    warnings: [], checks: [], effective: {} };
}

module.exports = { formatPreflight, inputError };
