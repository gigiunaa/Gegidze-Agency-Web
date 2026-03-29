import fs from 'fs';
import path from 'path';
import type { TranscriptSegment } from '../../../shared/types';
import type { DatabaseService } from './database';
import { config } from '../config';

export class TranscriptionService {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  async transcribe(recordingId: string): Promise<void> {
    const recording = await this.db.getRecording(recordingId);
    if (!recording) {
      throw new Error(`Recording not found: ${recordingId}`);
    }

    if (!fs.existsSync(recording.filePath)) {
      throw new Error(`Mic recording file not found: ${recording.filePath}`);
    }

    // Transcribe mic audio (this is the user's microphone — labeled as "You")
    console.log('Transcribing mic audio...');
    const micResult = await this.callWhisperApi(recording.filePath);
    const micSegments: TranscriptSegment[] = micResult.segments.map(seg => ({
      ...seg,
      speaker: 'You',
    }));

    let allSegments = micSegments;

    // Transcribe speaker/tab audio if available (other participants)
    if (recording.speakerFilePath && fs.existsSync(recording.speakerFilePath)) {
      console.log('Transcribing speaker audio...');
      const speakerResult = await this.callWhisperApi(recording.speakerFilePath);
      const speakerSegments: TranscriptSegment[] = speakerResult.segments.map(seg => ({
        ...seg,
        speaker: 'Participant',
      }));

      allSegments = [...micSegments, ...speakerSegments].sort((a, b) => a.start - b.start);
    }

    const fullText = allSegments
      .map(seg => `[${seg.speaker}] ${seg.text}`)
      .join('\n');

    await this.db.createTranscription({
      meetingId: recording.meetingId,
      recordingId: recording.id,
      segments: allSegments,
      fullText,
      language: micResult.language,
    });

    console.log(`Transcription complete for ${recording.meetingId}: ${allSegments.length} segments`);
    await this.db.updateMeetingStatus(recording.meetingId, 'completed');
  }

  private async callWhisperApi(filePath: string): Promise<{
    text: string;
    segments: TranscriptSegment[];
    language: string;
  }> {
    const audioBuffer = fs.readFileSync(filePath);
    const blob = new Blob([audioBuffer], { type: 'audio/webm' });

    const formData = new FormData();
    formData.append('file', blob, path.basename(filePath));
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');

    const apiKey = config.openaiApiKey;
    if (!apiKey) {
      throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY in .env');
    }

    console.log(`Calling Whisper API for ${path.basename(filePath)} (${audioBuffer.length} bytes)...`);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Whisper API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as { text: string; segments?: { start: number; end: number; text: string }[]; language?: string };

    const segments: TranscriptSegment[] = (data.segments ?? []).map(
      (seg) => ({
        start: seg.start,
        end: seg.end,
        text: seg.text.trim(),
      })
    );

    return {
      text: data.text,
      segments,
      language: data.language ?? 'en',
    };
  }
}
