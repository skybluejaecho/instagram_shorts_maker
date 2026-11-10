const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readable(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must contain text.`);
  return value.trim();
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function productionInput(root, name, planId) {
  const label = `History input for ${planId}`;
  if (typeof name !== 'string' || !name.trim() || path.isAbsolute(name)) throw new Error(`${label} must be repository-relative.`);
  const file = path.resolve(root, name);
  if (!within(root, file)) throw new Error(`${label} is outside the repository.`);
  try {
    if (!fs.statSync(file).isFile()) throw new Error(`${label} must be a file.`);
    if (!within(fs.realpathSync(root), fs.realpathSync(file))) throw new Error(`${label} resolves outside the repository.`);
    const bytes = fs.readFileSync(file);
    const source = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (!object(source)) throw new Error(`${label} must contain a JSON object.`);
    let narration;
    if (source.narration !== undefined) {
      if (!Array.isArray(source.narration)) throw new Error(`${label} narration must be an array.`);
      narration = source.narration.map((cue, index) => {
        if (typeof cue === 'string') return { text: readable(cue, `${label} cue ${index}`) };
        if (!object(cue)) throw new Error(`${label} has an invalid narration cue.`);
        return { ...(cue.id === undefined ? {} : { id: readable(cue.id, `${label} cue ID`) }),
          text: readable(cue.text, `${label} cue ${index}`) };
      });
    } else if (source.beats !== undefined) {
      if (!Array.isArray(source.beats)) throw new Error(`${label} beats must be an array.`);
      narration = source.beats.map((beat, index) => {
        if (!object(beat)) throw new Error(`${label} has an invalid beat.`);
        return { ...(beat.id === undefined ? {} : { id: readable(beat.id, `${label} beat ID`) }),
          text: readable(beat.narration, `${label} beat ${index}`) };
      });
    }
    return { contentHash: hash(bytes), ...(narration === undefined ? {} : { narration }) };
  } catch (error) {
    throw new Error(`${label} could not be read: ${error.message}`, { cause: error });
  }
}

// A complete snapshot is compared again under the catalog lock at publication time.
// Materialized inputs are authoritative because review revisions update those files.
function readSeriesHistory(root, catalog, seriesId) {
  const base = fs.realpathSync(root);
  if (!object(catalog?.series) || !Object.hasOwn(catalog.series, seriesId)) throw new Error('Unknown series: ' + seriesId);
  const plans = catalog.plans?.[seriesId] || {};
  if (!object(plans) || !object(catalog.episodes)) throw new Error('Invalid series history catalog.');
  const history = Object.entries(plans).map(([id, plan]) => {
    if (!object(plan) || plan.id !== id || (plan.seriesId !== undefined && plan.seriesId !== seriesId)) {
      throw new Error('Invalid plan identity in series history: ' + id);
    }
    const entry = { id,
      title: readable(plan.title, 'History title'), topicKey: readable(plan.topicKey, 'History topic key'),
      objective: readable(plan.objective, 'History objective'), angle: readable(plan.angle, 'History angle'),
    };
    if (plan.knowledge !== undefined) {
      if (!object(plan.knowledge) || Object.keys(plan.knowledge).some(key => !['core', 'example'].includes(key))) {
        throw new Error('Invalid knowledge metadata in history: ' + id);
      }
      entry.knowledge = { core: readable(plan.knowledge.core, 'Core knowledge'), example: readable(plan.knowledge.example, 'Knowledge example') };
    }
    if (plan.scheduledFor !== undefined) entry.scheduledFor = readable(plan.scheduledFor, 'Scheduled timestamp');
    if (plan.publishedAt !== undefined) entry.publishedAt = readable(plan.publishedAt, 'Published timestamp');
    const materialized = Object.values(catalog.episodes).filter(episode => episode?.seriesId === seriesId && episode.planId === id);
    if (materialized.length > 1) throw new Error('Multiple materialized inputs exist for history plan: ' + id);
    const input = materialized.length ? materialized[0].episode : plan.input;
    if (materialized.length || input !== undefined) Object.assign(entry, productionInput(base, input, id));
    return entry;
  });
  return { history, historyHash: hash(JSON.stringify(history)) };
}

module.exports = { readSeriesHistory };
