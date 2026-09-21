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
import { createGoogleRouter } from './routes/google';

const app = express();
const db = new DatabaseService();

// Middleware — CORS
const ALLOWED_ORIGINS = [
  'https://gegidze-agency-web-production.up.railway.app',
  'https://app.gegidze.com',
];
if (process.env.RAILWAY_PUBLIC_DOMAIN) {
  ALLOWED_ORIGINS.push(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
}

// The extension uploads a call straight from the meeting page: handing a long recording through
// the background worker first was too much data for it to carry.
const CALL_PAGE_ORIGINS = /^https:\/\/(meet\.google\.com|[a-z0-9-]+\.zoom\.us|[a-z0-9-]+\.zoho\.(com|eu))$/;

app.use(cors((req, callback) => {
  const origin = req.headers.origin;
  const ownSite = !origin || origin.startsWith('http://localhost:') || ALLOWED_ORIGINS.includes(origin);
  const extension = !!origin && (origin.startsWith('chrome-extension://') || CALL_PAGE_ORIGINS.test(origin));

  // Cookies are only for this app's own pages. Every request the extension makes carries a
  // bearer token instead, so a meeting page is never trusted to speak for a signed-in user.
  callback(null, { origin: ownSite || extension, credentials: ownSite });
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
// Google Calendar connection (auth is per route: the OAuth callback is a plain browser redirect)
app.use('/api/google', createGoogleRouter(db));

// Health check
app.get('/api/health', async (_req, res) => {
  try {
    await db.testConnection();
    res.json({ status: 'ok', db: 'connected', time: new Date().toISOString() });
  } catch (err: any) {
    res.json({ status: 'ok', db: 'error', dbError: err.message, code: err.code, time: new Date().toISOString() });
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
    console.log(`Unitty Recorder API running on port ${config.port}`);
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
