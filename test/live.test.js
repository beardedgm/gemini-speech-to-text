import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveTranscriber, joinTranscript, liveConfig } from '../src/live.js';
import { buildInstruction } from '../src/gemini.js';
import { pcmLevels, pcmSeconds, toWav, wavPcm } from '../src/recorder.js';

// Fake Live API: records what we send and lets the test play server messages.
function fakeAi({ failConnect = false } = {}) {
  const sent = [];
  let callbacks;
  const session = { sendRealtimeInput: (m) => sent.push(m), close: () => sent.push('close') };
  return {
    sent,
    emit: (serverContent) => callbacks.onmessage({ serverContent }),
    live: {
      connect: async (opts) => {
        callbacks = opts.callbacks;
        if (failConnect) throw new Error('connect refused');
        return session;
      },
    },
  };
}

test('liveConfig: conversational model uses audio replies + manual turns; transcribe model uses text', () => {
  const c = liveConfig('gemini-3.8-live');
  assert.deepEqual(c.responseModalities, ['AUDIO']);
  assert.equal(c.realtimeInputConfig.automaticActivityDetection.disabled, true);
  assert.ok(c.inputAudioTranscription);
  assert.deepEqual(liveConfig('gemini-3.5-transcribe-live').responseModalities, ['TEXT']);
});

test('joinTranscript adds spaces only where missing', () => {
  assert.equal(joinTranscript(['Hello.', 'World.']), 'Hello. World.');
  assert.equal(joinTranscript(['Hel', ' lo ', 'there']), 'Hel lo there');
  assert.equal(joinTranscript([]), '');
});

test('LiveTranscriber queues early audio, brackets it with activityStart/End, and settles on the transcript', async () => {
  const ai = fakeAi();
  const lt = new LiveTranscriber({ ai, settleMs: 20 });
  lt.begin();
  lt.push(Buffer.from([1, 2])); // before connect resolves: queued
  await lt.sessionReady;
  lt.push(Buffer.from([3, 4]));
  const done = lt.finish();
  await new Promise((r) => setImmediate(r));
  ai.emit({ inputTranscription: { text: 'Meeting at four.' } });
  assert.equal(await done, 'Meeting at four.');
  assert.ok('activityStart' in ai.sent[0]);
  assert.equal(ai.sent.filter((m) => m.audio).length, 2);
  assert.ok(ai.sent.some((m) => m.activityEnd));
  assert.equal(ai.sent.at(-1), 'close');
});

test('LiveTranscriber finalizes on the model reply too', async () => {
  const ai = fakeAi();
  const lt = new LiveTranscriber({ ai, settleMs: 10_000 });
  lt.begin();
  await lt.sessionReady;
  const done = lt.finish();
  await new Promise((r) => setImmediate(r));
  ai.emit({ inputTranscription: { text: 'Hi' } });
  ai.emit({ modelTurn: { parts: [{ inlineData: {} }] } });
  assert.equal(await done, 'Hi');
});

test('LiveTranscriber surfaces connect errors so the caller can fall back', async () => {
  const lt = new LiveTranscriber({ ai: fakeAi({ failConnect: true }) });
  lt.begin();
  await assert.rejects(lt.finish(), /connect refused/);
});

test('transcript cleanup instruction differs from the audio one', () => {
  const t = buildInstruction(['COSMIC'], 'transcript');
  assert.match(t, /speech-to-text transcript/);
  assert.match(t, /- COSMIC/);
  assert.doesNotMatch(buildInstruction([], 'audio'), /transcript of someone/);
});

test('toWav/wavPcm round-trip and pcm helpers', () => {
  const pcm = Buffer.alloc(32000); // 1 s of silence
  assert.deepEqual(wavPcm(toWav(pcm)), pcm);
  assert.equal(pcmSeconds(pcm), 1);
  assert.equal(pcmLevels(pcm).peakWindowDb, -Infinity);
});

test('LiveTranscriber does not hang when the server closes during setup and connect never settles', async () => {
  let callbacks;
  const ai = { live: { connect: (opts) => { callbacks = opts.callbacks; return new Promise(() => {}); } } };
  const lt = new LiveTranscriber({ ai });
  lt.begin();
  lt.push(Buffer.from([1]));
  callbacks.onclose({ code: 1008, reason: 'model not found' });
  await assert.rejects(lt.finish(), /1008 model not found/);
});
