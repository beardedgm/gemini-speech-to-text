// Gemini Speech to Text tray app: dictation engine + tray icon + Settings window.

// Must stay the first import: repairs stdout/stderr before any dependency touches them.
import { replaced as replacedStdio } from '../src/stdio-guard.js';
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, Notification, safeStorage, session, shell, Tray } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configProblem, loadConfig } from '../src/config.js';
import { DictationService } from '../src/engine.js';
import { levelFrame } from '../src/micmonitor.js';
import { DEFAULT_MIC, isDefaultMic, micFromEnv } from '../src/mics.js';
import { testAllMicrophones, testMicrophone } from '../src/mictest.js';
import { checkKey } from '../src/gemini.js';
import { parseHotkey } from '../src/hotkey.js';
import { hotkeyIssues, recordShortcut } from '../src/hotkeyrecord.js';
import { loadPlatform } from '../src/platform/index.js';
import { APP_NAME, APP_SLUG, migrateLegacyStateDir } from '../src/names.js';
import { migrateFromFlowcode } from './migrate.js';
import { RendererCapture } from './rendercapture.js';
import { mergeConfig, SettingsStore, validMic } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');

// Only one copy may run. A second launch (e.g. from the app menu while the
// tray app is already running) must exit right away: app.quit() is async, and
// the second copy used to start its own engine first, briefly listening to
// the keyboard alongside the first (double handling) or failing with
// "No keyboards found" while shutting down.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.exit(0);

// Development fallback: the repo's .env (GEMINI_API_KEY / VOICE_DEV_GEMINI_KEY, GSTT_* or legacy FLOWCODE_*).
if (!app.isPackaged && fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

let tray, store, platform, service, settingsWin, logFile;
let state = 'idle';
let lastError = null;
let recording = null; // { promise, cancel } while Settings records a new hotkey
let micWarning = null; // message while the mic isn't hearing anything during a hold
let capture = null; // Windows: hidden getUserMedia capture window (RendererCapture)
let captureWin = null;
let captureFailed = null; // why it couldn't be used (ffmpeg is used instead)
let captureTries = 0;

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

// Only touch the tray image when it actually changes: each change is a D-Bus
// round trip to the panel (StatusNotifierItem on Linux).
let currentIcon = null;
function setTrayIcon(name) {
  if (!tray || currentIcon === name) return;
  currentIcon = name;
  tray.setImage(icon(name));
}

// Live level meter while recording, at most ~10 updates per second.
const LEVEL_FRAMES = 6;
const LEVEL_INTERVAL_MS = 100;
let lastLevelAt = 0;
function showLevel(db) {
  if (state !== 'recording' || micWarning) return;
  const now = Date.now();
  if (now - lastLevelAt < LEVEL_INTERVAL_MS) return;
  lastLevelAt = now;
  setTrayIcon(`level-${levelFrame(db, LEVEL_FRAMES)}`);
}

function stateIcon(shown) {
  if (shown === 'recording') return micWarning ? 'mic-off' : 'level-0';
  return shown === 'setup' || shown === 'error' ? 'working' : shown;
}

function refreshTray() {
  if (!tray) return;
  const config = currentConfig();
  const shown = configProblem(config) ? 'setup' : state;
  setTrayIcon(stateIcon(shown));
  const status = micWarning && shown === 'recording' ? 'Microphone not hearing you!' : STATE_LABEL[shown];
  tray.setToolTip(`${APP_NAME}: ${status}${shown === 'idle' ? ` (hold ${config.hotkey})` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${APP_NAME}: ${status}`, enabled: false },
    ...(lastError ? [{ label: lastError.slice(0, 80), enabled: false }] : []),
    { label: `Hold ${config.hotkey} to dictate`, enabled: false },
    { type: 'separator' },
    {
      label: 'Retry last dictation',
      enabled: Boolean(service?.canRetry) && state === 'idle',
      click: () => service?.retryLast(),
    },
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
    {
      label: 'Sounds',
      submenu: [
        { label: 'When recording starts', type: 'checkbox', checked: config.soundStart, click: (i) => { store.update({ soundStart: i.checked }); restartService(); } },
        { label: 'When text is pasted', type: 'checkbox', checked: config.soundDone, click: (i) => { store.update({ soundDone: i.checked }); restartService(); } },
      ],
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
  if (s !== 'recording') micWarning = null;
  refreshTray();
}

// --- engine -------------------------------------------------------------------

// On Windows, Electron's clipboard is far faster than PowerShell. On Linux,
// wl-copy/xclip keep working without a focused window, so keep them.
// Windows: capture in the hidden renderer (fast start, follows the Windows
// default device); ffmpeg/DirectShow only if that window can't start.
function micPlatform(p) {
  if (p.name !== 'windows' || !capture || captureFailed) return p;
  return { ...p, createRecorder: () => capture.createRecorder() };
}

function platformForApp(p) {
  p = micPlatform(p);
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
  await prepareCapture(config);
  service = new DictationService(config, platformForApp(platform));
  service.on('log', log);
  service.on('debug', (m) => config.debug && log(`[debug] ${m}`));
  service.on('state', setState);
  service.on('error', (m) => {
    lastError = m;
    refreshTray();
    if (config.notify && Notification.isSupported()) new Notification({ title: APP_NAME, body: m, silent: true }).show();
  });
  service.on('level', showLevel);
  service.on('mic-warning', ({ message }) => {
    micWarning = message;
    refreshTray();
    // Shown even with notifications off: this is about losing what you're saying right now.
    if (Notification.isSupported()) new Notification({ title: 'Microphone not hearing you', body: message, silent: true, urgency: 'critical' }).show();
  });
  service.on('mic-ok', () => { micWarning = null; refreshTray(); });
  // The chosen mic wasn't there: say which one was used instead.
  service.on('mic-fallback', ({ message }) => {
    if (Notification.isSupported()) new Notification({ title: 'Using a different microphone', body: message, silent: true }).show();
  });
  service.on('retry-available', refreshTray);
  try {
    await service.start();
  } catch (e) {
    log(`Could not start: ${e.message}`);
    lastError = e.message;
    service = null;
  }
  refreshTray();
}

// Serialized: two restarts at once (e.g. a Settings save while the capture
// window restarts) must not leave two services listening.
let restarting = Promise.resolve();
function restartService() {
  restarting = restarting.catch(() => {}).then(async () => {
    const old = service;
    service = null;
    await old?.stop();
    state = 'idle';
    await startService();
  });
  return restarting;
}

// --- microphone capture (Windows) ---------------------------------------------------

function createCaptureWindow() {
  const ses = session.fromPartition('persist:capture');
  const isCapture = (wc) => Boolean(wc && captureWin && wc.id === captureWin.webContents.id);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(isCapture(wc) && permission === 'media' && !(details?.mediaTypes ?? []).includes('video'));
  });
  ses.setPermissionCheckHandler((wc, permission) => isCapture(wc) && permission === 'media');
  captureWin = new BrowserWindow({
    show: false, width: 200, height: 100, skipTaskbar: true, focusable: false,
    webPreferences: {
      preload: path.join(ROOT, 'app', 'capture-preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, backgroundThrottling: false, partition: 'persist:capture',
    },
  });
  captureWin.webContents.on('render-process-gone', (_e, d) => {
    log(`Microphone capture window stopped (${d.reason}); restarting it.`);
    capture?.destroy();
    capture = null;
    captureWin = null;
    restartService();
  });
  captureWin.loadFile(path.join(ROOT, 'app', 'capture.html'));
  return { send: (cmd) => captureWin?.webContents.send('cap:command', cmd), destroy: () => captureWin?.destroy() };
}

async function prepareCapture(config) {
  if (platform.name !== 'windows' || captureFailed) return;
  if (!capture) {
    capture = new RendererCapture({ createWindow: createCaptureWindow });
    capture.on('devices-changed', (listing) => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('mics:changed', listing);
    });
    const t0 = Date.now();
    if (!(await capture.ready())) {
      const why = capture.error || 'no response';
      capture.destroy();
      capture = null;
      captureWin = null;
      captureTries++;
      if (captureTries < 2) { log(`Microphone capture window didn't start (${why}); trying once more.`); return prepareCapture(config); }
      captureFailed = why;
      log(`Microphone capture window didn't start (${why}); using ffmpeg instead.`);
      return;
    }
    log(`Microphone capture ready in ${Date.now() - t0} ms: ${capture.devices.map((d) => d.name).join(', ') || 'no mics found'}${capture.defaultName ? ` (default ${capture.defaultName})` : ''}.`);
  }
  // GSTT_MIC may hold a DirectShow id ("@device_cm_..."): learn its name.
  const pin = config.mic;
  if (pin && !isDefaultMic(pin) && /^@device/i.test(pin.id) && !capture.aliases.has(pin.id)) {
    const listing = await platform.listMicrophones().catch(() => null);
    const d = listing?.devices.find((x) => x.id === pin.id);
    if (d) capture.aliases.set(pin.id, d.name);
  }
}

// What Settings shows: the mics now, the current default, the saved choice
// and whether GSTT_MIC is set (so it's never a hidden pin).
async function micListing() {
  const listing = capture ? capture.listing() : await platform.listMicrophones().catch(() => ({ devices: [], defaultName: null }));
  const env = micFromEnv();
  const saved = validMic(store.settings.mic) ? store.settings.mic : null;
  let envName = null;
  if (env) envName = capture?.aliases.get(env.id) ?? listing.devices.find((d) => d.id === env.id)?.name ?? env.name;
  return {
    ...listing,
    chosen: saved ?? (env ? { id: env.id, name: envName } : DEFAULT_MIC),
    env: env ? { value: env.id, name: envName, overridden: Boolean(saved) } : null,
    platform: platform.name,
    usingFfmpeg: platform.name === 'windows' && !capture,
  };
}

async function testMic(mic, onLevel) {
  if (capture) return capture.test(mic, { seconds: 3, onLevel });
  return testMicrophone(platform, mic, { seconds: 3, onLevel });
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
    width: 560, height: 900, resizable: true, title: `${APP_NAME} Settings`,
    icon: path.join(ASSETS, 'icon.png'), autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(ROOT, 'app', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  settingsWin.loadFile(path.join(ROOT, 'app', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; recording?.cancel(); });
}

function registerIpc() {
  ipcMain.handle('settings:get', () => {
    const config = currentConfig();
    return {
      mode: config.mode, hotkey: config.hotkey, silenceDb: config.silenceDb,
      soundStart: config.soundStart, soundDone: config.soundDone,
      startAtLogin: isStartAtLogin(), hasKey: Boolean(config.apiKey),
      keySource: keySource(), keyProtection: store.keyProtection(),
    };
  });

  ipcMain.handle('settings:save', async (_e, v) => {
    try {
      if (!['live', 'oneshot'].includes(v.mode)) throw new Error('Pick a mode.');
      const { errors } = hotkeyIssues(String(v.hotkey ?? ''), hotkeyCheckOptions());
      if (errors.length) throw new Error(errors[0]);
      if (!Number.isFinite(v.silenceDb) || v.silenceDb > -10 || v.silenceDb < -70) throw new Error('Silence cutoff must be between -70 and -10.');
      if (v.apiKey) store.setApiKey(v.apiKey);
      store.update({ mode: v.mode, hotkey: v.hotkey.split('+').map((k) => k.trim().toUpperCase()).join('+'), silenceDb: v.silenceDb, soundStart: Boolean(v.soundStart), soundDone: Boolean(v.soundDone) });
      if (v.startAtLogin !== isStartAtLogin()) setStartAtLogin(v.startAtLogin);
      if (v.mic !== undefined) {
        if (!validMic(v.mic)) throw new Error('Pick a microphone.');
        store.update({ mic: { id: String(v.mic.id), name: String(v.mic.name ?? v.mic.id) } });
      }
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

  ipcMain.handle('mics:list', () => micListing());
  ipcMain.handle('mics:test', async (e, mic) => {
    const send = (db) => { if (!e.sender.isDestroyed()) e.sender.send('mics:level', mic?.id ?? 'default', db); };
    try { return await testMic(mic ?? DEFAULT_MIC, send); } catch (err) { return { ok: false, kind: 'open-failed', text: `Couldn't open it: ${err.message}` }; }
  });
  ipcMain.handle('mics:test-all', async (e) => {
    const send = (id, db) => { if (!e.sender.isDestroyed()) e.sender.send('mics:level', id, db); };
    try {
      if (capture) return await capture.testAll({ seconds: 3, onLevel: send });
      return await testAllMicrophones(platform, { seconds: 3 });
    } catch {
      return [];
    }
  });

  ipcMain.handle('hotkey:check', (_e, spec) => hotkeyIssues(String(spec ?? ''), hotkeyCheckOptions()));

  // Record a new hotkey: dictation is paused so the keys pressed here can't
  // start a recording, then the next chord pressed anywhere is captured by the
  // same listener dictation uses (raw evdev / the Windows hook), so Super/Win
  // is seen even when the desktop grabs it first.
  ipcMain.handle('hotkey:record', async () => {
    if (recording) return { ok: false, error: 'Already recording a hotkey.' };
    const old = service;
    service = null;
    await old?.stop();
    state = 'idle';
    refreshTray();
    try {
      // Listening "for" Super makes the platform layer suppress the Launcher /
      // Start menu while Super is held, exactly as during dictation.
      const listener = platform.createHotkey(parseHotkey('SUPER'), { onWarn: log });
      recording = recordShortcut(listener, { platform: platform.name });
      const r = await recording.promise;
      if (r.spec) log(`Recorded hotkey ${r.spec}`);
      return r.spec ? { ok: true, spec: r.spec, issues: hotkeyIssues(r.spec, hotkeyCheckOptions()) } : { ok: !r.error, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      recording = null;
      await startService();
    }
  });

  ipcMain.handle('hotkey:cancel', () => { recording?.cancel(); });
}

function hotkeyCheckOptions() {
  return { platform: platform.name, detectable: platform.DETECTABLE_KEYS ?? null };
}

// --- lifecycle ---------------------------------------------------------------------

// Log unexpected errors instead of showing Electron's crash dialog; the tray
// app should keep running (a failed dictation is reported via notification).
process.on('uncaughtException', (err) => log(`Unexpected error: ${err?.stack || err}`));
process.on('unhandledRejection', (err) => log(`Unhandled rejection: ${err?.stack || err}`));

app.on('second-instance', openSettings);
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => { service?.stop(); capture?.destroy(); });

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;
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
  ipcMain.on('cap:event', (e, msg) => { if (captureWin && e.sender.id === captureWin.webContents.id) capture?.onEvent(msg); });
  ipcMain.on('cap:chunk', (e, id, bytes) => { if (captureWin && e.sender.id === captureWin.webContents.id) capture?.onChunk(id, bytes); });

  tray = new Tray(icon('idle'));
  tray.on('click', openSettings);
  refreshTray();

  await startService();
  if (configProblem(currentConfig())) openSettings(); // first run: ask for the key
});
