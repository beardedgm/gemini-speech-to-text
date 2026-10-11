// Tray app settings. The API key is encrypted with Electron safeStorage,
// which uses the OS keychain (Windows DPAPI / Linux Secret Service via
// gnome-keyring or KWallet). Other settings are plain JSON.

import fs from 'node:fs';
import path from 'node:path';

export const SETTING_KEYS = ['mode', 'hotkey', 'silenceDb', 'startAtLogin', 'soundStart', 'soundDone'];

export class SettingsStore {
  // safeStorage is injected so this can be tested without Electron.
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'settings.json');
    this.safeStorage = safeStorage;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  get settings() {
    return Object.fromEntries(SETTING_KEYS.filter((k) => this.data[k] !== undefined).map((k) => [k, this.data[k]]));
  }

  update(values) {
    for (const k of SETTING_KEYS) if (values[k] !== undefined) this.data[k] = values[k];
    this.save();
  }

  // 'keychain' when the OS keychain protects the key; 'plain' when Electron
  // falls back to an unprotected key (Linux without a Secret Service).
  keyProtection() {
    if (!this.safeStorage.isEncryptionAvailable()) return 'unavailable';
    const backend = this.safeStorage.getSelectedStorageBackend?.();
    return backend === 'basic_text' ? 'plain' : 'keychain';
  }

  hasApiKey() {
    return typeof this.data.apiKeyEncrypted === 'string';
  }

  getApiKey() {
    if (!this.hasApiKey()) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(this.data.apiKeyEncrypted, 'base64'));
    } catch {
      return null; // keychain changed or locked
    }
  }

  setApiKey(key) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('No OS keychain available to store the key securely.');
    this.data.apiKeyEncrypted = this.safeStorage.encryptString(key.trim()).toString('base64');
    this.save();
  }

  clearApiKey() {
    delete this.data.apiKeyEncrypted;
    this.save();
  }
}

// Settings saved in the app win over .env; the stored key wins over env keys.
export function mergeConfig(envConfig, settings, storedKey) {
  return {
    ...envConfig,
    ...(settings.mode ? { mode: settings.mode } : {}),
    ...(settings.hotkey ? { hotkey: settings.hotkey } : {}),
    ...(Number.isFinite(settings.silenceDb) ? { silenceDb: settings.silenceDb } : {}),
    ...(typeof settings.soundStart === 'boolean' ? { soundStart: settings.soundStart } : {}),
    ...(typeof settings.soundDone === 'boolean' ? { soundDone: settings.soundDone } : {}),
    apiKey: storedKey || envConfig.apiKey,
  };
}
