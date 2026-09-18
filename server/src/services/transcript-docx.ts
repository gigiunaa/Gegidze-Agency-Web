import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import type { Meeting, Transcription } from '../../../shared/types';

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Word document with the meeting title, date and one line per transcript segment
export async function buildTranscriptDocx(meeting: Meeting, transcription: Transcription): Promise<Buffer> {
  const date = new Date(meeting.startTime).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  const lines = transcription.segments.length > 0
    ? transcription.segments.map(seg => new Paragraph({
        spacing: { after: 120 },
        children: [
          new TextRun({ text: `${formatTime(seg.start)}  `, color: '888888' }),
          ...(seg.speaker ? [new TextRun({ text: `${seg.speaker}: `, bold: true })] : []),
          new TextRun({ text: seg.text }),
        ],
      }))
    : [new Paragraph({ children: [new TextRun({ text: transcription.fullText })] })];

  // Invited people from the Calendar invite, when known
  const attendees = meeting.attendees ?? [];
  const participants = attendees.length > 0
    ? [
        new Paragraph({ spacing: { before: 120 }, children: [new TextRun({ text: 'Participants', bold: true })] }),
        ...attendees.map(a => new Paragraph({ children: [new TextRun({ text: `${a.name} — ${a.email}` })] })),
        new Paragraph({ spacing: { after: 240 }, children: [] }),
      ]
    : [];

  const doc = new Document({
    creator: 'Gegidze Meeting Recorder',
    title: meeting.title,
    styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
    sections: [{
      children: [
        new Paragraph({ text: meeting.title, heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: date, color: '888888' })] }),
        ...participants,
        ...lines,
      ],
    }],
  });

  return Packer.toBuffer(doc);
}

// File name for the download: the meeting title with characters Windows/browsers reject replaced
export function transcriptFileName(meeting: Meeting): string {
  const safe = meeting.title.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+—\s+/g, ' - ').trim();
  return `${safe || 'transcript'}.docx`;
}
