import OpenAI from 'openai';
import type { ActionItem } from '../../../shared/types';
import type { DatabaseService } from './database';
import { config } from '../config';

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

    // Skip summary if transcript is too short (less than 20 words)
    const wordCount = transcription.fullText.trim().split(/\s+/).length;
    if (wordCount < 20) {
      console.log(`Skipping summary — transcript too short (${wordCount} words)`);
      return;
    }

    const apiKey = config.openaiApiKey;
    if (!apiKey) {
      throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY in .env');
    }

    const client = new OpenAI({ apiKey });

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a meeting assistant. Summarize ONLY what is actually said in the transcript. Do NOT invent, assume, or hallucinate any information that is not explicitly present in the transcript. If the transcript is too short or unclear to generate a meaningful summary, return minimal results. Always respond with valid JSON.',
        },
        {
          role: 'user',
          content: `Analyze the following meeting transcript and provide a structured summary based ONLY on what was actually said. Do not make up any information.

Return your response as JSON with the following structure:
{
  "overview": "A 2-3 sentence overview of what was actually discussed",
  "keyPoints": ["Key point 1", "Key point 2", ...],
  "actionItems": [{"description": "Task description", "assignee": "Person name or null", "dueDate": "Date or null"}],
  "decisions": ["Decision 1", "Decision 2", ...]
}

If there are no action items or decisions, return empty arrays.

Transcript:
${transcription.fullText}`,
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No response from GPT');
    }

    const parsed = JSON.parse(content) as {
      overview: string;
      keyPoints: string[];
      actionItems: ActionItem[];
      decisions: string[];
    };

    await this.db.createSummary({
      meetingId: transcription.meetingId,
      transcriptionId: transcription.id,
      overview: parsed.overview,
      keyPoints: parsed.keyPoints,
      actionItems: parsed.actionItems,
      decisions: parsed.decisions,
    });
  }
}
