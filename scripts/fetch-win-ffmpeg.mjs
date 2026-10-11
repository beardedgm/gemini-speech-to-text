// Puts ffmpeg.exe in build/vendor/win32-x64/ for the Windows installer.
// npm only installs @ffmpeg-installer/win32-x64 on Windows, so when building
// the installer elsewhere we fetch the same pinned package tarball directly.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'vendor', 'win32-x64');
const PKG = '@ffmpeg-installer/win32-x64@4.1.0';
const target = path.join(OUT, 'ffmpeg.exe');

if (fs.existsSync(target)) {
  console.log(`${target} already present`);
} else {
  fs.mkdirSync(OUT, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const tgz = execFileSync(npm, ['pack', PKG, '--silent', '--pack-destination', OUT], { encoding: 'utf8', shell: process.platform === 'win32' }).trim().split('\n').pop();
  execFileSync('tar', ['-xzf', path.join(OUT, tgz), '-C', OUT, '--strip-components=1', 'package/ffmpeg.exe']);
  fs.rmSync(path.join(OUT, tgz));
  console.log(`ffmpeg.exe (${(fs.statSync(target).size / 1e6).toFixed(1)} MB) -> ${target}`);
}
