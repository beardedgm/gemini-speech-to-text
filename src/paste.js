// Insert text into the focused app: put it on the clipboard, press Ctrl+V,
// then put the user's previous clipboard back.
//
// Wayland: wl-clipboard + ydotool (needs ydotoold running).
// X11:     xclip + xdotool.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
// Every helper gets a timeout so a stuck clipboard owner can't wedge the app.
const run = (cmd, args, opts = {}) => execFileP(cmd, args, { timeout: 3000, killSignal: 'SIGKILL', ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function detectBackend(env = process.env) {
  return env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === 'wayland' ? 'wayland' : 'x11';
}

const backends = {
  wayland: {
    async read() {
      const { stdout: types } = await run('wl-paste', ['--list-types'], { timeout: 1500 });
      if (!/^(text\/plain|UTF8_STRING)/m.test(types)) return null; // image or empty: don't touch
      const { stdout } = await run('wl-paste', ['--no-newline'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 1500 });
      return stdout;
    },
    write: (text) => pipeTo('wl-copy', [], text),
    pasteKeys: () => run('ydotool', ['key', '--delay', '0', 'ctrl+v']),
  },
  x11: {
    async read() {
      const { stdout } = await run('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 1500 });
      return stdout;
    },
    write: (text) => pipeTo('xclip', ['-selection', 'clipboard', '-i'], text),
    pasteKeys: () => run('xdotool', ['key', '--clearmodifiers', 'ctrl+v']),
  },
};

// wl-copy and xclip fork a background process that keeps serving the
// clipboard and inherits our pipes. Wait for the parent's 'exit', never
// 'close': 'close' waits for every pipe holder and so never fires.
export function pipeTo(cmd, args, text, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'], detached: true });
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      p.stderr.destroy(); // stop listening; the background child may hold it open
      if (code === 0) resolve(); else reject(new Error(`${cmd} failed: ${err.trim()}`));
    });
    p.stdin.end(text);
    p.unref();
  });
}

// backend: 'wayland', 'x11', or an object with read/write/pasteKeys (Windows).
export async function pasteText(text, { backend = detectBackend(), restore = true, restoreDelayMs = 400 } = {}) {
  const b = typeof backend === 'string' ? backends[backend] : backend;
  let previous = null;
  if (restore) {
    try { previous = await b.read(); } catch { previous = null; }
  }
  await b.write(text);
  await sleep(60); // let the compositor see the new selection owner
  await b.pasteKeys();
  if (restore && previous !== null) {
    await sleep(restoreDelayMs); // the target app reads the clipboard asynchronously
    await b.write(previous);
  }
}

export async function readClipboard(backend = detectBackend()) {
  return backends[backend].read();
}
