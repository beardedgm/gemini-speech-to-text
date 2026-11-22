// Linux: evdev hotkey, PipeWire mic, wl-clipboard/xclip + ydotool/xdotool paste.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HoldToTalk, SUPER_KEYS, findKeyboards } from '../hotkey.js';
import { KeyTap } from '../keytap.js';
import { APP_NAME, stateDir } from '../names.js';
import { DEFAULT_MIC, isDefaultMic, micFromEnv, resolveMic } from '../mics.js';
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

// PipeWire inputs (not monitors of outputs) from `pactl -f json list sources`:
// [{ id: node name, name: description }].
export function parsePactlSources(json) {
  let list;
  try { list = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && typeof s.name === 'string' && !isMonitor(s))
    .map((s) => ({ id: s.name, name: s.description || s.properties?.['node.description'] || s.name, altIds: s.properties?.['object.serial'] ? [String(s.properties['object.serial'])] : [] }));
}

function isMonitor(s) {
  if (s.name.endsWith('.monitor')) return true;
  if (s.properties?.['device.class'] === 'monitor') return true;
  return Boolean(s.monitor_of_sink && s.monitor_of_sink !== 'n/a');
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? null : String(out)));
  });
}

async function listSources() {
  const out = await run('pactl', ['-f', 'json', 'list', 'sources']);
  return out ? parsePactlSources(out) : [];
}

// Mics for the Settings picker, plus the current default's name.
export async function listMicrophones() {
  const [devices, def] = await Promise.all([listSources(), run('pactl', ['get-default-source'])]);
  const defName = def?.trim();
  return { devices, defaultName: devices.find((d) => d.id === defName)?.name ?? (await microphoneName()) };
}

// pw-record arguments for a choice: no --target follows the default input
// live, so "System default" needs nothing resolved.
export function pwRecordArgs(target = null) {
  return ['--rate=16000', '--channels=1', '--format=s16', ...(target ? [`--target=${target}`] : []), '--raw', '-'];
}

// A chosen mic that isn't there: PipeWire would quietly pick something, so
// check the list right after capture starts (no delay at key-down), and if
// the choice is missing, switch to the default and say so.
export function createRecorder() {
  const rec = new Recorder({
    argsFor: (mic) => {
      const choice = mic ?? micFromEnv();
      rec.micId = isDefaultMic(choice) ? null : choice.id;
      rec.micName = isDefaultMic(choice) ? null : choice.name;
      return pwRecordArgs(rec.micId);
    },
  });
  const start = rec.start.bind(rec);
  rec.start = (opts = {}) => {
    start(opts);
    const gen = rec.generation;
    const choice = rec.mic ?? micFromEnv();
    listSources().then(async (devices) => {
      if (!rec.proc || rec.generation !== gen) return;
      if (isDefaultMic(choice)) {
        rec.emit('mic', { name: await microphoneName(), fallback: null });
        return;
      }
      const { device, fallback } = devices.length ? resolveMic(devices, choice) : { device: { id: choice.id, name: choice.name }, fallback: null };
      if (fallback) {
        rec.restart({ mic: DEFAULT_MIC }); // not null: that would mean "GSTT_MIC" again
        rec.emit('mic', { name: await microphoneName(), fallback });
      } else {
        if (device.id !== rec.micId) rec.restart({ mic: { id: device.id, name: device.name } });
        rec.micName = device.name;
        rec.emit('mic', { name: device.name, fallback: null });
      }
    });
  };
  return rec;
}

export function pasteText(text, opts) {
  return pasteWith(text, opts);
}

export function pasteDescription() {
  return detectBackend();
}

// Name of a PipeWire input (default: the default input), for messages like
// "Elgato Wave 3 sent no sound".
export function microphoneName(mic = null) {
  const target = mic?.id || '@DEFAULT_AUDIO_SOURCE@';
  return new Promise((resolve) => {
    execFile('wpctl', ['inspect', target], { timeout: 2000 }, (err, out) => {
      if (err) return resolve(null);
      resolve(String(out).match(/node\.description = "([^"]+)"/)?.[1] ?? null);
    });
  });
}

// True if PipeWire reports the input muted (software mute, or a USB mic's own
// mute button, e.g. tapping the Elgato Wave 3's dial). null if unknown.
export function microphoneMuted(mic = null) {
  const target = mic?.id || '@DEFAULT_AUDIO_SOURCE@';
  return new Promise((resolve) => {
    execFile('wpctl', ['get-volume', target], { timeout: 2000 }, (err, out) => {
      resolve(err ? null : /\[MUTED\]/.test(String(out)));
    });
  });
}

// Force the input to suspend and resume (via pipewire-pulse). Recovers USB
// mics that came back from PipeWire's idle suspend delivering nothing/zeros.
export function recoverMic(mic = null) {
  const source = mic?.id || '@DEFAULT_SOURCE@';
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
