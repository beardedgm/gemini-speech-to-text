// The Settings "Test" button for capture paths built on Recorder (PipeWire on
// Linux, ffmpeg on Windows when the tray app's own capture isn't available):
// record a few seconds from one mic, report live levels, then a verdict.

import { chunkLevelDb } from './micmonitor.js';
import { isDefaultMic, resolveMic, testVerdict } from './mics.js';

// platform: { createRecorder, listMicrophones }. mic: a choice (src/mics.js).
// onLevel(dBFS) is called for each chunk. Resolves with testVerdict(...) plus
// { maxDb, name }.
export async function testMicrophone(platform, mic, { seconds = 3, onLevel = () => {}, listing = null } = {}) {
  const { devices = [], defaultName = null } = listing ?? (await platform.listMicrophones?.()) ?? {};
  let target = mic;
  let name = isDefaultMic(mic) ? defaultName : mic.name;
  if (!isDefaultMic(mic) && devices.length) {
    const { device } = resolveMic(devices, mic);
    if (!device) return { ...testVerdict({ error: 'it isn\'t connected' }), maxDb: -Infinity, name };
    target = { id: device.id, name: device.name };
    name = device.name;
  }
  const rec = platform.createRecorder();
  let bytes = 0;
  let maxDb = -Infinity;
  try {
    await rec.prepare?.();
    rec.start({
      mic: target,
      onChunk: (c) => {
        bytes += c.length;
        const db = chunkLevelDb(c);
        if (db > maxDb) maxDb = db;
        onLevel(db);
      },
    });
  } catch (e) {
    return { ...testVerdict({ error: e.message }), maxDb, name };
  }
  await new Promise((r) => setTimeout(r, seconds * 1000));
  let error = null;
  try { await rec.stop(); } catch (e) { error = e.openFailed ?? null; }
  return { ...testVerdict({ error, bytes, maxDb }), maxDb, name: rec.micName ?? name };
}

// Every mic at once (separate devices can be captured in parallel).
export async function testAllMicrophones(platform, { seconds = 3 } = {}) {
  const listing = (await platform.listMicrophones?.()) ?? { devices: [] };
  return Promise.all(listing.devices.map(async (d) => ({
    id: d.id,
    ...(await testMicrophone(platform, { id: d.id, name: d.name }, { seconds, listing })),
  })));
}
