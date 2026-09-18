// ─── User ──────────────────────────────────────────────────────────
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'manager' | 'admin';
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

// ─── Meeting ────────────────────────────────────────────────────────
export interface Meeting {
  id: string;
  userId: string;
  title: string;
  startTime: string;
  endTime: string;
  calendarSource: 'google' | 'outlook' | 'manual' | 'extension';
  calendarEventId?: string;
  participants: string[];
  status: MeetingStatus;
  errorMessage?: string;
  clickupTaskUrl?: string;
  // Google Meet link of the call (from the extension)
  meetUrl?: string;
  // People invited to the call, from the Google Calendar event
  attendees?: Attendee[];
  createdAt: string;
  updatedAt: string;
}

export interface Attendee {
  name: string;
  email: string;
}

export type MeetingStatus =
  | 'scheduled'
  | 'recording'
  | 'processing'
  | 'completed'
  | 'failed';

// ─── Recording ──────────────────────────────────────────────────────
export interface Recording {
  id: string;
  meetingId: string;
  filePath: string;
  speakerFilePath?: string;
  durationSeconds: number;
  fileSize: number;
  format: 'webm' | 'wav' | 'mp3';
  // Who was speaking when, read from the meeting's live captions (seconds from recording start)
  captions?: SpeakerInterval[];
  createdAt: string;
}

export interface SpeakerInterval {
  name: string;
  start: number;
  end: number;
}

// ─── Transcription ──────────────────────────────────────────────────
export interface Transcription {
  id: string;
  meetingId: string;
  recordingId: string;
  segments: TranscriptSegment[];
  fullText: string;
  language: string;
  createdAt: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

// ─── Summary ────────────────────────────────────────────────────────
export interface Summary {
  id: string;
  meetingId: string;
  transcriptionId: string;
  overview: string;
  keyPoints: string[];
  actionItems: ActionItem[];
  decisions: string[];
  createdAt: string;
}

export interface ActionItem {
  description: string;
  assignee?: string;
  dueDate?: string;
}

// ─── Settings ───────────────────────────────────────────────────────
export interface AppSettings {
  audioSource: 'system' | 'microphone' | 'both';
  autoRecord: boolean;
  transcriptionProvider: 'whisper';
  summaryProvider: 'claude';
  openaiApiKey?: string;
  anthropicApiKey?: string;
  theme: 'light' | 'dark' | 'system';
}
