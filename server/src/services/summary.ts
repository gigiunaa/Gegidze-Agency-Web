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
      max_tokens: 8192,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a detailed meeting analyst. Your job is to create comprehensive summaries so that someone who was NOT on the call can fully understand everything that was discussed. Summarize ONLY what is actually said in the transcript. Do NOT invent or hallucinate any information. Be thorough — cover every topic, question, concern, and response. Always respond with valid JSON.',
        },
        {
          role: 'user',
          content: `Analyze the following meeting transcript and provide a comprehensive, detailed summary based ONLY on what was actually said. A team member who was not on this call should be able to read your summary and understand everything that happened.

Return your response as JSON with the following structure:
{
  "overview": "A detailed overview covering all main topics discussed, who said what, and the overall flow of the conversation. Be thorough — write as many sentences as needed to capture the full picture.",
  "keyPoints": ["Detailed key point 1", "Detailed key point 2", ...],
  "actionItems": [{"description": "Specific task description with full context", "assignee": "Person name or null", "dueDate": "Date or null"}],
  "decisions": ["Decision 1 with context of why it was made", "Decision 2", ...]
}

Guidelines:
- Overview should be detailed enough to replace listening to the call
- Key points should capture every important topic, not just the top 3
- Include who proposed what, who agreed/disagreed, and any concerns raised
- If there are no action items or decisions, return empty arrays

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
