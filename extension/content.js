// Content script — runs on Google Meet, Zoom, Zoho pages
// Handles microphone + tab audio recording

let mediaRecorder = null;
let speakerRecorder = null;
let chunks = [];
let speakerChunks = [];
let currentMeetingId = null;
let timerInterval = null;
let recordingStartTime = null;
let micStream = null;
let speakerStream = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'CALL_DETECTED':
      showCallBanner(msg.platform);
      break;
    case 'START_RECORDING':
      startRecording(msg.meetingId, msg.tabStreamId);
      break;
    case 'STOP_RECORDING':
      stopRecording();
      break;
  }
});

// ── Recording ─────────────────────────────────────────────────────────────
async function startRecording(meetingId, tabStreamId) {
  try {
    currentMeetingId = meetingId;
    chunks = [];
    speakerChunks = [];

    // 1. Record microphone (user's voice)
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 48000,
      },
    });
    console.log('[Gegidze] Mic stream obtained');

    mediaRecorder = new MediaRecorder(micStream, {
      mimeType: 'audio/webm;codecs=opus',
    });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    // 2. Record tab audio (other participants) if available
    if (tabStreamId) {
      try {
        speakerStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: tabStreamId,
            },
          },
        });
        console.log('[Gegidze] Tab audio stream obtained');

        speakerRecorder = new MediaRecorder(speakerStream, {
          mimeType: 'audio/webm;codecs=opus',
        });
        speakerRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) speakerChunks.push(e.data);
        };
        speakerRecorder.start(1000);
      } catch (tabErr) {
        console.warn('[Gegidze] Tab audio capture failed:', tabErr.message);
        speakerRecorder = null;
        speakerStream = null;
      }
    }

    // When mic recording stops, upload both tracks
    mediaRecorder.onstop = async () => {
      // Stop speaker recorder too
      if (speakerRecorder && speakerRecorder.state !== 'inactive') {
        speakerRecorder.stop();
        // Wait a bit for final chunks
        await new Promise(r => setTimeout(r, 200));
      }

      const micBlob = new Blob(chunks, { type: 'audio/webm' });
      const speakerBlob = speakerChunks.length > 0 ? new Blob(speakerChunks, { type: 'audio/webm' }) : null;

      console.log(`[Gegidze] Mic: ${micBlob.size} bytes, Speaker: ${speakerBlob?.size || 0} bytes`);

      const micArray = Array.from(new Uint8Array(await micBlob.arrayBuffer()));
      const speakerArray = speakerBlob ? Array.from(new Uint8Array(await speakerBlob.arrayBuffer())) : null;
      const savedMeetingId = currentMeetingId;

      chrome.runtime.sendMessage({
        type: 'UPLOAD_AUDIO',
        audioData: micArray,
        speakerData: speakerArray,
        meetingId: savedMeetingId,
      }, (response) => {
        if (response?.error) {
          showNotification(`Gegidze: Upload failed — ${response.error}`, 'error');
        } else {
          showNotification('Gegidze: Recording uploaded. Transcript is being created.', 'success');
        }
      });

      // Cleanup streams
      micStream?.getTracks().forEach(t => t.stop());
      speakerStream?.getTracks().forEach(t => t.stop());
      chunks = [];
      speakerChunks = [];
      micStream = null;
      speakerStream = null;
      currentMeetingId = null;
    };

    mediaRecorder.start(1000);
    console.log('[Gegidze] Recording started for meeting', meetingId);

    removeBanner();
    showRecordingIndicator();
  } catch (err) {
    console.error('[Gegidze] Recording failed:', err);
    alert('Gegidze: Microphone access denied. Please allow microphone access and try again.');
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    console.log('[Gegidze] Recording stopped');
  }
  removeRecordingIndicator();
}

// ── UI: Call detected banner ──────────────────────────────────────────────
function showCallBanner(platform) {
  if (document.getElementById('gegidze-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'gegidze-banner';
  banner.innerHTML = `
    <div style="
      position: fixed; top: 20px; right: 20px; z-index: 999999;
      background: linear-gradient(135deg, #1a1a2e, #12121f);
      border: 1px solid #7b6cf6; border-radius: 14px;
      padding: 20px 24px; color: #e8e6f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px; min-width: 280px;
      box-shadow: 0 8px 32px rgba(123, 108, 246, 0.35);
      animation: gegidze-in 0.35s ease-out;
    ">
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 14px;">
        <span style="font-size: 22px;">🎙️</span>
        <div>
          <div style="font-weight: 700; font-size: 15px;">Gegidze Recorder</div>
          <div style="color: #8b89a0; font-size: 12px; margin-top: 2px;">${platform} call detected</div>
        </div>
        <button id="gegidze-close" style="
          margin-left: auto; background: none; border: none;
          color: #8b89a0; cursor: pointer; font-size: 16px;
        ">✕</button>
      </div>
      <p style="color: #c4c2d0; font-size: 13px; line-height: 1.5; margin-bottom: 0;">
        Click the <strong>Gegidze extension icon</strong> → <strong>Record</strong> to start.
      </p>
    </div>
    <style>
      @keyframes gegidze-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
    </style>
  `;

  document.body.appendChild(banner);
  document.getElementById('gegidze-close')?.addEventListener('click', removeBanner);
  setTimeout(removeBanner, 8000);
}

function removeBanner() {
  const el = document.getElementById('gegidze-banner');
  if (el) {
    el.style.transition = 'opacity 0.25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }
}

// ── UI: Recording indicator ───────────────────────────────────────────────
function showRecordingIndicator() {
  if (document.getElementById('gegidze-rec')) return;
  recordingStartTime = Date.now();

  const el = document.createElement('div');
  el.id = 'gegidze-rec';
  el.innerHTML = `
    <div style="
      position: fixed; top: 16px; right: 16px; z-index: 999999;
      background: linear-gradient(135deg, #1a1215, #12121f);
      border: 1px solid #3e2a2a; border-radius: 10px;
      padding: 10px 16px; color: #ef4444;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; display: flex; align-items: center; gap: 8px;
      box-shadow: 0 4px 16px rgba(239, 68, 68, 0.2);
      animation: gegidze-in 0.3s ease-out;
    ">
      <span style="width:10px;height:10px;border-radius:50%;background:#ef4444;animation:gegidze-pulse 1s infinite;"></span>
      <span style="font-weight: 600;">Recording</span>
      <span id="gegidze-timer" style="font-variant-numeric:tabular-nums;color:#c4c2d0;">00:00</span>
      <button id="gegidze-stop" style="
        background:#2e1a1a;border:1px solid #3e2a2a;border-radius:6px;
        color:#ef4444;padding:4px 10px;margin-left:6px;font-size:12px;
        font-weight:600;cursor:pointer;
      ">Stop</button>
    </div>
    <style>
      @keyframes gegidze-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
    </style>
  `;

  document.body.appendChild(el);

  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const s = (elapsed % 60).toString().padStart(2, '0');
    const timer = document.getElementById('gegidze-timer');
    if (timer) timer.textContent = `${m}:${s}`;
  }, 1000);

  document.getElementById('gegidze-stop')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    stopRecording();
  });
}

function removeRecordingIndicator() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  const el = document.getElementById('gegidze-rec');
  if (el) el.remove();
}

// ── UI: Notification ──────────────────────────────────────────────────────
function showNotification(text, type) {
  const existing = document.getElementById('gegidze-notification');
  if (existing) existing.remove();

  const color = type === 'success' ? '#34d399' : '#ef4444';
  const div = document.createElement('div');
  div.id = 'gegidze-notification';
  div.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; z-index: 9999999;
    background: #1a1a2e; border: 1px solid ${color}; border-radius: 12px;
    padding: 14px 20px; color: ${color}; font-size: 13px; font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    animation: gegidze-in 0.3s ease-out;
  `;
  div.textContent = text;
  document.body.appendChild(div);
  setTimeout(() => {
    div.style.transition = 'opacity 0.3s';
    div.style.opacity = '0';
    setTimeout(() => div.remove(), 300);
  }, 5000);
}
