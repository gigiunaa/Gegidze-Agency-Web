import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';

export function createTranscriptionsRouter(db: DatabaseService): Router {
  const router = Router();

  router.get('/:meetingId', async (req: AuthRequest, res) => {
    const meeting = await db.getMeeting(req.params.meetingId as string);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    // Admin can view any, others only their own
    if (req.userRole !== 'admin' && meeting.userId !== req.userId) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const transcription = await db.getTranscription(req.params.meetingId as string);
    return res.json(transcription);
  });

  return router;
}
