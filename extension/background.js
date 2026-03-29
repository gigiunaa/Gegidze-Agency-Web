// ── Config ────────────────────────────────────────────────────────────────
const API_BASE = 'http://localhost:3001/api';

const CALL_PATTERNS = [
  { pattern: /^https:\/\/meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/i, platform: 'Google Meet' },
  { pattern: /^https:\/\/.*\.zoom\.us\/(wc|j)\/\d+/i, platform: 'Zoom' },
  { pattern: /^https:\/\/.*\.zoho\.com\/(telephony|meeting)\//i, platform: 'Zoho' },
];

// ── State ─────────────────────────────────────────────────────────────────
let activeCallTabs = new Map();
let recordingTabId = null;
let recordingMeetingId = null;
let recordingStartTime = null;

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
    }
  } else {
    if (activeCallTabs.has(tabId)) {
      activeCallTabs.delete(tabId);
      if (activeCallTabs.size === 0) {
        chrome.action.setBadgeText({ text: '' });
      }
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
      sendResponse({
        isRecording: !!recordingTabId,
        tabId: recordingTabId,
        meetingId: recordingMeetingId,
        startTime: recordingStartTime,
        activeCalls: Array.from(activeCallTabs.entries()).map(([id, info]) => ({
          tabId: id,
          ...info,
        })),
      });
      return true;

    case 'START_RECORDING': {
      const tabId = msg.tabId;
      const callInfo = activeCallTabs.get(tabId) || { platform: 'Unknown' };

      getAuthToken().then(async (token) => {
        if (!token) {
          sendResponse({ error: 'Not logged in' });
          return;
        }
        try {
          const meeting = await apiRequest('/meetings', 'POST', {
            title: `${callInfo.platform} Call — ${new Date().toLocaleString()}`,
            startTime: new Date().toISOString(),
            endTime: new Date(Date.now() + 3600000).toISOString(),
            calendarSource: 'extension',
            participants: [],
            status: 'recording',
          }, token);

          recordingTabId = tabId;
          recordingMeetingId = meeting.id;
          recordingStartTime = Date.now();

          // Tell content script to start recording mic
          chrome.tabs.sendMessage(tabId, {
            type: 'START_RECORDING',
            meetingId: meeting.id,
          });

          chrome.action.setBadgeText({ text: 'REC' });
          chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });

          sendResponse({ ok: true, meetingId: meeting.id });
        } catch (e) {
          sendResponse({ error: e.message });
        }
      });
      return true;
    }

    case 'STOP_RECORDING': {
      if (recordingTabId) {
        chrome.tabs.sendMessage(recordingTabId, { type: 'STOP_RECORDING' }).catch(() => {});
      }

      recordingTabId = null;
      recordingMeetingId = null;
      recordingStartTime = null;

      if (activeCallTabs.size > 0) {
        chrome.action.setBadgeText({ text: '●' });
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      } else {
        chrome.action.setBadgeText({ text: '' });
      }

      sendResponse({ ok: true });
      return true;
    }

    case 'UPLOAD_AUDIO': {
      handleUpload(msg.audioData, msg.meetingId).then(() => {
        sendResponse({ ok: true });
      }).catch(e => {
        sendResponse({ error: e.message });
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

    case 'GET_AUTH':
      chrome.storage.local.get(['authToken', 'userEmail'], (data) => {
        sendResponse(data);
      });
      return true;

    case 'ZOHO_SEARCH': {
      getAuthToken().then(async (token) => {
        try {
          const res = await fetch(`${API_BASE}/zoho/search?q=${encodeURIComponent(msg.query)}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error('Search failed');
          const leads = await res.json();
          sendResponse({ leads });
        } catch (e) {
          sendResponse({ error: e.message });
        }
      });
      return true;
    }

    case 'ZOHO_PUSH': {
      getAuthToken().then(async (token) => {
        try {
          const res = await fetch(`${API_BASE}/zoho/push-summary`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ meetingId: msg.meetingId, leadId: msg.leadId }),
          });
          if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Push failed');
          }
          const result = await res.json();
          sendResponse(result);
        } catch (e) {
          sendResponse({ error: e.message });
        }
      });
      return true;
    }
  }
});

// ── Upload ────────────────────────────────────────────────────────────────
async function handleUpload(audioData, meetingId) {
  const token = await getAuthToken();
  if (!token || !meetingId) throw new Error('Not authenticated');

  const blob = new Blob([new Uint8Array(audioData)], { type: 'audio/webm' });
  console.log(`[Gegidze] Uploading ${blob.size} bytes for meeting ${meetingId}`);

  const formData = new FormData();
  formData.append('meetingId', meetingId);
  formData.append('mic', blob, 'recording.webm');

  const res = await fetch(`${API_BASE}/recordings/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  console.log(`[Gegidze] Upload complete for meeting ${meetingId}`);
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
