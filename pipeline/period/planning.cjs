const fs = require('node:fs');
const path = require('node:path');
const { readCatalog, editCatalog, saveCatalog } = require('../planning.cjs');

const fields = ['id', 'seriesId', 'startDate', 'days', 'timezone', 'times', 'weekdays', 'batchSize', 'planIds'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameInstant = (a, b) => Date.parse(a) === Date.parse(b);

function identifier(value, label, max = 48) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(value) || value.length > max ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}

function calendarDate(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) throw new Error('startDate requires a YYYY-MM-DD calendar date (year 1000–9999).');
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Invalid calendar date: ' + value);
  return date;
}

function formatter(timezone) {
  if (typeof timezone !== 'string' || !timezone.trim()) throw new Error('timezone must be an IANA timezone name.');
  try {
    const result = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    // Offset-only timezone identifiers provide no calendar/DST rules.
    if (/^[+-]/.test(result.resolvedOptions().timeZone)) throw new Error('Offset-only timezone');
    return result;
  } catch { throw new Error('Unknown IANA timezone: ' + timezone); }
}

function dateParts(format, milliseconds) {
  return Object.fromEntries(format.formatToParts(new Date(milliseconds)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function localInstant(date, time, format) {
  const nominal = Date.parse(`${date}T${time}:00Z`);
  const offsets = new Set();
  // Probe both sides of timezone transitions, including half-hour shifts and
  // skipped calendar days, then require an exact wall-clock round trip.
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = nominal + hours * 3600000;
    const part = dateParts(format, instant);
    offsets.add(Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) - instant);
  }
  const target = `${date}T${time}`;
  const matches = [...offsets].map(offset => nominal - offset).filter(instant => {
    const p = dateParts(format, instant);
    const wall = `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    return wall === target && p.second === 0;
  });
  if (matches.length !== 1) throw new Error(`${matches.length ? 'Ambiguous' : 'Nonexistent'} local posting time: ${target} (${format.resolvedOptions().timeZone}). Choose another time.`);
  return new Date(matches[0]).toISOString();
}

function normalizeSpec(spec) {
  if (!plain(spec) || Object.keys(spec).some(key => !fields.includes(key))) throw new Error('Unknown field in period specification.');
  const id = identifier(spec.id, 'period ID', 40);
  const seriesId = identifier(spec.seriesId, 'series ID');
  calendarDate(spec.startDate);
  if (!Number.isInteger(spec.days) || spec.days < 1 || spec.days > 366) throw new Error('days must be 1–366.');
  const batchSize = spec.batchSize === undefined ? 5 : spec.batchSize;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10) throw new Error('batchSize must be 1–10.');
  const format = formatter(spec.timezone === undefined ? 'Asia/Seoul' : spec.timezone);
  const times = spec.times === undefined ? ['19:00'] : spec.times;
  if (!Array.isArray(times) || !times.length || times.length > 8 || times.some(time => typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) || new Set(times).size !== times.length) {
    throw new Error('times requires 1–8 unique HH:mm values.');
  }
  const weekdays = spec.weekdays === undefined ? [1, 2, 3, 4, 5, 6, 7] : spec.weekdays;
  if (!Array.isArray(weekdays) || !weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(weekdays).size !== weekdays.length) {
    throw new Error('weekdays requires unique ISO weekdays 1 (Monday) to 7 (Sunday).');
  }
  if (spec.planIds !== undefined) {
    if (!Array.isArray(spec.planIds) || !spec.planIds.length || new Set(spec.planIds).size !== spec.planIds.length) throw new Error('planIds requires unique plan IDs.');
    spec.planIds.forEach(value => identifier(value, 'plan ID', 200));
  }
  return { id, seriesId, startDate: spec.startDate, days: spec.days, timezone: format.resolvedOptions().timeZone,
    times: [...times].sort(), weekdays: [...weekdays].sort((a, b) => a - b), batchSize,
    ...(spec.planIds === undefined ? {} : { planIds: [...spec.planIds] }) };
}

function createSlots(spec) {
  const format = formatter(spec.timezone);
  const start = calendarDate(spec.startDate).getTime();
  const slots = [];
  for (let day = 0; day < spec.days; day++) {
    const date = new Date(start + day * 86400000);
    const name = date.toISOString().slice(0, 10);
    if (date.getUTCFullYear() > 9999) throw new Error('Period crosses year 9999.');
    if (!spec.weekdays.includes(date.getUTCDay() || 7)) continue;
    for (const localTime of spec.times) {
      if (slots.length >= 366) throw new Error('A period supports at most 366 posting slots.');
      slots.push({ id: `s${String(slots.length + 1).padStart(3, '0')}`, date: name, localTime,
        scheduledFor: localInstant(name, localTime, format) });
    }
  }
  if (!slots.length) throw new Error('The selected dates and weekdays contain no posting slots.');
  if (spec.planIds && spec.planIds.length !== slots.length) throw new Error(`Need exactly ${slots.length} planIds for these posting slots.`);
  const groups = [];
  for (let offset = 0; offset < slots.length; offset += spec.batchSize) {
    const selected = slots.slice(offset, offset + spec.batchSize);
    const id = `${spec.id}-b${String(groups.length + 1).padStart(2, '0')}`;
    const planIds = spec.planIds?.slice(offset, offset + selected.length);
    groups.push({ id, slotIds: selected.map(slot => slot.id), ...(planIds ? { planIds } : {}) });
    selected.forEach((slot, index) => Object.assign(slot, { batchId: id, ...(planIds ? { planId: planIds[index] } : {}) }));
  }
  return { slots, groups };
}

function periods(catalog) {
  if (catalog.periods !== undefined && !plain(catalog.periods)) throw new Error('Unsupported period catalog.');
  return catalog.periods || {};
}

function storedSpec(period) {
  return normalizeSpec(Object.fromEntries(fields.filter(key => period[key] !== undefined).map(key => [key, period[key]])));
}

function validatePeriod(period) {
  if (!plain(period) || period.version !== 1 || !Array.isArray(period.slots) || !Array.isArray(period.groups)) throw new Error('Unsupported period plan.');
  const spec = storedSpec(period);
  const expected = createSlots(spec);
  if (JSON.stringify(period.groups) !== JSON.stringify(expected.groups) || period.slots.length !== expected.slots.length) throw new Error('Period groups or slot count changed.');
  for (const [index, slot] of period.slots.entries()) {
    const original = expected.slots[index];
    for (const [key, value] of Object.entries(original)) if (slot[key] !== value) throw new Error('Immutable period slot changed: ' + slot.id);
    if (slot.planId !== undefined) identifier(slot.planId, 'slot plan ID', 200);
    if (slot.episodeId !== undefined) identifier(slot.episodeId, 'slot episode ID', 260);
    if ((slot.episodeId && !slot.planId) || (!spec.planIds && slot.planId && !slot.episodeId)) throw new Error('Period slot binding is incomplete.');
  }
  return period;
}

function readPeriod(root, id) {
  identifier(id, 'period ID', 40);
  const all = periods(readCatalog(root));
  const period = Object.hasOwn(all, id) ? all[id] : undefined;
  if (!period) throw new Error('Unknown period: ' + id);
  return validatePeriod(period);
}

function listPeriods(root) {
  return Object.values(periods(readCatalog(root))).map(validatePeriod);
}

function inputExists(root, filename) {
  if (typeof filename !== 'string' || path.isAbsolute(filename)) throw new Error('A repository-relative production input is required.');
  const absolute = path.resolve(root, filename);
  const relative = path.relative(root, absolute);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('Production input escapes repository.');
  if (!fs.statSync(absolute).isFile()) throw new Error('Production input is not a file.');
  const actual = path.relative(fs.realpathSync(root), fs.realpathSync(absolute));
  if (path.isAbsolute(actual) || actual === '..' || actual.startsWith('..' + path.sep)) throw new Error('Production input resolves outside repository.');
}

function assertAvailable(catalog, candidate, root) {
  const selected = new Set(candidate.slots.map(slot => slot.planId).filter(Boolean));
  const times = new Set(candidate.slots.map(slot => Date.parse(slot.scheduledFor)));
  for (const period of Object.values(periods(catalog))) {
    validatePeriod(period);
    if (period.seriesId !== candidate.seriesId || period.id === candidate.id) continue;
    for (const slot of period.slots) {
      if (times.has(Date.parse(slot.scheduledFor))) throw new Error('Posting time already reserved by period: ' + period.id);
      if (slot.planId && selected.has(slot.planId)) throw new Error('Plan already reserved by period: ' + period.id);
    }
  }
  for (const plan of Object.values(catalog.plans[candidate.seriesId] || {})) {
    if (!plan.scheduledFor) continue;
    const ownSlot = candidate.slots.find(slot => slot.planId === plan.id);
    if (ownSlot && !sameInstant(plan.scheduledFor, ownSlot.scheduledFor)) throw new Error('Selected plan has a different posting time: ' + plan.id);
    if (!ownSlot && times.has(Date.parse(plan.scheduledFor))) throw new Error('Posting time already belongs to plan: ' + plan.id);
  }
  let legacy = {};
  try { legacy = JSON.parse(fs.readFileSync(path.join(root, 'pipeline/batches.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const group of candidate.groups) {
    if (Object.hasOwn(catalog.batches, group.id) || Object.hasOwn(legacy, group.id) ||
        fs.existsSync(path.join(root, 'runs/_generation', group.id, 'state.json')) ||
        fs.existsSync(path.join(root, 'runs/_batches', group.id, 'state.json'))) throw new Error('Period batch ID is already in use: ' + group.id);
    for (const period of Object.values(periods(catalog))) if (period.groups.some(other => other.id === group.id)) throw new Error('Period batch ID is already reserved: ' + group.id);
  }
}

async function createPeriod(root, value) {
  const spec = normalizeSpec(value);
  const layout = createSlots(spec);
  return editCatalog(root, catalog => {
    const all = periods(catalog);
    const existing = Object.hasOwn(all, spec.id) ? all[spec.id] : undefined;
    if (existing) {
      validatePeriod(existing);
      if (JSON.stringify(storedSpec(existing)) !== JSON.stringify(spec)) throw new Error('Period ID already exists with different settings: ' + spec.id);
      return { period: existing, reused: true };
    }
    if (!Object.hasOwn(catalog.series, spec.seriesId)) throw new Error('Unknown series: ' + spec.seriesId);
    if (!spec.planIds && catalog.series[spec.seriesId].adapter !== 'pipeline/story/adapter.cjs') throw new Error('Automatic period planning requires the common story adapter.');
    const materialized = new Set(Object.values(catalog.episodes).filter(episode => episode.seriesId === spec.seriesId).map(episode => episode.planId));
    for (const id of spec.planIds || []) {
      const plan = catalog.plans[spec.seriesId]?.[id];
      if (!plan || plan.seriesId !== spec.seriesId) throw new Error('Unknown plan in this series: ' + id);
      if (materialized.has(id) || plan.publishedAt) throw new Error('Period requires an unproduced, unpublished plan: ' + id);
      if (!plan.input) throw new Error('Plan needs a production input: ' + id);
      inputExists(root, plan.input);
    }
    const period = { version: 1, ...spec, createdAt: new Date().toISOString(), ...layout };
    assertAvailable(catalog, period, root);
    catalog.periods ||= {};
    catalog.periods[period.id] = period;
    saveCatalog(root, catalog);
    return { period, reused: false };
  });
}

async function attachPeriodBatch(root, periodId, batchId) {
  identifier(periodId, 'period ID', 40);
  identifier(batchId, 'batch ID');
  return editCatalog(root, catalog => {
    const all = periods(catalog);
    const period = Object.hasOwn(all, periodId) ? all[periodId] : undefined;
    if (!period) throw new Error('Unknown period: ' + periodId);
    validatePeriod(period);
    const group = period.groups.find(item => item.id === batchId);
    if (!group) throw new Error('Batch does not belong to period: ' + batchId);
    const episodeIds = catalog.batches[batchId];
    if (!Array.isArray(episodeIds) || episodeIds.length !== group.slotIds.length || new Set(episodeIds).size !== episodeIds.length) throw new Error('Period batch has an invalid episode count: ' + batchId);
    let changed = false;
    for (const [index, slotId] of group.slotIds.entries()) {
      const slot = period.slots.find(item => item.id === slotId);
      const episodeId = episodeIds[index];
      const episode = catalog.episodes[episodeId];
      const plan = episode && catalog.plans[period.seriesId]?.[episode.planId];
      if (!episode || episode.seriesId !== period.seriesId || !plan || plan.seriesId !== period.seriesId || plan.publishedAt ||
          (slot.planId && slot.planId !== episode.planId) || (slot.episodeId && slot.episodeId !== episodeId)) throw new Error('Episode does not match period slot: ' + slotId);
      if ((plan.scheduledFor && !sameInstant(plan.scheduledFor, slot.scheduledFor)) ||
          (episode.scheduledFor && !sameInstant(episode.scheduledFor, slot.scheduledFor))) throw new Error('Episode has a different posting time: ' + episodeId);
      for (const other of Object.values(periods(catalog))) {
        if (other.seriesId !== period.seriesId) continue;
        for (const occupied of other.slots) {
          if (other.id === period.id && occupied.id === slot.id) continue;
          if (occupied.planId === episode.planId || occupied.episodeId === episodeId || sameInstant(occupied.scheduledFor, slot.scheduledFor)) throw new Error('Episode or posting time already assigned to a period slot: ' + episodeId);
        }
      }
      for (const other of Object.values(catalog.plans[period.seriesId] || {})) {
        if (other.id !== plan.id && other.scheduledFor && sameInstant(other.scheduledFor, slot.scheduledFor)) throw new Error('Posting time already assigned to another plan: ' + other.id);
      }
      if (slot.planId !== episode.planId || slot.episodeId !== episodeId || plan.scheduledFor !== slot.scheduledFor || episode.scheduledFor !== slot.scheduledFor) changed = true;
      Object.assign(slot, { planId: episode.planId, episodeId });
      plan.scheduledFor = slot.scheduledFor;
      episode.scheduledFor = slot.scheduledFor;
    }
    if (changed) saveCatalog(root, catalog);
    return period;
  });
}

module.exports = { createPeriod, readPeriod, listPeriods, attachPeriodBatch, normalizeSpec, createSlots };
