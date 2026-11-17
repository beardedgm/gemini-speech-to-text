// "Press your shortcut" support for Settings: turn key events into a hotkey
// spec, and check a spec for keys that can't work or clash with the system.

import { KEY_CODES, KEY_F24, KEY_GROUPS, keyName, parseHotkey } from './hotkey.js';

// Modifiers are recorded side-agnostic ("CTRL", not "KEY_LEFTCTRL"), in this order.
const MODIFIERS = ['CTRL', 'SHIFT', 'ALT', 'SUPER'];
const MODIFIER_OF = new Map(MODIFIERS.flatMap((m) => KEY_GROUPS[m].map((c) => [c, m])));
const NAME_OF = new Map(Object.entries(KEY_CODES).map(([k, v]) => [v, k.slice(4)]));
const TYPING = new Set(Object.entries(KEY_CODES).filter(([k]) => /^KEY_[A-Z0-9]$/.test(k) || k === 'KEY_SPACE').map(([, v]) => v));

const LABELS = { CTRL: 'Ctrl', SHIFT: 'Shift', ALT: 'Alt', SUPER: 'Super', ESC: 'Esc', SPACE: 'Space', CAPSLOCK: 'Caps Lock', SCROLLLOCK: 'Scroll Lock', DELETE: 'Delete', TAB: 'Tab', PAUSE: 'Pause', COMPOSE: 'Menu' };
const label = (part, platform) => (part === 'SUPER' && platform === 'windows' ? 'Win' : LABELS[part] ?? part.replace(/^KEY_/, ''));

// Collects one chord: every key pressed until all keys are released again.
export class ShortcutRecorder {
  constructor() {
    this.held = new Set();
    this.chord = new Set();
  }

  // value: 1 = press, 0 = release, 2 = autorepeat. Returns the chord's codes
  // once every key is up again, otherwise null.
  feed(code, value) {
    if (value === 2 || code === KEY_F24) return null;
    if (value === 1) {
      this.held.add(code);
      this.chord.add(code);
    } else if (value === 0 && this.held.delete(code) && this.held.size === 0 && this.chord.size) {
      const codes = [...this.chord];
      this.chord.clear();
      return codes;
    }
    return null;
  }
}

// Codes from ShortcutRecorder -> "CTRL+SUPER". Unnamed keys -> { error }.
export function specFromCodes(codes, platform = 'linux') {
  const mods = new Set();
  const others = [];
  for (const c of codes) {
    if (MODIFIER_OF.has(c)) mods.add(MODIFIER_OF.get(c));
    else if (NAME_OF.has(c)) { if (!others.includes(NAME_OF.get(c))) others.push(NAME_OF.get(c)); }
    else return { error: `That key (${platform === 'windows' ? 'unrecognized' : keyName(c)}) can't be part of the hotkey. Use Ctrl, Shift, Alt, ${label('SUPER', platform)}, letters, digits, F1–F23, Space, Tab, Esc, Caps Lock or Scroll Lock.` };
  }
  const parts = [...MODIFIERS.filter((m) => mods.has(m)), ...others];
  return { spec: parts.join('+') };
}

// Problems with a hotkey spec on this platform. errors block saving;
// warnings are shown but the user may keep the hotkey.
// detectable: the evdev codes the platform's key listener can report (null = all).
export function hotkeyIssues(spec, { platform = 'linux', detectable = null } = {}) {
  const errors = [];
  const warnings = [];
  if (!spec.trim()) return { errors: ['Enter or record a hotkey.'], warnings };
  let groups;
  try {
    groups = parseHotkey(spec);
  } catch (e) {
    return { errors: [e.message], warnings };
  }
  if (detectable) {
    const missing = groups.filter((g) => !g.some((c) => detectable.has(c)));
    for (const g of missing) errors.push(`${label(NAME_OF.get(g[0]) ?? keyName(g[0]), platform)} can't be detected on Windows. Pick another key.`);
  }

  const has = (name) => {
    const want = KEY_GROUPS[name] ?? [KEY_CODES[`KEY_${name}`]];
    return groups.some((g) => g.some((c) => want.includes(c)));
  };
  const only = (...names) => groups.length === names.length && names.every(has);
  const win = platform === 'windows';

  if (only('SUPER')) warnings.push(`${label('SUPER', platform)} on its own also starts a short recording every time you use a ${label('SUPER', platform)} shortcut.`);
  if (has('ALT') && has('TAB')) warnings.push(`Alt+Tab switches windows, so holding it will also switch apps.`);
  if (has('CTRL') && has('ALT') && has('DELETE')) warnings.push(`Ctrl+Alt+Delete is handled by the system first${win ? ' (it opens the security screen)' : ''}.`);
  if (has('CTRL') && has('SHIFT') && has('ESC')) warnings.push(`Ctrl+Shift+Esc opens the ${win ? 'Task Manager' : 'system monitor on some desktops'}.`);
  if (win && has('SUPER') && has('H')) warnings.push('Win+H opens Windows voice typing at the same time.');
  const typing = groups.filter((g) => g.some((c) => TYPING.has(c)));
  if (typing.length) {
    const keys = typing.map((g) => label(NAME_OF.get(g[0]), platform)).join(', ');
    warnings.push(typing.length === groups.length
      ? `Holding ${keys} types it into the app you're in.`
      : `The app you're in also receives ${keys}, which may trigger one of its shortcuts.`);
  }
  return { errors, warnings };
}

// Listens on a started HoldToTalk-style listener (emits 'key' code, value)
// until one chord is pressed and released. Esc on its own cancels.
// Resolves { spec } | { error } | { cancelled: true }; the listener is stopped
// before the promise settles.
export function recordShortcut(listener, { platform = 'linux', timeoutMs = 15000 } = {}) {
  const rec = new ShortcutRecorder();
  let finish;
  const promise = new Promise((resolve) => {
    let done = false;
    finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      listener.off?.('key', onKey);
      try { listener.stop(); } catch { /* already stopped */ }
      resolve(result);
    };
    const onKey = (code, value) => {
      const codes = rec.feed(code, value);
      if (!codes) return;
      if (codes.length === 1 && codes[0] === KEY_CODES.KEY_ESC) return finish({ cancelled: true });
      finish(specFromCodes(codes, platform));
    };
    const timer = setTimeout(() => finish({ cancelled: true, timedOut: true }), timeoutMs);
    timer.unref?.();
    listener.on('key', onKey);
    listener.on('error', (e) => finish({ error: e.message }));
    try { listener.start(); } catch (e) { finish({ error: e.message }); }
  });
  return { promise, cancel: () => finish({ cancelled: true }) };
}
