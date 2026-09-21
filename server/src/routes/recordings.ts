import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import type { AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';
import type { SpeakerInterval } from '../../../shared/types';
import { TranscriptionService } from '../services/transcription';
import { enrichMeetingFromCalendar } from '../services/calendar-enrichment';
import { SummaryService } from '../services/summary';
import { attachTranscriptToZoho } from '../services/zoho-attach';
import { config } from '../config';

// A call arrives in two requests: the microphone from the meeting page, then the other
// participants from the extension. Processing waits for the second one, but not forever.
const WAIT_FOR_SPEAKER_MS = 3 * 60 * 1000;

// "Who spoke when" sent by the extension as JSON; anything malformed is ignored rather than failing the upload
function parseCaptions(raw: unknown): SpeakerInterval[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is SpeakerInterval =>
        c && typeof c.name === 'string' && c.name.trim() !== '' && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end >= c.start)
      .map(c => ({ name: c.name.trim(), start: c.start, end: c.end, ...(typeof c.text === 'string' && c.text.trim() ? { text: c.text.trim() } : {}) }));
  } catch {
    return [];
  }
}

export function createRecordingsRouter(db: DatabaseService): Router {
  const router = Router();
  const transcription = new TranscriptionService(db);
  const summaryService = new SummaryService(db);
  // Recordings whose pipeline has already been kicked off, so it never runs twice
  const started = new Set<string>();

  if (!config.geminiApiKey) {
    console.warn('GEMINI_API_KEY is not set — uploaded recordings will fail to transcribe');
  }

  if (!fs.existsSync(config.uploadsDir)) {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
  }

  const storage = multer.diskStorage({
    destination: config.uploadsDir,
    filename: (_req, file, cb) => {
      const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname) || '.webm'}`;
      cb(null, uniqueName);
    },
  });

  const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

  function cleanupFiles(...paths: (string | undefined)[]) {
    for (const p of paths) {
      if (p && fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    }
  }

  // Transcript → notes → Zoho. Runs once per recording, in the background.
  function startPipeline(recordingId: string, meetingId: string, reason: string) {
    if (started.has(recordingId)) return;
    started.add(recordingId);
    console.log(`Processing recording ${recordingId} (${reason})`);

    (async () => {
      const meeting = await db.getMeeting(meetingId);
      if (meeting) await enrichMeetingFromCalendar(db, meeting);
      await transcription.transcribe(recordingId);

      // Notes are a bonus on top of the transcript: never fail the meeting over them
      try {
        const trans = await db.getTranscription(meetingId);
        if (trans) await summaryService.generate(trans.id);
      } catch (err) {
        console.error('Notes failed (non-fatal):', err instanceof Error ? err.message : err);
      }

      // Put the transcript on the CRM records of the people who were on the call
      try {
        const updated = await db.getMeeting(meetingId);
        if (updated) await attachTranscriptToZoho(db, updated);
      } catch (err) {
        console.error('Zoho attachment failed (non-fatal):', err instanceof Error ? err.message : err);
      }

      const recording = await db.getRecording(recordingId);
      cleanupFiles(recording?.filePath, recording?.speakerFilePath);
    })().catch(async (err) => {
      console.error('Auto-transcription failed:', err);
      await db.updateMeetingStatus(meetingId, 'failed', err instanceof Error ? err.message : String(err));
      const recording = await db.getRecording(recordingId);
      // Keep the audio on failure so the call is not lost and can be transcribed again
      console.error(`Audio kept for retry: ${[recording?.filePath, recording?.speakerFilePath].filter(Boolean).join(', ')}`);
    });
  }

  // The microphone track, uploaded from the meeting page itself
  router.post('/upload', upload.fields([
    { name: 'mic', maxCount: 1 },
    { name: 'speaker', maxCount: 1 },
  ]), async (req: AuthRequest, res) => {
    try {
      const { meetingId, durationSeconds } = req.body;
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };

      if (!meetingId || !files?.mic?.[0]) {
        return res.status(400).json({ error: 'meetingId and mic audio file are required' });
      }

      const meeting = await db.getMeeting(meetingId);
      if (!meeting || meeting.userId !== req.userId) {
        return res.status(404).json({ error: 'Meeting not found' });
      }

      const micFile = files.mic[0];
      const speakerFile = files.speaker?.[0];
      const expectSpeaker = req.body.expectSpeaker === 'true' && !speakerFile;
      console.log(`Upload received for meeting ${meetingId}: mic ${micFile.size} bytes, speaker ${speakerFile?.size ?? 0} bytes${expectSpeaker ? ' (others still to come)' : ''}${req.body.tabCaptureError ? `, tab capture error: ${req.body.tabCaptureError}` : ''}`);

      const captions = parseCaptions(req.body.captions);
      console.log(`Captions timeline: ${captions.length} intervals`);

      const recording = await db.createRecording({
        meetingId,
        filePath: micFile.path,
        speakerFilePath: speakerFile?.path,
        durationSeconds: parseFloat(durationSeconds) || 0,
        fileSize: micFile.size + (speakerFile?.size || 0),
        format: 'webm',
        captions,
      });

      await db.updateMeetingStatus(meetingId, 'processing');

      if (expectSpeaker) {
        // Don't lose the call if the extension never manages to send the other side
        setTimeout(() => startPipeline(recording.id, meetingId, 'others never arrived'), WAIT_FOR_SPEAKER_MS);
      } else {
        startPipeline(recording.id, meetingId, 'complete upload');
      }

      return res.json(recording);
    } catch (err) {
      console.error('Upload error:', err);
      return res.status(500).json({ error: 'Upload failed' });
    }
  });

  // The other participants' track, uploaded by the extension right after the microphone one
  router.post('/:id/speaker', upload.single('speaker'), async (req: AuthRequest, res) => {
    try {
      const recording = await db.getRecording(req.params.id as string);
      if (!recording || !req.file) {
        return res.status(404).json({ error: 'Recording not found or no file' });
      }
      const meeting = await db.getMeeting(recording.meetingId);
      if (!meeting || meeting.userId !== req.userId) {
        return res.status(404).json({ error: 'Recording not found' });
      }

      console.log(`Others' track received for recording ${recording.id}: ${req.file.size} bytes`);
      await db.setRecordingSpeakerFile(recording.id, req.file.path, req.file.size);
      startPipeline(recording.id, recording.meetingId, 'both tracks in');

      return res.json({ ok: true });
    } catch (err) {
      console.error('Speaker upload error:', err);
      return res.status(500).json({ error: 'Upload failed' });
    }
  });

  return router;
}
