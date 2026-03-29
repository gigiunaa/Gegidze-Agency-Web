import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from '../config';
import type { Meeting, Recording, Transcription, Summary } from '../../../shared/types';

export class DatabaseService {
  private db: Database.Database;

  constructor() {
    if (!fs.existsSync(config.dataDir)) {
      fs.mkdirSync(config.dataDir, { recursive: true });
    }
    const dbPath = path.join(config.dataDir, 'gegidze.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS meetings (
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        speaker_file_path TEXT,
        duration_seconds REAL NOT NULL DEFAULT 0,
        file_size INTEGER NOT NULL DEFAULT 0,
        format TEXT NOT NULL DEFAULT 'webm',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS transcriptions (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        segments TEXT NOT NULL DEFAULT '[]',
        full_text TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT 'en',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        transcription_id TEXT NOT NULL REFERENCES transcriptions(id) ON DELETE CASCADE,
        overview TEXT NOT NULL DEFAULT '',
        key_points TEXT NOT NULL DEFAULT '[]',
        action_items TEXT NOT NULL DEFAULT '[]',
        decisions TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS settings (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );

      CREATE INDEX IF NOT EXISTS idx_meetings_user ON meetings(user_id);
      CREATE INDEX IF NOT EXISTS idx_recordings_meeting ON recordings(meeting_id);
      CREATE INDEX IF NOT EXISTS idx_transcriptions_meeting ON transcriptions(meeting_id);
      CREATE INDEX IF NOT EXISTS idx_summaries_meeting ON summaries(meeting_id);
    `);

    // Add zoho_lead_id column if it doesn't exist
    try {
      this.db.exec('ALTER TABLE meetings ADD COLUMN zoho_lead_id TEXT');
    } catch {
      // Column already exists
    }

    // Create teams table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Add team_id column to users if it doesn't exist
    try {
      this.db.exec('ALTER TABLE users ADD COLUMN team_id TEXT');
    } catch {
      // Column already exists
    }
  }

  // ─── Users ────────────────────────────────────────────────────────
  createUser(email: string, passwordHash: string, name: string): { id: string; email: string; name: string; role: string } {
    const id = crypto.randomUUID();
    // First user gets admin role
    const userCount = (this.db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
    const role = userCount === 0 ? 'admin' : 'user';
    this.db.prepare('INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)').run(id, email, passwordHash, name, role);
    return { id, email, name, role };
  }

  getUserByEmail(email: string): { id: string; email: string; name: string; role: string; password_hash: string } | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
  }

  getUserById(id: string): { id: string; email: string; name: string; role: string } | undefined {
    return this.db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(id) as any;
  }

  getUsers(): { id: string; email: string; name: string; role: string; createdAt: string }[] {
    const rows = this.db.prepare('SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC').all() as any[];
    return rows.map(r => ({ ...r, createdAt: r.created_at }));
  }

  // ─── Meetings ─────────────────────────────────────────────────────
  getMeetings(userId: string): Meeting[] {
    const rows = this.db.prepare('SELECT * FROM meetings WHERE user_id = ? ORDER BY start_time DESC').all(userId) as Record<string, unknown>[];
    return rows.map(this.rowToMeeting);
  }

  getAllMeetings(): Meeting[] {
    const rows = this.db.prepare('SELECT * FROM meetings ORDER BY start_time DESC').all() as Record<string, unknown>[];
    return rows.map(this.rowToMeeting);
  }

  getMeeting(id: string): Meeting | null {
    const row = this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToMeeting(row) : null;
  }

  createMeeting(userId: string, meeting: Omit<Meeting, 'id' | 'userId' | 'createdAt' | 'updatedAt'>): Meeting {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO meetings (id, user_id, title, start_time, end_time, calendar_source, calendar_event_id, participants, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, meeting.title, meeting.startTime, meeting.endTime, meeting.calendarSource, meeting.calendarEventId ?? null, JSON.stringify(meeting.participants), meeting.status, now, now);
    return this.getMeeting(id)!;
  }

  deleteMeeting(id: string): void {
    this.db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  }

  setMeetingZohoLead(meetingId: string, zohoLeadId: string): void {
    this.db.prepare("UPDATE meetings SET zoho_lead_id = ? WHERE id = ?").run(zohoLeadId, meetingId);
  }

  getMeetingZohoLead(meetingId: string): string | null {
    const row = this.db.prepare("SELECT zoho_lead_id FROM meetings WHERE id = ?").get(meetingId) as { zoho_lead_id: string | null } | undefined;
    return row?.zoho_lead_id ?? null;
  }

  updateMeetingStatus(id: string, status: Meeting['status'], errorMessage?: string): void {
    if (errorMessage) {
      this.db.prepare("UPDATE meetings SET status = ?, error_message = ?, updated_at = datetime('now') WHERE id = ?").run(status, errorMessage, id);
    } else {
      this.db.prepare("UPDATE meetings SET status = ?, error_message = NULL, updated_at = datetime('now') WHERE id = ?").run(status, id);
    }
  }

  // ─── Recordings ───────────────────────────────────────────────────
  createRecording(recording: Omit<Recording, 'id' | 'createdAt'>): Recording {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO recordings (id, meeting_id, file_path, speaker_file_path, duration_seconds, file_size, format)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, recording.meetingId, recording.filePath, recording.speakerFilePath ?? null, recording.durationSeconds, recording.fileSize, recording.format);
    return this.getRecording(id)!;
  }

  getRecording(id: string): Recording | null {
    const row = this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRecording(row) : null;
  }

  getRecordingByMeeting(meetingId: string): Recording | null {
    const row = this.db.prepare('SELECT * FROM recordings WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1').get(meetingId) as Record<string, unknown> | undefined;
    return row ? this.rowToRecording(row) : null;
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
  createTranscription(transcription: Omit<Transcription, 'id' | 'createdAt'>): Transcription {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO transcriptions (id, meeting_id, recording_id, segments, full_text, language)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, transcription.meetingId, transcription.recordingId, JSON.stringify(transcription.segments), transcription.fullText, transcription.language);
    return this.getTranscriptionById(id)!;
  }

  getTranscription(meetingId: string): Transcription | null {
    const row = this.db.prepare('SELECT * FROM transcriptions WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1').get(meetingId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      meetingId: row.meeting_id as string,
      recordingId: row.recording_id as string,
      segments: JSON.parse(row.segments as string),
      fullText: row.full_text as string,
      language: row.language as string,
      createdAt: row.created_at as string,
    };
  }

  getTranscriptionById(id: string): Transcription | null {
    const row = this.db.prepare('SELECT * FROM transcriptions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      meetingId: row.meeting_id as string,
      recordingId: row.recording_id as string,
      segments: JSON.parse(row.segments as string),
      fullText: row.full_text as string,
      language: row.language as string,
      createdAt: row.created_at as string,
    };
  }

  // ─── Summaries ────────────────────────────────────────────────────
  createSummary(summary: Omit<Summary, 'id' | 'createdAt'>): Summary {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO summaries (id, meeting_id, transcription_id, overview, key_points, action_items, decisions)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, summary.meetingId, summary.transcriptionId, summary.overview, JSON.stringify(summary.keyPoints), JSON.stringify(summary.actionItems), JSON.stringify(summary.decisions));
    return this.getSummaryById(id)!;
  }

  getSummary(meetingId: string): Summary | null {
    const row = this.db.prepare('SELECT * FROM summaries WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1').get(meetingId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSummary(row);
  }

  getSummaryById(id: string): Summary | null {
    const row = this.db.prepare('SELECT * FROM summaries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSummary(row);
  }

  private rowToSummary(row: Record<string, unknown>): Summary {
    return {
      id: row.id as string,
      meetingId: row.meeting_id as string,
      transcriptionId: row.transcription_id as string,
      overview: row.overview as string,
      keyPoints: JSON.parse(row.key_points as string),
      actionItems: JSON.parse(row.action_items as string),
      decisions: JSON.parse(row.decisions as string),
      createdAt: row.created_at as string,
    };
  }

  // ─── Settings ─────────────────────────────────────────────────────
  getSettings(userId: string): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings WHERE user_id = ?').all(userId) as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  setSetting(userId: string, key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)').run(userId, key, value);
  }

  // ─── Role & Team Management ─────────────────────────────────────
  updateUserRole(userId: string, role: string): void {
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  }

  deleteUser(userId: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  getTeams(): { id: string; name: string; createdAt: string }[] {
    const rows = this.db.prepare('SELECT id, name, created_at FROM teams ORDER BY created_at DESC').all() as any[];
    return rows.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at }));
  }

  createTeam(name: string): { id: string; name: string; createdAt: string } {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(id, name);
    const row = this.db.prepare('SELECT id, name, created_at FROM teams WHERE id = ?').get(id) as any;
    return { id: row.id, name: row.name, createdAt: row.created_at };
  }

  assignUserTeam(userId: string, teamId: string | null): void {
    this.db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(teamId, userId);
  }

  getTeamMembers(teamId: string): { id: string; email: string; name: string; role: string }[] {
    return this.db.prepare('SELECT id, email, name, role FROM users WHERE team_id = ?').all(teamId) as any[];
  }

  getUserTeamId(userId: string): string | null {
    const row = this.db.prepare('SELECT team_id FROM users WHERE id = ?').get(userId) as { team_id: string | null } | undefined;
    return row?.team_id ?? null;
  }

  getMeetingsForTeam(teamId: string): Meeting[] {
    const rows = this.db.prepare(
      'SELECT m.* FROM meetings m INNER JOIN users u ON m.user_id = u.id WHERE u.team_id = ? ORDER BY m.start_time DESC'
    ).all(teamId) as Record<string, unknown>[];
    return rows.map(this.rowToMeeting);
  }

  close(): void {
    this.db.close();
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
      participants: JSON.parse(row.participants as string),
      status: row.status as Meeting['status'],
      errorMessage: (row.error_message as string) ?? undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
