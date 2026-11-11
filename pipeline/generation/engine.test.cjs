const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateBatch, inspectGeneration } = require('./engine.cjs');
const { registerSeries: registerActualSeries, addPlans, readCatalog } = require('../planning.cjs');
// Registration probes only the injected local voice inventory in these logic tests.
const registerSeries = (root, spec) => registerActualSeries(root, spec, {
  listVoices: async () => [{ name: 'Microsoft Heami Desktop', culture: 'ko-KR', enabled: true }],
});

async function exactNovelty({ entries, history }) {
  const normal = value => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  const comparisons = [];
  const duplicatePlanIds = [];
  for (const [index, entry] of entries.entries()) {
    for (const other of [...history, ...entries.slice(0, index).map(item => item.plan)]) {
      if (['topicKey', 'title', 'objective'].some(key => normal(entry.plan[key]) === normal(other[key]))) {
        comparisons.push({ candidateId: entry.plan.id, reference: { kind: 'history', id: other.id },
          verdict: 'duplicate', reason: 'repeats an existing fact', method: 'exact' });
        if (!duplicatePlanIds.includes(entry.plan.id)) duplicatePlanIds.push(entry.plan.id);
      }
    }
  }
  return { status: duplicatePlanIds.length ? 'duplicates' : 'passed', duplicatePlanIds, reviewPlanIds: [], comparisons,
    profiles: entries.map(entry => ({ planId: entry.plan.id, knowledge: { core: entry.plan.objective, example: entry.plan.angle } })) };
}

async function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-generation-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('shorts-generation-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const adapterDir = path.join(root, 'pipeline', 'story');
  fs.mkdirSync(adapterDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'pipeline', 'episodes.json'), '{}');
  fs.writeFileSync(path.join(root, 'pipeline', 'batches.json'), '{}');
  fs.writeFileSync(path.join(adapterDir, 'adapter.cjs'), `
    const fs = require('node:fs');
    const path = require('node:path');
    exports.createStages = () => {
      if (fs.existsSync(path.join(__dirname, 'fail-commit'))) throw Error('Fixture commit failure');
      return [{id:'render',inputs:()=>({}),outputs:['video.mp4'],run:async()=>{}}];
    };
  `);
  const series = { id: 'sample', name: '자료 구조 검증', audience: '입문자', topics: ['스택', '큐'],
    defaultDurationSeconds: 30, tone: '간결한 설명', adapter: 'pipeline/story/adapter.cjs' };
  await registerSeries(root, series);
  return { root, series, adapterDir,
    options: { seriesId: series.id, batchId: 'generated', count: 1, preflight: async () => {}, noveltyCheck: exactNovelty },
    catalogText: () => fs.readFileSync(path.join(root, 'planning', 'catalog.json'), 'utf8'),
    workDir: path.join(root, 'runs', '_generation', 'generated') };
}

function proposal(suffix = 'peek') {
  const scene = (id, type, from, headline) => ({ id, type, from, headline,
    body: null, cards: [], layout: 'row', carry: [], actions: [] });
  return { episodes: [{ title: '데이터 확인 ' + suffix, topicKey: 'stack.' + suffix,
    objective: '값을 유지하는 확인 방법 ' + suffix, angle: '확인 후 남은 값을 비교합니다.',
    story: { narration: [{ id: 'hook', text: '맨 위의 값을 확인하면 자료가 사라질까요?' },
      { id: 'answer', text: '확인 연산은 값을 읽기만 하므로 자료는 그대로 남아 있습니다.' }],
    scenes: [scene('question', 'question', 'hook', '확인하면 사라질까?'),
      scene('finish', 'conclusion', 'answer', '자료는 그대로')] } }] };
}

test('generation repairs duplicate history and measured timing before atomically committing', async t => {
  const job = await fixture(t);
  await addPlans(job.root, 'sample', [{ id: 'old', title: '기존 이야기', topicKey: 'stack.duplicate',
    objective: '기존 목표', angle: '기존 예시', references: [] }]);
  const replies = [proposal('duplicate'), proposal('long'), proposal('short')];
  const prompts = [];
  let checks = 0;
  const result = await generateBatch(job.root, { ...job.options,
    provider: async ({ prompt, schema, directory }) => {
      assert.equal(schema.additionalProperties, false);
      assert.ok(directory.startsWith(job.workDir + path.sep));
      prompts.push(prompt);
      return replies[prompts.length - 1];
    },
    preflight: async (entries, directory) => {
      checks++;
      assert.equal(entries[0].story.durationSeconds, 30);
      assert.ok(fs.statSync(directory).isDirectory());
      if (checks === 1) throw new Error('Measured narration is 31.2s; shorten below 29s.');
    },
  });
  assert.equal(prompts.length, 3);
  assert.match(prompts[1], /repeats an existing/);
  assert.match(prompts[2], /31\.2s/);
  assert.equal(checks, 2);
  assert.deepEqual(result, { batchId: 'generated', episodeIds: ['sample-generated-01'], reused: false });
  const catalog = readCatalog(job.root);
  assert.deepEqual(Object.keys(catalog.plans.sample), ['old', 'generated-01']);
  assert.equal(catalog.plans.sample['generated-01'].topicKey, 'stack.short');
  assert.equal(catalog.generations.generated.referencesVerified, false);
  const state = await inspectGeneration(job.root, 'generated');
  assert.equal(state.status, 'committed');
  assert.deepEqual(state.attempts.map(item => item.status), ['rejected', 'rejected', 'accepted']);
});

test('bounded failed preflight preserves the complete catalog and records all attempts', async t => {
  const job = await fixture(t);
  const before = job.catalogText();
  let calls = 0;
  await assert.rejects(generateBatch(job.root, { ...job.options, maxAttempts: 2,
    provider: async () => { calls++; return proposal(); },
    preflight: async () => { throw new Error('Scene is too short for its transition.'); },
  }), /after 2 attempts/);
  assert.equal(calls, 2);
  assert.equal(job.catalogText(), before);
  const state = await inspectGeneration(job.root, 'generated');
  assert.equal(state.status, 'failed');
  assert.equal(state.attempts.length, 2);
  assert.equal(state.accepted, undefined);
});

test('transport failure stops immediately and releases the lock for a later retry', async t => {
  const job = await fixture(t);
  let calls = 0;
  await assert.rejects(generateBatch(job.root, { ...job.options, provider: async () => {
    calls++; throw new Error('Model login required.');
  } }), /login required/);
  assert.equal(calls, 1);
  assert.equal((await inspectGeneration(job.root, 'generated')).attempts[0].status, 'provider_failed');
  const result = await generateBatch(job.root, { ...job.options, provider: async () => proposal() });
  assert.equal(result.reused, false);
  assert.equal((await inspectGeneration(job.root, 'generated')).attempts.length, 2);
});

test('a non-retryable runtime preflight failure preserves its candidate and resumes without another model call', async t => {
  const job = await fixture(t);
  const before = job.catalogText();
  let calls = 0;
  const provider = async () => { calls++; return proposal(); };
  const missingVoice = async () => {
    const error = new Error('The Korean voice is not installed.');
    error.generationRetryable = false;
    throw error;
  };
  await assert.rejects(generateBatch(job.root, { ...job.options, provider, preflight: missingVoice }), /voice is not installed/);
  let state = await inspectGeneration(job.root, 'generated');
  assert.equal(state.status, 'preflight_failed');
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].status, 'preflight_failed');
  assert.ok(state.preflightPending);
  assert.equal(state.accepted, undefined);
  assert.equal(calls, 1);
  assert.equal(job.catalogText(), before);
  await assert.rejects(generateBatch(job.root, { ...job.options, preflight: missingVoice }), /voice is not installed/);
  assert.equal(calls, 1);
  const result = await generateBatch(job.root, job.options);
  assert.equal(result.reused, false);
  state = await inspectGeneration(job.root, 'generated');
  assert.equal(state.status, 'committed');
  assert.equal(state.preflightPending, undefined);
  assert.ok(state.accepted);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].status, 'accepted');
});

test('a pending preflight candidate with a newly measured content defect enters the bounded repair loop', async t => {
  const job = await fixture(t);
  const runtime = Object.assign(new Error('Speech runtime unavailable.'), { generationRetryable: false });
  await assert.rejects(generateBatch(job.root, { ...job.options,
    provider: async () => proposal('long'), preflight: async () => { throw runtime; },
  }), /runtime unavailable/);
  let calls = 0;
  let checks = 0;
  await generateBatch(job.root, { ...job.options, maxAttempts: 1,
    provider: async ({ prompt }) => {
      calls++;
      assert.match(prompt, /Measured narration is 32 seconds/);
      assert.match(prompt, /stack\.long/);
      return proposal('short');
    },
    preflight: async () => {
      checks++;
      if (checks === 1) throw new Error('Measured narration is 32 seconds.');
    },
  });
  assert.equal(calls, 1);
  assert.equal(checks, 2);
  const state = await inspectGeneration(job.root, 'generated');
  assert.equal(state.preflightPending, undefined);
  assert.deepEqual(state.attempts.map(attempt => attempt.status), ['rejected', 'accepted']);
  assert.equal(readCatalog(job.root).plans.sample['generated-01'].topicKey, 'stack.short');
});

test('committed generation is reused without a model call or another preflight; conflicting requests fail early', async t => {
  const job = await fixture(t);
  await generateBatch(job.root, { ...job.options, provider: async () => proposal() });
  const before = job.catalogText();
  const forbidden = async () => { throw new Error('Must not call again.'); };
  const result = await generateBatch(job.root, { ...job.options, provider: forbidden, preflight: forbidden, noveltyCheck: undefined });
  assert.equal(result.reused, true);
  assert.equal(job.catalogText(), before);
  await assert.rejects(generateBatch(job.root, { ...job.options, count: 2, provider: forbidden }), /different generation request/);
  assert.equal(job.catalogText(), before);
});

test('a validated candidate survives commit failure and resumes without regeneration', async t => {
  const job = await fixture(t);
  const marker = path.join(job.adapterDir, 'fail-commit');
  fs.writeFileSync(marker, 'test');
  let calls = 0;
  const options = { ...job.options, provider: async () => { calls++; return proposal(); } };
  await assert.rejects(generateBatch(job.root, options), /Fixture commit failure/);
  assert.equal((await inspectGeneration(job.root, 'generated')).status, 'commit_failed');
  assert.deepEqual(readCatalog(job.root).batches, {});
  fs.unlinkSync(marker);
  const result = await generateBatch(job.root, options);
  assert.equal(result.reused, false);
  assert.equal(calls, 1);
  assert.equal((await inspectGeneration(job.root, 'generated')).attempts.length, 1);
});

test('accepted candidates are checked against fresh history and only their new duplicates are replaced', async t => {
  const job = await fixture(t);
  const marker = path.join(job.adapterDir, 'fail-commit');
  fs.writeFileSync(marker, 'test');
  await assert.rejects(generateBatch(job.root, { ...job.options, provider: async () => proposal() }), /Fixture commit failure/);
  fs.unlinkSync(marker);
  await addPlans(job.root, 'sample', [{ id: 'concurrent', title: '별도 기획', topicKey: 'stack.peek',
    objective: '다른 목표', angle: '동시 추가', references: [] }]);
  let calls = 0;
  const options = { ...job.options, provider: async () => { calls++; return proposal('replacement'); } };
  await generateBatch(job.root, options);
  assert.equal(calls, 1);
  assert.equal(readCatalog(job.root).plans.sample['generated-01'].topicKey, 'stack.replacement');
  const state = await inspectGeneration(job.root, 'generated');
  assert.deepEqual(state.attempts[1].replacedPlanIds, ['generated-01']);
});

test('accepted candidate integrity is checked before resume', async t => {
  const job = await fixture(t);
  const marker = path.join(job.adapterDir, 'fail-commit');
  fs.writeFileSync(marker, 'test');
  await assert.rejects(generateBatch(job.root, { ...job.options, provider: async () => proposal() }), /Fixture commit failure/);
  fs.unlinkSync(marker);
  const state = await inspectGeneration(job.root, 'generated');
  fs.appendFileSync(path.join(job.workDir, state.accepted.candidatePath), '\n');
  let calls = 0;
  await assert.rejects(generateBatch(job.root, { ...job.options, provider: async () => { calls++; return proposal(); } }), /candidate changed/);
  assert.equal(calls, 0);
  assert.deepEqual(readCatalog(job.root).batches, {});
});

test('concurrent generation of one batch is rejected while status remains readable', async t => {
  const job = await fixture(t);
  let releaseProvider;
  let providerStarted;
  const started = new Promise(resolve => { providerStarted = resolve; });
  const held = new Promise(resolve => { releaseProvider = resolve; });
  const first = generateBatch(job.root, { ...job.options, provider: async () => {
    providerStarted();
    await held;
    return proposal();
  } });
  await started;
  try {
    assert.equal((await inspectGeneration(job.root, 'generated')).status, 'generating');
    await assert.rejects(generateBatch(job.root, { ...job.options, provider: async () => proposal() }), /already running/);
  } finally { releaseProvider(); }
  await first;
});

test('unsupported inputs fail before generation, and an abandoned active journal is interrupted', async t => {
  const job = await fixture(t);
  const forbidden = async () => { throw new Error('Provider was called.'); };
  await assert.rejects(generateBatch(job.root, { ...job.options, count: 11, provider: forbidden }), /1–10/);
  await assert.rejects(generateBatch(job.root, { ...job.options, preflight: undefined, provider: forbidden }), /preflight/);
  await assert.rejects(generateBatch(job.root, { ...job.options, batchId: '..', provider: forbidden }), /safe identifier/);
  fs.mkdirSync(job.workDir, { recursive: true });
  fs.writeFileSync(path.join(job.workDir, 'state.json'), JSON.stringify({ version: 1, status: 'preflighting' }));
  assert.equal((await inspectGeneration(job.root, 'generated')).status, 'interrupted');
  assert.equal(await inspectGeneration(job.root, 'missing'), undefined);
});

function batchProposal(...suffixes) {
  return { episodes: suffixes.flatMap(suffix => proposal(suffix).episodes) };
}

async function semanticResult(entries, { duplicate = [], uncertain = [] } = {}) {
  const report = await exactNovelty({ entries, history: [] });
  return { ...report, status: uncertain.length ? 'needs_review' : duplicate.length ? 'duplicates' : 'passed',
    duplicatePlanIds: duplicate, reviewPlanIds: uncertain,
    comparisons: [...duplicate.map(candidateId => ({ pairId: candidateId, candidateId,
      reference: { kind: 'history', id: 'old' }, verdict: 'duplicate', reason: '표현만 다르고 같은 지식입니다.', method: 'model' })),
    ...uncertain.map(candidateId => ({ pairId: candidateId, candidateId,
      reference: { kind: 'history', id: 'old' }, verdict: 'uncertain', reason: '기존 초안의 핵심이 불명확합니다.', method: 'model' }))] };
}

test('semantic duplicates replace only rejected slots and preserve the accepted raw episode exactly', async t => {
  const job = await fixture(t);
  const initial = batchProposal('separate', 'paraphrase');
  const replies = [initial, proposal('new-knowledge')];
  const calls = [];
  let checks = 0;
  const result = await generateBatch(job.root, { ...job.options, count: 2,
    provider: async ({ prompt }) => {
      calls.push(prompt);
      return replies[calls.length - 1];
    },
    noveltyCheck: async ({ entries }) => {
      checks++;
      return semanticResult(entries, { duplicate: checks === 1 ? ['generated-02'] : [] });
    },
    preflight: async entries => {
      assert.equal(checks, 2);
      assert.deepEqual(entries.map(entry => entry.plan.topicKey), ['stack.separate', 'stack.new-knowledge']);
    },
  });
  assert.deepEqual(result.episodeIds, ['sample-generated-01', 'sample-generated-02']);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /generated-02/);
  const state = await inspectGeneration(job.root, 'generated');
  const accepted = JSON.parse(fs.readFileSync(path.join(job.workDir, state.accepted.candidatePath)));
  assert.deepEqual(accepted.episodes[0], initial.episodes[0]);
  assert.deepEqual(state.attempts[1].replacedPlanIds, ['generated-02']);
  const stored = readCatalog(job.root);
  assert.ok(stored.plans.sample['generated-01'].knowledge.core);
  assert.equal(stored.generations.generated.novelty.status, 'passed');
  assert.ok(state.semanticReportFile);
});

test('uncertain semantic decisions stop before synthesis and recheck the same candidate on explicit retry', async t => {
  const job = await fixture(t);
  const before = job.catalogText();
  let modelCalls = 0;
  let speechCalls = 0;
  const options = { ...job.options, provider: async () => { modelCalls++; return proposal(); },
    preflight: async () => { speechCalls++; },
    noveltyCheck: async ({ entries }) => semanticResult(entries, { uncertain: ['generated-01'] }),
  };
  await assert.rejects(generateBatch(job.root, options), /needs human review/);
  await assert.rejects(generateBatch(job.root, options), /needs human review/);
  assert.equal(modelCalls, 1);
  assert.equal(speechCalls, 0);
  assert.equal(job.catalogText(), before);
  assert.equal((await inspectGeneration(job.root, 'generated')).status, 'needs_review');
  await generateBatch(job.root, { ...options, noveltyCheck: exactNovelty });
  assert.equal(modelCalls, 1);
  assert.equal(speechCalls, 1);
});

test('duplicate replacement exhaustion leaves review state and preserves the retained slots on retry', async t => {
  const job = await fixture(t);
  let modelCalls = 0;
  let speechCalls = 0;
  const initial = batchProposal('retained', 'paraphrase');
  const options = { ...job.options, count: 2, maxAttempts: 2,
    provider: async () => { modelCalls++; return modelCalls === 1 ? initial : proposal('another-paraphrase'); },
    preflight: async () => { speechCalls++; },
    noveltyCheck: async ({ entries }) => semanticResult(entries, { duplicate: ['generated-02'] }),
  };
  await assert.rejects(generateBatch(job.root, options), /after 2 attempts/);
  assert.equal(modelCalls, 2);
  assert.equal(speechCalls, 0);
  assert.deepEqual(readCatalog(job.root).batches, {});
  let state = await inspectGeneration(job.root, 'generated');
  assert.equal(state.status, 'needs_review');
  assert.deepEqual(state.repair.planIds, ['generated-02']);
  let checked = 0;
  await generateBatch(job.root, { ...options, maxAttempts: 1,
    provider: async () => { modelCalls++; return proposal('genuinely-new'); },
    noveltyCheck: async ({ entries }) => semanticResult(entries, { duplicate: ++checked === 1 ? ['generated-02'] : [] }),
  });
  state = await inspectGeneration(job.root, 'generated');
  const candidate = JSON.parse(fs.readFileSync(path.join(job.workDir, state.accepted.candidatePath)));
  assert.deepEqual(candidate.episodes[0], initial.episodes[0]);
  assert.equal(modelCalls, 3);
  assert.equal(speechCalls, 1);
});

test('semantic provider failure preserves candidate and retries judgment without a content-model call', async t => {
  const job = await fixture(t);
  let modelCalls = 0;
  let speechCalls = 0;
  await assert.rejects(generateBatch(job.root, { ...job.options,
    provider: async () => { modelCalls++; return proposal(); },
    noveltyCheck: async () => { throw new Error('Judge connection unavailable'); },
    preflight: async () => { speechCalls++; },
  }), /Judge connection/);
  assert.equal((await inspectGeneration(job.root, 'generated')).status, 'semantic_failed');
  assert.equal(speechCalls, 0);
  await generateBatch(job.root, { ...job.options, preflight: async () => { speechCalls++; } });
  assert.equal(modelCalls, 1);
  assert.equal(speechCalls, 1);
});

test('changed history during semantic judgment stops before TTS and requires a fresh comparison', async t => {
  const job = await fixture(t);
  let speechCalls = 0;
  await assert.rejects(generateBatch(job.root, { ...job.options, provider: async () => proposal(),
    noveltyCheck: async ({ entries }) => {
      await addPlans(job.root, 'sample', [{ id: 'concurrent', title: '새 초안', topicKey: 'queue.new', objective: '새 목표', angle: '새 예시', references: [] }]);
      return semanticResult(entries);
    }, preflight: async () => { speechCalls++; },
  }), error => error.code === 'SEMANTIC_HISTORY_CHANGED');
  assert.equal(speechCalls, 0);
  assert.deepEqual(readCatalog(job.root).batches, {});
  let historySeen;
  await generateBatch(job.root, { ...job.options, noveltyCheck: async context => {
    historySeen = context.history;
    return exactNovelty(context);
  } });
  assert.equal(historySeen[0].id, 'concurrent');
});

test('a catalog race during speech cannot publish a stale semantic pass; resume rechecks fresh history', async t => {
  const job = await fixture(t);
  let modelCalls = 0;
  await assert.rejects(generateBatch(job.root, { ...job.options,
    provider: async () => { modelCalls++; return proposal(); },
    preflight: async () => addPlans(job.root, 'sample', [{ id: 'newer', title: '새 계획', topicKey: 'queue.other', objective: '별도 학습', angle: '비교', references: [] }]),
  }), error => error.code === 'SEMANTIC_HISTORY_CHANGED');
  assert.deepEqual(readCatalog(job.root).batches, {});
  assert.equal((await inspectGeneration(job.root, 'generated')).status, 'commit_failed');
  await generateBatch(job.root, job.options);
  assert.equal(modelCalls, 1);
});

test('invalid semantic reports fail closed before synthesis and a new gate is mandatory', async t => {
  const job = await fixture(t);
  let calls = 0;
  let speech = 0;
  await assert.rejects(generateBatch(job.root, { ...job.options, noveltyCheck: undefined,
    provider: async () => { calls++; return proposal(); },
  }), /semantic novelty check is required/);
  assert.equal(calls, 0);
  await assert.rejects(generateBatch(job.root, { ...job.options, provider: async () => proposal(),
    noveltyCheck: async ({ entries }) => ({ ...await semanticResult(entries), profiles: [] }),
    preflight: async () => { speech++; },
  }), /one knowledge profile/);
  assert.equal(speech, 0);
});

test('malformed replacement count never replaces a retained episode', async t => {
  const job = await fixture(t);
  const original = batchProposal('keep', 'replace');
  const replies = [original, batchProposal('illegal-retained-change', 'still-wrong'), proposal('replacement')];
  let calls = 0;
  let checks = 0;
  await generateBatch(job.root, { ...job.options, count: 2,
    provider: async () => replies[calls++],
    noveltyCheck: async ({ entries }) => semanticResult(entries, { duplicate: ++checks === 1 ? ['generated-02'] : [] }),
  });
  assert.equal(calls, 3);
  const state = await inspectGeneration(job.root, 'generated');
  const candidate = JSON.parse(fs.readFileSync(path.join(job.workDir, state.accepted.candidatePath)));
  assert.deepEqual(candidate.episodes[0], original.episodes[0]);
  assert.equal(candidate.episodes[1].topicKey, 'stack.replacement');
});

test('a timing repair after partial duplicate replacement still preserves every other episode', async t => {
  const job = await fixture(t);
  const initial = batchProposal('retained', 'duplicate');
  const responses = [initial, proposal('new-long'), proposal('new-short')];
  let modelCalls = 0;
  let gateCalls = 0;
  let speechCalls = 0;
  await generateBatch(job.root, { ...job.options, count: 2,
    provider: async ({ prompt }) => {
      if (modelCalls === 2) {
        assert.match(prompt, /timing/);
        assert.match(prompt, /32 seconds/);
      }
      return responses[modelCalls++];
    },
    noveltyCheck: async ({ entries }) => semanticResult(entries, { duplicate: ++gateCalls === 1 ? ['generated-02'] : [] }),
    preflight: async () => {
      if (++speechCalls === 1) throw Object.assign(new Error('Measured narration is 32 seconds.'), { planId: 'generated-02' });
    },
  });
  const state = await inspectGeneration(job.root, 'generated');
  assert.equal(modelCalls, 3);
  assert.equal(speechCalls, 2);
  assert.deepEqual(state.attempts[1].replacedPlanIds, ['generated-02']);
  assert.deepEqual(state.attempts[2].replacedPlanIds, ['generated-02']);
  const candidate = JSON.parse(fs.readFileSync(path.join(job.workDir, state.accepted.candidatePath)));
  assert.deepEqual(candidate.episodes[0], initial.episodes[0]);
});

test('unreadable current history stops instead of asking the content model to fix filesystem state', async t => {
  const job = await fixture(t);
  let calls = 0;
  let speech = 0;
  await assert.rejects(generateBatch(job.root, { ...job.options,
    provider: async () => {
      calls++;
      await addPlans(job.root, 'sample', [{ id: 'missing', title: '다른 내용', topicKey: 'missing', objective: '새 목표', angle: '새 예시', references: [], input: 'missing.json' }]);
      return proposal();
    }, preflight: async () => { speech++; },
  }), /could not be read/);
  assert.equal(calls, 1);
  assert.equal(speech, 0);
  assert.equal((await inspectGeneration(job.root, 'generated')).status, 'semantic_failed');
});

test('series settings changed during preflight are refused before publication', async t => {
  const job = await fixture(t);
  await assert.rejects(generateBatch(job.root, { ...job.options, provider: async () => proposal(),
    preflight: async () => {
      const catalog = readCatalog(job.root);
      catalog.series.sample.topics = ['변경된 주제'];
      fs.writeFileSync(path.join(job.root, 'planning/catalog.json'), JSON.stringify(catalog));
    },
  }), /Series settings changed/);
  assert.deepEqual(readCatalog(job.root).batches, {});
  assert.equal((await inspectGeneration(job.root, 'generated')).status, 'commit_failed');
});

test('malformed timing replacements preserve the timing repair intent on the next attempt', async t => {
  const job = await fixture(t);
  const initial = batchProposal('retain', 'length');
  const replies = [initial, batchProposal('extra', 'bad-count'), proposal('short-enough')];
  let calls = 0;
  let speech = 0;
  await generateBatch(job.root, { ...job.options, count: 2,
    provider: async ({ prompt }) => {
      if (calls > 0) assert.match(prompt, /"kind": "timing"/);
      return replies[calls++];
    },
    preflight: async () => {
      if (++speech === 1) throw Object.assign(new Error('Narration is 32 seconds.'), { planId: 'generated-02' });
    },
  });
  const state = await inspectGeneration(job.root, 'generated');
  const candidate = JSON.parse(fs.readFileSync(path.join(job.workDir, state.accepted.candidatePath)));
  assert.equal(calls, 3);
  assert.deepEqual(candidate.episodes[0], initial.episodes[0]);
});

async function contentFixture(t) {
  const job = await fixture(t);
  const sourceFile = path.join(job.root, 'stack-reference.md');
  fs.writeFileSync(sourceFile, 'Peek reads the top value without removing it.\nA stack uses last-in-first-out order.\n');
  const catalog = readCatalog(job.root);
  catalog.series.sample.contentReview = { mode: 'required', sources: [{ id: 'stack', title: 'Stack reference',
    path: 'stack-reference.md', url: 'https://example.test/stack' }] };
  fs.writeFileSync(path.join(job.root, 'planning', 'catalog.json'), JSON.stringify(catalog));
  job.series = catalog.series.sample;
  job.sourceFile = sourceFile;
  job.options.contentCheck = contentJudge();
  return job;
}

// This is a deterministic mock of model judgments, while exercising the real report validator,
// snapshots, source-quote checks and all generation/commit state transitions.
function contentJudge(decide = () => ({})) {
  return async context => {
    const { createContentChecker, collectUnits } = require('../content/checker.cjs');
    const { corrections = [], uncertain = [] } = decide(context);
    return createContentChecker({ provider: async () => ({
      units: collectUnits(context.entries).map(unit => {
        const verdict = uncertain.includes(unit.planId) ? 'uncertain' : corrections.includes(unit.planId) ? 'contradicted' : 'supported';
        return { unitId: unit.unitId, verdict, claim: unit.text,
          reason: verdict === 'contradicted' ? 'Fix the mistaken removal claim.' : 'Fixture source comparison.',
          evidence: verdict === 'uncertain' ? [] : [{ sourceId: 'stack', quote: 'Peek reads the top value without removing it.' }] };
      }),
      consistency: context.entries.map(entry => ({ planId: entry.plan.id, verdict: 'consistent', reason: 'Fixture screen and narration agree.' })),
    }) })(context);
  };
}

test('required content review grounds generation and passes after novelty but before synthesis', async t => {
  const job = await contentFixture(t);
  const order = [];
  await generateBatch(job.root, { ...job.options,
    provider: async ({ prompt }) => {
      order.push('generate');
      assert.match(prompt, /Peek reads the top value without removing it/);
      assert.doesNotMatch(prompt, /출처 검증은 이번 생성에 포함되지 않습니다/);
      return proposal();
    },
    noveltyCheck: async context => { order.push('novelty'); return exactNovelty(context); },
    contentCheck: async context => {
      order.push('content');
      assert.ok(context.entries[0].plan.knowledge.core);
      return contentJudge()(context);
    },
    preflight: async () => { order.push('speech'); },
  });
  assert.deepEqual(order, ['generate', 'novelty', 'content', 'speech']);
  const state = await inspectGeneration(job.root, 'generated');
  assert.equal(state.contentReport.status, 'passed');
  assert.equal(state.contentCandidateSha256, state.accepted.candidateSha256);
  assert.equal(state.contentSourceHash, state.contentReport.sourceHash);
  assert.ok(fs.existsSync(path.join(job.workDir, state.contentReportFile)));
  assert.equal(readCatalog(job.root).generations.generated.referencesVerified, true);
  assert.deepEqual(readCatalog(job.root).plans.sample['generated-01'].references, ['https://example.test/stack']);
});

test('required content gate cannot be omitted and unavailable sources stop before model or TTS calls', async t => {
  const job = await contentFixture(t);
  let calls = 0;
  let speech = 0;
  const options = { ...job.options, provider: async () => { calls++; return proposal(); }, preflight: async () => { speech++; } };
  await assert.rejects(generateBatch(job.root, { ...options, contentCheck: undefined }), /source-grounded content check is required/);
  assert.equal(calls, 0);
  fs.unlinkSync(job.sourceFile);
  await assert.rejects(generateBatch(job.root, options), /requires readable evidence sources/);
  assert.equal(calls, 0);
  assert.equal(speech, 0);
  const held = await inspectGeneration(job.root, 'generated');
  assert.equal(held.status, 'needs_review');
  assert.equal(held.attempts.length, 0);
  assert.equal(held.sourceIssues[0].sourceId, 'stack');
  assert.deepEqual(readCatalog(job.root).batches, {});
  fs.writeFileSync(job.sourceFile, 'Peek reads the top value without removing it.');
  await generateBatch(job.root, options);
  assert.equal(calls, 1);
  assert.equal(speech, 1);
});

test('content corrections replace only the failed slot and recheck novelty and content before synthesis', async t => {
  const job = await contentFixture(t);
  const initial = batchProposal('retained', 'wrong');
  const repaired = proposal('corrected');
  let generationCalls = 0;
  let noveltyCalls = 0;
  let contentCalls = 0;
  let speechCalls = 0;
  await generateBatch(job.root, { ...job.options, count: 2,
    provider: async ({ prompt }) => {
      if (generationCalls++) {
        assert.match(prompt, /"kind": "content"/);
        assert.match(prompt, /Fix the mistaken removal claim/);
        assert.match(prompt, /주제와 학습 목표를 유지/);
        return repaired;
      }
      return initial;
    },
    noveltyCheck: async context => { noveltyCalls++; return exactNovelty(context); },
    contentCheck: contentJudge(() => ({ corrections: ++contentCalls === 1 ? ['generated-02'] : [] })),
    preflight: async () => { speechCalls++; },
  });
  assert.equal(generationCalls, 2);
  assert.equal(noveltyCalls, 2);
  assert.equal(contentCalls, 2);
  assert.equal(speechCalls, 1);
  const state = await inspectGeneration(job.root, 'generated');
  const accepted = JSON.parse(fs.readFileSync(path.join(job.workDir, state.accepted.candidatePath)));
  assert.deepEqual(accepted.episodes[0], initial.episodes[0]);
  assert.deepEqual(accepted.episodes[1], repaired.episodes[0]);
  assert.deepEqual(state.attempts[1].replacedPlanIds, ['generated-02']);
});

test('uncertain content stays pending without synthesis and resumes from its candidate against current sources', async t => {
  const job = await contentFixture(t);
  let calls = 0;
  let speech = 0;
  await assert.rejects(generateBatch(job.root, { ...job.options,
    provider: async () => { calls++; return proposal(); },
    contentCheck: contentJudge(() => ({ uncertain: ['generated-01'] })),
    preflight: async () => { speech++; },
  }), /Content review needs human review/);
  const before = await inspectGeneration(job.root, 'generated');
  assert.equal(before.status, 'needs_review');
  assert.ok(before.reviewPending);
  assert.equal(speech, 0);
  assert.deepEqual(readCatalog(job.root).batches, {});
  fs.appendFileSync(job.sourceFile, '\nAdditional source clarification.');
  await generateBatch(job.root, { ...job.options,
    provider: async () => { throw new Error('Must reuse the candidate.'); }, preflight: async () => { speech++; },
  });
  const after = await inspectGeneration(job.root, 'generated');
  assert.equal(calls, 1);
  assert.equal(speech, 1);
  assert.equal(after.attempts.length, 1);
  assert.notEqual(after.contentSourceHash, before.contentSourceHash);
});

test('content checker failure preserves the candidate and resumes without content regeneration', async t => {
  const job = await contentFixture(t);
  let calls = 0;
  let speech = 0;
  await assert.rejects(generateBatch(job.root, { ...job.options,
    provider: async () => { calls++; return proposal(); },
    contentCheck: async () => { throw new Error('Content judge network unavailable.'); },
    preflight: async () => { speech++; },
  }), /judge network unavailable/);
  const state = await inspectGeneration(job.root, 'generated');
  assert.equal(state.status, 'content_failed');
  assert.ok(state.contentPending);
  assert.equal(speech, 0);
  await generateBatch(job.root, job.options);
  assert.equal(calls, 1);
  assert.equal((await inspectGeneration(job.root, 'generated')).attempts.length, 1);
});

test('sources changed during content review stop before speech and are checked fresh on resume', async t => {
  const job = await contentFixture(t);
  let speech = 0;
  await assert.rejects(generateBatch(job.root, { ...job.options,
    provider: async () => proposal(),
    contentCheck: async context => {
      const report = await contentJudge()(context);
      fs.appendFileSync(job.sourceFile, '\nA concurrent source edit.');
      return report;
    }, preflight: async () => { speech++; },
  }), error => error.code === 'CONTENT_SOURCES_CHANGED');
  assert.equal(speech, 0);
  assert.equal((await inspectGeneration(job.root, 'generated')).status, 'content_failed');
  await generateBatch(job.root, { ...job.options, preflight: async () => { speech++; } });
  assert.equal(speech, 1);
  assert.equal((await inspectGeneration(job.root, 'generated')).attempts.length, 1);
});

test('sources changed during synthesis cannot commit a stale content pass', async t => {
  const job = await contentFixture(t);
  await assert.rejects(generateBatch(job.root, { ...job.options,
    provider: async () => proposal(),
    preflight: async () => { fs.appendFileSync(job.sourceFile, '\nChanged during speech.'); },
  }), error => error.code === 'CONTENT_SOURCES_CHANGED');
  assert.deepEqual(readCatalog(job.root).batches, {});
  assert.equal((await inspectGeneration(job.root, 'generated')).status, 'commit_failed');
  await generateBatch(job.root, job.options);
  assert.equal((await inspectGeneration(job.root, 'generated')).attempts.length, 1);
});

test('a mismatched content report is rejected before synthesis', async t => {
  const job = await contentFixture(t);
  let speech = 0;
  await assert.rejects(generateBatch(job.root, { ...job.options,
    provider: async () => proposal(),
    contentCheck: async context => ({ ...await contentJudge()(context), entryHash: '0'.repeat(64) }),
    preflight: async () => { speech++; },
  }), /does not match the candidate/);
  assert.equal(speech, 0);
  assert.equal((await inspectGeneration(job.root, 'generated')).status, 'content_failed');
});

test('exhausted content corrections remain reviewable and preserve a bounded targeted retry', async t => {
  const job = await contentFixture(t);
  let speech = 0;
  await assert.rejects(generateBatch(job.root, { ...job.options, maxAttempts: 1,
    provider: async () => proposal('wrong'),
    contentCheck: contentJudge(() => ({ corrections: ['generated-01'] })),
    preflight: async () => { speech++; },
  }), /after 1 attempts/);
  const held = await inspectGeneration(job.root, 'generated');
  assert.equal(held.status, 'needs_review');
  assert.equal(held.repair.feedback.kind, 'content');
  assert.equal(speech, 0);
  let checks = 0;
  let calls = 0;
  await generateBatch(job.root, { ...job.options, maxAttempts: 1,
    provider: async ({ prompt }) => { calls++; assert.match(prompt, /"kind": "content"/); return proposal('fixed'); },
    contentCheck: contentJudge(() => ({ corrections: ++checks === 1 ? ['generated-01'] : [] })),
  });
  assert.equal(calls, 1);
  assert.equal(checks, 2);
});

test('timing changes recheck content and malformed content replacements retain repair intent', async t => {
  const job = await contentFixture(t);
  const initial = batchProposal('retained', 'repair');
  const replies = [initial, batchProposal('extra', 'bad-count'), proposal('fixed'), proposal('short')];
  let calls = 0;
  let checks = 0;
  let speech = 0;
  await generateBatch(job.root, { ...job.options, count: 2, maxAttempts: 4,
    provider: async ({ prompt }) => {
      if (calls === 1 || calls === 2) assert.match(prompt, /"kind": "content"/);
      if (calls === 3) assert.match(prompt, /"kind": "timing"/);
      return replies[calls++];
    },
    contentCheck: contentJudge(() => ({ corrections: ++checks === 1 ? ['generated-02'] : [] })),
    preflight: async () => {
      if (++speech === 1) throw Object.assign(new Error('Narration lasts 32 seconds.'), { planId: 'generated-02' });
    },
  });
  assert.equal(calls, 4);
  assert.equal(checks, 3);
  assert.equal(speech, 2);
  const state = await inspectGeneration(job.root, 'generated');
  const accepted = JSON.parse(fs.readFileSync(path.join(job.workDir, state.accepted.candidatePath)));
  assert.deepEqual(accepted.episodes[0], initial.episodes[0]);
});
