import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMeetingTitle, MAX_TITLE_LENGTH } from './meeting-title';

test('keeps a normal title as it is', () => {
  assert.equal(cleanMeetingTitle('Domus — CRM demo'), 'Domus — CRM demo');
});

test('trims the edges and squeezes runs of spaces', () => {
  assert.equal(cleanMeetingTitle('   შეხვედრა    თეკლასთან  '), 'შეხვედრა თეკლასთან');
});

test('refuses a title that is empty or only spaces', () => {
  assert.equal(cleanMeetingTitle(''), null);
  assert.equal(cleanMeetingTitle('    '), null);
});

test('refuses anything that is not text', () => {
  assert.equal(cleanMeetingTitle(undefined), null);
  assert.equal(cleanMeetingTitle(42), null);
});

test('cuts an overlong title to the limit', () => {
  assert.equal(cleanMeetingTitle('a'.repeat(MAX_TITLE_LENGTH + 50))?.length, MAX_TITLE_LENGTH);
});

// A pasted title can carry line breaks; a title is one line, and it also names the Word file
test('turns line breaks into spaces', () => {
  assert.equal(cleanMeetingTitle('Domus\nდემო'), 'Domus დემო');
});
