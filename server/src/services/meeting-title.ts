// A meeting's title is shown on every page and also names its Word file, so it is held to one
// clean line of reasonable length. Anything that cleans down to nothing is refused rather than
// saved as an empty title nobody can click on.
export const MAX_TITLE_LENGTH = 200;

export function cleanMeetingTitle(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH).trim();
  return cleaned || null;
}
