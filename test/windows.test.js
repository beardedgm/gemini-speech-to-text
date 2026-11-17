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
  assert.equal(mapUiohookKey(47), 47);     // V: letters keep their scan code (= evdev code)
  assert.equal(mapUiohookKey(91), 183);    // F13
  assert.equal(mapUiohookKey(3667), 111);  // Delete
  assert.ok(mapUiohookKey(3639) >= 100000); // Print Screen: "another key", never a hotkey
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

import { soundScript, WINDOWS_SOUNDS } from '../src/platform/windows.js';

test('Windows sounds use built-in media files with a system-sound fallback', () => {
  const s = soundScript('start', 'C:\\Windows\\Media');
  assert.match(s, /C:\\Windows\\Media\\Speech On\.wav/);
  assert.match(s, /SystemSounds/);
  assert.match(soundScript('done', 'C:\\Windows\\Media'), /Speech Off\.wav/);
  assert.equal(soundScript('nope'), null);
  assert.deepEqual(Object.keys(WINDOWS_SOUNDS), ['start', 'done', 'error']);
});

import { parseDshowAudioDeviceList, resolveMicrophone } from '../src/platform/windows.js';

// Real `ffmpeg -list_devices` output from a Windows laptop with an Elgato Wave:3.
const ELGATO_LIST = [
  '[dshow @ 000001b80ffd9e80] DirectShow video devices (some may be both video and audio devices)',
  '[dshow @ 000001b80ffd9e80]  "HD WebCam"',
  '[dshow @ 000001b80ffd9e80]     Alternative name "@device_pnp_\\\\?\\usb#vid_1bcf&pid_2c6b&mi_00#6&2218e88f&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"',
  '[dshow @ 000001b80ffd9e80] DirectShow audio devices',
  '[dshow @ 000001b80ffd9e80]  "Microphone (Elgato Wave:3)"',
  '[dshow @ 000001b80ffd9e80]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{AEF32A67-693D-495D-8DE5-65D00DED3D8B}"',
  '[dshow @ 000001b80ffd9e80]  "Microphone (Realtek(R) Audio)"',
  '[dshow @ 000001b80ffd9e80]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{82A54AD2-2DD0-4AA9-B602-DBE8C9E729A8}"',
  'dummy: Immediate exit requested',
].join('\r\n');
const ELGATO_ALT = '@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{AEF32A67-693D-495D-8DE5-65D00DED3D8B}';

test('dshow device list keeps each audio device\'s alternative name (old and new ffmpeg)', () => {
  const list = parseDshowAudioDeviceList(ELGATO_LIST);
  assert.deepEqual(list.map((d) => d.name), ['Microphone (Elgato Wave:3)', 'Microphone (Realtek(R) Audio)']);
  assert.equal(list[0].altName, ELGATO_ALT);
  const modern = parseDshowAudioDeviceList([
    '[dshow @ 01] "Integrated Camera" (video)',
    '[dshow @ 01]   Alternative name "@device_pnp_cam"',
    '[dshow @ 01] "Microphone (Elgato Wave:3)" (audio)',
    '[dshow @ 01]   Alternative name "@device_cm_{X}\\wave_{Y}"',
    '[dshow @ 01] "Headset (Jabra)" (audio)',
  ].join('\n'));
  assert.deepEqual(modern, [
    { name: 'Microphone (Elgato Wave:3)', altName: '@device_cm_{X}\\wave_{Y}' },
    { name: 'Headset (Jabra)', altName: null },
  ]);
});

test('a mic name with a colon is opened by its alternative name; the friendly name stays for display', () => {
  const list = parseDshowAudioDeviceList(ELGATO_LIST);
  const mic = resolveMicrophone(list);
  assert.equal(mic.name, 'Microphone (Elgato Wave:3)');
  assert.equal(mic.input, ELGATO_ALT);
  const i = ffmpegMicArgs(mic.input);
  const input = i[i.indexOf('-i') + 1];
  assert.equal(input, `audio=${ELGATO_ALT}`);
  assert.ok(!input.slice('audio='.length).includes(':'), 'ffmpeg would split the device on ":"');
  // GSTT_MIC matches the friendly or the alternative name.
  assert.deepEqual(resolveMicrophone(list, 'Microphone (Realtek(R) Audio)'),
    { name: 'Microphone (Realtek(R) Audio)', input: list[1].altName });
  assert.equal(resolveMicrophone(list, ELGATO_ALT).name, 'Microphone (Elgato Wave:3)');
  // Unknown GSTT_MIC (or no alt name): passed through as-is.
  assert.deepEqual(resolveMicrophone(list, 'USB Mic'), { name: 'USB Mic', input: 'USB Mic' });
  assert.equal(resolveMicrophone([]), null);
});
