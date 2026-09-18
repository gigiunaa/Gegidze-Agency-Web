import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { splitAudio } from './audio-chunks';

// 25 seconds of generated tone as a webm/opus file, like the extension records
function tempRecording(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunks-test-'));
  const filePath = path.join(dir, 'mic.webm');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=25', '-c:a', 'libopus', '-y', filePath]);
  return filePath;
}

test('splits a long recording into chunks of the requested length', async () => {
  const chunks = await splitAudio(tempRecording(), 10);

  assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.ok(fs.statSync(chunk).size > 0, `${chunk} should not be empty`);
  }
});

test('keeps a short recording in one piece', async () => {
  const chunks = await splitAudio(tempRecording(), 600);

  assert.equal(chunks.length, 1);
});

test('falls back to the whole recording when ffmpeg is not available', async () => {
  const recording = tempRecording();

  const chunks = await splitAudio(recording, 10, 'ffmpeg-that-does-not-exist');

  assert.deepEqual(chunks, [recording]);
});
