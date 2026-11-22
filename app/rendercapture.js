// Main-process side of the hidden capture window (app/capture.html): keeps
// the current device list, opens/closes capture sessions, and provides a
// Recorder-compatible object for DictationService plus the Settings mic test.
//
// Electron-free except for the window factory passed in, so it can be tested.

import { EventEmitter } from 'node:events';
import { chunkLevelDb } from '../src/micmonitor.js';
import { DEFAULT_MIC_ID, isDefaultMic, resolveMic, testVerdict } from '../src/mics.js';

export class RendererCapture extends EventEmitter {
  // createWindow() -> { send(cmd), destroy() }; the caller routes the
  // window's 'cap:event' / 'cap:chunk' messages to onEvent / onChunk.
  // aliases: Map of other ids for a mic name (e.g. dshow "@device_..." ids
  // from GSTT_MIC) -> friendly name.
  constructor({ createWindow, readyTimeoutMs = 8000 }) {
    super();
    this.createWindow = createWindow;
    this.readyTimeoutMs = readyTimeoutMs;
    this.devices = [];
    this.defaultName = null;
    this.aliases = new Map();
    this.nextSession = 1;
    this.handlers = new Map(); // session -> { onChunk, onEvent }
  }

  // Resolves true once the window has reported its devices (false on timeout).
  ready() {
    if (!this.readyPromise) {
      this.readyPromise = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), this.readyTimeoutMs);
        this.once('devices', () => { clearTimeout(timer); resolve(true); });
        try { this.win = this.createWindow(); } catch (e) { clearTimeout(timer); this.error = e.message; resolve(false); }
      });
    }
    return this.readyPromise;
  }

  send(cmd) { this.win?.send(cmd); }

  onEvent(msg) {
    if (msg.type === 'devices') {
      const before = JSON.stringify([this.devices, this.defaultName]);
      this.devices = msg.devices ?? [];
      this.defaultName = msg.defaultName ?? null;
      this.emit('devices', this.listing());
      if (before !== JSON.stringify([this.devices, this.defaultName])) this.emit('devices-changed', this.listing());
      return;
    }
    this.handlers.get(msg.session)?.onEvent(msg);
  }

  onChunk(session, bytes) {
    this.handlers.get(session)?.onChunk(Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length));
  }

  listing() {
    return { devices: this.devices.map(({ id, name }) => ({ id, name })), defaultName: this.defaultName };
  }

  // A choice -> what to open: { deviceId, name, fallback }.
  resolve(mic) {
    let wanted = mic;
    if (!isDefaultMic(mic) && this.aliases.has(mic.id)) wanted = { ...mic, name: this.aliases.get(mic.id) };
    const { device, fallback } = resolveMic(this.devices, wanted);
    return device
      ? { deviceId: device.id, name: device.name, fallback: null }
      : { deviceId: DEFAULT_MIC_ID, name: this.defaultName, fallback: fallback && { ...fallback, wanted } };
  }

  // Open one capture session. Returns a handle with close(). onEvent gets
  // 'opened' / 'failed' / 'first-audio' / 'ended' messages.
  open(deviceId, { onChunk, onEvent }) {
    const session = this.nextSession++;
    this.handlers.set(session, { onChunk, onEvent });
    this.send({ type: 'open', session, deviceId });
    return {
      session,
      reopen: (id = deviceId) => { deviceId = id; this.send({ type: 'open', session, deviceId: id }); },
      close: () => new Promise((resolve) => {
        const h = this.handlers.get(session);
        if (!h) return resolve();
        const timer = setTimeout(done, 1000);
        function done() { clearTimeout(timer); resolve(); }
        h.onEvent = (m) => { if (m.type === 'closed') { this.handlers.delete(session); done(); } };
        this.send({ type: 'close', session });
      }),
    };
  }

  createRecorder() {
    return new RendererRecorder(this);
  }

  // Settings "Test": a few seconds from one mic, live levels, plain verdict.
  async test(mic, { seconds = 3, onLevel = () => {} } = {}) {
    await this.ready();
    const target = isDefaultMic(mic)
      ? { deviceId: DEFAULT_MIC_ID, name: this.defaultName }
      : this.resolve(mic);
    if (!isDefaultMic(mic) && target.fallback) return { ...testVerdict({ error: 'it isn\'t connected' }), maxDb: -Infinity, name: mic.name };
    let bytes = 0;
    let maxDb = -Infinity;
    let error = null;
    let openMs = null;
    let firstAudioMs = null;
    const h = this.open(target.deviceId, {
      onChunk: (c) => { bytes += c.length; const db = chunkLevelDb(c); if (db > maxDb) maxDb = db; onLevel(db); },
      onEvent: (m) => {
        if (m.type === 'failed') error = m.error;
        if (m.type === 'opened') openMs = m.ms;
        if (m.type === 'first-audio') firstAudioMs = m.ms;
      },
    });
    await new Promise((r) => setTimeout(r, seconds * 1000));
    await h.close();
    return { ...testVerdict({ error, bytes, maxDb }), maxDb, name: target.name, openMs, firstAudioMs };
  }

  async testAll({ seconds = 3, onLevel = () => {} } = {}) {
    await this.ready();
    return Promise.all(this.devices.map(async (d) => ({
      id: d.id,
      ...(await this.test({ id: d.id, name: d.name }, { seconds, onLevel: (db) => onLevel(d.id, db) })),
    })));
  }

  destroy() {
    try { this.win?.destroy(); } catch { /* gone */ }
    this.win = null;
  }
}

// Recorder-compatible (see src/recorder.js) on top of a capture session.
export class RendererRecorder extends EventEmitter {
  constructor(capture) {
    super();
    this.capture = capture;
    this.proc = null; // truthy while recording (DictationService checks it)
    this.startupGraceMs = 500; // audio arrives ~100 ms after open
    this.micName = null;
    this.micId = null;
  }

  async prepare(mic = null) {
    if (!(await this.capture.ready())) throw new Error(`The microphone capture window didn't start${this.capture.error ? `: ${this.capture.error}` : ''}`);
    return this.capture.resolve(mic).name ?? 'System default';
  }

  start({ onChunk, mic = null } = {}) {
    if (this.proc) throw new Error('Already recording');
    this.chunks = [];
    this.openError = null;
    this.onChunk = onChunk;
    this.mic = mic;
    this.timing = {};
    const target = this.capture.resolve(mic);
    this.micName = target.name;
    this.micId = target.deviceId === DEFAULT_MIC_ID ? null : target.deviceId;
    let fallback = target.fallback;
    let triedDefault = target.deviceId === DEFAULT_MIC_ID;
    const t0 = Date.now();
    const handle = this.capture.open(target.deviceId, {
      onChunk: (c) => {
        if (this.handle !== handle) return; // a later dictation's session
        this.chunks.push(c);
        this.onChunk?.(c);
      },
      onEvent: (m) => {
        if (m.type === 'opened') {
          if (m.label && triedDefault) this.micName = m.label;
          // Once per dictation (restarts reopen the same mic).
          if (this.timing.openMs === undefined) {
            this.timing.openMs = m.ms;
            this.emit('mic', { name: this.micName, fallback });
          }
        } else if (m.type === 'first-audio') {
          this.timing.firstAudioMs = m.ms;
        } else if (m.type === 'failed') {
          if (!triedDefault) {
            // The chosen mic is listed but won't open: use the default.
            triedDefault = true;
            fallback = { wanted: mic, reason: m.error };
            this.micName = this.capture.defaultName;
            this.micId = null;
            handle.reopen(DEFAULT_MIC_ID);
          } else {
            this.openError = m.error;
          }
        }
      },
    });
    this.handle = handle;
    this.proc = handle;
    this.startedAt = t0;
  }

  // Reopen the stream (stuck device), keeping the audio so far.
  restart() {
    if (!this.proc) return false;
    this.openError = null;
    this.handle.reopen();
    return true;
  }

  async stop() {
    if (!this.proc) return null;
    const handle = this.proc;
    this.proc = null;
    // Let the last ~50 ms chunk arrive before closing.
    await handle.close();
    const pcm = Buffer.concat(this.chunks);
    if (pcm.length === 0) {
      if (this.openError) throw Object.assign(new Error(`Couldn't open the microphone: ${this.openError}`), { openFailed: this.openError });
      throw new Error('Recording is empty');
    }
    return pcm;
  }

  async cancel() {
    try { await this.stop(); } catch { /* nothing to keep */ }
  }
}
