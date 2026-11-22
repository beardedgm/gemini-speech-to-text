// Hidden capture window (Windows tray app): records mics with getUserMedia
// and sends 16 kHz mono s16 PCM to the main process in ~50 ms chunks.
//
// Why here and not ffmpeg: Chromium opens a WASAPI stream in ~40 ms and
// delivers audio in ~80-110 ms (ffmpeg/DirectShow: ~450 ms), it knows the
// Windows default device ("default" follows Sound settings), and it reports
// devices coming and going (devicechange). The mic is only opened while a
// dictation or test runs, so Windows' "microphone in use" icon is off at rest.

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 800; // 50 ms

let ctx = null;
let suspendTimer = null;
let workletLoaded = null;
const sessions = new Map(); // session id -> { stream, source, node, pending, count, closed }

function send(msg) { window.capture.send(msg); }

// "Default - Microphone (Elgato Wave:3) (0fd9:0070)" -> "Microphone (Elgato Wave:3)"
function cleanLabel(label) {
  return String(label || '')
    .replace(/^(Default|Communications)\s+-\s+/i, '')
    .replace(/\s+\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
    .trim();
}

async function listDevices() {
  const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const def = all.find((d) => d.deviceId === 'default');
  const devices = all
    .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d) => ({ id: d.deviceId, name: cleanLabel(d.label) || 'Microphone', groupId: d.groupId }));
  // Windows: "Default - Microphone (Elgato Wave:3) (0fd9:0070)"
  let defaultName = def ? cleanLabel(def.label) : null;
  if (def && !defaultName) defaultName = devices.find((d) => d.groupId === def.groupId)?.name ?? null;
  return { devices, defaultName };
}

async function publishDevices() {
  try { send({ type: 'devices', ...(await listDevices()) }); } catch (e) { send({ type: 'devices', devices: [], defaultName: null, error: e.message }); }
}

async function audioContext() {
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    workletLoaded = ctx.audioWorklet.addModule('capture-worklet.js');
    workletLoaded.catch(() => { ctx = null; workletLoaded = null; }); // try again next time
  }
  await workletLoaded;
  clearTimeout(suspendTimer);
  await ctx.resume(); // also wins over a suspend() still in progress
  return ctx;
}

function toS16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

function constraints(deviceId) {
  return {
    audio: {
      deviceId: deviceId === 'default' ? 'default' : { exact: deviceId },
      channelCount: 1,
      // No echo cancellation or auto gain (levels stay comparable for the
      // silence cutoff and the dead-mic check). Noise suppression on: without
      // it Chromium asks Windows for the raw stream, and a laptop mic array
      // (measured: Realtek on the Aero 15) then idles around -45 dBFS, which
      // the -40 dBFS speech cutoff can't tell from talking; with it, -63 dBFS.
      echoCancellation: false, noiseSuppression: true, autoGainControl: false,
    },
  };
}

function errorText(e) {
  if (e?.name === 'NotAllowedError') return 'Windows is blocking microphone access (Settings > Privacy & security > Microphone > Let desktop apps access your microphone)';
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'it isn\'t connected';
  if (e?.name === 'NotReadableError') return 'it\'s in use or not working (Windows couldn\'t start it)';
  return `${e?.name || 'Error'}: ${e?.message || e}`;
}

async function open(id, deviceId, t0) {
  const s = { pending: [], count: 0, closed: false };
  sessions.set(id, s);
  try {
    const [stream, ac] = await Promise.all([navigator.mediaDevices.getUserMedia(constraints(deviceId)), audioContext()]);
    if (s.closed || sessions.get(id) !== s) { stream.getTracks().forEach((t) => t.stop()); return; }
    s.stream = stream;
    s.source = ac.createMediaStreamSource(stream);
    s.node = new AudioWorkletNode(ac, 'gstt-tap');
    let first = true;
    s.node.port.onmessage = (e) => {
      if (s.closed) return;
      if (first) { first = false; send({ type: 'first-audio', session: id, ms: Math.round(performance.now() - t0) }); }
      s.pending.push(e.data);
      s.count += e.data.length;
      if (s.count >= CHUNK_SAMPLES) flush(id, s);
    };
    s.source.connect(s.node);
    const track = stream.getAudioTracks()[0];
    track.onended = () => send({ type: 'ended', session: id });
    send({ type: 'opened', session: id, ms: Math.round(performance.now() - t0), label: cleanLabel(track.label) });
  } catch (e) {
    if (sessions.get(id) !== s) return; // replaced by a newer open of this session
    sessions.delete(id);
    send({ type: 'failed', session: id, error: errorText(e), name: e?.name });
  }
}

function flush(id, s) {
  if (!s.count) return;
  const all = new Float32Array(s.count);
  let off = 0;
  for (const b of s.pending) { all.set(b, off); off += b.length; }
  s.pending = [];
  s.count = 0;
  window.capture.chunk(id, toS16(all));
}

function close(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.closed = true;
  flush(id, s);
  try { s.source?.disconnect(); s.node?.disconnect(); } catch { /* already gone */ }
  s.stream?.getTracks().forEach((t) => t.stop());
  sessions.delete(id);
  // Nothing recording: let the audio thread sleep.
  // Not at once: a restart closes and reopens straight away.
  clearTimeout(suspendTimer);
  if (!sessions.size) suspendTimer = setTimeout(() => { if (!sessions.size) ctx?.suspend().catch(() => {}); }, 5000);
}

window.capture.onCommand(async (cmd) => {
  if (cmd.type === 'open') {
    close(cmd.session);
    await open(cmd.session, cmd.deviceId, performance.now());
  } else if (cmd.type === 'close') {
    close(cmd.session);
    send({ type: 'closed', session: cmd.session });
  } else if (cmd.type === 'list') {
    await publishDevices();
  }
});

navigator.mediaDevices.addEventListener('devicechange', publishDevices);
publishDevices();
