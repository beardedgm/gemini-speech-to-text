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
  91: KEY_CODES.KEY_F13, 92: KEY_CODES.KEY_F14, 93: KEY_CODES.KEY_F15, 99: KEY_CODES.KEY_F16,
  100: KEY_CODES.KEY_F17, 101: KEY_CODES.KEY_F18, 102: KEY_CODES.KEY_F19, 103: KEY_CODES.KEY_F20,
  104: KEY_CODES.KEY_F21, 105: KEY_CODES.KEY_F22, 106: KEY_CODES.KEY_F23,
  15: KEY_CODES.KEY_TAB, 70: KEY_CODES.KEY_SCROLLLOCK, 3667: KEY_CODES.KEY_DELETE,
};
// Letters and digits: libuiohook uses the same set-1 scan codes as evdev.
for (const [name, code] of Object.entries(KEY_CODES)) {
  if (/^KEY_[A-Z0-9]$/.test(name)) UIOHOOK_TO_EVDEV[code] = code;
}
// evdev codes the Windows hook can report (Pause and Compose have no uiohook code).
export const DETECTABLE_KEYS = new Set(Object.values(UIOHOOK_TO_EVDEV));
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
// Each device is { name, altName }: altName is DirectShow's "Alternative name"
// (an @device_... moniker), or null if ffmpeg didn't print one.
export function parseDshowAudioDeviceList(stderr) {
  const devices = [];
  let inAudioSection = false;
  let last = null; // the device a following "Alternative name" line belongs to
  for (const line of stderr.split(/\r?\n/)) {
    const alt = line.match(/Alternative name\s+"([^"]+)"/i);
    if (alt) { if (last) last.altName = alt[1]; continue; }
    // Newer ffmpeg: '[dshow @ ...] "Microphone (Realtek)" (audio)'
    const tagged = line.match(/\]\s+"([^"]+)"\s+\(([^)]*)\)\s*$/);
    if (tagged) {
      last = /audio/.test(tagged[2]) ? { name: tagged[1], altName: null } : null;
      if (last) devices.push(last);
      continue;
    }
    // Older ffmpeg: a "DirectShow audio devices" header, then '[dshow @ ...]  "Name"'
    if (/DirectShow audio devices/i.test(line)) { inAudioSection = true; last = null; continue; }
    if (/DirectShow video devices/i.test(line)) { inAudioSection = false; last = null; continue; }
    const m = line.match(/\]\s+"([^"]+)"/);
    if (m) {
      last = inAudioSection ? { name: m[1], altName: null } : null;
      if (last) devices.push(last);
    }
  }
  return devices;
}

export function parseDshowAudioDevices(stderr) {
  return parseDshowAudioDeviceList(stderr).map((d) => d.name);
}

async function listMicrophoneDevices() {
  // ffmpeg exits non-zero here by design (no real input), and prints to stderr.
  const r = await execFileP(ffmpegPath(), ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true })
    .catch((e) => e);
  return parseDshowAudioDeviceList(String(r.stderr ?? ''));
}

export async function listMicrophones() {
  return (await listMicrophoneDevices()).map((d) => d.name);
}

// Pick GSTT_MIC (display or alternative name) or the first device.
// Returns { name, input }: name for messages, input for ffmpeg. ffmpeg's dshow
// input splits on ':' (video:audio), so "Microphone (Elgato Wave:3)" can't be
// opened by name; the alternative name has no ':' and is used when known.
export function resolveMicrophone(devices, wanted) {
  const dev = wanted
    ? devices.find((d) => d.name === wanted || d.altName === wanted) ?? { name: wanted, altName: null }
    : devices[0];
  return dev ? { name: dev.name, input: dev.altName ?? dev.name } : null;
}

export function ffmpegMicArgs(device) {
  return ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-audio_buffer_size', '50',
    '-i', `audio=${device}`, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'];
}

let mic; // { name, input } once resolved
export function createRecorder() {
  const rec = new Recorder({
    command: ffmpegPath(),
    args: [],
    stopProcess: (p) => { try { p.stdin.write('q'); } catch { p.kill(); } }, // ffmpeg quits cleanly on "q"
  });
  const start = rec.start.bind(rec);
  // Resolve the mic once (GSTT_MIC or the first DirectShow audio device).
  rec.prepare = async () => {
    mic ??= resolveMicrophone(await listMicrophoneDevices(), envSetting(process.env, 'MIC'));
    if (!mic) throw new Error('No microphone found (ffmpeg -list_devices). Set GSTT_MIC.');
    rec.args = ffmpegMicArgs(mic.input);
    return mic.name;
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

// The DirectShow mic in use (resolved when recording is first prepared).
export async function microphoneName() {
  return mic?.name ?? null;
}

export function listKeyboards() {
  return [{ path: 'hook', name: 'Windows keyboard hook' }];
}

// Built-in Windows sounds, played by a hidden PowerShell so we don't block.
export const WINDOWS_SOUNDS = {
  start: 'Speech On.wav',
  done: 'Speech Off.wav',
  error: 'Windows Critical Stop.wav',
};

export function soundScript(kind, mediaDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'Media')) {
  const file = WINDOWS_SOUNDS[kind];
  if (!file) return null;
  const full = path.win32.join(mediaDir, file).replace(/'/g, "''");
  return `$p = '${full}'; if (Test-Path $p) { (New-Object Media.SoundPlayer $p).PlaySync() } else { [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 400 }`;
}

export function beep(kind) {
  const script = soundScript(kind);
  if (!script) return;
  spawn('powershell.exe', [...PS, script], { stdio: 'ignore', windowsHide: true, detached: true }).on('error', () => {}).unref();
}
export function notify() { /* tray app will use Electron notifications */ }
