// Gemini request limits and what happens when a request fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioTimeoutMs, CLEANUP_TIMEOUT_MS, generate, MAX_RETRIES } from '../src/gemini.js';
import { Dictation } from '../src/engine.js';
import { loadConfig } from '../src/config.js';

const fakeClient = (impl) => {
  const calls = [];
  return { calls, interactions: { create: async (body, opts) => { calls.push({ body, opts }); return impl(body, opts); } } };
};

test('every request gets a per-attempt timeout and at most one quick retry', async () => {
  const c = fakeClient(() => ({ output_text: ' Hello. ' }));
  assert.equal(await generate({ client: c, model: 'm', instruction: 'i', input: 'x' }), 'Hello.');
  assert.deepEqual(c.calls[0].opts, { timeout: CLEANUP_TIMEOUT_MS, maxRetries: MAX_RETRIES });
  assert.equal(c.calls[0].body.store, false);
  await generate({ client: c, model: 'm', instruction: 'i', input: 'x', timeoutMs: 30000 });
  assert.equal(c.calls[1].opts.timeout, 30000);
});

test('a timed-out request says so plainly; API errors keep their status', async () => {
  const timeout = Object.assign(new Error('Request timed out: TimeoutError: The operation was aborted due to timeout'), { name: 'APIConnectionTimeoutError' });
  await assert.rejects(generate({ client: fakeClient(() => { throw timeout; }), model: 'm', instruction: 'i', input: 'x' }),
    /Gemini didn't answer within 8 s \(tried 2 times\)/);
  const busy = Object.assign(new Error('503 overloaded'), { status: 503, body: { error: { message: 'The model is overloaded.' } } });
  await assert.rejects(generate({ client: fakeClient(() => { throw busy; }), model: 'm', instruction: 'i', input: 'x' }),
    /^Error: Gemini 503 The model is overloaded\.$/);
});

test('audio requests get more time as clips grow, capped at 2 minutes', () => {
  assert.equal(audioTimeoutMs(32000 * 10), 22500); // 10 s clip
  assert.equal(audioTimeoutMs(32000 * 120), 50000); // 2 min clip
  assert.equal(audioTimeoutMs(32000 * 3600), 120000);
});

test('live mode: if cleanup fails, the raw transcript is typed instead of losing the dictation', async () => {
  const config = { ...loadConfig({ GEMINI_API_KEY: 'k', GSTT_MODE: 'live', GSTT_SILENCE_DB: '-70' }), apiKey: '' }; // no key: cleanup throws
  const live = { begin() {}, push() {}, abort() {}, finish: async () => 'so um send it on friday' };
  const d = new Dictation(config, { mode: 'live', liveFactory: () => live });
  const pcm = Buffer.alloc(32000 * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? 3000 : -3000, i);
  const r = await d.finish(pcm);
  assert.equal(r.text, 'so um send it on friday');
  assert.match(r.cleanupFailed, /GEMINI_API_KEY/);
  const empty = new Dictation(config, { mode: 'live', liveFactory: () => ({ ...live, finish: async () => '  ' }) });
  assert.equal((await empty.finish(pcm)).text, ''); // nothing heard: "No speech detected", as before
});

test('one-shot: a clip over the ~39 min request limit is flagged in the log, shorter ones are not', async () => {
  const { ONE_SHOT_LIMIT_SECONDS } = await import('../src/gemini.js');
  assert.ok(ONE_SHOT_LIMIT_SECONDS > 38 * 60 && ONE_SHOT_LIMIT_SECONDS < 40 * 60);
  const logs = [];
  const d = new Dictation(loadConfig({ GEMINI_API_KEY: 'k', GSTT_MODE: 'oneshot' }), { mode: 'oneshot', log: (m) => logs.push(m) });
  assert.equal(d.warnIfTooLong(Buffer.alloc(32000 * 60 * 10)), false);
  assert.equal(logs.length, 0);
  assert.equal(d.warnIfTooLong(Buffer.alloc(32000 * 60 * 41)), true);
  assert.match(logs[0], /41 min long, over the ~39 min that fits in one request/);
});
