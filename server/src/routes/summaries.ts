import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';
import { SummaryService } from '../services/summary';

export function createSummariesRouter(db: DatabaseService): Router {
  const router = Router();
  const summaryService = new SummaryService(db);

  router.get('/:meetingId', async (req: AuthRequest, res) => {
    const meeting = await db.getMeeting(req.params.meetingId as string);
    if (!meeting || meeting.userId !== req.userId) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const summary = await db.getSummary(req.params.meetingId as string);
    return res.json(summary);
  });

  router.post('/generate', async (req: AuthRequest, res) => {
    try {
      const { transcriptionId } = req.body;
      if (!transcriptionId) {
        return res.status(400).json({ error: 'transcriptionId is required' });
      }
      await summaryService.generate(transcriptionId);
      return res.json({ success: true });
    } catch (err) {
      console.error('Summary generation error:', err);
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Summary generation failed' });
    }
  });

  return router;
}
