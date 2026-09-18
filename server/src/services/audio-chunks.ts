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
