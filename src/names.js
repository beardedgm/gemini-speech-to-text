// The app's names in one place, plus migration from its old name ("flowcode").

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'Gemini Speech to Text';
export const APP_SLUG = 'gemini-speech-to-text';
export const LEGACY_SLUG = 'flowcode';

export const ENV_PREFIX = 'GSTT_';
export const LEGACY_ENV_PREFIX = 'FLOWCODE_';

// GSTT_X, falling back to the old FLOWCODE_X so existing .env files keep working.
export function envSetting(env, name) {
  return env[`${ENV_PREFIX}${name}`] ?? env[`${LEGACY_ENV_PREFIX}${name}`];
}

export function stateDir(platform = process.platform, env = process.env, slug = APP_SLUG) {
  return platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), slug)
    : path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), slug);
}

export function logFilePath(platform = process.platform, env = process.env) {
  return path.join(stateDir(platform, env), `${APP_SLUG}.log`);
}

// Move ~/.local/state/flowcode (or %LOCALAPPDATA%\flowcode) to the new name,
// renaming flowcode.log, unless the new folder already exists.
export function migrateLegacyStateDir(platform = process.platform, env = process.env) {
  const oldDir = stateDir(platform, env, LEGACY_SLUG);
  const newDir = stateDir(platform, env);
  try {
    if (!fs.existsSync(oldDir) || fs.existsSync(newDir)) return false;
    fs.renameSync(oldDir, newDir);
    const oldLog = path.join(newDir, `${LEGACY_SLUG}.log`);
    if (fs.existsSync(oldLog)) fs.renameSync(oldLog, path.join(newDir, `${APP_SLUG}.log`));
    return true;
  } catch {
    return false;
  }
}
