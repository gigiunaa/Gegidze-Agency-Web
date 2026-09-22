import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle,
  Footer, PageNumber, Table, TableRow, TableCell, WidthType, ShadingType,
} from 'docx';
import type { Meeting, Transcription, TranscriptSegment } from '../../../shared/types';
import type { Notes } from './summary';

const ACCENT = '7B6CF6';
const MUTED = '8888A0';
const TEXT = '141428';
// One colour per speaker, in order of first appearance
const SPEAKER_COLORS = ['7B6CF6', '0E9F6E', 'D97706', '2563EB', 'DB2777', '0891B2'];

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// Consecutive segments by the same speaker read better as one paragraph
function mergeTurns(segments: TranscriptSegment[]): TranscriptSegment[] {
  const turns: TranscriptSegment[] = [];
  for (const seg of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker) {
      last.text = `${last.text} ${seg.text}`;
      last.end = seg.end;
    } else {
      turns.push({ ...seg });
    }
  }
  return turns;
}

const run = (text: string, extra: Partial<ConstructorParameters<typeof TextRun>[0] & object> = {}) =>
  new TextRun({ text, color: TEXT, ...extra });

// Word document: title block, participants, then the conversation as speaker turns
export async function buildTranscriptDocx(meeting: Meeting, transcription: Transcription, notes?: Notes | null): Promise<Buffer> {
  const date = new Date(meeting.startTime).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' });
  const turns = mergeTurns(transcription.segments);
  const duration = turns.length > 0 ? formatDuration(turns[turns.length - 1].end) : null;

  const colorFor = new Map<string, string>();
  for (const turn of turns) {
    const name = turn.speaker ?? '';
    if (!colorFor.has(name)) colorFor.set(name, SPEAKER_COLORS[colorFor.size % SPEAKER_COLORS.length]);
  }

  const header = [
    new Paragraph({ children: [run('UNITTY MEETING RECORDER', { color: ACCENT, bold: true, size: 16, characterSpacing: 40 })], spacing: { after: 120 } }),
    new Paragraph({ text: meeting.title, heading: HeadingLevel.TITLE, spacing: { after: 80 } }),
    new Paragraph({
      children: [run(date, { color: MUTED }), ...(duration ? [run(`  ·  ${duration}`, { color: MUTED })] : [])],
      spacing: { after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'E4E4ED', space: 8 } },
    }),
  ];

  const attendees = meeting.attendees ?? [];
  const participants = attendees.length > 0
    ? [
        new Paragraph({ children: [run('Participants', { bold: true, size: 24 })], spacing: { before: 120, after: 80 } }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: noBorders(),
          rows: attendees.map(a => new TableRow({
            children: [
              cell([run(a.name, { bold: true })], 40),
              cell([run(a.email, { color: MUTED })], 60),
            ],
          })),
        }),
        new Paragraph({ spacing: { after: 240 }, children: [] }),
      ]
    : [];

  // Notes page (overview, topics, next steps); the transcript starts on a new page after it
  const notesBlock = notes && notes.overview
    ? [
        new Paragraph({ children: [run('Summary', { bold: true, size: 28 })], spacing: { before: 120, after: 120 } }),
        new Paragraph({ children: [run(notes.overview)], spacing: { after: 240, line: 300 } }),
        ...notes.sections.flatMap(section => [
          new Paragraph({ children: [run(section.heading, { bold: true, size: 24 })], spacing: { before: 160, after: 60 } }),
          new Paragraph({ children: [run(section.text)], spacing: { after: 120, line: 300 } }),
        ]),
        ...(notes.nextSteps.length > 0
          ? [
              new Paragraph({ children: [run('Next steps', { bold: true, size: 24 })], spacing: { before: 200, after: 60 } }),
              ...notes.nextSteps.map(step => new Paragraph({ children: [run(step)], bullet: { level: 0 }, spacing: { after: 60 } })),
            ]
          : []),
      ]
    : [];

  const transcript = [
    new Paragraph({ children: [run('Transcript', { bold: true, size: 24 })], spacing: { before: 120, after: 160 }, pageBreakBefore: notesBlock.length > 0 }),
    ...(turns.length > 0
      ? turns.flatMap(turn => [
          new Paragraph({
            spacing: { before: 160, after: 40 },
            children: [
              run(turn.speaker ?? 'Speaker', { bold: true, color: colorFor.get(turn.speaker ?? '') ?? ACCENT }),
              run(`   ${formatTime(turn.start)}`, { color: MUTED, size: 18 }),
            ],
          }),
          new Paragraph({ children: [run(turn.text)], spacing: { after: 80, line: 300 }, indent: { left: 200 } }),
        ])
      : [new Paragraph({ children: [run(transcription.fullText)] })]),
  ];

  const doc = new Document({
    creator: 'Unitty Meeting Recorder',
    title: meeting.title,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22, color: TEXT } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', run: { size: 44, bold: true, color: TEXT, font: 'Calibri' } },
      ],
    },
    sections: [{
      properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], color: MUTED, size: 16 })],
          })],
        }),
      },
      children: [...header, ...participants, ...notesBlock, ...transcript],
    }],
  });

  return Packer.toBuffer(doc);
}

function noBorders() {
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  return { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
}

function cell(children: TextRun[], widthPercent: number): TableCell {
  return new TableCell({
    width: { size: widthPercent, type: WidthType.PERCENTAGE },
    shading: { type: ShadingType.CLEAR, fill: 'F5F5FA' },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({ children })],
  });
}

// File name for the download: the meeting title with characters Windows/browsers reject replaced
export function transcriptFileName(meeting: Meeting): string {
  const safe = meeting.title.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+—\s+/g, ' - ').trim() || 'Transcript';
  // The date is spelled out, so an attachment sitting in a CRM record says which call it was
  const day = new Date(meeting.startTime).toISOString().slice(0, 10);
  return safe.includes(day) ? `${safe}.docx` : `${safe} — ${day}.docx`;
}
