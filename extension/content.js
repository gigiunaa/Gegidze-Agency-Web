// Content script — runs on Google Meet, Zoom, Zoho pages
// Handles microphone + tab audio recording

let mediaRecorder = null;
let chunks = [];
let currentMeetingId = null;
let timerInterval = null;
let recordingStartTime = null;
let micStream = null;
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
      startRecording(msg.meetingId, msg.tabCaptureError);
      break;
    case 'STOP_RECORDING':
      stopRecording();
      break;
    case 'RECORDING_ERROR':
      showNotification(`Unitty: ${msg.message}`, 'error');
      break;
  }
});

function sendToBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({});
      else resolve(response || {});
    });
  });
}

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
let captionIntervals = [];               // finalized { name, start, end, text } in seconds from recording start
const activeCaptionBlocks = new Map();   // caption DOM block -> { name, text, start, end }

function turnOnCaptions() {
  // The CC button shows the "closed_caption_off" icon while captions are off (same in every UI language)
  const icon = Array.from(document.querySelectorAll('.google-symbols')).find(i => i.textContent.trim() === 'closed_caption_off');
  const button = icon?.closest('button');
  if (button) {
    button.click();
    console.log('[Unitty] Captions turned on');
  }
}

function captionsRegion() {
  // tabindex first: aria-label is translated in a non-English Meet UI
  return document.querySelector('div[role="region"][tabindex="0"]')
    || document.querySelector('div[role="region"][aria-label="Captions"]');
}

// A caption block holds the speaker's name and then what they said. Meet's markup changes over
// time, so two ways of finding the blocks are tried before giving up.
function blockFrom(element, nameEl, textEl) {
  if (!element || !nameEl || !textEl || nameEl === textEl) return null;
  const name = nameEl.textContent?.trim();
  const text = textEl.textContent?.trim();
  if (!name || !text || name === text || name.length > 60) return null;
  return { element, name, text };
}

function readCaptionBlocks() {
  const region = captionsRegion();
  if (!region) return [];

  // Preferred: each block starts with the speaker's avatar
  const byAvatar = [];
  for (const avatar of region.querySelectorAll('img')) {
    const block = blockFrom(avatar.parentElement, avatar.nextElementSibling, avatar.parentElement?.lastElementChild);
    if (block) byAvatar.push(block);
  }
  if (byAvatar.length > 0) return byAvatar;

  // Otherwise: any element whose last two children are the name and the spoken text
  const candidates = [];
  for (const el of region.querySelectorAll('div')) {
    if (el.children.length < 2) continue;
    const textEl = el.lastElementChild;
    const block = blockFrom(el, textEl.previousElementSibling, textEl);
    if (block) candidates.push(block);
  }
  // Keep the innermost matches, so an outer wrapper does not swallow several speakers
  return candidates.filter(c => !candidates.some(other => other !== c && c.element.contains(other.element)));
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
        captionIntervals.push({ name: entry.name, start: entry.start, end: entry.end, text: entry.text });
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
      captionIntervals.push({ name: entry.name, start: entry.start, end: entry.end, text: entry.text });
      activeCaptionBlocks.delete(element);
    }
  }
}

// Meet's own caption strip stays in the page (we read it) but is hidden; the text shows in our panel instead
function hideMeetCaptions(hidden) {
  const region = captionsRegion();
  if (!region) return;
  // Only made see-through: collapsing or moving it stops Meet from drawing the captions we read.
  // The space Meet reserves at the bottom is its own layout decision and cannot be taken back here.
  region.style.opacity = hidden ? '0' : '';
  region.style.pointerEvents = hidden ? 'none' : '';
}

function renderLiveCaptions(blocks) {
  const panel = document.getElementById('unitty-live');
  if (!panel) return;
  panel.style.display = 'block';

  const recent = blocks.slice(-3);
  if (recent.length === 0) {
    const waiting = document.createElement('div');
    waiting.style.cssText = 'color:#555570;';
    waiting.textContent = 'Listening for speech…';
    panel.replaceChildren(waiting);
    return;
  }

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
    captionIntervals.push({ name: entry.name, start: entry.start, end: entry.end, text: entry.text });
  }
  activeCaptionBlocks.clear();
  const intervals = captionIntervals.filter(c => c.end > c.start);
  console.log(`[Unitty] Captions: ${intervals.length} speaker intervals, ${new Set(intervals.map(c => c.name)).size} people`);
  if (intervals.length === 0) {
    const region = captionsRegion();
    console.warn('[Unitty] No speaker names were read. Captions region:', region ? region.innerHTML.slice(0, 1500) : 'not found');
  }
  return intervals;
}

// ── Chat notice ───────────────────────────────────────────────────────────
const CHAT_NOTICE = 'Hi everyone, this is an automated message: Unitty Recorder is transcribing this meeting for me so I can give my full attention to you.';

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

// The box you type a message into. Meet has shipped it as a textarea, and other builds use a
// contenteditable or a plain input, so it is found by looking around the send button rather than
// by tag. The bottom-bar Gemini box is a contenteditable too, hence the send button as the anchor.
function visibleChatInput() {
  const isUsable = (el) => el && el.offsetParent !== null;
  const send = symbolButton('send');
  if (send) {
    let node = send.parentElement;
    for (let level = 0; level < 6 && node; level++) {
      const field = Array.from(node.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')).find(isUsable);
      if (field) return field;
      node = node.parentElement;
    }
  }
  return Array.from(document.querySelectorAll('textarea')).find(isUsable) || null;
}

function chatInputText(field) {
  return ('value' in field ? field.value : field.textContent || '').trim();
}

function typeIntoChat(field, text) {
  field.focus();
  if ('value' in field) {
    // Meet's input is framework-controlled: go through the native setter so it notices the change
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    if (setter) setter.call(field, text); else field.value = text;
  } else {
    field.textContent = text;
  }
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

// Let the other participants know the call is being transcribed. Two things matter here: the
// toolbar may not be ready the moment recording starts, so the chat button is waited for; and
// clicking that button when the panel is already open closes it, so the panel is left as found.
async function postChatNotice() {
  let openedByUs = false;
  // Shown on screen, not just logged: reading the console during a call is not realistic
  const pageState = () => [
    symbolButton('chat') ? 'chat+' : 'chat-',
    symbolButton('send') ? 'send+' : 'send-',
    'ta' + document.querySelectorAll('textarea').length,
    'ce' + document.querySelectorAll('[contenteditable="true"]').length,
    'in' + document.querySelectorAll('input[type="text"]').length,
  ].join(' ');

  const giveUp = (reason) => {
    const state = pageState();
    console.warn('[Unitty] Chat notice not posted:', reason, '|', state);
    showNotification(`Unitty: chat notice failed — ${reason} [${state}]`, 'error');
  };

  try {
    let input = visibleChatInput();
    if (!input) {
      const chatButton = await waitFor(() => symbolButton('chat'), 15000);
      if (!chatButton) return giveUp('the chat button never appeared');
      chatButton.click();
      openedByUs = true;
      input = await waitFor(visibleChatInput, 10000);
    }
    if (!input) return giveUp('the chat box did not open');

    typeIntoChat(input, CHAT_NOTICE);
    await new Promise(r => setTimeout(r, 400));
    if (!chatInputText(input)) return giveUp('Meet did not accept the text');

    const sendButton = symbolButton('send');
    if (sendButton && !sendButton.disabled) sendButton.click();
    await new Promise(r => setTimeout(r, 600));

    // An empty box means it went; if the button did nothing, Enter is the other way to send
    if (chatInputText(input)) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      await new Promise(r => setTimeout(r, 600));
    }

    if (chatInputText(input)) return giveUp('the message stayed in the box');
    console.log('[Unitty] Chat notice sent');
  } catch (err) {
    giveUp(err.message);
  } finally {
    if (openedByUs) {
      // Meet redraws the panel after a message is posted; clicking too soon lands on nothing.
      // One click only — a second one arrives mid-animation and opens the panel straight back up.
      await new Promise(r => setTimeout(r, 1000));
      symbolButton('chat')?.click();
    }
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
    box.id = 'unitty-crm';
    box.style.cssText = `
      position: fixed; bottom: 96px; left: 50%; transform: translateX(-50%);
      z-index: 9999999; max-width: 520px;
      background: #ffffff; border: 1px solid #e4e4ed; border-left: 4px solid #7b6cf6;
      border-radius: 10px; padding: 12px 18px; color: #141428;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; line-height: 1.5; box-shadow: 0 8px 28px rgba(0,0,0,0.14);
      animation: unitty-in 0.3s ease-out;
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
async function startRecording(meetingId, streamIdError) {
  try {
    currentMeetingId = meetingId;
    chunks = [];
    tabCaptureError = null;

    // 1. Record microphone (user's voice)
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 48000,
      },
    });
    console.log('[Unitty] Mic stream obtained');

    mediaRecorder = new MediaRecorder(micStream, {
      mimeType: 'audio/webm;codecs=opus',
    });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    // The other participants are recorded outside this tab (see offscreen.js), because a tab
    // that is being captured stops playing its sound to the user.
    if (streamIdError) {
      tabCaptureError = streamIdError;
      showNotification(
        `Unitty: ONLY YOUR VOICE is being recorded — ${streamIdError}`,
        'error',
      );
    }

    // When mic recording stops, upload both tracks
    // The recording goes to the server straight from this page: passing a long call through
    // the extension's background worker meant serialising megabytes of audio, which failed.
    mediaRecorder.onstop = async () => {
      const micBlob = new Blob(chunks, { type: 'audio/webm' });
      const savedMeetingId = currentMeetingId;
      const captions = stopCaptionTracking();
      console.log(`[Unitty] Mic: ${micBlob.size} bytes`);

      micStream?.getTracks().forEach(t => t.stop());
      chunks = [];
      micStream = null;
      currentMeetingId = null;

      try {
        const { token, apiBase } = await sendToBackground({ type: 'GET_UPLOAD_INFO' });
        if (!token) throw new Error('not signed in');

        const form = new FormData();
        form.append('meetingId', savedMeetingId);
        form.append('mic', micBlob, 'recording.webm');
        form.append('expectSpeaker', tabCaptureError ? 'false' : 'true');
        if (tabCaptureError) form.append('tabCaptureError', tabCaptureError);
        if (captions.length > 0) form.append('captions', JSON.stringify(captions));

        const res = await fetch(`${apiBase}/recordings/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        if (!res.ok) throw new Error(`server said ${res.status}`);
        const recording = await res.json();

        showNotification('Unitty: Recording uploaded. Transcript is being created.', 'success');
        // The other participants were recorded outside this tab; the background sends that part
        if (!tabCaptureError) sendToBackground({ type: 'UPLOAD_SPEAKER', recordingId: recording.id });
      } catch (err) {
        console.error('[Unitty] Upload failed:', err);
        showNotification(`Unitty: Upload failed — ${err.message}`, 'error');
      }
    };

    mediaRecorder.start(1000);
    recordingStartTime = Date.now();
    console.log('[Unitty] Recording started for meeting', meetingId);

    removeBanner();
    showRecordingIndicator();
    startCaptionTracking();
    setTimeout(postChatNotice, 1500);
    setTimeout(() => showCrmNotice(meetingId), 4000);
  } catch (err) {
    console.error('[Unitty] Recording failed:', err);
    alert('Unitty: Microphone access denied. Please allow microphone access and try again.');
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    console.log('[Unitty] Recording stopped');
  }
  removeRecordingIndicator();
}

// ── UI: Call detected banner ──────────────────────────────────────────────
function showCallBanner(platform) {
  if (document.getElementById('unitty-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'unitty-banner';
  banner.innerHTML = `
    <div style="
      position: fixed; top: 140px; right: 20px; z-index: 999999;
      background: #ffffff;
      border: 1px solid #7b6cf6; border-radius: 14px;
      padding: 20px 24px; color: #141428;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px; min-width: 280px;
      box-shadow: 0 8px 32px rgba(123, 108, 246, 0.2);
      animation: unitty-in 0.35s ease-out;
    ">
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 14px;">
        <span style="font-size: 22px;">🎙️</span>
        <div>
          <div style="font-weight: 700; font-size: 15px;">Unitty Recorder</div>
          <div style="color: #555570; font-size: 12px; margin-top: 2px;">${platform} call detected</div>
        </div>
        <button id="unitty-close" style="
          margin-left: auto; background: none; border: none;
          color: #555570; cursor: pointer; font-size: 16px;
        ">✕</button>
      </div>
      <p style="color: #141428; font-size: 13px; line-height: 1.6; margin: 0;">
        Click the <strong>Unitty icon</strong> in the toolbar to record this call.
      </p>
    </div>
    <style>
      @keyframes unitty-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
    </style>
  `;

  document.body.appendChild(banner);
  document.getElementById('unitty-close')?.addEventListener('click', removeBanner);
}

function removeBanner() {
  const el = document.getElementById('unitty-banner');
  if (el) {
    el.style.transition = 'opacity 0.25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }
}

// ── UI: Recording indicator ───────────────────────────────────────────────
function showRecordingIndicator() {
  if (document.getElementById('unitty-rec')) return;
  recordingStartTime = Date.now();

  const el = document.createElement('div');
  el.id = 'unitty-rec';
  el.innerHTML = `
    <div style="
      position: fixed; top: 140px; right: 16px; z-index: 999999;
      background: #fff5f5;
      border: 1px solid #f5c2c2; border-radius: 10px;
      padding: 10px 16px; color: #ef4444;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; display: flex; align-items: center; gap: 8px;
      box-shadow: 0 4px 16px rgba(239, 68, 68, 0.2);
      animation: unitty-in 0.3s ease-out;
    ">
      <span style="width:10px;height:10px;border-radius:50%;background:#ef4444;animation:unitty-pulse 1s infinite;"></span>
      <span style="font-weight: 600;">Recording</span>
      <span id="unitty-timer" style="font-variant-numeric:tabular-nums;color:#555570;">00:00</span>
      <button id="unitty-stop" style="
        background:#fdecec;border:1px solid #f5c2c2;border-radius:6px;
        color:#ef4444;padding:4px 10px;margin-left:6px;font-size:12px;
        font-weight:600;cursor:pointer;
      ">Stop</button>
    </div>
    <div id="unitty-live" style="
      position: fixed; top: 196px; right: 16px; z-index: 999999; width: 360px; max-height: 34vh; overflow: hidden;
      background: rgba(255, 255, 255, 0.96); border: 1px solid #e4e4ed; border-radius: 10px;
      padding: 10px 14px; color: #141428; display: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; line-height: 1.5;
    "></div>
    <style>
      @keyframes unitty-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
    </style>
  `;

  document.body.appendChild(el);

  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const s = (elapsed % 60).toString().padStart(2, '0');
    const timer = document.getElementById('unitty-timer');
    if (timer) timer.textContent = `${m}:${s}`;
  }, 1000);

  document.getElementById('unitty-stop')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    stopRecording();
  });
}

function removeRecordingIndicator() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  const el = document.getElementById('unitty-rec');
  if (el) el.remove();
}

// ── UI: Notification ──────────────────────────────────────────────────────
function showNotification(text, type) {
  const staysFor = type === 'error' ? 30000 : 5000;
  const existing = document.getElementById('unitty-notification');
  if (existing) existing.remove();

  const color = type === 'success' ? '#34d399' : '#ef4444';
  const div = document.createElement('div');
  div.id = 'unitty-notification';
  div.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; z-index: 9999999;
    background: #ffffff; border: 1px solid ${color}; border-radius: 12px;
    padding: 14px 20px; color: ${color}; font-size: 13px; font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    box-shadow: 0 8px 32px rgba(0,0,0,0.12);
    animation: unitty-in 0.3s ease-out;
  `;
  div.textContent = text;
  document.body.appendChild(div);
  setTimeout(() => {
    div.style.transition = 'opacity 0.3s';
    div.style.opacity = '0';
    setTimeout(() => div.remove(), 300);
  }, staysFor);
}
