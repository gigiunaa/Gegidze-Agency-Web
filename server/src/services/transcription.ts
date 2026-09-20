import fs from 'fs';
import path from 'path';
import type { SpeakerInterval } from '../../../shared/types';
import type { DatabaseService } from './database';
import { config } from '../config';
import { transcribeWithGemini, type TranscriptResult } from './gemini';
import { splitAudio, removeChunks, isSilent, mixTracks, speechIntervals } from './audio-chunks';
import { assignSpeakers } from './transcript-utils';

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

      // Who spoke when: Meet's captions carry names; failing that, which track had sound
      const timeline = await this.speakerTimeline(recording.captions ?? [], ownerName, recording.filePath, hasOthers ? speakerPath : null);
      const segments = assignSpeakers(result.segments, timeline, hasOthers ? 'Participant' : ownerName);

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

  // Captions name everyone (the local user appears as "You"). Without captions, the two
  // tracks still tell the owner apart from the others.
  private async speakerTimeline(captions: SpeakerInterval[], ownerName: string, micPath: string, speakerPath: string | null): Promise<SpeakerInterval[]> {
    if (captions.length > 0) {
      const named = captions.map(c => ({ ...c, name: LOCAL_USER_CAPTION_NAMES.has(c.name) ? ownerName : c.name }));
      const withText = named.filter(c => c.text).length;
      console.log(`Speaker names from captions: ${named.length} intervals, ${new Set(named.map(c => c.name)).size} people, ${withText} with text`);
      return named;
    }

    console.log('No captions — telling speakers apart by which track had sound');
    const mine = (await speechIntervals(micPath)).map(i => ({ ...i, name: ownerName }));
    const theirs = speakerPath ? (await speechIntervals(speakerPath)).map(i => ({ ...i, name: 'Participant' })) : [];
    // The others' track is the cleaner source: the mic also hears them through the speakers
    return [...theirs, ...mine];
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
