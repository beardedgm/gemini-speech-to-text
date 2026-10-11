# Gemini Speech to Text

Hold-to-talk dictation for Linux, powered by Gemini.

To use it:
1. Hold the hotkey (**Ctrl+Super**, either side, by default) and talk.
2. Let go.

Gemini transcribes the clip and cleans it up: punctuation, capitalization, and no "um"s or false starts. The text is then pasted wherever your cursor is.

It's a small Node app with one dependency (`@google/genai`). It was designed from the notes in `wispr-rea-notes.md`, and all the code is new.

## How it works

| Piece | How |
|---|---|
| Hotkey | Reads key events straight from `/dev/input/event*` (evdev), so it works in every app on Wayland (COSMIC) and X11. Keyboards that connect later (Bluetooth) are picked up automatically. |
| Recording | `pw-record` (PipeWire), 16 kHz mono WAV, recorded while the key is held. |
| Transcription (default, `live`) | While you hold the keys, audio streams to `gemini-3.8-live` (Live API), which transcribes as you talk. On release the raw transcript goes to `gemini-3.5-flash-lite` (text only) for cleanup: punctuation, no filler words, and your dictionary as preferred spellings. Text is ready about 1 s after you let go. See "Live mode" below. |
| Transcription (`oneshot`) | One `gemini-3.8-flash` call with the audio inline, sent after you let go. `store: false`, low thinking. It's also the automatic fallback if a live session fails. |
| Paste | Saves your clipboard → copies the text → presses Ctrl+V → restores your old clipboard after 0.4 s. Wayland uses `wl-copy` + `ydotool`; X11 uses `xclip` + `xdotool`. |

The hold is cancelled, with nothing sent, in two cases:
- You let go within 0.25 s, so a quick tap does nothing.
- You press another key while holding, so Ctrl+Super+arrow and other shortcuts still work.

Recording starts when both Ctrl and Super are down, and stops when either is released. Paste waits until both are up, so the simulated Ctrl+V never combines with a key you're still holding.

**COSMIC Launcher:** on COSMIC, tapping Super alone opens the Launcher. To stop a Ctrl+Super hold from counting as that tap, the app taps F24, a key bound to nothing, through its own virtual keyboard (`src/keytap.py`, Python standard library only). This uses `/dev/uinput`, which members of the `input` group can already use.

## Setup

### 1. Install
Requires Node 22 or newer. You have 24.

```bash
cd gemini-speech-to-text
```
```bash
npm install
```

### 2. Add your Gemini API key
Create a key at https://aistudio.google.com/apikey. Then:

```bash
cp .env.example .env
```

Open `.env` in an editor and set `GEMINI_API_KEY=...`. If it is unset, the app uses `VOICE_DEV_GEMINI_KEY` instead. Git ignores `.env`, so the key is never committed.

### 3. Permissions
- **Keyboard:** reading the keyboard requires being in the `input` group. On this machine you already are; check with `id`. On another machine run `sudo usermod -aG input $USER`, then log out and back in.
- **Paste:** pasting on Wayland needs `ydotoold` running with access to `/dev/uinput`. On this machine it's already running as your user. If it ever isn't, start it with:

```bash
ydotoold &
```

### 4. Optional: your dictionary
```bash
cp dictionary.example.txt dictionary.txt
```

Put one name or term per line in `dictionary.txt`.

## Run

```bash
npm start
```

Then hold **Ctrl+Super**, talk, and release. Stop the app with Ctrl+C in its terminal.

Everything is also logged to `~/.local/state/gemini-speech-to-text/gemini-speech-to-text.log`. Dictated text is left out of the log file. Errors also show as desktop notifications.

## Settings (in `.env`)

| Variable | Default | Notes |
|---|---|---|
| `GSTT_HOTKEY` | `CTRL+SUPER` | Keys joined with `+`. `CTRL`, `SUPER` (`WIN`), `ALT` and `SHIFT` match either side. Exact evdev names also work, e.g. `KEY_RIGHTCTRL` or `KEY_F13`. |
| `GSTT_MODE` | `live` | `live` or `oneshot` (see "Live mode"). |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Model for one-shot transcription, and the fallback if live fails. |
| `GSTT_LIVE_MODEL` | `gemini-3.8-live` | Live API model for live mode. `gemini-3.5-transcribe-live` also works. |
| `GSTT_CLEANUP_MODEL` | `gemini-3.5-flash-lite` | Text model that cleans up the live transcript. |
| `GSTT_SILENCE_DB` | `-40` | Silence cutoff in dBFS (see "Silence check"). |
| `GSTT_DEBUG` | `0` | `1` logs every hotkey key event and the device it came from. |
| `GSTT_DRY_RUN` | `0` | `1` does everything except the paste (logs the text instead). |
| `GSTT_NOTIFY` | `1` | `0` turns off error notifications. |
| `GSTT_SOUND_START` | `1` | `0` turns off the sound when recording starts. |
| `GSTT_SOUND_DONE` | `1` | `0` turns off the sound after the text is pasted. |
| `GSTT_DICTIONARY` | `dictionary.txt` | Path to your dictionary file. |
| `GSTT_RESTORE_CLIPBOARD` | `1` | Set to `0` to leave the dictated text on the clipboard. |

## Test commands (no API key needed)

| Command | What it does |
|---|---|
| `node src/cli.js devices` | Lists the keyboards it will listen to. |
| `node src/cli.js test-hotkey` | Prints START/STOP/CANCEL as you hold and release the hotkey. |
| `node src/cli.js test-record 3` | Records 3 s to `test-recording.wav`. Play it back with `pw-play test-recording.wav`. |
| `node src/cli.js test-paste "Hello" 3` | Waits 3 s (click into a text field), then pastes "Hello". |
| `node src/cli.js transcribe file.wav` | Sends a WAV file to Gemini and prints the text (needs the key). |
| `node src/cli.js bench file.wav [oneshot\|live] [runs]` | Replays a WAV in real time as if it were the mic and times key-release → text for each mode. Never pastes (needs the key). |
| `npm test` | Runs the unit tests. |

## Known limits (v1)
- **Terminals:** most terminals paste with Ctrl+Shift+V, so Ctrl+V does nothing there. Use `GSTT_RESTORE_CLIPBOARD=0` and paste by hand, or dictate into other apps.
- **Wait time:** the text appears after you let go, once Gemini replies (usually about 1–2 s). There's no live preview.
- **Unplugged keyboards:** a keyboard plugged in after starting isn't picked up. Restart the app.
- **Non-text clipboard:** if your clipboard held an image, it isn't restored, but it isn't overwritten until the paste either.
- **Audio limit:** clips are sent inline, which caps them at about 20 MB (roughly 10 minutes of audio).

## Silence check
Before anything is sent, the clip's loudest 50 ms must be louder than `GSTT_SILENCE_DB` (default `-40` dBFS). Quieter clips are dropped without calling Gemini, because models tend to invent text for silence.

If quiet speech gets dropped, lower the threshold in `.env`, e.g. `GSTT_SILENCE_DB=-48`. To see your mic's levels, run `node src/cli.js test-record 3`.

## Live mode

Live is the default. To use one-shot instead, set `GSTT_MODE=oneshot` in `.env`.

How it works:
- **Key down:** opens a Live API session and streams mic audio in 100 ms chunks.
- **Speaking:** turn detection is manual, so a pause doesn't split your dictation. With automatic detection the model cut in mid-sentence.
- **Key up:** ends the turn. The full transcript arrives within about 0.4 s, then gets the same text cleanup and dictionary. The model's spoken reply (`gemini-3.8-live` only replies in audio) is ignored, and the session is closed.
- **Failures:** if the live session fails, the recorded audio is sent the one-shot way instead, so nothing is lost.

Measured with `bench`: a 13 s dictation clip, replayed in real time, from key release to finished text.

| | One-shot | Live |
|---|---|---|
| 13 s clip, 5 rounds | 1951–2886 ms (avg 2490) | 1057–1239 ms (avg 1184) |
| 40 s clip, 2 rounds | 5498 / 1831 ms | 1312 / 1240 ms |

Both modes produced the same cleaned text. Live also stays flat as dictations get longer.

Trade-offs:
- **Cost:** live keeps a session open while you hold the key and pays for a short audio reply each time.
- **Wasted sessions:** a session opens on every hold, including holds that end up cancelled.

## Try on Windows

The Gemini core is shared by both systems: live and one-shot modes, cleanup, dictionary and the silence check. Only three pieces differ per OS (`src/platform/`):

| | Linux | Windows |
|---|---|---|
| Hotkey | evdev (`/dev/input`) | Global low-level keyboard hook (`uiohook-napi`, prebuilt) |
| Start menu / Launcher | Taps F24 through `/dev/uinput` | Taps F24 through the hook (SendInput) while Win is held |
| Microphone | `pw-record` | Bundled ffmpeg (`@ffmpeg-installer/win32-x64`, installed only on Windows), DirectShow |
| Paste | wl-clipboard/xclip + ydotool/xdotool | PowerShell `Get-/Set-Clipboard` + SendInput Ctrl+V |

To try it:
1. Install Node.js 22 LTS or newer from https://nodejs.org.
2. Copy the project folder over, without `node_modules`. In PowerShell:
   ```
   cd gemini-speech-to-text
   npm install
   copy .env.example .env
   notepad .env
   ```
   In Notepad, set `GEMINI_API_KEY=...` and save.
3. Optional check: `node src\cli.js devices` should list your microphone(s). `node src\cli.js test-record 3` records a test clip.
4. Run `npm start`. Click into Notepad, hold **Ctrl+Win**, talk, and let go.

Settings are the same as on Linux. `GSTT_MIC` picks a microphone by name (from `devices`); the default is the first one. `GSTT_HOTKEY=CTRL+WIN` is the same as `CTRL+SUPER`. Logs go to `%LOCALAPPDATA%\gemini-speech-to-text\gemini-speech-to-text.log`.

**Not yet tested on Windows.** It was written on Linux, and only the logic is unit-tested there. These need checking on a real Windows machine:
- `uiohook-napi` loading and seeing Ctrl+Win in every app, including elevated (admin) windows. A non-admin process can't hook those, which is a Windows rule.
- The F24 tap actually keeping the Start menu closed when Win is released.
- ffmpeg DirectShow capture: device naming, about 50 ms of buffering, and quitting cleanly on `q`.
- PowerShell clipboard speed (about 0.3–0.5 s per call adds paste delay) and Unicode round-trip. The tray app will switch to Electron's built-in clipboard.
- Paste into UWP/Store apps and terminals (Windows Terminal pastes on Ctrl+V; older consoles may not).
- Sounds use the built-in Windows media files and are untested.

## Tray app

The tray app is the same engine with a tray icon and a Settings window. It's the easiest way to use the app day to day.

- **Tray icon:** gray when ready, red while recording, amber while transcribing. The menu has: the current status, a mode switch (Live / One-shot), Settings…, Start at login, Open log, and Quit.
- **Settings:** API key, mode, hotkey, silence cutoff, sounds (start of recording and after pasting, each on or off) and start at login. The sounds can also be toggled from the tray menu (Sounds). On first launch with no key, Settings opens by itself.
  - The **API key** is encrypted with the OS keychain (Electron `safeStorage`: Secret Service/gnome-keyring on Linux, DPAPI on Windows) and saved in the app's config folder. It is never stored as plain text and never sent to the Settings page; the page can only tell whether a key exists. **Test** checks a key with one small Gemini request.
  - For development, the repo's `.env` (`GEMINI_API_KEY` / `VOICE_DEV_GEMINI_KEY`) still works when no key is saved.
- **Start at login:** Linux writes `~/.config/autostart/gemini-speech-to-text.desktop`; Windows uses the standard login item.
- **Errors** show as desktop notifications and in the tray menu. Details are in the log (Tray → Open log).

Run it from the repo:

```bash
npm run app
```

### Installers

```bash
npm run dist:linux
```
```bash
npm run dist:win
```

These write to `dist/`:

| File | For |
|---|---|
| `gemini-speech-to-text-<version>.AppImage` | Any Linux. `chmod +x`, then double-click. |
| `gemini-speech-to-text_<version>_amd64.deb` | Pop!_OS / Ubuntu / Debian: `sudo apt install ./gemini-speech-to-text_<version>_amd64.deb`. Pulls in python3, wl-clipboard, ydotool and pipewire. Replaces the old `flowcode` package if it's installed. |
| `Gemini Speech to Text Setup <version>.exe` | Windows (per-user install, no admin). Unsigned, so SmartScreen will warn ("More info" → "Run anyway"). |

- **Linux needs:** your user in the `input` group, and `ydotoold` running for paste. See Permissions.
- **Building Windows on Linux:** `dist:win` fetches the Windows ffmpeg (`scripts/fetch-win-ffmpeg.mjs`) and needs Wine, which builds fine on Linux. Electron itself doesn't run under Wine, so the Windows build has only been checked for contents, not run.
- **No terminal needed:** the app works when started from a file manager, menu or autostart. `src/stdio-guard.js` sends console output to the log when there's no usable terminal, so missing stdout/stderr can't crash it.

## Renamed from flowcode

This app used to be called **flowcode**. Version 0.1.1 renames it everywhere, and nothing is lost:
- **Settings and saved API key:** carried over automatically on the first start (the key is moved from the old keychain entry to the new one).
- **Log folder:** moved to the new name.
- **Autostart:** an old `flowcode` autostart entry is replaced with the new one.
- **Environment variables:** now start with `GSTT_`. The old `FLOWCODE_` names still work as a fallback.
- **Old .deb:** installing the new one removes the `flowcode` package. You can also remove it yourself with `sudo apt remove flowcode`.
