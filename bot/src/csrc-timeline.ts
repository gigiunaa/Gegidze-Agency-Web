export interface Sample {
  csrc: number;
  audioLevel: number;
  atMs: number;
}

export interface Interval {
  csrc: number;
  startMs: number;
  endMs: number;
}

// Below this, the level is room noise rather than someone talking
const MIN_LEVEL = 0.01;
// Two bursts from one person closer together than this are one turn, not two
const SILENCE_GAP_MS = 1500;

export function speakingIntervals(
  samples: Sample[],
  opts: { minLevel?: number; silenceGapMs?: number } = {},
): Interval[] {
  const minLevel = opts.minLevel ?? MIN_LEVEL;
  const gap = opts.silenceGapMs ?? SILENCE_GAP_MS;

  const bySource = new Map<number, Sample[]>();
  for (const s of samples) {
    if (s.audioLevel < minLevel) continue;
    const list = bySource.get(s.csrc);
    if (list) list.push(s); else bySource.set(s.csrc, [s]);
  }

  const intervals: Interval[] = [];
  for (const [csrc, list] of bySource) {
    list.sort((a, b) => a.atMs - b.atMs);
    let current: Interval | null = null;
    for (const s of list) {
      if (current && s.atMs - current.endMs <= gap) {
        current.endMs = s.atMs;
      } else {
        current = { csrc, startMs: s.atMs, endMs: s.atMs };
        intervals.push(current);
      }
    }
  }

  return intervals.sort((a, b) => a.startMs - b.startMs || a.csrc - b.csrc);
}
