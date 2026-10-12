// Generates the tray and app icons as PNGs (no image tools needed):
// a microphone on a colored disc. Run: node scripts/make-icons.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed-distance shapes in unit coordinates (0..1), 4x4 supersampled.
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function micShape(x, y) {
  const capsule = sdRoundRect(x, y, 0.5, 0.40, 0.10, 0.17, 0.10);
  // U-shaped holder: ring segment below the capsule's middle
  const ring = Math.abs(sdCircle(x, y, 0.5, 0.42, 0.19)) - 0.03;
  const holder = y > 0.42 ? ring : Infinity;
  const stem = sdRoundRect(x, y, 0.5, 0.69, 0.03, 0.07, 0.01);
  const base = sdRoundRect(x, y, 0.5, 0.765, 0.12, 0.03, 0.02);
  return Math.min(capsule, holder, stem, base);
}

// Level meter: five vertical bars, the first `lit` drawn bright.
function meterShape(lit) {
  return (x, y) => {
    const heights = [0.18, 0.28, 0.38, 0.28, 0.18];
    let inside = false, on = false;
    heights.forEach((h, i) => {
      const cx = 0.26 + i * 0.12;
      if (sdRoundRect(x, y, cx, 0.5, 0.04, h, 0.035) <= 0) { inside = true; on = i < lit; }
    });
    return inside ? (on ? 1 : 0.35) : 0;
  };
}

// Microphone with a diagonal slash (mic off).
function micOffShape(x, y) {
  const slash = Math.abs((x - 0.5) + (y - 0.5)) / Math.SQRT2 - 0.045;
  const inBand = Math.abs(x - y) < 0.62;
  return Math.min(micShape(x, y), inBand ? slash : Infinity) <= 0 ? 1 : 0;
}

function drawWith(size, disc, shape) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let a = 0, white = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const x = (px + (sx + 0.5) / S) / size, y = (py + (sy + 0.5) / S) / size;
        if (sdCircle(x, y, 0.5, 0.5, 0.48) <= 0) { a++; white += shape(x, y); }
      }
      const cov = a / (S * S), w = a ? white / a : 0;
      const i = (py * size + px) * 4;
      buf[i] = Math.round(disc[0] * (1 - w) + 255 * w);
      buf[i + 1] = Math.round(disc[1] * (1 - w) + 255 * w);
      buf[i + 2] = Math.round(disc[2] * (1 - w) + 255 * w);
      buf[i + 3] = Math.round(255 * cov);
    }
  }
  return png(size, buf);
}

function draw(size, disc) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let a = 0, white = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const x = (px + (sx + 0.5) / S) / size, y = (py + (sy + 0.5) / S) / size;
        if (sdCircle(x, y, 0.5, 0.5, 0.48) <= 0) { a++; if (micShape(x, y) <= 0) white++; }
      }
      const cov = a / (S * S), w = a ? white / a : 0;
      const i = (py * size + px) * 4;
      buf[i] = Math.round(disc[0] * (1 - w) + 255 * w);
      buf[i + 1] = Math.round(disc[1] * (1 - w) + 255 * w);
      buf[i + 2] = Math.round(disc[2] * (1 - w) + 255 * w);
      buf[i + 3] = Math.round(255 * cov);
    }
  }
  return png(size, buf);
}

const COLORS = {
  idle: [92, 99, 112],      // slate
  recording: [220, 38, 38], // red
  working: [217, 119, 6],   // amber
  app: [79, 70, 229],       // indigo
};

fs.mkdirSync(OUT, { recursive: true });
for (const state of ['idle', 'recording', 'working']) {
  fs.writeFileSync(path.join(OUT, `tray-${state}.png`), draw(32, COLORS[state]));
  fs.writeFileSync(path.join(OUT, `tray-${state}@2x.png`), draw(64, COLORS[state]));
}
fs.writeFileSync(path.join(OUT, 'icon.png'), draw(512, COLORS.app));
// Live level frames while recording (0 = silent ... 5 = loud), and mic-off.
for (let lit = 0; lit <= 5; lit++) {
  fs.writeFileSync(path.join(OUT, `tray-level-${lit}.png`), drawWith(32, COLORS.recording, meterShape(lit)));
  fs.writeFileSync(path.join(OUT, `tray-level-${lit}@2x.png`), drawWith(64, COLORS.recording, meterShape(lit)));
}
fs.writeFileSync(path.join(OUT, 'tray-mic-off.png'), drawWith(32, [127, 29, 29], micOffShape));
fs.writeFileSync(path.join(OUT, 'tray-mic-off@2x.png'), drawWith(64, [127, 29, 29], micOffShape));
console.log(`icons written to ${OUT}`);
