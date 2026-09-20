import type { TranscriptSegment } from '../../../shared/types';

// One transcript line as returned by the transcription model
export interface TimedLine {
  start: string; // "MM:SS" or "H:MM:SS"
  end: string;
  text: string;
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

// Who was speaking when, as observed from the meeting's captions (seconds from recording start).
// text is Google's own caption for that turn, when the extension captured it.
export interface SpeakerInterval {
  name: string;
  start: number;
  end: number;
  text?: string;
}

// Captions appear a little after the speech, so a segment may fall just outside its interval
const NEAREST_SPEAKER_SECONDS = 3;
// A caption block is only considered for a segment said within this many seconds of it
const TEXT_MATCH_WINDOW_SECONDS = 20;
// Below this share of shared words the caption text says nothing about the segment
const TEXT_MATCH_MIN = 0.4;

const words = (text: string) => new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean));

// How well a caption's words account for the segment's words. Recall alone would favour any
// long caption block (it contains everything), so the caption's own length counts against it.
function textMatch(segmentText: string, captionText: string): { recall: number; score: number } {
  const a = words(segmentText);
  const b = words(captionText);
  if (a.size === 0 || b.size === 0) return { recall: 0, score: 0 };
  let hits = 0;
  for (const w of a) if (b.has(w)) hits++;
  const recall = hits / a.size;
  const precision = hits / b.size;
  const score = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  return { recall, score };
}

function gapBetween(seg: TranscriptSegment, interval: SpeakerInterval): number {
  return Math.max(interval.start - seg.end, seg.start - interval.end, 0);
}

// Label each segment with its speaker. The words decide when the captions carry text (Google
// attributes each caption to the microphone it came from, so a matching caption is exact);
// otherwise the caption overlapping the segment most, or the nearest one, or the fallback.
export function assignSpeakers(segments: TranscriptSegment[], timeline: SpeakerInterval[], fallback: string): TranscriptSegment[] {
  return segments.map(seg => ({ ...seg, speaker: speakerFor(seg, timeline) ?? fallback }));
}

function speakerFor(seg: TranscriptSegment, timeline: SpeakerInterval[]): string | null {
  // 1. By text
  let bestText: SpeakerInterval | null = null;
  let bestScore = 0;
  for (const interval of timeline) {
    if (!interval.text || gapBetween(seg, interval) > TEXT_MATCH_WINDOW_SECONDS) continue;
    const { recall, score } = textMatch(seg.text, interval.text);
    if (recall < TEXT_MATCH_MIN) continue;
    // Ties go to the caption closest in time
    if (score > bestScore || (score === bestScore && bestText && gapBetween(seg, interval) < gapBetween(seg, bestText))) {
      bestText = interval;
      bestScore = score;
    }
  }
  if (bestText) return bestText.name;

  // 2. By time
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
    const gap = gapBetween(seg, interval);
    if (gap < nearestGap) {
      nearest = interval;
      nearestGap = gap;
    }
  }
  if (best) return best.name;
  if (nearest && nearestGap <= NEAREST_SPEAKER_SECONDS) return nearest.name;
  return null;
}
