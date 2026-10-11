// Linux: evdev hotkey, PipeWire mic, wl-clipboard/xclip + ydotool/xdotool paste.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HoldToTalk, SUPER_KEYS, findKeyboards } from '../hotkey.js';
import { KeyTap } from '../keytap.js';
import { Recorder } from '../recorder.js';
import { detectBackend, pasteText as pasteWith } from '../paste.js';

export const name = 'linux';

export function logDir() {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'flowcode');
}

// keys: parsed hotkey groups. onWarn: message callback for non-fatal problems.
export function createHotkey(keys, { onWarn } = {}) {
  const hk = new HoldToTalk({ keys });
  // With Super in the hotkey, tap F24 (bound to nothing) during the hold so
  // COSMIC doesn't open the Launcher when Super is released.
  if (keys.some((g) => g.some((c) => SUPER_KEYS.includes(c)))) {
    const keytap = new KeyTap({ onError: (m) => onWarn?.(`Launcher suppression unavailable (${m}); the Launcher may open after a hold.`) });
    const start = hk.start.bind(hk);
    const stop = hk.stop.bind(hk);
    hk.start = () => { keytap.start(); return start(); };
    hk.stop = () => { keytap.stop(); stop(); };
    hk.on('start', () => { if (!keytap.tap()) hk.emit('debug', 'keytap not ready'); });
  }
  return hk;
}

export function createRecorder() {
  return new Recorder();
}

export function pasteText(text, opts) {
  return pasteWith(text, opts);
}

export function pasteDescription() {
  return detectBackend();
}

export function listKeyboards() {
  return findKeyboards();
}

const SOUND_DIR = '/usr/share/sounds/freedesktop/stereo';
const SOUNDS = { start: 'message-new-instant.oga', done: 'complete.oga', error: 'dialog-warning.oga' };

export function beep(kind) {
  const file = path.join(SOUND_DIR, SOUNDS[kind] ?? '');
  if (SOUNDS[kind] && fs.existsSync(file)) spawn('paplay', [file], { stdio: 'ignore' }).on('error', () => {});
}

export function notify(summary, body = '') {
  spawn('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications',
    '--object-path', '/org/freedesktop/Notifications', '--method', 'org.freedesktop.Notifications.Notify',
    'flowcode', '0', 'audio-input-microphone', summary, body, '[]', '{}', '5000'], { stdio: 'ignore' }).on('error', () => {});
}
