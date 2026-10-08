import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Meeting, Transcription, Summary, EmailDraft, ZohoAttachment } from '../../../shared/types';
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
        <EditableTitle meeting={meeting} onRenamed={(title) => setMeeting({ ...meeting, title })} />
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

      {meeting.status === 'failed' && <RetryBanner meeting={meeting} onDone={() => loadData(meeting.id)} />}

      <DownloadRow meeting={meeting} hasTranscript={!!transcription} />

      {transcription && <ZohoSection meeting={meeting} />}

      {notes && <NotesView notes={notes} onEmailSaved={(emailDraft) => setNotes({ ...notes, emailDraft })} />}

      <div className={styles.tabContent}>
        <TranscriptView transcription={transcription} />
      </div>
    </div>
  );
}

// ── Title ─────────────────────────────────────────────────────────────────
// Calls arrive named by the calendar or by the time they started, which rarely says what they
// were about. Clicking the name turns it into a box; Enter keeps it, Escape puts it back.
function EditableTitle({ meeting, onRenamed }: { meeting: Meeting; onRenamed: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(meeting.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function start() {
    setDraft(meeting.title);
    setError('');
    setEditing(true);
  }

  async function save() {
    const title = draft.trim();
    if (!title) { setError('A name is required'); return; }
    if (title === meeting.title) { setEditing(false); return; }
    setSaving(true);
    setError('');
    try {
      const updated = await api.meetings.rename(meeting.id, title);
      onRenamed(updated.title);
      setEditing(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <h1 className={styles.title}>
        <button className={styles.titleButton} onClick={start} title="Rename this call">
          {meeting.title}
          <span className={styles.titlePencil} aria-hidden="true">✎</span>
        </button>
      </h1>
    );
  }

  return (
    <div className={styles.titleEdit}>
      <input
        className={styles.titleInput}
        value={draft}
        autoFocus
        maxLength={200}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <button className={styles.downloadBtn} onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      <button className={styles.titleCancel} onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
      {error && <span className={styles.errorText}>{error}</span>}
    </div>
  );
}

// ── A call that did not make it through ───────────────────────────────────
function RetryBanner({ meeting, onDone }: { meeting: Meeting; onDone: () => void }) {
  const [trying, setTrying] = useState(false);
  const [error, setError] = useState('');

  async function handleRetry() {
    setTrying(true);
    setError('');
    try {
      await api.recordings.retry(meeting.id);
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setTrying(false);
    }
  }

  return (
    <div className={styles.zohoSection}>
      <h3 className={styles.zohoTitle}>This call was not transcribed</h3>
      <p className={styles.emptyText}>{meeting.errorMessage || 'Something went wrong while processing it.'}</p>
      <p className={styles.emptyText}>The audio was kept, so it can be put through again.</p>
      <button className={styles.downloadBtn} onClick={handleRetry} disabled={trying}>
        {trying ? 'Starting...' : 'Try again'}
      </button>
      {error && <p className={styles.errorText}>{error}</p>}
    </div>
  );
}

// ── Downloads: the transcript, and the recording itself ───────────────────
function DownloadRow({ meeting, hasTranscript }: { meeting: Meeting; hasTranscript: boolean }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const safeTitle = meeting.title.replace(/[\\/:*?"<>|]/g, '-');

  async function run(what: string, download: () => Promise<void>) {
    setBusy(what);
    setError('');
    try {
      await download();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className={styles.downloadRow}>
      {hasTranscript && (
        <button
          className={styles.downloadBtn}
          onClick={() => run('word', () => api.transcription.downloadDocx(meeting.id, `${safeTitle}.docx`))}
          disabled={!!busy}
        >
          {busy === 'word' ? 'Preparing...' : 'Download Word'}
        </button>
      )}
      <button
        className={styles.downloadBtn}
        onClick={() => run('audio', () => api.recordings.downloadAudio(meeting.id, `${safeTitle}.webm`))}
        disabled={!!busy}
      >
        {busy === 'audio' ? 'Preparing...' : 'Download recording'}
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
function NotesView({ notes, onEmailSaved }: { notes: Summary; onEmailSaved: (d: EmailDraft) => void }) {
  return (
    <div className={styles.summary}>
      <section className={styles.summarySection}><h3>Summary</h3><p>{notes.overview}</p></section>
      {notes.sections.map((s, i) => (
        <section key={i} className={styles.summarySection}><h3>{s.heading}</h3><p>{s.text}</p></section>
      ))}
      {notes.nextSteps.length > 0 && (
        <section className={styles.summarySection}><h3>Next steps</h3><ul>{notes.nextSteps.map((step, i) => <li key={i}>{step}</li>)}</ul></section>
      )}
      {notes.emailDraft && <EmailDraftView meetingId={notes.meetingId} draft={notes.emailDraft} onSaved={onEmailSaved} />}
      <h3 className={styles.transcriptTitle}>Transcript</h3>
    </div>
  );
}

// ── Follow-up email ───────────────────────────────────────────────────────
// Written from the call, in the voice of whoever was on it. Nothing is sent from here: the
// person reads it, changes what they want — here or in their mail client — and sends it.
function EmailDraftView({ meetingId, draft, onSaved }: { meetingId: string; draft: EmailDraft; onSaved: (d: EmailDraft) => void }) {
  const [copied, setCopied] = useState('');
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function copy(what: 'subject' | 'all', text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      /* a browser that refuses the clipboard still shows the text to select by hand */
    }
  }

  function startEditing() {
    setSubject(draft.subject);
    setBody(draft.body);
    setError('');
    setEditing(true);
  }

  async function save() {
    if (!subject.trim() || !body.trim()) { setError('A subject and a message are both required'); return; }
    setSaving(true);
    setError('');
    try {
      onSaved(await api.summary.updateEmail(meetingId, { subject, body }));
      setEditing(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <section className={styles.emailDraft}>
        <div className={styles.emailHeader}>
          <h3>Follow-up email</h3>
        </div>
        <label className={styles.emailLabel} htmlFor="email-subject">Subject</label>
        <input
          id="email-subject"
          className={styles.emailSubjectInput}
          value={subject}
          maxLength={200}
          disabled={saving}
          onChange={(e) => setSubject(e.target.value)}
        />
        <label className={styles.emailLabel} htmlFor="email-body">Message</label>
        <textarea
          id="email-body"
          className={styles.emailBodyInput}
          value={body}
          rows={Math.min(24, Math.max(8, body.split('\n').length + 2))}
          disabled={saving}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className={styles.emailEditActions}>
          <button className={styles.emailCopyBtn} onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
          <button className={styles.titleCancel} onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
          {error && <span className={styles.errorText}>{error}</span>}
        </div>
      </section>
    );
  }

  return (
    <section className={styles.emailDraft}>
      <div className={styles.emailHeader}>
        <h3>Follow-up email</h3>
        <div className={styles.emailHeaderActions}>
          <button className={styles.titleCancel} onClick={startEditing}>Edit</button>
          <button className={styles.emailCopyBtn} onClick={() => copy('all', [draft.subject, '', draft.body].join('\n'))}>
            {copied === 'all' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <div className={styles.emailSubjectRow}>
        <span className={styles.emailLabel}>Subject</span>
        <span className={styles.emailSubject}>{draft.subject}</span>
        <button className={styles.emailCopySmall} onClick={() => copy('subject', draft.subject)}>
          {copied === 'subject' ? '✓' : 'Copy'}
        </button>
      </div>

      <p className={styles.emailBody}>{draft.body}</p>
    </section>
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
