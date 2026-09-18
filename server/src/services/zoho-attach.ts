import type { Meeting, ZohoAttachment } from '../../../shared/types';
import type { DatabaseService } from './database';
import { ZohoService, attendeeEmails } from './zoho';
import { buildTranscriptDocx, transcriptFileName } from './transcript-docx';

// Attach the meeting's Word transcript to every CRM record (Lead and Contact) whose email
// matches an outside participant. Best effort: failures are recorded, never thrown.
export async function attachTranscriptToZoho(db: DatabaseService, meeting: Meeting): Promise<void> {
  const zoho = new ZohoService();
  if (!zoho.isConfigured) {
    console.log('Zoho not configured — skipping attachment');
    return;
  }

  const emails = attendeeEmails(meeting.attendees ?? []);
  if (emails.length === 0) {
    console.log('No participant emails on this meeting — nothing to attach in Zoho');
    return;
  }

  const transcription = await db.getTranscription(meeting.id);
  if (!transcription) {
    console.log('No transcript — nothing to attach in Zoho');
    return;
  }

  const notes = await db.getSummary(meeting.id);
  const docx = await buildTranscriptDocx(meeting, transcription, notes);
  const fileName = transcriptFileName(meeting);

  const results: ZohoAttachment[] = [];
  for (const email of emails) {
    try {
      const records = await zoho.findByEmail(email);
      if (records.length === 0) {
        results.push({ email, status: 'not_found' });
        continue;
      }
      for (const record of records) {
        await zoho.uploadAttachment(record.module, record.id, fileName, docx);
        results.push({ email, name: record.name, module: record.module, url: record.url, status: 'uploaded' });
        console.log(`Zoho: attached "${fileName}" to ${record.module}/${record.id} (${record.name})`);
      }
    } catch (err) {
      console.error(`Zoho attachment for ${email} failed:`, err instanceof Error ? err.message : err);
      results.push({ email, status: 'failed' });
    }
  }

  await db.setMeetingZohoAttachments(meeting.id, results);
}
