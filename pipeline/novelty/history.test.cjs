const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSeriesHistory } = require('./history.cjs');

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const base = fs.mkdtempSync(path.join(parent, 'shorts-novelty-history-'));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  t.after(() => {
    assert.equal(path.dirname(base), parent);
    assert.ok(path.basename(base).startsWith('shorts-novelty-history-'));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const plan = (id, fields = {}) => ({ id, seriesId:'cs', title:id + ' 제목', topicKey:id + '.topic',
    objective:id + ' 학습 목표', angle:'순서를 비교한다', references:[], ...fields });
  const catalog = { version:1, series:{ cs:{id:'cs'}, other:{id:'other'} }, plans:{ cs:{}, other:{} }, episodes:{}, batches:{} };
  const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  return { root, base, catalog, plan, write };
}

test('all draft, materialized and published history is retained in order and scoped to its series', t => {
  const job = fixture(t);
  job.catalog.plans.cs = { draft:job.plan('draft'), old:job.plan('old', { publishedAt:'2026-11-01T00:00:00Z' }),
    ready:job.plan('ready', { input:'ready.json', knowledge:{core:'스택의 맨 위 값을 읽는다',example:'A 위에 B'} }) };
  job.catalog.plans.other.hidden = { ...job.plan('hidden'), seriesId:'other', input:'missing-should-not-read.json' };
  job.write('ready.json', { narration:[{id:'cue',text:'비를 확인해도 자료는 남습니다.'}], secret:'not part of semantic context' });
  const before = JSON.stringify(job.catalog);
  const first = readSeriesHistory(job.root, job.catalog, 'cs');
  assert.deepEqual(first.history.map(item => item.id), ['draft','old','ready']);
  assert.equal(first.history[1].publishedAt, '2026-11-01T00:00:00Z');
  assert.deepEqual(first.history[2].narration, [{id:'cue',text:'비를 확인해도 자료는 남습니다.'}]);
  assert.equal(first.history[2].knowledge.example, 'A 위에 B');
  assert.equal(first.history[2].secret, undefined);
  assert.match(first.history[2].contentHash, /^[a-f0-9]{64}$/);
  assert.equal(first.historyHash, readSeriesHistory(job.root, job.catalog, 'cs').historyHash);
  assert.equal(JSON.stringify(job.catalog), before);
});

test('current materialized revision input takes precedence over the old plan input', t => {
  const job = fixture(t);
  job.catalog.plans.cs.p = job.plan('p', { input:'obsolete-missing.json' });
  job.catalog.episodes['cs-p'] = { seriesId:'cs',planId:'p',episode:'current.json' };
  job.write('current.json', { narration:[{id:'cue',text:'수정된 현재 낭독문입니다.'}] });
  const before = readSeriesHistory(job.root, job.catalog, 'cs');
  assert.equal(before.history[0].narration[0].text, '수정된 현재 낭독문입니다.');
  job.write('current.json', { narration:[{id:'cue',text:'다음 수정의 새 낭독문입니다.'}] });
  const after = readSeriesHistory(job.root, job.catalog, 'cs');
  assert.notEqual(before.historyHash, after.historyHash);
  assert.notEqual(before.history[0].contentHash, after.history[0].contentHash);
});

test('metadata changes and every history entry affect the fingerprint without truncation', t => {
  const job = fixture(t);
  for (let i = 0; i < 57; i++) job.catalog.plans.cs['p'+i] = job.plan('p'+i);
  const before = readSeriesHistory(job.root, job.catalog, 'cs');
  assert.equal(before.history.length, 57);
  job.catalog.plans.cs.p56.objective = '마지막 회차의 목표 변경';
  const after = readSeriesHistory(job.root, job.catalog, 'cs');
  assert.notEqual(before.historyHash, after.historyHash);
  assert.equal(after.history.at(-1).objective, '마지막 회차의 목표 변경');
});

test('missing, malformed or escaped inputs fail rather than silently dropping previous content', t => {
  const job = fixture(t);
  const failure = (input, regex) => {
    job.catalog.plans.cs.p = job.plan('p', { input });
    assert.throws(() => readSeriesHistory(job.root, job.catalog, 'cs'), regex);
  };
  failure('missing.json', /History input for p could not be read/);
  failure('../outside.json', /outside the repository/);
  failure(path.join(job.root, 'absolute.json'), /repository-relative/);
  fs.writeFileSync(path.join(job.root, 'bad.json'), '{broken');
  failure('bad.json', /could not be read/);
  job.write('bad.json', { narration:{text:'wrong shape'} });
  failure('bad.json', /narration must be an array/);
  job.write('bad.json', { narration:[{id:'cue'}] });
  failure('bad.json', /must contain text/);
});

test('a junction to content outside the repository is rejected by realpath containment', t => {
  const job = fixture(t);
  const outside = path.join(job.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'voice.json'), JSON.stringify({narration:['외부 내용']}));
  fs.symlinkSync(outside, path.join(job.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  job.catalog.plans.cs.p = job.plan('p', { input:'linked/voice.json' });
  assert.throws(() => readSeriesHistory(job.root, job.catalog, 'cs'), /resolves outside/);
});

test('known legacy beats expose only narration and ambiguous materialization is rejected', t => {
  const job = fixture(t);
  job.catalog.plans.cs.p = job.plan('p', { input:'beats.json' });
  job.write('beats.json', { beats:[{id:'one',narration:'기존 방식의 낭독문입니다.',private:'exclude'}] });
  assert.deepEqual(readSeriesHistory(job.root, job.catalog, 'cs').history[0].narration,
    [{id:'one',text:'기존 방식의 낭독문입니다.'}]);
  job.catalog.episodes.one = {seriesId:'cs',planId:'p',episode:'beats.json'};
  job.catalog.episodes.two = {seriesId:'cs',planId:'p',episode:'beats.json'};
  assert.throws(() => readSeriesHistory(job.root, job.catalog, 'cs'), /Multiple materialized/);
});
