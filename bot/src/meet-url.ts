// A Meet call code is three letters, four letters, three letters. Matching the shape rather than
// just the host keeps /home and /new — which are Meet pages but not calls — out.
const CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export function meetingCodeFrom(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (CODE.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.hostname !== 'meet.google.com') return null;

  const code = url.pathname.replace(/^\/+|\/+$/g, '');
  return CODE.test(code) ? code : null;
}
