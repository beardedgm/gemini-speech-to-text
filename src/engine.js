// The dictation engine, shared by the CLI and the tray app:
// hotkey -> record -> (live or one-shot) Gemini -> paste.
// OS-specific pieces (hotkey, mic, paste, sounds) come from src/platform/.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupTranscript, loadDictionary, transcribe } from './gemini.js';
import { parseHotkey } from './hotkey.js';
import { LiveTranscriber } from './live.js';
import { MicMonitor, MIC_PROBLEMS } from './micmonitor.js';
import { pcmLevels, pcmSeconds, toWav, wavPcm } from './recorder.js';

// Returns why a clip should be skipped, or null if it should be transcribed.
export const MIC_SILENT = 'microphone sent no audio';

export function skipReason(pcm, { minSeconds, silenceDb }) {
  const secs = pcmSeconds(pcm);
  if (secs < minSeconds) return 'too short';
  const { peakWindowDb } = pcmLevels(pcm);
  // Exactly zero signal: a working mic always picks up some noise, so this
  // means it's muted (e.g. a hardware mute button) or its stream stalled.
  if (peakWindowDb === -Infinity) return MIC_SILENT;
  if (peakWindowDb < silenceDb) return `no speech (loudest ${peakWindowDb.toFixed(0)} dBFS < ${silenceDb})`;
  return null;
}

// Automatic mic resets per hold before warning the user.
export const MAX_MIC_RECOVERIES = 3;

const geminiOpts = (config) => ({ apiKey: config.apiKey, model: config.model, dictionary: loadDictionary(config.dictionary) });

// One dictation from key-down to text. Used for the real mic and for `bench`.
export class Dictation {
  constructor(config, { mode = config.mode, log = () => {}, liveFactory } = {}) {
    this.config = config;
    this.log = log;
    const makeLive = liveFactory ?? (() => new LiveTranscriber({ apiKey: config.apiKey, model: config.liveModel }));
    this.live = mode === 'live' ? makeLive() : null;
    this.live?.begin();
  }

  push(chunk) { this.live?.push(chunk); }

  // Resolves with { text, raw?, transcriptMs?, fellBack? } or { skipped }.
  async finish(pcm) {
    const skipped = skipReason(pcm, this.config);
    if (skipped) { this.live?.abort(); return { skipped }; }
    if (this.live) {
      const t0 = Date.now();
      let raw;
      try {
        raw = await this.live.finish();
      } catch (e) {
        // The audio is still in memory, so fall back to a one-shot call.
        this.log(`Live transcription failed (${e.message}); falling back to one-shot.`);
        return { text: await transcribe(toWav(pcm), geminiOpts(this.config)), fellBack: true };
      }
      const transcriptMs = Date.now() - t0;
      const text = await cleanupTranscript(raw, { ...geminiOpts(this.config), model: this.config.cleanupModel });
      return { raw, text, transcriptMs };
    }
    return { text: await transcribe(toWav(pcm), geminiOpts(this.config)) };
  }

  abort() { this.live?.abort(); }
}

// Long-running hold-to-talk service.
// Events:
//   'state'  ('idle' | 'recording' | 'working')
//   'log'    (message, { private }) - private messages contain dictated text
//   'debug'  (message)
//   'error'  (message) - user-facing problems (notify)
//   'pasted' (text, ms)
//   'level'  (dBFS) - live mic level while recording (for the tray meter)
//   'mic-warning' ({ reason, mic, message }) - mic isn't hearing anything, ~1 s into a hold
//   'mic-ok' () - signal arrived after a warning
//   'retry-available' (boolean) - a failed dictation's audio is kept for "Retry last dictation"
export class DictationService extends EventEmitter {
  constructor(config, platform, { dictationFactory, monitorFactory, retryFile, transcribeFn } = {}) {
    super();
    this.config = config;
    this.platform = platform;
    this.state = 'idle';
    this.makeDictation = dictationFactory ?? ((cfg, opts) => new Dictation(cfg, opts));
    this.makeMonitor = monitorFactory ?? (() => new MicMonitor({ checkAfterMs: 500 }));
    // Audio of the last dictation that failed, kept so it can be retried.
    this.retryFile = retryFile ?? (platform.logDir ? path.join(platform.logDir(), 'last-dictation.wav') : null);
    this.lastFailed = null;
    this.transcribe = transcribeFn ?? transcribe;
  }

  get canRetry() { return Boolean(this.lastFailed); }

  keepForRetry(pcm) {
    this.lastFailed = pcm;
    if (this.retryFile) {
      try { fs.writeFileSync(this.retryFile, toWav(pcm), { mode: 0o600 }); } catch { /* memory copy is enough */ }
    }
    this.log('Kept the audio of this dictation: use "Retry last dictation" in the tray menu.');
    this.emit('retry-available', true);
  }

  clearRetry() {
    if (!this.lastFailed) return;
    this.lastFailed = null;
    if (this.retryFile) fs.rmSync(this.retryFile, { force: true });
    this.emit('retry-available', false);
  }

  setState(s) {
    if (this.state !== s) { this.state = s; this.emit('state', s); }
  }

  log(msg, opts = {}) { this.emit('log', msg, opts); }

  async start() {
    const { config, platform } = this;
    this.recorder = platform.createRecorder();
    if (this.retryFile && fs.existsSync(this.retryFile)) {
      try {
        this.lastFailed = wavPcm(fs.readFileSync(this.retryFile));
        this.emit('retry-available', true);
      } catch { /* ignore a damaged file */ }
    }
    if (this.recorder.prepare) this.log(`Microphone: ${await this.recorder.prepare()}`);
    const hk = platform.createHotkey(parseHotkey(config.hotkey), { onWarn: (m) => this.log(m) });
    this.hotkey = hk;
    hk.on('error', (err) => {
      this.log(`Keyboard read error: ${err.message}`);
      if (/EACCES/.test(err.message)) this.log('You need to be in the "input" group. See README, "Permissions".');
      this.emit('error', `Keyboard error: ${err.message}`);
    });
    hk.on('debug', (m) => this.emit('debug', m));
    hk.on('devices', (kbs) => this.log(`Keyboards now: ${kbs.map((k) => k.name).join(', ')}`));
    hk.on('start', () => this.onStart());
    hk.on('cancel', (why) => this.onCancel(why));
    hk.on('stop', () => this.onStop());
    const kbs = hk.start();
    this.log(`Listening for ${config.hotkey} on: ${kbs.map((k) => k.name).join(', ')}`);
    const modelDesc = config.mode === 'live' ? `${config.liveModel} -> ${config.cleanupModel}` : config.model;
    this.log(`Mode ${config.mode} (${modelDesc}), paste via ${platform.pasteDescription()}.`);
    this.setState('idle');
  }

  onStart() {
    if (this.busy) return;
    try {
      const d = this.makeDictation(this.config, { log: (m) => this.log(m) });
      this.current = d;
      const mon = this.makeMonitor();
      this.monitor = mon;
      let recoveries = 0;
      let recoveredLogged = false;
      this.warned = false;
      mon.on('level', (db) => {
        if (recoveries && !recoveredLogged && db >= mon.floorDb) {
          recoveredLogged = true;
          this.log(`Microphone recovered after ${recoveries} restart${recoveries > 1 ? 's' : ''}.`);
        }
        this.emit('level', db);
      });
      mon.on('ok', () => { this.log('Microphone is hearing you again.'); this.emit('mic-ok'); });
      mon.on('warning', async (reason) => {
        // Muted (e.g. the mic's own mute button): say so; resets can't help.
        if (reason !== 'too-quiet' && (await this.platform.microphoneMuted?.().catch(() => null)) === true) {
          if (this.monitor !== mon) return;
          reason = 'muted';
          recoveries = MAX_MIC_RECOVERIES;
        }
        // USB mics (e.g. Elgato Wave 3) sometimes come back from PipeWire's
        // idle suspend stuck: no data, or exact zeros. Forcing the input to
        // suspend and resume, then restarting capture, fixes that within
        // ~0.5 s; restarting capture alone doesn't. A muted mic won't recover,
        // so after MAX_MIC_RECOVERIES the user is warned.
        if (reason !== 'too-quiet' && recoveries < MAX_MIC_RECOVERIES && this.recorder.restart) {
          recoveries++;
          this.log(`Microphone ${MIC_PROBLEMS[reason]}; resetting it (try ${recoveries}).`);
          await this.platform.recoverMic?.().catch(() => {});
          if (this.monitor !== mon) return; // released meanwhile
          this.recorder.restart();
          mon.warning = null;
          mon.schedule();
          return;
        }
        const mic = await this.platform.microphoneName?.().catch(() => null);
        if (this.monitor !== mon || !mon.warning) return; // released or recovered meanwhile
        const message = reason === 'muted'
          ? `${mic ?? 'Your microphone'} is muted. Unmute it to dictate.`
          : `${mic ?? 'Your microphone'} ${MIC_PROBLEMS[reason]}. Is it muted?`;
        this.warned = true;
        this.log(`Mic warning: ${message}`);
        this.platform.beep('error');
        this.emit('mic-warning', { reason, mic, message });
      });
      mon.start();
      this.recorder.start({ onChunk: (c) => { d.push(c); mon.push(c); } });
      if (this.config.soundStart !== false) this.platform.beep('start');
      this.log('Recording...');
      this.setState('recording');
    } catch (e) { this.log(`Could not start recording: ${e.message}`); }
  }

  async onCancel(why) {
    if (!this.recorder.proc) return;
    this.monitor?.stop();
    this.monitor = null;
    this.current?.abort();
    await this.recorder.cancel();
    this.log(`Cancelled (${why}).`);
    this.setState('idle');
  }

  async onStop() {
    if (!this.recorder.proc) return;
    this.busy = true;
    this.monitor?.stop();
    this.monitor = null;
    this.setState('working');
    let pcm = null;
    let delivered = false;
    try {
      pcm = await this.recorder.stop();
      const t0 = Date.now();
      const { text, raw, skipped } = await this.current.finish(pcm);
      if (skipped === MIC_SILENT) {
        const mic = await this.platform.microphoneName?.().catch(() => null);
        this.log(`Not sent: ${skipped}${mic ? ` (${mic})` : ''}.`);
        if (!this.warned) this.emit('error', `Your microphone${mic ? ` (${mic})` : ''} sent no sound at all. Is it muted?`);
        return;
      }
      if (skipped) { this.log(`Not sent: ${skipped}.`); return; }
      if (raw !== undefined) this.log(`Live transcript (${Date.now() - t0} ms): ${raw}`, { private: true });
      if (!text) {
        this.log('No speech detected.');
        this.keepForRetry(pcm); // real audio but no text: don't lose it
        return;
      }
      // Don't send Ctrl+V while the user still holds Super/Ctrl from the hotkey.
      const released = await this.hotkey.waitForRelease();
      if (!released) this.emit('debug', 'hotkey still held after 1.5 s; pasting anyway');
      await this.deliver(text, t0);
      delivered = true;
    } catch (e) {
      this.platform.beep('error');
      this.log(`Error: ${e.message}`);
      // Keep real audio (not silence) so the dictation can be retried.
      if (pcm && !skipReason(pcm, this.config)) this.keepForRetry(pcm);
      // An empty recording was already announced by the early mic warning.
      if (!(this.warned && /Recording is empty/.test(e.message))) {
        this.emit('error', `Dictation failed: ${e.message}${this.canRetry ? ' (use "Retry last dictation")' : ''}`);
      }
    } finally {
      if (delivered) this.clearRetry();
      this.busy = false;
      this.setState('idle');
    }
  }

  async deliver(text, t0) {
    if (this.config.dryRun) { this.log(`[dry run] would paste: ${text}`, { private: true }); return; }
    await this.platform.pasteText(text, { restore: this.config.restore });
    if (this.config.soundDone !== false) this.platform.beep('done');
    this.log(`Pasted ${Date.now() - t0} ms after release: ${text}`, { private: true });
    this.emit('pasted', text, Date.now() - t0);
  }

  // Re-send the last failed dictation (one-shot) and paste the result where
  // the cursor is now.
  async retryLast() {
    if (this.busy || !this.lastFailed) return false;
    this.busy = true;
    this.setState('working');
    const t0 = Date.now();
    try {
      const text = await this.transcribe(toWav(this.lastFailed), geminiOpts(this.config));
      if (!text) throw new Error('Gemini returned no text for the saved audio');
      await this.deliver(text, t0);
      this.clearRetry();
      return true;
    } catch (e) {
      this.platform.beep('error');
      this.log(`Retry failed: ${e.message}`);
      this.emit('error', `Retry failed: ${e.message}`);
      return false;
    } finally {
      this.busy = false;
      this.setState('idle');
    }
  }

  async stop() {
    this.monitor?.stop();
    this.hotkey?.stop();
    this.current?.abort();
    await this.recorder?.cancel();
  }
}
