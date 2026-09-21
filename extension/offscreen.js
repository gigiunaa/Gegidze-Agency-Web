// Records the call audio away from the Meet tab.
// Chrome stops playing a tab's audio to the speakers while that tab is being captured, so the
// captured sound is played back from here — outside the captured tab, where it is not picked up
// again. Doing this inside the Meet tab either stayed silent or fed back into the recording.

let recorder = null;
let chunks = [];
let stream = null;
let playbackContext = null;
let recorded = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.type === 'OFFSCREEN_START') {
    startCapture(msg.streamId).then(sendResponse, (err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'OFFSCREEN_STOP') {
    stopCapture().then(sendResponse, (err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'OFFSCREEN_UPLOAD') {
    uploadCapture(msg.recordingId, msg.token, msg.apiBase).then(sendResponse, (err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function startCapture(streamId) {
  await stopCapture().catch(() => {});
  chunks = [];

  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  });

  // Give the sound back to the user
  playbackContext = new AudioContext();
  playbackContext.createMediaStreamSource(stream).connect(playbackContext.destination);
  await playbackContext.resume().catch(() => {});

  recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.start(1000);
  console.log('[Unitty offscreen] capturing tab audio, playback', playbackContext.state);
  return { ok: true };
}

async function stopCapture() {
  if (!recorder) return { bytes: 0 };

  const finished = new Promise((resolve) => { recorder.onstop = resolve; });
  if (recorder.state !== 'inactive') recorder.stop();
  await finished;

  recorded = new Blob(chunks, { type: 'audio/webm' });
  stream?.getTracks().forEach((t) => t.stop());
  await playbackContext?.close().catch(() => {});
  recorder = null; chunks = []; stream = null; playbackContext = null;

  console.log(`[Unitty offscreen] stopped, ${recorded.size} bytes`);
  return { bytes: recorded.size };
}

// Uploaded from here rather than handed to the background worker: a long call is far too much
// data to pass between extension contexts as a message.
async function uploadCapture(recordingId, token, apiBase) {
  if (!recorded || recorded.size === 0) return { skipped: 'nothing recorded' };

  const form = new FormData();
  form.append('speaker', recorded, 'speaker.webm');
  const res = await fetch(`${apiBase}/recordings/${recordingId}/speaker`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`server said ${res.status}`);

  console.log(`[Unitty offscreen] uploaded ${recorded.size} bytes for recording ${recordingId}`);
  recorded = null;
  return { ok: true };
}
