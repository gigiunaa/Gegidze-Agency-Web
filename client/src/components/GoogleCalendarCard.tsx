import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Card, Button } from './ui';
import styles from './GoogleCalendarCard.module.css';

// Connect the user's Google account so call transcripts get the invited people's names and emails
export function GoogleCalendarCard() {
  const [status, setStatus] = useState<{ configured: boolean; connected: boolean; email: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.google.status().then(setStatus).catch(() => setStatus(null));

    // Google sends the browser back to /?google=connected|error after the consent screen
    const params = new URLSearchParams(window.location.search);
    if (params.get('google') === 'error') {
      setError(`Google connection failed: ${params.get('reason') || 'unknown error'}`);
    }
    if (params.has('google')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  async function connect() {
    setBusy(true);
    setError('');
    try {
      const { url } = await api.google.connect();
      window.location.href = url;
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.google.disconnect();
      setStatus((s) => (s ? { ...s, connected: false, email: null } : s));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!status || !status.configured) return null;

  return (
    <Card className={styles.card}>
      <div className={styles.text}>
        <span className={styles.title}>Google Calendar</span>
        <span className={styles.subtitle}>
          {status.connected
            ? `Connected as ${status.email}. Transcripts include the invited people's names and emails.`
            : 'Connect once, and every call transcript gets the invited people\'s names and emails from the invite.'}
        </span>
        {error && <span className={styles.error}>{error}</span>}
      </div>
      {status.connected ? (
        <Button variant="secondary" size="sm" onClick={disconnect} disabled={busy}>Disconnect</Button>
      ) : (
        <Button variant="primary" size="sm" onClick={connect} disabled={busy}>Connect Google Calendar</Button>
      )}
    </Card>
  );
}
