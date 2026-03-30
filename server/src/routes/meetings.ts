import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';

export function createMeetingsRouter(db: DatabaseService): Router {
  const router = Router();

  router.get('/', async (req: AuthRequest, res) => {
    if (req.userRole === 'admin' || req.userRole === 'manager') {
      return res.json(await db.getAllMeetings());
    }
    return res.json(await db.getMeetings(req.userId!));
  });

  router.get('/:id', async (req: AuthRequest, res) => {
    const meeting = await db.getMeeting(req.params.id as string);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    if (req.userRole === 'admin' || req.userRole === 'manager') {
      return res.json(meeting);
    }

    if (meeting.userId !== req.userId) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    return res.json(meeting);
  });

  router.post('/', async (req: AuthRequest, res) => {
    const { title, startTime, endTime, calendarSource, participants, status } = req.body;
    const meeting = await db.createMeeting(req.userId!, {
      title: title || `Recording ${new Date().toLocaleString()}`,
      startTime: startTime || new Date().toISOString(),
      endTime: endTime || new Date(Date.now() + 3600000).toISOString(),
      calendarSource: calendarSource || 'manual',
      participants: participants || [],
      status: status || 'scheduled',
    });
    res.json(meeting);
  });

  router.patch('/:id/status', async (req: AuthRequest, res) => {
    const meeting = await db.getMeeting(req.params.id as string);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    if (req.userRole !== 'admin' && req.userRole !== 'manager' && meeting.userId !== req.userId) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ error: 'Status required' });
    }
    await db.updateMeetingStatus(req.params.id as string, status);
    return res.json({ ok: true });
  });

  router.delete('/:id', async (req: AuthRequest, res) => {
    const meeting = await db.getMeeting(req.params.id as string);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    if (req.userRole !== 'admin' && req.userRole !== 'manager' && meeting.userId !== req.userId) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    await db.deleteMeeting(req.params.id as string);
    return res.json({ ok: true });
  });

  return router;
}
