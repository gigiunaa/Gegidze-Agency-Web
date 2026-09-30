// Runs in the Meet tab once the bot is in the call. Reading the individual participant tracks
// turned out to be impossible — four ways of doing it all came back silent — so the call is
// recorded the way a person hears it: the tab's own audio output, everyone mixed together.
// Who said what is worked out afterwards, from the recording itself.
export const TAB_AUDIO_SOURCE = `
(() => {
  if (window.__unittyTabRecorder) return;

  window.__unittyTabAudio = { state: 'idle', error: '', bytes: 0, surface: '', chunks: [] };

  window.__unittyStartTabAudio = async () => {
    const info = window.__unittyTabAudio;
    try {
      // Chrome only gives up a tab's audio through a display capture, and only from a real user
      // gesture — which the launch flags stand in for.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        systemAudio: 'exclude',
      });

      const audio = stream.getAudioTracks();
      if (audio.length === 0) {
        info.state = 'failed';
        info.error = 'the capture came back with no audio track';
        stream.getTracks().forEach((t) => t.stop());
        return info;
      }

      // The picture is of no use to a transcript and costs a great deal to carry. Its settings
      // are read first, because they are the only proof of which surface was handed over.
      const surface = stream.getVideoTracks()[0]?.getSettings()?.displaySurface || 'unknown';
      info.surface = surface;
      for (const t of stream.getVideoTracks()) { t.stop(); stream.removeTrack(t); }

      const settings = stream.getVideoTracks()[0] ? stream.getVideoTracks()[0].getSettings() : {};
      info.surface = settings.displaySurface || 'unknown';

      window.__unittyCaptureTrack = audio[0];
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) { info.chunks.push(e.data); info.bytes += e.data.size; }
      };
      recorder.start(2000);
      window.__unittyTabRecorder = recorder;
      info.state = 'recording';
    } catch (err) {
      info.state = 'failed';
      info.error = String(err && err.message ? err.message : err);
    }
    return info;
  };

  window.__unittyStopTabAudio = async () => {
    const info = window.__unittyTabAudio;
    const recorder = window.__unittyTabRecorder;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
    }
    info.chunkCount = info.chunks.length;
    info.trackState = window.__unittyCaptureTrack ? window.__unittyCaptureTrack.readyState : 'no track';
    info.recorderState = recorder ? recorder.state : 'no recorder';

    const blob = new Blob(info.chunks, { type: 'audio/webm' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { state: info.state, error: info.error, surface: info.surface, chunkCount: info.chunkCount, trackState: info.trackState, recorderState: info.recorderState, bytes: buf.length, base64: btoa(bin) };
  };
})();
`;
