import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import type { AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';
import { TranscriptionService } from '../services/transcription';
import { config } from '../config';

export function createRecordingsRouter(db: DatabaseService): Router {
  const router = Router();
  const transcription = new TranscriptionService(db);

  if (!config.geminiApiKey) {
    console.warn('GEMINI_API_KEY is not set — uploaded recordings will fail to transcribe');
  }

  // Ensure uploads directory exists
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

  // Clean up local audio files
  function cleanupFiles(...paths: (string | undefined)[]) {
    for (const p of paths) {
      if (p && fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    }
  }

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

      const recording = await db.createRecording({
        meetingId,
        filePath: micFile.path,
        speakerFilePath: speakerFile?.path,
        durationSeconds: parseFloat(durationSeconds) || 0,
        fileSize: micFile.size + (speakerFile?.size || 0),
        format: 'webm',
      });

      await db.updateMeetingStatus(meetingId, 'processing');

      // Background pipeline: transcribe → cleanup
      (async () => {
        await transcription.transcribe(recording.id);

        // Clean up local files since user doesn't want them stored locally
        cleanupFiles(micFile.path, speakerFile?.path);
      })().catch(async (err) => {
        console.error('Auto-transcription failed:', err);
        await db.updateMeetingStatus(meetingId, 'failed', err instanceof Error ? err.message : String(err));
        // Keep the audio on failure so the call is not lost and can be transcribed again
        console.error(`Audio kept for retry: ${[micFile.path, speakerFile?.path].filter(Boolean).join(', ')}`);
      });

      return res.json(recording);
    } catch (err) {
      console.error('Upload error:', err);
      return res.status(500).json({ error: 'Upload failed' });
    }
  });

  return router;
}
