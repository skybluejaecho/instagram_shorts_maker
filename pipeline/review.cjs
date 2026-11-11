const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { inspectEpisode } = require('./runner.cjs');
const { lockWorkDir } = require('./run-state.cjs');

const revisionPattern = /^[a-f0-9]{64}$/;
const actions = new Set(['approve', 'request-changes']);

function readHistory(workDir) {
  let document;
  try {
    document = JSON.parse(fs.readFileSync(path.join(workDir, 'review.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (document?.version !== 1 || !Array.isArray(document.history)) {
    throw new Error('Unsupported review history: ' + workDir);
  }
  const ids = new Set();
  for (const event of document.history) {
    if (!event || typeof event.id !== 'string' || !event.id || ids.has(event.id) ||
        !actions.has(event.action) || !revisionPattern.test(event.revision) ||
        typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)) ||
        typeof event.videoPath !== 'string' || !event.videoPath ||
        typeof event.reportPath !== 'string' || !event.reportPath ||
        (event.note !== undefined && (typeof event.note !== 'string' || !event.note.trim())) ||
        (event.target !== undefined && (typeof event.target !== 'string' || !event.target.trim())) ||
        (event.action === 'request-changes' && (!event.note || !event.target))) {
      throw new Error('Invalid review event: ' + workDir);
    }
    ids.add(event.id);
  }
  return document.history;
}

function saveHistory(workDir, history) {
  const temporary = path.join(workDir, `review-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, history }, null, 2) + '\n');
    fs.renameSync(temporary, path.join(workDir, 'review.json'));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function artifactPath(workDir, directory, filename) {
  const result = path.resolve(workDir, directory, filename);
  const relative = path.relative(workDir, result);
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Review artifact is outside this episode: ' + result);
  }
  return result;
}

async function inspectReview(workDir, stages) {
  const history = readHistory(workDir);
  const { state, steps } = await inspectEpisode(workDir, stages);
  const view = {
    status: state.status === 'ready_for_review' ? 'needs_rebuild' : 'unavailable',
    revision: null, videoPath: null, reportPath: null, history,
    latestDecision: history.at(-1) || null,
    latestRequest: history.findLast(event => event.action === 'request-changes') || null,
  };
  const render = state.stages.render;
  const verify = state.stages.verify;
  if (state.status !== 'ready_for_review' || !steps.length || !steps.every(step => step.current) ||
      !steps.some(step => step.id === 'render') || !steps.some(step => step.id === 'verify') ||
      !render?.outputs?.['video.mp4'] || !verify?.outputs?.['report.json']) return view;

  const visual = stages.some(stage => stage.id === 'visual') ? state.stages.visual : undefined;
  const content = stages.some(stage => stage.id === 'content') ? state.stages.content : undefined;
  view.revision = createHash('sha256').update(JSON.stringify({
    renderDirectory: render.dir, renderKey: render.key, video: render.outputs['video.mp4'],
    verificationKey: verify.key, report: verify.outputs['report.json'],
    ...(visual ? { visualReview: { key: visual.key, report: visual.outputs['report.json'] } } : {}),
    ...(content ? { contentReview: { key: content.key, report: content.outputs['report.json'] } } : {}),
  })).digest('hex');
  view.videoPath = artifactPath(workDir, render.dir, 'video.mp4');
  view.reportPath = artifactPath(workDir, verify.dir, 'report.json');
  const decision = history.findLast(event => event.revision === view.revision);
  view.status = decision ? (decision.action === 'approve' ? 'approved' : 'changes_requested') : 'ready_for_review';
  return view;
}

async function recordReview(workDir, stages, { action, revision, note, target } = {}) {
  if (!actions.has(action)) throw new Error('Choose approve or request-changes.');
  if (typeof revision !== 'string' || !revisionPattern.test(revision)) throw new Error('A full current revision is required.');
  if (note !== undefined && (typeof note !== 'string' || !note.trim())) throw new Error('Review note must contain text.');
  if (target !== undefined && (typeof target !== 'string' || !target.trim())) throw new Error('Review target must contain text.');
  if (action === 'request-changes' && note === undefined) throw new Error('A revision request needs a note.');
  if (action === 'request-changes' && target === undefined) throw new Error('A revision request needs a target.');
  if (!fs.existsSync(workDir)) throw new Error('Create a current verified video before recording a review.');

  const release = await lockWorkDir(workDir, 'Episode');
  try {
    const current = await inspectReview(workDir, stages);
    if (!current.revision) throw new Error('Review requires current, complete, verified output. Rebuild the episode first.');
    if (revision !== current.revision) throw new Error('The revision has changed. Review the current MP4 before submitting.');
    const decision = {
      action, revision, videoPath: current.videoPath, reportPath: current.reportPath,
      ...(note !== undefined ? { note: note.trim() } : {}),
      ...(action === 'request-changes' ? { target: target.trim() } : {}),
    };
    const latest = current.latestDecision;
    if (latest?.action === action && latest.revision === revision &&
        latest.note === decision.note && latest.target === decision.target) return current;
    const event = { id: randomUUID(), at: new Date().toISOString(), ...decision };
    saveHistory(workDir, [...current.history, event]);
    return {
      ...current, status: action === 'approve' ? 'approved' : 'changes_requested',
      history: [...current.history, event], latestDecision: event,
      latestRequest: action === 'request-changes' ? event : current.latestRequest,
    };
  } finally {
    await release();
  }
}

module.exports = { inspectReview, recordReview };
