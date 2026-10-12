import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chunkLevelDb, levelFrame, MicMonitor } from '../src/micmonitor.js';
import { Recorder } from '../src/recorder.js';
import { DictationService } from '../src/engine.js';
import { HoldToTalk } from '../src/hotkey.js';
import { loadConfig } from '../src/config.js';

const tone = (amp, bytes = 3200) => { const b = Buffer.alloc(bytes); for (let i = 0; i < bytes; i += 2) b.writeInt16LE(i % 4 ? amp : -amp, i); return b; };
const ZEROS = Buffer.alloc(3200);

// Manual clock: timers fire only when the test says so.
function fakeTimers() {
  const pending = new Map(); let id = 0;
  return {
    setTimer: (fn) => { pending.set(++id, fn); return id; },
    clearTimer: (i) => pending.delete(i),
    fire() { const fns = [...pending.values()]; pending.clear(); fns.forEach((f) => f()); },
  };
}

test('chunk level: silence is -Infinity, a loud tone is near 0 dBFS', () => {
  assert.equal(chunkLevelDb(ZEROS), -Infinity);
  assert.ok(chunkLevelDb(tone(16000)) > -10);
  assert.ok(chunkLevelDb(tone(30)) < -55);
});

test('levelFrame maps dBFS onto meter frames', () => {
  assert.equal(levelFrame(-Infinity), 0);
  assert.equal(levelFrame(-80), 0);
  assert.equal(levelFrame(-5), 5);
  const mid = levelFrame(-37);
  assert.ok(mid > 0 && mid < 5);
  assert.equal(levelFrame(-59.9), 1); // any real signal lights at least one bar
});

for (const [name, chunks, reason] of [
  ['no audio data', [], 'no-data'],
  ['exact digital silence', [ZEROS, ZEROS], 'silent'],
  ['barely any signal', [tone(3), tone(3)], 'too-quiet'],
]) {
  test(`warns at the 1 s check for ${name}`, () => {
    const t = fakeTimers();
    const m = new MicMonitor({ setTimer: t.setTimer, clearTimer: t.clearTimer });
    const warnings = [];
    m.on('warning', (r) => warnings.push(r));
    m.start();
    chunks.forEach((c) => m.push(c));
    assert.deepEqual(warnings, []); // nothing before the check
    t.fire();
    assert.deepEqual(warnings, [reason]);
  });
}

test('normal room noise does not warn; signal after a warning clears it', () => {
  const t = fakeTimers();
  const m = new MicMonitor({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  const ev = [];
  m.on('warning', (r) => ev.push(`warn:${r}`));
  m.on('ok', () => ev.push('ok'));
  m.start();
  m.push(tone(60)); // about -55 dBFS, a quiet room
  t.fire();
  assert.deepEqual(ev, []);

  m.start();
  m.push(ZEROS);
  t.fire();
  m.push(ZEROS);
  m.push(tone(2000)); // unmuted mid-hold
  assert.deepEqual(ev, ['warn:silent', 'ok']);
});

test('recorder restart replaces a stalled capture and keeps earlier audio', async () => {
  let n = 0;
  // First process: one chunk then stalls. Second: keeps sending.
  const rec = new Recorder({ command: 'sh', args: [], stopProcess: (p) => p.kill('SIGTERM') });
  rec.spawnProc = ((orig) => function () {
    n++;
    this.args = ['-c', n === 1 ? 'printf AAAA; sleep 30' : 'while true; do printf BBBB; sleep 0.05; done'];
    return orig.call(this);
  })(rec.spawnProc);
  rec.start();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(rec.restart(), true);
  await new Promise((r) => setTimeout(r, 200));
  const pcm = await rec.stop();
  const s = pcm.toString();
  assert.ok(s.startsWith('AAAA') && s.includes('BBBB'), s.slice(0, 20));
});

// Service-level: fake OS layer with a scriptable recorder.
function platformWith(chunksDuring, pcmOnStop) {
  const pasted = [], beeps = [];
  let hotkey, restarts = 0;
  const rec = new EventEmitter();
  rec.start = ({ onChunk }) => { rec.proc = {}; rec.onChunk = onChunk; chunksDuring.forEach((c) => onChunk(c)); };
  rec.restart = () => { restarts++; return true; };
  rec.stop = async () => { rec.proc = null; return pcmOnStop; };
  rec.cancel = async () => { rec.proc = null; };
  return {
    pasted, beeps, rec, get restarts() { return restarts; }, get hotkey() { return hotkey; },
    createHotkey: (keys) => {
      hotkey = new HoldToTalk({ keys, minHoldMs: 0, findDevices: () => [{ path: 'k', name: 'kbd' }] });
      hotkey.openDevice = (kb) => hotkey.readers.set(kb.path, { name: kb.name, proc: { kill() {} } });
      return hotkey;
    },
    createRecorder: () => rec,
    pasteText: async (t) => pasted.push(t),
    pasteDescription: () => 'fake',
    microphoneName: async () => 'Elgato Wave 3 Pro',
    beep: (k) => beeps.push(k),
  };
}
const until = (e, ev) => new Promise((r) => e.once(ev, r));
const press = (hk) => { hk.handleKey(29, 1, 'k'); hk.handleKey(125, 1, 'k'); };
const release = (hk) => { hk.handleKey(29, 0, 'k'); hk.handleKey(125, 0, 'k'); };

test('stuck mic: reset (suspend/resume + capture restart) up to 3 times, then error sound + warning naming the mic, before release', async () => {
  const t = fakeTimers();
  const p = platformWith([ZEROS, ZEROS], ZEROS);
  let resets = 0;
  p.recoverMic = async () => { resets++; };
  const svc = new DictationService(loadConfig({ GEMINI_API_KEY: 'k', GSTT_MODE: 'oneshot' }), p, {
    monitorFactory: () => new MicMonitor({ setTimer: t.setTimer, clearTimer: t.clearTimer }),
    retryFile: null,
    dictationFactory: () => ({ push() {}, abort() {}, finish: async () => ({ skipped: 'microphone sent no audio' }) }),
  });
  await svc.start();
  press(p.hotkey);
  const warnings = [];
  svc.on('mic-warning', (w) => warnings.push(w));
  const settle = () => new Promise((r) => setImmediate(r));
  t.fire(); await settle(); // check 1 -> reset 1
  p.rec.onChunk(ZEROS);
  t.fire(); await settle(); // check 2 -> reset 2
  p.rec.onChunk(ZEROS);
  t.fire(); await settle(); // check 3 -> reset 3
  assert.deepEqual([resets, p.restarts, warnings.length], [3, 3, 0]); // quiet recovery attempts, no alarm yet
  p.rec.onChunk(ZEROS);
  const warning = until(svc, 'mic-warning');
  t.fire(); // check 4 -> give up, warn
  const w = await warning;
  assert.equal(w.reason, 'silent');
  assert.match(w.message, /Elgato Wave 3 Pro is sending no sound/);
  assert.deepEqual(p.beeps.filter((b) => b === 'error'), ['error']);
  assert.equal(svc.state, 'recording'); // still holding
  const errors = [];
  svc.on('error', (m) => errors.push(m));
  const idle = new Promise((r) => svc.on('state', (s) => s === 'idle' && r()));
  release(p.hotkey);
  await idle;
  assert.deepEqual(errors, []); // no second notification on release
  await svc.stop();
});

test('stuck mic that recovers after one reset: no warning, recovery is logged', async () => {
  const t = fakeTimers();
  const p = platformWith([ZEROS], tone(8000, 32000));
  p.recoverMic = async () => {};
  const svc = new DictationService(loadConfig({ GEMINI_API_KEY: 'k', GSTT_MODE: 'oneshot' }), p, {
    monitorFactory: () => new MicMonitor({ setTimer: t.setTimer, clearTimer: t.clearTimer }),
    retryFile: null,
    dictationFactory: () => ({ push() {}, abort() {}, finish: async () => ({ text: 'ok' }) }),
  });
  await svc.start();
  const logs = []; const warnings = [];
  svc.on('log', (m) => logs.push(m));
  svc.on('mic-warning', (w) => warnings.push(w));
  press(p.hotkey);
  t.fire(); await new Promise((r) => setImmediate(r));
  p.rec.onChunk(tone(4000)); // capture works after the reset
  t.fire();
  assert.deepEqual(warnings, []);
  assert.ok(logs.some((m) => /resetting it \(try 1\)/.test(m)));
  assert.ok(logs.some((m) => /recovered after 1 restart/.test(m)));
  const idle = new Promise((r) => svc.on('state', (s) => s === 'idle' && r()));
  release(p.hotkey);
  await idle;
  await svc.stop();
});

test('failed transcription keeps the audio; "Retry last dictation" re-sends it, pastes, and clears it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstt-retry-'));
  const retryFile = path.join(dir, 'last-dictation.wav');
  const loud = tone(8000, 32000);
  const p = platformWith([loud], loud);
  let sent = null;
  const svc = new DictationService(loadConfig({ GEMINI_API_KEY: 'k', GSTT_MODE: 'oneshot' }), p, {
    retryFile,
    dictationFactory: () => ({ push() {}, abort() {}, finish: async () => { throw new Error('503 overloaded'); } }),
    transcribeFn: async (wav) => { sent = wav; return 'Recovered text.'; },
  });
  await svc.start();
  const err = until(svc, 'error');
  press(p.hotkey); release(p.hotkey);
  assert.match(await err, /503 overloaded.*Retry last dictation/);
  assert.equal(svc.canRetry, true);
  assert.ok(fs.existsSync(retryFile));
  assert.equal(fs.statSync(retryFile).mode & 0o077, 0);

  // The saved audio survives an app restart.
  const svc2 = new DictationService(loadConfig({ GEMINI_API_KEY: 'k' }), platformWith([], loud), { retryFile, transcribeFn: async (wav) => { sent = wav; return 'Recovered text.'; } });
  await svc2.start();
  assert.equal(svc2.canRetry, true);
  await svc.stop();

  const p2 = svc2.platform;
  assert.equal(await svc2.retryLast(), true);
  assert.deepEqual(p2.pasted, ['Recovered text.']);
  assert.ok(sent.length > 32000); // WAV header + the kept audio
  assert.equal(svc2.canRetry, false);
  assert.equal(fs.existsSync(retryFile), false);
  await svc2.stop();
});

test('silence is never kept for retry', async () => {
  const p = platformWith([ZEROS], ZEROS);
  const svc = new DictationService(loadConfig({ GEMINI_API_KEY: 'k', GSTT_MODE: 'oneshot' }), p, { retryFile: null });
  await svc.start();
  const idle = new Promise((r) => svc.on('state', (s) => s === 'idle' && r()));
  press(p.hotkey); release(p.hotkey);
  await idle;
  assert.equal(svc.canRetry, false);
  await svc.stop();
});

test('a muted mic is reported as muted right away, without pointless resets', async () => {
  const t = fakeTimers();
  const p = platformWith([ZEROS], ZEROS);
  let resets = 0;
  p.recoverMic = async () => { resets++; };
  p.microphoneMuted = async () => true;
  const svc = new DictationService(loadConfig({ GEMINI_API_KEY: 'k', GSTT_MODE: 'oneshot' }), p, {
    monitorFactory: () => new MicMonitor({ setTimer: t.setTimer, clearTimer: t.clearTimer }),
    retryFile: null,
    dictationFactory: () => ({ push() {}, abort() {}, finish: async () => ({ skipped: 'microphone sent no audio' }) }),
  });
  await svc.start();
  press(p.hotkey);
  const warning = until(svc, 'mic-warning');
  t.fire();
  const w = await warning;
  assert.equal(w.reason, 'muted');
  assert.equal(w.message, 'Elgato Wave 3 Pro is muted. Unmute it to dictate.');
  assert.equal(resets, 0);
  const idle = new Promise((r) => svc.on('state', (s) => s === 'idle' && r()));
  release(p.hotkey);
  await idle;
  await svc.stop();
});
