#!/usr/bin/env node
/**
 * Cable & Charging Monitor — API + static server (zero dependencies, macOS).
 *
 * Endpoints:
 *   GET /api/status       → link speed + live MB/s (iostat) + charging/power,
 *                           plus the last full benchmark if present.
 *   GET /api/benchmark    → runs a full dd read benchmark (takes a few
 *                           seconds on a slow link) and returns throughput.
 *   GET /api/cable-speed  → legacy alias for the cable part of /api/status.
 *
 * Also serves the built React app from ./dist on the same port.
 *
 * Data sources (all macOS-native):
 *   - ioreg -p IOUSB            negotiated USB link speed of the drive
 *   - iostat -d -w 1            real-time MB/s off the external disk
 *   - ioreg -rn AppleSmartBattery  battery %, charging, live amperage/voltage
 *   - system_profiler SPPowerDataType  charger wattage + battery health
 *   - dd read benchmark         full-throughput measurement on demand
 *
 * Env overrides:
 *   CABLE_MONITOR_PORT (default 8787)  — note: NOT plain PORT, which is
 *       already used by other tools in this environment.
 *   VOLUME  (default: first /Volumes/* entry, prefers *AI_DRIVE*)
 *   MAX_FILE (pin the file used for the dd benchmark)
 */
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.CABLE_MONITOR_PORT || 8787);
const DIST = path.join(__dirname, 'dist');
const VOLUME = process.env.VOLUME || null;
const MAX_FILE = process.env.MAX_FILE || null;

// IOKit "Device Speed" codes → negotiated USB spec.
const USB_SPEEDS = {
  0: { label: 'USB 1.0', mbps: 1.5 },
  1: { label: 'USB 1.1', mbps: 12 },
  2: { label: 'USB 2.0', mbps: 480 },
  3: { label: 'USB 3.0 / 3.2 Gen 1', mbps: 5000 },
  4: { label: 'USB 3.2 Gen 2', mbps: 10000 },
  5: { label: 'USB 3.2 Gen 2x2 / USB4', mbps: 20000 },
};

// Realistic sustained read speed for a SanDisk Extreme (spec ~1050 MB/s).
const EXTREME_CAPABLE_MBPS = 10000;
const EXTREME_CAPABLE_MB_PER_SEC = 1000;

// ---------- WebSocket (RFC 6455, zero dependencies) ----------
// Push-only live stream: the server broadcasts status JSON every ~1.5s to
// every connected client. Client frames are mostly ignored (browsers
// auto-answer pings, and reconnects handle dropped connections).
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set();
let pushTimer = null;
let pingTimer = null;
let pushing = false;

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.from(payload, 'utf8');
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
  const client = { socket, alive: true };
  clients.add(client);
  socket.setNoDelay(true);
  socket.on('data', (buf) => {
    // Minimal client-frame handling: answer empty pings, honor close.
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    const len = buf[1] & 0x7f;
    if (opcode === 0x9 && len === 0) socket.write(encodeFrame('', 0xA)); // ping → pong
    else if (opcode === 0x8) socket.end(); // close
  });
  socket.on('close', () => clients.delete(client));
  socket.on('error', () => clients.delete(client));
  ensurePushLoop();
}

async function broadcast(precomputed) {
  if (!clients.size) return;
  const payload = JSON.stringify(precomputed || (await statusPayload()));
  for (const c of clients) {
    try {
      c.socket.write(encodeFrame(payload));
    } catch {
      /* drop dead clients */
    }
  }
}

function ensurePushLoop() {
  if (pushTimer) return;
  pushTimer = setInterval(async () => {
    if (!clients.size) {
      clearInterval(pushTimer);
      pushTimer = null;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      return;
    }
    if (pushing) return; // previous cycle still running
    pushing = true;
    try {
      await broadcast();
    } catch {
      /* keep the loop alive */
    } finally {
      pushing = false;
    }
  }, 1500);
  if (!pingTimer) {
    pingTimer = setInterval(() => {
      if (!clients.size) return;
      for (const c of clients) {
        try {
          c.socket.write(encodeFrame('', 0x9));
        } catch {
          /* ignore */
        }
      }
    }, 25000);
  }
}

function run(cmd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code === undefined ? 1 : err.code) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

// ---------- USB link speed ----------
function parseIOReg(out) {
  const devices = [];
  let cur = null;
  for (const line of out.split('\n')) {
    const prod = line.match(/"USB Product Name"\s*=\s*"([^"]*)"/);
    const vend = line.match(/"USB Vendor Name"\s*=\s*"([^"]*)"/);
    const speed = line.match(/"Device Speed"\s*=\s*(\d+)/);
    if (prod) {
      cur = { product: prod[1] };
      devices.push(cur);
    }
    if (cur && vend) cur.vendor = vend[1];
    if (cur && speed) cur.speed = Number(speed[1]);
  }
  return devices;
}

async function linkSpeed() {
  const r = await run('ioreg -p IOUSB -l -w 0 2>/dev/null');
  const devices = parseIOReg(r.stdout);
  const candidate =
    devices.find((d) => d.product && d.speed !== undefined && !/root hub/i.test(d.product)) ||
    devices[0] ||
    null;
  if (!candidate) return { device: null };
  const info = USB_SPEEDS[candidate.speed] || { label: `Unknown (code ${candidate.speed})`, mbps: null };
  return { device: { product: candidate.product, vendor: candidate.vendor || null, speed_code: candidate.speed, speed_label: info.label, speed_mbps: info.mbps } };
}

// ---------- Volume / disk discovery ----------
async function detectVolumes() {
  const r = await run('ls -d /Volumes/* 2>/dev/null');
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

let _diskCache = null; // { volume, disk, ts }
async function diskFor(volume) {
  if (_diskCache && _diskCache.volume === volume && Date.now() - _diskCache.ts < 30000) {
    return _diskCache.disk;
  }
  // 1) Parent whole disk of the volume — often a synthesized APFS
  //    container (disk5s1 → disk5). NOTE: plist uses ParentWholeDisk as a
  //    string; WholeDisk is a <false/> boolean for partitions.
  const info = await run(`diskutil info -plist "${volume}" 2>/dev/null`);
  const whole = ((info.stdout || '').match(
    /<key>ParentWholeDisk<\/key>\s*<string>([^<]+)<\/string>/
  ) || [])[1] || null;
  // 2) iostat needs the PHYSICAL disk. Map the container to its APFS
  //    physical store (disk4s1 → disk4), falling back to the whole disk.
  let disk = null;
  if (whole) {
    const apfs = await run('diskutil apfs list 2>/dev/null');
    const store = (apfs.stdout || '').match(
      new RegExp(`APFS Container Reference:\\s+${whole}\\b[\\s\\S]*?Physical Store Disk:\\s+(disk\\d+s\\d+)`)
    );
    disk = store ? store[1].replace(/s\d+$/, '') : whole.replace(/s\d+$/, '');
  }
  _diskCache = { volume, disk, ts: Date.now() };
  return disk;
}

// ---------- Real-time throughput (1s iostat sample) ----------
// One iostat call samples EVERY physical disk at once.
async function liveMBsAll(disks) {
  if (!disks || !disks.length) return {};
  const r = await run(`iostat -d -w 1 -c 2 ${disks.join(' ')} 2>/dev/null`);
  const lines = (r.stdout || '').split('\n').filter((l) => l.trim());
  if (lines.length < 3) return {};
  const names = lines[0].trim().split(/\s+/);
  const last = lines[lines.length - 1].trim().split(/\s+/);
  const res = {};
  names.forEach((n, i) => {
    const v = parseFloat(last[i * 3 + 2]); // MB/s column within the disk's group
    res[n] = Number.isFinite(v) ? v : null;
  });
  return res;
}

// ---------- Drive enumeration (external volumes, boot volume excluded) ----------
let _drivesCache = null; // { ts, drives }
async function enumerateDrives() {
  if (_drivesCache && Date.now() - _drivesCache.ts < 10000) return _drivesCache.drives;
  const vols = await detectVolumes();
  const boot = await run('diskutil info -plist / 2>/dev/null');
  const bootWhole = ((boot.stdout || '').match(
    /<key>ParentWholeDisk<\/key>\s*<string>([^<]+)<\/string>/
  ) || [])[1] || null;
  const plistStr = (s, key) => {
    const m = s.match(new RegExp(`<key>${key}<\\/key>\\s*<string>([^<]+)<\\/string>`));
    return m ? m[1] : null;
  };
  const drives = [];
  for (const vol of vols) {
    const info = await run(`diskutil info -plist "${vol}" 2>/dev/null`);
    const out = info.stdout || '';
    const whole = plistStr(out, 'ParentWholeDisk');
    if (whole && bootWhole && whole === bootWhole) continue; // internal boot volume
    const ejectable = /<key>Ejectable<\/key>\s*<true\/>/.test(out);
    if (!ejectable) continue; // only external drives have a "cable"
    const ident = plistStr(out, 'DeviceIdentifier');
    drives.push({
      name: path.basename(vol),
      volume: vol,
      disk: await diskFor(vol),
      protocol: plistStr(out, 'Protocol') || null,
      removable: /<key>Removable<\/key>\s*<true\/>/.test(out),
    });
  }
  _drivesCache = { ts: Date.now(), drives };
  return drives;
}

// ---------- Charging / power ----------
let _powerStaticCache = null; // { ts, data }
async function powerStatic() {
  if (_powerStaticCache && Date.now() - _powerStaticCache.ts < 15000) {
    return _powerStaticCache.data;
  }
  const r = await run('system_profiler SPPowerDataType 2>/dev/null');
  const out = r.stdout || '';
  const grab = (re) => {
    const m = out.match(re);
    return m ? m[1] : null;
  };
  const data = {
    ac_connected: grab(/AC Charger Information:[\s\S]*?Connected:\s*(Yes|No)/) === 'Yes',
    charger_watts: grab(/Wattage \(W\):\s*(\d+)/) ? Number(grab(/Wattage \(W\):\s*(\d+)/)) : null,
    battery_percent: grab(/State of Charge \(%\):\s*(\d+)/) ? Number(grab(/State of Charge \(%\):\s*(\d+)/)) : null,
    fully_charged: grab(/Fully Charged:\s*(Yes|No)/) === 'Yes',
    charging: grab(/Charging:\s*(Yes|No)/) === 'Yes',
    cycle_count: grab(/Cycle Count:\s*(\d+)/) ? Number(grab(/Cycle Count:\s*(\d+)/)) : null,
    max_capacity_pct: grab(/Maximum Capacity:\s*(\d+)%/) ? Number(grab(/Maximum Capacity:\s*(\d+)%/)) : null,
    condition: grab(/Condition:\s*([A-Za-z ]+)/) ? grab(/Condition:\s*([A-Za-z ]+)/).trim() : null,
  };
  _powerStaticCache = { ts: Date.now(), data };
  return data;
}

async function powerLive() {
  const r = await run('ioreg -rn AppleSmartBattery 2>/dev/null');
  const out = r.stdout || '';
  const num = (k) => {
    const m = out.match(new RegExp(`"${k}"\\s*=\\s*(-?\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const str = (k) => {
    const m = out.match(new RegExp(`"${k}"\\s*=\\s*(Yes|No)`));
    return m ? m[1] : null;
  };
  let amperageMa = num('Amperage');
  // ioreg can print the signed amperage as an unsigned 64-bit value
  // (e.g. -1616 mA appears as 18446744073709550000). Reinterpret as signed.
  if (amperageMa !== null && amperageMa > 2147483647) {
    amperageMa -= 18446744073709551616;
  }
  const voltageMv = num('Voltage');
  // Sanity bounds: battery currents stay within ±20 A; pack voltage within 8–16 V.
  const saneA = amperageMa !== null && Math.abs(amperageMa) <= 20000 ? amperageMa : null;
  const saneV = voltageMv !== null && voltageMv >= 8000 && voltageMv <= 16000 ? voltageMv : null;
  const liveWatts = saneA !== null && saneV !== null
    ? Math.round((Math.abs(saneA) * saneV / 1e6) * 10) / 10
    : null;
  return {
    battery_percent: num('CurrentCapacity'),
    charging: str('IsCharging') === 'Yes',
    fully_charged: str('FullyCharged') === 'Yes',
    amperage_ma: saneA,
    voltage_mv: saneV,
    live_watts: liveWatts,
  };
}

// ---------- Full dd benchmark ----------
let _fileCache = null; // { volume, file, ts }
async function findBenchFile(volume) {
  if (_fileCache && _fileCache.volume === volume && Date.now() - _fileCache.ts < 600000) {
    return _fileCache.file;
  }
  // Full-drive finds take ~20s+ on a slow USB link (every dirent must be
  // read). Try the shallow scan first — it finds big files in ~0.1s — and
  // only fall back to a deep walk if the volume is flat.
  const candidates = [
    `find "${volume}" -maxdepth 3 -type f -size +128M -not -path "*/.Trash/*" 2>/dev/null | head -1`,
    `find "${volume}" -type f -size +512M -not -path "*/.Trash/*" 2>/dev/null | head -1`,
    `find "${volume}" -type f -size +16M -not -path "*/.Trash/*" 2>/dev/null | head -1`,
  ];
  for (const cmd of candidates) {
    const r = await run(cmd, 45000);
    const f = (r.stdout || '').trim();
    if (f) {
      _fileCache = { volume, file: f, ts: Date.now() };
      return f;
    }
  }
  _fileCache = { volume, file: null, ts: Date.now() };
  return null;
}

async function benchmark(file) {
  const r = await run(`dd if="${file}" of=/dev/null bs=1m count=256 2>&1`, 60000);
  const out = r.stdout || r.stderr || '';
  const m = out.match(/\(([\d.]+) bytes\/sec\)/);
  if (!m) return { ok: false, note: 'dd benchmark failed', raw: out.slice(0, 300) };
  const bps = Number(m[1]);
  return { ok: true, bytes_per_sec: Math.round(bps), mb_per_sec: Math.round((bps / 1e6) * 10) / 10 };
}

// ---------- Verdict ----------
function buildVerdict(speedCode, measuredMBs, capableMBs) {
  const linkedAtUSB2 = speedCode === 2;
  if (measuredMBs === null) {
    return linkedAtUSB2
      ? {
          level: 'bottleneck',
          title: 'BOTTLENECK — USB 2.0',
          color: '#ff453a',
          guidance:
            'The drive is negotiating at USB 2.0 (480 Mbps) — roughly 28x less bandwidth than it is capable of. ' +
            'Run a full speed test to confirm, then: 1) fully unplug the cable from BOTH the drive and the Mac, wait 10–15s, replug directly (no hub); ' +
            '2) use the cable that shipped with the drive — most generic USB-C cables are USB 2.0 data; ' +
            '3) if it still negotiates at 2.0 on another computer too, the drive\u2019s USB-C port is damaged or failing.',
        }
      : {
          level: 'unknown',
          title: 'No measurement',
          color: '#a1a1a6',
          guidance: 'Run a full speed test to measure real throughput. Link is ' +
            (USB_SPEEDS[speedCode]?.label || 'unknown') + '.',
        };
  }
  const ratio = capableMBs ? measuredMBs / capableMBs : null;
  if (linkedAtUSB2 || measuredMBs < 60) {
    return {
      level: 'bottleneck',
      title: 'BOTTLENECK — USB 2.0',
      color: '#ff453a',
      ratio,
      guidance:
        'Confirmed: the drive negotiates at USB 2.0 (480 Mbps) and reads at ~' + Math.round(measuredMBs) +
        ' MB/s. Fixes, in order: 1) fully unplug the cable from BOTH the drive and the Mac, wait 10–15s, replug directly (no hub); ' +
        '2) use the cable that shipped with the drive — most generic USB-C cables are USB 2.0 data; ' +
        '3) if it still negotiates at 2.0 on another computer too, the drive\u2019s USB-C port is damaged or failing.',
    };
  }
  if (ratio !== null && ratio < 0.4) {
    return {
      level: 'slow',
      title: 'SLOW — far below capability',
      color: '#ff9f0a',
      ratio,
      guidance:
        'The link is SuperSpeed but real throughput is well below the drive\u2019s capability. Check for a worn cable, a marginal port, or heavy background I/O during the test.',
    };
  }
  return {
    level: 'good',
    title: 'GOOD — full speed',
    color: '#32d74b',
    ratio,
    guidance:
      'The drive runs at its expected speed. If the game still stutters, the bottleneck is elsewhere: RAM pressure, GPU settings, or open-world asset streaming from external storage.',
  };
}

// ---------- API payloads ----------
async function cableStatus({ withBenchmark = false, volume: wantVolume = null } = {}) {
  const { device } = await linkSpeed();
  const drives = await enumerateDrives();
  const primary =
    (wantVolume ? drives.find((d) => d.volume === wantVolume) : null) ||
    (VOLUME ? drives.find((d) => d.volume === VOLUME) : null) ||
    drives.find((d) => /AI_DRIVE/i.test(d.volume)) ||
    drives[0] ||
    null;

  const liveAll = await liveMBsAll(drives.map((d) => d.disk).filter(Boolean));
  for (const d of drives) d.live_mb_per_sec = d.disk ? (liveAll[d.disk] ?? null) : null;

  const volume = primary ? primary.volume : null;
  const disk = primary ? primary.disk : null;
  const live = disk ? (liveAll[disk] ?? null) : null;
  let file = MAX_FILE;
  let bench = null;
  let benchFile = null;
  const cachedBench = _benches.get(volume || 'default');
  if (cachedBench && Date.now() - cachedBench.ts < 3600000) {
    bench = cachedBench.bench;
    benchFile = cachedBench.bench_file;
  }
  if (withBenchmark) {
    if (volume && !file) file = await findBenchFile(volume);
    if (file) {
      bench = await benchmark(file);
      benchFile = path.basename(file);
      _benches.set(volume || 'default', { bench, bench_file: benchFile, ts: Date.now() });
    }
  }

  const isExtreme = /extreme/i.test(device?.product || '');
  const capableMbps = isExtreme ? EXTREME_CAPABLE_MBPS : device?.speed_mbps ?? null;
  const capableMBs = isExtreme
    ? EXTREME_CAPABLE_MB_PER_SEC
    : capableMbps
      ? Math.round(((capableMbps * 1e6) / 8 / 1e6) * 10) / 10
      : null;

  const measured = bench?.ok ? bench.mb_per_sec : null;
  const verdict = buildVerdict(device?.speed_code, measured, capableMBs);

  return {
    device,
    volume: volume || null,
    disk: disk || null,
    live_mb_per_sec: live,
    drives,
    benchmark: bench,
    bench_file: benchFile,
    capable: {
      mbps: capableMbps,
      mb_per_sec: capableMBs,
      source: isExtreme ? 'SanDisk Extreme spec (~1050 MB/s read)' : 'negotiated link limit',
    },
    verdict,
  };
}

async function powerStatus() {
  const [static_, live] = await Promise.all([powerStatic(), powerLive()]);
  return { ...static_, ...live };
}

async function statusPayload({ withBenchmark = false, volume = null } = {}) {
  const [cable, power] = await Promise.all([cableStatus({ withBenchmark, volume }), powerStatus()]);
  return { ts: new Date().toISOString(), cable, power };
}

// Last benchmark per volume, so live pushes keep showing the result.
const _benches = new Map();

// ---------- Static serving ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const sendJson = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj, null, 2));
  };

  try {
    if (url.pathname === '/api/status') {
      const withBench = url.searchParams.get('bench') === '1';
      return sendJson(200, await statusPayload({
        withBenchmark: withBench,
        volume: url.searchParams.get('volume'),
      }));
    }
    if (url.pathname === '/api/benchmark') {
      const data = await statusPayload({
        withBenchmark: true,
        volume: url.searchParams.get('volume'),
      });
      sendJson(200, data);
      broadcast(data); // push the fresh benchmark to live clients
      return;
    }
    if (url.pathname === '/api/cable-speed') {
      return sendJson(200, await cableStatus());
    }
    if (url.pathname === '/api/power') {
      return sendJson(200, await powerStatus());
    }
    if (url.pathname.startsWith('/api/')) {
      return sendJson(404, { error: 'unknown endpoint' });
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    sendJson(500, { error: String((err && err.message) || err) });
  }
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/ws') handleUpgrade(req, socket);
  else socket.destroy();
});

server.listen(PORT, () => {
  console.log(`Cable & Charging Monitor → http://localhost:${PORT}`);
  console.log(`  API: http://localhost:${PORT}/api/status`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  if (!fs.existsSync(DIST)) {
    console.log('  (no ./dist yet — run `npm run build` to serve the React UI)');
  }
});
