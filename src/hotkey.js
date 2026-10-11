// Global hold-to-talk hotkey for Linux, read straight from evdev.
//
// Works on both Wayland and X11 because it reads /dev/input/event* directly.
// The user must be in the `input` group (see README).

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

// Linux input-event-codes.h subset: the keys that make sense as a hotkey.
export const KEY_CODES = {
  KEY_ESC: 1,
  KEY_LEFTCTRL: 29,
  KEY_LEFTSHIFT: 42,
  KEY_RIGHTSHIFT: 54,
  KEY_LEFTALT: 56,
  KEY_SPACE: 57,
  KEY_CAPSLOCK: 58,
  KEY_F1: 59, KEY_F2: 60, KEY_F3: 61, KEY_F4: 62, KEY_F5: 63, KEY_F6: 64,
  KEY_F7: 65, KEY_F8: 66, KEY_F9: 67, KEY_F10: 68, KEY_F11: 87, KEY_F12: 88,
  KEY_RIGHTCTRL: 97,
  KEY_RIGHTALT: 100,
  KEY_LEFTMETA: 125,
  KEY_RIGHTMETA: 126,
  KEY_COMPOSE: 127,
  KEY_F13: 183, KEY_F14: 184, KEY_F15: 185, KEY_F16: 186,
  KEY_F17: 187, KEY_F18: 188, KEY_F19: 189, KEY_F20: 190,
  KEY_PAUSE: 119,
  KEY_SCROLLLOCK: 70,
};

const EV_KEY = 1;
const KEY_A = 30;
// struct input_event on 64-bit Linux: timeval (16) + type u16 + code u16 + value s32.
const EVENT_SIZE = 24;

// Side-agnostic aliases: "CTRL" matches either Ctrl key, and so on.
export const KEY_GROUPS = {
  CTRL: [KEY_CODES.KEY_LEFTCTRL, KEY_CODES.KEY_RIGHTCTRL],
  SHIFT: [KEY_CODES.KEY_LEFTSHIFT, KEY_CODES.KEY_RIGHTSHIFT],
  ALT: [KEY_CODES.KEY_LEFTALT, KEY_CODES.KEY_RIGHTALT],
  SUPER: [KEY_CODES.KEY_LEFTMETA, KEY_CODES.KEY_RIGHTMETA],
  META: [KEY_CODES.KEY_LEFTMETA, KEY_CODES.KEY_RIGHTMETA],
  WIN: [KEY_CODES.KEY_LEFTMETA, KEY_CODES.KEY_RIGHTMETA],
};

export const SUPER_KEYS = KEY_GROUPS.SUPER;

// "CTRL+SUPER" -> [[29, 97], [125, 126]]. Each group is satisfied by any one of its keys.
export function parseHotkey(spec) {
  return spec.split('+').map((part) => {
    const name = part.trim().toUpperCase();
    if (name in KEY_GROUPS) return [...KEY_GROUPS[name]];
    const full = name.startsWith('KEY_') ? name : `KEY_${name}`;
    if (full in KEY_CODES) return [KEY_CODES[full]];
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) return [n];
    throw new Error(`Unknown key "${part}" in hotkey "${spec}"`);
  });
}

const CODE_NAMES = Object.fromEntries(Object.entries(KEY_CODES).map(([k, v]) => [v, k]));
export const keyName = (code) => CODE_NAMES[code] ?? `code ${code}`;

function hasBit(hexWords, bit) {
  // /proc bitmaps are space-separated hex longs, most significant first.
  const words = hexWords.trim().split(/\s+/).reverse();
  const word = BigInt(`0x${words[Math.floor(bit / 64)] ?? '0'}`);
  return ((word >> BigInt(bit % 64)) & 1n) === 1n;
}

// Find real keyboards: devices that report EV_KEY and have the A key.
// Our own injectors (ydotoold, our keytap) are excluded so we never hear our own keys.
export function findKeyboards(devicesText = fs.readFileSync('/proc/bus/input/devices', 'utf8')) {
  const keyboards = [];
  for (const block of devicesText.split(/\n\s*\n/)) {
    const name = block.match(/^N: Name="(.*)"$/m)?.[1] ?? '';
    const handlers = block.match(/^H: Handlers=(.*)$/m)?.[1] ?? '';
    const keyBits = block.match(/^B: KEY=(.*)$/m)?.[1];
    const event = handlers.match(/\bevent(\d+)\b/)?.[1];
    if (!event || !keyBits || /ydotool|gstt virtual|flowcode/i.test(name)) continue;
    if (!hasBit(keyBits, KEY_A)) continue;
    keyboards.push({ name, path: `/dev/input/event${event}` });
  }
  return keyboards;
}

// Emits:
//   'start'  - every hotkey group has a key down (start recording now)
//   'stop'   - a hotkey group was released after a valid hold
//   'cancel' - the hold was too short, or another key was pressed (it was a shortcut, not dictation)
//   'debug'  - (message) hotkey-related events, for GSTT_DEBUG
//   'devices'- (list) the set of keyboards being read changed
//
// Key state is tracked per device, so one press reported by two devices isn't
// double counted, and a device that disappears takes its held keys with it.
// Keys outside the hotkey never block it from starting: a missed release
// elsewhere (focus change, grab, reconnect) must not disable dictation.
export class HoldToTalk extends EventEmitter {
  constructor({ keys, minHoldMs = 250, rescanMs = 2000, findDevices = findKeyboards }) {
    super();
    this.groups = keys.map((g) => (Array.isArray(g) ? g : [g]));
    this.hotkeyCodes = new Set(this.groups.flat());
    this.minHoldMs = minHoldMs;
    this.rescanMs = rescanMs;
    this.findDevices = findDevices;
    this.down = new Map(); // device path -> Set of held codes
    this.active = false;
    this.startedAt = 0;
    this.readers = new Map(); // device path -> { proc, name }
  }

  start() {
    this.stopping = false;
    this.rescan();
    if (this.readers.size === 0) throw new Error('No keyboards found in /proc/bus/input/devices');
    // Pick up keyboards that are plugged in or reconnect (Bluetooth) later.
    this.rescanTimer = setInterval(() => this.rescan(), this.rescanMs);
    this.rescanTimer.unref?.();
    return this.keyboards();
  }

  keyboards() {
    return [...this.readers.entries()].map(([path, r]) => ({ path, name: r.name }));
  }

  rescan() {
    let found;
    try { found = this.findDevices(); } catch { return; }
    let changed = false;
    for (const kb of found) {
      if (this.readers.has(kb.path)) continue;
      this.openDevice(kb);
      changed = true;
    }
    if (changed && this.rescanTimer) this.emit('devices', this.keyboards());
  }

  openDevice(kb) {
    // Read through a `cat` child: Node's fs streams would park a libuv pool thread
    // in a blocking read() per device, starving DNS lookups and hanging exit.
    const proc = spawn('cat', [kb.path], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.readers.set(kb.path, { proc, name: kb.name });
    let pending = Buffer.alloc(0);
    proc.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      for (; offset + EVENT_SIZE <= pending.length; offset += EVENT_SIZE) {
        const type = pending.readUInt16LE(offset + 16);
        const code = pending.readUInt16LE(offset + 18);
        const value = pending.readInt32LE(offset + 20);
        if (type === EV_KEY) this.handleKey(code, value, kb.path);
      }
      pending = pending.subarray(offset);
    });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code) => {
      if (this.readers.get(kb.path)?.proc === proc) this.readers.delete(kb.path);
      this.dropDevice(kb.path);
      if (this.stopping) return;
      const msg = /Permission denied/.test(err) ? 'EACCES permission denied' : (err.trim() || `reader exited (${code})`);
      this.emit('debug', `${kb.path} (${kb.name}) closed: ${msg}`);
      if (/EACCES/.test(msg)) this.emit('error', new Error(`${kb.path} (${kb.name}): ${msg}`));
      // Otherwise the device went away; the next rescan reopens it if it comes back.
    });
  }

  stop() {
    this.stopping = true;
    clearInterval(this.rescanTimer);
    for (const r of this.readers.values()) r.proc.kill();
    this.readers.clear();
  }

  // Forget keys held on a device that disappeared.
  dropDevice(path) {
    const held = this.down.get(path);
    this.down.delete(path);
    if (held?.size && this.active && !this.groupsHeld()) this.release('device-gone');
  }

  isDown(code) {
    for (const set of this.down.values()) if (set.has(code)) return true;
    return false;
  }

  groupsHeld() {
    return this.groups.every((g) => g.some((c) => this.isDown(c)));
  }

  release(reason) {
    this.active = false;
    const held = Date.now() - this.startedAt;
    if (reason === 'device-gone') this.emit('cancel', reason);
    else if (held < this.minHoldMs) this.emit('cancel', 'too-short');
    else this.emit('stop', held);
  }

  // Resolves once no hotkey key is held (or after timeoutMs), so a simulated
  // Ctrl+V never combines with a Super/Ctrl the user is still holding.
  waitForRelease(timeoutMs = 1500) {
    const anyHeld = () => [...this.hotkeyCodes].some((c) => this.isDown(c));
    if (!anyHeld()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { clearInterval(poll); resolve(false); }, timeoutMs);
      const poll = setInterval(() => {
        if (!anyHeld()) { clearInterval(poll); clearTimeout(timer); resolve(true); }
      }, 20);
    });
  }

  // value: 1 = press, 0 = release, 2 = autorepeat
  handleKey(code, value, device = 'default') {
    if (value === 2) return;
    const isHotkey = this.hotkeyCodes.has(code);
    let set = this.down.get(device);
    if (!set) { set = new Set(); this.down.set(device, set); }
    if (value === 1) {
      set.add(code);
      if (isHotkey) this.emit('debug', `${keyName(code)} down on ${device}`);
      if (this.active && !isHotkey) {
        this.active = false;
        this.emit('debug', `other key (${keyName(code)}) pressed during hold`);
        this.emit('cancel', 'other-key');
        return;
      }
      if (!this.active && isHotkey && this.groupsHeld()) {
        this.active = true;
        this.startedAt = Date.now();
        this.emit('start');
      }
    } else if (value === 0) {
      set.delete(code);
      if (isHotkey) this.emit('debug', `${keyName(code)} up on ${device}`);
      if (this.active && isHotkey && !this.groupsHeld()) this.release('released');
    }
  }
}
