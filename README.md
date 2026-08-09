# Cable & Charging Monitor

A macOS-only React dashboard that shows, in real time:

- **Cable speed** — a live, fluctuating number: the real-time data rate
  through the USB port (Mbps), plus the negotiated link speed (USB 2.0 /
  3.x / 3.2 Gen 2) read from `ioreg`.
- **Drive capacity** — total / used / free space and % used per drive from
  `df`, with a live gauge.
- **Internet speed** — live upload and download in Mbps, sampled from
  `netstat -ib` counter deltas on the default interface.
- **RAM speed** — live used/free/cached memory with a pressure gauge
  (`vm_stat`), plus the chip's published LPDDR spec (e.g. M4 → 7500 MT/s,
  120 GB/s) since macOS does not expose the memory clock. Includes a
  **Clear cached data** button that flushes inactive memory (macOS admin
  prompt).
- **CPU** — live load % and the top processes by CPU/RAM (`ps`).
- **Live history** — every widget draws a sparkline of its recent samples
  (throughput, memory, CPU, battery, charge rate, upload/download).
- **Speed Test summary** — the Speed Test widget also shows a live summary
  of all sections with status dots.
- **Compact mode** — a toggle in the footer collapses the dashboard into a
  single dense column for small windows (persisted in localStorage).
- **Full speed test** — an on-demand `dd` read benchmark that measures the
  drive's real maximum read speed.
- **Charging** — charger wattage, battery %, live charge rate in watts
  (computed from the battery's amperage × voltage), and battery health.

## Quick start

```bash
cd cable-speed-app
npm install
npm start          # builds the React app and serves it + API on :8787
```

Open http://localhost:8787

### Dev mode (hot reload)

```bash
npm run api        # terminal 1 — API server on :8787
npm run dev        # terminal 2 — Vite on :5173 (proxies /api → :8787)
```

### Tests

```bash
npm test           # unit tests (ioreg parser, WebSocket frames) +
                   # integration tests that spawn the real server and
                   # exercise the HTTP + WebSocket endpoints
```

## Native macOS app

`Cable Speed Monitor.app` is a real native app (Swift + WebKit): double-click it
(or drag it to the Dock / Applications) and it opens the dashboard in its own
window — no browser tab. It starts the API server on :8787 itself if the
LaunchAgent isn't running, then loads the dashboard.

Rebuild it from source any time:

```bash
./build-app.sh      # compiles "Cable Speed Monitor.swift" → .app (ad-hoc signed)
```

The Swift source, build script, and icon live in the repo; the built `.app`
bundle is git-ignored (it's a local artifact).

### Packaging for transport

`build-app.sh` embeds the runtime payload (`server.cjs` + the built `dist/`
dashboard) into `Contents/Resources/runtime/`, so the `.app` is portable:
copy it to any Mac (or a USB stick) and double-click — the launcher finds the
embedded runtime first and serves the dashboard from inside the bundle, no
project folder required. Verified by copying the app to a clean directory and
launching it there.

Two caveats for the target Mac:

- **Node.js must be installed** (the launcher looks in the standard homebrew
  `/usr/local` locations). To make it fully standalone, drop a `node` binary
  into `Contents/Resources/runtime/node` and the launcher will pick it up.
- The app binds **port 8787**; if something else already answers there, it
  opens the dashboard pointing at that server instead of starting its own.

When the app starts the server itself (transportable mode), it stops it again
on quit; when the LaunchAgent is providing the server, it leaves it running.

## Live background service (macOS)

The API server can run as a LaunchAgent so the dashboard stays live whenever
this Mac is on — no terminal needed:

```bash
cp com.cablespeed.monitor.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cablespeed.monitor.plist
```

It runs `server.cjs` on :8787 at login (logs to
`~/Library/Logs/cable-speed-monitor.log`). Static previews of the dashboard
poll `http://localhost:8787` directly (CORS is enabled), so they show the
same live MB/s, charge rate, and battery state as the served app.

> Note: keep paths free of spaces — launchd refuses to spawn jobs whose
> `WorkingDirectory` / log paths contain spaces.

## API

| Endpoint              | Description                                                |
| --------------------- | ---------------------------------------------------------- |
| `WS /ws`              | **Live push stream** — status JSON broadcast every ~1.5–2s (no polling) |
| `GET /api/status`     | Link speed + live MB/s + power/charging (HTTP fallback)    |
| `GET /api/benchmark`  | Runs the full `dd` benchmark (~few seconds on a slow link) |
| `GET /api/cable-speed`| Cable-only subset                                            |
| `GET /api/power`      | Power/charging subset                                        |

The dashboard uses the WebSocket stream by default (auto-reconnects with
backoff) and only falls back to 3s HTTP polling while the socket is down.
Benchmark results are cached per drive so they survive between pushes.

### Env overrides

- `CABLE_MONITOR_PORT` — server port (default `8787`)
- `VOLUME` — volume to benchmark (default: first `/Volumes/*`, prefers `*AI_DRIVE*`)
- `MAX_FILE` — pin the file used for the benchmark

## How the numbers are read

| Stat                | Source                                            |
| ------------------- | ------------------------------------------------- |
| Link speed          | `ioreg -p IOUSB` → `Device Speed` (2 = USB 2.0, 4 = 10 Gbps) |
| Live MB/s           | `iostat -d -w 1 -c 2 <disk>`                      |
| Max read speed      | `dd if=<big file> of=/dev/null bs=1m count=256`   |
| Charge rate (W)     | `ioreg -rn AppleSmartBattery` → \|Amperage\| × Voltage |
| Charger wattage     | `system_profiler SPPowerDataType`                  |

Diagnosis is color-coded: red = USB 2.0 bottleneck, orange = slow link,
green = running at capability.
