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
let playbackContext = null;
let tabCaptureError = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'PING':
      sendResponse({ ok: true });
      break;
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

// ── Call detection ────────────────────────────────────────────────────────
// Meet shows a "call_end" (red phone) icon only while you are in the call. The icon name is
// the same in every UI language, unlike button labels.
function isInCall() {
  return Array.from(document.querySelectorAll('i')).some(i => i.textContent.trim() === 'call_end');
}

let joinedNotified = false;
setInterval(() => {
  const inCall = isInCall();
  if (inCall && !joinedNotified) {
    joinedNotified = true;
    if (mediaRecorder) return;
    // Ask the background to open the extension popup so the user can press Record right away;
    // the in-page banner is the fallback if the popup can't be opened.
    showCallBanner('Google Meet');
    chrome.runtime.sendMessage({ type: 'CALL_JOINED' }, () => void chrome.runtime.lastError);
  } else if (!inCall && joinedNotified && !mediaRecorder) {
    joinedNotified = false;
  }
}, 2000);

// ── Captions: who is speaking when ────────────────────────────────────────
// Google Meet's live captions show the speaker's name next to each caption block. While recording
// we only keep track of WHO spoke WHEN (not Google's text); the server matches these times with
// the Gemini transcript to put names on the transcript lines.
let captionTimer = null;
let captionIntervals = [];               // finalized { name, start, end } in seconds from recording start
const activeCaptionBlocks = new Map();   // caption DOM block -> { name, text, start, end }

function turnOnCaptions() {
  // The CC button shows the "closed_caption_off" icon while captions are off (same in every UI language)
  const icon = Array.from(document.querySelectorAll('.google-symbols')).find(i => i.textContent.trim() === 'closed_caption_off');
  const button = icon?.closest('button');
  if (button) {
    button.click();
    console.log('[Gegidze] Captions turned on');
  }
}

// Each caption block: [avatar] [name] [text]; the text element is the last child, the name sits right before it
function readCaptionBlocks() {
  const region = document.querySelector('div[role="region"][tabindex="0"]');
  if (!region) return [];
  const blocks = [];
  for (const block of Array.from(region.children)) {
    const textEl = block.lastElementChild;
    const nameEl = textEl?.previousElementSibling;
    const name = nameEl?.textContent?.trim();
    const text = textEl?.textContent?.trim();
    if (!name || !text || name === text) continue;
    blocks.push({ element: block, name, text });
  }
  return blocks;
}

function pollCaptions() {
  if (!recordingStartTime) return;
  const now = (Date.now() - recordingStartTime) / 1000;
  const seen = new Set();

  for (const { element, name, text } of readCaptionBlocks()) {
    seen.add(element);
    const entry = activeCaptionBlocks.get(element);
    if (!entry) {
      activeCaptionBlocks.set(element, { name, text, start: now, end: now });
    } else if (entry.text !== text || entry.name !== name) {
      // Meet keeps appending to the same block while the person talks; a much shorter text means it started over
      if (text.length < entry.text.length - 250) {
        captionIntervals.push({ name: entry.name, start: entry.start, end: entry.end });
        entry.start = now;
      }
      entry.name = name;
      entry.text = text;
      entry.end = now;
    }
  }

  // Blocks that disappeared or went quiet are finished
  for (const [element, entry] of activeCaptionBlocks) {
    if (!seen.has(element) || now - entry.end > 8) {
      captionIntervals.push({ name: entry.name, start: entry.start, end: entry.end });
      activeCaptionBlocks.delete(element);
    }
  }
}

function startCaptionTracking() {
  captionIntervals = [];
  activeCaptionBlocks.clear();
  turnOnCaptions();
  captionTimer = setInterval(pollCaptions, 500);
}

function stopCaptionTracking() {
  if (captionTimer) { clearInterval(captionTimer); captionTimer = null; }
  for (const entry of activeCaptionBlocks.values()) {
    captionIntervals.push({ name: entry.name, start: entry.start, end: entry.end });
  }
  activeCaptionBlocks.clear();
  const intervals = captionIntervals.filter(c => c.end > c.start);
  console.log(`[Gegidze] Captions: ${intervals.length} speaker intervals, ${new Set(intervals.map(c => c.name)).size} people`);
  return intervals;
}

// ── Recording ─────────────────────────────────────────────────────────────
async function startRecording(meetingId, tabStreamId) {
  try {
    currentMeetingId = meetingId;
    chunks = [];
    speakerChunks = [];
    tabCaptureError = null;

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

        // Capturing mutes the tab for the user — play the captured audio back so the call stays audible
        playbackContext = new AudioContext();
        playbackContext.createMediaStreamSource(speakerStream).connect(playbackContext.destination);
        playbackContext.resume().catch(() => {});

        speakerRecorder = new MediaRecorder(speakerStream, {
          mimeType: 'audio/webm;codecs=opus',
        });
        speakerRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) speakerChunks.push(e.data);
        };
        speakerRecorder.start(1000);
      } catch (tabErr) {
        console.warn('[Gegidze] Tab audio capture failed:', tabErr.message);
        tabCaptureError = tabErr.message;
        speakerRecorder = null;
        speakerStream = null;
        playbackContext?.close().catch(() => {});
        playbackContext = null;
        showNotification(`Gegidze: other participants' audio is NOT being captured — ${tabErr.message}`, 'error');
      }
    } else {
      tabCaptureError = 'no tab stream id';
      showNotification("Gegidze: other participants' audio is NOT being captured — no tab stream", 'error');
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
      const captions = stopCaptionTracking();

      chrome.runtime.sendMessage({
        type: 'UPLOAD_AUDIO',
        audioData: micArray,
        speakerData: speakerArray,
        meetingId: savedMeetingId,
        tabCaptureError,
        captions,
      }, (response) => {
        if (chrome.runtime.lastError || !response) {
          // Background worker gave no answer — the upload may not have happened
          showNotification(`Gegidze: Upload not confirmed — ${chrome.runtime.lastError?.message || 'no response'}. Check the dashboard.`, 'error');
        } else if (response.error) {
          showNotification(`Gegidze: Upload failed — ${response.error}`, 'error');
        } else {
          showNotification('Gegidze: Recording uploaded. Transcript is being created.', 'success');
        }
      });

      // Cleanup streams
      micStream?.getTracks().forEach(t => t.stop());
      speakerStream?.getTracks().forEach(t => t.stop());
      playbackContext?.close().catch(() => {});
      playbackContext = null;
      chunks = [];
      speakerChunks = [];
      micStream = null;
      speakerStream = null;
      currentMeetingId = null;
    };

    mediaRecorder.start(1000);
    recordingStartTime = Date.now();
    console.log('[Gegidze] Recording started for meeting', meetingId);

    removeBanner();
    showRecordingIndicator();
    startCaptionTracking();
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
      <button id="gegidze-start" style="
        width: 100%; padding: 10px 14px; background: #7b6cf6; border: none; border-radius: 8px;
        color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
      ">Start recording</button>
      <p id="gegidze-banner-hint" style="color: #8b89a0; font-size: 12px; line-height: 1.5; margin: 10px 0 0;">
        Or click the Gegidze extension icon → Record.
      </p>
    </div>
    <style>
      @keyframes gegidze-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
    </style>
  `;

  document.body.appendChild(banner);
  document.getElementById('gegidze-close')?.addEventListener('click', removeBanner);
  // Chrome only lets us capture the call audio after the user pressed the extension itself,
  // so this button opens the extension popup where the real Record button lives.
  document.getElementById('gegidze-start')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_POPUP' }, (response) => {
      if (chrome.runtime.lastError || response?.error) {
        const hint = document.getElementById('gegidze-banner-hint');
        if (hint) hint.innerHTML = 'Please click the <strong>Gegidze extension icon</strong> → <strong>Record</strong>.';
      }
    });
  });
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
