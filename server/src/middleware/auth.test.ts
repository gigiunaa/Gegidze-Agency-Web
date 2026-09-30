import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRenew, TOKEN_LIFETIME_SECONDS } from './auth';

const now = 1_800_000_000;
const expiringIn = (seconds: number) => now + seconds;

test('a token used soon after signing is left alone', () => {
  assert.equal(shouldRenew(expiringIn(TOKEN_LIFETIME_SECONDS - 60), now), false);
});

test('a token past its halfway point is renewed', () => {
  assert.equal(shouldRenew(expiringIn(TOKEN_LIFETIME_SECONDS / 2 - 1), now), true);
});

test('a token with minutes left is renewed', () => {
  assert.equal(shouldRenew(expiringIn(120), now), true);
});

// Without an expiry there is nothing to measure, and handing out a fresh token on that basis
// would turn any malformed token into an endless one
test('a token with no expiry is not renewed', () => {
  assert.equal(shouldRenew(undefined, now), false);
});
