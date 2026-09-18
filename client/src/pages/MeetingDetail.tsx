import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Meeting, Transcription, Summary, ZohoAttachment } from '../../../shared/types';
import styles from './MeetingDetail.module.css';

export function MeetingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [transcription, setTranscription] = useState<Transcription | null>(null);
  const [notes, setNotes] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    loadData(id);
  }, [id]);

  async function loadData(meetingId: string) {
    setLoading(true);
    const [m, t, n] = await Promise.all([
      api.meetings.get(meetingId),
      api.transcription.get(meetingId),
      api.summary.get(meetingId).catch(() => null),
    ]);
    setMeeting(m);
    setTranscription(t);
    setNotes(n);
    setLoading(false);
  }

  if (loading) return <div className={styles.page}><p className={styles.loading}>Loading...</p></div>;
  if (!meeting) return <div className={styles.page}><p>Meeting not found.</p><button onClick={() => navigate('/meetings')}>Back</button></div>;

  return (
    <div className={styles.page}>
      <button className={styles.backBtn} onClick={() => navigate('/meetings')}>&larr; Back</button>

      <div className={styles.header}>
        <h1 className={styles.title}>{meeting.title}</h1>
        <span className={styles.meta}>
          {new Date(meeting.startTime).toLocaleString()} &mdash; {new Date(meeting.endTime).toLocaleTimeString()}
        </span>
        {(meeting.attendees?.length ?? 0) > 0 ? (
          <div className={styles.participants}>
            {meeting.attendees!.map((a) => (
              <span key={a.email} className={styles.participant} title={a.email}>{a.name} — {a.email}</span>
            ))}
          </div>
        ) : meeting.participants.length > 0 && (
          <div className={styles.participants}>
            {meeting.participants.map((p, i) => (<span key={i} className={styles.participant}>{p}</span>))}
          </div>
        )}
      </div>

      {/* ClickUp recording link */}
      {meeting.clickupTaskUrl && (
        <a
          href={meeting.clickupTaskUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.clickupLink}
        >
          ClickUp Recording
        </a>
      )}

      {transcription && <DownloadWordButton meeting={meeting} />}

      {transcription && <ZohoSection meeting={meeting} />}

      {notes && <NotesView notes={notes} />}

      <div className={styles.tabContent}>
        <TranscriptView transcription={transcription} />
      </div>
    </div>
  );
}

// ── Word download ─────────────────────────────────────────────────────────
function DownloadWordButton({ meeting }: { meeting: Meeting }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  async function handleDownload() {
    setDownloading(true);
    setError('');
    try {
      await api.transcription.downloadDocx(meeting.id, `${meeting.title.replace(/[\\/:*?"<>|]/g, '-')}.docx`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className={styles.downloadRow}>
      <button className={styles.downloadBtn} onClick={handleDownload} disabled={downloading}>
        {downloading ? 'Preparing...' : 'Download Word'}
      </button>
      {error && <span className={styles.errorText}>{error}</span>}
    </div>
  );
}

// ── Zoho CRM ──────────────────────────────────────────────────────────────
function ZohoSection({ meeting }: { meeting: Meeting }) {
  const [results, setResults] = useState<ZohoAttachment[] | null>(meeting.zohoAttachments ?? null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  async function handleSend() {
    setSending(true);
    setError('');
    try {
      const res = await api.zoho.attach(meeting.id);
      setResults(res.results);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  const label = (r: ZohoAttachment) =>
    r.status === 'uploaded' ? `${r.name} (${r.module}) — ${r.email}`
      : r.status === 'not_found' ? `${r.email} — not in Zoho`
      : `${r.email} — upload failed`;

  return (
    <div className={styles.zohoSection}>
      <h3 className={styles.zohoTitle}>Zoho CRM</h3>
      {results && results.length > 0 ? (
        <ul className={styles.zohoList}>
          {results.map((r, i) => (
            <li key={i} className={r.status === 'uploaded' ? styles.zohoOk : styles.zohoMiss}>
              {r.status === 'uploaded' ? '✓ ' : '· '}
              {r.url ? (
                <a href={r.url} target="_blank" rel="noopener noreferrer" className={styles.zohoRecordLink}>{label(r)}</a>
              ) : label(r)}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.emptyText}>Not sent to Zoho yet.</p>
      )}
      <button className={styles.downloadBtn} onClick={handleSend} disabled={sending}>
        {sending ? 'Sending...' : results ? 'Send again' : 'Send to Zoho'}
      </button>
      {error && <p className={styles.errorText}>{error}</p>}
    </div>
  );
}

// ── Notes (summary) ───────────────────────────────────────────────────────
function NotesView({ notes }: { notes: Summary }) {
  return (
    <div className={styles.summary}>
      <section className={styles.summarySection}><h3>Summary</h3><p>{notes.overview}</p></section>
      {notes.sections.map((s, i) => (
        <section key={i} className={styles.summarySection}><h3>{s.heading}</h3><p>{s.text}</p></section>
      ))}
      {notes.nextSteps.length > 0 && (
        <section className={styles.summarySection}><h3>Next steps</h3><ul>{notes.nextSteps.map((step, i) => <li key={i}>{step}</li>)}</ul></section>
      )}
      <h3 className={styles.transcriptTitle}>Transcript</h3>
    </div>
  );
}

// ── Transcript View ───────────────────────────────────────────────────────
function TranscriptView({ transcription }: { transcription: Transcription | null }) {
  if (!transcription) return <p className={styles.emptyText}>No transcript available. Transcription may still be processing.</p>;
  return (
    <div className={styles.transcript}>
      {transcription.segments.length > 0 ? (
        transcription.segments.map((seg, i) => (
          <div key={i} className={styles.segment}>
            <span className={styles.timestamp}>{formatTime(seg.start)}</span>
            {seg.speaker && <span className={styles.speaker}>{seg.speaker}</span>}
            <span className={styles.segText}>{seg.text}</span>
          </div>
        ))
      ) : (
        <p className={styles.fullText}>{transcription.fullText}</p>
      )}
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
