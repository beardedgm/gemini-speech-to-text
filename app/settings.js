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

$('cancel').addEventListener('click', () => window.gstt.close());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.gstt.close(); });

load();
