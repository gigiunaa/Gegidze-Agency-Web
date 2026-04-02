import { Pool } from 'pg';
import crypto from 'crypto';
import { config } from '../config';
import type { Meeting, Recording, Transcription, Summary } from '../../../shared/types';

export class DatabaseService {
  private pool: Pool;

  constructor() {
    const connStr = config.databaseUrl;
    const needsSsl = connStr.includes('supabase.com') || connStr.includes('neon.tech');

    this.pool = new Pool({
      connectionString: connStr,
      ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      allowExitOnIdle: true,
    });

    this.pool.on('error', (err) => {
      console.error('Unexpected pool error:', err.message);
    });
  }

  private async queryWithRetry(sql: string, params?: unknown[], retries = 3): Promise<any> {
    for (let i = 0; i < retries; i++) {
      try {
        return await this.pool.query(sql, params);
      } catch (err: any) {
        const isTimeout = err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EPIPE';
        if (isTimeout && i < retries - 1) {
          console.warn(`DB query retry ${i + 1}/${retries} after ${err.code}`);
          await new Promise(r => setTimeout(r, 1000 * (i + 1)));
          continue;
        }
        throw err;
      }
    }
  }

  async init(): Promise<void> {
    // Create tables one by one (transaction pooler doesn't support multi-statement queries)
    await this.queryWithRetry(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      team_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await this.queryWithRetry(`CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await this.queryWithRetry(`CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      calendar_source TEXT NOT NULL DEFAULT 'manual',
      calendar_event_id TEXT,
      participants TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'scheduled',
      error_message TEXT,
      zoho_lead_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await this.queryWithRetry(`CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      speaker_file_path TEXT,
      duration_seconds REAL NOT NULL DEFAULT 0,
      file_size INTEGER NOT NULL DEFAULT 0,
      format TEXT NOT NULL DEFAULT 'webm',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await this.queryWithRetry(`CREATE TABLE IF NOT EXISTS transcriptions (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
      segments TEXT NOT NULL DEFAULT '[]',
      full_text TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'en',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await this.queryWithRetry(`CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      transcription_id TEXT NOT NULL REFERENCES transcriptions(id) ON DELETE CASCADE,
      overview TEXT NOT NULL DEFAULT '',
      key_points TEXT NOT NULL DEFAULT '[]',
      action_items TEXT NOT NULL DEFAULT '[]',
      decisions TEXT NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await this.queryWithRetry(`CREATE TABLE IF NOT EXISTS settings (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    )`);

    await this.queryWithRetry(`CREATE INDEX IF NOT EXISTS idx_meetings_user ON meetings(user_id)`);
    await this.queryWithRetry(`CREATE INDEX IF NOT EXISTS idx_recordings_meeting ON recordings(meeting_id)`);
    await this.queryWithRetry(`CREATE INDEX IF NOT EXISTS idx_transcriptions_meeting ON transcriptions(meeting_id)`);
    await this.queryWithRetry(`CREATE INDEX IF NOT EXISTS idx_summaries_meeting ON summaries(meeting_id)`);
  }

  // ─── Users ────────────────────────────────────────────────────────
  async createUser(email: string, passwordHash: string, name: string): Promise<{ id: string; email: string; name: string; role: string }> {
    const id = crypto.randomUUID();
    const countRes = await this.queryWithRetry('SELECT COUNT(*) as count FROM users');
    const role = parseInt(countRes.rows[0].count) === 0 ? 'admin' : 'user';
    await this.queryWithRetry('INSERT INTO users (id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5)', [id, email, passwordHash, name, role]);
    return { id, email, name, role };
  }

  async getUserByEmail(email: string): Promise<{ id: string; email: string; name: string; role: string; password_hash: string } | undefined> {
    const res = await this.queryWithRetry('SELECT * FROM users WHERE email = $1', [email]);
    return res.rows[0];
  }

  async getUserById(id: string): Promise<{ id: string; email: string; name: string; role: string } | undefined> {
    const res = await this.queryWithRetry('SELECT id, email, name, role FROM users WHERE id = $1', [id]);
    return res.rows[0];
  }

  async getUsers(): Promise<{ id: string; email: string; name: string; role: string; createdAt: string }[]> {
    const res = await this.queryWithRetry('SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC');
    return res.rows.map((r: any) => ({ ...r, createdAt: r.created_at }));
  }

  // ─── Meetings ─────────────────────────────────────────────────────
  async getMeetings(userId: string): Promise<Meeting[]> {
    const res = await this.queryWithRetry('SELECT * FROM meetings WHERE user_id = $1 ORDER BY start_time DESC', [userId]);
    return res.rows.map(this.rowToMeeting);
  }

  async getAllMeetings(): Promise<Meeting[]> {
    const res = await this.queryWithRetry('SELECT * FROM meetings ORDER BY start_time DESC');
    return res.rows.map(this.rowToMeeting);
  }

  async getMeeting(id: string): Promise<Meeting | null> {
    const res = await this.queryWithRetry('SELECT * FROM meetings WHERE id = $1', [id]);
    return res.rows[0] ? this.rowToMeeting(res.rows[0]) : null;
  }

  async createMeeting(userId: string, meeting: Omit<Meeting, 'id' | 'userId' | 'createdAt' | 'updatedAt'>): Promise<Meeting> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.queryWithRetry(`
      INSERT INTO meetings (id, user_id, title, start_time, end_time, calendar_source, calendar_event_id, participants, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [id, userId, meeting.title, meeting.startTime, meeting.endTime, meeting.calendarSource, meeting.calendarEventId ?? null, JSON.stringify(meeting.participants), meeting.status, now, now]);
    return (await this.getMeeting(id))!;
  }

  async updateMeetingTitle(id: string, title: string): Promise<void> {
    await this.queryWithRetry('UPDATE meetings SET title = $1, updated_at = NOW() WHERE id = $2', [title, id]);
  }

  async deleteMeeting(id: string): Promise<void> {
    await this.queryWithRetry('DELETE FROM meetings WHERE id = $1', [id]);
  }

  async setMeetingZohoLead(meetingId: string, zohoLeadId: string): Promise<void> {
    await this.queryWithRetry('UPDATE meetings SET zoho_lead_id = $1 WHERE id = $2', [zohoLeadId, meetingId]);
  }

  async getMeetingZohoLead(meetingId: string): Promise<string | null> {
    const res = await this.queryWithRetry('SELECT zoho_lead_id FROM meetings WHERE id = $1', [meetingId]);
    return res.rows[0]?.zoho_lead_id ?? null;
  }

  async updateMeetingStatus(id: string, status: Meeting['status'], errorMessage?: string): Promise<void> {
    if (errorMessage) {
      await this.queryWithRetry('UPDATE meetings SET status = $1, error_message = $2, updated_at = NOW() WHERE id = $3', [status, errorMessage, id]);
    } else {
      await this.queryWithRetry('UPDATE meetings SET status = $1, error_message = NULL, updated_at = NOW() WHERE id = $2', [status, id]);
    }
  }

  // ─── Recordings ───────────────────────────────────────────────────
  async createRecording(recording: Omit<Recording, 'id' | 'createdAt'>): Promise<Recording> {
    const id = crypto.randomUUID();
    await this.queryWithRetry(`
      INSERT INTO recordings (id, meeting_id, file_path, speaker_file_path, duration_seconds, file_size, format)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [id, recording.meetingId, recording.filePath, recording.speakerFilePath ?? null, recording.durationSeconds, recording.fileSize, recording.format]);
    return (await this.getRecording(id))!;
  }

  async getRecording(id: string): Promise<Recording | null> {
    const res = await this.queryWithRetry('SELECT * FROM recordings WHERE id = $1', [id]);
    return res.rows[0] ? this.rowToRecording(res.rows[0]) : null;
  }

  async getRecordingByMeeting(meetingId: string): Promise<Recording | null> {
    const res = await this.queryWithRetry('SELECT * FROM recordings WHERE meeting_id = $1 ORDER BY created_at DESC LIMIT 1', [meetingId]);
    return res.rows[0] ? this.rowToRecording(res.rows[0]) : null;
  }

  private rowToRecording(row: Record<string, unknown>): Recording {
    return {
      id: row.id as string,
      meetingId: row.meeting_id as string,
      filePath: row.file_path as string,
      speakerFilePath: (row.speaker_file_path as string) ?? undefined,
      durationSeconds: row.duration_seconds as number,
      fileSize: row.file_size as number,
      format: row.format as Recording['format'],
      createdAt: row.created_at as string,
    };
  }

  // ─── Transcriptions ──────────────────────────────────────────────
  async createTranscription(transcription: Omit<Transcription, 'id' | 'createdAt'>): Promise<Transcription> {
    const id = crypto.randomUUID();
    await this.queryWithRetry(`
      INSERT INTO transcriptions (id, meeting_id, recording_id, segments, full_text, language)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [id, transcription.meetingId, transcription.recordingId, JSON.stringify(transcription.segments), transcription.fullText, transcription.language]);
    return (await this.getTranscriptionById(id))!;
  }

  async getTranscription(meetingId: string): Promise<Transcription | null> {
    const res = await this.queryWithRetry('SELECT * FROM transcriptions WHERE meeting_id = $1 ORDER BY created_at DESC LIMIT 1', [meetingId]);
    if (!res.rows[0]) return null;
    return this.rowToTranscription(res.rows[0]);
  }

  async getTranscriptionById(id: string): Promise<Transcription | null> {
    const res = await this.queryWithRetry('SELECT * FROM transcriptions WHERE id = $1', [id]);
    if (!res.rows[0]) return null;
    return this.rowToTranscription(res.rows[0]);
  }

  private rowToTranscription(row: Record<string, unknown>): Transcription {
    return {
      id: row.id as string,
      meetingId: row.meeting_id as string,
      recordingId: row.recording_id as string,
      segments: typeof row.segments === 'string' ? JSON.parse(row.segments) : row.segments,
      fullText: row.full_text as string,
      language: row.language as string,
      createdAt: row.created_at as string,
    };
  }

  // ─── Summaries ────────────────────────────────────────────────────
  async createSummary(summary: Omit<Summary, 'id' | 'createdAt'>): Promise<Summary> {
    const id = crypto.randomUUID();
    await this.queryWithRetry(`
      INSERT INTO summaries (id, meeting_id, transcription_id, overview, key_points, action_items, decisions)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [id, summary.meetingId, summary.transcriptionId, summary.overview, JSON.stringify(summary.keyPoints), JSON.stringify(summary.actionItems), JSON.stringify(summary.decisions)]);
    return (await this.getSummaryById(id))!;
  }

  async getSummary(meetingId: string): Promise<Summary | null> {
    const res = await this.queryWithRetry('SELECT * FROM summaries WHERE meeting_id = $1 ORDER BY created_at DESC LIMIT 1', [meetingId]);
    if (!res.rows[0]) return null;
    return this.rowToSummary(res.rows[0]);
  }

  async getSummaryById(id: string): Promise<Summary | null> {
    const res = await this.queryWithRetry('SELECT * FROM summaries WHERE id = $1', [id]);
    if (!res.rows[0]) return null;
    return this.rowToSummary(res.rows[0]);
  }

  private rowToSummary(row: Record<string, unknown>): Summary {
    return {
      id: row.id as string,
      meetingId: row.meeting_id as string,
      transcriptionId: row.transcription_id as string,
      overview: row.overview as string,
      keyPoints: typeof row.key_points === 'string' ? JSON.parse(row.key_points) : row.key_points,
      actionItems: typeof row.action_items === 'string' ? JSON.parse(row.action_items) : row.action_items,
      decisions: typeof row.decisions === 'string' ? JSON.parse(row.decisions) : row.decisions,
      createdAt: row.created_at as string,
    };
  }

  // ─── Settings ─────────────────────────────────────────────────────
  async getSettings(userId: string): Promise<Record<string, string>> {
    const res = await this.queryWithRetry('SELECT key, value FROM settings WHERE user_id = $1', [userId]);
    const result: Record<string, string> = {};
    for (const row of res.rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  async setSetting(userId: string, key: string, value: string): Promise<void> {
    await this.queryWithRetry(
      'INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (user_id, key) DO UPDATE SET value = $3',
      [userId, key, value]
    );
  }

  // ─── Role & Team Management ─────────────────────────────────────
  async updateUserRole(userId: string, role: string): Promise<void> {
    await this.queryWithRetry('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.queryWithRetry('DELETE FROM users WHERE id = $1', [userId]);
  }

  async getTeams(): Promise<{ id: string; name: string; createdAt: string }[]> {
    const res = await this.queryWithRetry('SELECT id, name, created_at FROM teams ORDER BY created_at DESC');
    return res.rows.map((r: any) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
  }

  async createTeam(name: string): Promise<{ id: string; name: string; createdAt: string }> {
    const id = crypto.randomUUID();
    await this.queryWithRetry('INSERT INTO teams (id, name) VALUES ($1, $2)', [id, name]);
    const res = await this.queryWithRetry('SELECT id, name, created_at FROM teams WHERE id = $1', [id]);
    const row = res.rows[0];
    return { id: row.id, name: row.name, createdAt: row.created_at };
  }

  async assignUserTeam(userId: string, teamId: string | null): Promise<void> {
    await this.queryWithRetry('UPDATE users SET team_id = $1 WHERE id = $2', [teamId, userId]);
  }

  async getTeamMembers(teamId: string): Promise<{ id: string; email: string; name: string; role: string }[]> {
    const res = await this.queryWithRetry('SELECT id, email, name, role FROM users WHERE team_id = $1', [teamId]);
    return res.rows;
  }

  async getUserTeamId(userId: string): Promise<string | null> {
    const res = await this.queryWithRetry('SELECT team_id FROM users WHERE id = $1', [userId]);
    return res.rows[0]?.team_id ?? null;
  }

  async getMeetingsForTeam(teamId: string): Promise<Meeting[]> {
    const res = await this.queryWithRetry(
      'SELECT m.* FROM meetings m INNER JOIN users u ON m.user_id = u.id WHERE u.team_id = $1 ORDER BY m.start_time DESC',
      [teamId]
    );
    return res.rows.map(this.rowToMeeting);
  }

  async testConnection(): Promise<void> {
    const res = await this.pool.query('SELECT 1 as ok');
    if (!res.rows[0]) throw new Error('No response from DB');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private rowToMeeting(row: Record<string, unknown>): Meeting {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      title: row.title as string,
      startTime: row.start_time as string,
      endTime: row.end_time as string,
      calendarSource: row.calendar_source as Meeting['calendarSource'],
      calendarEventId: row.calendar_event_id as string | undefined,
      participants: typeof row.participants === 'string' ? JSON.parse(row.participants) : row.participants,
      status: row.status as Meeting['status'],
      errorMessage: (row.error_message as string) ?? undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
