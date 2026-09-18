import type { TranscriptSegment } from '../../../shared/types';

// One transcript line as returned by the transcription model
export interface TimedLine {
  start: string; // "MM:SS" or "H:MM:SS"
  end: string;
  text: string;
}

// Word-overlap similarity (0..1) between two transcripts, ignoring case and punctuation.
// Unicode-aware so non-Latin scripts (Georgian) are compared, not stripped.
export function transcriptSimilarity(textA: string, textB: string): number {
  const a = textA.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  const b = textB.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  const total = Math.max(wordsA.size, wordsB.size);
  return total === 0 ? 1 : overlap / total;
}

// "MM:SS" / "H:MM:SS" → seconds, or null if unreadable
function parseTimestamp(value: string): number | null {
  if (!/^\d+(:\d{1,2}){1,2}$/.test(value.trim())) return null;
  return value.trim().split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

// Convert model lines to segments. offsetSeconds = where this audio chunk starts in the full recording.
export function linesToSegments(lines: TimedLine[], offsetSeconds: number): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let previousEnd = offsetSeconds;

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;

    const parsedStart = parseTimestamp(line.start);
    const parsedEnd = parseTimestamp(line.end);
    const start: number = parsedStart === null ? previousEnd : parsedStart + offsetSeconds;
    const end: number = parsedEnd === null ? start : Math.max(start, parsedEnd + offsetSeconds);

    segments.push({ start, end, text });
    previousEnd = end;
  }

  return segments;
}

// Who was speaking when, as observed from the meeting's captions (seconds from recording start)
export interface SpeakerInterval {
  name: string;
  start: number;
  end: number;
}

// Captions appear a little after the speech, so a segment may fall just outside its interval
const NEAREST_SPEAKER_SECONDS = 3;

// Label each segment with the captioned speaker who overlaps it most (or is nearest), else fallback
export function assignSpeakers(segments: TranscriptSegment[], timeline: SpeakerInterval[], fallback: string): TranscriptSegment[] {
  return segments.map(seg => {
    let best: SpeakerInterval | null = null;
    let bestOverlap = 0;
    let nearest: SpeakerInterval | null = null;
    let nearestGap = Infinity;

    for (const interval of timeline) {
      const overlap = Math.min(seg.end, interval.end) - Math.max(seg.start, interval.start);
      if (overlap > bestOverlap) {
        best = interval;
        bestOverlap = overlap;
      }
      const gap = Math.max(interval.start - seg.end, seg.start - interval.end, 0);
      if (gap < nearestGap) {
        nearest = interval;
        nearestGap = gap;
      }
    }

    const speaker = best?.name ?? (nearest && nearestGap <= NEAREST_SPEAKER_SECONDS ? nearest.name : fallback);
    return { ...seg, speaker };
  });
}
