#!/usr/bin/env node
// flowcode: hold a key, talk, let go, and the cleaned-up text is pasted where your cursor is.

import './stdio-guard.js'; // first: survive being started without a terminal
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configProblem, loadConfig } from './config.js';
import { Dictation, DictationService } from './engine.js';
import { loadDictionary, transcribe } from './gemini.js';
import { parseHotkey } from './hotkey.js';
import { loadPlatform } from './platform/index.js';
import { pcmLevels, pcmSeconds, toWav, wavPcm } from './recorder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig(process.env, ROOT);
const platform = await loadPlatform();

// Everything is also appended to a log file, since the terminal usually isn't
// visible while dictating into another app. Dictated text stays out of it.
const LOG_FILE = path.join(platform.logDir(), 'flowcode.log');
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
function log(msg, { private: isPrivate = false } = {}) {
  console.log(new Date().toLocaleTimeString(), msg);
  const line = isPrivate ? msg.replace(/: [\s\S]*$/, ': [text omitted]') : msg;
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`); } catch { /* best effort */ }
}
const debug = (m) => { if (config.debug) log(`[debug] ${m}`); };

function requireConfig() {
  const problem = configProblem(config);
  if (problem) {
    console.error(`${problem} Copy .env.example to .env and set GEMINI_API_KEY.`);
    process.exit(1);
  }
}

async function runDictation() {
  requireConfig();
  const service = new DictationService(config, platform);
  service.on('log', log);
  service.on('debug', debug);
  service.on('error', (m) => { if (config.notify) platform.notify('flowcode', m); });
  await service.start();
  log(`Hold ${config.hotkey}, talk, release. Log file: ${LOG_FILE}${config.debug ? ' (debug on)' : ''}`);
  const quit = () => { service.stop().finally(() => process.exit(0)); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

// Replay a WAV in real time as if it were the mic, through one or both modes,
// and time key release -> text. Never pastes.
async function bench(file, modes = ['oneshot', 'live'], runs = 1) {
  requireConfig();
  const pcm = wavPcm(fs.readFileSync(file));
  log(`${file}: ${pcmSeconds(pcm).toFixed(1)}s of audio, replayed in real time.`);
  for (let r = 1; r <= runs; r++) {
    for (const mode of modes) {
      const d = new Dictation(config, { mode, log });
      const CHUNK = 3200; // 100 ms
      for (let o = 0; o < pcm.length; o += CHUNK) {
        d.push(pcm.subarray(o, o + CHUNK));
        await new Promise((res) => setTimeout(res, 100));
      }
      const t0 = Date.now();
      const out = await d.finish(pcm);
      const ms = Date.now() - t0;
      if (out.skipped) log(`[${mode}] skipped: ${out.skipped}`);
      else {
        const split = out.transcriptMs !== undefined ? ` (transcript ${out.transcriptMs} + cleanup ${ms - out.transcriptMs})` : '';
        console.log(`[${mode} run ${r}] ${ms} ms${split}\n    -> ${out.text.replace(/\n+/g, ' / ')}`);
      }
    }
  }
}

// --- test commands (no API key needed) ---

function testHotkey() {
  const hk = platform.createHotkey(parseHotkey(config.hotkey), { onWarn: log });
  hk.on('debug', debug);
  hk.on('start', () => log('START (recording would begin)'));
  hk.on('stop', (ms) => log(`STOP after ${ms} ms (would transcribe and paste)`));
  hk.on('cancel', (why) => log(`CANCEL (${why})`));
  const kbs = hk.start();
  log(`Listening for ${config.hotkey} on: ${kbs.map((k) => k.name).join(', ')}. Press Ctrl+C to quit.`);
  process.on('SIGINT', () => { hk.stop(); process.exit(0); });
}

async function testRecord(seconds = 3) {
  const file = path.join(ROOT, 'test-recording.wav');
  const r = platform.createRecorder();
  if (r.prepare) log(`Microphone: ${await r.prepare()}`);
  r.start();
  log(`Recording ${seconds}s from the default mic...`);
  await new Promise((res) => setTimeout(res, seconds * 1000));
  const pcm = await r.stop();
  fs.writeFileSync(file, toWav(pcm));
  const { rmsDb, peakWindowDb } = pcmLevels(pcm);
  log(`Saved ${file} (${pcmSeconds(pcm).toFixed(2)}s, avg ${rmsDb.toFixed(0)} dBFS, loudest ${peakWindowDb.toFixed(0)} dBFS; speech threshold ${config.silenceDb}).`);
}

async function testPaste(text = 'Hello from flowcode.', delay = 3) {
  log(`Focus a text field. Pasting in ${delay}s via ${platform.pasteDescription()}...`);
  await new Promise((res) => setTimeout(res, delay * 1000));
  await platform.pasteText(text, { restore: config.restore });
  log('Pasted.');
}

async function transcribeFile(file) {
  requireConfig();
  console.log(await transcribe(file, { apiKey: config.apiKey, model: config.model, dictionary: loadDictionary(config.dictionary) }));
}

async function devices() {
  for (const k of platform.listKeyboards()) console.log(`keyboard: ${k.path}  ${k.name}`);
  if (platform.listMicrophones) for (const m of await platform.listMicrophones()) console.log(`microphone: ${m}`);
}

const [cmd = 'run', ...args] = process.argv.slice(2);
const commands = {
  run: runDictation,
  'test-hotkey': testHotkey,
  'test-record': () => testRecord(Number(args[0]) || 3),
  'test-paste': () => testPaste(args[0], Number(args[1]) || 3),
  transcribe: () => transcribeFile(args[0]),
  bench: () => bench(args[0], args[1] ? [args[1]] : undefined, Number(args[2]) || 1),
  devices,
};
if (!commands[cmd]) {
  console.log('Usage: flowcode [run | test-hotkey | test-record [secs] | test-paste [text] [delay] | transcribe <file.wav> | bench <file.wav> [oneshot|live] [runs] | devices]');
  process.exit(1);
}
Promise.resolve(commands[cmd]()).catch((e) => { console.error(e.message); process.exit(1); });
