import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Meeting, Transcription, Summary } from '../../../shared/types';
import styles from './MeetingDetail.module.css';

type Tab = 'transcript' | 'summary';

export function MeetingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [transcription, setTranscription] = useState<Transcription | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('transcript');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    loadData(id);
  }, [id]);

  async function loadData(meetingId: string) {
    setLoading(true);
    const [m, t, s] = await Promise.all([
      api.meetings.get(meetingId),
      api.transcription.get(meetingId),
      api.summary.get(meetingId),
    ]);
    setMeeting(m);
    setTranscription(t);
    setSummary(s);
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
        {meeting.participants.length > 0 && (
          <div className={styles.participants}>
            {meeting.participants.map((p, i) => (<span key={i} className={styles.participant}>{p}</span>))}
          </div>
        )}
      </div>

      {/* Zoho CRM Link */}
      {summary && <ZohoSection meetingId={id!} />}

      <div className={styles.tabs}>
        <button className={`${styles.tab} ${activeTab === 'transcript' ? styles.activeTab : ''}`} onClick={() => setActiveTab('transcript')}>Transcript</button>
        <button className={`${styles.tab} ${activeTab === 'summary' ? styles.activeTab : ''}`} onClick={() => setActiveTab('summary')}>AI Summary</button>
      </div>

      <div className={styles.tabContent}>
        {activeTab === 'transcript' && <TranscriptView transcription={transcription} />}
        {activeTab === 'summary' && <SummaryView summary={summary} />}
      </div>
    </div>
  );
}

// ── Zoho CRM Section ──────────────────────────────────────────────────────
function ZohoSection({ meetingId }: { meetingId: string }) {
  const [leadId, setLeadId] = useState('');
  const [pushing, setPushing] = useState(false);
  const [pushed, setPushed] = useState<{ lead: boolean; deals: string[] } | null>(null);
  const [error, setError] = useState('');

  async function handlePush() {
    const trimmed = leadId.trim();
    if (!trimmed) return;
    setPushing(true);
    setError('');
    try {
      const result = await api.zoho.pushSummary(meetingId, trimmed);
      setPushed({ lead: result.lead, deals: result.dealsUpdated });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPushing(false);
    }
  }

  return (
    <div className={styles.zohoSection}>
      <h3 className={styles.zohoTitle}>Zoho CRM</h3>

      {pushed ? (
        <div className={styles.zohoPushed}>
          <span>✓ Summary sent to Lead</span>
          {pushed.deals.length > 0 && (
            <span> + {pushed.deals.length} Deal{pushed.deals.length > 1 ? 's' : ''}</span>
          )}
        </div>
      ) : (
        <>
          <div className={styles.zohoSearch}>
            <input
              className={styles.zohoInput}
              type="text"
              placeholder="Enter Zoho Lead ID..."
              value={leadId}
              onChange={(e) => setLeadId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handlePush()}
            />
            <button
              className={styles.zohoSendBtn}
              onClick={handlePush}
              disabled={pushing || !leadId.trim()}
            >
              {pushing ? '...' : 'Send'}
            </button>
          </div>

          {error && <p className={styles.errorText}>{error}</p>}
        </>
      )}
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

// ── Summary View ──────────────────────────────────────────────────────────
function SummaryView({ summary }: { summary: Summary | null }) {
  if (!summary) return <p className={styles.emptyText}>Summary is being generated...</p>;
  return (
    <div className={styles.summary}>
      <section className={styles.summarySection}><h3>Overview</h3><p>{summary.overview}</p></section>
      {summary.keyPoints.length > 0 && (
        <section className={styles.summarySection}><h3>Key Points</h3><ul>{summary.keyPoints.map((p, i) => <li key={i}>{p}</li>)}</ul></section>
      )}
      {summary.actionItems.length > 0 && (
        <section className={styles.summarySection}><h3>Action Items</h3><ul>{summary.actionItems.map((item, i) => (
          <li key={i}>{item.description}{item.assignee && <span className={styles.assignee}> — {item.assignee}</span>}{item.dueDate && <span className={styles.dueDate}> (due: {item.dueDate})</span>}</li>
        ))}</ul></section>
      )}
      {summary.decisions.length > 0 && (
        <section className={styles.summarySection}><h3>Decisions</h3><ul>{summary.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul></section>
      )}
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
