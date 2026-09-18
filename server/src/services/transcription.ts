import fs from 'fs';
import path from 'path';
import type { TranscriptSegment } from '../../../shared/types';
import type { DatabaseService } from './database';
import { config } from '../config';
import { transcribeWithGemini, type TranscriptResult } from './gemini';
import { splitAudio, removeChunks, isSilent } from './audio-chunks';
import { transcriptSimilarity, assignSpeakers } from './transcript-utils';

// Each track is transcribed in 10-minute pieces
const CHUNK_SECONDS = 600;

// How Google Meet captions label the local user, per UI language
const LOCAL_USER_CAPTION_NAMES = new Set(['You', 'თქვენ', 'Вы']);

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

    // Mic track is the account owner; the other track gets names from the meeting captions
    const meeting = await this.db.getMeeting(recording.meetingId);
    const owner = meeting ? await this.db.getUserById(meeting.userId) : undefined;
    const micSegments: TranscriptSegment[] = micResult.segments.map(seg => ({
      ...seg,
      speaker: owner?.name || 'You',
    }));

    let allSegments = micSegments;

    if (speakerResult) {
      // Captions label the local user as "You" (localized) — that speech is on the mic track, not this one
      const others = (recording.captions ?? []).filter(c => !LOCAL_USER_CAPTION_NAMES.has(c.name));
      const speakerSegments = assignSpeakers(speakerResult.segments, others, 'Participant');
      console.log(`Speaker names from captions: ${others.length} intervals, ${new Set(others.map(c => c.name)).size} people`);

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
        // Silence would only tempt the model to invent a conversation
        if (await isSilent(chunk)) {
          console.log(`Chunk ${index + 1}/${chunks.length} of ${path.basename(filePath)} is silent — skipped`);
          continue;
        }
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
