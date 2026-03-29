import express from 'express';
import cors from 'cors';
import path from 'path';
import { config, projectRoot } from './config';
import { DatabaseService } from './services/database';
import { authMiddleware } from './middleware/auth';
import { createAuthRouter } from './routes/auth';
import { createMeetingsRouter } from './routes/meetings';
import { createRecordingsRouter } from './routes/recordings';
import { createTranscriptionsRouter } from './routes/transcriptions';
import { createSummariesRouter } from './routes/summaries';
import { createSettingsRouter } from './routes/settings';
import { createAdminRouter } from './routes/admin';
import { createZohoRouter } from './routes/zoho';

const app = express();
const db = new DatabaseService();

// Middleware — CORS
const ALLOWED_ORIGINS = [
  'https://gegidze-agency-web-production.up.railway.app',
];
if (process.env.RAILWAY_PUBLIC_DOMAIN) {
  ALLOWED_ORIGINS.push(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
}

app.use(cors({
  credentials: true,
  origin: (origin, callback) => {
    // Allow: same-origin (no origin header), localhost dev, chrome extension, and production domain
    if (
      !origin ||
      origin.startsWith('http://localhost:') ||
      origin.startsWith('chrome-extension://') ||
      ALLOWED_ORIGINS.includes(origin)
    ) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
}));
app.use(express.json({ limit: '50mb' }));

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Simple rate limiter for auth routes (brute-force protection)
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
app.use('/api/auth', (req, res, next) => {
  if (req.method !== 'POST') return next();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (entry && entry.resetAt > now) {
    if (entry.count >= 10) {
      return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }
    entry.count++;
  } else {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 }); // 15 min window
  }
  // Cleanup old entries periodically
  if (loginAttempts.size > 10000) {
    for (const [key, val] of loginAttempts) {
      if (val.resetAt < now) loginAttempts.delete(key);
    }
  }
  next();
});

// Public routes
app.use('/api/auth', createAuthRouter(db));

// Protected routes
app.use('/api/meetings', authMiddleware, createMeetingsRouter(db));
app.use('/api/recordings', authMiddleware, createRecordingsRouter(db));
app.use('/api/transcriptions', authMiddleware, createTranscriptionsRouter(db));
app.use('/api/summaries', authMiddleware, createSummariesRouter(db));
app.use('/api/settings', authMiddleware, createSettingsRouter(db));
app.use('/api/admin', authMiddleware, createAdminRouter(db));
app.use('/api/zoho', authMiddleware, createZohoRouter(db));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Temporary seed endpoint — DELETE AFTER SETUP
app.post('/api/seed-reset', async (req, res) => {
  const secret = req.headers['x-seed-secret'];
  if (secret !== 'gegidze-seed-2026') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const bcrypt = await import('bcryptjs');
    // Delete all users (cascades to meetings, etc.)
    const allUsers = db.getUsers();
    for (const u of allUsers) {
      db.deleteUser(u.id);
    }
    // Create admin user
    const hash = await bcrypt.hash('12345678', 12);
    const user = db.createUser('gg.gegidze@gmail.com', hash, 'Gigi Gegidze');
    // Set role to admin
    db.updateUserRole(user.id, 'admin');
    return res.json({ ok: true, message: 'Database reset. Admin user created.', userId: user.id });
  } catch (err: unknown) {
    console.error('Seed error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

// Serve client static files in production
const clientDist = path.join(projectRoot, 'client/dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(config.port, () => {
  console.log(`Gegidze Agency API running on port ${config.port}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
