import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';
import { buildTranscriptDocx, transcriptFileName } from '../services/transcript-docx';

export function createTranscriptionsRouter(db: DatabaseService): Router {
  const router = Router();

  // Admin/manager can view any meeting, others only their own
  async function accessibleMeeting(req: AuthRequest) {
    const meeting = await db.getMeeting(req.params.meetingId as string);
    if (!meeting) return null;
    if (req.userRole !== 'admin' && req.userRole !== 'manager' && meeting.userId !== req.userId) return null;
    return meeting;
  }

  router.get('/:meetingId', async (req: AuthRequest, res) => {
    const meeting = await accessibleMeeting(req);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const transcription = await db.getTranscription(meeting.id);
    return res.json(transcription);
  });

  // Transcript as a Word document
  router.get('/:meetingId/docx', async (req: AuthRequest, res) => {
    const meeting = await accessibleMeeting(req);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const transcription = await db.getTranscription(meeting.id);
    if (!transcription) {
      return res.status(404).json({ error: 'No transcript for this meeting yet' });
    }

    const notes = await db.getSummary(meeting.id);
    const docx = await buildTranscriptDocx(meeting, transcription, notes);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(transcriptFileName(meeting))}`);
    return res.send(docx);
  });

  return router;
}
