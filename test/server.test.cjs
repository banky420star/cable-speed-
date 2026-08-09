const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const PROJECT = path.join(__dirname, '..');
const { parseIOReg, wsAccept, encodeFrame, USB_SPEEDS, parseNetstat, parseDF, parseVmStat, matchChip, parsePsProcs } = require(path.join(PROJECT, 'server.cjs'));

// ------------------------------ unit tests ------------------------------

test('parseIOReg extracts products, vendors and link speeds', () => {
  const out = [
    '"USB Product Name" = "SanDisk Extreme"',
    '"USB Vendor Name" = "SanDisk"',
    '"Device Speed" = 3',
    '"USB Product Name" = "USB3.1 Hub"',
    '"Device Speed" = 4',
  ].join('\n');
  const devices = parseIOReg(out);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].product, 'SanDisk Extreme');
  assert.equal(devices[0].vendor, 'SanDisk');
  assert.equal(devices[0].speed, 3);
  assert.equal(devices[1].speed, 4);
});

test('wsAccept matches the RFC 6455 sample vector', () => {
  // RFC 6455 §1.3: key dGhlIHNhbXBsZSBub25jZQ== → s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
  assert.equal(wsAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('encodeFrame handles small, medium and large payloads', () => {
  const small = encodeFrame('hi');
  assert.deepEqual([...small], [0x81, 2, 0x68, 0x69]);

  const medium = encodeFrame('x'.repeat(200));
  assert.equal(medium[0], 0x81);
  assert.equal(medium[1], 126);
  assert.equal(medium.readUInt16BE(2), 200);
  assert.equal(medium.length, 204);

  const large = encodeFrame('y'.repeat(70000));
  assert.equal(large[1], 127);
  assert.equal(Number(large.readBigUInt64BE(2)), 70000);
});

test('USB_SPEEDS maps the negotiated speed codes', () => {
  assert.equal(USB_SPEEDS[2].label, 'USB 2.0');
  assert.equal(USB_SPEEDS[2].mbps, 480);
  assert.equal(USB_SPEEDS[4].mbps, 10000);
});

test('parseNetstat reads the default-interface byte counters', () => {
  const out = [
    'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
    'en0        1500  <Link#11>   de:51:25:66:35:e7  3404620     0 3411961718  2251782     0 1807932548     0',
    'en0        1500  192.168.1     mac.home         3404620     - 3411961718  2251782     - 1807932548     -',
  ].join('\n');
  assert.deepEqual(parseNetstat(out, 'en0'), { ibytes: 3411961718, obytes: 1807932548 });
  assert.equal(parseNetstat(out, 'en7'), null);
});

test('parseVmStat reads the live memory counters', () => {
  const out = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                  100.',
    'Pages active:               200.',
    'Pages inactive:              50.',
    'Pages speculative:           10.',
    'Pages wired down:            30.',
    'Pages occupied by compressor: 20.',
  ].join('\n');
  const s = parseVmStat(out);
  assert.equal(s.page_size, 16384);
  assert.equal(s.free, 100);
  assert.equal(s.active, 200);
  assert.equal(s.inactive, 50);
  assert.equal(s.speculative, 10);
  assert.equal(s.wired, 30);
  assert.equal(s.compressed, 20);
});

test('parsePsProcs reads top processes from ps output', () => {
  const out = [
    ' 87.5  123456 /usr/bin/Some App',
    ' 12.3  2048  launchd',
    '  1.1  5120  WindowServer',
  ].join('\n');
  const rows = parsePsProcs(out);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { cpu: 87.5, mem_mb: 121, name: '/usr/bin/Some App' });
  assert.equal(rows[1].cpu, 12.3);
  assert.equal(rows[1].mem_mb, 2);
  assert.equal(rows[2].name, 'WindowServer');
});

test('matchChip maps the brand string to the LPDDR spec', () => {
  assert.deepEqual(matchChip('Apple M4'), { mts: 7500, gbps: 120, type: 'LPDDR5X', chip: 'M4' });
  assert.equal(matchChip('Apple M4 Pro').mts, 8533);
  assert.equal(matchChip('Apple M2').mts, 6400);
  assert.equal(matchChip('Intel Core i7'), null);
});

test('parseDF reads capacity from a df -k row', () => {
  const out = [
    'Filesystem   1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on',
    '/dev/disk5s1   488352768 366996612 121199080    76%  578806 1211990800    0%   /Volumes/AI_DRIVE',
  ].join('\n');
  const cap = parseDF(out, '/Volumes/AI_DRIVE');
  assert.equal(cap.percent_used, 76);
  assert.equal(cap.total_gb, 465.7); // 488352768 KiB / 1048576
  assert.equal(cap.used_gb, 350);
  assert.equal(cap.free_gb, 115.6);
  assert.equal(parseDF(out, '/Volumes/MISSING'), null);
});

// --------------------------- integration tests ---------------------------

let child = null;
let port = 0;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function httpGet(p, pth, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: pth, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout on GET ${pth}`));
    });
    req.on('error', reject);
  });
}

async function waitReady(p, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await httpGet(p, '/api/status', 4000);
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not become ready');
}

before(async () => {
  port = await freePort();
  child = spawn(process.execPath, ['server.cjs'], {
    cwd: PROJECT,
    env: { ...process.env, CABLE_MONITOR_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitReady(port);
});

after(() => {
  if (child) child.kill();
});

test('GET /api/status returns cable + power + internet payloads', async () => {
  const r = await httpGet(port, '/api/status');
  assert.equal(r.status, 200);
  const json = JSON.parse(r.body);
  assert.ok(json.ts, 'has a timestamp');
  assert.ok(json.cable && typeof json.cable === 'object');
  assert.ok(json.power && typeof json.power === 'object');
  assert.ok(json.internet && typeof json.internet === 'object');
  for (const k of ['down_mbps', 'up_mbps', 'down_mb_per_sec', 'up_mb_per_sec', 'interface']) {
    assert.ok(k in json.internet, `internet.${k} present`);
  }
  // waitReady() above primed the first netstat sample, so this call must have
  // real deltas (regression: a missing timestamp made these NaN → null).
  assert.equal(typeof json.internet.down_mbps, 'number', 'down_mbps is a number');
  assert.equal(typeof json.internet.up_mbps, 'number', 'up_mbps is a number');
  assert.ok(Array.isArray(json.cable.drives));
  assert.ok('live_mb_per_sec' in json.cable);
  assert.ok('capacity' in json.cable, 'capacity key present (may be null without a drive)');
  for (const d of json.cable.drives) {
    assert.ok('capacity' in d, `drive ${d.name} carries capacity`);
  }
  assert.ok(json.memory && typeof json.memory === 'object', 'memory payload present');
  for (const k of ['total_gb', 'used_gb', 'percent_used', 'speed_mts', 'bandwidth_gb_per_sec', 'type']) {
    assert.ok(k in json.memory, `memory.${k} present`);
  }
  assert.equal(typeof json.memory.percent_used, 'number', 'percent_used is a number');
  assert.ok(json.cpu && typeof json.cpu === 'object', 'cpu payload present');
  assert.ok('load_pct' in json.cpu);
  assert.ok('cores' in json.cpu);
  assert.ok(Array.isArray(json.cpu.processes));
});

test('GET /api/cable-speed returns the cable object at top level', async () => {
  const r = await httpGet(port, '/api/cable-speed');
  assert.equal(r.status, 200);
  const json = JSON.parse(r.body);
  assert.ok(typeof json === 'object');
  assert.ok('device' in json);
  assert.ok('verdict' in json);
  assert.ok('live_mb_per_sec' in json);
});

test('GET /api/power returns the power fields', async () => {
  const r = await httpGet(port, '/api/power');
  assert.equal(r.status, 200);
  const json = JSON.parse(r.body);
  assert.ok(typeof json === 'object');
  assert.ok('battery_percent' in json);
  assert.ok('charging' in json);
  assert.ok('charger_watts' in json);
  assert.ok('live_watts' in json);
  assert.ok('discharging' in json);
});

test('unknown API paths return 404', async () => {
  const r = await httpGet(port, '/api/nope');
  assert.equal(r.status, 404);
});

test('WebSocket handshake upgrades and pushes live JSON', async () => {
  const json = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    let handshakeDone = false;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('no push received within 20s'));
    }, 20000);

    sock.on('connect', () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx).toString();
        assert.match(head, /101 Switching Protocols/, 'server answers with 101');
        handshakeDone = true;
        buf = buf.slice(idx + 4);
      }
      for (;;) {
        if (buf.length < 2) break;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let hdr = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          hdr = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          hdr = 10;
        }
        if (buf.length < hdr + len) break;
        const payload = buf.slice(hdr, hdr + len).toString('utf8');
        buf = buf.slice(hdr + len);
        if (opcode === 0x1) {
          clearTimeout(timer);
          sock.destroy();
          resolve(JSON.parse(payload));
          return;
        }
        // server pings (0x9) are ignored; it answers its own pings
      }
    });

    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  assert.ok(json.cable && typeof json.cable === 'object');
  assert.ok(json.power && typeof json.power === 'object');
});
