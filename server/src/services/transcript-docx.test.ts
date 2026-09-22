import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import type { Meeting, Transcription } from '../../../shared/types';
import { buildTranscriptDocx, transcriptFileName } from './transcript-docx';

const meeting: Meeting = {
  id: 'm1',
  userId: 'u1',
  title: 'Google Meet Call — 9/18/2026',
  startTime: '2026-09-18T10:30:00.000Z',
  endTime: '2026-09-18T11:00:00.000Z',
  calendarSource: 'extension',
  participants: [],
  status: 'completed',
  createdAt: '2026-09-18T10:30:00.000Z',
  updatedAt: '2026-09-18T11:00:00.000Z',
};

const transcription: Transcription = {
  id: 't1',
  meetingId: 'm1',
  recordingId: 'r1',
  segments: [
    { start: 0, end: 3, text: 'გამარჯობა, როგორ ხარ?', speaker: 'You' },
    { start: 65, end: 70, text: 'კარგად, გმადლობ.', speaker: 'Participant' },
  ],
  fullText: '[You] გამარჯობა, როგორ ხარ?\n[Participant] კარგად, გმადლობ.',
  language: 'ka',
  createdAt: '2026-09-18T11:05:00.000Z',
};

// The document body XML inside the .docx zip
async function documentXml(docx: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(docx);
  const xml = await zip.file('word/document.xml')?.async('string');
  assert.ok(xml, 'word/document.xml missing from the docx');
  return xml;
}

test('produces a Word document with the meeting title', async () => {
  const xml = await documentXml(await buildTranscriptDocx(meeting, transcription));

  assert.match(xml, /Google Meet Call — 9\/18\/2026/);
});

test('writes every line with its time, speaker and Georgian text', async () => {
  const xml = await documentXml(await buildTranscriptDocx(meeting, transcription));

  assert.match(xml, /0:00/);
  assert.match(xml, /You/);
  assert.match(xml, /გამარჯობა, როგორ ხარ\?/);
  assert.match(xml, /1:05/);
  assert.match(xml, /Participant/);
  assert.match(xml, /კარგად, გმადლობ\./);
});

test('names the file after the meeting and the day it was held', () => {
  assert.equal(transcriptFileName(meeting), 'Google Meet Call - 9-18-2026 — 2026-09-18.docx');
});

test('does not repeat the date when the title already ends with it', () => {
  const dated = { ...meeting, title: 'Intro call — 2026-09-18' };

  assert.equal(transcriptFileName(dated), 'Intro call - 2026-09-18.docx');
});

test('keeps the name usable as a file on any system', () => {
  const messy = { ...meeting, title: 'Zoom Call — 9/18/2026, 2:15:00 PM' };

  assert.equal(transcriptFileName(messy), 'Zoom Call - 9-18-2026, 2-15-00 PM — 2026-09-18.docx');
});


test('lists the invited people with their emails under the title', async () => {
  const withAttendees: Meeting = {
    ...meeting,
    attendees: [
      { name: 'Gigi Giunashvili', email: 'gigig@gegidze.com' },
      { name: 'Nino Beridze', email: 'nino@acme.com' },
    ],
  };

  const xml = await documentXml(await buildTranscriptDocx(withAttendees, transcription));

  assert.match(xml, /Participants/);
  assert.match(xml, /Gigi Giunashvili/);
  assert.match(xml, /gigig@gegidze.com/);
  assert.match(xml, /Nino Beridze/);
  assert.match(xml, /nino@acme.com/);
});

test('merges consecutive lines of the same speaker into one paragraph', async () => {
  const sameSpeaker: Transcription = {
    ...transcription,
    segments: [
      { start: 0, end: 3, text: 'გამარჯობა.', speaker: 'You' },
      { start: 3, end: 6, text: 'როგორ ხარ?', speaker: 'You' },
      { start: 7, end: 9, text: 'კარგად.', speaker: 'Participant' },
    ],
  };

  const xml = await documentXml(await buildTranscriptDocx(meeting, sameSpeaker));

  assert.equal((xml.match(/>You</g) ?? []).length, 1);
  assert.match(xml, /გამარჯობა\. როგორ ხარ\?/);
});

test('puts the notes on the first page, before the transcript', async () => {
  const notes = {
    overview: 'ზარი შეეხო ვებსაიტის შეთავაზებას.',
    sections: [{ heading: 'შეთავაზება', text: 'Google Ads და ვებსაიტი, 4 500 ლარი.' }],
    nextSteps: ['გიგი გაუგზავნის შეთავაზებას.'],
  };

  const xml = await documentXml(await buildTranscriptDocx(meeting, transcription, notes));

  assert.match(xml, /ზარი შეეხო ვებსაიტის შეთავაზებას\./);
  assert.match(xml, /შეთავაზება/);
  assert.match(xml, /გიგი გაუგზავნის შეთავაზებას\./);
  assert.ok(xml.indexOf('ზარი შეეხო') < xml.indexOf('გამარჯობა, როგორ ხარ?'), 'notes come before the transcript');
  assert.match(xml, /w:pageBreakBefore/);
});
