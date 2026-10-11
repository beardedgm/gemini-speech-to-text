// Gemini Speech to Text tray app: dictation engine + tray icon + Settings window.

// Must stay the first import: repairs stdout/stderr before any dependency touches them.
import { replaced as replacedStdio } from '../src/stdio-guard.js';
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, Tray } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configProblem, loadConfig } from '../src/config.js';
import { DictationService } from '../src/engine.js';
import { checkKey } from '../src/gemini.js';
import { parseHotkey } from '../src/hotkey.js';
import { loadPlatform } from '../src/platform/index.js';
import { APP_NAME, APP_SLUG, migrateLegacyStateDir } from '../src/names.js';
import { migrateFromFlowcode } from './migrate.js';
import { mergeConfig, SettingsStore } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');

if (!app.requestSingleInstanceLock()) app.quit();

// Development fallback: the repo's .env (GEMINI_API_KEY / VOICE_DEV_GEMINI_KEY, GSTT_* or legacy FLOWCODE_*).
if (!app.isPackaged && fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

let tray, store, platform, service, settingsWin, logFile;
let state = 'idle';
let lastError = null;

function log(msg, { private: isPrivate = false } = {}) {
  try { console.log(new Date().toLocaleTimeString(), msg); } catch { /* no usable stdout */ }
  if (!logFile) return;
  const line = isPrivate ? msg.replace(/: [\s\S]*$/, ': [text omitted]') : msg;
  try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch { /* best effort */ }
}

function currentConfig() {
  const env = loadConfig(process.env, app.getPath('userData'));
  return mergeConfig(env, store.settings, store.getApiKey());
}

function keySource() {
  if (store.hasApiKey() && store.getApiKey()) return 'keychain';
  return loadConfig(process.env).apiKey ? 'env' : 'none';
}

// --- tray ---------------------------------------------------------------------

const icons = {};
function icon(s) {
  icons[s] ??= nativeImage.createFromPath(path.join(ASSETS, `tray-${s}.png`));
  return icons[s];
}

const STATE_LABEL = { idle: 'Ready', recording: 'Recording…', working: 'Transcribing…', setup: 'Needs setup', error: 'Error' };

function refreshTray() {
  if (!tray) return;
  const config = currentConfig();
  const shown = configProblem(config) ? 'setup' : state;
  tray.setImage(icon(shown === 'setup' || shown === 'error' ? 'working' : shown));
  tray.setToolTip(`${APP_NAME}: ${STATE_LABEL[shown]}${shown === 'idle' ? ` (hold ${config.hotkey})` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${APP_NAME}: ${STATE_LABEL[shown]}`, enabled: false },
    ...(lastError ? [{ label: lastError.slice(0, 80), enabled: false }] : []),
    { label: `Hold ${config.hotkey} to dictate`, enabled: false },
    { type: 'separator' },
    {
      label: 'Mode',
      submenu: ['live', 'oneshot'].map((m) => ({
        label: m === 'live' ? 'Live (fastest)' : 'One-shot',
        type: 'radio',
        checked: config.mode === m,
        click: () => { store.update({ mode: m }); restartService(); },
      })),
    },
    { label: 'Settings…', click: openSettings },
    { label: 'Start at login', type: 'checkbox', checked: isStartAtLogin(), click: (i) => setStartAtLogin(i.checked) },
    { label: 'Open log', click: () => shell.openPath(logFile) },
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, click: () => app.quit() },
  ]));
}

function setState(s) {
  state = s;
  if (s !== 'idle') lastError = null;
  refreshTray();
}

// --- engine -------------------------------------------------------------------

// On Windows, Electron's clipboard is far faster than PowerShell. On Linux,
// wl-copy/xclip keep working without a focused window, so keep them.
function platformForApp(p) {
  if (p.name !== 'windows') return p;
  const electronClipboard = {
    read: async () => (clipboard.availableFormats().some((f) => f.startsWith('text/')) ? clipboard.readText() : null),
    write: async (t) => clipboard.writeText(t),
    pasteKeys: p.windowsClipboard.pasteKeys,
  };
  return { ...p, pasteText: (text, opts) => p.pasteText(text, { ...opts, backend: electronClipboard }) };
}

async function startService() {
  const config = currentConfig();
  const problem = configProblem(config);
  if (problem) {
    log(`Not started: ${problem}`);
    refreshTray();
    return;
  }
  service = new DictationService(config, platformForApp(platform));
  service.on('log', log);
  service.on('debug', (m) => config.debug && log(`[debug] ${m}`));
  service.on('state', setState);
  service.on('error', (m) => {
    lastError = m;
    refreshTray();
    if (config.notify && Notification.isSupported()) new Notification({ title: APP_NAME, body: m, silent: true }).show();
  });
  try {
    await service.start();
  } catch (e) {
    log(`Could not start: ${e.message}`);
    lastError = e.message;
    service = null;
  }
  refreshTray();
}

async function restartService() {
  const old = service;
  service = null;
  await old?.stop();
  state = 'idle';
  await startService();
}

// --- start at login -------------------------------------------------------------

const AUTOSTART = path.join(os.homedir(), '.config', 'autostart', `${APP_SLUG}.desktop`);

function launchCommand() {
  // AppImage sets APPIMAGE; .deb installs a real executable; dev runs electron + app dir.
  if (process.env.APPIMAGE) return `"${process.env.APPIMAGE}"`;
  if (app.isPackaged) return `"${process.execPath}"`;
  return `"${process.execPath}" "${ROOT}"`;
}

function isStartAtLogin() {
  if (process.platform === 'linux') return fs.existsSync(AUTOSTART);
  return app.getLoginItemSettings().openAtLogin;
}

function setStartAtLogin(on) {
  if (process.platform === 'linux') {
    if (on) {
      fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true });
      fs.writeFileSync(AUTOSTART, [
        '[Desktop Entry]', 'Type=Application', `Name=${APP_NAME}`, 'Comment=Hold-to-talk dictation with Gemini',
        `Exec=${launchCommand()}`, 'X-GNOME-Autostart-enabled=true', '',
      ].join('\n'));
    } else {
      fs.rmSync(AUTOSTART, { force: true });
    }
  } else {
    app.setLoginItemSettings({ openAtLogin: on });
  }
  store.update({ startAtLogin: on });
  refreshTray();
}

// --- settings window ---------------------------------------------------------------

function openSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 560, height: 720, resizable: true, title: `${APP_NAME} Settings`,
    icon: path.join(ASSETS, 'icon.png'), autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(ROOT, 'app', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  settingsWin.loadFile(path.join(ROOT, 'app', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}

function registerIpc() {
  ipcMain.handle('settings:get', () => {
    const config = currentConfig();
    return {
      mode: config.mode, hotkey: config.hotkey, silenceDb: config.silenceDb,
      startAtLogin: isStartAtLogin(), hasKey: Boolean(config.apiKey),
      keySource: keySource(), keyProtection: store.keyProtection(),
    };
  });

  ipcMain.handle('settings:save', async (_e, v) => {
    try {
      if (!['live', 'oneshot'].includes(v.mode)) throw new Error('Pick a mode.');
      parseHotkey(v.hotkey); // throws on unknown keys
      if (!Number.isFinite(v.silenceDb) || v.silenceDb > -10 || v.silenceDb < -70) throw new Error('Silence cutoff must be between -70 and -10.');
      if (v.apiKey) store.setApiKey(v.apiKey);
      store.update({ mode: v.mode, hotkey: v.hotkey.toUpperCase(), silenceDb: v.silenceDb });
      if (v.startAtLogin !== isStartAtLogin()) setStartAtLogin(v.startAtLogin);
      await restartService();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('settings:test-key', async (_e, key) => {
    try {
      const model = await checkKey(key || currentConfig().apiKey);
      return { ok: true, model };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('settings:clear-key', async () => {
    store.clearApiKey();
    await restartService();
    return { ok: true };
  });

  ipcMain.handle('settings:close', () => settingsWin?.close());
}

// --- lifecycle ---------------------------------------------------------------------

// Log unexpected errors instead of showing Electron's crash dialog; the tray
// app should keep running (a failed dictation is reported via notification).
process.on('uncaughtException', (err) => log(`Unexpected error: ${err?.stack || err}`));
process.on('unhandledRejection', (err) => log(`Unhandled rejection: ${err?.stack || err}`));

app.on('second-instance', openSettings);
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => { service?.stop(); });

app.whenReady().then(async () => {
  migrateLegacyStateDir(); // ~/.local/state/flowcode -> new name (log)
  store = new SettingsStore(app.getPath('userData'), safeStorage);
  platform = await loadPlatform();
  logFile = path.join(platform.logDir(), `${APP_SLUG}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const migrated = migrateFromFlowcode({ store, appDataDir: app.getPath('appData') });
  if (migrated.length) log(`Carried over from flowcode: ${migrated.join(', ')}.`);
  if (store.data.startAtLogin && !isStartAtLogin()) setStartAtLogin(true);
  if (replacedStdio.length) log(`No usable ${replacedStdio.join('/')} (started without a terminal); console output goes to this log.`);
  registerIpc();

  tray = new Tray(icon('idle'));
  tray.on('click', openSettings);
  refreshTray();

  await startService();
  if (configProblem(currentConfig())) openSettings(); // first run: ask for the key
});
