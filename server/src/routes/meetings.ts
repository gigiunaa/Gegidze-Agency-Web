import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';

export function createMeetingsRouter(db: DatabaseService): Router {
  const router = Router();

  router.get('/', async (req: AuthRequest, res) => {
    if (req.userRole === 'admin') {
      return res.json(await db.getAllMeetings());
    }
    if (req.userRole === 'manager') {
      const teamId = await db.getUserTeamId(req.userId!);
      if (teamId) {
        return res.json(await db.getMeetingsForTeam(teamId));
      }
    }
    return res.json(await db.getMeetings(req.userId!));
  });

  router.get('/:id', async (req: AuthRequest, res) => {
    const meeting = await db.getMeeting(req.params.id as string);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    if (req.userRole === 'admin') {
      return res.json(meeting);
    }

    if (req.userRole === 'manager') {
      const teamId = await db.getUserTeamId(req.userId!);
      if (teamId) {
        const meetingOwnerTeamId = await db.getUserTeamId(meeting.userId);
        if (meetingOwnerTeamId === teamId) {
          return res.json(meeting);
        }
      }
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

  router.delete('/:id', async (req: AuthRequest, res) => {
    const meeting = await db.getMeeting(req.params.id as string);
    if (!meeting || meeting.userId !== req.userId) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    await db.deleteMeeting(req.params.id as string);
    return res.json({ ok: true });
  });

  return router;
}
