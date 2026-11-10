const fs = require('node:fs');
const path = require('node:path');
const { createTools } = require('../tools.cjs');
const { runEpisode } = require('../runner.cjs');
const { createStages } = require('../story/adapter.cjs');
const { validateSpec, validateTiming } = require('../story/spec.cjs');
const { buildHtml } = require('../story/render.cjs');

// Measure the actual selected voice before publishing any generated episode inputs.
function createSpeechPreflight(root, { log = () => {} } = {}) {
  const tools = createTools(root);
  return async (entries, directory) => {
    const reports = [];
    for (const [index, entry] of entries.entries()) {
      const spec = validateSpec(entry.story);
      const workDir = path.join(directory, String(index + 1).padStart(2, '0'));
      fs.mkdirSync(workDir, { recursive: true });
      const episodeFile = path.join(workDir, 'input.json');
      fs.writeFileSync(episodeFile, JSON.stringify(spec, null, 2) + '\n');
      const [speech] = createStages({ episodeFile, tools });
      let state;
      try {
        state = await runEpisode(workDir, [speech], { log: message => log(`[${entry.plan.id}] ${message}`) });
      } catch (error) {
        error.generationRetryable = false;
        error.planId = entry.plan.id;
        throw error;
      }
      const voiceDir = path.join(workDir, state.stages.speech.dir, 'voice');
      const timing = JSON.parse(fs.readFileSync(path.join(voiceDir, 'timing.json'), 'utf8').replace(/^\uFEFF/, ''));
      try {
        validateTiming(spec, timing, fs.readFileSync(path.join(voiceDir, 'narration.wav')));
        const maxHold = Math.max(2, Math.min(6, spec.durationSeconds * .25));
        if (spec.durationSeconds - timing.durationSeconds > maxHold) {
          throw new Error(`Narration is too short. Add useful explanation so the final silent hold is at most ${maxHold}s.`);
        }
        const { html, timeline } = buildHtml(spec, timing);
        fs.copyFileSync(path.join(voiceDir, 'narration.wav'), path.join(workDir, 'narration.wav'));
        fs.writeFileSync(path.join(workDir, 'preview.html'), html);
        fs.writeFileSync(path.join(workDir, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n');
        reports.push({ planId: entry.plan.id, speechSeconds: timing.durationSeconds,
          videoSeconds: spec.durationSeconds, sceneCount: spec.scenes.length });
        log(`[${entry.plan.id}] TTS ${timing.durationSeconds.toFixed(2)}s / video ${spec.durationSeconds}s: passed`);
      } catch (error) {
        const failure = new Error(`${entry.plan.id} (${entry.plan.title}): ${error.message} Measured narration=${timing.durationSeconds}s, video=${spec.durationSeconds}s; keep the fixed series voice/rate and duration.`, { cause: error });
        failure.planId = entry.plan.id;
        if (error.code) failure.code = error.code;
        if (error.generationRetryable === false) failure.generationRetryable = false;
        throw failure;
      }
    }
    fs.writeFileSync(path.join(directory, 'preflight.json'), JSON.stringify(reports, null, 2) + '\n');
    return reports;
  };
}

module.exports = { createSpeechPreflight };
