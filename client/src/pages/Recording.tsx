import { useState, useEffect, useRef } from 'react';
import { useRecordingStore, currentStream } from '../stores/recording';
import { useMeetingsStore } from '../stores/meetings';
import { api } from '../api/client';
import styles from './Recording.module.css';

function useAudioLevel(stream: MediaStream | null) {
  const [level, setLevel] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!stream) { setLevel(0); return; }
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    function tick() {
      analyser.getByteFrequencyData(data);
      setLevel(data.reduce((a, b) => a + b, 0) / data.length);
      rafRef.current = requestAnimationFrame(tick);
    }
    tick();
    return () => { cancelAnimationFrame(rafRef.current); source.disconnect(); ctx.close(); };
  }, [stream]);

  return level;
}

export function RecordingPage() {
  const { isRecording, durationSeconds, startRecording, stopRecording } = useRecordingStore();
  const audioLevel = useAudioLevel(isRecording ? currentStream : null);
  const { fetchMeetings } = useMeetingsStore();
  const [manualTitle, setManualTitle] = useState('');
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');

  useEffect(() => { loadAudioDevices(); }, []);

  async function loadAudioDevices() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      setAudioDevices(inputs);
      if (inputs.length > 0 && !selectedDeviceId) setSelectedDeviceId(inputs[0].deviceId);
    } catch (err) { console.error('Failed to enumerate devices:', err); }
  }

  async function handleStart() {
    const meeting = await api.meetings.create({
      title: manualTitle || `Recording ${new Date().toLocaleString()}`,
      startTime: new Date().toISOString(),
      endTime: new Date(Date.now() + 3600000).toISOString(),
      calendarSource: 'manual',
      participants: [],
      status: 'scheduled',
    });
    await startRecording(meeting.id, selectedDeviceId || undefined);
  }

  async function handleStop() {
    await stopRecording();
    await fetchMeetings();
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Record</h1>

      {isRecording ? (
        <div className={styles.recordingActive}>
          <div className={styles.visualizer}>
            <div className={styles.pulseRing} />
            <div className={styles.pulseRing} style={{ animationDelay: '0.5s' }} />
            <div className={styles.micIcon}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0" />
                <line x1="12" y1="17" x2="12" y2="22" />
              </svg>
            </div>
          </div>
          <div className={styles.timer}>{formatDuration(durationSeconds)}</div>
          <div className={styles.levelMeter}>
            <div className={styles.levelBar} style={{ width: `${Math.min(100, audioLevel * 1.5)}%` }} />
          </div>
          <p className={styles.recordingLabel}>
            {audioLevel > 2 ? 'Recording in progress' : 'No audio detected — check microphone'}
          </p>
          <button className={styles.stopBtn} onClick={handleStop}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="2" width="12" height="12" rx="2" /></svg>
            Stop Recording
          </button>
        </div>
      ) : (
        <div className={styles.setup}>
          {audioDevices.length > 0 && (
            <div className={styles.deviceSection}>
              <label className={styles.label}>Microphone</label>
              <select className={styles.select} value={selectedDeviceId} onChange={(e) => setSelectedDeviceId(e.target.value)}>
                {audioDevices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 8)}`}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className={styles.label}>Meeting title (optional)</label>
            <input className={styles.input} type="text" placeholder="e.g., Team standup" value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} />
          </div>
          <button className={styles.startBtn} onClick={handleStart}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6" /></svg>
            Start Recording
          </button>
        </div>
      )}
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
