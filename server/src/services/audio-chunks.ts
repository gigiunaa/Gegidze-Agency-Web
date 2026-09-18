import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Split a recording into chunks of chunkSeconds (stream copy, no re-encoding).
// Short chunks keep each transcription request fast and well within model output limits.
// Returns the original file when ffmpeg is unavailable. Chunk files live in a "<file>-chunks" folder.
export async function splitAudio(filePath: string, chunkSeconds: number, ffmpegPath = 'ffmpeg'): Promise<string[]> {
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
