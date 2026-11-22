// Settings window logic (renderer). Talks to the main process via window.gstt.
const $ = (id) => document.getElementById(id);

function status(el, text, cls = '') {
  el.textContent = text;
  el.className = `status ${cls}`;
}

async function load() {
  const s = await window.gstt.getSettings();
  document.querySelector(`input[name=mode][value=${s.mode}]`).checked = true;
  $('hotkey').value = s.hotkey;
  await checkHotkey();
  $('silence').value = s.silenceDb;
  $('login').checked = s.startAtLogin;
  $('soundStart').checked = s.soundStart;
  $('soundDone').checked = s.soundDone;
  $('clearKey').hidden = s.keySource !== 'keychain';
  if (s.keySource === 'keychain') status($('keyStatus'), 'A key is saved. Leave the field empty to keep it.', 'ok');
  else if (s.keySource === 'env') status($('keyStatus'), 'Using the key from the .env file (development). Paste one here to store it in the keychain.', 'warn');
  else status($('keyStatus'), 'No key yet. Paste one to start dictating.', 'warn');
  if (s.keyProtection === 'plain') status($('keyStatus'), 'Warning: no system keychain found, so the key would only be obfuscated.', 'err');
  if (!s.hasKey) $('key').focus();
  await loadMics();
}

$('test').addEventListener('click', async () => {
  status($('keyStatus'), 'Testing...');
  const r = await window.gstt.testKey($('key').value.trim() || null);
  status($('keyStatus'), r.ok ? `Key works (${r.model}).` : `Key check failed: ${r.error}`, r.ok ? 'ok' : 'err');
});

$('clearKey').addEventListener('click', async () => {
  await window.gstt.clearKey();
  await load();
});

$('save').addEventListener('click', async () => {
  status($('saveStatus'), 'Saving...');
  const r = await window.gstt.saveSettings({
    apiKey: $('key').value.trim() || undefined,
    mode: document.querySelector('input[name=mode]:checked').value,
    hotkey: $('hotkey').value.trim(),
    silenceDb: Number($('silence').value),
    startAtLogin: $('login').checked,
    soundStart: $('soundStart').checked,
    soundDone: $('soundDone').checked,
    mic: selectedMic(),
  });
  if (!r.ok) return status($('saveStatus'), r.error, 'err');
  $('key').value = '';
  status($('saveStatus'), 'Saved.', 'ok');
  await load();
});

// --- hotkey: recorder + live check ---------------------------------------------

let recording = false;

function showIssues({ errors = [], warnings = [] }) {
  const el = $('hotkeyStatus');
  el.replaceChildren(...[...errors.map((t) => [t, 'err']), ...warnings.map((t) => [t, 'warn'])].map(([t, cls]) => {
    const p = document.createElement('p');
    p.textContent = t;
    p.className = cls;
    return p;
  }));
  el.className = 'status';
}

async function checkHotkey() {
  showIssues(await window.gstt.checkHotkey($('hotkey').value));
}

let checkTimer;
$('hotkey').addEventListener('input', () => {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(checkHotkey, 250);
});

function setRecording(on) {
  recording = on;
  $('record').textContent = on ? 'Cancel' : 'Record';
  $('record').classList.toggle('recording', on);
  $('hotkey').disabled = on;
  $('save').disabled = on;
}

$('record').addEventListener('click', async () => {
  if (recording) return window.gstt.cancelRecordHotkey();
  setRecording(true);
  status($('hotkeyStatus'), 'Press and release your shortcut now. Dictation is paused until you do.');
  const r = await window.gstt.recordHotkey();
  setRecording(false);
  if (r.spec) {
    $('hotkey').value = r.spec;
    showIssues(r.issues);
    if (!r.issues.errors.length) status($('saveStatus'), 'Click Save to use the new hotkey.');
  } else if (r.error) {
    status($('hotkeyStatus'), r.error, 'err');
  } else {
    await checkHotkey(); // cancelled: show the current hotkey's state again
  }
  $('record').focus();
});

// While recording, the keys are for the recorder: don't let them type,
// press buttons or close the window.
for (const type of ['keydown', 'keyup', 'keypress']) {
  window.addEventListener(type, (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}

// --- microphone: picker, test, check all ---------------------------------------

let mics = null; // last listing from the main process
let testing = false;

function cleanName(n) { return String(n || '').replace(/\s+\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, ''); }

function selectedMic() {
  const opt = $('mic').selectedOptions[0];
  return opt ? { id: opt.value, name: opt.dataset.name } : undefined;
}

function option(id, label, name = label) {
  const o = document.createElement('option');
  o.value = id;
  o.textContent = label;
  o.dataset.name = name;
  return o;
}

// keepSelection: a refresh keeps what's picked in the list (maybe not saved yet).
async function loadMics({ keepSelection = false } = {}) {
  const previous = keepSelection ? selectedMic() : null;
  mics = await window.gstt.listMics();
  const want = previous ?? mics.chosen;
  const sel = $('mic');
  const opts = [option('default', `System default${mics.defaultName ? ` (currently: ${cleanName(mics.defaultName)})` : ''}`, 'System default')];
  for (const d of mics.devices) opts.push(option(d.id, cleanName(d.name), d.name));
  const present = want.id === 'default' || mics.devices.some((d) => d.id === want.id || cleanName(d.name) === cleanName(want.name));
  if (!present) opts.push(option(want.id, `${cleanName(want.name)} (not connected)`, want.name));
  sel.replaceChildren(...opts);
  const match = [...sel.options].find((o) => o.value === want.id) ?? [...sel.options].find((o) => cleanName(o.dataset.name) === cleanName(want.name));
  if (match) match.selected = true;
  const env = $('micEnv');
  env.hidden = !mics.env;
  if (mics.env) {
    env.textContent = mics.env.overridden
      ? `GSTT_MIC is set (${cleanName(mics.env.name)}), but your choice here wins. You can remove that environment variable.`
      : `GSTT_MIC is set, so ${cleanName(mics.env.name)} is used. Save a choice here to override it.`;
  }
  if (!mics.devices.length) status($('micStatus'), 'No microphones found. Plug one in; this list updates by itself.', 'warn');
  else if (!testing && !keepSelection) status($('micStatus'), '');
}

function showLevel(db) {
  const pct = Number.isFinite(db) ? Math.max(0, Math.min(100, ((db + 70) / 55) * 100)) : 0;
  $('micMeter').firstElementChild.style.width = `${pct}%`;
}

$('mic').addEventListener('change', () => { status($('micStatus'), 'Click Save to use this microphone, or Test to check it first.'); });

$('testMic').addEventListener('click', async () => {
  if (testing) return;
  testing = true;
  $('testMic').disabled = true;
  $('micMeter').classList.remove('dead');
  status($('micStatus'), 'Listening for 3 seconds: say something...');
  const r = await window.gstt.testMic(selectedMic());
  testing = false;
  $('testMic').disabled = false;
  showLevel(-Infinity);
  if (!r.ok) $('micMeter').classList.add('dead');
  const which = r.name ? `${cleanName(r.name)}: ` : '';
  status($('micStatus'), `${which}${r.text}`, r.kind === 'ok' ? 'ok' : r.ok ? 'warn' : 'err');
});

$('testAll').addEventListener('click', async () => {
  if (testing) return;
  testing = true;
  $('testAll').disabled = true;
  const list = $('allResults');
  list.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'Listening to every mic for 3 seconds: say something...' }));
  const results = await window.gstt.testAllMics();
  testing = false;
  $('testAll').disabled = false;
  list.replaceChildren(...results.map((r) => {
    const li = document.createElement('li');
    li.className = r.ok ? 'ok' : 'bad';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const text = document.createElement('span');
    text.textContent = `${cleanName(r.name)}: ${r.ok ? 'sending sound' : r.text.replace(/^No sound from this mic/, 'no sound')}`;
    li.append(dot, text);
    return li;
  }));
  if (!results.length) list.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'No microphones found.' }));
});

window.gstt.onMicLevel((id, db) => {
  const sel = selectedMic();
  if (testing && (!sel || sel.id === id || id === 'default')) showLevel(db);
});
// Windows reports device changes; elsewhere, look again every few seconds.
window.gstt.onMicsChanged(() => loadMics({ keepSelection: true }));
setInterval(() => { if (mics && mics.platform !== 'windows' && !testing) loadMics({ keepSelection: true }); }, 3000);

$('cancel').addEventListener('click', () => window.gstt.close());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !recording) window.gstt.close(); });

load();
