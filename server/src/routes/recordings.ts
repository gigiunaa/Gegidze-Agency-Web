import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';
import { TranscriptionService } from '../services/transcription';
import { SummaryService } from '../services/summary';
import { ClickUpService } from '../services/clickup';
import { config } from '../config';

const execFileAsync = promisify(execFile);

export function createRecordingsRouter(db: DatabaseService): Router {
  const router = Router();
  const transcription = new TranscriptionService(db);
  const summaryService = new SummaryService(db);
  const clickup = new ClickUpService();

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

  // Convert webm to mp4 using ffmpeg. If both mic and speaker exist, merge them.
  async function convertToMp4(micPath: string, speakerPath?: string): Promise<string> {
    const outputPath = micPath.replace(/\.webm$/, '.mp4');

    if (speakerPath && fs.existsSync(speakerPath)) {
      // Merge mic + speaker into one stereo mp4
      await execFileAsync('ffmpeg', [
        '-i', micPath,
        '-i', speakerPath,
        '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=longest[a]',
        '-map', '[a]',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-y', outputPath,
      ]);
    } else {
      // Single track conversion
      await execFileAsync('ffmpeg', [
        '-i', micPath,
        '-c:a', 'aac',
        '-b:a', '128k',
        '-y', outputPath,
      ]);
    }

    console.log(`Converted to MP4: ${outputPath}`);
    return outputPath;
  }

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

      // Background pipeline: transcribe → summarize → convert mp4 → upload to ClickUp → cleanup
      (async () => {
        // 1. Transcribe
        await transcription.transcribe(recording.id);

        // 2. Generate summary
        const trans = await db.getTranscription(meetingId);
        if (trans) {
          console.log('Auto-generating summary...');
          await summaryService.generate(trans.id);
        }

        console.log(`Summary generated for meeting ${meetingId}`);

        // 3. Convert to MP4 and upload to ClickUp
        console.log(`ClickUp configured: ${clickup.isConfigured}`);
        if (clickup.isConfigured) {
          let mp4Path: string | undefined;
          try {
            console.log('Converting to MP4...');
            mp4Path = await convertToMp4(micFile.path, speakerFile?.path);
            console.log(`MP4 ready: ${mp4Path}`);

            // Build summary text for ClickUp task description
            const summary = await db.getSummary(meetingId);
            const updatedMeeting = await db.getMeeting(meetingId);
            const title = updatedMeeting?.title || meeting.title;
            const summaryText = summary
              ? [
                  summary.overview,
                  '',
                  summary.keyPoints.length > 0 ? `Key Points:\n${summary.keyPoints.map(p => `• ${p}`).join('\n')}` : '',
                  '',
                  summary.actionItems.length > 0 ? `Action Items:\n${summary.actionItems.map(a => `• ${a.description}${a.assignee ? ` — ${a.assignee}` : ''}${a.dueDate ? ` (due: ${a.dueDate})` : ''}`).join('\n')}` : '',
                  '',
                  summary.decisions.length > 0 ? `Decisions:\n${summary.decisions.map(d => `• ${d}`).join('\n')}` : '',
                ].filter(Boolean).join('\n')
              : 'No summary available';

            const { taskUrl } = await clickup.createTaskWithAudio(title, summaryText, mp4Path);
            await db.setMeetingClickUpUrl(meetingId, taskUrl);
            console.log(`ClickUp task created for meeting ${meetingId}: ${taskUrl}`);
          } catch (err) {
            console.error('ClickUp upload failed (non-fatal):', err);
          } finally {
            // Delete all local audio files (webm + mp4)
            cleanupFiles(micFile.path, speakerFile?.path, mp4Path);
          }
        } else {
          console.log('ClickUp not configured — skipping upload');
          // Still clean up local files since user doesn't want them stored locally
          cleanupFiles(micFile.path, speakerFile?.path);
        }
      })().catch(async (err) => {
        console.error('Auto-transcription/summary/upload failed:', err);
        await db.updateMeetingStatus(meetingId, 'failed', err instanceof Error ? err.message : String(err));
        // Clean up on failure too
        cleanupFiles(micFile.path, speakerFile?.path);
      });

      return res.json(recording);
    } catch (err) {
      console.error('Upload error:', err);
      return res.status(500).json({ error: 'Upload failed' });
    }
  });

  return router;
}
