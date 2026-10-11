// Windows layer logic that can be checked on any OS (no hook, mic or PowerShell needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HoldToTalk, parseHotkey } from '../src/hotkey.js';
import { ffmpegMicArgs, mapUiohookKey, parseDshowAudioDevices } from '../src/platform/windows.js';
import { pasteText } from '../src/paste.js';

test('uiohook key codes map to the evdev codes used by hotkey specs', () => {
  assert.equal(mapUiohookKey(29), 29);     // left Ctrl
  assert.equal(mapUiohookKey(3613), 97);   // right Ctrl
  assert.equal(mapUiohookKey(3675), 125);  // left Win
  assert.equal(mapUiohookKey(3676), 126);  // right Win
  assert.equal(mapUiohookKey(107), null);  // F24: our own Start-menu suppression tap, ignored
  assert.ok(mapUiohookKey(47) >= 100000);  // V: "another key", never a hotkey
});

test('Ctrl+Win hold via mapped hook events: start, F24 tap ignored, stop', () => {
  const hk = new HoldToTalk({ keys: parseHotkey('CTRL+WIN'), minHoldMs: 0, findDevices: () => [] });
  const ev = [];
  for (const e of ['start', 'stop', 'cancel']) hk.on(e, () => ev.push(e));
  const feed = (code, v) => { const c = mapUiohookKey(code); if (c !== null) hk.handleKey(c, v, 'hook'); };
  feed(29, 1); feed(3675, 1);   // Ctrl, Win
  feed(107, 1); feed(107, 0);   // injected F24 must not cancel
  feed(3675, 0); feed(29, 0);
  assert.deepEqual(ev, ['start', 'stop']);
});

test('parseDshowAudioDevices handles new and old ffmpeg output', () => {
  const modern = [
    '[dshow @ 000001] "Integrated Camera" (video)',
    '[dshow @ 000001]   Alternative name "@device_pnp_\\\\?\\usb#vid"',
    '[dshow @ 000001] "Microphone (Realtek(R) Audio)" (audio)',
    '[dshow @ 000001]   Alternative name "@device_cm_{33D9A762}"',
    '[dshow @ 000001] "Headset (Jabra Evolve2)" (audio)',
    'dummy: Immediate exit requested',
  ].join('\r\n');
  assert.deepEqual(parseDshowAudioDevices(modern), ['Microphone (Realtek(R) Audio)', 'Headset (Jabra Evolve2)']);
  const legacy = [
    '[dshow @ 0x1] DirectShow video devices (some may be both video and audio devices)',
    '[dshow @ 0x1]  "Integrated Camera"',
    '[dshow @ 0x1] DirectShow audio devices',
    '[dshow @ 0x1]  "Microphone Array (Intel)"',
    '[dshow @ 0x1]     Alternative name "@device_cm_{...}"',
  ].join('\n');
  assert.deepEqual(parseDshowAudioDevices(legacy), ['Microphone Array (Intel)']);
  assert.deepEqual(parseDshowAudioDevices(''), []);
});

test('ffmpeg mic args produce 16 kHz mono s16 PCM on stdout', () => {
  const a = ffmpegMicArgs('Microphone (Realtek(R) Audio)');
  assert.deepEqual(a.slice(a.indexOf('-i'), a.indexOf('-i') + 2), ['-i', 'audio=Microphone (Realtek(R) Audio)']);
  assert.ok(a.join(' ').endsWith('-ac 1 -ar 16000 -f s16le -'));
});

test('paste flow with an injected backend: save, write, Ctrl+V, restore; non-text clipboard untouched', async () => {
  const calls = [];
  const backend = (previous) => ({
    read: async () => { calls.push('read'); return previous; },
    write: async (t) => { calls.push(`write:${t}`); },
    pasteKeys: async () => { calls.push('ctrl+v'); },
  });
  await pasteText('hi', { backend: backend('old'), restoreDelayMs: 0 });
  assert.deepEqual(calls, ['read', 'write:hi', 'ctrl+v', 'write:old']);
  calls.length = 0;
  await pasteText('hi', { backend: backend(null), restoreDelayMs: 0 }); // e.g. an image was on the clipboard
  assert.deepEqual(calls, ['read', 'write:hi', 'ctrl+v']);
});
