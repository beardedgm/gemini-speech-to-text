import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'stdio-guard.js');

// Child script: make process.stderr throw EBADF on access (what Derrick's
// Electron main hit), then import the guard, then do what crashed: import
// node:assert (reads process.stderr) and write to stderr.
function runChild({ withGuard }) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'gstt-guard-'));
  const script = `
    Object.defineProperty(process, 'stderr', { configurable: true, get() { const e = new Error('open EBADF'); e.code = 'EBADF'; throw e; } });
    ${withGuard ? `await import(${JSON.stringify(GUARD)});` : ''}
    try {
      await import('node:assert');
      new (await import('node:assert')).AssertionError({ actual: 1, expected: 2, operator: 'strictEqual' });
      console.error('written to stderr');
      process.stdout.write('OK');
    } catch (e) { process.stdout.write('CRASH ' + e.code); }
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: state } });
  const logged = fs.existsSync(path.join(state, 'gemini-speech-to-text', 'gemini-speech-to-text.log')) ? fs.readFileSync(path.join(state, 'gemini-speech-to-text', 'gemini-speech-to-text.log'), 'utf8') : '';
  return { out: r.stdout, logged };
}

test('without the guard, an unusable stderr crashes on assert/console use (the reported bug)', () => {
  assert.match(runChild({ withGuard: false }).out, /CRASH EBADF/);
});

test('with the guard, the app keeps running and stderr output goes to the log file', () => {
  const { out, logged } = runChild({ withGuard: true });
  assert.equal(out, 'OK');
  assert.match(logged, /written to stderr/);
});

test('guard leaves working streams alone and tolerates later EPIPE', async () => {
  const { guardStdio } = await import('../src/stdio-guard.js');
  const { EventEmitter } = await import('node:events');
  const ok = Object.assign(new EventEmitter(), { fd: 1, destroyed: false, write() {} });
  const target = { stdout: ok, stderr: ok };
  assert.deepEqual(guardStdio(target), []);
  assert.equal(target.stdout, ok);
  assert.doesNotThrow(() => ok.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
});
