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
// How finely a refused piece is cut on each further attempt. Running out of these means the audio
// is left out of the transcript rather than the whole call being thrown away.
const RETRY_SLICE_SECONDS = [120, 30];

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
        results.push(await this.transcribeStubbornly(chunk, index * CHUNK_SECONDS, 0));
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

  // Gemini refuses the odd piece of audio with "blocked: OTHER", and it is not consistent about
  // it: the same ten minutes went through on one run and was refused on the next. Losing a
  // thirty-minute call over one refused piece is not acceptable, so a refusal is answered by
  // cutting that piece up and trying the parts. Smaller pieces get through, and whatever is
  // refused to the end costs seconds of the call instead of all of it.
  private async transcribeStubbornly(chunk: string, offsetSeconds: number, depth: number): Promise<TranscriptResult> {
    try {
      return await transcribeWithGemini(chunk, {
        apiKey: config.geminiApiKey,
        model: config.transcriptionModel,
        offsetSeconds,
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const seconds = RETRY_SLICE_SECONDS[depth];
      if (seconds === undefined) {
        console.error(`Gave up on ${path.basename(chunk)} at ${offsetSeconds}s: ${why}`);
        // Said out loud in the transcript. A silent hole reads as "nobody spoke", which is a
        // worse lie than admitting this half-minute could not be transcribed.
        const marker = { start: offsetSeconds, end: offsetSeconds, text: '[ამ მონაკვეთის გაშიფვრა ვერ მოხერხდა]' };
        return { text: marker.text, segments: [marker], language: 'ka' };
      }

      console.warn(`${path.basename(chunk)} refused (${why}) — cutting it into ${seconds}s pieces and trying again`);
      const pieces = await splitAudio(chunk, seconds);
      try {
        const results: TranscriptResult[] = [];
        for (const [index, piece] of pieces.entries()) {
          if (await isSilent(piece)) continue;
          results.push(await this.transcribeStubbornly(piece, offsetSeconds + index * seconds, depth + 1));
        }
        return {
          text: results.map(r => r.text).join(' '),
          segments: results.flatMap(r => r.segments),
          language: results.find(r => r.segments.length > 0)?.language ?? 'ka',
        };
      } finally {
        removeChunks(chunk);
      }
    }
  }
}
