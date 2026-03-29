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

// Middleware
app.use(cors({
  credentials: true,
  origin: true,
}));
app.use(express.json({ limit: '50mb' }));

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
