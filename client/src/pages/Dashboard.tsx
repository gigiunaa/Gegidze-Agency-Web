import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMeetingsStore } from '../stores/meetings';
import { useRecordingStore } from '../stores/recording';
import {
  PageHeader,
  StatCard,
  Card,
  Badge,
  Button,
  EmptyState,
  Skeleton,
} from '../components/ui';
import styles from './Dashboard.module.css';

export function DashboardPage() {
  const { meetings, loading, fetchMeetings } = useMeetingsStore();
  const { isRecording } = useRecordingStore();
  const navigate = useNavigate();

  useEffect(() => {
    fetchMeetings();
  }, [fetchMeetings]);

  const upcoming = meetings.filter((m) => m.status === 'scheduled');
  const completed = meetings.filter((m) => m.status === 'completed');
  const inProgress = meetings.find((m) => m.status === 'recording');

  return (
    <div className={styles.page}>
      <PageHeader
        title="Dashboard"
        subtitle={`${meetings.length} total meetings`}
        actions={
          <div className={styles.quickActions}>
            <Button
              variant="primary"
              size="sm"
              onClick={() => navigate('/recording')}
            >
              Start Recording
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate('/meetings')}
            >
              View All Meetings
            </Button>
          </div>
        }
      />

      {/* Stats row */}
      <div className={styles.statsGrid}>
        <StatCard label="Upcoming" value={upcoming.length} />
        <StatCard label="Completed" value={completed.length} variant="success" />
        <StatCard
          label="Recording"
          value={isRecording ? 'LIVE' : 'Idle'}
          variant={isRecording ? 'recording' : 'default'}
        />
      </div>

      {/* Active recording banner */}
      {inProgress && (
        <Card
          interactive
          className={styles.activeBanner}
          onClick={() =>
            navigate(
              inProgress.calendarSource === 'extension'
                ? `/meetings/${inProgress.id}`
                : '/recording',
            )
          }
        >
          <div className={styles.bannerContent}>
            <span className={styles.recordingDot} />
            <span>
              Recording in progress: <strong>{inProgress.title}</strong>
            </span>
            <span className={styles.viewBtn}>
              {inProgress.calendarSource === 'extension' ? 'Extension' : 'View'}
            </span>
          </div>
        </Card>
      )}

      {/* Main content grid */}
      <div className={styles.contentGrid}>
        {/* Upcoming meetings */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Upcoming Meetings</h2>

          {loading ? (
            <div className={styles.skeletonList}>
              <Skeleton height={64} borderRadius="var(--radius-md)" count={3} />
            </div>
          ) : upcoming.length === 0 ? (
            <EmptyState
              title="No upcoming meetings"
              description="Start a manual recording or sync your calendar to see scheduled meetings here."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => navigate('/recording')}
                >
                  Start Recording
                </Button>
              }
            />
          ) : (
            <div className={styles.meetingList}>
              {upcoming.slice(0, 5).map((meeting) => (
                <Card
                  key={meeting.id}
                  interactive
                  className={styles.meetingCard}
                  onClick={() => navigate(`/meetings/${meeting.id}`)}
                >
                  <div className={styles.meetingInfo}>
                    <span className={styles.meetingTitle}>{meeting.title}</span>
                    <span className={styles.meetingTime}>
                      {new Date(meeting.startTime).toLocaleString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <Badge variant="scheduled">Scheduled</Badge>
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* Recent recordings */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Recent Recordings</h2>

          {loading ? (
            <div className={styles.skeletonList}>
              <Skeleton height={64} borderRadius="var(--radius-md)" count={3} />
            </div>
          ) : completed.length === 0 ? (
            <EmptyState
              title="No recordings yet"
              description="Completed meeting recordings will appear here. Record your first meeting to get started."
            />
          ) : (
            <div className={styles.meetingList}>
              {completed.slice(0, 5).map((meeting) => (
                <Card
                  key={meeting.id}
                  interactive
                  className={styles.meetingCard}
                  onClick={() => navigate(`/meetings/${meeting.id}`)}
                >
                  <div className={styles.meetingInfo}>
                    <span className={styles.meetingTitle}>{meeting.title}</span>
                    <span className={styles.meetingTime}>
                      {new Date(meeting.startTime).toLocaleString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <Badge variant="completed">Completed</Badge>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
