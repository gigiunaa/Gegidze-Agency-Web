import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';
import { SummaryService } from '../services/summary';

export function createSummariesRouter(db: DatabaseService): Router {
  const router = Router();
  const summaryService = new SummaryService(db);

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

  // The follow-up email arrived after these meetings were summarised. This writes one for each
  // of them, from the transcript that is already stored — nothing is transcribed again.
  router.post('/backfill-emails', async (req: AuthRequest, res) => {
    if (req.userRole !== 'admin') return res.status(404).json({ error: 'Not found' });

    const pending = await db.summariesWithoutEmail();
    console.log(`Backfilling email drafts for ${pending.length} meeting(s)`);
    res.json({ started: pending.length });

    // Answered before the work starts: writing thirty drafts takes minutes, and a request left
    // hanging that long is dropped by the proxy long before it finishes.
    void (async () => {
      let written = 0;
      for (const row of pending) {
        try {
          await summaryService.generate(row.transcriptionId);
          written++;
        } catch (err) {
          console.error(`Draft failed for ${row.meetingId}: ${err instanceof Error ? err.message : err}`);
        }
      }
      console.log(`Email drafts written: ${written}/${pending.length}`);
    })();
  });

  router.get('/:meetingId', async (req: AuthRequest, res) => {
    const meeting = await db.getMeeting(req.params.meetingId as string);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    if (req.userRole !== 'admin' && req.userRole !== 'manager' && meeting.userId !== req.userId) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const summary = await db.getSummary(req.params.meetingId as string);
    return res.json(summary);
  });

  return router;
}
