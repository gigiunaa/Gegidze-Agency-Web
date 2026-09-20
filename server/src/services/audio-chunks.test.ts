import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { splitAudio, isSilent, mixTracks, speechIntervals } from './audio-chunks';

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

// ── mixTracks ───────────────────────────────────────────────────────────────

test('mixes two tracks into one recording', async () => {
  const mic = tempGenerated('sine=frequency=440:duration=6');
  const others = tempGenerated('sine=frequency=880:duration=6');

  const mixed = await mixTracks(mic, others);

  assert.ok(fs.existsSync(mixed));
  assert.ok(fs.statSync(mixed).size > 0);
  assert.equal(await isSilent(mixed), false);
});

// ── speechIntervals ─────────────────────────────────────────────────────────

test('finds when there is speech on a track', async () => {
  // 3 s of tone, 3 s of silence, 3 s of tone
  const track = tempGenerated('sine=frequency=440:duration=9,volume=enable=\'between(t,3,6)\':volume=0');

  const intervals = await speechIntervals(track);

  assert.equal(intervals.length, 2);
  assert.ok(intervals[0].start < 0.5 && Math.abs(intervals[0].end - 3) < 0.5, `first ${JSON.stringify(intervals[0])}`);
  assert.ok(Math.abs(intervals[1].start - 6) < 0.5 && Math.abs(intervals[1].end - 9) < 0.5, `second ${JSON.stringify(intervals[1])}`);
});

test('a silent track has no speech intervals', async () => {
  assert.deepEqual(await speechIntervals(tempGenerated('anullsrc=r=48000:cl=mono:d=5')), []);
});

test('still finds the last stretch of speech in a recording without a duration header', async () => {
  // MediaRecorder-style webm: re-muxed without metadata, tone at the end
  const src = tempGenerated('sine=frequency=440:duration=6,volume=enable=\'between(t,0,3)\':volume=0');
  const noHeader = src.replace('.webm', '-live.webm');
  execFileSync('ffmpeg', ['-v', 'error', '-i', src, '-c', 'copy', '-live', '1', '-y', noHeader]);

  const intervals = await speechIntervals(noHeader);

  assert.equal(intervals.length, 1);
  assert.ok(Math.abs(intervals[0].start - 3) < 0.5 && intervals[0].end > 5.5, JSON.stringify(intervals));
});
