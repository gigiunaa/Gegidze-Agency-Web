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
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
  }
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
app.get('/api/health', async (_req, res) => {
  try {
    await db.testConnection();
    res.json({ status: 'ok', db: 'connected', time: new Date().toISOString() });
  } catch (err: any) {
    res.json({ status: 'ok', db: 'error', dbError: err.message, code: err.code, time: new Date().toISOString() });
  }
});

// Debug endpoint (temporary)
app.get('/api/debug', async (_req, res) => {
  try {
    const meetings = await db.getAllMeetings();
    const recent = meetings.slice(0, 5).map(m => ({
      id: m.id,
      title: m.title,
      status: m.status,
      error: m.errorMessage,
      created: m.createdAt,
    }));
    const users = await db.getUsers();
    res.json({
      hasOpenAIKey: !!config.openaiApiKey,
      openAIKeyPrefix: config.openaiApiKey ? config.openaiApiKey.substring(0, 7) + '...' : 'NOT SET',
      uploadsDir: config.uploadsDir,
      users: users.map(u => ({ email: u.email, name: u.name, role: u.role })),
      recentMeetings: recent,
    });
  } catch (err: any) {
    res.json({ error: err.message });
  }
});

// Serve client static files in production
const clientDist = path.join(projectRoot, 'client/dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// Start server first, then init database
async function start() {
  const server = app.listen(config.port, () => {
    console.log(`Gegidze Agency API running on port ${config.port}`);
  });

  try {
    await db.init();
    console.log('Database connected and initialized');
  } catch (err) {
    console.error('Database init failed:', err);
    console.error('Server running but database unavailable — check DATABASE_URL');
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await db.close();
    server.close();
    process.exit(0);
  });
}

start();
