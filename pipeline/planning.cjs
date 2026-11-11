const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { lockWorkDir } = require('./run-state.cjs');

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must contain text.`);
  return value.trim();
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

function stringList(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new Error(`${label} must be an array.`);
  return value.map(item => text(item, label));
}

function relativeFile(root, value, label, mustExist = false) {
  const name = text(value, label);
  const absolute = path.resolve(root, name);
  const relative = path.relative(root, absolute);
  if (path.isAbsolute(name) || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
    throw new Error(`${label} must be a repository-relative file.`);
  }
  if (mustExist) {
    if (!fs.statSync(absolute).isFile()) throw new Error(`${label} must be a file.`);
    const actual = path.relative(fs.realpathSync(root), fs.realpathSync(absolute));
    if (path.isAbsolute(actual) || actual === '..' || actual.startsWith('..' + path.sep)) {
      throw new Error(`${label} resolves outside the repository.`);
    }
  }
  return relative.split(path.sep).join('/');
}

function timestamp(value, label) {
  const normalized = text(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(normalized);
  if (!match || !Number.isFinite(Date.parse(normalized))) throw new Error(`${label} requires an ISO date and time with a timezone.`);
  const [, year, month, day, hour, minute, second = '00', zone] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (calendar.getUTCDate() !== Number(day) || calendar.getUTCMonth() + 1 !== Number(month) ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== 'Z' && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4)) > 59 || (zone.slice(1, 3) === '14' && zone.slice(4) !== '00')))) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

function emptyCatalog() {
  return { version: 1, series: {}, plans: {}, episodes: {}, batches: {} };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function readCatalog(root) {
  let catalog;
  try { catalog = readJson(path.join(root, 'planning', 'catalog.json')); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyCatalog();
    throw error;
  }
  if (catalog?.version !== 1 || !['series', 'plans', 'episodes', 'batches'].every(key => object(catalog[key]))) {
    throw new Error('Unsupported planning catalog.');
  }
  return catalog;
}

function saveCatalog(root, catalog) {
  const directory = path.join(root, 'planning');
  const temporary = path.join(directory, `catalog-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(catalog, null, 2) + '\n');
    fs.renameSync(temporary, path.join(directory, 'catalog.json'));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

async function editCatalog(root, operation) {
  const directory = path.join(root, 'planning');
  fs.mkdirSync(directory, { recursive: true });
  const release = await lockWorkDir(directory, 'Planning catalog');
  try { return await operation(readCatalog(root)); }
  finally { await release(); }
}

function normalizeSeries(root, spec) {
  if (!object(spec)) throw new Error('A series specification must be an object.');
  const supported = ['id', 'name', 'audience', 'topics', 'defaultDurationSeconds', 'tone', 'adapter', 'renderProfile', 'contentReview', 'visualReview'];
  const unknown = Object.keys(spec).filter(key => !supported.includes(key));
  if (unknown.length) throw new Error('Unsupported series field: ' + unknown.join(', '));
  if (!Number.isFinite(spec.defaultDurationSeconds) || spec.defaultDurationSeconds <= 0) throw new Error('A positive defaultDurationSeconds is required.');
  if (spec.renderProfile !== undefined && !object(spec.renderProfile)) throw new Error('renderProfile must be an object.');
  const visualReview = spec.visualReview === undefined ? undefined : require('./visual/policy.cjs').normalizeVisualReview(spec.visualReview);
  if (visualReview?.mode === 'required' && spec.adapter?.replaceAll('\\', '/') !== 'pipeline/story/adapter.cjs') {
    throw new Error('Visual review currently supports pipeline/story/adapter.cjs only.');
  }
  if (spec.contentReview?.mode === 'required' && spec.adapter?.replaceAll('\\', '/') !== 'pipeline/story/adapter.cjs') {
    throw new Error('Required content review currently supports pipeline/story/adapter.cjs only.');
  }
  return {
    id: identifier(spec.id, 'series ID'), name: text(spec.name, 'Series name'),
    audience: text(spec.audience, 'Audience'), topics: stringList(spec.topics, 'Topics'),
    defaultDurationSeconds: spec.defaultDurationSeconds, tone: text(spec.tone, 'Tone'),
    adapter: relativeFile(root, spec.adapter, 'Adapter', true),
    ...(spec.renderProfile === undefined ? {} : { renderProfile: spec.renderProfile }),
    ...(spec.contentReview === undefined ? {} : { contentReview: require('./content/sources.cjs').normalizeContentReview(spec.contentReview) }),
    ...(visualReview === undefined ? {} : { visualReview }),
  };
}

function normalizePlan(root, seriesId, plan) {
  if (!object(plan)) throw new Error('A plan must be an object.');
  if (plan.seriesId !== undefined && plan.seriesId !== seriesId) throw new Error('Plan seriesId does not match.');
  return {
    id: identifier(plan.id, 'plan ID'), seriesId,
    title: text(plan.title, 'Plan title'), topicKey: text(plan.topicKey, 'Topic key'),
    objective: text(plan.objective, 'Objective'), angle: text(plan.angle, 'Explanation angle'),
    references: stringList(plan.references, 'References', true),
    ...(plan.knowledge === undefined ? {} : { knowledge: normalizeKnowledge(plan.knowledge) }),
    ...(plan.input !== undefined ? { input: relativeFile(root, plan.input, 'Production input') } : {}),
    ...(plan.scheduledFor !== undefined ? { scheduledFor: timestamp(plan.scheduledFor, 'scheduledFor') } : {}),
    ...(plan.publishedAt !== undefined ? { publishedAt: timestamp(plan.publishedAt, 'publishedAt') } : {}),
  };
}

function normalizeKnowledge(value) {
  if (!object(value) || Object.keys(value).some(key => !['core', 'example'].includes(key))) throw new Error('Knowledge must contain only core and example.');
  const result = {};
  for (const key of ['core', 'example']) {
    const content = text(value[key], `Knowledge ${key}`);
    if (content.length > 1000 || /[\x00-\x08\x0b-\x1f]/.test(content)) throw new Error(`Knowledge ${key} must be readable text within 1000 characters.`);
    result[key] = content;
  }
  return result;
}

async function registerSeries(root, spec, { listVoices, onPreflight } = {}) {
  // Do not let caller mutation during the asynchronous environment check
  // publish a different specification from the one that was inspected.
  const requested = structuredClone(spec);
  const report = await require('./series/preflight.cjs').checkSeries(root, requested, { listVoices });
  const series = report.normalized;
  if (report.canRegister) {
    try {
      const adapter = require(path.resolve(root, series.adapter));
      if (typeof adapter.createStages !== 'function') throw new Error('The adapter must export createStages.');
    } catch (error) {
      report.errors.push({ code: 'ADAPTER_LOAD_FAILED', field: 'adapter', message: error.message });
      report.status = 'failed'; report.canRegister = false;
    }
  }
  onPreflight?.(report);
  if (!report.canRegister) throw Object.assign(new Error('Series preflight failed: ' + report.errors.map(item => `${item.field}: ${item.message}`).join('; ')), {
    code: 'SERIES_PREFLIGHT_FAILED', report,
  });
  return editCatalog(root, catalog => {
    // Recheck local paths/evidence after the asynchronous probe and before
    // committing. Later production retains its own evidence freshness gate.
    normalizeSeries(root, requested);
    if (series.contentReview?.mode === 'required') {
      const fresh = require('./content/sources.cjs').readEvidenceBundle(root, series);
      if (fresh.status !== 'ready' || fresh.sourceHash !== report.evidence?.sourceHash) {
        throw Object.assign(new Error('Evidence changed after the registration preflight. Check the series again.'), { code: 'SERIES_PREFLIGHT_CHANGED' });
      }
    }
    if (Object.hasOwn(catalog.series, series.id)) {
      if (JSON.stringify(catalog.series[series.id]) !== JSON.stringify(series)) throw new Error('Series ID already exists with different settings: ' + series.id);
      return catalog;
    }
    catalog.series[series.id] = series;
    catalog.plans[series.id] = {};
    saveCatalog(root, catalog);
    return catalog;
  });
}

async function configureContentReview(root, seriesId, policy) {
  identifier(seriesId, 'series ID');
  const normalized = require('./content/sources.cjs').normalizeContentReview(policy);
  return editCatalog(root, catalog => {
    if (!Object.hasOwn(catalog.series, seriesId)) throw new Error('Unknown series: ' + seriesId);
    if (normalized.mode === 'required' && catalog.series[seriesId].adapter !== 'pipeline/story/adapter.cjs') {
      throw new Error('Required content review currently supports pipeline/story/adapter.cjs only.');
    }
    catalog.series[seriesId].contentReview = normalized;
    saveCatalog(root, catalog);
    return catalog;
  });
}

async function configureVisualReview(root, seriesId, policy) {
  identifier(seriesId, 'series ID');
  if (!object(policy)) throw new Error('A visual review policy object is required.');
  const visualReview = require('./visual/policy.cjs').normalizeVisualReview(policy);
  return editCatalog(root, catalog => {
    if (!Object.hasOwn(catalog.series, seriesId)) throw new Error('Unknown series: ' + seriesId);
    if (visualReview.mode === 'required' && catalog.series[seriesId].adapter !== 'pipeline/story/adapter.cjs') {
      throw new Error('Visual review currently supports pipeline/story/adapter.cjs only.');
    }
    catalog.series[seriesId].visualReview = visualReview;
    saveCatalog(root, catalog);
    return catalog;
  });
}

async function storePlans(root, seriesId, plans, update) {
  identifier(seriesId, 'series ID');
  if (!Array.isArray(plans) || !plans.length) throw new Error('Provide at least one plan.');
  const normalized = plans.map(plan => normalizePlan(root, seriesId, plan));
  if (new Set(normalized.map(plan => plan.id)).size !== normalized.length) throw new Error('Duplicate plan IDs in this request.');
  return editCatalog(root, catalog => {
    if (!Object.hasOwn(catalog.series, seriesId)) throw new Error('Unknown series: ' + seriesId);
    const seriesPlans = catalog.plans[seriesId] || {};
    const materialized = materializedPlanIds(catalog, seriesId);
    for (const plan of normalized) {
      validatePeriodPlan(catalog, seriesId, plan);
      if (update && !Object.hasOwn(seriesPlans, plan.id)) throw new Error('Unknown plan: ' + plan.id);
      if (update && (materialized.has(plan.id) || seriesPlans[plan.id].publishedAt)) {
        throw new Error('A materialized or published plan cannot be updated: ' + plan.id);
      }
      if (!update && Object.hasOwn(seriesPlans, plan.id) && JSON.stringify(seriesPlans[plan.id]) !== JSON.stringify(plan)) {
        throw new Error('Plan ID already exists with different content: ' + plan.id);
      }
      seriesPlans[plan.id] = plan;
    }
    catalog.plans[seriesId] = seriesPlans;
    saveCatalog(root, catalog);
    return catalog;
  });
}

async function addPlans(root, seriesId, plans) {
  return storePlans(root, seriesId, plans, false);
}

async function updatePlans(root, seriesId, plans) {
  return storePlans(root, seriesId, plans, true);
}

function normalizedTopic(value) {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

function duplicateGroups(catalog, seriesId) {
  const topics = new Map();
  for (const [id, plan] of Object.entries(catalog.plans[seriesId] || {})) {
    const key = normalizedTopic(plan.topicKey);
    if (!topics.has(key)) topics.set(key, []);
    topics.get(key).push(id);
  }
  return [...topics].filter(([, ids]) => ids.length > 1).map(([topicKey, planIds]) => ({ topicKey, planIds }));
}

function checkDuplicates(root, seriesId) {
  const catalog = readCatalog(root);
  if (!Object.hasOwn(catalog.series, seriesId)) throw new Error('Unknown series: ' + seriesId);
  return duplicateGroups(catalog, seriesId);
}

function legacyRegistry(root, name) {
  try { return readJson(path.join(root, 'pipeline', name + '.json')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

function materializedPlanIds(catalog, seriesId) {
  return new Set(Object.values(catalog.episodes).filter(episode => episode.seriesId === seriesId).map(episode => episode.planId));
}

// Period reservations share the catalog lock with ordinary planning commands.
// This prevents another command from taking a reserved plan or posting time.
function periodReservations(catalog, seriesId) {
  return Object.values(catalog.periods || {}).filter(period => period.seriesId === seriesId)
    .flatMap(period => period.slots.map(slot => ({ ...slot, periodId: period.id })));
}

function validatePeriodPlan(catalog, seriesId, plan) {
  for (const slot of periodReservations(catalog, seriesId)) {
    if (slot.planId === plan.id) {
      if (plan.publishedAt || (plan.scheduledFor && Date.parse(plan.scheduledFor) !== Date.parse(slot.scheduledFor))) {
        throw new Error('Plan belongs to a reserved period slot: ' + plan.id);
      }
    } else if (plan.scheduledFor && Date.parse(plan.scheduledFor) === Date.parse(slot.scheduledFor)) {
      throw new Error('Posting time belongs to a reserved period slot: ' + slot.scheduledFor);
    }
  }
}

function validatePeriodBatch(catalog, seriesId, batchId, planIds, generated = false) {
  for (const period of Object.values(catalog.periods || {})) {
    for (const group of period.groups) {
      if (group.id === batchId && (period.seriesId !== seriesId ||
          group.slotIds.length !== planIds.length ||
          (group.planIds && (generated || JSON.stringify(group.planIds) !== JSON.stringify(planIds))) ||
          (!group.planIds && !generated))) {
        throw new Error('Batch does not match its period reservation: ' + batchId);
      }
    }
  }
  for (const slot of periodReservations(catalog, seriesId)) {
    if (slot.planId && planIds.includes(slot.planId) && slot.batchId !== batchId) {
      throw new Error('Plan belongs to another period batch: ' + slot.planId);
    }
  }
}

function choosePlans(catalog, seriesId, options, existingBatch) {
  const explicit = options.planIds !== undefined;
  if (explicit === (options.count !== undefined)) throw new Error('Choose planIds or count.');
  if (explicit) {
    if (!Array.isArray(options.planIds) || !options.planIds.length) throw new Error('Choose at least one plan.');
    options.planIds.forEach(id => identifier(id, 'plan ID'));
    if (new Set(options.planIds).size !== options.planIds.length) throw new Error('Duplicate selected plan IDs.');
    return options.planIds;
  }
  if (!Number.isSafeInteger(options.count) || options.count < 1) throw new Error('count must be a positive integer.');
  if (existingBatch) {
    if (existingBatch.length !== options.count) throw new Error('Batch ID already exists with a different selection.');
    return existingBatch.map(id => catalog.episodes[id].planId);
  }
  const used = materializedPlanIds(catalog, seriesId);
  const reserved = new Set(periodReservations(catalog, seriesId).map(slot => slot.planId));
  const candidates = Object.values(catalog.plans[seriesId] || {}).filter(plan => plan.input && !plan.publishedAt && !used.has(plan.id) && !reserved.has(plan.id));
  if (candidates.length < options.count) throw new Error(`Need ${options.count} input-ready unproduced plans; found ${candidates.length}.`);
  return candidates.slice(0, options.count).map(plan => plan.id);
}

async function createBatchFromPlans(root, seriesId, batchId, options = {}) {
  identifier(seriesId, 'series ID');
  identifier(batchId, 'batch ID');
  return editCatalog(root, async catalog => {
    const series = catalog.series[seriesId];
    if (!Object.hasOwn(catalog.series, seriesId)) throw new Error('Unknown series: ' + seriesId);
    const legacyEpisodes = legacyRegistry(root, 'episodes');
    const legacyBatches = legacyRegistry(root, 'batches');
    if (Object.hasOwn(legacyBatches, batchId)) throw new Error('Batch ID already belongs to a legacy batch: ' + batchId);
    const existing = Object.hasOwn(catalog.batches, batchId) ? catalog.batches[batchId] : null;
    const planIds = choosePlans(catalog, seriesId, options, existing);
    validatePeriodBatch(catalog, seriesId, batchId, planIds);
    const seriesPlans = catalog.plans[seriesId] || {};
    const plans = planIds.map(id => {
      if (!Object.hasOwn(seriesPlans, id) || seriesPlans[id].seriesId !== seriesId) throw new Error('Unknown plan in this series: ' + id);
      return seriesPlans[id];
    });
    const episodeIds = plans.map(plan => `${seriesId}-${plan.id}`);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(episodeIds)) throw new Error('Batch ID already exists with a different selection.');
      return { batchId, episodeIds, reused: true };
    }
    const duplicates = duplicateGroups(catalog, seriesId).filter(group => group.planIds.some(id => planIds.includes(id)));
    if (duplicates.length) throw new Error('Duplicate topic keys in selected plans: ' + duplicates.map(group => `${group.topicKey} (${group.planIds.join(', ')})`).join('; '));
    const used = materializedPlanIds(catalog, seriesId);
    for (const [i, plan] of plans.entries()) {
      if (used.has(plan.id) || plan.publishedAt) throw new Error('Plan is already materialized or published: ' + plan.id);
      if (!plan.input) throw new Error('Plan needs a production input JSON: ' + plan.id);
      if (Object.hasOwn(catalog.episodes, episodeIds[i]) || Object.hasOwn(legacyEpisodes, episodeIds[i])) throw new Error('Episode ID already exists: ' + episodeIds[i]);
    }
    const adapterFile = path.resolve(root, relativeFile(root, series.adapter, 'Adapter', true));
    const adapter = require(adapterFile);
    if (typeof adapter.createStages !== 'function') throw new Error('The adapter must export createStages.');
    const snapshots = plans.map(plan => {
      const source = readJson(path.resolve(root, relativeFile(root, plan.input, 'Production input', true)));
      if (!object(source)) throw new Error('Production input must be a JSON object: ' + plan.id);
      return { title: plan.title, audience: series.audience, tone: series.tone, durationSeconds: series.defaultDurationSeconds,
        ...(series.renderProfile === undefined ? {} : { profile: series.renderProfile }), ...source };
    });
    const created = [];
    try {
      fs.mkdirSync(path.join(root, 'planning', 'inputs'), { recursive: true });
      for (const [i, plan] of plans.entries()) {
        const input = `planning/inputs/${episodeIds[i]}-${randomUUID()}.json`;
        const file = path.join(root, input);
        fs.writeFileSync(file, JSON.stringify(snapshots[i], null, 2) + '\n', { flag: 'wx' });
        created.push(file);
        const stages = adapter.createStages({ root, sampleDir: path.dirname(adapterFile), episodeFile: file, tools: {} });
        if (!Array.isArray(stages) || !stages.length || stages.some(stage => !stage?.id || typeof stage.inputs !== 'function' || typeof stage.run !== 'function' || !Array.isArray(stage.outputs))) {
          throw new Error('The adapter returned invalid production stages: ' + plan.id);
        }
        catalog.episodes[episodeIds[i]] = { adapter: series.adapter, episode: input, seriesId, planId: plan.id,
          topicKey: plan.topicKey, ...(plan.scheduledFor ? { scheduledFor: plan.scheduledFor } : {}) };
      }
      catalog.batches[batchId] = episodeIds;
      saveCatalog(root, catalog);
    } catch (error) {
      // A failed preparation never publishes half a batch. Only files from this attempt are removed.
      for (const file of created) fs.unlinkSync(file);
      throw error;
    }
    return { batchId, episodeIds, reused: false };
  });
}

// A generated batch becomes visible only after every input passes adapter validation.
// The catalog lock also rechecks history changed during the (potentially long) model call.
async function commitGeneratedBatch(root, seriesId, batchId, entries, { requestKey, expectedHistoryHash, noveltyReport, expectedSourceHash, contentReport } = {}) {
  identifier(seriesId, 'series ID');
  identifier(batchId, 'batch ID');
  if (!/^[a-f0-9]{64}$/.test(requestKey || '')) throw new Error('A generation request key is required.');
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 10) throw new Error('Generate 1–10 episodes per batch.');
  if (expectedHistoryHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedHistoryHash)) throw new Error('A valid expected history hash is required.');
  if (noveltyReport !== undefined && expectedHistoryHash === undefined) throw new Error('Semantic publication requires an expected history hash.');
  return editCatalog(root, catalog => {
    validatePeriodBatch(catalog, seriesId, batchId, entries.map(entry => entry.plan.id), true);
    const existing = catalog.generations?.[batchId];
    if (existing) {
      if (existing.seriesId !== seriesId || existing.requestKey !== requestKey) throw new Error('Generation batch ID belongs to a different request.');
      if (JSON.stringify(existing.episodeIds) !== JSON.stringify(catalog.batches[batchId])) throw new Error('Generated batch catalog is inconsistent.');
      return { batchId, episodeIds: existing.episodeIds, reused: true };
    }
    if (!Object.hasOwn(catalog.series, seriesId)) throw new Error('Unknown series: ' + seriesId);
    function verifyHistory(snapshot) {
      if (expectedHistoryHash === undefined) return;
      const current = require('./novelty/history.cjs').readSeriesHistory(root, snapshot, seriesId);
      if (current.historyHash !== expectedHistoryHash) {
        const error = new Error('Series history changed after semantic validation; compare the candidate against current history again.');
        error.code = 'SEMANTIC_HISTORY_CHANGED';
        throw error;
      }
    }
    verifyHistory(catalog);
    const series = catalog.series[seriesId];
    const contentRequired = series.contentReview?.mode === 'required';
    let evidenceBundle;
    function verifySources() {
      if (!contentRequired && contentReport === undefined) return;
      evidenceBundle = require('./content/sources.cjs').readEvidenceBundle(root, series);
      if (!/^[a-f0-9]{64}$/.test(expectedSourceHash || '') || evidenceBundle.status !== 'ready' || evidenceBundle.sourceHash !== expectedSourceHash) {
        throw Object.assign(new Error('Evidence sources changed or are unavailable; review the candidate against current sources again.'), { code: 'CONTENT_SOURCES_CHANGED' });
      }
    }
    verifySources();
    let content;
    if (contentRequired || contentReport !== undefined) {
      if (!contentReport || contentReport.status !== 'passed') throw new Error('A passed content report is required before publication.');
      require('./content/checker.cjs').validateContentReport(contentReport, entries, evidenceBundle);
      const reportPath = relativeFile(root, path.relative(root, path.resolve(root, contentReport.reportPath)), 'Content report', true);
      content = { status: 'passed', sourceHash: expectedSourceHash, entryHash: contentReport.entryHash,
        reportPath, reportHash: createHash('sha256').update(JSON.stringify(contentReport)).digest('hex'),
        sources: contentReport.sources, checkedAt: contentReport.createdAt };
    }
    if (series.adapter !== 'pipeline/story/adapter.cjs') throw new Error('Automatic generation requires pipeline/story/adapter.cjs.');
    if (Object.hasOwn(catalog.batches, batchId) || Object.hasOwn(legacyRegistry(root, 'batches'), batchId)) {
      throw new Error('Batch ID already exists: ' + batchId);
    }
    const { validateSpec, normalizeProfile } = require('./story/spec.cjs');
    const adapterFile = path.resolve(root, relativeFile(root, series.adapter, 'Adapter', true));
    const adapter = require(adapterFile);
    const normalized = entries.map(entry => {
      const referencedIds = new Set((contentReport?.units || []).filter(unit => unit.planId === entry.plan.id)
        .flatMap(unit => (unit.evidence || []).map(evidence => evidence.sourceId)));
      const references = content ? evidenceBundle.sources.filter(source => referencedIds.has(source.id)).map(source => source.url || source.path) : entry.plan.references;
      const plan = normalizePlan(root, seriesId, { ...entry.plan, references });
      if (plan.input || plan.scheduledFor || plan.publishedAt) throw new Error('Generated plans cannot set paths or publishing metadata.');
      const story = validateSpec(entry.story);
      if (story.title !== plan.title || story.durationSeconds !== series.defaultDurationSeconds ||
          JSON.stringify(story.profile) !== JSON.stringify(normalizeProfile(series.renderProfile))) {
        throw new Error('Generated story must use the plan title and series production settings.');
      }
      return { plan, story };
    });
    let novelty;
    if (noveltyReport !== undefined) {
      if (!object(noveltyReport) || noveltyReport.status !== 'passed' ||
          !Array.isArray(noveltyReport.duplicatePlanIds) || noveltyReport.duplicatePlanIds.length ||
          !Array.isArray(noveltyReport.reviewPlanIds) || noveltyReport.reviewPlanIds.length ||
          !Array.isArray(noveltyReport.profiles) || noveltyReport.profiles.length !== normalized.length ||
          !Array.isArray(noveltyReport.comparisons)) throw new Error('A passed semantic report is required before publication.');
      const profiles = new Map();
      for (const profile of noveltyReport.profiles) {
        if (!object(profile) || typeof profile.planId !== 'string' || profiles.has(profile.planId)) throw new Error('Invalid semantic profile IDs.');
        profiles.set(profile.planId, normalizeKnowledge(profile.knowledge));
      }
      for (const { plan } of normalized) {
        if (!profiles.has(plan.id) || JSON.stringify(plan.knowledge) !== JSON.stringify(profiles.get(plan.id))) {
          throw new Error('Semantic profiles must match the generated plans and knowledge.');
        }
      }
      for (const comparison of noveltyReport.comparisons) {
        if (!object(comparison) || !profiles.has(comparison.candidateId) || comparison.verdict !== 'distinct') {
          throw new Error('Semantic publication requires distinct comparisons for the generated plans.');
        }
      }
      let reportPath;
      if (noveltyReport.reportPath !== undefined) {
        const absolute = path.resolve(root, noveltyReport.reportPath);
        reportPath = relativeFile(root, path.relative(root, absolute), 'Semantic report', true);
      }
      novelty = { status: 'passed', historyHash: expectedHistoryHash,
        planIds: normalized.map(({ plan }) => plan.id), comparisonCount: noveltyReport.comparisons.length,
        reportHash: createHash('sha256').update(JSON.stringify(noveltyReport)).digest('hex'),
        ...(typeof noveltyReport.inputHash === 'string' && /^[a-f0-9]{64}$/.test(noveltyReport.inputHash) ? { inputHash: noveltyReport.inputHash } : {}),
        ...(reportPath ? { reportPath } : {}) };
    }
    const previous = Object.values(catalog.plans[seriesId] || {});
    const seen = Object.fromEntries(['topicKey', 'title', 'objective'].map(key => [key, new Set(previous.map(plan => normalizedTopic(plan[key])))]));
    const usedIds = new Set(Object.keys(catalog.plans[seriesId] || {}));
    const legacyEpisodes = legacyRegistry(root, 'episodes');
    const episodeIds = normalized.map(({ plan }) => {
      if (usedIds.has(plan.id)) throw new Error('Generated plan ID already exists: ' + plan.id);
      usedIds.add(plan.id);
      for (const key of Object.keys(seen)) {
        const value = normalizedTopic(plan[key]);
        if (seen[key].has(value)) throw new Error(`Generated ${key} duplicates current history: ${plan[key]}`);
        seen[key].add(value);
      }
      const id = `${seriesId}-${plan.id}`;
      if (Object.hasOwn(catalog.episodes, id) || Object.hasOwn(legacyEpisodes, id)) throw new Error('Episode ID already exists: ' + id);
      return id;
    });
    const created = [];
    try {
      fs.mkdirSync(path.join(root, 'planning', 'inputs'), { recursive: true });
      catalog.plans[seriesId] ||= {};
      for (const [i, { plan, story }] of normalized.entries()) {
        const input = `planning/inputs/${episodeIds[i]}-${randomUUID()}.json`;
        const file = path.join(root, input);
        fs.writeFileSync(file, JSON.stringify({ audience: series.audience, tone: series.tone, ...story }, null, 2) + '\n', { flag: 'wx' });
        created.push(file);
        const stages = adapter.createStages({ root, sampleDir: path.dirname(adapterFile), episodeFile: file, tools: {} });
        if (!Array.isArray(stages) || !stages.length || stages.some(stage => !stage?.id || typeof stage.inputs !== 'function' || typeof stage.run !== 'function' || !Array.isArray(stage.outputs))) {
          throw new Error('The adapter returned invalid production stages: ' + plan.id);
        }
        catalog.plans[seriesId][plan.id] = { ...plan, input };
        catalog.episodes[episodeIds[i]] = { adapter: series.adapter, episode: input, seriesId, planId: plan.id, topicKey: plan.topicKey };
      }
      catalog.batches[batchId] = episodeIds;
      catalog.generations ||= {};
      catalog.generations[batchId] = { seriesId, requestKey, episodeIds, createdAt: new Date().toISOString(),
        contentHash: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'), referencesVerified: Boolean(content),
        ...(novelty ? { novelty } : {}), ...(content ? { contentReview: content } : {}) };
      // Review revisions can update existing input files without touching this catalog lock.
      // Check the published history again after adapter preparation, before exposing new plans.
      if (expectedHistoryHash !== undefined) verifyHistory(readCatalog(root));
      verifySources();
      saveCatalog(root, catalog);
    } catch (error) {
      for (const file of created) fs.unlinkSync(file);
      throw error;
    }
    return { batchId, episodeIds, reused: false };
  });
}

module.exports = { readCatalog, normalizeSeries, registerSeries, configureContentReview, configureVisualReview, addPlans, updatePlans, checkDuplicates, createBatchFromPlans, commitGeneratedBatch,
  editCatalog, saveCatalog };
