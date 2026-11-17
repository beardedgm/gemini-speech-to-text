// "Record" button in Settings: chord capture, spec naming and hotkey checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HoldToTalk, KEY_CODES, parseHotkey } from '../src/hotkey.js';
import { ShortcutRecorder, hotkeyIssues, recordShortcut, specFromCodes } from '../src/hotkeyrecord.js';
import { DETECTABLE_KEYS, mapUiohookKey } from '../src/platform/windows.js';

const K = KEY_CODES;
const win = { platform: 'windows', detectable: DETECTABLE_KEYS };

test('recorder returns the whole chord once every key is released', () => {
  const r = new ShortcutRecorder();
  assert.equal(r.feed(K.KEY_LEFTCTRL, 1), null);
  assert.equal(r.feed(K.KEY_RIGHTMETA, 1), null);
  assert.equal(r.feed(K.KEY_RIGHTMETA, 2), null);        // autorepeat ignored
  assert.equal(r.feed(194, 1), null);                     // our own F24 tap ignored
  assert.equal(r.feed(194, 0), null);
  assert.equal(r.feed(K.KEY_LEFTCTRL, 0), null);          // Super still held
  assert.deepEqual(r.feed(K.KEY_RIGHTMETA, 0), [K.KEY_LEFTCTRL, K.KEY_RIGHTMETA]);
  assert.equal(r.feed(K.KEY_A, 0), null);                 // stray release before any press
});

test('chords become side-agnostic specs in a fixed modifier order', () => {
  assert.deepEqual(specFromCodes([K.KEY_RIGHTMETA, K.KEY_LEFTCTRL]), { spec: 'CTRL+SUPER' });
  assert.deepEqual(specFromCodes([K.KEY_F13]), { spec: 'F13' });
  assert.deepEqual(specFromCodes([K.KEY_SPACE, K.KEY_RIGHTSHIFT, K.KEY_LEFTALT]), { spec: 'SHIFT+ALT+SPACE' });
  assert.match(specFromCodes([K.KEY_LEFTCTRL, 300]).error, /can't be part of the hotkey/);
  // Every recorded spec parses back to the same keys.
  assert.deepEqual(parseHotkey('CTRL+SUPER'), parseHotkey(specFromCodes([K.KEY_LEFTCTRL, K.KEY_LEFTMETA]).spec));
});

test('every key the Windows hook can report can be named, and every named key it reports works', () => {
  for (const code of DETECTABLE_KEYS) assert.ok(specFromCodes([code]).spec, `code ${code}`);
  // F13-F23, Tab, Delete, letters and digits come through the hook now.
  for (const [uio, evdev] of [[91, K.KEY_F13], [106, K.KEY_F23], [15, K.KEY_TAB], [3667, K.KEY_DELETE], [30, K.KEY_A], [11, K.KEY_0]]) {
    assert.equal(mapUiohookKey(uio), evdev);
  }
});

test('hotkey checks: errors for unknown or undetectable keys, warnings for clashes', () => {
  assert.deepEqual(hotkeyIssues('CTRL+SUPER', win), { errors: [], warnings: [] });
  assert.deepEqual(hotkeyIssues('CTRL+SUPER'), { errors: [], warnings: [] });
  assert.deepEqual(hotkeyIssues('F13', win), { errors: [], warnings: [] });
  assert.match(hotkeyIssues('', win).errors[0], /Enter or record/);
  assert.match(hotkeyIssues('CTRL+FOO', win).errors[0], /Unknown key/);
  assert.match(hotkeyIssues('PAUSE', win).errors[0], /can't be detected on Windows/);
  assert.deepEqual(hotkeyIssues('PAUSE').errors, []); // fine on Linux

  const warns = (spec, opts) => hotkeyIssues(spec, opts).warnings.join(' ');
  assert.match(warns('WIN', win), /Win on its own/);
  assert.match(warns('SUPER'), /Super on its own/);
  assert.match(warns('ALT+TAB'), /switches windows/);
  assert.match(warns('CTRL+ALT+DELETE', win), /security screen/);
  assert.match(warns('CTRL+SHIFT+ESC', win), /Task Manager/);
  assert.match(warns('WIN+H', win), /voice typing/);
  assert.doesNotMatch(warns('SUPER+H'), /voice typing/); // Windows-only clash
  assert.match(warns('SPACE'), /types it/);
  assert.match(warns('CTRL+Q'), /also receives Q/);
  // No warnings that name other dictation apps.
  for (const spec of ['CTRL+SUPER', 'CTRL+WIN', 'WIN', 'ALT+SPACE']) {
    for (const opts of [win, {}]) assert.doesNotMatch(warns(spec, opts), /flow/i);
  }
});

test('recordShortcut drives a real HoldToTalk listener and stops it', async () => {
  const hk = new HoldToTalk({ keys: parseHotkey('SUPER'), findDevices: () => [] });
  let stopped = 0;
  hk.start = () => [];
  hk.stop = () => { stopped++; };
  const { promise } = recordShortcut(hk);
  hk.handleKey(K.KEY_LEFTCTRL, 1);
  hk.handleKey(K.KEY_LEFTMETA, 1);
  hk.handleKey(K.KEY_LEFTMETA, 0);
  hk.handleKey(K.KEY_LEFTCTRL, 0);
  assert.deepEqual(await promise, { spec: 'CTRL+SUPER' });
  assert.equal(stopped, 1);
});

test('recordShortcut: Esc cancels, cancel() cancels, start errors and timeouts are reported', async () => {
  const fake = () => Object.assign(new EventEmitter(), { start() {}, stop() {} });
  let l = fake();
  let r = recordShortcut(l);
  l.emit('key', K.KEY_ESC, 1); l.emit('key', K.KEY_ESC, 0);
  assert.deepEqual(await r.promise, { cancelled: true });

  l = fake();
  r = recordShortcut(l);
  r.cancel();
  assert.deepEqual(await r.promise, { cancelled: true });

  l = Object.assign(fake(), { start() { throw new Error('No keyboards found'); } });
  assert.deepEqual(await recordShortcut(l).promise, { error: 'No keyboards found' });

  assert.deepEqual(await recordShortcut(fake(), { timeoutMs: 10 }).promise, { cancelled: true, timedOut: true });
});

test('reading /proc/bus/input/devices retries EINTR (listener restart right after stop)', async () => {
  const { readProcDevices } = await import('../src/hotkey.js');
  let calls = 0;
  const eintr = () => Object.assign(new Error('EINTR: interrupted system call, read'), { code: 'EINTR' });
  assert.equal(readProcDevices(() => { if (++calls < 3) throw eintr(); return 'ok'; }), 'ok');
  assert.equal(calls, 3);
  assert.throws(() => readProcDevices(() => { throw eintr(); }), /EINTR/);
  assert.throws(() => readProcDevices(() => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); }), /nope/);
});
