// ── Config ────────────────────────────────────────────────────────────────
// Change this to your Railway URL for production, or keep localhost for local dev
const API_BASE = 'https://gegidze-agency-web-production.up.railway.app/api';

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
          // Inject content script if not already present
          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ['content.js'],
            });
          } catch (injectErr) {
            console.warn('[Gegidze] Content script injection:', injectErr.message);
          }

          // Get tab audio stream ID for capturing other participants
          let tabStreamId = null;
          try {
            tabStreamId = await new Promise((resolve, reject) => {
              chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                } else {
                  resolve(streamId);
                }
              });
            });
          } catch (tabErr) {
            console.warn('[Gegidze] Tab capture not available:', tabErr.message);
          }

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

          // Tell content script to start recording mic + tab audio
          chrome.tabs.sendMessage(tabId, {
            type: 'START_RECORDING',
            meetingId: meeting.id,
            tabStreamId: tabStreamId,
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
      const stoppedTabId = recordingTabId;
      const stoppedMeetingId = recordingMeetingId;

      if (stoppedTabId) {
        chrome.tabs.sendMessage(stoppedTabId, { type: 'STOP_RECORDING' }).catch(() => {});
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

      // Update meeting status on server
      if (stoppedMeetingId) {
        getAuthToken().then(async (token) => {
          if (!token) return;
          try {
            await fetch(`${API_BASE}/meetings/${stoppedMeetingId}/status`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({ status: 'processing' }),
            });
          } catch (e) {
            console.error('[Gegidze] Failed to update meeting status:', e);
          }
        });
      }

      sendResponse({ ok: true });
      return true;
    }

    case 'UPLOAD_AUDIO': {
      handleUpload(msg.audioData, msg.speakerData, msg.meetingId).then(() => {
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
async function handleUpload(audioData, speakerData, meetingId) {
  const token = await getAuthToken();
  if (!token || !meetingId) throw new Error('Not authenticated');

  const micBlob = new Blob([new Uint8Array(audioData)], { type: 'audio/webm' });
  console.log(`[Gegidze] Uploading mic: ${micBlob.size} bytes for meeting ${meetingId}`);

  const formData = new FormData();
  formData.append('meetingId', meetingId);
  formData.append('mic', micBlob, 'recording.webm');

  if (speakerData) {
    const speakerBlob = new Blob([new Uint8Array(speakerData)], { type: 'audio/webm' });
    formData.append('speaker', speakerBlob, 'speaker.webm');
    console.log(`[Gegidze] Also uploading speaker: ${speakerBlob.size} bytes`);
  }

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
