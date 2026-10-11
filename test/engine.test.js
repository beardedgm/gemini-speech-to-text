import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { configProblem, loadConfig } from '../src/config.js';
import { Dictation, DictationService, skipReason } from '../src/engine.js';
import { HoldToTalk, parseHotkey } from '../src/hotkey.js';
import { loadPlatform } from '../src/platform/index.js';

const LOUD = Buffer.alloc(32000); // 1 s
for (let i = 0; i < LOUD.length; i += 2) LOUD.writeInt16LE(i % 4 ? 8000 : -8000, i);
const SILENT = Buffer.alloc(32000);

test('loadConfig defaults and VOICE_DEV_GEMINI_KEY fallback', () => {
  const c = loadConfig({ VOICE_DEV_GEMINI_KEY: 'k' }, '/x');
  assert.equal(c.apiKey, 'k');
  assert.equal(c.hotkey, 'CTRL+SUPER');
  assert.equal(c.mode, 'live');
  assert.equal(loadConfig({ FLOWCODE_MODE: 'oneshot' }).mode, 'oneshot');
  assert.equal(c.dictionary, '/x/dictionary.txt');
  assert.equal(loadConfig({ GEMINI_API_KEY: 'a', VOICE_DEV_GEMINI_KEY: 'b' }).apiKey, 'a');
  assert.match(configProblem(loadConfig({})), /API key/);
  assert.match(configProblem(loadConfig({ GEMINI_API_KEY: 'a', FLOWCODE_MODE: 'turbo' })), /Mode/);
  assert.equal(configProblem(loadConfig({ GEMINI_API_KEY: 'a', FLOWCODE_MODE: 'LIVE' })), null);
});

test('skipReason: too short, silent, ok', () => {
  const cfg = { minSeconds: 0.3, silenceDb: -40 };
  assert.equal(skipReason(Buffer.alloc(3200), cfg), 'too short');
  assert.equal(skipReason(SILENT, cfg), 'microphone sent no audio');
  assert.equal(skipReason(LOUD, cfg), null);
});

test('Dictation in live mode uses the live transcript, and skips silence without finishing the session', async () => {
  const calls = [];
  const fakeLive = { begin: () => calls.push('begin'), push: () => calls.push('push'), finish: async () => 'raw words', abort: () => calls.push('abort') };
  const cfg = loadConfig({ GEMINI_API_KEY: 'k', FLOWCODE_MODE: 'live' });
  const silent = new Dictation(cfg, { liveFactory: () => fakeLive });
  assert.deepEqual(await silent.finish(SILENT), { skipped: 'microphone sent no audio' });
  assert.deepEqual(calls, ['begin', 'abort']);
});

// A fake OS layer: hotkey driven by the test, recorder returning fixed PCM, paste recorded.
function fakePlatform(pcm = LOUD) {
  const pasted = [];
  let hotkey;
  return {
    pasted,
    get hotkey() { return hotkey; },
    createHotkey: (keys) => {
      hotkey = new HoldToTalk({ keys, minHoldMs: 0, findDevices: () => [{ path: 'k', name: 'kbd' }] });
      hotkey.openDevice = (kb) => hotkey.readers.set(kb.path, { name: kb.name, proc: { kill() {} } });
      return hotkey;
    },
    createRecorder: () => {
      const r = new EventEmitter();
      r.start = () => { r.proc = {}; };
      r.stop = async () => { r.proc = null; return pcm; };
      r.cancel = async () => { r.proc = null; };
      return r;
    },
    pasteText: async (text) => { pasted.push(text); },
    pasteDescription: () => 'fake',
    beep() {},
  };
}

const fakeDictation = (text) => () => ({ push() {}, abort() {}, finish: async () => ({ text }) });
const until = (emitter, event) => new Promise((r) => emitter.once(event, r));

test('DictationService: Ctrl+Super hold -> recording -> working -> paste after both keys are up', async () => {
  const p = fakePlatform();
  const svc = new DictationService(loadConfig({ GEMINI_API_KEY: 'k' }), p, { dictationFactory: fakeDictation('Hello there.') });
  const states = [];
  svc.on('state', (s) => states.push(s));
  await svc.start();
  const [LC, META] = [29, 125];
  p.hotkey.handleKey(LC, 1, 'k');
  p.hotkey.handleKey(META, 1, 'k');
  assert.equal(svc.state, 'recording');
  const pasted = until(svc, 'pasted');
  p.hotkey.handleKey(LC, 0, 'k'); // stop; Super still held
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(p.pasted, []); // waits for Super to be released
  p.hotkey.handleKey(META, 0, 'k');
  assert.equal(await pasted, 'Hello there.');
  assert.deepEqual(p.pasted, ['Hello there.']);
  assert.deepEqual(states, ['recording', 'working', 'idle']);
  await svc.stop();
});

test('DictationService: dry run never pastes; errors are reported and return to idle', async () => {
  const p = fakePlatform();
  const svc = new DictationService(loadConfig({ GEMINI_API_KEY: 'k', FLOWCODE_DRY_RUN: '1' }), p, { dictationFactory: fakeDictation('x') });
  await svc.start();
  const logs = [];
  svc.on('log', (m) => logs.push(m));
  const backToIdle = new Promise((r) => svc.on('state', (s) => s === 'idle' && r()));
  p.hotkey.handleKey(97, 1, 'k'); p.hotkey.handleKey(126, 1, 'k');
  p.hotkey.handleKey(97, 0, 'k'); p.hotkey.handleKey(126, 0, 'k');
  await backToIdle;
  assert.deepEqual(p.pasted, []);
  assert.ok(logs.some((m) => m.startsWith('[dry run]')));
  await svc.stop();

  const p2 = fakePlatform();
  const boom = () => ({ push() {}, abort() {}, finish: async () => { throw new Error('quota'); } });
  const svc2 = new DictationService(loadConfig({ GEMINI_API_KEY: 'k' }), p2, { dictationFactory: boom });
  await svc2.start();
  const err = until(svc2, 'error');
  const idle2 = new Promise((r) => svc2.on('state', (s) => s === 'idle' && r()));
  p2.hotkey.handleKey(29, 1, 'k'); p2.hotkey.handleKey(125, 1, 'k'); p2.hotkey.handleKey(29, 0, 'k'); p2.hotkey.handleKey(125, 0, 'k');
  assert.match(await err, /quota/);
  await idle2;
  assert.deepEqual(p2.pasted, []);
  await svc2.stop();
});

test('loadPlatform picks the OS layer', async () => {
  assert.equal((await loadPlatform('linux')).name, 'linux');
  assert.equal((await loadPlatform('win32')).name, 'windows');
  await assert.rejects(loadPlatform('darwin'), /Linux and Windows only/);
});

test('hotkey parsing is identical for Windows (CTRL+WIN == CTRL+SUPER)', () => {
  assert.deepEqual(parseHotkey('CTRL+WIN'), parseHotkey('CTRL+SUPER'));
});

test('sound toggles: both on by default, GSTT_SOUND_* / legacy env turn each off', () => {
  const d = loadConfig({});
  assert.equal(d.soundStart, true);
  assert.equal(d.soundDone, true);
  const off = loadConfig({ GSTT_SOUND_START: '0', FLOWCODE_SOUND_DONE: '0' });
  assert.equal(off.soundStart, false);
  assert.equal(off.soundDone, false);
});

async function beepsFor(env) {
  const p = fakePlatform();
  const beeps = [];
  p.beep = (k) => beeps.push(k);
  const svc = new DictationService(loadConfig({ GEMINI_API_KEY: 'k', ...env }), p, { dictationFactory: fakeDictation('hi') });
  await svc.start();
  const pasted = until(svc, 'pasted');
  p.hotkey.handleKey(29, 1, 'k'); p.hotkey.handleKey(125, 1, 'k'); p.hotkey.handleKey(29, 0, 'k'); p.hotkey.handleKey(125, 0, 'k');
  await pasted;
  await svc.stop();
  return beeps;
}

test('start and done sounds play independently according to the toggles', async () => {
  assert.deepEqual(await beepsFor({}), ['start', 'done']);
  assert.deepEqual(await beepsFor({ GSTT_SOUND_START: '0' }), ['done']);
  assert.deepEqual(await beepsFor({ GSTT_SOUND_DONE: '0' }), ['start']);
  assert.deepEqual(await beepsFor({ GSTT_SOUND_START: '0', GSTT_SOUND_DONE: '0' }), []);
});

import { MIC_SILENT } from '../src/engine.js';

test('exact digital silence is reported as a muted/stalled mic, not just "no speech"', () => {
  const cfg = { minSeconds: 0.3, silenceDb: -40 };
  assert.equal(skipReason(SILENT, cfg), MIC_SILENT);
  const quiet = Buffer.alloc(32000);
  for (let i = 0; i < quiet.length; i += 2) quiet.writeInt16LE(i % 4 ? 30 : -30, i); // room noise, about -60 dBFS
  assert.match(skipReason(quiet, cfg), /^no speech/);
});

test('a silent-mic recording notifies the user with the microphone name and pastes nothing', async () => {
  const p = fakePlatform(SILENT);
  p.microphoneName = async () => 'Elgato Wave 3 Pro';
  // Real Dictation (one-shot): the silence check runs before any Gemini call.
  const svc = new DictationService(loadConfig({ GEMINI_API_KEY: 'k', GSTT_MODE: 'oneshot' }), p);
  await svc.start();
  const err = until(svc, 'error');
  p.hotkey.handleKey(29, 1, 'k'); p.hotkey.handleKey(125, 1, 'k'); p.hotkey.handleKey(29, 0, 'k'); p.hotkey.handleKey(125, 0, 'k');
  assert.match(await err, /Elgato Wave 3 Pro.*no sound at all.*muted/);
  assert.deepEqual(p.pasted, []);
  await svc.stop();
});
