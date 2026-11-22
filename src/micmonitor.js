// Watches the microphone during a hold: reports live levels for the tray
// meter, and warns within about a second if the mic isn't hearing anything,
// so a dead or muted mic is noticed while you're still talking instead of
// after the whole dictation is lost.
//
// Events:
//   'level'   (dBFS of the latest chunk, -Infinity for digital silence)
//   'warning' (reason) - 'no-data' | 'silent' | 'too-quiet'
//   'ok'      ()       - real signal arrived after a warning

import { EventEmitter } from 'node:events';

export const MIC_PROBLEMS = {
  'no-data': 'is sending no audio at all',
  silent: 'is sending no sound (exact silence)',
  'too-quiet': 'is barely picking anything up',
  muted: 'is muted',
};

export function chunkLevelDb(chunk) {
  const n = Math.floor(chunk.length / 2);
  if (!n) return -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = chunk.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return sum > 0 ? 10 * Math.log10(sum / n) : -Infinity;
}

export class MicMonitor extends EventEmitter {
  // floorDb: below this the mic is treated as not hearing anything. A working
  // mic in a quiet room is around -55 dBFS; a muted one is exactly -Infinity.
  // graceMs: capture tools that are slow to start (ffmpeg/dshow takes ~450 ms
  // to deliver its first audio) get this long, in total, to send at least
  // minBytes before "no audio" / "silent" is judged. Defaults to checkAfterMs.
  constructor({ checkAfterMs = 1000, graceMs = checkAfterMs, minBytes = 4800, floorDb = -70, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    super();
    this.checkAfterMs = checkAfterMs;
    this.graceMs = Math.max(graceMs, checkAfterMs);
    this.minBytes = minBytes;
    this.floorDb = floorDb;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  start() {
    this.bytes = 0;
    this.maxDb = -Infinity;
    this.warning = null;
    this.stopped = false;
    this.schedule();
  }

  // Look again after another checkAfterMs (e.g. after restarting capture).
  schedule() {
    this.bytes = 0;
    this.maxDb = -Infinity;
    this.waited = 0;
    this.wait(this.checkAfterMs);
  }

  wait(ms) {
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.waited += ms; this.check(); }, ms);
  }

  push(chunk) {
    if (this.stopped) return;
    this.bytes += chunk.length;
    const db = chunkLevelDb(chunk);
    if (db > this.maxDb) this.maxDb = db;
    this.emit('level', db);
    if (this.warning && db >= this.floorDb) {
      this.warning = null;
      this.emit('ok');
    }
  }

  problem() {
    if (this.bytes === 0) return 'no-data';
    if (this.maxDb === -Infinity) return 'silent';
    if (this.maxDb < this.floorDb) return 'too-quiet';
    return null;
  }

  check() {
    if (this.stopped) return;
    // Still starting up: too little audio to judge yet, and inside the grace period.
    if (this.bytes < this.minBytes && this.waited < this.graceMs) {
      this.wait(Math.min(100, this.graceMs - this.waited));
      return;
    }
    const p = this.problem();
    if (p && p !== this.warning) {
      this.warning = p;
      this.emit('warning', p);
    }
  }

  stop() {
    this.stopped = true;
    this.clearTimer(this.timer);
  }
}

// Map a level to one of `frames` meter frames (0 = quiet, frames-1 = loud).
export function levelFrame(db, frames = 6, minDb = -60, maxDb = -15) {
  if (!Number.isFinite(db) || db <= minDb) return 0;
  if (db >= maxDb) return frames - 1;
  return Math.max(1, Math.round(((db - minDb) / (maxDb - minDb)) * (frames - 1)));
}
