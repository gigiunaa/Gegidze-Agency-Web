import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakingIntervals, type Sample } from './csrc-timeline';

const sample = (csrc: number, audioLevel: number, atMs: number): Sample => ({ csrc, audioLevel, atMs });

test('runs of loud samples from one source become one interval', () => {
  const intervals = speakingIntervals([
    sample(11, 0.20, 0),
    sample(11, 0.18, 200),
    sample(11, 0.22, 400),
  ]);
  assert.deepEqual(intervals, [{ csrc: 11, startMs: 0, endMs: 400 }]);
});

test('a long silence splits one source into two intervals', () => {
  const intervals = speakingIntervals([
    sample(11, 0.20, 0),
    sample(11, 0.20, 200),
    sample(11, 0.20, 5000),
  ]);
  assert.deepEqual(intervals, [
    { csrc: 11, startMs: 0, endMs: 200 },
    { csrc: 11, startMs: 5000, endMs: 5000 },
  ]);
});

test('samples below the speaking level are not speech', () => {
  const intervals = speakingIntervals([
    sample(11, 0.001, 0),
    sample(11, 0.002, 200),
  ]);
  assert.deepEqual(intervals, []);
});

test('two people talking are kept apart', () => {
  const intervals = speakingIntervals([
    sample(11, 0.20, 0),
    sample(22, 0.20, 100),
    sample(11, 0.20, 200),
    sample(22, 0.20, 300),
  ]);
  assert.deepEqual(intervals, [
    { csrc: 11, startMs: 0, endMs: 200 },
    { csrc: 22, startMs: 100, endMs: 300 },
  ]);
});

test('an empty recording has no speech in it', () => {
  assert.deepEqual(speakingIntervals([]), []);
});
