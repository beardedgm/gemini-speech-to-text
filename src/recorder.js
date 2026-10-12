// Microphone capture: 16 kHz mono 16-bit PCM from a child process's stdout.
// Linux uses PipeWire's pw-record; Windows passes ffmpeg (DirectShow) in.
// Speech models don't need more than 16 kHz, and it keeps uploads small.
// Audio is kept in memory and can be streamed chunk by chunk (live mode).

import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const SAMPLE_RATE = 16000;

const PW_RECORD = { command: 'pw-record', args: ['--rate=16000', '--channels=1', '--format=s16', '--raw', '-'] };

export class Recorder {
  // stopProcess(proc): ask the recorder to finish (pw-record: SIGINT; ffmpeg: "q" on stdin).
  constructor({ command = PW_RECORD.command, args = PW_RECORD.args, stopProcess = (p) => p.kill('SIGINT') } = {}) {
    this.command = command;
    this.args = args;
    this.stopProcess = stopProcess;
    this.proc = null;
  }

  // onChunk(buffer) receives raw PCM as it arrives.
  start({ onChunk } = {}) {
    if (this.proc) throw new Error('Already recording');
    this.chunks = [];
    this.stderr = '';
    this.onChunk = onChunk;
    this.replaced = new WeakSet();
    this.spawnProc();
  }

  spawnProc() {
    const proc = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    proc.stdin.on('error', () => {});
    proc.stdout.on('data', (d) => {
      if (this.replaced.has(proc)) return; // output from a restarted-away process
      this.chunks.push(d);
      this.onChunk?.(d);
    });
    proc.stderr.on('data', (d) => { this.stderr += d; });
    proc.on('error', (err) => { this.stderr += err.message; });
    this.exited = new Promise((resolve) => proc.on('close', resolve));
  }

  // Replace a stalled capture process mid-recording, keeping audio so far.
  restart() {
    const old = this.proc;
    if (!old) return false;
    this.replaced.add(old);
    this.spawnProc();
    old.kill('SIGKILL');
    return true;
  }

  // Stops recording and resolves with all captured PCM.
  async stop() {
    if (!this.proc) return null;
    const proc = this.proc;
    this.proc = null;
    this.stopProcess(proc);
    const timeout = setTimeout(() => proc.kill('SIGKILL'), 2000);
    await this.exited;
    clearTimeout(timeout);
    const pcm = Buffer.concat(this.chunks);
    if (pcm.length === 0) throw new Error(`Recording is empty${this.stderr ? `: ${this.stderr.trim()}` : ''}`);
    return pcm;
  }

  async cancel() {
    try { await this.stop(); } catch { /* nothing to keep */ }
  }
}

export function pcmSeconds(pcm) {
  return pcm.length / (SAMPLE_RATE * 2);
}

// Wrap 16 kHz mono s16 PCM in a 44-byte WAV header.
export function toWav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24); h.writeUInt32LE(SAMPLE_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// PCM samples of a WAV: walk the RIFF chunks to "data", since some writers
// add LIST/fact chunks before it.
export function wavPcm(buf) {
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const end = size && off + 8 + size <= buf.length ? off + 8 + size : buf.length;
      return buf.subarray(off + 8, end);
    }
    off += 8 + size + (size % 2);
  }
  return buf.subarray(44);
}

export function wavSeconds(file) {
  return pcmSeconds(wavPcm(fs.readFileSync(file)));
}

export function wavLevels(file) {
  return pcmLevels(wavPcm(fs.readFileSync(file)));
}

// Loudness of s16 PCM in dBFS: overall RMS and loudest 50 ms window.
// Used to skip clips with no speech, which models tend to "transcribe" anyway.
export function pcmLevels(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (n <= 0) return { rmsDb: -Infinity, peakWindowDb: -Infinity };
  const win = 800; // 50 ms at 16 kHz
  let total = 0, winSum = 0, best = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    total += v * v;
    winSum += v * v;
    if ((i + 1) % win === 0) { best = Math.max(best, winSum / win); winSum = 0; }
  }
  const db = (x) => (x > 0 ? 10 * Math.log10(x) : -Infinity);
  return { rmsDb: db(total / n), peakWindowDb: db(Math.max(best, winSum / Math.max(1, n % win))) };
}
