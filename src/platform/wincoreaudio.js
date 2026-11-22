// Windows Core Audio (MMDevice API) from a long-lived hidden PowerShell:
// the capture endpoints with their friendly names, which one is the default
// recording device right now, and whether each is muted in Windows.
//
// DirectShow (ffmpeg) knows none of this: it lists devices in driver order.
// Its "Alternative name" for a mic ends in wave_{GUID}, and that GUID is the
// same one as in the Core Audio endpoint id {0.0.1.00000000}.{GUID}, which is
// how the Windows default is mapped to a dshow device.
//
// The C# is compiled once when the helper starts (about a second, done in the
// background); each query after that takes a few milliseconds.

import { spawn } from 'node:child_process';

const CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class GsttMMDeviceEnumerator {}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IGsttEnum {
  int EnumAudioEndpoints(int dataFlow, int mask, out IGsttColl devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IGsttDev endpoint);
}
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IGsttColl { int GetCount(out int n); int Item(int i, out IGsttDev d); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IGsttDev {
  int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  int OpenPropertyStore(int access, out IGsttProps store);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetState(out int state);
}
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IGsttProps { int GetCount(out int c); int GetAt(int i, out GsttKey k); int GetValue(ref GsttKey k, out GsttVariant v); }
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IGsttVolume {
  int R(IntPtr p); int U(IntPtr p); int GetChannelCount(out int c);
  int SetMasterVolumeLevel(float l, ref Guid g); int SetMasterVolumeLevelScalar(float l, ref Guid g);
  int GetMasterVolumeLevel(out float l); int GetMasterVolumeLevelScalar(out float l);
  int A(); int B(); int C(); int D();
  int SetMute(bool m, ref Guid g); int GetMute(out bool m);
}
[StructLayout(LayoutKind.Sequential)] public struct GsttKey { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Sequential)] public struct GsttVariant { public short vt; short a, b, c; public IntPtr p; IntPtr p2; }
public static class GsttCoreAudio {
  static string Str(string s) {
    if (s == null) return "null";
    var b = new StringBuilder("\"");
    foreach (char ch in s) {
      if (ch == '"' || ch == '\\') b.Append('\\').Append(ch);
      else if (ch < ' ') b.Append("\\u").Append(((int)ch).ToString("x4"));
      else b.Append(ch);
    }
    return b.Append('"').ToString();
  }
  static string Name(IGsttDev d) {
    IGsttProps s; d.OpenPropertyStore(0, out s);
    var k = new GsttKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    GsttVariant v; s.GetValue(ref k, out v);
    return v.vt == 31 ? Marshal.PtrToStringUni(v.p) : null;
  }
  static string DefaultId(IGsttEnum e, int role) {
    IGsttDev d; if (e.GetDefaultAudioEndpoint(1, role, out d) != 0 || d == null) return null;
    string id; d.GetId(out id); return id;
  }
  public static string List() {
    var e = (IGsttEnum)new GsttMMDeviceEnumerator();
    string def = DefaultId(e, 0), comms = DefaultId(e, 2);
    IGsttColl c; e.EnumAudioEndpoints(1, 0xF, out c);
    int n; c.GetCount(out n);
    var b = new StringBuilder("[");
    for (int i = 0; i < n; i++) {
      IGsttDev d; c.Item(i, out d);
      string id; d.GetId(out id); int st; d.GetState(out st);
      string name = null; try { name = Name(d); } catch {}
      string muted = "null", vol = "null";
      if (st == 1) {
        try {
          var iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A"); object o;
          d.Activate(ref iid, 23, IntPtr.Zero, out o);
          var v = (IGsttVolume)o; bool m; v.GetMute(out m); float s; v.GetMasterVolumeLevelScalar(out s);
          muted = m ? "true" : "false"; vol = Math.Round(s * 100).ToString();
        } catch {}
      }
      if (i > 0) b.Append(',');
      b.Append("{\"id\":").Append(Str(id)).Append(",\"name\":").Append(Str(name))
       .Append(",\"state\":").Append(st).Append(",\"muted\":").Append(muted).Append(",\"volume\":").Append(vol)
       .Append(",\"isDefault\":").Append(id == def ? "true" : "false")
       .Append(",\"isDefaultComms\":").Append(id == comms ? "true" : "false").Append('}');
    }
    return b.Append(']').ToString();
  }
}
`;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
${CSHARP}
'@
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { $out = [GsttCoreAudio]::List() } catch { $out = '{"error":' + (ConvertTo-Json ([string]$_)) + '}' }
  [Console]::Out.WriteLine($out)
}
`;

export const ENDPOINT_ACTIVE = 1;

// "{0.0.1.00000000}.{aef32a67-...}" or "...\wave_{AEF32A67-...}" -> "aef32a67-..."
export function endpointGuid(id) {
  const m = String(id ?? '').match(/\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\s*$/i);
  return m ? m[1].toLowerCase() : null;
}

// The dshow device (from parseDshowAudioDeviceList) for a Core Audio endpoint.
export function dshowDeviceForEndpoint(dshowDevices, endpoint) {
  const guid = endpointGuid(endpoint?.id);
  return (guid && dshowDevices.find((d) => endpointGuid(d.altName) === guid))
    || dshowDevices.find((d) => d.name === endpoint?.name)
    || null;
}

export class CoreAudioHelper {
  // startTimeoutMs: compiling the C# can be slow (antivirus scan); a caller
  // never waits longer than this for it, it just gets null (unknown).
  constructor({ spawnFn = spawn, timeoutMs = 4000, startTimeoutMs = 3000 } = {}) {
    this.spawnFn = spawnFn;
    this.timeoutMs = timeoutMs;
    this.startTimeoutMs = startTimeoutMs;
    this.proc = null;
    this.failed = null;
  }

  ensure() {
    if (this.proc || this.failed) return;
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const p = this.spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p;
    this.queue = [];
    let buf = '';
    let err = '';
    this.ready = new Promise((resolve) => { this.onReady = resolve; });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (line === 'ready') { this.onReady(true); continue; }
        this.queue.shift()?.(line);
      }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.stdin.on('error', () => {});
    // Never keep the process (e.g. the CLI) alive just for this helper; it's
    // ref'd only while a query is waiting for its answer.
    this.hold(false);
    const gone = (why) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.failed = why || err.trim().split(/\r?\n/)[0] || 'Core Audio helper exited';
      this.onReady(false);
      for (const fn of this.queue.splice(0)) fn(null);
    };
    p.on('error', (e) => gone(e.message));
    p.on('exit', () => gone());
  }

  hold(on) {
    const p = this.proc;
    for (const h of [p, p?.stdin, p?.stdout, p?.stderr]) { try { on ? h?.ref?.() : h?.unref?.(); } catch { /* closed */ } }
  }

  // Capture endpoints: [{ id, name, state, muted, volume, isDefault, isDefaultComms }],
  // or null if Core Audio can't be reached (the caller then falls back).
  async endpoints() {
    this.ensure();
    if (!this.proc) return null;
    this.pending = (this.pending ?? 0) + 1;
    this.hold(true);
    try {
      return await this.query();
    } finally {
      if (--this.pending === 0) this.hold(false);
    }
  }

  async query() {
    const started = await Promise.race([this.ready, new Promise((r) => setTimeout(() => r(false), this.startTimeoutMs))]);
    if (!started) return null;
    const line = await new Promise((resolve) => {
      const timer = setTimeout(() => { const i = this.queue.indexOf(done); if (i >= 0) this.queue.splice(i, 1); resolve(null); }, this.timeoutMs);
      const done = (l) => { clearTimeout(timer); resolve(l); };
      this.queue.push(done);
      this.proc.stdin.write('list\n');
    });
    if (!line) return null;
    try {
      const v = JSON.parse(line);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    try { p?.stdin.end(); p?.kill(); } catch { /* already gone */ }
  }
}
