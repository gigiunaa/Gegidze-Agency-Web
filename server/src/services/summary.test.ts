import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { buildNotes, MIN_WORDS_FOR_NOTES } from './summary';

const notes = {
  overview: 'ზარი შეეხო ვებსაიტისა და რეკლამის შეთავაზებას სასტუმროების ქსელისთვის.',
  sections: [
    { heading: 'კლიენტის სიტუაცია', text: 'ხუთი სასტუმრო ბათუმსა და თბილისში; ონლაინ ჯავშნების ზრდა სურთ.' },
    { heading: 'შეთავაზება', text: 'Google Ads და ვებსაიტის განახლება, ექვსი კვირა, 4 500 ლარი.' },
  ],
  nextSteps: ['გიგი დღეს გაუგზავნის წერილობით შეთავაზებას.', 'შემდეგი შეხვედრა ორშაბათს 15:00-ზე.'],
  emailDraft: {
    subject: 'შეთავაზება — Google Ads და ვებსაიტი',
    body: 'გამარჯობა ნინო,\n\nმადლობა დღევანდელი საუბრისთვის.\n\nპატივისცემით,\nგიგი',
  },
};

// Local stand-in for the Gemini API that records the request and answers with canned notes
async function withFakeGemini(run: (baseUrl: string, received: { body: string }) => Promise<void>): Promise<void> {
  const received = { body: '' };
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      received.body = Buffer.concat(parts).toString('utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(notes) }] } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, received);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const transcript = '[gigi] გამარჯობა, მე გიგი ვარ, Unitty-ის წარმომადგენელი.\n[ნინო] გამარჯობა, მე ნინო ვარ, მარკეტინგის ხელმძღვანელი.';

test('sends the transcript to the model and returns the notes', async () => {
  await withFakeGemini(async (baseUrl, received) => {
    const result = await buildNotes(transcript, { apiKey: 'k', model: 'gemini-3.8-flash', baseUrl, retryDelayMs: 1 });

    assert.deepEqual(result, notes);
    const body = JSON.parse(received.body);
    const prompt = body.contents[0].parts.map((p: { text?: string }) => p.text ?? '').join('\n');
    assert.match(prompt, /მე გიგი ვარ/);
    assert.match(prompt, /ქართულ/);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
  });
});

test('too little speech is not worth notes', () => {
  assert.equal(MIN_WORDS_FOR_NOTES, 40);
});

test('drafts a follow-up email in the first person', async () => {
  await withFakeGemini(async (baseUrl, received) => {
    const result = await buildNotes(transcript, { apiKey: 'k', model: 'm', baseUrl });

    assert.equal(result.emailDraft?.subject, notes.emailDraft.subject);
    assert.match(result.emailDraft?.body ?? '', /მადლობა დღევანდელი საუბრისთვის/);
    // The model has to be told whose voice to write in, or the mail reads like a report
    assert.match(received.body, /პირველ პირში/);
  });
});

test('a meeting with no email in it still returns the notes', async () => {
  const withoutEmail = { overview: notes.overview, sections: notes.sections, nextSteps: notes.nextSteps };
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(withoutEmail) }] } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const result = await buildNotes(transcript, { apiKey: 'k', model: 'm', baseUrl: `http://127.0.0.1:${port}` });
    assert.equal(result.emailDraft, undefined);
    assert.equal(result.overview, notes.overview);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the email is written by the person whose account this is', async () => {
  await withFakeGemini(async (baseUrl, received) => {
    await buildNotes(transcript, { apiKey: 'k', model: 'm', baseUrl }, 'გიგი გიუნაშვილი');

    // Without being told, the model picks a name out of the transcript and writes as the wrong
    // person — it signed one draft as the customer and addressed it to the account owner
    assert.match(received.body, /გიგი გიუნაშვილი/);
  });
});

// A team talking among themselves has no client to write to. Drafting one anyway produced a letter
// to colleagues that recited the minutes back at them and talked about the reader in the third person.
test('an internal meeting gets no client email', async () => {
  const internal = { ...notes, isClientMeeting: false };
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(internal) }] } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const result = await buildNotes(transcript, { apiKey: 'k', model: 'm', baseUrl: `http://127.0.0.1:${port}` });
    assert.equal(result.emailDraft, undefined);
    assert.equal(result.overview, notes.overview);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the model is told to speak to the reader, not about them, and to keep it short', async () => {
  await withFakeGemini(async (baseUrl, received) => {
    await buildNotes(transcript, { apiKey: 'k', model: 'm', baseUrl }, 'თამარი');
    assert.match(received.body, /მეორე პირში/);
    assert.match(received.body, /isClientMeeting/);
  });
});
