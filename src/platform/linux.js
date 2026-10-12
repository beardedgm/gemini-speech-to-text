// Linux: evdev hotkey, PipeWire mic, wl-clipboard/xclip + ydotool/xdotool paste.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HoldToTalk, SUPER_KEYS, findKeyboards } from '../hotkey.js';
import { KeyTap } from '../keytap.js';
import { APP_NAME, envSetting, stateDir } from '../names.js';
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

// GSTT_MIC picks a PipeWire input by node name or serial (see `wpctl status`);
// default is the system's default input.
export function createRecorder() {
  const target = envSetting(process.env, 'MIC');
  if (!target) return new Recorder();
  return new Recorder({ args: ['--rate=16000', '--channels=1', '--format=s16', `--target=${target}`, '--raw', '-'] });
}

export function pasteText(text, opts) {
  return pasteWith(text, opts);
}

export function pasteDescription() {
  return detectBackend();
}

// Name of the default PipeWire input, for messages like "Elgato Wave 3 sent no sound".
export function microphoneName() {
  const target = envSetting(process.env, 'MIC') || '@DEFAULT_AUDIO_SOURCE@';
  return new Promise((resolve) => {
    execFile('wpctl', ['inspect', target], { timeout: 2000 }, (err, out) => {
      if (err) return resolve(null);
      resolve(String(out).match(/node\.description = "([^"]+)"/)?.[1] ?? null);
    });
  });
}

// True if PipeWire reports the input muted (software mute, or a USB mic's own
// mute button, e.g. tapping the Elgato Wave 3's dial). null if unknown.
export function microphoneMuted() {
  const target = envSetting(process.env, 'MIC') || '@DEFAULT_AUDIO_SOURCE@';
  return new Promise((resolve) => {
    execFile('wpctl', ['get-volume', target], { timeout: 2000 }, (err, out) => {
      resolve(err ? null : /\[MUTED\]/.test(String(out)));
    });
  });
}

// Force the input to suspend and resume (via pipewire-pulse). Recovers USB
// mics that came back from PipeWire's idle suspend delivering nothing/zeros.
export function recoverMic() {
  const source = envSetting(process.env, 'MIC') || '@DEFAULT_SOURCE@';
  const pactl = (state) => new Promise((resolve) => {
    execFile('pactl', ['suspend-source', source, state], { timeout: 2000 }, () => resolve());
  });
  return pactl('1').then(() => pactl('0'));
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
