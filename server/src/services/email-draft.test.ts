import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanEmailDraft, MAX_SUBJECT_LENGTH, MAX_BODY_LENGTH } from './email-draft';

test('keeps a normal subject and body', () => {
  assert.deepEqual(
    cleanEmailDraft({ subject: 'Zoho CRM — შეთავაზება', body: 'გამარჯობა, ნიკა,\n\nმადლობა.' }),
    { subject: 'Zoho CRM — შეთავაზება', body: 'გამარჯობა, ნიკა,\n\nმადლობა.' },
  );
});

test('the subject is one line, with spaces squeezed', () => {
  assert.equal(cleanEmailDraft({ subject: '  შეთავაზება\n  Domus  ', body: 'x' })?.subject, 'შეთავაზება Domus');
});

// The body is a letter: its line breaks are its paragraphs and must survive
test('the body keeps its line breaks and loses only trailing space', () => {
  assert.equal(cleanEmailDraft({ subject: 's', body: 'გამარჯობა,\n\nტექსტი   \n\n' })?.body, 'გამარჯობა,\n\nტექსტი');
});

test('refuses a draft with an empty subject or body', () => {
  assert.equal(cleanEmailDraft({ subject: '   ', body: 'x' }), null);
  assert.equal(cleanEmailDraft({ subject: 's', body: '  \n ' }), null);
});

test('refuses anything that is not a subject and body of text', () => {
  assert.equal(cleanEmailDraft(undefined), null);
  assert.equal(cleanEmailDraft({ subject: 5, body: 'x' }), null);
});

test('cuts an overlong subject and body to their limits', () => {
  const d = cleanEmailDraft({ subject: 's'.repeat(MAX_SUBJECT_LENGTH + 9), body: 'b'.repeat(MAX_BODY_LENGTH + 9) });
  assert.equal(d?.subject.length, MAX_SUBJECT_LENGTH);
  assert.equal(d?.body.length, MAX_BODY_LENGTH);
});
