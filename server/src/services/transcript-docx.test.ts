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

test('names the file after the meeting, safe for a download', () => {
  assert.equal(transcriptFileName({ ...meeting, title: 'Zoom Call — 9/18/2026, 2:15:00 PM' }), 'Zoom Call - 9-18-2026, 2-15-00 PM.docx');
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
  assert.match(xml, /Gigi Giunashvili — gigig@gegidze.com/);
  assert.match(xml, /Nino Beridze — nino@acme.com/);
});
