import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeConfig, SettingsStore } from '../app/store.js';

// Stand-in for Electron safeStorage: reversible "encryption" so we can check it's not stored in plain text.
const fakeSafe = (backend = 'gnome_libsecret') => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => backend,
  encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flowcode-store-'));

test('API key is stored encrypted, survives reload, and can be cleared', () => {
  const dir = tmp();
  const s = new SettingsStore(dir, fakeSafe());
  s.setApiKey('  AIzaSECRET  ');
  const onDisk = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.doesNotMatch(onDisk, /AIzaSECRET/);
  assert.equal(new SettingsStore(dir, fakeSafe()).getApiKey(), 'AIzaSECRET');
  s.clearApiKey();
  assert.equal(new SettingsStore(dir, fakeSafe()).hasApiKey(), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o077, 0);
});

test('only known settings are kept', () => {
  const s = new SettingsStore(tmp(), fakeSafe());
  s.update({ mode: 'oneshot', hotkey: 'CTRL+ALT', bogus: 1 });
  assert.deepEqual(s.settings, { mode: 'oneshot', hotkey: 'CTRL+ALT' });
});

test('key protection reports a plain-text fallback and missing keychain', () => {
  assert.equal(new SettingsStore(tmp(), fakeSafe()).keyProtection(), 'keychain');
  assert.equal(new SettingsStore(tmp(), fakeSafe('basic_text')).keyProtection(), 'plain');
  const none = { ...fakeSafe(), isEncryptionAvailable: () => false };
  assert.equal(new SettingsStore(tmp(), none).keyProtection(), 'unavailable');
  assert.throws(() => new SettingsStore(tmp(), none).setApiKey('x'), /keychain/);
});

test('mergeConfig: app settings override .env, stored key wins over env key', () => {
  const env = { apiKey: 'envkey', mode: 'live', hotkey: 'CTRL+SUPER', silenceDb: -40, model: 'm' };
  assert.deepEqual(mergeConfig(env, { mode: 'oneshot', silenceDb: -48 }, 'stored'),
    { ...env, mode: 'oneshot', silenceDb: -48, apiKey: 'stored' });
  assert.equal(mergeConfig(env, {}, null).apiKey, 'envkey');
});
