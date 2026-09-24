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
  window.__unittyStartedAt = Date.now();
  const receivers = new Set();

  function watch(pc) {
    pc.addEventListener('track', (event) => {
      if (event.track && event.track.kind === 'audio' && event.receiver) receivers.add(event.receiver);
    });
  }

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

  setInterval(() => {
    const atMs = Date.now() - window.__unittyStartedAt;
    for (const receiver of receivers) {
      const contributing = receiver.getContributingSources ? receiver.getContributingSources() : [];
      for (const s of contributing) {
        if (typeof s.audioLevel !== 'number') continue;
        window.__unittySamples.push({ csrc: s.source, audioLevel: s.audioLevel, atMs });
      }
      // Some builds report the stream's own synchronization source instead of contributing ones
      const own = receiver.getSynchronizationSources ? receiver.getSynchronizationSources() : [];
      for (const s of own) {
        if (typeof s.audioLevel !== 'number') continue;
        window.__unittySamples.push({ csrc: s.source, audioLevel: s.audioLevel, atMs });
      }
    }
  }, 200);
})();
`;
