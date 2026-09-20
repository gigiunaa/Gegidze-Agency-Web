import fs from 'fs';
import path from 'path';
import type { SpeakerInterval } from '../../../shared/types';
import type { DatabaseService } from './database';
import { config } from '../config';
import { transcribeWithGemini, type TranscriptResult } from './gemini';
import { splitAudio, removeChunks, isSilent, mixTracks, speechIntervals } from './audio-chunks';
import { assignSpeakers, assignSpeakersWithTracks } from './transcript-utils';

// Each recording is transcribed in 10-minute pieces
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

    const meeting = await this.db.getMeeting(recording.meetingId);
    const owner = meeting ? await this.db.getUserById(meeting.userId) : undefined;
    const ownerName = owner?.name || 'You';

    // One recording of the whole call: the microphone also hears the others through the
    // speakers, so transcribing the two tracks separately produced every sentence twice.
    const speakerPath = recording.speakerFilePath && fs.existsSync(recording.speakerFilePath) ? recording.speakerFilePath : null;
    const hasOthers = !!speakerPath && !(await isSilent(speakerPath));
    const mixedPath = hasOthers ? await mixTracks(recording.filePath, speakerPath!) : null;

    try {
      console.log(hasOthers ? 'Transcribing the mixed call audio...' : 'Transcribing mic audio (nobody else recorded)...');
      const result = await this.transcribeTrack(mixedPath ?? recording.filePath);

      // Who said what. With the others' track we know for certain when the owner was the only
      // one talking; the captions then name the others. Without it, captions alone decide.
      const captions = this.namedCaptions(recording.captions ?? [], ownerName);
      let segments;
      if (hasOthers) {
        const othersTalking = await speechIntervals(speakerPath!);
        console.log(`Others' track: ${othersTalking.length} stretches of sound`);
        segments = assignSpeakersWithTracks(result.segments, captions, ownerName, othersTalking);
      } else {
        segments = assignSpeakers(result.segments, captions, ownerName);
      }

      const fullText = segments.map(seg => `[${seg.speaker}] ${seg.text}`).join('\n');
      await this.db.createTranscription({
        meetingId: recording.meetingId,
        recordingId: recording.id,
        segments,
        fullText,
        language: result.language,
      });

      console.log(`Transcription complete for ${recording.meetingId}: ${segments.length} segments`);
      await this.db.updateMeetingStatus(recording.meetingId, 'completed');
    } finally {
      if (mixedPath) fs.rmSync(mixedPath, { force: true });
    }
  }

  // Captions label the local user "You" (localised); everyone else appears by name
  private namedCaptions(captions: SpeakerInterval[], ownerName: string): SpeakerInterval[] {
    const named = captions.map(c => ({ ...c, name: LOCAL_USER_CAPTION_NAMES.has(c.name) ? ownerName : c.name }));
    const withText = named.filter(c => c.text).length;
    console.log(`Captions: ${named.length} intervals, ${new Set(named.map(c => c.name)).size} people, ${withText} with text`);
    return named;
  }

  // Transcribe one audio file chunk by chunk, with segment times relative to the whole file
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
