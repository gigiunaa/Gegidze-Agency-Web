import fs from 'fs';
import path from 'path';
import type { TranscriptSegment } from '../../../shared/types';
import { linesToSegments, type TimedLine } from './transcript-utils';

export interface GeminiOptions {
  apiKey: string;
  model: string;
  // Where this audio chunk starts in the full recording
  offsetSeconds?: number;
  baseUrl?: string;
  retryDelayMs?: number;
}

export interface TranscriptResult {
  text: string;
  segments: TranscriptSegment[];
  language: string;
}

const MAX_ATTEMPTS = 3;

const MIME_TYPES: Record<string, string> = {
  '.webm': 'audio/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
};

const PROMPT = [
  'Transcribe this audio recording verbatim, in the language that is spoken.',
  'Most recordings are informal Georgian business conversations with occasional English or Russian words.',
  'Rules:',
  '- Write Georgian speech ONLY in Georgian script (Mkhedruli). Never mix letters from other alphabets into Georgian words.',
  '- English product names or terms may stay in Latin script (e.g. WhatsApp, ChatGPT).',
  '- Do not translate, summarize, or skip anything. Do not invent speech for silent parts.',
  '- Split the transcript into short segments (a sentence or two each) with start and end times as MM:SS from the beginning of this audio.',
  '- "language" is the ISO 639-1 code of the main spoken language (e.g. "ka", "en").',
  '- If nobody speaks, return an empty segments list.',
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    language: { type: 'STRING' },
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start: { type: 'STRING' },
          end: { type: 'STRING' },
          text: { type: 'STRING' },
        },
        required: ['start', 'end', 'text'],
      },
    },
  },
  required: ['language', 'segments'],
};

class RetryableError extends Error {}

// Gemini (general multimodal model, prompted) — best Georgian quality in our comparison
export async function transcribeWithGemini(filePath: string, options: GeminiOptions): Promise<TranscriptResult> {
  if (!options.apiKey) {
    throw new Error('Gemini API key not configured. Set GEMINI_API_KEY in .env');
  }

  const baseUrl = options.baseUrl ?? 'https://generativelanguage.googleapis.com';
  const mimeType = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'audio/webm';
  const audioBuffer = fs.readFileSync(filePath);

  console.log(`Calling Gemini (${options.model}) for ${path.basename(filePath)} (${audioBuffer.length} bytes)...`);

  const file = await uploadFile(baseUrl, options.apiKey, audioBuffer, mimeType);
  try {
    const parsed = await generateWithRetry(baseUrl, options, file.uri, mimeType);
    const segments = linesToSegments(parsed.segments, options.offsetSeconds ?? 0);
    return {
      text: segments.map(seg => seg.text).join(' '),
      segments,
      language: parsed.language || 'ka',
    };
  } finally {
    // Don't leave call audio in Google's file store
    await fetch(`${baseUrl}/v1beta/${file.name}`, {
      method: 'DELETE',
      headers: { 'x-goog-api-key': options.apiKey },
    }).catch(() => { /* ignore — files expire on their own */ });
  }
}

async function uploadFile(baseUrl: string, apiKey: string, audio: Buffer, mimeType: string): Promise<{ name: string; uri: string }> {
  const start = await fetch(`${baseUrl}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(audio.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'meeting-audio' } }),
  });
  if (!start.ok) {
    throw new Error(`Gemini upload error: ${start.status} - ${await start.text()}`);
  }
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Gemini upload error: no upload URL returned');
  }

  const upload = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: new Blob([audio]),
  });
  if (!upload.ok) {
    throw new Error(`Gemini upload error: ${upload.status} - ${await upload.text()}`);
  }

  let file = (await upload.json() as { file: { name: string; uri: string; state?: string } }).file;
  for (let i = 0; file.state === 'PROCESSING' && i < 30; i++) {
    await sleep(2000);
    const status = await fetch(`${baseUrl}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': apiKey } });
    file = await status.json() as typeof file;
  }
  return file;
}

async function generateWithRetry(
  baseUrl: string,
  options: GeminiOptions,
  fileUri: string,
  mimeType: string
): Promise<{ language: string; segments: TimedLine[] }> {
  let lastError: Error = new Error('Gemini transcription failed');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await generate(baseUrl, options, fileUri, mimeType);
    } catch (err) {
      if (!(err instanceof RetryableError)) throw err;
      lastError = err;
      console.warn(`Gemini attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await sleep((options.retryDelayMs ?? 5000) * attempt);
    }
  }

  throw lastError;
}

async function generate(
  baseUrl: string,
  options: GeminiOptions,
  fileUri: string,
  mimeType: string
): Promise<{ language: string; segments: TimedLine[] }> {
  const response = await fetch(`${baseUrl}/v1beta/models/${options.model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': options.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{ file_data: { mime_type: mimeType, file_uri: fileUri } }, { text: PROMPT }],
      }],
      generationConfig: {
        maxOutputTokens: 65536,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });

  if (!response.ok) {
    const message = `Gemini API error: ${response.status} - ${await response.text()}`;
    // Rate limits and server errors are worth another try; anything else is not
    if (response.status === 429 || response.status >= 500) throw new RetryableError(message);
    throw new Error(message);
  }

  const data = await response.json() as {
    candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  };
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason !== 'STOP') {
    // e.g. MAX_TOKENS when the model gets stuck repeating itself
    throw new RetryableError(`Gemini stopped early: ${candidate?.finishReason ?? 'no candidate'}`);
  }

  const text = (candidate.content?.parts ?? []).filter(p => p.text && !p.thought).map(p => p.text).join('');
  try {
    const parsed = JSON.parse(text) as { language?: string; segments?: TimedLine[] };
    return { language: parsed.language ?? '', segments: parsed.segments ?? [] };
  } catch {
    throw new RetryableError(`Gemini returned unreadable JSON: ${text.slice(0, 200)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
