import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';

export function createTranscriptionsRouter(db: DatabaseService): Router {
  const router = Router();

  router.get('/:meetingId', (req: AuthRequest, res) => {
    const meeting = db.getMeeting(req.params.meetingId as string);
    if (!meeting || meeting.userId !== req.userId) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const transcription = db.getTranscription(req.params.meetingId as string);
    return res.json(transcription);
  });

  return router;
}
