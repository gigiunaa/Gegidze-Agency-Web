import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetCodeFromUrl, findEventForMeet, attendeesFromEvent, matchSpeakersToAttendees, type CalendarEvent } from './google-calendar';

const salesCall: CalendarEvent = {
  id: 'evt1',
  summary: 'Intro call — Acme',
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  start: { dateTime: '2026-09-18T12:30:00+04:00' },
  attendees: [
    { email: 'gigig@gegidze.com', displayName: 'Gigi Giunashvili', self: true, responseStatus: 'accepted' },
    { email: 'nino@acme.com', displayName: 'Nino Beridze', responseStatus: 'accepted' },
    { email: 'room@resource.calendar.google.com', displayName: 'Room 1', resource: true },
  ],
};

const otherCall: CalendarEvent = {
  id: 'evt2',
  summary: 'Standup',
  conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/xyz-abcd-efg' }] },
  start: { dateTime: '2026-09-18T10:00:00+04:00' },
  attendees: [],
};

test('extracts the meeting code from a Meet URL', () => {
  assert.equal(meetCodeFromUrl('https://meet.google.com/abc-defg-hij?authuser=0'), 'abc-defg-hij');
  assert.equal(meetCodeFromUrl('https://zoom.us/j/123'), null);
});

test('finds the calendar event whose Meet link matches the call', () => {
  assert.equal(findEventForMeet([otherCall, salesCall], 'https://meet.google.com/abc-defg-hij')?.id, 'evt1');
  assert.equal(findEventForMeet([otherCall, salesCall], 'https://meet.google.com/xyz-abcd-efg')?.id, 'evt2');
  assert.equal(findEventForMeet([otherCall, salesCall], 'https://meet.google.com/nnn-nnnn-nnn'), null);
});

test('lists the people invited, without meeting rooms', () => {
  assert.deepEqual(attendeesFromEvent(salesCall), [
    { name: 'Gigi Giunashvili', email: 'gigig@gegidze.com' },
    { name: 'Nino Beridze', email: 'nino@acme.com' },
  ]);
});

test('uses the email as the name when the invite has no display name', () => {
  const event: CalendarEvent = { ...salesCall, attendees: [{ email: 'lasha@acme.com' }] };

  assert.deepEqual(attendeesFromEvent(event), [{ name: 'lasha@acme.com', email: 'lasha@acme.com' }]);
});

test('matches transcript speaker names to invited people', () => {
  const attendees = attendeesFromEvent(salesCall);

  assert.deepEqual(matchSpeakersToAttendees(['Nino Beridze', 'gigi giunashvili'], attendees), {
    'Nino Beridze': 'nino@acme.com',
    'gigi giunashvili': 'gigig@gegidze.com',
  });
});

test('matches on first name when Meet shows a shorter name than the invite', () => {
  const attendees = attendeesFromEvent(salesCall);

  assert.deepEqual(matchSpeakersToAttendees(['Nino'], attendees), { Nino: 'nino@acme.com' });
});

test('leaves a speaker unmatched when no invited person fits', () => {
  const attendees = attendeesFromEvent(salesCall);

  assert.deepEqual(matchSpeakersToAttendees(['Lasha'], attendees), {});
});
