import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decryptChromiumV11, encryptChromiumV11, migrateFromFlowcode } from '../app/migrate.js';
import { SettingsStore } from '../app/store.js';
import { loadConfig } from '../src/config.js';
import { envSetting, logFilePath, migrateLegacyStateDir, stateDir } from '../src/names.js';

const fakeSafe = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gstt-migrate-'));

test('GSTT_* settings win; legacy FLOWCODE_* still work as a fallback', () => {
  assert.equal(envSetting({ GSTT_MODE: 'oneshot', FLOWCODE_MODE: 'live' }, 'MODE'), 'oneshot');
  assert.equal(envSetting({ FLOWCODE_MODE: 'live' }, 'MODE'), 'live');
  const c = loadConfig({ GEMINI_API_KEY: 'k', FLOWCODE_SILENCE_DB: '-48', GSTT_HOTKEY: 'CTRL+ALT', FLOWCODE_HOTKEY: 'CTRL+SUPER' });
  assert.equal(c.silenceDb, -48);
  assert.equal(c.hotkey, 'CTRL+ALT');
});

test('log folder moves from flowcode to the new name, once', () => {
  const env = { XDG_STATE_HOME: tmp() };
  const old = path.join(env.XDG_STATE_HOME, 'flowcode');
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'flowcode.log'), 'old lines\n');
  assert.equal(migrateLegacyStateDir('linux', env), true);
  assert.equal(fs.readFileSync(logFilePath('linux', env), 'utf8'), 'old lines\n');
  assert.equal(fs.existsSync(old), false);
  assert.equal(migrateLegacyStateDir('linux', env), false);
  assert.match(stateDir('linux', env), /gemini-speech-to-text$/);
});

test('Chromium v11 decrypt matches the format (round trip)', () => {
  const blob = encryptChromiumV11('AIzaTEST-key_123', 'keyring-password');
  assert.equal(blob.subarray(0, 3).toString(), 'v11');
  assert.equal(decryptChromiumV11(blob, 'keyring-password'), 'AIzaTEST-key_123');
  assert.throws(() => decryptChromiumV11(blob, 'wrong-password'));
});

function oldInstall(appData, home, { withAutostart = false } = {}) {
  fs.mkdirSync(path.join(appData, 'flowcode'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'flowcode', 'settings.json'), JSON.stringify({
    apiKeyEncrypted: encryptChromiumV11('AIzaMIGRATED', 'old-pass').toString('base64'),
    mode: 'live', hotkey: 'CTRL+SUPER', silenceDb: -48,
  }));
  if (withAutostart) {
    fs.mkdirSync(path.join(home, '.config', 'autostart'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'autostart', 'flowcode.desktop'), '[Desktop Entry]\n');
  }
}

test('settings, API key and autostart carry over from flowcode, exactly once', () => {
  const appData = tmp(), home = tmp();
  oldInstall(appData, home, { withAutostart: true });
  const store = new SettingsStore(path.join(appData, 'Gemini Speech to Text'), fakeSafe);
  const done = migrateFromFlowcode({ store, appDataDir: appData, platform: 'linux', keyringPassword: () => 'old-pass', home });
  assert.deepEqual(done, ['settings', 'API key', 'autostart']);
  assert.equal(store.getApiKey(), 'AIzaMIGRATED');
  assert.deepEqual(store.settings, { mode: 'live', hotkey: 'CTRL+SUPER', silenceDb: -48, startAtLogin: true });
  assert.equal(fs.existsSync(path.join(home, '.config', 'autostart', 'flowcode.desktop')), false);
  assert.doesNotMatch(fs.readFileSync(store.file, 'utf8'), /AIzaMIGRATED/);
  // Second start: nothing to do.
  assert.deepEqual(migrateFromFlowcode({ store, appDataDir: appData, platform: 'linux', keyringPassword: () => 'old-pass', home }), []);
});

test('if the old key cannot be read, settings still move and the user is asked to paste the key', () => {
  const appData = tmp(), home = tmp();
  oldInstall(appData, home);
  const store = new SettingsStore(path.join(appData, 'new'), fakeSafe);
  const done = migrateFromFlowcode({ store, appDataDir: appData, platform: 'linux', keyringPassword: () => null, home });
  assert.equal(done[0], 'settings');
  assert.match(done[1], /please paste it again/);
  assert.equal(store.hasApiKey(), false);
  // Not marked done, so the next start retries (e.g. after the keyring unlocks).
  const retry = migrateFromFlowcode({ store, appDataDir: appData, platform: 'linux', keyringPassword: () => 'old-pass', home });
  assert.deepEqual(retry, ['API key']);
  assert.equal(store.getApiKey(), 'AIzaMIGRATED');
});

test('nothing to migrate on a fresh install', () => {
  const appData = tmp();
  const store = new SettingsStore(path.join(appData, 'new'), fakeSafe);
  assert.deepEqual(migrateFromFlowcode({ store, appDataDir: appData, platform: 'linux', keyringPassword: () => 'x', home: tmp() }), []);
});
