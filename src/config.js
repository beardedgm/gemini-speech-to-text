// Settings from environment variables (.env for development).

import path from 'node:path';
import { DEFAULT_CLEANUP_MODEL, DEFAULT_MODEL } from './gemini.js';
import { DEFAULT_LIVE_MODEL } from './live.js';
import { envSetting } from './names.js';

export function loadConfig(env = process.env, root = process.cwd()) {
  const get = (name) => envSetting(env, name); // GSTT_name, or legacy FLOWCODE_name
  return {
    // VOICE_DEV_GEMINI_KEY is accepted so an existing voice-dev .env works unchanged.
    apiKey: env.GEMINI_API_KEY || env.VOICE_DEV_GEMINI_KEY,
    model: env.GEMINI_MODEL || DEFAULT_MODEL,
    // live (default): stream while held, then clean up the transcript; falls back to oneshot on failure.
    // oneshot: send the whole clip on release.
    mode: (get('MODE') || 'live').toLowerCase(),
    liveModel: get('LIVE_MODEL') || DEFAULT_LIVE_MODEL,
    // Text-only cleanup of the live transcript.
    cleanupModel: get('CLEANUP_MODEL') || DEFAULT_CLEANUP_MODEL,
    // Hold both (either side), like Flow's Ctrl+Win.
    hotkey: get('HOTKEY') || 'CTRL+SUPER',
    dictionary: path.resolve(root, get('DICTIONARY') || 'dictionary.txt'),
    restore: get('RESTORE_CLIPBOARD') !== '0',
    minSeconds: 0.3,
    // Skip clips whose loudest 50 ms is quieter than this (dBFS).
    silenceDb: Number(get('SILENCE_DB') ?? -40),
    debug: get('DEBUG') === '1',
    notify: get('NOTIFY') !== '0',
    // Sounds: start of recording, and after the text is pasted. On unless set to 0.
    soundStart: get('SOUND_START') !== '0',
    soundDone: get('SOUND_DONE') !== '0',
    // Do everything except the paste (for testing).
    dryRun: get('DRY_RUN') === '1',
  };
}

export function configProblem(config) {
  if (!config.apiKey) return 'No Gemini API key set.';
  if (!['oneshot', 'live'].includes(config.mode)) return `Mode must be "oneshot" or "live", not "${config.mode}".`;
  return null;
}
