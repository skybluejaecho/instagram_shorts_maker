const fs = require('node:fs');
const path = require('node:path');
const { readStateFile } = require('../run-state.cjs');
const { inspectEpisode } = require('../runner.cjs');
const { validateSpec, validateTiming } = require('../story/spec.cjs');
const { buildHtml } = require('../story/render.cjs');
const { createSpeechPreflight } = require('../generation/preflight.cjs');

function runtimeFailure(error) {
  error.generationRetryable = false;
  return error;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function existingArtifact(workDir, directory, filename) {
  if (typeof directory !== 'string' || path.isAbsolute(directory)) throw new Error('Invalid saved speech artifact directory.');
  const base = path.resolve(workDir);
  const file = path.resolve(base, directory, filename);
  if (!inside(base, file) || !inside(fs.realpathSync(base), fs.realpathSync(file))) {
    throw new Error('Saved speech artifact resolves outside the episode directory.');
  }
  return file;
}

function prepareDirectory(root, directory, workDir) {
  const base = fs.realpathSync(root);
  const destination = path.resolve(directory);
  const episode = path.resolve(workDir);
  if (!inside(path.resolve(root), destination) || destination === episode || inside(episode, destination)) {
    throw new Error('Revision preview needs a separate directory inside the repository.');
  }
  let ancestor = destination;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actualAncestor = fs.realpathSync(ancestor);
  if (actualAncestor !== base && !inside(base, actualAncestor)) throw new Error('Revision preview directory resolves outside the repository.');
  const actualEpisode = fs.realpathSync(episode);
  if (actualAncestor === actualEpisode || inside(actualEpisode, actualAncestor)) throw new Error('Revision preview cannot overwrite episode artifacts.');
  fs.mkdirSync(destination, { recursive: true });
  return destination;
}

function ioError(error) {
  return typeof error.code === 'string' || /\b(?:EACCES|EPERM|ENOENT|ENOTDIR|ENOSPC|EIO|EROFS|EMFILE)\b/.test(error.message || '');
}

function createRevisionPreflight(root, { log = () => {}, speechPreflight } = {}) {
  const synthesize = speechPreflight || createSpeechPreflight(root, { log });
  return async ({ source, story, directory, workDir, stages }) => {
    let baseline;
    let destination;
    try {
      baseline = validateSpec(source);
      destination = prepareDirectory(root, directory, workDir);
    } catch (error) { throw runtimeFailure(error); }
    const revised = validateSpec(story);
    const unchangedSpeech = JSON.stringify(baseline.narration) === JSON.stringify(revised.narration) &&
      JSON.stringify(baseline.profile.speech) === JSON.stringify(revised.profile.speech);
    try {
      if (!unchangedSpeech) {
        const reports = await synthesize([{ plan: { id: 'revision' }, story: revised }], destination);
        if (!Array.isArray(reports) || reports.length !== 1 || !Number.isFinite(reports[0]?.speechSeconds)) {
          throw runtimeFailure(new Error('Speech preflight did not return a measured narration report.'));
        }
        const report = { ...reports[0], reusedSpeech: false };
        fs.writeFileSync(path.join(destination, 'preflight.json'), JSON.stringify(report, null, 2) + '\n');
        return report;
      }

      let wav;
      let timing;
      let speechDirectory;
      try {
        const saved = readStateFile(workDir);
        const speech = saved?.stages?.speech;
        const speechIndex = Array.isArray(stages) ? stages.findIndex(stage => stage.id === 'speech') : -1;
        if (!speech || speech.status !== 'done' || speechIndex < 0) {
          throw new Error('Current speech artifacts are required before applying a visual revision.');
        }
        // Validate locations before inspectEpisode reads the files named by this stage.
        for (const file of stages[speechIndex].outputs) existingArtifact(workDir, speech.dir, file);
        const wavFile = existingArtifact(workDir, speech.dir, 'voice/narration.wav');
        const timingFile = existingArtifact(workDir, speech.dir, 'voice/timing.json');
        // The revision engine has just validated the proposed content. Inspect only
        // media dependencies here so an older validation-only report cannot make
        // unchanged audio stale or trigger another model call.
        const mediaStages = stages.slice(0, speechIndex + 1).filter(stage => !stage.validationOnly);
        const inspected = await inspectEpisode(workDir, mediaStages);
        if (!inspected.steps.at(-1)?.current) throw new Error('Saved speech is stale or changed. Rebuild the episode before applying this request.');
        wav = fs.readFileSync(wavFile);
        timing = JSON.parse(fs.readFileSync(timingFile, 'utf8').replace(/^\uFEFF/, ''));
        validateTiming(baseline, timing, wav);
        speechDirectory = speech.dir;
      } catch (error) { throw runtimeFailure(error); }

      // Existing speech is sound; a failure against the proposed story is a repairable content issue.
      validateTiming(revised, timing, wav);
      const { html, timeline } = buildHtml(revised, timing);
      fs.writeFileSync(path.join(destination, 'preview.html'), html);
      fs.writeFileSync(path.join(destination, 'narration.wav'), wav);
      fs.writeFileSync(path.join(destination, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n');
      const report = { reusedSpeech: true, speechDirectory, audioSha256: timing.audioSha256,
        speechSeconds: timing.durationSeconds, videoSeconds: revised.durationSeconds, sceneCount: revised.scenes.length };
      fs.writeFileSync(path.join(destination, 'preflight.json'), JSON.stringify(report, null, 2) + '\n');
      log(`[revision] 기존 음성 재사용: ${timing.durationSeconds.toFixed(2)}s / ${revised.durationSeconds}s`);
      return report;
    } catch (error) {
      if (ioError(error)) error.generationRetryable = false;
      throw error;
    }
  };
}

module.exports = { createRevisionPreflight };
