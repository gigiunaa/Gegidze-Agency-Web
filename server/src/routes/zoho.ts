import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';
import { ZohoService, attendeeEmails } from '../services/zoho';
import { attachTranscriptToZoho } from '../services/zoho-attach';
import { enrichMeetingFromCalendar } from '../services/calendar-enrichment';

export function createZohoRouter(db: DatabaseService): Router {
  const router = Router();
  const zoho = new ZohoService();

  // Who on this call is already in the CRM — asked by the extension while recording
  router.get('/lookup/:meetingId', async (req: AuthRequest, res) => {
    let meeting = await db.getMeeting(req.params.meetingId as string);
    if (!meeting || (req.userRole !== 'admin' && req.userRole !== 'manager' && meeting.userId !== req.userId)) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    if (!zoho.isConfigured) {
      return res.json({ matches: [] });
    }

    try {
      // The invite is usually read after the call; do it now so we know who is on this one
      if (!meeting.attendees) meeting = await enrichMeetingFromCalendar(db, meeting);

      const matches: { email: string; name: string; module: string; url: string }[] = [];
      for (const email of attendeeEmails(meeting.attendees ?? [])) {
        for (const record of await zoho.findByEmail(email)) {
          matches.push({ email, name: record.name, module: record.module, url: record.url });
        }
      }
      return res.json({ matches });
    } catch (err) {
      console.error('Zoho lookup error:', err);
      return res.json({ matches: [] });
    }
  });

  // Attach (or re-attach) this meeting's transcript to the participants' CRM records
  router.post('/attach/:meetingId', async (req: AuthRequest, res) => {
    const meeting = await db.getMeeting(req.params.meetingId as string);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    if (req.userRole !== 'admin' && req.userRole !== 'manager' && meeting.userId !== req.userId) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    try {
      await attachTranscriptToZoho(db, meeting);
      const updated = await db.getMeeting(meeting.id);
      return res.json({ results: updated?.zohoAttachments ?? [] });
    } catch (err) {
      console.error('Zoho attach error:', err);
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Zoho attachment failed' });
    }
  });

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
        ...summary.sections.map(s => `${s.heading}\n${s.text}`),
        '',
        summary.nextSteps.length > 0 ? `Next steps:\n${summary.nextSteps.map(step => `• ${step}`).join('\n')}` : '',
        '',
        meeting.clickupTaskUrl ? `[Recording] ${meeting.clickupTaskUrl}` : '',
      ].filter(Boolean).join('\n');

      const result = await zoho.pushSummary(
        leadId,
        summaryText,
        meeting.title,
        new Date(meeting.startTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
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
