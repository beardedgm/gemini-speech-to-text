// One-time migration from the app's old name ("flowcode") to
// "Gemini Speech to Text": settings, the saved API key, and autostart.
//
// Electron's safeStorage key on Linux lives in the keyring under the app's
// name, so after a rename the old encrypted key can't be read through
// safeStorage. We read the old entry ourselves (Chromium's documented
// "v11" scheme: AES-128-CBC, key = PBKDF2-SHA1(password, "saltysalt", 1),
// IV = 16 spaces) and re-encrypt under the new name. The key never leaves
// this process and is never logged.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function decryptChromiumV11(blob, password) {
  if (blob.subarray(0, 3).toString() !== 'v11') throw new Error('not a v11 blob');
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  return Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]).toString('utf8');
}

// Test helper: the inverse, matching Chromium's format.
export function encryptChromiumV11(text, password) {
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  return Buffer.concat([Buffer.from('v11'), cipher.update(text, 'utf8'), cipher.final()]);
}

// libsecret lookup through Python's GObject bindings, which ship with GNOME/COSMIC
// desktops (secret-tool often isn't installed). The password goes to our stdout
// pipe only; it's never printed to a terminal or logged.
const PY_LOOKUP = `
import sys, gi
gi.require_version('Secret', '1')
from gi.repository import Secret
schema = Secret.Schema.new('chrome_libsecret_os_crypt_password_v2', Secret.SchemaFlags.NONE,
                           {'application': Secret.SchemaAttributeType.STRING})
pw = Secret.password_lookup_sync(schema, {'application': sys.argv[1]}, None)
sys.stdout.write(pw or '')
`;

// The old app's keyring password (Linux Secret Service), or null.
export function legacyKeyringPassword(application = 'flowcode') {
  const attempts = [
    ['secret-tool', ['lookup', 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2', 'application', application]],
    ['python3', ['-I', '-c', PY_LOOKUP, application]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim();
      if (out) return out;
    } catch { /* try the next way */ }
  }
  return null;
}

export function legacyConfigDir(appDataDir) {
  return path.join(appDataDir, 'flowcode');
}

// store: the new SettingsStore. Returns a list of what was migrated (for the log).
export function migrateFromFlowcode({ store, appDataDir, platform = process.platform, keyringPassword = legacyKeyringPassword, home = os.homedir() }) {
  const done = [];
  const oldFile = path.join(legacyConfigDir(appDataDir), 'settings.json');
  if (store.data.migratedFrom || !fs.existsSync(oldFile)) return done;
  let keyFailed = false;
  let old;
  try { old = JSON.parse(fs.readFileSync(oldFile, 'utf8')); } catch { return done; }

  const settings = {};
  for (const k of ['mode', 'hotkey', 'silenceDb', 'startAtLogin']) if (old[k] !== undefined && store.data[k] === undefined) settings[k] = old[k];
  if (Object.keys(settings).length) { store.update(settings); done.push('settings'); }

  if (old.apiKeyEncrypted && !store.hasApiKey()) {
    try {
      const blob = Buffer.from(old.apiKeyEncrypted, 'base64');
      let key = null;
      if (platform === 'linux' && blob.subarray(0, 3).toString() === 'v11') {
        const password = keyringPassword();
        if (password) key = decryptChromiumV11(blob, password);
      }
      if (key) { store.setApiKey(key); done.push('API key'); }
      else keyFailed = true;
    } catch {
      keyFailed = true;
    }
    if (keyFailed) done.push('API key (could not be carried over; please paste it again in Settings)');
  }

  // Old autostart entry would launch the old app; drop it (new one is written if enabled).
  const oldAutostart = path.join(home, '.config', 'autostart', 'flowcode.desktop');
  if (fs.existsSync(oldAutostart)) {
    fs.rmSync(oldAutostart, { force: true });
    if (store.data.startAtLogin === undefined) store.update({ startAtLogin: true });
    done.push('autostart');
  }

  // Finished only once the key moved (or there was none); otherwise retry next start.
  if (!keyFailed) {
    store.data.migratedFrom = 'flowcode';
    store.save();
  }
  return done;
}
