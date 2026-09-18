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
      startRecording(msg.meetingId, msg.tabStreamId, msg.tabCaptureError);
      break;
    case 'STOP_RECORDING':
      stopRecording();
      break;
    case 'RECORDING_ERROR':
      showNotification(`Gegidze: ${msg.message}`, 'error');
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
    showCallBanner('Google Meet');
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

function captionsRegion() {
  // tabindex first: aria-label is translated in a non-English Meet UI
  return document.querySelector('div[role="region"][tabindex="0"]')
    || document.querySelector('div[role="region"][aria-label="Captions"]');
}

// Every caption block carries the speaker's avatar, then their name, then the spoken text.
// The blocks sit several levels below the region, so the avatars are what we look for.
function readCaptionBlocks() {
  const region = captionsRegion();
  if (!region) return [];
  const blocks = [];
  for (const avatar of region.querySelectorAll('img')) {
    const block = avatar.parentElement;
    const nameEl = avatar.nextElementSibling;
    const textEl = block?.lastElementChild;
    if (!block || !nameEl || !textEl || nameEl === textEl) continue;
    const name = nameEl.textContent?.trim();
    const text = textEl.textContent?.trim();
    if (!name || !text) continue;
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

// Meet's own caption strip stays in the page (we read it) but is hidden; the text shows in our panel instead
function hideMeetCaptions(hidden) {
  const region = captionsRegion();
  if (!region) return;
  // Moved out of sight rather than removed, so Meet keeps writing captions into it
  region.style.opacity = hidden ? '0' : '';
  region.style.pointerEvents = hidden ? 'none' : '';
  region.style.transform = hidden ? 'translateY(300vh)' : '';
  region.style.maxHeight = hidden ? '0px' : '';
}

function renderLiveCaptions(blocks) {
  const panel = document.getElementById('gegidze-live');
  if (!panel) return;
  const recent = blocks.slice(-3);
  panel.style.display = recent.length ? 'block' : 'none';
  panel.replaceChildren(...recent.map(({ name, text }) => {
    const line = document.createElement('div');
    line.style.marginBottom = '6px';
    const who = document.createElement('span');
    who.style.cssText = 'color:#7b6cf6;font-weight:600;';
    who.textContent = `${name}: `;
    line.append(who, document.createTextNode(text));
    return line;
  }));
}

function startCaptionTracking() {
  captionIntervals = [];
  activeCaptionBlocks.clear();
  turnOnCaptions();
  captionTimer = setInterval(() => {
    hideMeetCaptions(true);
    pollCaptions();
    renderLiveCaptions(readCaptionBlocks());
  }, 500);
}

function stopCaptionTracking() {
  if (captionTimer) { clearInterval(captionTimer); captionTimer = null; }
  hideMeetCaptions(false);
  for (const entry of activeCaptionBlocks.values()) {
    captionIntervals.push({ name: entry.name, start: entry.start, end: entry.end });
  }
  activeCaptionBlocks.clear();
  const intervals = captionIntervals.filter(c => c.end > c.start);
  console.log(`[Gegidze] Captions: ${intervals.length} speaker intervals, ${new Set(intervals.map(c => c.name)).size} people`);
  return intervals;
}

// ── Chat notice ───────────────────────────────────────────────────────────
const CHAT_NOTICE = 'Hi everyone, this is an automated message: Gegidze Recorder is transcribing this meeting for me so I can give my full attention to you.';

function symbolButton(iconText) {
  const icon = Array.from(document.querySelectorAll('.google-symbols')).find(i => i.textContent.trim() === iconText);
  return icon?.closest('button') || null;
}

function waitFor(check, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = check();
      if (found || Date.now() - started > timeoutMs) { clearInterval(timer); resolve(found || null); }
    }, 200);
  });
}

// Let the other participants know the call is being transcribed: open Meet's chat, send the notice, close it
async function postChatNotice() {
  try {
    const chatButton = symbolButton('chat');
    if (!chatButton) return console.warn('[Gegidze] Chat button not found');
    chatButton.click();

    const input = await waitFor(() => Array.from(document.querySelectorAll('textarea')).find(t => t.offsetParent !== null), 5000);
    if (!input) return console.warn('[Gegidze] Chat input not found');

    input.focus();
    // Meet's input is framework-controlled: set the value through the native setter so it notices the change
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, CHAT_NOTICE);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));

    const sendButton = symbolButton('send');
    if (sendButton && !sendButton.disabled) {
      sendButton.click();
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }
    console.log('[Gegidze] Chat notice sent');

    await new Promise(r => setTimeout(r, 800));
    symbolButton('chat')?.click();
  } catch (err) {
    console.warn('[Gegidze] Chat notice failed:', err.message);
  }
}

// ── CRM notice ────────────────────────────────────────────────────────────
// Shortly after recording starts, tell the user which people on this call are already in Zoho
function showCrmNotice(meetingId) {
  chrome.runtime.sendMessage({ type: 'ZOHO_LOOKUP', meetingId }, (response) => {
    if (chrome.runtime.lastError || !response || response.error) return;
    const matches = response.matches || [];
    if (matches.length === 0) return;

    const box = document.createElement('div');
    box.id = 'gegidze-crm';
    box.style.cssText = `
      position: fixed; bottom: 96px; left: 50%; transform: translateX(-50%);
      z-index: 9999999; max-width: 520px;
      background: #ffffff; border: 1px solid #e4e4ed; border-left: 4px solid #7b6cf6;
      border-radius: 10px; padding: 12px 18px; color: #141428;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; line-height: 1.5; box-shadow: 0 8px 28px rgba(0,0,0,0.14);
      animation: gegidze-in 0.3s ease-out;
    `;
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;color:#7b6cf6;margin-bottom:4px;';
    title.textContent = 'Zoho CRM';
    box.appendChild(title);
    for (const m of matches) {
      // Clicking opens the record in Zoho CRM
      const line = document.createElement(m.url ? 'a' : 'div');
      if (m.url) {
        line.href = m.url;
        line.target = '_blank';
        line.rel = 'noopener noreferrer';
        line.style.cssText = 'display:block;color:#141428;text-decoration:none;border-bottom:1px solid transparent;';
        line.addEventListener('mouseenter', () => { line.style.borderBottomColor = '#7b6cf6'; });
        line.addEventListener('mouseleave', () => { line.style.borderBottomColor = 'transparent'; });
      }
      line.textContent = `✓ ${m.name} (${m.module === 'Leads' ? 'Lead' : 'Contact'}) — ${m.email}`;
      box.appendChild(line);
    }
    document.body.appendChild(box);

    setTimeout(() => {
      box.style.transition = 'opacity 0.4s';
      box.style.opacity = '0';
      setTimeout(() => box.remove(), 400);
    }, 20000);
  });
}

// ── Recording ─────────────────────────────────────────────────────────────
async function startRecording(meetingId, tabStreamId, streamIdError) {
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
      tabCaptureError = streamIdError || 'no tab stream id';
      showNotification(
        `Gegidze: ONLY YOUR VOICE is being recorded — ${tabCaptureError}. Stop, open this call tab and press Record from the Gegidze icon.`,
        'error',
      );
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
    setTimeout(postChatNotice, 1500);
    setTimeout(() => showCrmNotice(meetingId), 4000);
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
      background: #ffffff;
      border: 1px solid #7b6cf6; border-radius: 14px;
      padding: 20px 24px; color: #141428;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px; min-width: 280px;
      box-shadow: 0 8px 32px rgba(123, 108, 246, 0.2);
      animation: gegidze-in 0.35s ease-out;
    ">
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 14px;">
        <span style="font-size: 22px;">🎙️</span>
        <div>
          <div style="font-weight: 700; font-size: 15px;">Gegidze Recorder</div>
          <div style="color: #555570; font-size: 12px; margin-top: 2px;">${platform} call detected</div>
        </div>
        <button id="gegidze-close" style="
          margin-left: auto; background: none; border: none;
          color: #555570; cursor: pointer; font-size: 16px;
        ">✕</button>
      </div>
      <p style="color: #141428; font-size: 13px; line-height: 1.6; margin: 0;">
        Click the <strong>Gegidze icon</strong> in the toolbar to record this call.
      </p>
    </div>
    <style>
      @keyframes gegidze-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
    </style>
  `;

  document.body.appendChild(banner);
  document.getElementById('gegidze-close')?.addEventListener('click', removeBanner);
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
      background: #fff5f5;
      border: 1px solid #f5c2c2; border-radius: 10px;
      padding: 10px 16px; color: #ef4444;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; display: flex; align-items: center; gap: 8px;
      box-shadow: 0 4px 16px rgba(239, 68, 68, 0.2);
      animation: gegidze-in 0.3s ease-out;
    ">
      <span style="width:10px;height:10px;border-radius:50%;background:#ef4444;animation:gegidze-pulse 1s infinite;"></span>
      <span style="font-weight: 600;">Recording</span>
      <span id="gegidze-timer" style="font-variant-numeric:tabular-nums;color:#555570;">00:00</span>
      <button id="gegidze-stop" style="
        background:#fdecec;border:1px solid #f5c2c2;border-radius:6px;
        color:#ef4444;padding:4px 10px;margin-left:6px;font-size:12px;
        font-weight:600;cursor:pointer;
      ">Stop</button>
    </div>
    <div id="gegidze-live" style="
      position: fixed; top: 64px; right: 16px; z-index: 999999; width: 360px; max-height: 40vh; overflow: hidden;
      background: rgba(255, 255, 255, 0.96); border: 1px solid #e4e4ed; border-radius: 10px;
      padding: 10px 14px; color: #141428; display: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; line-height: 1.5;
    "></div>
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
    background: #ffffff; border: 1px solid ${color}; border-radius: 12px;
    padding: 14px 20px; color: ${color}; font-size: 13px; font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    box-shadow: 0 8px 32px rgba(0,0,0,0.12);
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
