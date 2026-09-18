// Records the call audio away from the Meet tab.
// Chrome stops playing a tab's audio to the speakers while that tab is being captured, so the
// captured sound is played back from here — outside the captured tab, where it is not picked up
// again. Doing this inside the Meet tab either stayed silent or fed back into the recording.

let recorder = null;
let chunks = [];
let stream = null;
let playbackContext = null;

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
  console.log('[Gegidze offscreen] capturing tab audio, playback', playbackContext.state);
  return { ok: true };
}

async function stopCapture() {
  if (!recorder) return { audio: null };

  const finished = new Promise((resolve) => { recorder.onstop = resolve; });
  if (recorder.state !== 'inactive') recorder.stop();
  await finished;

  const blob = new Blob(chunks, { type: 'audio/webm' });
  const audio = blob.size > 0 ? Array.from(new Uint8Array(await blob.arrayBuffer())) : null;

  stream?.getTracks().forEach((t) => t.stop());
  await playbackContext?.close().catch(() => {});
  recorder = null; chunks = []; stream = null; playbackContext = null;

  console.log(`[Gegidze offscreen] stopped, ${audio ? audio.length : 0} bytes`);
  return { audio };
}
