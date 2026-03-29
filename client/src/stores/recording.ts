import { create } from 'zustand';
import { api } from '../api/client';

let micRecorder: MediaRecorder | null = null;
let micChunks: Blob[] = [];

export let currentStream: MediaStream | null = null;

interface RecordingState {
  isRecording: boolean;
  meetingId: string | null;
  durationSeconds: number;
  error: string | null;
  startRecording: (meetingId: string, deviceId?: string) => Promise<void>;
  stopRecording: () => Promise<void>;
}

function createMediaRecorder(stream: MediaStream, chunks: Blob[]): MediaRecorder {
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  const recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  return recorder;
}

let timerInterval: ReturnType<typeof setInterval> | null = null;
let startTime = 0;

export const useRecordingStore = create<RecordingState>((set, get) => ({
  isRecording: false,
  meetingId: null,
  durationSeconds: 0,
  error: null,

  startRecording: async (meetingId: string, deviceId?: string) => {
    try {
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 48000,
      };
      if (deviceId) {
        audioConstraints.deviceId = { exact: deviceId };
      }

      currentStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });

      micChunks = [];
      micRecorder = createMediaRecorder(currentStream, micChunks);
      micRecorder.start(1000);

      startTime = Date.now();
      timerInterval = setInterval(() => {
        set({ durationSeconds: Math.floor((Date.now() - startTime) / 1000) });
      }, 1000);

      set({ isRecording: true, meetingId, durationSeconds: 0, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start recording';
      set({ error: message });
      throw err;
    }
  },

  stopRecording: async () => {
    const { meetingId } = get();

    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    // Stop recorder
    await new Promise<void>((resolve) => {
      if (micRecorder && micRecorder.state !== 'inactive') {
        micRecorder.onstop = () => resolve();
        micRecorder.stop();
      } else {
        resolve();
      }
    });

    // Stop tracks
    if (currentStream) {
      currentStream.getTracks().forEach((track) => track.stop());
      currentStream = null;
    }
    micRecorder = null;

    // Upload to server
    if (meetingId && micChunks.length > 0) {
      const micBlob = new Blob(micChunks, { type: 'audio/webm;codecs=opus' });
      const formData = new FormData();
      formData.append('mic', micBlob, 'recording.webm');
      formData.append('meetingId', meetingId);
      formData.append('durationSeconds', String(Math.floor((Date.now() - startTime) / 1000)));

      try {
        await api.recordings.upload(formData);
      } catch (err) {
        console.error('Upload failed:', err);
      }
    }

    micChunks = [];
    set({ isRecording: false, meetingId: null, durationSeconds: 0 });
  },
}));
