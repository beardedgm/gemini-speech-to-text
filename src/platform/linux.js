// Linux: evdev hotkey, PipeWire mic, wl-clipboard/xclip + ydotool/xdotool paste.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HoldToTalk, SUPER_KEYS, findKeyboards } from '../hotkey.js';
import { KeyTap } from '../keytap.js';
import { APP_NAME, stateDir } from '../names.js';
import { Recorder } from '../recorder.js';
import { detectBackend, pasteText as pasteWith } from '../paste.js';

export const name = 'linux';

export function logDir() {
  return stateDir();
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

// Name of the default PipeWire input, for messages like "Elgato Wave 3 sent no sound".
export function microphoneName() {
  return new Promise((resolve) => {
    execFile('wpctl', ['inspect', '@DEFAULT_AUDIO_SOURCE@'], { timeout: 2000 }, (err, out) => {
      if (err) return resolve(null);
      resolve(String(out).match(/node\.description = "([^"]+)"/)?.[1] ?? null);
    });
  });
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
    APP_NAME, '0', 'audio-input-microphone', summary, body, '[]', '{}', '5000'], { stdio: 'ignore' }).on('error', () => {});
}
