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
