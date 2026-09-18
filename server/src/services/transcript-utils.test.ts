import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptSimilarity, linesToSegments, assignSpeakers } from './transcript-utils';

// ── transcriptSimilarity ────────────────────────────────────────────────────

test('different Georgian transcripts are not treated as duplicates', () => {
  const mic = 'გამარჯობა, როგორ ხარ?';
  const speaker = 'დღეს კარგი ამინდია.';

  assert.ok(transcriptSimilarity(mic, speaker) < 0.8);
});

test('the same Georgian transcript is a duplicate regardless of punctuation', () => {
  assert.equal(transcriptSimilarity('გამარჯობა, როგორ ხარ?', 'გამარჯობა როგორ ხარ'), 1);
});

test('the same English transcript is a duplicate regardless of case and punctuation', () => {
  assert.equal(transcriptSimilarity('Hello, how are you?', 'hello how are you'), 1);
});

// ── linesToSegments ─────────────────────────────────────────────────────────

test('converts MM:SS timestamps to seconds', () => {
  const segments = linesToSegments([{ start: '01:05', end: '01:09', text: 'გამარჯობა.' }], 0);

  assert.deepEqual(segments, [{ start: 65, end: 69, text: 'გამარჯობა.' }]);
});

test('converts H:MM:SS timestamps to seconds', () => {
  const segments = linesToSegments([{ start: '1:02:03', end: '1:02:10', text: 'კარგი.' }], 0);

  assert.deepEqual(segments, [{ start: 3723, end: 3730, text: 'კარგი.' }]);
});

test('shifts timestamps by the position of the audio chunk in the recording', () => {
  const segments = linesToSegments([{ start: '00:05', end: '00:09', text: 'დღეს.' }], 600);

  assert.deepEqual(segments, [{ start: 605, end: 609, text: 'დღეს.' }]);
});

test('drops lines without text and trims the rest', () => {
  const segments = linesToSegments([
    { start: '00:01', end: '00:02', text: '   ' },
    { start: '00:03', end: '00:04', text: '  კარგი.  ' },
  ], 0);

  assert.deepEqual(segments, [{ start: 3, end: 4, text: 'კარგი.' }]);
});

test('keeps a line with an unreadable timestamp right after the previous line', () => {
  const segments = linesToSegments([
    { start: '00:10', end: '00:12', text: 'კარგი.' },
    { start: 'n/a', end: '', text: 'დღეს.' },
  ], 0);

  assert.deepEqual(segments, [
    { start: 10, end: 12, text: 'კარგი.' },
    { start: 12, end: 12, text: 'დღეს.' },
  ]);
});

// ── assignSpeakers ──────────────────────────────────────────────────────────

const timeline = [
  { name: 'გიორგი', start: 0, end: 5 },
  { name: 'ნინო', start: 5, end: 12 },
  { name: 'გიორგი', start: 20, end: 25 },
];

test('names each segment after the person speaking at that time', () => {
  const segments = assignSpeakers([
    { start: 1, end: 4, text: 'გამარჯობა.' },
    { start: 6, end: 11, text: 'კარგად, გმადლობ.' },
    { start: 21, end: 24, text: 'დავიწყოთ.' },
  ], timeline, 'Participant');

  assert.deepEqual(segments.map(s => s.speaker), ['გიორგი', 'ნინო', 'გიორგი']);
});

test('picks the person who overlaps the segment the most', () => {
  const segments = assignSpeakers([{ start: 4, end: 10, text: 'ეს ჩემი აზრია.' }], timeline, 'Participant');

  assert.equal(segments[0].speaker, 'ნინო');
});

test('uses the nearest speaker when captions lag slightly behind the audio', () => {
  const segments = assignSpeakers([{ start: 13, end: 14, text: 'ხო.' }], timeline, 'Participant');

  assert.equal(segments[0].speaker, 'ნინო');
});

test('falls back to the default label when nobody was captioned near that time', () => {
  const segments = assignSpeakers([{ start: 40, end: 42, text: 'ჰმ.' }], timeline, 'Participant');

  assert.equal(segments[0].speaker, 'Participant');
});

test('keeps the segments unchanged apart from the speaker', () => {
  const segments = assignSpeakers([{ start: 1, end: 4, text: 'გამარჯობა.' }], timeline, 'Participant');

  assert.deepEqual(segments, [{ start: 1, end: 4, text: 'გამარჯობა.', speaker: 'გიორგი' }]);
});
