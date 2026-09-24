import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingCodeFrom } from './meet-url';

test('reads the code out of a Meet link', () => {
  assert.equal(meetingCodeFrom('https://meet.google.com/abc-defg-hij'), 'abc-defg-hij');
});

test('ignores query strings and trailing slashes', () => {
  assert.equal(meetingCodeFrom('https://meet.google.com/abc-defg-hij/?authuser=1'), 'abc-defg-hij');
});

test('accepts a bare meeting code', () => {
  assert.equal(meetingCodeFrom('abc-defg-hij'), 'abc-defg-hij');
});

test('refuses Meet pages that are not a call', () => {
  assert.equal(meetingCodeFrom('https://meet.google.com/home'), null);
  assert.equal(meetingCodeFrom('https://meet.google.com/new'), null);
});

test('refuses links to other services', () => {
  assert.equal(meetingCodeFrom('https://zoom.us/j/123456'), null);
  assert.equal(meetingCodeFrom(''), null);
});
