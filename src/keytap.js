// Node side of keytap.py: a persistent virtual keyboard used to tap KEY_F24
// while Super is held, so COSMIC doesn't treat the Super release as a
// Launcher tap. Fails soft: without it dictation still works, the Launcher
// may just pop up after a Ctrl+Super hold.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// In the packaged app the script is unpacked next to app.asar so python can read it.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'keytap.py')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
export const KEY_F24 = 194;

export class KeyTap {
  constructor({ onError } = {}) {
    this.onError = onError;
    this.ready = false;
  }

  start() {
    this.proc = spawn('python3', ['-I', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    this.proc.stdout.on('data', (d) => { if (String(d).includes('ready')) this.ready = true; });
    this.proc.stderr.on('data', (d) => { err += d; });
    this.proc.on('error', (e) => this.onError?.(e.message));
    this.proc.on('close', (code) => {
      this.ready = false;
      if (code && !this.stopping) this.onError?.(err.trim().split('\n').pop() || `exited ${code}`);
    });
    this.proc.stdin.on('error', () => {});
    return this;
  }

  tap(code = KEY_F24) {
    if (this.ready) this.proc.stdin.write(`${code}\n`);
    return this.ready;
  }

  stop() {
    this.stopping = true;
    try { this.proc?.stdin.end('quit\n'); } catch { /* already gone */ }
  }
}
