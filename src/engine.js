// The dictation engine, shared by the CLI and the tray app:
// hotkey -> record -> (live or one-shot) Gemini -> paste.
// OS-specific pieces (hotkey, mic, paste, sounds) come from src/platform/.

import { EventEmitter } from 'node:events';
import { cleanupTranscript, loadDictionary, transcribe } from './gemini.js';
import { parseHotkey } from './hotkey.js';
import { LiveTranscriber } from './live.js';
import { pcmLevels, pcmSeconds, toWav } from './recorder.js';

// Returns why a clip should be skipped, or null if it should be transcribed.
export function skipReason(pcm, { minSeconds, silenceDb }) {
  const secs = pcmSeconds(pcm);
  if (secs < minSeconds) return 'too short';
  const { peakWindowDb } = pcmLevels(pcm);
  if (peakWindowDb < silenceDb) return `no speech (loudest ${peakWindowDb.toFixed(0)} dBFS < ${silenceDb})`;
  return null;
}

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
export class DictationService extends EventEmitter {
  constructor(config, platform, { dictationFactory } = {}) {
    super();
    this.config = config;
    this.platform = platform;
    this.state = 'idle';
    this.makeDictation = dictationFactory ?? ((cfg, opts) => new Dictation(cfg, opts));
  }

  setState(s) {
    if (this.state !== s) { this.state = s; this.emit('state', s); }
  }

  log(msg, opts = {}) { this.emit('log', msg, opts); }

  async start() {
    const { config, platform } = this;
    this.recorder = platform.createRecorder();
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
      this.recorder.start({ onChunk: (c) => d.push(c) });
      this.platform.beep('start');
      this.log('Recording...');
      this.setState('recording');
    } catch (e) { this.log(`Could not start recording: ${e.message}`); }
  }

  async onCancel(why) {
    if (!this.recorder.proc) return;
    this.current?.abort();
    await this.recorder.cancel();
    this.log(`Cancelled (${why}).`);
    this.setState('idle');
  }

  async onStop() {
    if (!this.recorder.proc) return;
    this.busy = true;
    this.setState('working');
    try {
      const pcm = await this.recorder.stop();
      const t0 = Date.now();
      const { text, raw, skipped } = await this.current.finish(pcm);
      if (skipped) { this.log(`Not sent: ${skipped}.`); return; }
      if (raw !== undefined) this.log(`Live transcript (${Date.now() - t0} ms): ${raw}`, { private: true });
      if (!text) { this.log('No speech detected.'); return; }
      // Don't send Ctrl+V while the user still holds Super/Ctrl from the hotkey.
      const released = await this.hotkey.waitForRelease();
      if (!released) this.emit('debug', 'hotkey still held after 1.5 s; pasting anyway');
      if (this.config.dryRun) { this.log(`[dry run] would paste: ${text}`, { private: true }); return; }
      await this.platform.pasteText(text, { restore: this.config.restore });
      this.platform.beep('done');
      this.log(`Pasted ${Date.now() - t0} ms after release: ${text}`, { private: true });
      this.emit('pasted', text, Date.now() - t0);
    } catch (e) {
      this.platform.beep('error');
      this.log(`Error: ${e.message}`);
      this.emit('error', `Dictation failed: ${e.message}`);
    } finally {
      this.busy = false;
      this.setState('idle');
    }
  }

  async stop() {
    this.hotkey?.stop();
    this.current?.abort();
    await this.recorder?.cancel();
  }
}
