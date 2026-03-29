// Content script — runs on Google Meet, Zoom, Zoho pages
// Handles microphone recording and Zoho lead linking

let mediaRecorder = null;
let chunks = [];
let currentMeetingId = null;
let timerInterval = null;
let recordingStartTime = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'CALL_DETECTED':
      showCallBanner(msg.platform);
      break;
    case 'START_RECORDING':
      startRecording(msg.meetingId);
      break;
    case 'STOP_RECORDING':
      stopRecording();
      break;
  }
});

// ── Recording ─────────────────────────────────────────────────────────────
async function startRecording(meetingId) {
  try {
    currentMeetingId = meetingId;
    chunks = [];

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 48000,
      },
    });

    console.log('[Gegidze] Mic stream obtained, tracks:', stream.getAudioTracks().length);

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus',
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      console.log(`[Gegidze] Recording complete: ${chunks.length} chunks, ${blob.size} bytes`);

      const arrayBuffer = await blob.arrayBuffer();
      const savedMeetingId = currentMeetingId;

      chrome.runtime.sendMessage({
        type: 'UPLOAD_AUDIO',
        audioData: Array.from(new Uint8Array(arrayBuffer)),
        meetingId: savedMeetingId,
      });

      stream.getTracks().forEach(t => t.stop());
      chunks = [];
      currentMeetingId = null;

      // Show Zoho lead search panel instead of simple notice
      showZohoPanel(savedMeetingId);
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

// ── UI: Zoho Lead ID Panel ────────────────────────────────────────────────
function showZohoPanel(meetingId) {
  if (document.getElementById('gegidze-zoho')) return;

  const panel = document.createElement('div');
  panel.id = 'gegidze-zoho';
  panel.innerHTML = `
    <div id="gegidze-zoho-inner" style="
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      z-index: 9999999; width: 400px;
      background: linear-gradient(135deg, #1a1a2e, #12121f);
      border: 1px solid #7b6cf6; border-radius: 16px;
      padding: 28px; color: #e8e6f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 16px 64px rgba(0,0,0,0.5);
      animation: gegidze-in 0.3s ease-out;
    ">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px;">
        <div>
          <div style="font-weight: 700; font-size: 16px;">Zoho CRM</div>
          <div style="color: #34d399; font-size: 12px; margin-top: 4px;">✓ Recording uploaded</div>
        </div>
        <button id="gegidze-zoho-skip" style="
          background: none; border: none; color: #8b89a0;
          cursor: pointer; font-size: 13px;
        ">Skip</button>
      </div>

      <p style="color: #c4c2d0; font-size: 13px; margin-bottom: 12px;">
        Enter Lead ID from Zoho CRM:
      </p>

      <div style="display: flex; gap: 8px;">
        <input id="gegidze-zoho-lead-id" type="text" placeholder="e.g. 5765228000001234567"
          style="
            flex: 1; padding: 10px 14px; box-sizing: border-box;
            background: #0a0a14; border: 1px solid #2a2a3e; border-radius: 8px;
            color: #e8e6f0; font-size: 13px; outline: none;
          "
        />
        <button id="gegidze-zoho-send" style="
          padding: 10px 18px; background: #7b6cf6; border: none; border-radius: 8px;
          color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
          white-space: nowrap;
        ">Send</button>
      </div>

      <div id="gegidze-zoho-status" style="
        margin-top: 10px; font-size: 13px; color: #8b89a0;
      "></div>
    </div>

    <div style="
      position: fixed; inset: 0; z-index: 9999998;
      background: rgba(0,0,0,0.6);
    " id="gegidze-zoho-backdrop"></div>
  `;

  document.body.appendChild(panel);

  const leadIdInput = document.getElementById('gegidze-zoho-lead-id');
  const sendBtn = document.getElementById('gegidze-zoho-send');
  const statusDiv = document.getElementById('gegidze-zoho-status');

  // Skip button
  document.getElementById('gegidze-zoho-skip')?.addEventListener('click', closeZohoPanel);
  document.getElementById('gegidze-zoho-backdrop')?.addEventListener('click', closeZohoPanel);

  // Send button — save Lead ID and close, push happens in background after summary is ready
  sendBtn?.addEventListener('click', () => {
    const leadId = leadIdInput?.value?.trim();
    if (!leadId) {
      statusDiv.textContent = 'Please enter a Lead ID';
      return;
    }
    statusDiv.innerHTML = '<span style="color: #7b6cf6;">Lead ID saved. Summary will be sent automatically.</span>';
    sendBtn.disabled = true;
    leadIdInput.disabled = true;

    // Start background polling for summary, then push
    waitForSummaryAndPush(meetingId, leadId);

    setTimeout(closeZohoPanel, 2000);
  });

  // Enter key
  leadIdInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBtn?.click();
  });

  leadIdInput?.focus();
}

function waitForSummaryAndPush(meetingId, leadId) {
  let attempts = 0;
  const maxAttempts = 60; // 5 minutes max (every 5 seconds)

  const poll = () => {
    attempts++;
    chrome.runtime.sendMessage({ type: 'ZOHO_PUSH', meetingId, leadId }, (response) => {
      if (response?.error?.includes('No summary available')) {
        // Summary not ready yet, retry
        if (attempts < maxAttempts) {
          setTimeout(poll, 5000);
        } else {
          showNotification('Zoho CRM: Summary generation timed out. Try sending manually from the dashboard.', 'error');
        }
        return;
      }

      if (response?.error) {
        showNotification(`Zoho CRM Error: ${response.error}`, 'error');
        return;
      }

      let msg = 'Summary sent to Zoho CRM';
      if (response?.dealsUpdated?.length > 0) {
        msg += ` + ${response.dealsUpdated.length} Deal(s) updated`;
      }
      showNotification(msg, 'success');
    });
  };

  // First attempt after 10 seconds (give transcription + summary time)
  setTimeout(poll, 10000);
}

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

function closeZohoPanel() {
  const el = document.getElementById('gegidze-zoho');
  if (el) {
    el.style.transition = 'opacity 0.25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }
}

