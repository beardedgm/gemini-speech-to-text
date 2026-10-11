// Windows: low-level keyboard hook (uiohook-napi), ffmpeg/DirectShow mic,
// PowerShell clipboard + SendInput Ctrl+V.
//
// Written and unit-tested on Linux; see README "Try on Windows" for what
// still needs checking on a real Windows machine.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { HoldToTalk, KEY_CODES } from '../hotkey.js';
import { envSetting, stateDir } from '../names.js';
import { Recorder } from '../recorder.js';
import { pasteText as pasteWith } from '../paste.js';

export const name = 'windows';
const require = createRequire(import.meta.url);
const execFileP = promisify(execFile);

export function logDir() {
  return stateDir();
}

// --- hotkey -----------------------------------------------------------------

// uiohook key codes (libuiohook VC_*) -> the evdev codes HoldToTalk uses, so
// hotkey specs like CTRL+SUPER mean the same on both systems.
export const UIOHOOK_TO_EVDEV = {
  29: KEY_CODES.KEY_LEFTCTRL, 3613: KEY_CODES.KEY_RIGHTCTRL,
  42: KEY_CODES.KEY_LEFTSHIFT, 54: KEY_CODES.KEY_RIGHTSHIFT,
  56: KEY_CODES.KEY_LEFTALT, 3640: KEY_CODES.KEY_RIGHTALT,
  3675: KEY_CODES.KEY_LEFTMETA, 3676: KEY_CODES.KEY_RIGHTMETA,
  1: KEY_CODES.KEY_ESC, 57: KEY_CODES.KEY_SPACE, 58: KEY_CODES.KEY_CAPSLOCK,
  59: KEY_CODES.KEY_F1, 60: KEY_CODES.KEY_F2, 61: KEY_CODES.KEY_F3, 62: KEY_CODES.KEY_F4,
  63: KEY_CODES.KEY_F5, 64: KEY_CODES.KEY_F6, 65: KEY_CODES.KEY_F7, 66: KEY_CODES.KEY_F8,
  67: KEY_CODES.KEY_F9, 68: KEY_CODES.KEY_F10, 87: KEY_CODES.KEY_F11, 88: KEY_CODES.KEY_F12,
};
const UIOHOOK_F24 = 107;
const UIOHOOK_V = 47;
const UIOHOOK_CTRL = 29;
// Unmapped keys still need to count as "another key" (cancels a hold), so
// give them codes that can't collide with a hotkey.
const OTHER_KEY_BASE = 100000;

export function mapUiohookKey(code) {
  if (code === UIOHOOK_F24) return null; // our own Start-menu suppression tap
  return UIOHOOK_TO_EVDEV[code] ?? OTHER_KEY_BASE + code;
}

let uiohookModule;
function uiohook() {
  uiohookModule ??= require('uiohook-napi');
  return uiohookModule;
}

// HoldToTalk fed by a global low-level keyboard hook instead of evdev.
export class WindowsHotkey extends HoldToTalk {
  constructor(opts) {
    super({ ...opts, findDevices: () => [] });
  }

  start() {
    const { uIOhook } = uiohook();
    this.hook = uIOhook;
    this.onDown = (e) => { const c = mapUiohookKey(e.keycode); if (c !== null) this.handleKey(c, 1, 'hook'); };
    this.onUp = (e) => { const c = mapUiohookKey(e.keycode); if (c !== null) this.handleKey(c, 0, 'hook'); };
    uIOhook.on('keydown', this.onDown);
    uIOhook.on('keyup', this.onUp);
    uIOhook.start();
    // Windows opens the Start menu when Win is released with no other key in
    // between. Tapping F24 (bound to nothing) during the hold prevents that.
    this.on('start', () => {
      if (this.groups.some((g) => g.includes(KEY_CODES.KEY_LEFTMETA))) uIOhook.keyTap(UIOHOOK_F24);
    });
    return this.keyboards();
  }

  keyboards() {
    return [{ path: 'hook', name: 'Windows keyboard hook' }];
  }

  stop() {
    if (!this.hook) return;
    this.hook.off?.('keydown', this.onDown);
    this.hook.off?.('keyup', this.onUp);
    this.hook.stop();
    this.hook = null;
  }
}

export function createHotkey(keys) {
  return new WindowsHotkey({ keys });
}

// --- microphone ---------------------------------------------------------------

export function ffmpegPath() {
  const custom = envSetting(process.env, 'FFMPEG');
  if (custom) return custom;
  // Packaged tray app: shipped as an extra resource.
  const bundled = process.resourcesPath && path.join(process.resourcesPath, 'ffmpeg.exe');
  if (bundled && fs.existsSync(bundled)) return bundled;
  try {
    return path.join(path.dirname(require.resolve('@ffmpeg-installer/win32-x64/package.json')), 'ffmpeg.exe');
  } catch {
    return 'ffmpeg'; // fall back to one on PATH
  }
}

// Parse `ffmpeg -list_devices true -f dshow -i dummy` output into audio device names.
export function parseDshowAudioDevices(stderr) {
  const devices = [];
  let inAudioSection = false;
  for (const line of stderr.split(/\r?\n/)) {
    // Newer ffmpeg: '[dshow @ ...] "Microphone (Realtek)" (audio)'
    const tagged = line.match(/\]\s+"([^"]+)"\s+\(audio\)/);
    if (tagged) { devices.push(tagged[1]); continue; }
    // Older ffmpeg: a "DirectShow audio devices" header, then '[dshow @ ...]  "Name"'
    if (/DirectShow audio devices/i.test(line)) { inAudioSection = true; continue; }
    if (/DirectShow video devices/i.test(line)) { inAudioSection = false; continue; }
    if (inAudioSection && !/Alternative name/i.test(line)) {
      const m = line.match(/\]\s+"([^"]+)"/);
      if (m) devices.push(m[1]);
    }
  }
  return devices;
}

export async function listMicrophones() {
  // ffmpeg exits non-zero here by design (no real input), and prints to stderr.
  const r = await execFileP(ffmpegPath(), ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true })
    .catch((e) => e);
  return parseDshowAudioDevices(String(r.stderr ?? ''));
}

export function ffmpegMicArgs(device) {
  return ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-audio_buffer_size', '50',
    '-i', `audio=${device}`, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'];
}

let micName;
export function createRecorder() {
  const rec = new Recorder({
    command: ffmpegPath(),
    args: [],
    stopProcess: (p) => { try { p.stdin.write('q'); } catch { p.kill(); } }, // ffmpeg quits cleanly on "q"
  });
  const start = rec.start.bind(rec);
  // Resolve the mic once (GSTT_MIC or the first DirectShow audio device).
  rec.prepare = async () => {
    micName ??= envSetting(process.env, 'MIC') || (await listMicrophones())[0];
    if (!micName) throw new Error('No microphone found (ffmpeg -list_devices). Set GSTT_MIC.');
    rec.args = ffmpegMicArgs(micName);
    return micName;
  };
  rec.start = (opts) => {
    if (!rec.args.length) throw new Error('Microphone not ready yet');
    return start(opts);
  };
  return rec;
}

// --- paste --------------------------------------------------------------------

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

function powershell(script, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', [...PS, script], { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('PowerShell timed out')); }, 4000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out); else reject(new Error(`PowerShell failed: ${err.trim()}`));
    });
    p.stdin.end(input ?? '');
  });
}

export const windowsClipboard = {
  async read() {
    // Text only; returns null for images/files so we never clobber them on restore.
    const out = await powershell('[Console]::OutputEncoding=[Text.Encoding]::UTF8; $t = Get-Clipboard -Format Text -Raw; if ($t) { [Console]::Out.Write($t) }');
    return out.length ? out : null;
  },
  async write(text) {
    await powershell('[Console]::InputEncoding=[Text.Encoding]::UTF8; $t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t', text);
  },
  async pasteKeys() {
    uiohook().uIOhook.keyTap(UIOHOOK_V, [UIOHOOK_CTRL]);
  },
};

// opts.backend lets the tray app swap in Electron's (much faster) clipboard.
export function pasteText(text, opts = {}) {
  return pasteWith(text, { backend: windowsClipboard, ...opts });
}

export function pasteDescription() {
  return 'clipboard + Ctrl+V';
}

export function listKeyboards() {
  return [{ path: 'hook', name: 'Windows keyboard hook' }];
}

export function beep() { /* no system sounds yet; the tray app will show state */ }
export function notify() { /* tray app will use Electron notifications */ }
