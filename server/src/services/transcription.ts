import fs from 'fs';
import type { TranscriptSegment } from '../../../shared/types';
import type { DatabaseService } from './database';
import { config } from '../config';
import { transcribeWithGemini, type TranscriptResult } from './gemini';
import { splitAudio, removeChunks } from './audio-chunks';
import { transcriptSimilarity } from './transcript-utils';

// Each track is transcribed in 10-minute pieces
const CHUNK_SECONDS = 600;

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

    const hasSpeakerTrack = !!recording.speakerFilePath && fs.existsSync(recording.speakerFilePath);

    // Mic audio is the user's microphone ("You"); speaker/tab audio is the other participants
    console.log(`Transcribing mic audio${hasSpeakerTrack ? ' and speaker audio' : ''}...`);
    const [micResult, speakerResult] = await Promise.all([
      this.transcribeTrack(recording.filePath),
      hasSpeakerTrack ? this.transcribeTrack(recording.speakerFilePath!) : Promise.resolve(null),
    ]);

    const micSegments: TranscriptSegment[] = micResult.segments.map(seg => ({
      ...seg,
      speaker: 'You',
    }));

    let allSegments = micSegments;

    if (speakerResult) {
      const speakerSegments: TranscriptSegment[] = speakerResult.segments.map(seg => ({
        ...seg,
        speaker: 'Participant',
      }));

      // Check if speaker audio is just a duplicate of mic (user alone on call)
      // Compare texts — if >80% similar, skip speaker segments
      const similarity = transcriptSimilarity(micResult.text, speakerResult.text);
      console.log(`Mic vs Speaker similarity: ${(similarity * 100).toFixed(0)}%`);

      if (similarity < 0.8) {
        // Different content — include both tracks
        allSegments = [...micSegments, ...speakerSegments].sort((a, b) => a.start - b.start);
      } else {
        // Same content — user is alone, only keep mic ("You")
        console.log('Speaker audio matches mic — skipping duplicate (user alone on call)');
      }
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

  // Transcribe one audio track chunk by chunk, with segment times relative to the whole track
  private async transcribeTrack(filePath: string): Promise<TranscriptResult> {
    const chunks = await splitAudio(filePath, CHUNK_SECONDS);
    try {
      const results: TranscriptResult[] = [];
      for (const [index, chunk] of chunks.entries()) {
        results.push(await transcribeWithGemini(chunk, {
          apiKey: config.geminiApiKey,
          model: config.transcriptionModel,
          offsetSeconds: index * CHUNK_SECONDS,
        }));
      }

      return {
        text: results.map(r => r.text).join(' '),
        segments: results.flatMap(r => r.segments),
        language: results[0]?.language ?? 'ka',
      };
    } finally {
      removeChunks(filePath);
    }
  }
}
