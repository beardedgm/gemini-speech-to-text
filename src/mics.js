// Microphone choice, shared by every capture path (Windows renderer, ffmpeg,
// PipeWire). A choice is { id, name }: id is stable for the platform (Chromium
// deviceId, dshow alternative name, PipeWire node name), name is what people
// see and the fallback match when the id changes. id 'default' means "whatever
// the system's default input is at the moment a dictation starts".

import { envSetting } from './names.js';

export const DEFAULT_MIC_ID = 'default';
export const DEFAULT_MIC = Object.freeze({ id: DEFAULT_MIC_ID, name: 'System default' });

export function isDefaultMic(mic) {
  return !mic || !mic.id || mic.id === DEFAULT_MIC_ID;
}

// GSTT_MIC (legacy FLOWCODE_MIC) as a choice. It can be a display name or an
// id (dshow "@device_..." moniker, PipeWire node name or serial).
export function micFromEnv(env = process.env) {
  const v = envSetting(env, 'MIC');
  return v ? { id: v, name: v, fromEnv: true } : null;
}

// "Microphone (Elgato Wave:3) (0fd9:0070)" -> "Microphone (Elgato Wave:3)":
// Chromium appends the USB vendor:product id to labels.
export function cleanLabel(label = '') {
  return String(label).replace(/\s+\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim();
}

// devices: [{ id, name, altIds?: [] }] as listed now (no 'default' entry).
// wanted: a choice or null. Returns { device, fallback }:
//   device   - the device to open, or null for the system default
//   fallback - null, or { wanted, reason } when the wanted mic isn't there
export function resolveMic(devices, wanted) {
  if (isDefaultMic(wanted)) return { device: null, fallback: null };
  const byId = devices.find((d) => d.id === wanted.id || d.altIds?.includes(wanted.id));
  if (byId) return { device: byId, fallback: null };
  // Ids can change (another profile, driver reinstall); names rarely do.
  const want = cleanLabel(wanted.name).toLowerCase();
  const byName = want && devices.find((d) => cleanLabel(d.name).toLowerCase() === want);
  if (byName) return { device: byName, fallback: null };
  return { device: null, fallback: { wanted, reason: 'not connected' } };
}

// One line for the notification after falling back, e.g.
// "Microphone (Elgato Wave:3) isn't connected, so System default (Microphone (Realtek(R) Audio)) was used."
export function fallbackMessage(fallback, usedName) {
  const wanted = cleanLabel(fallback.wanted?.name) || 'The chosen microphone';
  const why = fallback.reason === 'not connected' ? "isn't connected" : `couldn't be opened (${fallback.reason})`;
  return `${wanted} ${why}, so ${usedName ? `System default (${cleanLabel(usedName)})` : 'the system default'} was used.`;
}

// Plain verdict for the Test button from the loudest level heard (dBFS) and
// whether any audio arrived at all.
export const TEST_FLOOR_DB = -70; // same floor MicMonitor uses for "not hearing anything"
export const TEST_SPEECH_DB = -45; // loudest 50 ms of normal speech is well above this
export function testVerdict({ error, bytes, maxDb }) {
  if (error) return { ok: false, kind: 'open-failed', text: `Couldn't open it: ${error}` };
  if (!bytes) return { ok: false, kind: 'no-data', text: 'No sound from this mic (it sent no audio at all)' };
  if (maxDb === -Infinity) return { ok: false, kind: 'silent', text: 'No sound from this mic (exact silence: muted?)' };
  if (maxDb < TEST_FLOOR_DB) return { ok: false, kind: 'too-quiet', text: 'No sound from this mic (barely anything: muted or turned down?)' };
  if (maxDb < TEST_SPEECH_DB) return { ok: true, kind: 'quiet', text: 'Sending sound, but only quiet background noise: talk while it tests' };
  return { ok: true, kind: 'ok', text: 'Hearing you' };
}
