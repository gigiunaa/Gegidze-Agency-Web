import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';

export function createMeetingsRouter(db: DatabaseService): Router {
  const router = Router();

  router.get('/', (req: AuthRequest, res) => {
    if (req.userRole === 'admin') {
      return res.json(db.getAllMeetings());
    }
    if (req.userRole === 'manager') {
      const teamId = db.getUserTeamId(req.userId!);
      if (teamId) {
        return res.json(db.getMeetingsForTeam(teamId));
      }
    }
    return res.json(db.getMeetings(req.userId!));
  });

  router.get('/:id', (req: AuthRequest, res) => {
    const meeting = db.getMeeting(req.params.id as string);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    // Admin can view any meeting
    if (req.userRole === 'admin') {
      return res.json(meeting);
    }

    // Manager can view meetings from their team
    if (req.userRole === 'manager') {
      const teamId = db.getUserTeamId(req.userId!);
      if (teamId) {
        const meetingOwnerTeamId = db.getUserTeamId(meeting.userId);
        if (meetingOwnerTeamId === teamId) {
          return res.json(meeting);
        }
      }
    }

    // Regular users can only view their own meetings
    if (meeting.userId !== req.userId) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    return res.json(meeting);
  });

  router.post('/', (req: AuthRequest, res) => {
    const { title, startTime, endTime, calendarSource, participants, status } = req.body;
    const meeting = db.createMeeting(req.userId!, {
      title: title || `Recording ${new Date().toLocaleString()}`,
      startTime: startTime || new Date().toISOString(),
      endTime: endTime || new Date(Date.now() + 3600000).toISOString(),
      calendarSource: calendarSource || 'manual',
      participants: participants || [],
      status: status || 'scheduled',
    });
    res.json(meeting);
  });

  router.delete('/:id', (req: AuthRequest, res) => {
    const meeting = db.getMeeting(req.params.id as string);
    if (!meeting || meeting.userId !== req.userId) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    db.deleteMeeting(req.params.id as string);
    return res.json({ ok: true });
  });

  return router;
}
