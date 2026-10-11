// Import this FIRST in any entry point that may start without a terminal.
//
// When the tray app is launched from a file manager, app menu or autostart,
// or outlives the terminal that started it, stdout/stderr can be unusable.
// Electron's main process doesn't repair them the way plain Node does, so
// the first touch of process.stderr can throw (EBADF), and dependencies touch
// it just by being imported (node:assert reads process.stderr to pick colors).
// That crashed the app with an error dialog before it could log anything.
//
// Here each stream is touched once inside try/catch. An unusable one is
// replaced with a stream that appends to the log file; a usable one gets an
// error handler so a later EPIPE (terminal closed) can't crash the app.

import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { logFilePath } from './names.js';

export { logFilePath };

export function fileSink(file = logFilePath()) {
  return new Writable({
    write(chunk, _enc, cb) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, chunk);
      } catch { /* never throw from logging */ }
      cb();
    },
  });
}

function usable(stream) {
  if (!stream || stream.destroyed) return false;
  if (typeof stream.fd === 'number') {
    try { fs.fstatSync(stream.fd); } catch { return false; }
  }
  return true;
}

// Returns the names of the streams that were replaced.
export function guardStdio(target = process) {
  const replaced = [];
  for (const name of ['stdout', 'stderr']) {
    let stream;
    try { stream = target[name]; } catch { stream = null; }
    if (usable(stream)) {
      stream.on?.('error', () => {}); // EPIPE/EBADF after the terminal goes away
      continue;
    }
    const sink = fileSink();
    Object.defineProperty(target, name, { configurable: true, enumerable: true, get: () => sink });
    replaced.push(name);
  }
  return replaced;
}

export const replaced = guardStdio();
