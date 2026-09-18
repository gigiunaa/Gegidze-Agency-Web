import type { Meeting, ZohoAttachment } from '../../../shared/types';
import type { DatabaseService } from './database';
import { ZohoService, externalAttendees } from './zoho';
import { buildTranscriptDocx, transcriptFileName } from './transcript-docx';

// Attach the meeting's Word transcript to every CRM record (Lead and Contact) whose email
// matches an outside participant. Best effort: failures are recorded, never thrown.
export async function attachTranscriptToZoho(db: DatabaseService, meeting: Meeting): Promise<void> {
  const zoho = new ZohoService();
  if (!zoho.isConfigured) {
    console.log('Zoho not configured — skipping attachment');
    return;
  }

  const owner = await db.getUserById(meeting.userId);
  const guests = externalAttendees(meeting.attendees ?? [], owner?.email ?? '');
  if (guests.length === 0) {
    console.log('No outside participants with an email — nothing to attach in Zoho');
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
  for (const guest of guests) {
    try {
      const records = await zoho.findByEmail(guest.email);
      if (records.length === 0) {
        results.push({ email: guest.email, status: 'not_found' });
        continue;
      }
      for (const record of records) {
        await zoho.uploadAttachment(record.module, record.id, fileName, docx);
        results.push({ email: guest.email, name: record.name, module: record.module, status: 'uploaded' });
        console.log(`Zoho: attached "${fileName}" to ${record.module}/${record.id} (${record.name})`);
      }
    } catch (err) {
      console.error(`Zoho attachment for ${guest.email} failed:`, err instanceof Error ? err.message : err);
      results.push({ email: guest.email, status: 'failed' });
    }
  }

  await db.setMeetingZohoAttachments(meeting.id, results);
}
