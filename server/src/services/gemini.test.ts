import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { transcribeWithGemini } from './gemini';

interface ReceivedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type GenerateReply = { status: number; json: unknown };

const modelReply = (payload: unknown, finishReason = 'STOP'): GenerateReply => ({
  status: 200,
  json: { candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(payload) }] } }] },
});

// Local stand-in for generativelanguage.googleapis.com: file upload, generateContent, file delete
async function withFakeGemini(
  generateReplies: GenerateReply[],
  run: (baseUrl: string, received: ReceivedRequest[]) => Promise<void>
): Promise<void> {
  const received: ReceivedRequest[] = [];
  const replies = [...generateReplies];

  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      received.push({ method: req.method ?? '', url, headers: req.headers, body: Buffer.concat(parts).toString('utf-8') });
      const { port } = server.address() as AddressInfo;
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };

      if (url === '/upload/v1beta/files') {
        return json(200, {}, { 'x-goog-upload-url': `http://127.0.0.1:${port}/upload-session` });
      }
      if (url === '/upload-session') {
        return json(200, { file: { name: 'files/abc', uri: 'https://files.example/abc', state: 'ACTIVE' } });
      }
      if (url.includes(':generateContent')) {
        const reply = replies.shift() ?? { status: 500, json: { error: 'no more replies queued' } };
        return json(reply.status, reply.json);
      }
      return json(200, {});
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

function tempAudioFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-test-'));
  const filePath = path.join(dir, 'mic.webm');
  fs.writeFileSync(filePath, Buffer.from('fake-audio'));
  return filePath;
}

const twoLines = {
  language: 'ka',
  segments: [
    { start: '00:01', end: '00:03', text: 'გამარჯობა.' },
    { start: '00:04', end: '00:06', text: 'როგორ ხარ?' },
  ],
};

const options = (baseUrl: string) => ({ apiKey: 'test-key', model: 'gemini-3.8-flash', baseUrl, retryDelayMs: 1 });

test('uploads the audio and asks the configured model to transcribe it', async () => {
  await withFakeGemini([modelReply(twoLines)], async (baseUrl, received) => {
    await transcribeWithGemini(tempAudioFile(), options(baseUrl));

    const uploadStart = received.find(r => r.url === '/upload/v1beta/files')!;
    assert.equal(uploadStart.headers['x-goog-api-key'], 'test-key');
    assert.equal(uploadStart.headers['x-goog-upload-header-content-type'], 'audio/webm');

    const upload = received.find(r => r.url === '/upload-session')!;
    assert.equal(upload.body, 'fake-audio');

    const generate = received.find(r => r.url.includes(':generateContent'))!;
    assert.equal(generate.url, '/v1beta/models/gemini-3.8-flash:generateContent');
    assert.equal(generate.headers['x-goog-api-key'], 'test-key');
    const body = JSON.parse(generate.body);
    assert.deepEqual(body.contents[0].parts[0], { file_data: { mime_type: 'audio/webm', file_uri: 'https://files.example/abc' } });
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
  });
});

test('returns the text, language and timed segments from the model', async () => {
  await withFakeGemini([modelReply(twoLines)], async (baseUrl) => {
    const result = await transcribeWithGemini(tempAudioFile(), options(baseUrl));

    assert.deepEqual(result, {
      text: 'გამარჯობა. როგორ ხარ?',
      language: 'ka',
      segments: [
        { start: 1, end: 3, text: 'გამარჯობა.' },
        { start: 4, end: 6, text: 'როგორ ხარ?' },
      ],
    });
  });
});

test('shifts segment times for a chunk from later in the recording', async () => {
  await withFakeGemini([modelReply(twoLines)], async (baseUrl) => {
    const result = await transcribeWithGemini(tempAudioFile(), { ...options(baseUrl), offsetSeconds: 600 });

    assert.deepEqual(result.segments.map(s => s.start), [601, 604]);
  });
});

test('asks again when the model output was cut off', async () => {
  await withFakeGemini([modelReply({ language: 'ka', segments: [] }, 'MAX_TOKENS'), modelReply(twoLines)], async (baseUrl, received) => {
    const result = await transcribeWithGemini(tempAudioFile(), options(baseUrl));

    assert.equal(result.segments.length, 2);
    assert.equal(received.filter(r => r.url.includes(':generateContent')).length, 2);
  });
});

test('asks again when the API is rate limited', async () => {
  await withFakeGemini([{ status: 429, json: { error: { message: 'quota' } } }, modelReply(twoLines)], async (baseUrl) => {
    const result = await transcribeWithGemini(tempAudioFile(), options(baseUrl));

    assert.equal(result.segments.length, 2);
  });
});

test('reports the status and response body when the API rejects the request', async () => {
  await withFakeGemini([{ status: 400, json: { error: { message: 'API key not valid' } } }], async (baseUrl, received) => {
    await assert.rejects(transcribeWithGemini(tempAudioFile(), options(baseUrl)), /400.*API key not valid/);

    assert.equal(received.filter(r => r.url.includes(':generateContent')).length, 1);
  });
});

test('gives up after repeated failures', async () => {
  const cutOff = modelReply({ language: 'ka', segments: [] }, 'MAX_TOKENS');
  await withFakeGemini([cutOff, cutOff, cutOff], async (baseUrl) => {
    await assert.rejects(transcribeWithGemini(tempAudioFile(), options(baseUrl)), /MAX_TOKENS/);
  });
});

test('removes the uploaded audio from Google afterwards', async () => {
  await withFakeGemini([modelReply(twoLines)], async (baseUrl, received) => {
    await transcribeWithGemini(tempAudioFile(), options(baseUrl));

    assert.ok(received.some(r => r.method === 'DELETE' && r.url === '/v1beta/files/abc'));
  });
});

test('refuses to run without an API key', async () => {
  await assert.rejects(
    transcribeWithGemini(tempAudioFile(), { apiKey: '', model: 'gemini-3.8-flash' }),
    /GEMINI_API_KEY/
  );
});
