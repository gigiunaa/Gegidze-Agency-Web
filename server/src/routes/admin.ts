import { Router } from 'express';
import { adminMiddleware, type AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';

export function createAdminRouter(db: DatabaseService): Router {
  const router = Router();
  router.use(adminMiddleware);

  // List all users
  router.get('/users', (_req: AuthRequest, res) => {
    const users = db.getUsers();
    res.json(users);
  });

  // Get all meetings (across all users)
  router.get('/meetings', (_req: AuthRequest, res) => {
    const meetings = db.getAllMeetings();
    res.json(meetings);
  });

  // Change user role
  router.put('/users/:id/role', (req: AuthRequest, res) => {
    const targetId = req.params.id as string;
    const { role } = req.body;

    if (!['user', 'manager', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be user, manager, or admin.' });
    }
    if (targetId === req.userId) {
      return res.status(400).json({ error: 'Cannot change your own role.' });
    }
    const user = db.getUserById(targetId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    db.updateUserRole(targetId, role);
    return res.json({ ok: true });
  });

  // Delete user
  router.delete('/users/:id', (req: AuthRequest, res) => {
    const targetId = req.params.id as string;

    if (targetId === req.userId) {
      return res.status(400).json({ error: 'Cannot delete yourself.' });
    }
    const user = db.getUserById(targetId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    db.deleteUser(targetId);
    return res.json({ ok: true });
  });

  // List all teams
  router.get('/teams', (_req: AuthRequest, res) => {
    const teams = db.getTeams();
    res.json(teams);
  });

  // Create team
  router.post('/teams', (req: AuthRequest, res) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Team name is required.' });
    }
    const team = db.createTeam(name);
    return res.json(team);
  });

  // Assign user to team
  router.put('/users/:id/team', (req: AuthRequest, res) => {
    const targetId = req.params.id as string;
    const { teamId } = req.body;

    const user = db.getUserById(targetId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    db.assignUserTeam(targetId, teamId ?? null);
    return res.json({ ok: true });
  });

  // Get stats
  router.get('/stats', (_req: AuthRequest, res) => {
    const users = db.getUsers();
    const meetings = db.getAllMeetings();
    const completed = meetings.filter(m => m.status === 'completed').length;
    const failed = meetings.filter(m => m.status === 'failed').length;

    res.json({
      totalUsers: users.length,
      totalMeetings: meetings.length,
      completedMeetings: completed,
      failedMeetings: failed,
    });
  });

  return router;
}
