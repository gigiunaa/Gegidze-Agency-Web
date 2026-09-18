import type { NoteSection } from '../../../shared/types';
import type { DatabaseService } from './database';
import { config } from '../config';
import { generateJson, type GeminiOptions } from './gemini';

export interface Notes {
  overview: string;
  sections: NoteSection[];
  nextSteps: string[];
}

// Shorter transcripts (a test call, a hello) don't need notes
export const MIN_WORDS_FOR_NOTES = 40;

const NOTES_SCHEMA = {
  type: 'OBJECT',
  properties: {
    overview: { type: 'STRING' },
    sections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { heading: { type: 'STRING' }, text: { type: 'STRING' } },
        required: ['heading', 'text'],
      },
    },
    nextSteps: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['overview', 'sections', 'nextSteps'],
};

const NOTES_PROMPT = [
  'შენ ბიზნეს-შეხვედრების ჩანაწერებს წერ. ქვემოთ მოცემულია ზარის ტრანსკრიპტი (ხაზის დასაწყისში კვადრატულ ფრჩხილებში მოლაპარაკის სახელია).',
  'დაწერე შეხვედრის ჩანაწერები ქართულ ენაზე, მხოლოდ იმის საფუძველზე, რაც ტრანსკრიპტშია. არაფერი გამოიგონო და არაფერი დაამატო.',
  'ფორმატი:',
  '- overview: 2–3 წინადადება — რაზე იყო საუბარი და რა შედეგით დასრულდა.',
  '- sections: 3–6 თემა. heading — მოკლე სათაური (2–4 სიტყვა); text — 1–3 წინადადება ფაქტებით: რიცხვები, ვადები, სახელები, გადაწყვეტილებები.',
  '- nextSteps: შეთანხმებული შემდეგი ნაბიჯები, ვინ და როდის. თუ არ იყო — ცარიელი სია.',
  'პროდუქტების და კომპანიების სახელები (Google Ads, Zoho, WhatsApp) ლათინურად დატოვე. ტექსტში მხოლოდ ქართული ასოები გამოიყენე, სხვა ანბანის ასოები არ აურიო.',
  '',
  'ტრანსკრიპტი:',
].join('\n');

// Meeting notes in Georgian from the transcript text
export async function buildNotes(transcript: string, options: Pick<GeminiOptions, 'apiKey' | 'model' | 'baseUrl' | 'retryDelayMs'>): Promise<Notes> {
  const result = await generateJson<Partial<Notes>>([{ text: `${NOTES_PROMPT}\n${transcript}` }], NOTES_SCHEMA, options);
  return {
    overview: result.overview?.trim() ?? '',
    sections: (result.sections ?? []).filter(s => s.heading && s.text),
    nextSteps: (result.nextSteps ?? []).filter(Boolean),
  };
}

export class SummaryService {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  async generate(transcriptionId: string): Promise<void> {
    const transcription = await this.db.getTranscriptionById(transcriptionId);
    if (!transcription) {
      throw new Error(`Transcription not found: ${transcriptionId}`);
    }

    const wordCount = transcription.fullText.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount < MIN_WORDS_FOR_NOTES) {
      console.log(`Skipping notes — transcript too short (${wordCount} words)`);
      return;
    }

    console.log(`Writing notes for meeting ${transcription.meetingId} (${wordCount} words)...`);
    const notes = await buildNotes(transcription.fullText, { apiKey: config.geminiApiKey, model: config.transcriptionModel });

    await this.db.createSummary({
      meetingId: transcription.meetingId,
      transcriptionId: transcription.id,
      ...notes,
    });
  }
}
