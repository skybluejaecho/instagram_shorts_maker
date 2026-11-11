const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sdk = require('microsoft-cognitiveservices-speech-sdk');

const voice = 'ko-KR-SunHiNeural';
const utterance = '백에서 이십 퍼센트 <bookmark mark="rise-start"/>오르면, <bookmark mark="rise-end"/>백이십.';
const text = utterance.replace(/<bookmark [^>]*\/>/g, '');
const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR"><voice name="${voice}">${utterance}</voice></speak>`;

function wavDurationSeconds(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Azure returned audio without a RIFF/WAVE header.');
  }
  let pcmFormatValid = false;
  let pcmBytes = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const chunk = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error('Truncated WAV chunk.');
    if (chunk === 'fmt ' && size >= 16) {
      pcmFormatValid = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1 &&
        wav.readUInt32LE(start + 4) === 24000 && wav.readUInt16LE(start + 14) === 16;
    }
    if (chunk === 'data') pcmBytes = size;
    offset = start + size + (size % 2);
  }
  if (!pcmFormatValid || !pcmBytes || pcmBytes % 2 !== 0) {
    throw new Error('Expected nonempty 24 kHz, 16-bit mono PCM WAV.');
  }
  return pcmBytes / (24000 * 2);
}

async function synthesize(key, region) {
  const config = sdk.SpeechConfig.fromSubscription(key, region);
  config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;
  const synthesizer = new sdk.SpeechSynthesizer(config, null);
  const marks = [];
  synthesizer.bookmarkReached = (_, event) => {
    marks.push({ name: event.text, seconds: event.audioOffset / 10000000 });
  };
  try {
    const result = await new Promise((resolve, reject) => {
      synthesizer.speakSsmlAsync(ssml, resolve, reject);
    });
    if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
      const details = sdk.CancellationDetails.fromResult(result);
      throw new Error(`Speech synthesis failed (${sdk.CancellationErrorCode[details.ErrorCode]}): ${details.errorDetails}`);
    }
    const wav = Buffer.from(result.audioData);
    const durationSeconds = wavDurationSeconds(wav);
    if (marks.length !== 2 || marks[0].name !== 'rise-start' || marks[1].name !== 'rise-end') {
      throw new Error('Expected exactly rise-start followed by rise-end from Azure.');
    }
    const startSeconds = marks[0].seconds;
    const endSeconds = marks[1].seconds;
    if (!(startSeconds >= 0 && startSeconds < endSeconds && endSeconds <= durationSeconds)) {
      throw new Error('Azure bookmark offsets do not fit inside the returned WAV.');
    }
    return { wav, timing: {
      text, voice, startSeconds, endSeconds, durationSeconds,
      audioSha256: createHash('sha256').update(wav).digest('hex'),
    } };
  } finally {
    synthesizer.close();
  }
}

async function main() {
  const { SPEECH_KEY: key, SPEECH_REGION: region } = process.env;
  if (!key || !region) throw new Error('Set SPEECH_KEY and SPEECH_REGION in the local Node environment.');
  const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'generated');
  try {
    await fs.access(output);
    throw new Error('Output already exists. Reuse it or specify a new output directory.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { wav, timing } = await synthesize(key, region);
  const parent = path.dirname(output);
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, '.speech-output-'));
  try {
    await fs.writeFile(path.join(staging, 'narration.wav'), wav);
    await fs.writeFile(path.join(staging, 'timing.json'), JSON.stringify(timing, null, 2) + '\n');
    await fs.rename(staging, output);
  } catch (error) {
    await fs.rm(path.join(staging, 'narration.wav'), { force: true });
    await fs.rm(path.join(staging, 'timing.json'), { force: true });
    await fs.rmdir(staging);
    throw error;
  }
  console.log(`Created ${output} (${timing.durationSeconds.toFixed(3)} s; rise ${timing.startSeconds.toFixed(3)}–${timing.endSeconds.toFixed(3)} s).`);
}

main().catch((error) => {
  const message = String(error.message || error);
  console.error(process.env.SPEECH_KEY ? message.replaceAll(process.env.SPEECH_KEY, '[redacted]') : message);
  process.exitCode = 1;
});
