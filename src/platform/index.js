// Picks the hotkey / microphone / paste layer for this OS. Everything else
// (Gemini one-shot and live, cleanup, dictionary, silence check) is shared.

export async function loadPlatform(platform = process.platform) {
  if (platform === 'linux') return import('./linux.js');
  if (platform === 'win32') return import('./windows.js');
  throw new Error(`Gemini Speech to Text doesn't support ${platform} yet (Linux and Windows only).`);
}
