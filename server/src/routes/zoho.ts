import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';
import { ZohoService } from '../services/zoho';

export function createZohoRouter(db: DatabaseService): Router {
  const router = Router();
  const zoho = new ZohoService();

  router.get('/search', async (req: AuthRequest, res) => {
    const query = req.query.q as string;
    if (!query || query.length < 2) {
      return res.json([]);
    }

    try {
      const leads = await zoho.searchLeads(query);
      return res.json(leads);
    } catch (err) {
      console.error('Zoho search error:', err);
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Search failed' });
    }
  });

  router.get('/leads/:leadId/deals', async (req: AuthRequest, res) => {
    try {
      const deals = await zoho.getDealsByLead(req.params.leadId as string);
      return res.json(deals);
    } catch (err) {
      console.error('Zoho deals error:', err);
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get deals' });
    }
  });

  router.post('/push-summary', async (req: AuthRequest, res) => {
    const { meetingId, leadId } = req.body;

    if (!meetingId || !leadId) {
      return res.status(400).json({ error: 'meetingId and leadId are required' });
    }

    try {
      const meeting = await db.getMeeting(meetingId);
      if (!meeting) {
        return res.status(404).json({ error: 'Meeting not found' });
      }

      const summary = await db.getSummary(meetingId);
      if (!summary) {
        return res.status(400).json({ error: 'No summary available for this meeting' });
      }

      const summaryText = [
        summary.overview,
        '',
        summary.keyPoints.length > 0 ? `Key Points:\n${summary.keyPoints.map(p => `• ${p}`).join('\n')}` : '',
        '',
        summary.actionItems.length > 0 ? `Action Items:\n${summary.actionItems.map(a => `• ${a.description}${a.assignee ? ` — ${a.assignee}` : ''}${a.dueDate ? ` (due: ${a.dueDate})` : ''}`).join('\n')}` : '',
        '',
        summary.decisions.length > 0 ? `Decisions:\n${summary.decisions.map(d => `• ${d}`).join('\n')}` : '',
      ].filter(Boolean).join('\n');

      const result = await zoho.pushSummary(
        leadId,
        summaryText,
        meeting.title,
        new Date(meeting.startTime).toLocaleString(),
      );

      await db.setMeetingZohoLead(meetingId, leadId);

      // Update meeting title with lead's first name
      try {
        const leadName = await zoho.getRecordName(leadId);
        if (leadName) {
          const date = new Date(meeting.startTime).toLocaleDateString();
          await db.updateMeetingTitle(meetingId, `${leadName} — ${date}`);
        }
      } catch (err) {
        console.error('Failed to update meeting title from Zoho:', err);
      }

      return res.json({
        ok: true,
        lead: result.lead,
        dealsUpdated: result.deals,
      });
    } catch (err) {
      console.error('Zoho push error:', err);
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Push failed' });
    }
  });

  return router;
}
