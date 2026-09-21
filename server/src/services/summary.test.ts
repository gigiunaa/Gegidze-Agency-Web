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
