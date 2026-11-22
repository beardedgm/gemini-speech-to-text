import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cleanLabel, DEFAULT_MIC, fallbackMessage, isDefaultMic, micFromEnv, resolveMic, testVerdict } from '../src/mics.js';
import { MicMonitor } from '../src/micmonitor.js';
import { Recorder } from '../src/recorder.js';
import { loadConfig } from '../src/config.js';
import { mergeConfig, validMic } from '../app/store.js';
import { parseDshowAudioDeviceList, resolveMicrophone, FFMPEG_STARTUP_GRACE_MS } from '../src/platform/windows.js';
import { dshowDeviceForEndpoint, endpointGuid } from '../src/platform/wincoreaudio.js';
import { parsePactlSources, parseSourceMute, pwRecordArgs, sourceName } from '../src/platform/linux.js';
import { RendererCapture } from '../app/rendercapture.js';
import { DictationService } from '../src/engine.js';
import { HoldToTalk } from '../src/hotkey.js';
import { testMicrophone } from '../src/mictest.js';

const ELGATO = { id: 'dev-elgato', name: 'Microphone (Elgato Wave:3)' };
const REALTEK = { id: 'dev-realtek', name: 'Microphone (Realtek(R) Audio)' };

test('mic choice: default, by id, by name when the id changed, missing -> fallback', () => {
  const devices = [ELGATO, REALTEK];
  assert.ok(isDefaultMic(null) && isDefaultMic(DEFAULT_MIC) && isDefaultMic({ id: 'default' }));
  assert.deepEqual(resolveMic(devices, null), { device: null, fallback: null });
  assert.equal(resolveMic(devices, { id: 'dev-realtek', name: 'x' }).device, REALTEK);
  // Chromium labels carry " (vid:pid)"; a saved name without it still matches.
  assert.equal(resolveMic([{ id: 'new', name: 'Microphone (Elgato Wave:3) (0fd9:0070)' }], { id: 'old', name: 'Microphone (Elgato Wave:3)' }).device.id, 'new');
  const r = resolveMic(devices, { id: 'gone', name: 'Headset (JBL LIVE660NC)' });
  assert.equal(r.device, null);
  assert.equal(r.fallback.reason, 'not connected');
  assert.equal(fallbackMessage(r.fallback, 'Microphone (Realtek(R) Audio)'),
    "Headset (JBL LIVE660NC) isn't connected, so System default (Microphone (Realtek(R) Audio)) was used.");
  assert.match(fallbackMessage({ wanted: ELGATO, reason: "it's in use" }, null), /couldn't be opened \(it's in use\), so the system default was used/);
});

test('cleanLabel drops the USB vendor:product id only', () => {
  assert.equal(cleanLabel('Microphone (Elgato Wave:3) (0fd9:0070)'), 'Microphone (Elgato Wave:3)');
  assert.equal(cleanLabel('Microphone (Realtek(R) Audio)'), 'Microphone (Realtek(R) Audio)');
});

test('Test button verdicts', () => {
  assert.equal(testVerdict({ error: 'it isn\'t connected' }).text, "Couldn't open it: it isn't connected");
  assert.equal(testVerdict({ bytes: 0, maxDb: -Infinity }).kind, 'no-data');
  assert.equal(testVerdict({ bytes: 9600, maxDb: -Infinity }).kind, 'silent'); // e.g. the Wave:3 today
  assert.equal(testVerdict({ bytes: 9600, maxDb: -101 }).kind, 'too-quiet');
  assert.equal(testVerdict({ bytes: 9600, maxDb: -58 }).kind, 'quiet');
  assert.deepEqual(testVerdict({ bytes: 9600, maxDb: -20 }), { ok: true, kind: 'ok', text: 'Hearing you' });
});

test('GSTT_MIC becomes the choice unless Settings saved one (even System default)', () => {
  const env = { GEMINI_API_KEY: 'k', GSTT_MIC: '@device_cm_{X}\\wave_{Y}' };
  assert.deepEqual(micFromEnv(env), { id: '@device_cm_{X}\\wave_{Y}', name: '@device_cm_{X}\\wave_{Y}', fromEnv: true });
  assert.equal(loadConfig({ GEMINI_API_KEY: 'k' }).mic, null);
  const cfg = loadConfig(env);
  assert.equal(mergeConfig(cfg, {}, null).mic.fromEnv, true);
  assert.deepEqual(mergeConfig(cfg, { mic: { id: 'default', name: 'System default' } }, null).mic, { id: 'default', name: 'System default' });
  assert.deepEqual(mergeConfig(cfg, { mic: REALTEK }, null).mic, REALTEK);
  assert.equal(mergeConfig(cfg, { mic: { id: '' } }, null).mic.fromEnv, true); // invalid saved value ignored
  assert.ok(validMic(REALTEK) && !validMic(null) && !validMic({ name: 'x' }));
});

// --- Windows: the Windows default through Core Audio ---------------------------

const LIST = parseDshowAudioDeviceList([
  '[dshow @ 01] DirectShow audio devices',
  '[dshow @ 01]  "Microphone (Elgato Wave:3)"',
  '[dshow @ 01]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{AEF32A67-693D-495D-8DE5-65D00DED3D8B}"',
  '[dshow @ 01]  "Microphone (Realtek(R) Audio)"',
  '[dshow @ 01]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{82A54AD2-2DD0-4AA9-B602-DBE8C9E729A8}"',
].join('\r\n'));
// Real Core Audio output from the same laptop: default recording = Realtek here.
const ENDPOINTS = [
  { id: '{0.0.1.00000000}.{82a54ad2-2dd0-4aa9-b602-dbe8c9e729a8}', name: 'Microphone (Realtek(R) Audio)', state: 1, muted: false, isDefault: true },
  { id: '{0.0.1.00000000}.{a9fc342c-1c39-418a-a11c-59e8376e9187}', name: 'Headset (JBL LIVE660NC)', state: 8, muted: null, isDefault: false },
  { id: '{0.0.1.00000000}.{aef32a67-693d-495d-8de5-65d00ded3d8b}', name: 'Microphone (Elgato Wave:3)', state: 1, muted: false, isDefault: false },
];

test('Core Audio endpoint GUID = dshow wave_{GUID}: the Windows default maps to the right ffmpeg device', () => {
  assert.equal(endpointGuid(ENDPOINTS[0].id), '82a54ad2-2dd0-4aa9-b602-dbe8c9e729a8');
  assert.equal(endpointGuid(LIST[1].altName), '82a54ad2-2dd0-4aa9-b602-dbe8c9e729a8');
  assert.equal(dshowDeviceForEndpoint(LIST, ENDPOINTS[0]).name, 'Microphone (Realtek(R) Audio)');
  // System default: the Windows default, not the first dshow device.
  assert.equal(resolveMicrophone(LIST, null, ENDPOINTS).name, 'Microphone (Realtek(R) Audio)');
  assert.equal(resolveMicrophone(LIST, DEFAULT_MIC, ENDPOINTS).input, LIST[1].altName);
  // Without Core Audio: the first device, as before.
  assert.equal(resolveMicrophone(LIST, null, null).name, 'Microphone (Elgato Wave:3)');
  // A missing pick falls back to the Windows default and says so.
  const r = resolveMicrophone(LIST, { id: 'x', name: 'Headset (JBL LIVE660NC)' }, ENDPOINTS);
  assert.equal(r.name, 'Microphone (Realtek(R) Audio)');
  assert.equal(r.fallback.wanted.name, 'Headset (JBL LIVE660NC)');
});

test('ffmpeg gets a startup grace period well above its measured ~450 ms first-audio time', () => {
  assert.ok(FFMPEG_STARTUP_GRACE_MS >= 1000);
});

// --- MicMonitor startup grace ----------------------------------------------------

function fakeTimers() {
  const pending = new Map(); let id = 0;
  return {
    setTimer: (fn, ms) => { pending.set(++id, { fn, ms }); return id; },
    clearTimer: (i) => pending.delete(i),
    fire() { const fns = [...pending.values()]; pending.clear(); fns.forEach((f) => f.fn()); return fns.map((f) => f.ms); },
  };
}
const tone = (amp, bytes = 3200) => { const b = Buffer.alloc(bytes); for (let i = 0; i < bytes; i += 2) b.writeInt16LE(i % 4 ? amp : -amp, i); return b; };

test('slow-starting capture: no "no audio" warning until the grace period is over', () => {
  const t = fakeTimers();
  const m = new MicMonitor({ checkAfterMs: 500, graceMs: 1500, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const ev = [];
  m.on('warning', (w) => ev.push(w));
  m.start();
  t.fire(); // 500 ms: nothing yet, but still inside the grace period
  assert.deepEqual(ev, []);
  m.push(tone(3000, 9600)); // first audio at ~600 ms (ffmpeg: ~450-570 ms)
  t.fire();
  assert.deepEqual(ev, []);
  // A capture that never delivers is still reported once the grace period is used up.
  const m2 = new MicMonitor({ checkAfterMs: 500, graceMs: 1500, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const ev2 = [];
  m2.on('warning', (w) => ev2.push(w));
  m2.start();
  for (let i = 0; i < 20 && !ev2.length; i++) t.fire();
  assert.deepEqual(ev2, ['no-data']);
  assert.ok(m2.waited >= 1500 && m2.waited <= 1600, String(m2.waited));
});

test('without a grace period the monitor behaves as before (one check at checkAfterMs)', () => {
  const t = fakeTimers();
  const m = new MicMonitor({ checkAfterMs: 500, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const ev = [];
  m.on('warning', (w) => ev.push(w));
  m.start();
  assert.deepEqual(t.fire(), [500]);
  assert.deepEqual(ev, ['no-data']);
});

// --- Recorder ----------------------------------------------------------------------

test('recorder restart kills the old capture process and waits for it to exit before starting the new one', async () => {
  const events = [];
  const rec = new Recorder({ command: process.execPath, args: [], stopProcess: (p) => p.kill() });
  let n = 0;
  rec.spawnProc = ((orig) => function () {
    n++;
    const me = n;
    this.args = ['-e', me === 1 ? 'process.stdout.write("AAAA"); setInterval(() => {}, 1000)' : 'setInterval(() => process.stdout.write("BBBB"), 30)'];
    events.push(`spawn ${me}`);
    orig.call(this);
    this.proc.on('exit', () => events.push(`exit ${me}`));
  })(rec.spawnProc);
  rec.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(rec.restart(), true);
  await new Promise((r) => setTimeout(r, 400));
  const pcm = await rec.stop();
  assert.deepEqual(events.slice(0, 3), ['spawn 1', 'exit 1', 'spawn 2']);
  const s = pcm.toString();
  assert.ok(s.startsWith('AAAA') && s.includes('BBBB'), s.slice(0, 20));
  assert.equal(rec.openError, null); // the killed process is not an "open failure"
});

test('recorder: argsFor picks capture arguments per dictation from the mic choice', async () => {
  const seen = [];
  const rec = new Recorder({
    command: process.execPath,
    argsFor: (mic) => { seen.push(mic?.id ?? null); return ['-e', 'process.stdout.write(Buffer.alloc(320)); process.stdin.on("data", () => process.exit(0))']; },
    stopProcess: (p) => p.stdin.write('q'),
  });
  rec.start({ mic: REALTEK });
  await new Promise((r) => setTimeout(r, 200));
  await rec.stop();
  rec.start({ mic: null });
  await new Promise((r) => setTimeout(r, 200));
  await rec.stop();
  assert.deepEqual(seen, ['dev-realtek', null]);
});

// --- Linux (PipeWire) ------------------------------------------------------------------

test('Linux: pactl sources become mic choices (monitors left out); pw-record targets only an explicit pick', () => {
  const json = JSON.stringify([
    { name: 'alsa_output.pci-0000_00_1f.3.analog-stereo.monitor', description: 'Monitor of Built-in Audio', monitor_of_sink: 'alsa_output.pci-0000_00_1f.3.analog-stereo', properties: { 'device.class': 'monitor' } },
    { name: 'alsa_input.usb-Elgato_Systems_Elgato_Wave_3-00.mono-fallback', description: 'Elgato Wave:3 Mono', monitor_of_sink: 'n/a', properties: { 'object.serial': 57 } },
    { name: 'alsa_input.pci-0000_00_1f.3.analog-stereo', description: 'Built-in Audio Analog Stereo', monitor_of_sink: 'n/a', properties: {} },
  ]);
  assert.deepEqual(parsePactlSources(json), [
    { id: 'alsa_input.usb-Elgato_Systems_Elgato_Wave_3-00.mono-fallback', name: 'Elgato Wave:3 Mono', altIds: ['57'] },
    { id: 'alsa_input.pci-0000_00_1f.3.analog-stereo', name: 'Built-in Audio Analog Stereo', altIds: [] },
  ]);
  assert.deepEqual(parsePactlSources('not json'), []);
  // A GSTT_MIC serial still matches the node.
  assert.equal(resolveMic(parsePactlSources(json), { id: '57', name: '57' }).device.name, 'Elgato Wave:3 Mono');
  assert.ok(!pwRecordArgs(null).some((a) => a.startsWith('--target')), 'default follows the system default live');
  assert.ok(pwRecordArgs('alsa_input.x').includes('--target=alsa_input.x'));
});

// --- Windows tray capture (hidden renderer), with a fake window ---------------------------

function fakeCaptureWindow(behaviour = {}) {
  const sent = [];
  let cap;
  const win = {
    send(cmd) {
      sent.push(cmd);
      setImmediate(() => {
        if (cmd.type === 'open') {
          const fail = behaviour.fail?.(cmd.deviceId);
          if (fail) return cap.onEvent({ type: 'failed', session: cmd.session, error: fail });
          cap.onEvent({ type: 'opened', session: cmd.session, ms: 40, label: behaviour.label?.(cmd.deviceId) ?? cmd.deviceId });
          cap.onChunk(cmd.session, new Uint8Array(behaviour.chunk ?? tone(3000, 1600)));
        } else if (cmd.type === 'close') {
          cap.onChunk(cmd.session, new Uint8Array(behaviour.chunk ?? tone(3000, 1600)));
          cap.onEvent({ type: 'closed', session: cmd.session });
        }
      });
    },
    destroy() {},
  };
  cap = new RendererCapture({
    createWindow: () => { setImmediate(() => cap.onEvent({ type: 'devices', devices: [ELGATO, REALTEK], defaultName: 'Microphone (Elgato Wave:3)' })); return win; },
  });
  return { cap, sent };
}

test('tray capture: System default opens "default"; an explicit pick opens that device', async () => {
  const { cap, sent } = fakeCaptureWindow({ label: (id) => (id === 'default' ? 'Microphone (Elgato Wave:3)' : id) });
  assert.equal(await cap.ready(), true);
  const rec = cap.createRecorder();
  const mics = [];
  rec.on('mic', (m) => mics.push(m));
  rec.start({ onChunk() {}, mic: null });
  await new Promise((r) => setImmediate(r));
  const pcm = await rec.stop();
  assert.ok(pcm.length >= 3200, 'keeps the audio that arrives while closing');
  rec.start({ onChunk() {}, mic: REALTEK });
  await new Promise((r) => setImmediate(r));
  await rec.stop();
  assert.deepEqual(sent.filter((c) => c.type === 'open').map((c) => c.deviceId), ['default', 'dev-realtek']);
  assert.deepEqual(mics, [{ name: 'Microphone (Elgato Wave:3)', fallback: null }, { name: REALTEK.name, fallback: null }]);
});

test('tray capture: a missing pick and a pick that fails to open both fall back to the default and say why', async () => {
  const { cap, sent } = fakeCaptureWindow({ fail: (id) => (id === 'dev-realtek' ? "it's in use or not working (Windows couldn't start it)" : null), label: () => 'Microphone (Elgato Wave:3)' });
  await cap.ready();
  const rec = cap.createRecorder();
  const mics = [];
  rec.on('mic', (m) => mics.push(m));
  rec.start({ onChunk() {}, mic: { id: 'gone', name: 'Headset (JBL LIVE660NC)' } });
  await new Promise((r) => setTimeout(r, 5));
  await rec.stop();
  rec.start({ onChunk() {}, mic: REALTEK });
  await new Promise((r) => setTimeout(r, 5));
  await rec.stop();
  assert.deepEqual(sent.filter((c) => c.type === 'open').map((c) => c.deviceId), ['default', 'dev-realtek', 'default']);
  assert.equal(mics[0].fallback.reason, 'not connected');
  assert.equal(mics[0].name, 'Microphone (Elgato Wave:3)');
  assert.match(mics[1].fallback.reason, /in use/);
});

test('tray capture: GSTT_MIC holding a dshow id is matched through its friendly name', async () => {
  const { cap } = fakeCaptureWindow();
  await cap.ready();
  cap.aliases.set('@device_cm_{X}\\wave_{AEF}', 'Microphone (Elgato Wave:3)');
  assert.equal(cap.resolve({ id: '@device_cm_{X}\\wave_{AEF}', name: '@device_cm_{X}\\wave_{AEF}', fromEnv: true }).deviceId, 'dev-elgato');
});

test('tray capture Test: verdict per mic; silence is "No sound from this mic"; a missing pick says not connected', async () => {
  const { cap } = fakeCaptureWindow({ chunk: Buffer.alloc(1600) });
  await cap.ready();
  const levels = [];
  const r = await cap.test(ELGATO, { seconds: 0.01, onLevel: (db) => levels.push(db) });
  assert.equal(r.kind, 'silent');
  assert.match(r.text, /^No sound from this mic/);
  assert.ok(levels.length >= 1);
  const missing = await cap.test({ id: 'gone', name: 'USB Mic' }, { seconds: 0.01 });
  assert.equal(missing.text, "Couldn't open it: it isn't connected");
  const all = await cap.testAll({ seconds: 0.01 });
  assert.deepEqual(all.map((x) => x.id), ['dev-elgato', 'dev-realtek']);
});

test('tray capture: device changes are announced (Settings refreshes its list)', async () => {
  const { cap } = fakeCaptureWindow();
  await cap.ready();
  const changes = [];
  cap.on('devices-changed', (l) => changes.push(l));
  cap.onEvent({ type: 'devices', devices: [REALTEK], defaultName: REALTEK.name });
  cap.onEvent({ type: 'devices', devices: [REALTEK], defaultName: REALTEK.name }); // same again: no event
  assert.deepEqual(changes, [{ devices: [REALTEK], defaultName: REALTEK.name }]);
});

// --- engine: fallback notification and per-dictation mic -------------------------------

test('engine: passes the configured mic to each dictation, logs which one opened, and reports a fallback', async () => {
  const rec = new EventEmitter();
  const starts = [];
  rec.start = ({ mic }) => {
    rec.proc = {};
    starts.push(mic);
    rec.micName = 'Microphone (Realtek(R) Audio)';
    setImmediate(() => rec.emit('mic', { name: rec.micName, fallback: { wanted: ELGATO, reason: 'not connected' } }));
  };
  rec.stop = async () => { rec.proc = null; return tone(3000, 32000); };
  rec.cancel = async () => { rec.proc = null; };
  let hotkey;
  const platform = {
    createHotkey: (keys) => {
      hotkey = new HoldToTalk({ keys, minHoldMs: 0, findDevices: () => [{ path: 'k', name: 'kbd' }] });
      hotkey.openDevice = (kb) => hotkey.readers.set(kb.path, { name: kb.name, proc: { kill() {} } });
      return hotkey;
    },
    createRecorder: () => rec,
    pasteText: async () => {},
    pasteDescription: () => 'fake',
    microphoneMuted: async () => false,
    beep() {},
  };
  const config = { ...loadConfig({ GEMINI_API_KEY: 'k', GSTT_MODE: 'oneshot' }), mic: ELGATO };
  const svc = new DictationService(config, platform, {
    retryFile: null,
    dictationFactory: () => ({ push() {}, abort() {}, finish: async () => ({ text: 'x' }) }),
  });
  const logs = [];
  svc.on('log', (m) => logs.push(m));
  const fallbacks = [];
  svc.on('mic-fallback', (f) => fallbacks.push(f));
  await svc.start();
  hotkey.handleKey(29, 1, 'k'); hotkey.handleKey(125, 1, 'k');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(starts, [ELGATO]);
  assert.equal(fallbacks.length, 1);
  assert.match(fallbacks[0].message, /Elgato Wave:3\) isn't connected, so System default \(Microphone \(Realtek\(R\) Audio\)\) was used/);
  assert.ok(logs.includes('Microphone: Microphone (Realtek(R) Audio)'));
  await svc.stop();
});

test('engine: a mic Windows reports as muted is reported right away, without resets', async () => {
  const rec = new EventEmitter();
  let restarts = 0;
  rec.start = ({ onChunk }) => { rec.proc = {}; rec.onChunk = onChunk; };
  rec.restart = () => { restarts++; return true; };
  rec.stop = async () => { rec.proc = null; return Buffer.alloc(3200); };
  rec.cancel = async () => { rec.proc = null; };
  rec.micName = 'Microphone (Elgato Wave:3)';
  let hotkey;
  const platform = {
    createHotkey: (keys) => {
      hotkey = new HoldToTalk({ keys, minHoldMs: 0, findDevices: () => [{ path: 'k', name: 'kbd' }] });
      hotkey.openDevice = (kb) => hotkey.readers.set(kb.path, { name: kb.name, proc: { kill() {} } });
      return hotkey;
    },
    createRecorder: () => rec,
    pasteText: async () => {},
    pasteDescription: () => 'fake',
    microphoneMuted: async (mic) => mic?.name === 'Microphone (Elgato Wave:3)',
    beep() {},
  };
  const t = fakeTimers();
  const svc = new DictationService(loadConfig({ GEMINI_API_KEY: 'k', GSTT_MODE: 'oneshot' }), platform, {
    retryFile: null,
    monitorFactory: () => new MicMonitor({ setTimer: t.setTimer, clearTimer: t.clearTimer }),
    dictationFactory: () => ({ push() {}, abort() {}, finish: async () => ({ skipped: 'microphone sent no audio' }) }),
  });
  const warnings = [];
  svc.on('mic-warning', (w) => warnings.push(w));
  await svc.start();
  hotkey.handleKey(29, 1, 'k'); hotkey.handleKey(125, 1, 'k');
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].reason, 'muted');
  assert.equal(warnings[0].message, 'Microphone (Elgato Wave:3) is muted. Unmute it to dictate.');
  // The monitor's own check then hears exact silence: still one warning
  // (one notification), not a second "is muted" for the same hold.
  rec.onChunk(Buffer.alloc(6400));
  t.fire();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(warnings.length, 1);
  assert.equal(restarts, 0);
  await svc.stop();
});

// --- shared Test for Recorder-based paths (Linux, ffmpeg) ----------------------------------

test('testMicrophone (Recorder paths): live levels and a verdict; a missing pick is not connected', async () => {
  const rec = new EventEmitter();
  rec.start = ({ onChunk }) => { rec.proc = {}; rec.timer = setInterval(() => onChunk(tone(8000, 1600)), 5); };
  rec.stop = async () => { clearInterval(rec.timer); rec.proc = null; return Buffer.alloc(3200); };
  const platform = { createRecorder: () => rec, listMicrophones: async () => ({ devices: [ELGATO, REALTEK], defaultName: ELGATO.name }) };
  const levels = [];
  const r = await testMicrophone(platform, REALTEK, { seconds: 0.05, onLevel: (db) => levels.push(db) });
  assert.equal(r.text, 'Hearing you');
  assert.equal(r.name, REALTEK.name);
  assert.ok(levels.length > 0);
  const missing = await testMicrophone(platform, { id: 'x', name: 'Gone' }, { seconds: 0.01 });
  assert.equal(missing.kind, 'open-failed');
});

// WirePlumber 0.5's wpctl only takes numeric ids ("'alsa_input…' is not a
// valid number"), so a pinned mic's mute state and name come from pactl.
test('Linux pinned mic: pactl mute output and name lookup by node name or serial', () => {
  assert.equal(parseSourceMute('Mute: yes\n'), true);
  assert.equal(parseSourceMute('Mute: no\n'), false);
  assert.equal(parseSourceMute(null), null);
  assert.equal(parseSourceMute('Failed to get source information: No such entity'), null);
  const devices = [{ id: 'alsa_input.usb-Elgato_Wave_3', name: 'Elgato Wave:3 Mono', altIds: ['71'] }];
  assert.equal(sourceName(devices, { id: 'alsa_input.usb-Elgato_Wave_3', name: 'old' }), 'Elgato Wave:3 Mono');
  assert.equal(sourceName(devices, { id: 71, name: 'old' }), 'Elgato Wave:3 Mono');
  assert.equal(sourceName(devices, { id: 'gone', name: 'Webcam' }), 'Webcam');
});
