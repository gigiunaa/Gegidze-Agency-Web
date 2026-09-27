// Runs inside the Meet tab, before Meet's own code. Every RTCPeerConnection Meet creates is
// wrapped so its inbound audio receivers can be watched. Meet sends the loudest speakers as a
// handful of RTP streams rather than one per person, and the contributing-source (CSRC) ids on
// those streams are what say who is actually talking — which is why this reads the transport
// instead of the screen.
export const RTC_HOOK_SOURCE = `
(() => {
  const Original = window.RTCPeerConnection;
  if (!Original || window.__unittyHooked) return;
  window.__unittyHooked = true;

  window.__unittySamples = [];
  window.__unittyTrackSamples = [];
  window.__unittyStartedAt = Date.now();
  const receivers = new Set();

  const connections = new Set();

  // Measuring the track itself, rather than asking the connection about it. getStats reported a
  // single placeholder stream at level zero on a live call while three audio tracks were plainly
  // flowing, so the audio is taken where it certainly exists: at the track.
  const meters = [];
  const entryChunks = [];
  let audioContext = null;

  function meter(track) {
    try {
      audioContext = audioContext || new AudioContext();
      const stream = new MediaStream([track]);

      // Chrome only decodes a remote track that something is actually consuming. An analyser on
      // its own is not enough — it reads silence for ever. Running the graph all the way to the
      // speakers is, and a gain of zero means nothing comes out of them. A muted <audio> element
      // does not work here: Chrome is free to skip decoding for something nobody can hear.
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      const silence = audioContext.createGain();
      silence.gain.value = 0;
      source.connect(analyser);
      analyser.connect(silence);
      silence.connect(audioContext.destination);
      audioContext.resume().catch(() => {});

      // Recorded as well as measured. Whether the level meters work or not, the audio itself is
      // what the product needs, and a file that can be played back settles what is really on
      // this track far better than another number does.
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.start(1000);
      entryChunks.push({ id: 'track' + (meters.length + 1), recorder, chunks });
      const buffer = new Float32Array(analyser.fftSize);
      const entry = { id: 'track' + (meters.length + 1), track, analyser, buffer };
      meters.push(entry);
      return entry;
    } catch (err) {
      window.__unittyDebug.lastError = 'meter: ' + String(err && err.message ? err.message : err);
      return null;
    }
  }

  function watch(pc) {
    connections.add(pc);
    pc.addEventListener('track', (event) => {
      if (event.track && event.track.kind === 'audio' && event.receiver) {
        receivers.add(event.receiver);
        meter(event.track);
      }
    });
  }

  // getStats() is the reliable way to find out who is making noise. Meet's SFU does not put
  // contributing sources on the streams it forwards — checked on a live call, 457 polls, always
  // empty — but it does send each participant as their own inbound stream, and the stats for
  // those carry both the stream's id and its current audio level.
  let statsInFlight = false;
  window.__unittyPollStats = async () => {
    // getStats resolves asynchronously; without this the 200ms timer stacks calls on a slow frame
    if (statsInFlight) return;
    statsInFlight = true;
    const atMs = Date.now() - window.__unittyStartedAt;
    for (const pc of connections) {
      let stats;
      try {
        stats = await pc.getStats();
      } catch (err) {
        window.__unittyDebug.lastError = String(err && err.message ? err.message : err);
        continue;
      }
      stats.forEach((entry) => {
        if (entry.type !== 'inbound-rtp' || entry.kind !== 'audio') return;
        window.__unittyDebug.inboundSeen++;
        if (typeof entry.audioLevel !== 'number') return;
        window.__unittyDebug.withLevel++;
        window.__unittySamples.push({ csrc: entry.ssrc, audioLevel: entry.audioLevel, atMs });
      });
    }
    statsInFlight = false;
  };

  // Meet's own code calls this as a constructor, so the wrapper has to behave like one: keep the
  // prototype chain and the static members, or Meet breaks before it ever reaches the call.
  function Hooked(...args) {
    const pc = new Original(...args);
    watch(pc);
    return pc;
  }
  Hooked.prototype = Original.prototype;
  Object.setPrototypeOf(Hooked, Original);
  window.RTCPeerConnection = Hooked;

  window.__unittyReceiverCount = () => receivers.size;

  window.__unittyFinish = async () => {
    const out = [];
    for (const e of entryChunks) {
      if (e.recorder.state !== 'inactive') {
        await new Promise((resolve) => { e.recorder.onstop = resolve; e.recorder.stop(); });
      }
      const blob = new Blob(e.chunks, { type: 'audio/webm' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      out.push({ id: e.id, bytes: buf.length, base64: btoa(bin) });
    }
    return out;
  };

  // Nothing here is guesswork-friendly: when no samples come out, the difference between "the
  // poll never ran", "the API is missing", "it returned nothing" and "it returned entries with no
  // level" decides what to fix, so all four are recorded.
  window.__unittyDebug = {
    polls: 0, contributing: 0, synchronization: 0, inboundSeen: 0, withLevel: 0, lastError: '', tracks: [], trackLevels: {},
  };

  setInterval(() => {
    const atMs = Date.now() - window.__unittyStartedAt;
    const dbg = window.__unittyDebug;
    dbg.polls++;

    // The bot must not play the call out loud: in the same room as a participant that is a
    // feedback loop, and the person ends up muting themselves. Silencing the elements rather
    // than the whole browser keeps Chrome decoding the audio, which is what the meters read.
    for (const el of document.querySelectorAll('audio, video')) {
      if (el.volume !== 0) el.volume = 0;
    }
    window.__unittyPollStats();

    // Loudness straight off each track: the peak sample in the current window. A track that is
    // silent stays near zero, so this is also what says whether anyone is talking at all.
    for (const m of meters) {
      m.analyser.getFloatTimeDomainData(m.buffer);
      let peak = 0;
      for (let i = 0; i < m.buffer.length; i++) {
        const v = m.buffer[i] < 0 ? -m.buffer[i] : m.buffer[i];
        if (v > peak) peak = v;
      }
      dbg.trackLevels[m.id] = Math.max(dbg.trackLevels[m.id] || 0, peak);
      window.__unittyTrackSamples.push({ csrc: m.id, audioLevel: peak, atMs });
    }
    try {
      dbg.tracks = [];
      for (const receiver of receivers) {
        dbg.tracks.push({
          kind: receiver.track ? receiver.track.kind : '?',
          state: receiver.track ? receiver.track.readyState : '?',
          muted: receiver.track ? receiver.track.muted : null,
          hasContributing: typeof receiver.getContributingSources === 'function',
          hasSynchronization: typeof receiver.getSynchronizationSources === 'function',
        });

        const contributing = receiver.getContributingSources ? receiver.getContributingSources() : [];
        dbg.contributing += contributing.length;
        for (const s of contributing) {
          if (typeof s.audioLevel !== 'number') continue;
          dbg.withLevel++;
          window.__unittySamples.push({ csrc: s.source, audioLevel: s.audioLevel, atMs });
        }

        // Some builds report the stream's own synchronization source instead of contributing ones
        const own = receiver.getSynchronizationSources ? receiver.getSynchronizationSources() : [];
        dbg.synchronization += own.length;
        for (const s of own) {
          if (typeof s.audioLevel !== 'number') continue;
          dbg.withLevel++;
          window.__unittySamples.push({ csrc: s.source, audioLevel: s.audioLevel, atMs });
        }
      }
    } catch (err) {
      dbg.lastError = String(err && err.message ? err.message : err);
    }
  }, 200);
})();
`;
