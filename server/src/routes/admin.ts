import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { adminMiddleware, type AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';

export function createAdminRouter(db: DatabaseService): Router {
  const router = Router();
  router.use(adminMiddleware);

  router.get('/users', async (_req: AuthRequest, res) => {
    const users = await db.getUsers();
    res.json(users);
  });

  router.get('/meetings', async (_req: AuthRequest, res) => {
    const meetings = await db.getAllMeetings();
    res.json(meetings);
  });

  router.patch('/users/:id/role', async (req: AuthRequest, res) => {
    const targetId = req.params.id as string;
    const { role } = req.body;

    if (!['user', 'manager', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be user, manager, or admin.' });
    }
    if (targetId === req.userId) {
      return res.status(400).json({ error: 'Cannot change your own role.' });
    }
    const user = await db.getUserById(targetId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    await db.updateUserRole(targetId, role);
    return res.json({ ok: true });
  });

  router.delete('/users/:id', async (req: AuthRequest, res) => {
    const targetId = req.params.id as string;

    if (targetId === req.userId) {
      return res.status(400).json({ error: 'Cannot delete yourself.' });
    }
    const user = await db.getUserById(targetId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    await db.deleteUser(targetId);
    return res.json({ ok: true });
  });

  router.get('/teams', async (_req: AuthRequest, res) => {
    const teams = await db.getTeams();
    res.json(teams);
  });

  router.post('/teams', async (req: AuthRequest, res) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Team name is required.' });
    }
    const team = await db.createTeam(name);
    return res.json(team);
  });

  router.patch('/users/:id/team', async (req: AuthRequest, res) => {
    const targetId = req.params.id as string;
    const { teamId } = req.body;

    const user = await db.getUserById(targetId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    await db.assignUserTeam(targetId, teamId ?? null);
    return res.json({ ok: true });
  });

  router.post('/users/invite', async (req: AuthRequest, res) => {
    try {
      const { email, password, name, role } = req.body;
      if (!email || !password || !name) {
        return res.status(400).json({ error: 'Email, password, and name are required' });
      }
      const existing = await db.getUserByEmail(email);
      if (existing) {
        return res.status(400).json({ error: 'Email already registered' });
      }
      const validRoles = ['user', 'manager', 'admin'];
      const userRole = validRoles.includes(role) ? role : 'user';
      const passwordHash = await bcrypt.hash(password, 12);
      const user = await db.createUser(email, passwordHash, name);
      if (userRole !== user.role) {
        await db.updateUserRole(user.id, userRole);
      }
      return res.json({ ...user, role: userRole });
    } catch (err) {
      console.error('Invite error:', err);
      return res.status(500).json({ error: 'Failed to invite user' });
    }
  });

  router.get('/stats', async (_req: AuthRequest, res) => {
    const users = await db.getUsers();
    const meetings = await db.getAllMeetings();
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
