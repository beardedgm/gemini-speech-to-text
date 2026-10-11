import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HoldToTalk, findKeyboards, parseHotkey, KEY_CODES } from '../src/hotkey.js';
import { buildInstruction, cleanOutput } from '../src/gemini.js';
import { detectBackend } from '../src/paste.js';

const { KEY_RIGHTCTRL: RC, KEY_LEFTCTRL: LC, KEY_LEFTMETA: META } = KEY_CODES;
const C = 46; // KEY_C

function track(hk) {
  const events = [];
  for (const e of ['start', 'stop', 'cancel']) hk.on(e, (arg) => events.push(e === 'cancel' ? `cancel:${arg}` : e));
  return events;
}

test('parseHotkey accepts names with or without KEY_ prefix, numbers, and side-agnostic groups', () => {
  assert.deepEqual(parseHotkey('KEY_RIGHTCTRL'), [[RC]]);
  assert.deepEqual(parseHotkey('leftctrl+leftmeta'), [[LC], [META]]);
  assert.deepEqual(parseHotkey('97'), [[RC]]);
  assert.deepEqual(parseHotkey('CTRL+SUPER'), [[LC, RC], [META, 126]]);
  assert.deepEqual(parseHotkey('ctrl+win'), parseHotkey('CTRL+SUPER'));
  assert.throws(() => parseHotkey('KEY_NOPE'));
});

test('hold long enough -> start then stop', () => {
  const hk = new HoldToTalk({ keys: [[RC]], minHoldMs: 0 });
  const ev = track(hk);
  hk.handleKey(RC, 1); hk.handleKey(RC, 2); hk.handleKey(RC, 0);
  assert.deepEqual(ev, ['start', 'stop']);
});

test('quick tap -> cancel too-short', () => {
  const hk = new HoldToTalk({ keys: [[RC]], minHoldMs: 10_000 });
  const ev = track(hk);
  hk.handleKey(RC, 1); hk.handleKey(RC, 0);
  assert.deepEqual(ev, ['start', 'cancel:too-short']);
});

test('using the key as a modifier (RightCtrl+C) cancels dictation', () => {
  const hk = new HoldToTalk({ keys: [[RC]], minHoldMs: 0 });
  const ev = track(hk);
  hk.handleKey(RC, 1); hk.handleKey(C, 1); hk.handleKey(C, 0); hk.handleKey(RC, 0);
  assert.deepEqual(ev, ['start', 'cancel:other-key']);
});

test('combo needs every group; stops when either is released', () => {
  const hk = new HoldToTalk({ keys: [[LC], [META]], minHoldMs: 0 });
  const ev = track(hk);
  hk.handleKey(LC, 1);
  assert.deepEqual(ev, []);
  hk.handleKey(META, 1);
  assert.deepEqual(ev, ['start']);
  hk.handleKey(LC, 0);
  assert.deepEqual(ev, ['start', 'stop']);
  hk.handleKey(META, 0);
  assert.deepEqual(ev, ['start', 'stop']);
});

test('CTRL+SUPER works with either side and in either order', () => {
  for (const [a, b] of [[RC, 126], [126, RC], [LC, META], [META, LC], [RC, META]]) {
    const hk = new HoldToTalk({ keys: parseHotkey('CTRL+SUPER'), minHoldMs: 0 });
    const ev = track(hk);
    hk.handleKey(a, 1); hk.handleKey(b, 1); hk.handleKey(b, 0); hk.handleKey(a, 0);
    assert.deepEqual(ev, ['start', 'stop'], `${a}+${b}`);
  }
});

test('a stuck non-hotkey key (missed release) does not disable the hotkey', () => {
  const hk = new HoldToTalk({ keys: parseHotkey('CTRL+SUPER'), minHoldMs: 0 });
  const ev = track(hk);
  hk.handleKey(C, 1, '/dev/input/event9'); // release never arrives (e.g. focus switch, grab)
  hk.handleKey(LC, 1, '/dev/input/event9'); hk.handleKey(META, 1, '/dev/input/event9');
  hk.handleKey(META, 0, '/dev/input/event9');
  assert.deepEqual(ev, ['start', 'stop']);
});

test('the same key reported by two devices is handled once', () => {
  const hk = new HoldToTalk({ keys: [[RC]], minHoldMs: 0 });
  const ev = track(hk);
  hk.handleKey(RC, 1, 'kbd-bt'); hk.handleKey(RC, 1, 'kbd-usb');
  hk.handleKey(RC, 0, 'kbd-bt');
  assert.deepEqual(ev, ['start']); // still held on the other device
  hk.handleKey(RC, 0, 'kbd-usb');
  assert.deepEqual(ev, ['start', 'stop']);
});

test('a keyboard that disappears mid-hold cancels instead of hanging', () => {
  const hk = new HoldToTalk({ keys: [[RC]], minHoldMs: 0 });
  const ev = track(hk);
  hk.handleKey(RC, 1, 'kbd');
  hk.dropDevice('kbd');
  assert.deepEqual(ev, ['start', 'cancel:device-gone']);
});

test('rescan picks up keyboards that appear later', () => {
  let list = [];
  const hk = new HoldToTalk({ keys: [[RC]], findDevices: () => list });
  const opened = [];
  hk.openDevice = (kb) => { opened.push(kb.path); hk.readers.set(kb.path, { name: kb.name, proc: { kill() {} } }); };
  list = [{ path: '/dev/input/event9', name: 'kbd' }];
  hk.rescan();
  list = [...list, { path: '/dev/input/event30', name: 'reconnected kbd' }];
  hk.rescan();
  hk.rescan();
  assert.deepEqual(opened, ['/dev/input/event9', '/dev/input/event30']);
});

test('findKeyboards keeps real keyboards and skips ydotoold and keyless devices', () => {
  const procText = [
    'N: Name="Power Button"\nH: Handlers=kbd event1\nB: KEY=10000000000000 0',
    'N: Name="ydotoold virtual device"\nH: Handlers=kbd event26\nB: KEY=ffffffffffffffff ffffffffffffffff',
    'N: Name="flowcode virtual keys"\nH: Handlers=kbd event13\nB: KEY=ffffffffffffffff ffffffffffffffff',
    'N: Name="gstt virtual keys"\nH: Handlers=kbd event14\nB: KEY=ffffffffffffffff ffffffffffffffff',
    'N: Name="Some Keyboard"\nH: Handlers=sysrq kbd event9 leds\nB: KEY=1000000000007 ff9f207ac14057ff febeffdfffefffff fffffffffffffffe',
  ].join('\n\n');
  assert.deepEqual(findKeyboards(procText), [{ name: 'Some Keyboard', path: '/dev/input/event9' }]);
});

test('instruction includes dictionary terms; sentinel means no speech', () => {
  assert.match(buildInstruction(['COSMIC', 'Pop!_OS']), /- COSMIC\n- Pop!_OS/);
  assert.equal(cleanOutput('  <<NO_SPEECH>> '), '');
  assert.equal(cleanOutput(' Hello. '), 'Hello.');
  assert.equal(cleanOutput(undefined), '');
});

test('backend detection', () => {
  assert.equal(detectBackend({ WAYLAND_DISPLAY: 'wayland-1' }), 'wayland');
  assert.equal(detectBackend({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }), 'x11');
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wavLevels, wavSeconds } from '../src/recorder.js';

function writeWav(samples, extraChunk = false) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(v, i * 2));
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(16000, 12); fmt.writeUInt32LE(32000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const list = Buffer.from('LIST\x0a\x00\x00\x00INFOxxxxxx', 'latin1');
  const dataHdr = Buffer.alloc(8); dataHdr.write('data', 0); dataHdr.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, ...(extraChunk ? [list] : []), dataHdr, data]);
  const riff = Buffer.alloc(8); riff.write('RIFF', 0); riff.writeUInt32LE(body.length, 4);
  const file = path.join(os.tmpdir(), `flowcode-test-${process.pid}-${Math.random()}.wav`);
  fs.writeFileSync(file, Buffer.concat([riff, body]));
  return file;
}

test('silence reads as -Infinity even with extra header chunks', () => {
  const f = writeWav(new Array(16000).fill(0), true);
  assert.equal(wavLevels(f).peakWindowDb, -Infinity);
  assert.equal(wavSeconds(f), 1);
  fs.rmSync(f);
});

test('a loud burst is detected as speech-level', () => {
  const s = new Array(16000).fill(0);
  for (let i = 4000; i < 6000; i++) s[i] = i % 2 ? 8000 : -8000; // about -12 dBFS
  const f = writeWav(s);
  const { peakWindowDb } = wavLevels(f);
  assert.ok(peakWindowDb > -15 && peakWindowDb < -10, String(peakWindowDb));
  fs.rmSync(f);
});

import { pipeTo } from '../src/paste.js';

test('pipeTo resolves when the tool exits even if a forked child keeps stderr open (wl-copy behaviour)', async () => {
  const t0 = Date.now();
  // Reads stdin, leaves a background child holding stderr for 5 s, exits 0.
  await pipeTo('sh', ['-c', 'cat >/dev/null; (sleep 5 >&2 &); exit 0'], 'text');
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test('pipeTo reports failures', async () => {
  await assert.rejects(pipeTo('sh', ['-c', 'cat >/dev/null; echo boom >&2; exit 3'], 'x'), /boom/);
});
