import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linesToSegments, assignSpeakers, assignSpeakersWithTracks } from './transcript-utils';

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

test('matches by what was said when the captions carry text', () => {
  // Akaki's caption block keeps growing while Gigi's short question sits inside it in time;
  // the words decide, not the overlap
  const captioned = [
    { name: 'Akaki', start: 10, end: 40, text: 'ტიპმა მთლიანი ფილმი გააკეთა რა მოკლემეტრაჟიანი ფილმები რო არის ხოლმე გავგიჟდი ორი ცალი ფილმი გააკეთა' },
    { name: 'gigi', start: 31, end: 33, text: 'ფილმი გააკეთა?' },
  ];

  const segments = assignSpeakers([
    { start: 29, end: 30, text: 'ფილმი გააკეთა?' },
    { start: 31, end: 36, text: 'ფილმი გააკეთა, ორი ცალი ფილმი გააკეთა წარმოიდგინე, მოკლემეტრაჟიანი.' },
  ], captioned, 'Participant');

  assert.deepEqual(segments.map(s => s.speaker), ['gigi', 'Akaki']);
});

test('does not match text from far away in the call', () => {
  const captioned = [
    { name: 'gigi', start: 5, end: 7, text: 'კი, კარგი.' },
    { name: 'Akaki', start: 300, end: 302, text: 'კი, კარგი.' },
  ];

  const segments = assignSpeakers([{ start: 301, end: 302, text: 'კი, კარგი.' }], captioned, 'Participant');

  assert.equal(segments[0].speaker, 'Akaki');
});

// ── assignSpeakersWithTracks ────────────────────────────────────────────────

const captionsFromCall = [
  { name: 'Akaki', start: 38, end: 46, text: 'თქვენ დაგეხარჯებათ ტოკენები და რაღაცეები ხო ჰო კიდიათ ეგ ტოკენები მთავარია იმუშაოს რა' },
];
// When the others' track carried sound (seconds from recording start)
const othersTalking = [{ start: 38, end: 41 }, { start: 47, end: 50 }];

test('a line said while the others were silent belongs to the owner, whatever the captions say', () => {
  const segments = assignSpeakersWithTracks(
    [{ start: 42, end: 46, text: 'ჰო, კიდიათ ეგ ტოკენები. მთავარია იმუშაოს რა.' }],
    captionsFromCall, 'gigi', othersTalking,
  );

  assert.equal(segments[0].speaker, 'gigi');
});

test('a line said while the others were talking takes its name from the captions', () => {
  const segments = assignSpeakersWithTracks(
    [{ start: 38, end: 41, text: 'თქვენ დაგეხარჯებათ ტოკენები და რაღაცეები, ხო?' }],
    captionsFromCall, 'gigi', othersTalking,
  );

  assert.equal(segments[0].speaker, 'Akaki');
});

test('others talking without captions are labelled Participant', () => {
  const segments = assignSpeakersWithTracks(
    [{ start: 47, end: 50, text: 'ვა, თან ჩარტა აქვთ.' }],
    [], 'gigi', othersTalking,
  );

  assert.equal(segments[0].speaker, 'Participant');
});

test('captions that Google gave to the owner never name the others', () => {
  // The owner's mic heard Akaki through the speakers, so Google captioned his words as "gigi"
  const segments = assignSpeakersWithTracks(
    [{ start: 47, end: 50, text: 'ვა, თან ჩარტა აქვთ.' }],
    [{ name: 'gigi', start: 47, end: 51, text: 'ვა თან ჩარტა აქვთ' }, { name: 'Akaki', start: 30, end: 46, text: 'რაღაც სხვა' }],
    'gigi', othersTalking,
  );

  assert.equal(segments[0].speaker, 'Akaki');
});
