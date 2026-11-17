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

$('cancel').addEventListener('click', () => window.gstt.close());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !recording) window.gstt.close(); });

load();
