import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMeetingsStore } from '../stores/meetings';
import { api } from '../api/client';
import type { Meeting, MeetingStatus } from '../../../shared/types';
import type { Column } from '../components/ui';
import {
  PageHeader,
  DataTable,
  Badge,
  SearchInput,
  EmptyState,
  Skeleton,
  Button,
} from '../components/ui';
import styles from './Meetings.module.css';

const STATUSES: { label: string; value: MeetingStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Scheduled', value: 'scheduled' },
  { label: 'Recording', value: 'recording' },
  { label: 'Processing', value: 'processing' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
];

export function MeetingsPage() {
  const { meetings, loading, fetchMeetings } = useMeetingsStore();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<MeetingStatus | 'all'>('all');

  useEffect(() => {
    fetchMeetings();
  }, [fetchMeetings]);

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    await api.meetings.delete(id);
    fetchMeetings();
  }

  const filtered = useMemo(() => {
    let result = meetings;

    if (statusFilter !== 'all') {
      result = result.filter((m) => m.status === statusFilter);
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((m) => m.title.toLowerCase().includes(q));
    }

    return result;
  }, [meetings, search, statusFilter]);

  const columns: Column<Meeting>[] = [
    {
      key: 'title',
      label: 'Meeting',
      width: '2fr',
      render: (row) => <span className={styles.meetingTitle}>{row.title}</span>,
    },
    {
      key: 'startTime',
      label: 'Date',
      width: '1fr',
      render: (row) => (
        <span className={styles.meetingDate}>
          {new Date(row.startTime).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
        </span>
      ),
    },
    {
      key: 'participants',
      label: 'Participants',
      width: '1fr',
      render: (row) => (
        <span className={styles.participants}>
          {row.participants.length > 0
            ? `${row.participants.length} participants`
            : '\u2014'}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      width: '160px',
      render: (row) => (
        <div className={styles.statusCell}>
          <Badge variant={row.status}>{row.status}</Badge>
          {row.status === 'failed' && row.errorMessage && (
            <span className={styles.errorHint} title={row.errorMessage}>
              {row.errorMessage.length > 50
                ? row.errorMessage.slice(0, 50) + '...'
                : row.errorMessage}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className={styles.deleteBtn}
            onClick={(e) => handleDelete(e, row.id)}
            title="Delete meeting"
          >
            ✕
          </Button>
        </div>
      ),
    },
  ];

  /* ─── Loading state ─────────────────────────────────────────────── */
  if (loading) {
    return (
      <div className={styles.page}>
        <PageHeader title="Meetings" />
        <div className={styles.skeletonToolbar}>
          <Skeleton width="280px" height={40} borderRadius="var(--radius-sm)" />
          <Skeleton width="360px" height={32} borderRadius="var(--radius-sm)" />
        </div>
        <Skeleton width="100%" height={48} borderRadius="var(--radius-sm)" count={6} />
      </div>
    );
  }

  /* ─── Empty state (no meetings at all) ──────────────────────────── */
  if (meetings.length === 0) {
    return (
      <div className={styles.page}>
        <PageHeader title="Meetings" />
        <EmptyState
          title="No meetings found"
          description="Start a manual recording to get started."
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader title="Meetings" subtitle={`${meetings.length} total`} />

      {/* ─── Toolbar: search + status filter pills ──────────────── */}
      <div className={styles.toolbar}>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search meetings..."
          className={styles.search}
        />

        <div className={styles.filters}>
          {STATUSES.map((s) => (
            <button
              key={s.value}
              className={`${styles.filterPill} ${statusFilter === s.value ? styles.filterPillActive : ''}`}
              onClick={() => setStatusFilter(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Table or filtered empty ────────────────────────────── */}
      {filtered.length === 0 ? (
        <EmptyState
          title="No matching meetings"
          description="Try adjusting your search or filter."
        />
      ) : (
        <DataTable<Meeting>
          columns={columns}
          data={filtered as (Meeting & Record<string, unknown>)[]}
          onRowClick={(row) => navigate(`/meetings/${row.id}`)}
        />
      )}
    </div>
  );
}
