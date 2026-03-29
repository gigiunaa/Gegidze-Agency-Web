import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';

export function createSettingsRouter(db: DatabaseService): Router {
  const router = Router();

  router.get('/', async (req: AuthRequest, res) => {
    const settings = await db.getSettings(req.userId!);
    res.json(settings);
  });

  router.patch('/', async (req: AuthRequest, res) => {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      await db.setSetting(req.userId!, key, String(value));
    }
    const settings = await db.getSettings(req.userId!);
    res.json(settings);
  });

  return router;
}
