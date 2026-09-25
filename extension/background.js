// ── Config ────────────────────────────────────────────────────────────────
// The dashboard and the API are the same origin; change both here and in popup.js if it moves
const API_BASE = 'https://notes.unitty.io/api';

const CALL_PATTERNS = [
  { pattern: /^https:\/\/meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/i, platform: 'Google Meet' },
  { pattern: /^https:\/\/.*\.zoom\.us\/(wc|j)\/\d+/i, platform: 'Zoom' },
  { pattern: /^https:\/\/.*\.zoho\.com\/(telephony|meeting)\//i, platform: 'Zoho' },
];

// ── State ─────────────────────────────────────────────────────────────────
let activeCallTabs = new Map();

// Chrome shuts the background worker down between events — on a long call it is gone long
// before the user presses stop — so what is being recorded is kept in session storage.
const NOT_RECORDING = { recordingTabId: null, recordingMeetingId: null, recordingStartTime: null };

async function getRecordingState() {
  const stored = await chrome.storage.session.get(['recordingTabId', 'recordingMeetingId', 'recordingStartTime']);
  return { ...NOT_RECORDING, ...stored };
}

function setRecordingState(state) {
  return chrome.storage.session.set(state);
}

// ── Tab monitoring ────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  const match = CALL_PATTERNS.find(p => p.pattern.test(tab.url));

  if (match) {
    if (!activeCallTabs.has(tabId)) {
      activeCallTabs.set(tabId, { platform: match.platform, url: tab.url });

      chrome.action.setBadgeText({ text: '●' });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });

      // Notify content script
      chrome.tabs.sendMessage(tabId, {
        type: 'CALL_DETECTED',
        platform: match.platform,
      }).catch(() => {});

      refreshIconBehaviour(tabId);
    }
  } else {
    if (activeCallTabs.has(tabId)) {
      activeCallTabs.delete(tabId);
      if (activeCallTabs.size === 0) {
        chrome.action.setBadgeText({ text: '' });
      }
      refreshIconBehaviour(tabId);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeCallTabs.has(tabId)) {
    activeCallTabs.delete(tabId);
    if (activeCallTabs.size === 0) {
      chrome.action.setBadgeText({ text: '' });
    }
  }
});

// ── Message handling ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'GET_STATE':
      getRecordingState().then((state) => sendResponse({
        isRecording: !!state.recordingTabId,
        tabId: state.recordingTabId,
        meetingId: state.recordingMeetingId,
        startTime: state.recordingStartTime,
        activeCalls: Array.from(activeCallTabs.entries()).map(([id, info]) => ({
          tabId: id,
          ...info,
        })),
      }));
      return true;

    case 'START_RECORDING': {
      startRecording(msg.tabId).then(sendResponse);
      return true;
    }

    case 'STOP_RECORDING': {
      stopRecording().then(() => sendResponse({ ok: true }));
      return true;
    }

    case 'GET_UPLOAD_INFO': {
      getAuthToken().then((token) => sendResponse({ token, apiBase: API_BASE }));
      return true;
    }

    case 'UPLOAD_SPEAKER': {
      uploadSpeakerTrack(msg.recordingId, msg.saveAs).then(sendResponse, (e) => sendResponse({ error: e.message }));
      return true;
    }

    case 'CHECK_MEETING': {
      getAuthToken().then(async (token) => {
        try {
          const res = await fetch(`${API_BASE}/meetings/${msg.meetingId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error(`status check failed: ${res.status}`);
          const meeting = await res.json();
          sendResponse({ status: meeting?.status, error: meeting?.errorMessage });
        } catch (e) {
          sendResponse({ error: e.message });
        }
      });
      return true;
    }

    case 'SAVE_AUTH':
      chrome.storage.local.set({ authToken: msg.token, userEmail: msg.email });
      sendResponse({ ok: true });
      return true;

    case 'LOGOUT':
      chrome.storage.local.remove(['authToken', 'userEmail']);
      sendResponse({ ok: true });
      return true;

    case 'ZOHO_LOOKUP': {
      getAuthToken().then(async (token) => {
        try {
          const res = await fetch(`${API_BASE}/zoho/lookup/${msg.meetingId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error(`lookup failed: ${res.status}`);
          sendResponse(await res.json());
        } catch (e) {
          sendResponse({ error: e.message });
        }
      });
      return true;
    }

    case 'GET_AUTH':
      chrome.storage.local.get(['authToken', 'userEmail'], (data) => {
        sendResponse(data);
      });
      return true;
  }
});

// ── Upload ────────────────────────────────────────────────────────────────
// The other participants were recorded in the offscreen document, which uploads them itself:
// a long recording is far too much data to pass between extension contexts as a message.
async function uploadSpeakerTrack(recordingId, saveAs) {
  const token = await getAuthToken();
  if (!token || !recordingId) return { error: 'Not authenticated' };

  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_STOP' });
    // Keep a copy on the user's machine even if the upload that follows fails
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_SAVE_LOCAL', saveAs }).catch(() => {});
    const result = await chrome.runtime.sendMessage({
      target: 'offscreen', type: 'OFFSCREEN_UPLOAD', recordingId, token, apiBase: API_BASE,
    });
    if (result?.error) console.warn('[Unitty] Upload of the other participants failed:', result.error);
    return result ?? {};
  } catch (e) {
    console.warn('[Unitty] Offscreen recorder unavailable:', e.message);
    return { error: e.message };
  } finally {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function getAuthToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['authToken'], (data) => {
      resolve(data.authToken || null);
    });
  });
}

async function apiRequest(path, method, body, token) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ── Recording ─────────────────────────────────────────────────────────────
// Chrome only allows capturing a tab's audio right after the user clicked the extension on that
// tab, so recording always starts from the toolbar icon (see chrome.action.onClicked below).
async function startRecording(tabId) {
  const callInfo = await callInfoFor(tabId);
  const token = await getAuthToken();
  if (!token) return { error: 'Not logged in' };

  try {
    // Inject the content script unless it is already running in the tab
    // (injecting twice throws "Identifier 'mediaRecorder' has already been declared")
    const alreadyLoaded = await chrome.tabs.sendMessage(tabId, { type: 'PING' }).then(r => !!r?.ok).catch(() => false);
    if (!alreadyLoaded) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      } catch (injectErr) {
        console.warn('[Unitty] Content script injection:', injectErr.message);
      }
    }

    // The other participants' audio is captured in the offscreen document, which also plays it
    // back — a captured tab goes silent for the user otherwise.
    let tabCaptureError = null;
    try {
      const streamId = await new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        });
      });
      await ensureOffscreen();
      const started = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_START', streamId });
      if (started?.error) throw new Error(started.error);
    } catch (tabErr) {
      // Without this stream the other participants are not recorded at all, so say so loudly
      console.warn('[Unitty] Tab capture not available:', tabErr.message);
      tabCaptureError = tabErr.message;
    }

    const meeting = await apiRequest('/meetings', 'POST', {
      title: `${callInfo.platform} Call — ${new Date().toLocaleString()}`,
      startTime: new Date().toISOString(),
      endTime: new Date(Date.now() + 3600000).toISOString(),
      calendarSource: 'extension',
      participants: [],
      status: 'recording',
      // Lets the server find the Calendar invite (title + invited people's emails)
      meetUrl: callInfo.url,
    }, token);

    await setRecordingState({ recordingTabId: tabId, recordingMeetingId: meeting.id, recordingStartTime: Date.now() });

    chrome.tabs.sendMessage(tabId, {
      type: 'START_RECORDING',
      meetingId: meeting.id,
      tabCaptureError,
    });

    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    return { ok: true, meetingId: meeting.id };
  } catch (e) {
    console.error('[Unitty] Could not start recording:', e);
    return { error: e.message };
  }
}

async function stopRecording() {
  const { recordingTabId: stoppedTabId, recordingMeetingId: stoppedMeetingId } = await getRecordingState();

  if (stoppedTabId) {
    chrome.tabs.sendMessage(stoppedTabId, { type: 'STOP_RECORDING' }).catch(() => {});
  }

  await setRecordingState(NOT_RECORDING);

  chrome.action.setBadgeText({ text: activeCallTabs.size > 0 ? '●' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });

  if (stoppedMeetingId) {
    getAuthToken().then(async (token) => {
      if (!token) return;
      try {
        await fetch(`${API_BASE}/meetings/${stoppedMeetingId}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: 'processing' }),
        });
      } catch (e) {
        console.error('[Unitty] Failed to update meeting status:', e);
      }
    });
  }
}

// ── Toolbar icon ──────────────────────────────────────────────────────────
// On a call tab the icon has no popup, so this fires and one click records or stops.
// Everywhere else the popup opens as usual (login, settings).
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const { recordingTabId } = await getRecordingState();
  if (recordingTabId === tab.id) {
    await stopRecording();
    return;
  }
  const result = await startRecording(tab.id);
  if (result.error) {
    console.warn('[Unitty]', result.error);
    chrome.tabs.sendMessage(tab.id, { type: 'RECORDING_ERROR', message: result.error }).catch(() => {});
  }
});

// One click should record, so the popup is taken off call tabs once the user is signed in
async function refreshIconBehaviour(tabId) {
  const token = await getAuthToken();
  const oneClick = !!token && activeCallTabs.has(tabId);
  try {
    await chrome.action.setPopup({ tabId, popup: oneClick ? '' : 'popup.html' });
  } catch { /* tab already gone */ }
}

chrome.tabs.onActivated.addListener(({ tabId }) => refreshIconBehaviour(tabId));
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.authToken) return;
  for (const tabId of activeCallTabs.keys()) refreshIconBehaviour(tabId);
});

// What call is open in this tab. The map is lost whenever Chrome restarts the worker, so the
// tab's own address is the source of truth — without it a call would lose its Calendar invite.
async function callInfoFor(tabId) {
  const known = activeCallTabs.get(tabId);
  if (known) return known;
  try {
    const tab = await chrome.tabs.get(tabId);
    const match = CALL_PATTERNS.find(p => p.pattern.test(tab.url || ''));
    if (match) {
      const info = { platform: match.platform, url: tab.url };
      activeCallTabs.set(tabId, info);
      return info;
    }
  } catch { /* tab gone */ }
  return { platform: 'Unknown' };
}

// ── Offscreen document ────────────────────────────────────────────────────
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Record the other participants on the call',
  });
}
