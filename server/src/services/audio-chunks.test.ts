import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { splitAudio, isSilent } from './audio-chunks';

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

// ── isSilent ────────────────────────────────────────────────────────────────

function tempGenerated(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-test-'));
  const filePath = path.join(dir, 'track.webm');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', source, '-c:a', 'libopus', '-y', filePath]);
  return filePath;
}

test('recognises a silent track', async () => {
  assert.equal(await isSilent(tempGenerated('anullsrc=r=48000:cl=mono:d=10')), true);
});

test('recognises a track with sound', async () => {
  assert.equal(await isSilent(tempGenerated('sine=frequency=440:duration=10')), false);
});

test('assumes sound when ffmpeg is not available', async () => {
  assert.equal(await isSilent(tempGenerated('anullsrc=r=48000:cl=mono:d=3'), 'ffmpeg-that-does-not-exist'), false);
});
