// Settings from environment variables (.env for development).

import path from 'node:path';
import { DEFAULT_CLEANUP_MODEL, DEFAULT_MODEL } from './gemini.js';
import { DEFAULT_LIVE_MODEL } from './live.js';

export function loadConfig(env = process.env, root = process.cwd()) {
  return {
    // VOICE_DEV_GEMINI_KEY is accepted so an existing voice-dev .env works unchanged.
    apiKey: env.GEMINI_API_KEY || env.VOICE_DEV_GEMINI_KEY,
    model: env.GEMINI_MODEL || DEFAULT_MODEL,
    // live (default): stream while held, then clean up the transcript; falls back to oneshot on failure.
    // oneshot: send the whole clip on release.
    mode: (env.FLOWCODE_MODE || 'live').toLowerCase(),
    liveModel: env.FLOWCODE_LIVE_MODEL || DEFAULT_LIVE_MODEL,
    // Text-only cleanup of the live transcript.
    cleanupModel: env.FLOWCODE_CLEANUP_MODEL || DEFAULT_CLEANUP_MODEL,
    // Hold both (either side), like Flow's Ctrl+Win.
    hotkey: env.FLOWCODE_HOTKEY || 'CTRL+SUPER',
    dictionary: path.resolve(root, env.FLOWCODE_DICTIONARY || 'dictionary.txt'),
    restore: env.FLOWCODE_RESTORE_CLIPBOARD !== '0',
    minSeconds: 0.3,
    // Skip clips whose loudest 50 ms is quieter than this (dBFS).
    silenceDb: Number(env.FLOWCODE_SILENCE_DB ?? -40),
    debug: env.FLOWCODE_DEBUG === '1',
    notify: env.FLOWCODE_NOTIFY !== '0',
    // Do everything except the paste (for testing).
    dryRun: env.FLOWCODE_DRY_RUN === '1',
  };
}

export function configProblem(config) {
  if (!config.apiKey) return 'No Gemini API key set.';
  if (!['oneshot', 'live'].includes(config.mode)) return `Mode must be "oneshot" or "live", not "${config.mode}".`;
  return null;
}
