const API_BASE = 'https://gegidze-agency-web-production.up.railway.app/api';

// ── DOM Elements ──────────────────────────────────────────────────────────
const loginView = document.getElementById('login-view');
const mainView = document.getElementById('main-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');
const callStatus = document.getElementById('call-status');
const noCallStatus = document.getElementById('no-call-status');
const callPlatform = document.getElementById('call-platform');
const recordBtn = document.getElementById('record-btn');
const stopBtn = document.getElementById('stop-btn');
const notRecording = document.getElementById('not-recording');
const isRecording = document.getElementById('is-recording');
const recTimer = document.getElementById('rec-timer');
const autoRecordToggle = document.getElementById('auto-record');
const uploadStatus = document.getElementById('upload-status');
const mainError = document.getElementById('main-error');

let timerInterval = null;

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const auth = await sendMessage({ type: 'GET_AUTH' });

  if (auth?.authToken) {
    showMainView();
    refreshState();
  } else {
    showLoginView();
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';

  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Login failed');
    }

    const data = await res.json();
    await sendMessage({ type: 'SAVE_AUTH', token: data.token, email });
    showMainView();
    refreshState();
  } catch (err) {
    loginError.textContent = err.message;
  }
});

logoutBtn.addEventListener('click', async () => {
  await sendMessage({ type: 'LOGOUT' });
  showLoginView();
});

// ── Recording Controls ───────────────────────────────────────────────────
recordBtn.addEventListener('click', async () => {
  mainError.textContent = '';
  const state = await sendMessage({ type: 'GET_STATE' });

  // Try active call tab first, then fall back to current active tab
  let tabId;
  if (state?.activeCalls?.length > 0) {
    tabId = state.activeCalls[0].tabId;
  } else {
    // Get the current active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }

  if (!tabId) {
    mainError.textContent = 'No active tab found';
    return;
  }

  const result = await sendMessage({ type: 'START_RECORDING', tabId });
  if (result?.error) {
    mainError.textContent = result.error;
  } else {
    refreshState();
  }
});

stopBtn.addEventListener('click', async () => {
  await sendMessage({ type: 'STOP_RECORDING' });
  refreshState();
});

// ── State Management ─────────────────────────────────────────────────────
async function refreshState() {
  const state = await sendMessage({ type: 'GET_STATE' });
  if (!state) return;

  const hasActiveCalls = state.activeCalls && state.activeCalls.length > 0;

  // Always enable record button
  recordBtn.disabled = false;

  if (hasActiveCalls) {
    const call = state.activeCalls[0];
    callStatus.classList.remove('hidden');
    noCallStatus.classList.add('hidden');
    callPlatform.textContent = `${call.platform} call active`;
  } else {
    callStatus.classList.add('hidden');
    noCallStatus.classList.remove('hidden');
  }

  if (state.isRecording) {
    notRecording.classList.add('hidden');
    isRecording.classList.remove('hidden');
    startTimer(state.startTime);
  } else {
    notRecording.classList.remove('hidden');
    isRecording.classList.add('hidden');
    stopTimer();
  }
}

// ── Timer ─────────────────────────────────────────────────────────────────
function startTimer(startTime) {
  stopTimer();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const s = (elapsed % 60).toString().padStart(2, '0');
    recTimer.textContent = `${m}:${s}`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  recTimer.textContent = '00:00';
}

// ── View toggling ────────────────────────────────────────────────────────
function showLoginView() {
  loginView.classList.remove('hidden');
  mainView.classList.add('hidden');
}

function showMainView() {
  loginView.classList.add('hidden');
  mainView.classList.remove('hidden');
}

// ── Messages from background ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'UPLOAD_COMPLETE') {
    uploadStatus.classList.remove('hidden');
    setTimeout(() => uploadStatus.classList.add('hidden'), 5000);
  }
});

// ── Helper ────────────────────────────────────────────────────────────────
function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      resolve(response);
    });
  });
}
