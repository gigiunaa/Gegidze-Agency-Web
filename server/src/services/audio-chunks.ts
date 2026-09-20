import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

// Bundled ffmpeg binary when it was downloaded at install time (production), otherwise whatever is on PATH
const DEFAULT_FFMPEG = typeof ffmpegStatic === 'string' && fs.existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg';

// Split a recording into chunks of chunkSeconds (stream copy, no re-encoding).
// Short chunks keep each transcription request fast and well within model output limits.
// Returns the original file when ffmpeg is unavailable. Chunk files live in a "<file>-chunks" folder.
export async function splitAudio(filePath: string, chunkSeconds: number, ffmpegPath = DEFAULT_FFMPEG): Promise<string[]> {
  const chunkDir = `${filePath}-chunks`;
  fs.mkdirSync(chunkDir, { recursive: true });

  try {
    await execFileAsync(ffmpegPath, [
      '-v', 'error',
      '-i', filePath,
      '-f', 'segment',
      '-segment_time', String(chunkSeconds),
      '-reset_timestamps', '1',
      '-c', 'copy',
      '-y', path.join(chunkDir, `chunk_%03d${path.extname(filePath) || '.webm'}`),
    ]);
  } catch (err) {
    console.warn(`Could not split audio with ffmpeg — transcribing in one piece: ${err instanceof Error ? err.message : err}`);
    fs.rmSync(chunkDir, { recursive: true, force: true });
    return [filePath];
  }

  return fs.readdirSync(chunkDir).sort().map(name => path.join(chunkDir, name));
}

// Remove the chunk folder created by splitAudio
export function removeChunks(filePath: string): void {
  fs.rmSync(`${filePath}-chunks`, { recursive: true, force: true });
}

// Quieter than this on average = nobody spoke (room noise sits around -60 dB, speech around -20 to -35 dB)
const SILENCE_MEAN_DB = -50;
// ...unless something loud happened at some point (a short remark in a long, otherwise quiet chunk)
const SILENCE_PEAK_DB = -35;

// True when the file holds no audible sound. Transcribing silence invites the model to make speech up,
// so silent tracks and chunks are skipped. Unknown (no ffmpeg) counts as sound.
export async function isSilent(filePath: string, ffmpegPath = DEFAULT_FFMPEG): Promise<boolean> {
  try {
    const { stderr } = await execFileAsync(ffmpegPath, ['-i', filePath, '-af', 'volumedetect', '-f', 'null', '-']);
    const level = (name: string): number | null => {
      const m = stderr.match(new RegExp(`${name}:\\s*(-?[\\d.]+|-inf)\\s*dB`));
      return !m ? null : m[1] === '-inf' ? -Infinity : Number(m[1]);
    };
    const mean = level('mean_volume');
    const peak = level('max_volume');
    if (mean === null || peak === null) return false;
    return mean < SILENCE_MEAN_DB && peak < SILENCE_PEAK_DB;
  } catch (err) {
    console.warn(`Could not measure volume with ffmpeg — assuming sound: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// Mix the microphone and the tab audio into one recording, so the call is transcribed once.
// Written next to the mic file; the caller removes it when done.
export async function mixTracks(micPath: string, speakerPath: string, ffmpegPath = DEFAULT_FFMPEG): Promise<string> {
  const outPath = micPath.replace(/(\.[a-z0-9]+)?$/i, '-mixed.webm');
  await execFileAsync(ffmpegPath, [
    '-v', 'error',
    '-i', micPath,
    '-i', speakerPath,
    '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[a]',
    '-map', '[a]',
    '-c:a', 'libopus',
    '-b:a', '64k',
    '-y', outPath,
  ]);
  return outPath;
}

// Quieter than this counts as a pause between utterances
const SPEECH_SILENCE_DB = -35;
const SPEECH_MIN_PAUSE_SECONDS = 0.6;

export interface SpeechInterval {
  start: number;
  end: number;
}

// When somebody is talking on a track (seconds from its start), from the gaps ffmpeg's
// silencedetect reports. Used to tell the two tracks' speakers apart when captions are missing.
export async function speechIntervals(filePath: string, ffmpegPath = DEFAULT_FFMPEG): Promise<SpeechInterval[]> {
  const { stderr } = await execFileAsync(ffmpegPath, [
    '-i', filePath,
    '-af', `silencedetect=noise=${SPEECH_SILENCE_DB}dB:d=${SPEECH_MIN_PAUSE_SECONDS}`,
    '-f', 'null', '-',
  ]);

  // MediaRecorder's webm carries no Duration header, so fall back to how far ffmpeg actually decoded
  const toSeconds = (h: string, m: string, s: string) => Number(h) * 3600 + Number(m) * 60 + Number(s);
  const duration = (() => {
    const header = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (header) return toSeconds(header[1], header[2], header[3]);
    const progress = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
    return progress ? toSeconds(progress[1], progress[2], progress[3]) : null;
  })();
  const silences: { start: number; end: number }[] = [];
  let openStart: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (s) openStart = Number(s[1]);
    if (e && openStart !== null) {
      silences.push({ start: openStart, end: Number(e[1]) });
      openStart = null;
    }
  }
  // Silence still open at the end of the file
  if (openStart !== null && duration !== null) silences.push({ start: openStart, end: duration });

  // Speech is everything between the silences
  const intervals: SpeechInterval[] = [];
  let cursor = 0;
  for (const gap of silences) {
    if (gap.start - cursor > 0.2) intervals.push({ start: cursor, end: gap.start });
    cursor = gap.end;
  }
  if (duration !== null && duration - cursor > 0.2) intervals.push({ start: cursor, end: duration });
  return intervals;
}
