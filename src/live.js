// Live mode: stream the mic to the Gemini Live API while the hotkey is held,
// so the transcript is ready almost as soon as the key is released.
//
// Turn control is manual (activityStart / activityEnd). Automatic voice
// detection would split a dictation at every pause and make the model answer
// mid-sentence. We only want the input transcription; anything the model
// says back is ignored, and its first reply marks the transcript as final.

import { EventEmitter } from 'node:events';
import { GoogleGenAI, Modality } from '@google/genai';

export const DEFAULT_LIVE_MODEL = 'gemini-3.8-live';

// Dedicated transcribe models reply in text; conversational live models
// (gemini-3.8-live) only accept audio replies.
export function liveConfig(model) {
  const transcribeModel = /transcribe/i.test(model);
  return {
    responseModalities: [transcribeModel ? Modality.TEXT : Modality.AUDIO],
    inputAudioTranscription: transcribeModel ? { mode: 'VERBATIM' } : {},
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    ...(transcribeModel ? {} : {
      systemInstruction: { parts: [{ text: 'You are only listening. Reply with the single word "ok".' }] },
    }),
  };
}

// Join transcription pieces, adding a space only where one is missing.
export function joinTranscript(pieces) {
  return pieces.reduce((acc, p) => {
    if (!p) return acc;
    if (!acc) return p;
    return /\s$/.test(acc) || /^\s/.test(p) ? acc + p : `${acc} ${p}`;
  }, '').trim();
}

export class LiveTranscriber extends EventEmitter {
  constructor({ apiKey, model = DEFAULT_LIVE_MODEL, finalTimeoutMs = 6000, settleMs = 150, ai }) {
    super();
    this.ai = ai ?? new GoogleGenAI({ apiKey });
    this.model = model;
    this.finalTimeoutMs = finalTimeoutMs;
    this.settleMs = settleMs;
  }

  // Open the session right away; audio pushed before it's ready is queued.
  begin() {
    this.pieces = [];
    this.queue = [];
    this.ended = false;
    this.closed = false;
    this.error = null;
    // connect() may never settle if the server rejects the setup (bad model,
    // bad key), so also give up on an early close/error or after a timeout.
    let fail;
    const failed = new Promise((resolve) => { fail = resolve; });
    const timer = setTimeout(() => fail(new Error('Live API did not connect within 8 s')), 8000);
    const onFailure = (err) => { this.error ??= err; fail(this.error); this.emit('final'); };
    const connecting = this.ai.live.connect({
      model: this.model,
      config: liveConfig(this.model),
      callbacks: {
        onmessage: (m) => this.onMessage(m),
        onerror: (e) => onFailure(new Error(`Live API error: ${e?.message ?? e}`)),
        onclose: (e) => {
          this.closed = true;
          if (!this.ended && e?.code && e.code !== 1000) onFailure(new Error(`Live API closed: ${e.code} ${e.reason ?? ''}`.trim()));
          else this.emit('final');
        },
      },
    }).then((session) => {
      if (this.error) { try { session.close(); } catch { /* ignore */ } return null; }
      this.session = session;
      session.sendRealtimeInput({ activityStart: {} });
      for (const chunk of this.queue) this.sendAudio(chunk);
      this.queue = [];
      return session;
    });
    this.sessionReady = Promise.race([connecting, failed.then((err) => { throw err; })])
      .catch((err) => { this.error ??= err; return null; })
      .finally(() => clearTimeout(timer));
  }

  push(chunk) {
    if (this.ended || this.error || this.closed) return;
    if (this.session) this.sendAudio(chunk); else this.queue.push(chunk);
  }

  sendAudio(chunk) {
    this.session.sendRealtimeInput({ audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
  }

  onMessage(m) {
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) {
      this.pieces.push(sc.inputTranscription.text);
      this.emit('partial', joinTranscript(this.pieces));
      // After the turn ends, transcription arrives in one burst. Once it goes
      // quiet for settleMs, treat it as final rather than waiting for the reply.
      if (this.ended) {
        clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => this.emit('final'), this.settleMs);
      }
    }
    // After we end the turn, the model's reply (or turn completion) means the
    // input transcription has been fully delivered.
    if (this.ended && (sc.modelTurn || sc.generationComplete || sc.turnComplete)) this.emit('final');
  }

  // End the turn and resolve with the full raw transcript.
  async finish() {
    await this.sessionReady;
    if (this.error || !this.session) { this.close(); throw this.error ?? new Error('Live API session not available'); }
    const final = new Promise((resolve) => this.once('final', resolve));
    this.ended = true;
    this.session.sendRealtimeInput({ activityEnd: {} });
    const timedOut = await Promise.race([
      final.then(() => false),
      new Promise((r) => setTimeout(() => r(true), this.finalTimeoutMs)),
    ]);
    this.close();
    if (this.error) throw this.error;
    if (timedOut && !this.pieces.length) throw new Error('Live API returned no transcript');
    return joinTranscript(this.pieces);
  }

  abort() {
    this.ended = true;
    this.sessionReady?.finally(() => this.close());
  }

  close() {
    clearTimeout(this.settleTimer);
    if (this.session && !this.closed) {
      this.closed = true;
      try { this.session.close(); } catch { /* already closed */ }
    }
  }
}
