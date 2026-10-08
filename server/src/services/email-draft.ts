import type { EmailDraft } from '../../../shared/types';

// A draft someone has edited by hand. The subject is a single line; the body is a letter whose
// line breaks are its paragraphs, so only the space at its very ends is trimmed. A draft that
// cleans down to an empty subject or body is refused: it would look ready to send and is not.
export const MAX_SUBJECT_LENGTH = 200;
export const MAX_BODY_LENGTH = 10000;

export function cleanEmailDraft(input: unknown): EmailDraft | null {
  if (!input || typeof input !== 'object') return null;
  const { subject, body } = input as { subject?: unknown; body?: unknown };
  if (typeof subject !== 'string' || typeof body !== 'string') return null;

  const cleanSubject = subject.replace(/\s+/g, ' ').trim().slice(0, MAX_SUBJECT_LENGTH).trim();
  const cleanBody = body.replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY_LENGTH);
  if (!cleanSubject || !cleanBody) return null;
  return { subject: cleanSubject, body: cleanBody };
}
