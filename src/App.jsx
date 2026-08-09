import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_MS = 3000; // live MB/s + charge rate
const HISTORY_MAX = 60;

// Optional embedded snapshot (injected by static previews / demos). When the
// API server is unreachable, the app renders this data instead of an error.
const EMBEDDED = typeof window !== 'undefined' ? window.__EMBEDDED_STATUS__ || null : null;

// In the static preview there is no same-origin API, so poll the real server
// directly (server.cjs sends Access-Control-Allow-Origin: *). When the app is
// served by server.cjs itself, stay same-origin.
const API_BASE = EMBEDDED ? 'http://localhost:8787' : '';

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* ignore */
    }
  },
};

/* ---------------------------------- icons ---------------------------------- */
const Icon = ({ path, size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

const ICONS = {
  usb: <Icon path={<><path d="M12 3v12" /><path d="M8 6l4-3 4 3" /><path d="M8 15h8v3a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3z" /></>} />,
  bolt: <Icon path={<path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z" />} />,
  battery: <Icon path={<><rect x="2" y="8" width="16" height="8" rx="2" /><path d="M22 11v2" /></>} />,
  gauge: <Icon path={<><path d="M12 14l3.5-3.5" /><path d="M4.9 19a9 9 0 1 1 14.2 0" /></>} />,
  heart: <Icon path={<path d="M12 20.5 4.6 13a5 5 0 0 1 7-7l.4.4.4-.4a5 5 0 0 1 7 7z" />} />,
  plug: <Icon path={<><path d="M9 2v6" /><path d="M15 2v6" /><path d="M7 8h10v3a5 5 0 0 1-10 0z" /><path d="M12 16v6" /></>} />,
  info: <Icon path={<><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>} />,
  close: <Icon path={<path d="M6 6l12 12M18 6 6 18" />} />,
  grip: <Icon path={<><path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" /></>} />,
  drive: <Icon path={<><path d="M22 12H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /><path d="M6 16h.01" /><path d="M10 16h.01" /></>} />,
  net: <Icon path={<><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /></>} />,
  chip: <Icon path={<><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M15 2v2M9 2v2M15 20v2M9 20v2M2 15h2M2 9h2M20 15h2M20 9h2" /></>} />,
  wifi: <Icon path={<><path d="M5 13a10 10 0 0 1 14 0" /><path d="M8.5 16.5a5 5 0 0 1 7 0" /><path d="M2 8.82a15 15 0 0 1 20 0" /><path d="M12 20h.01" /></>} />,
};

/* ------------------------------ small helpers ------------------------------ */
const fmtMBs = (v) => (v == null ? '—' : v >= 100 ? String(Math.round(v)) : v.toFixed(1));
const fmtWatts = (v) => (v == null ? '—' : `${v.toFixed(1)} W`);
const fmtGbps = (mbps) => (mbps ? `${(mbps / 1000).toFixed(1)} Gbps` : '—');
const fmtGB = (v) => (v == null ? '—' : `${v} GB`);

function AnimatedNumber({ value, decimals = 0, duration = 700 }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return undefined;
    const start = performance.now();
    let raf;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (to - from) * eased);
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <span className="anim-num">{display.toFixed(decimals)}</span>;
}

function Sparkline({ points, max, color, height = 46 }) {
  const width = 220;
  if (!points || points.length < 2) {
    return (
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" strokeDasharray="4 5" />
      </svg>
    );
  }
  const xs = points.map((_, i) => (i / (points.length - 1)) * width);
  const ys = points.map((v) => height - (Math.min(v, max) / max) * (height - 4) - 2);
  const line = `M${xs[0]},${ys[0]} ` + xs.slice(1).map((x, i) => `L${x},${ys[i + 1]}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const last = ys[ys.length - 1];
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {/* fillOpacity (not an appended hex alpha) so var(--color) works */}
      <path d={area} fill={color} fillOpacity={0.12} stroke="none" />
      <path d={line} className="spark-line" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={width} cy={last} r="3" fill={color} className="spark-dot" />
    </svg>
  );
}

function RingGauge({ ratio, color, children }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const filled = Math.min(1, Math.max(0, ratio)) * c;
  return (
    <div className="ring-wrap">
      <svg width="112" height="112" viewBox="0 0 112 112">
        <circle cx="56" cy="56" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="9" />
        <circle
          cx="56" cy="56" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={`${filled} ${c - filled}`} transform="rotate(-90 56 56)"
          style={{ transition: 'stroke-dasharray .8s cubic-bezier(.3,.7,.3,1)', filter: `drop-shadow(0 0 6px ${color})` }}
        />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

function CableWidget({ cable, history }) {
  const v = cable.verdict || {};
  const device = cable.device;
  const color = v.color || '#a1a1a6';
  const live = cable.live_mb_per_sec ?? null;
  // Cable speed as a live, fluctuating number: real-time data rate in Mbps.
  const liveMbps = live == null ? null : live * 8;
  const linkMbps = device?.speed_mbps ?? null;
  const series = history.map((h) => (h.live == null ? null : h.live * 8)).filter((x) => x != null);
  return (
    <div className="widget w-2" data-color={color}>
      <div className="widget-body cable-body">
        <div className="cable-head">
          <span key={v.title || 'unknown'} className="badge badge-in" style={{ background: `${color}1f`, color, border: `1px solid ${color}55` }}>
            {v.title || 'Unknown'}
          </span>
          <span className="live-tag"><span className="dot" /> live</span>
        </div>
        <div className="device">
          {device?.product || 'No external drive detected'}{' '}
          {device?.vendor && <span className="vendor">· {device.vendor}</span>}
        </div>
        <div className="cable-live-num" style={{ color: liveMbps != null && liveMbps > 0 ? color : 'var(--muted2)' }}>
          {liveMbps == null ? (
            <span className="cable-static">{linkMbps ? `${linkMbps} Mbps` : '—'}</span>
          ) : (
            <>
              <AnimatedNumber value={liveMbps} decimals={liveMbps < 100 ? 1 : 0} />
              <span className="unit">Mbps</span>
            </>
          )}
        </div>
        <Sparkline points={series} max={linkMbps || 1000} color={color} />
        <div className="meta">
          {device?.speed_label ? `${device.speed_label} link · ${fmtGbps(device.speed_mbps)}` : 'Link: unknown'}
          {' · '}
          {cable.volume ? `Volume ${String(cable.volume).replace('/Volumes/', '')}` : 'no external volume'}
          {cable.disk ? ` · disk ${cable.disk}` : ''}
        </div>
      </div>
    </div>
  );
}

function CapacityWidget({ cable }) {
  const cap = cable.capacity || null;
  const pct = cap?.percent_used ?? 0;
  const color = cap
    ? pct > 90 ? '#ff453a' : pct > 75 ? '#ff9f0a' : '#32d74b'
    : 'var(--muted2)';
  return (
    <div className="widget w-2">
      <div className="widget-body">
        <div className="through-row">
          <RingGauge ratio={pct / 100} color={color}>
            <div className="g-num" style={{ color }}>{cap ? `${pct}%` : '—'}</div>
            <div className="g-unit">used</div>
          </RingGauge>
          <div className="through-meta">
            <div className="stat-line">
              <span className="k">total</span>
              <span className="val">{fmtGB(cap?.total_gb)}</span>
            </div>
            <div className="stat-line">
              <span className="k">used</span>
              <span className="val" style={{ color }}>{fmtGB(cap?.used_gb)}</span>
            </div>
            <div className="stat-line">
              <span className="k">free</span>
              <span className="val" style={{ color: 'var(--blue)' }}>{fmtGB(cap?.free_gb)}</span>
            </div>
          </div>
        </div>
        <div className="cap-bar">
          <span className="cap-fill" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
        </div>
      </div>
    </div>
  );
}

function MemoryWidget({ memory, history, purgeMemory, purging }) {
  const memSeries = history.map((h) => h.mem).filter((x) => x != null);
  const total = memory?.total_gb ?? null;
  const used = memory?.used_gb ?? null;
  const free = memory?.free_gb ?? null;
  const cached = memory?.cached_gb ?? null;
  const pct = memory?.percent_used ?? 0;
  const color = pct > 90 ? '#ff453a' : pct > 75 ? '#ff9f0a' : '#32d74b';
  const mts = memory?.speed_mts ?? null;
  const bw = memory?.bandwidth_gb_per_sec ?? null;
  const type = memory?.type ?? null;
  return (
    <div className="widget w-2">
      <div className="widget-body">
        <div className="ram-spec">
          <span className="badge badge-in" style={{ background: `${color}1f`, color, border: `1px solid ${color}55` }}>
            {type || 'RAM'}
          </span>
          <div className="ram-speed-big">
            {mts ? <><AnimatedNumber value={mts} /> <span className="unit">MT/s</span></> : '—'}
          </div>
          <div className="ram-sub">
            {memory?.chip || 'Apple Silicon'}
            {bw ? ` · ${bw} GB/s peak bandwidth` : ''}
            {total ? ` · ${total} GB total` : ''}
          </div>
        </div>
        <div className="through-row" style={{ marginTop: 12 }}>
          <RingGauge ratio={pct / 100} color={color}>
            <div className="g-num" style={{ color }}>{total ? `${pct}%` : '—'}</div>
            <div className="g-unit">used</div>
          </RingGauge>
          <div className="through-meta">
            <div className="stat-line">
              <span className="k">used</span>
              <span className="val" style={{ color }}>{used == null ? '—' : <AnimatedNumber value={used} decimals={1} />} GB</span>
            </div>
            <div className="stat-line">
              <span className="k">free</span>
              <span className="val">{fmtGB(free)}</span>
            </div>
            <div className="stat-line">
              <span className="k">cached</span>
              <span className="val" style={{ color: 'var(--blue)' }}>{fmtGB(cached)}</span>
            </div>
          </div>
        </div>
        <div className="cap-bar">
          <span className="cap-fill" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
        </div>
        <div className="spark-head">
          <span>Memory used (live)</span>
          <span className="spark-live">{memSeries.length ? `last ${memSeries.length} samples` : 'waiting for data…'}</span>
        </div>
        <Sparkline points={memSeries} max={100} color={color} height={30} />
        <div className="ram-actions">
          <button className="purge-btn" onClick={purgeMemory} disabled={purging}>
            {purging ? 'Clearing…' : 'Clear cached data'}
          </button>
          <span className="purge-hint">flushes inactive memory · asks for your password</span>
        </div>
      </div>
    </div>
  );
}

function WifiWidget({ wifi }) {
  const rawSsid = wifi?.ssid;
  const ssid = rawSsid && !/redacted/i.test(rawSsid) ? rawSsid : 'Wi-Fi network';
  const q = wifi?.signal_quality_pct ?? null;
  const color = q == null ? 'var(--muted2)' : q > 70 ? 'var(--green)' : q > 40 ? 'var(--orange)' : 'var(--red)';
  const rate = wifi?.tx_rate_mbps ?? null;
  return (
    <div className="widget w-2">
      <div className="widget-body">
        <div className="wifi-head">
          <span className="wifi-ssid">{ssid}</span>
          <span className="wifi-ip">{wifi?.ipv4 || 'no IP'}</span>
        </div>
        <div className="wifi-row">
          <RingGauge ratio={(q ?? 0) / 100} color={color}>
            <div className="g-num" style={{ color }}>{q == null ? '—' : <AnimatedNumber value={q} decimals={0} />}</div>
            <div className="g-unit">signal</div>
          </RingGauge>
          <div className="through-meta">
            <div className="stat-line">
              <span className="k">tx rate</span>
              <span className="val">{rate != null ? `${rate} Mbps` : '—'}</span>
            </div>
            <div className="stat-line">
              <span className="k">phy</span>
              <span className="val">{wifi?.phy || '—'}</span>
            </div>
            <div className="stat-line">
              <span className="k">channel</span>
              <span className="val">{wifi?.channel || '—'}</span>
            </div>
            <div className="stat-line">
              <span className="k">security</span>
              <span className="val">{wifi?.security || '—'}</span>
            </div>
          </div>
        </div>
        <div className="wifi-bar">
          <i style={{ width: `${q ?? 0}%`, background: color }} />
        </div>
        <div className="wifi-sub">
          {wifi?.signal_dbm != null ? `signal ${wifi.signal_dbm} dBm · noise ${wifi.noise_dbm ?? '—'} dBm` : 'signal data unavailable'}
        </div>
      </div>
    </div>
  );
}

function CpuWidget({ cpu }) {
  const load = cpu?.load_pct ?? null;
  const cores = cpu?.cores ?? null;
  const color = load == null ? 'var(--muted2)' : load > 85 ? 'var(--red)' : load > 60 ? 'var(--orange)' : 'var(--green)';
  const procs = cpu?.processes || [];
  return (
    <div className="widget w-2">
      <div className="widget-body">
        <div className="through-row">
          <RingGauge ratio={(load ?? 0) / 100} color={color}>
            <div className="g-num" style={{ color }}>
              {load == null ? '—' : <AnimatedNumber value={load} decimals={0} />}
            </div>
            <div className="g-unit">% load</div>
          </RingGauge>
          <div className="through-meta">
            <div className="stat-line">
              <span className="k">cores</span>
              <span className="val">{cores ?? '—'}</span>
            </div>
            <div className="stat-line">
              <span className="k">top process</span>
              <span className="val proc-top-name">{procs[0]?.name || '—'}</span>
            </div>
            <div className="stat-line">
              <span className="k">top cpu</span>
              <span className="val" style={{ color }}>{procs[0]?.cpu != null ? `${procs[0].cpu.toFixed(1)}%` : '—'}</span>
            </div>
          </div>
        </div>
        <div className="spark-head">
          <span>Top processes by CPU</span>
          <span className="spark-live">live</span>
        </div>
        <div className="proc-list">
          {procs.length === 0 && <div className="proc-empty">waiting for data…</div>}
          {procs.slice(0, 5).map((p, i) => (
            <div className="proc-row" key={i}>
              <span className="proc-rank">{i + 1}</span>
              <span className="proc-name" title={p.name}>{p.name}</span>
              <span className="proc-bar"><i style={{ width: `${Math.min(100, p.cpu)}%`, background: color }} /></span>
              <span className="proc-cpu">{p.cpu.toFixed(1)}%</span>
              <span className="proc-mem">{p.mem_mb != null ? `${p.mem_mb} MB` : ''}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function InternetWidget({ internet, history }) {
  const down = internet?.down_mbps ?? null;
  const up = internet?.up_mbps ?? null;
  const iface = internet?.interface;
  const downSeries = history.map((h) => h.down).filter((x) => x != null);
  const upSeries = history.map((h) => h.up).filter((x) => x != null);
  const downMax = Math.max(50, ...downSeries);
  const upMax = Math.max(50, ...upSeries);
  return (
    <div className="widget">
      <div className="widget-body net-body">
        <div className="net-col">
          <span className="net-arrow down">↓</span>
          <div className="net-num" style={{ color: 'var(--blue)' }}>
            {down == null ? '—' : <AnimatedNumber value={down} decimals={down < 100 ? 1 : 0} />}
          </div>
          <div className="net-label">download <b>Mbps</b></div>
        </div>
        <div className="net-divider" />
        <div className="net-col">
          <span className="net-arrow up">↑</span>
          <div className="net-num" style={{ color: 'var(--green)' }}>
            {up == null ? '—' : <AnimatedNumber value={up} decimals={up < 100 ? 1 : 0} />}
          </div>
          <div className="net-label">upload <b>Mbps</b></div>
        </div>
      </div>
      <div className="net-spark">
        <div className="net-spark-row">
          <span className="net-spark-label down">↓</span>
          <Sparkline points={downSeries} max={downMax} color="var(--blue)" height={18} />
        </div>
        <div className="net-spark-row">
          <span className="net-spark-label up">↑</span>
          <Sparkline points={upSeries} max={upMax} color="var(--green)" height={18} />
        </div>
      </div>
      <div className="net-foot">{iface ? `live via ${iface}` : 'no active network interface'} · history fills as data flows</div>
    </div>
  );
}

function TestWidget({ cable, power, memory, cpu, internet, wifi, peaks, resetPeaks, testing, runFullTest }) {
  const bench = cable.benchmark?.mb_per_sec ?? null;
  const capable = cable.capable?.mb_per_sec ?? null;
  const pct = bench != null && capable ? Math.round((bench / capable) * 100) : null;
  const sc = (level) => (level === 'good' ? 'var(--green)' : level === 'warn' ? 'var(--orange)' : level === 'bad' ? 'var(--red)' : 'var(--muted2)');
  const cap = cable.capacity || {};
  const rows = [
    { label: 'Cable link', value: cable.device?.speed_label || '—', status: sc(cable.verdict?.level === 'bottleneck' ? 'bad' : cable.verdict?.level === 'slow' ? 'warn' : 'good') },
    { label: 'Drive read', value: bench != null ? `${fmtMBs(bench)} MB/s` : '—', status: sc(bench != null && capable && bench / capable >= 0.6 ? 'good' : bench != null ? 'bad' : 'none') },
    { label: 'Drive capacity', value: cap.percent_used != null ? `${cap.percent_used}% used` : '—', status: sc(cap.percent_used > 90 ? 'bad' : cap.percent_used > 75 ? 'warn' : 'good') },
    { label: 'Memory', value: memory?.percent_used != null ? `${memory.percent_used}% used` : '—', status: sc(memory?.percent_used > 90 ? 'bad' : memory?.percent_used > 75 ? 'warn' : 'good') },
    { label: 'CPU load', value: cpu?.load_pct != null ? `${cpu.load_pct}%` : '—', status: sc(cpu?.load_pct > 85 ? 'bad' : cpu?.load_pct > 60 ? 'warn' : 'good') },
    { label: 'Download', value: internet?.down_mbps != null ? `${internet.down_mbps} Mbps` : '—', status: 'var(--blue)' },
    { label: 'Upload', value: internet?.up_mbps != null ? `${internet.up_mbps} Mbps` : '—', status: 'var(--green)' },
    { label: 'Battery', value: power?.battery_percent != null ? `${power.battery_percent}%` : '—', status: sc(power?.battery_percent < 20 ? 'bad' : power?.battery_percent < 50 ? 'warn' : 'good') },
    { label: 'Charge rate', value: power?.live_watts != null ? `${power.live_watts.toFixed(1)} W` : '—', status: power?.live_watts < 0 ? 'var(--orange)' : 'var(--green)' },
  ];
  return (
    <div className="widget">
      <div className="widget-body">
        <button className="recheck" onClick={runFullTest} disabled={testing}>
          {testing && <span className="spin" />}
          {testing ? 'Running…' : '⚡  Full speed test'}
        </button>
        {bench != null && (
          <div className="test-result">
            <span className="k">result</span>
            <span className="val">{fmtMBs(bench)} MB/s</span>
            {pct != null && <span className="sub">≈ {pct}% of capable</span>}
          </div>
        )}
        {cable.bench_file && <div className="tiny">file: {cable.bench_file}</div>}
        <div className="wifi-max">
          <div className="wifi-max-head">
            <span>Wi-Fi max <b>↓ upload &amp; download ↑</b> this session</span>
            <button className="reset-peaks" onClick={resetPeaks} title="Reset the measured peaks">↺ reset</button>
          </div>
          <div className="wifi-max-cols">
            <div className="wifi-max-col down">
              <span className="net-arrow down">↓</span>
              <span className="wifi-max-val">
                {peaks.down > 0 ? `${peaks.down.toFixed(1)} Mbps` : '—'}
              </span>
              <span className="wifi-max-label">max download</span>
            </div>
            <div className="wifi-max-col up">
              <span className="net-arrow up">↑</span>
              <span className="wifi-max-val">
                {peaks.up > 0 ? `${peaks.up.toFixed(1)} Mbps` : '—'}
              </span>
              <span className="wifi-max-label">max upload</span>
            </div>
          </div>
          {wifi?.tx_rate_mbps != null && (
            <div className="tiny">
              Wi-Fi link cap ≈ {wifi.tx_rate_mbps} Mbps{wifi.ssid ? ` · ${wifi.ssid}` : ''} · peaks reset with ↺
            </div>
          )}
        </div>
        <div className="summary-head">
          <span>Live summary · all sections</span>
          <span className="spark-live">updates with each push</span>
        </div>
        <div className="summary-list">
          {rows.map((r) => (
            <div className="summary-row" key={r.label}>
              <span className="summary-dot" style={{ background: r.status, boxShadow: `0 0 6px ${r.status}` }} />
              <span className="summary-label">{r.label}</span>
              <span className="summary-val" style={{ color: r.status }}>{r.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function BatteryWidget({ power, history }) {
  const pct = power.battery_percent ?? 0;
  const charging = power.charging || (power.live_watts > 1 && !power.fully_charged);
  const color = pct < 20 ? 'var(--red)' : pct < 50 ? 'var(--orange)' : 'var(--green)';
  const batSeries = history.map((h) => h.bat).filter((x) => x != null);
  return (
    <div className="widget">
      <div className="widget-body">
        <div className="big" style={{ color }}>
          {pct}<span className="big-suffix">%</span>
        </div>
        <div className="sub-line">
          {charging ? '⚡ charging' : power.fully_charged ? 'fully charged' : 'on battery'}
        </div>
        <div className="batt-track">
          <i className={`batt-fill${charging ? ' charging' : ''}`} style={{ width: `${pct}%`, background: color }} />
        </div>
        <Sparkline points={batSeries} max={100} color={color} height={24} />
      </div>
    </div>
  );
}

function ChargeWidget({ power, history }) {
  const w = power.live_watts ?? 0;
  const discharging = power.discharging === true || w < 0;
  const charging = !discharging && w > 1;
  const state = discharging ? 'discharging' : charging ? 'charging' : power.fully_charged ? 'battery full' : 'idle';
  const color = discharging ? 'var(--orange)' : charging ? 'var(--green)' : 'var(--muted)';
  const wattSeries = history.map((h) => Math.abs(h.watts)).filter((x) => x != null);
  return (
    <div className="widget">
      <div className="widget-body">
        <div className="big" style={{ color }}>
          {Math.abs(w) < 0.05 ? '0.0' : <AnimatedNumber value={Math.abs(w)} decimals={1} />}
          <span className="big-suffix"> W</span>
        </div>
        <div className="sub-line">
          {state}
          {power.amperage_ma != null && power.voltage_mv != null
            ? ` · ${Math.abs(power.amperage_ma)} mA · ${(power.voltage_mv / 1000).toFixed(1)} V`
            : ''}
        </div>
        <Sparkline points={wattSeries} max={Math.max(5, ...wattSeries)} color={color} height={24} />
      </div>
    </div>
  );
}

function ChargerWidget({ power }) {
  return (
    <div className="widget">
      <div className="widget-body">
        <div className="big">{power.charger_watts ? `${power.charger_watts}` : '—'}<span className="big-suffix"> W</span></div>
        <div className="sub-line">{power.ac_connected ? 'AC connected' : 'no AC power'}</div>
      </div>
    </div>
  );
}

function HealthWidget({ power }) {
  return (
    <div className="widget">
      <div className="widget-body">
        <div className="big">{power.max_capacity_pct != null ? `${power.max_capacity_pct}` : '—'}<span className="big-suffix">%</span></div>
        <div className="sub-line">
          {power.cycle_count != null ? `${power.cycle_count} cycles` : ''}
          {power.condition ? ` · ${power.condition}` : ''}
        </div>
      </div>
    </div>
  );
}

function DiagnosisWidget({ cable }) {
  const v = cable.verdict || {};
  return (
    <div className="widget w-2">
      <div className="widget-body">
        <div className="guidance" style={{ borderLeftColor: v.color || 'var(--muted2)' }}>
          <strong>Diagnosis: </strong>
          {v.guidance || 'No diagnosis available.'}
        </div>
      </div>
    </div>
  );
}

const WIDGETS = [
  { key: 'cable', title: 'Cable Speed', icon: ICONS.usb, render: ({ cable, history }) => <CableWidget cable={cable} history={history} />, span: 2 },
  { key: 'capacity', title: 'Drive Capacity', icon: ICONS.drive, render: ({ cable }) => <CapacityWidget cable={cable} />, span: 2 },
  { key: 'memory', title: 'RAM Speed', icon: ICONS.chip, render: ({ memory, history, purgeMemory, purging }) => <MemoryWidget memory={memory} history={history} purgeMemory={purgeMemory} purging={purging} />, span: 2 },
  { key: 'cpu', title: 'CPU', icon: ICONS.chip, render: ({ cpu, history }) => <CpuWidget cpu={cpu} history={history} />, span: 2 },
  { key: 'wifi', title: 'Wi-Fi', icon: ICONS.wifi, render: ({ wifi }) => <WifiWidget wifi={wifi} />, span: 2 },
  { key: 'internet', title: 'Internet Speed', icon: ICONS.net, render: ({ internet, history }) => <InternetWidget internet={internet} history={history} /> },
  { key: 'battery', title: 'Battery', icon: ICONS.battery, render: ({ power, history }) => <BatteryWidget power={power} history={history} /> },
  { key: 'charge', title: 'Charge Rate', icon: ICONS.bolt, render: ({ power, history }) => <ChargeWidget power={power} history={history} /> },
  { key: 'charger', title: 'Charger', icon: ICONS.plug, render: ({ power }) => <ChargerWidget power={power} /> },
  { key: 'health', title: 'Battery Health', icon: ICONS.heart, render: ({ power }) => <HealthWidget power={power} /> },
  { key: 'test', title: 'Speed Test', icon: ICONS.info, render: ({ cable, power, memory, cpu, internet, wifi, peaks, resetPeaks, testing, runFullTest }) => (
    <TestWidget cable={cable} power={power} memory={memory} cpu={cpu} internet={internet} wifi={wifi} peaks={peaks} resetPeaks={resetPeaks} testing={testing} runFullTest={runFullTest} />
  ) },
  { key: 'diagnosis', title: 'Diagnosis', icon: ICONS.info, render: ({ cable }) => <DiagnosisWidget cable={cable} />, span: 2 },
];

/* ---------------------------------- app ----------------------------------- */
export default function App() {
  const [data, setData] = useState(EMBEDDED || null);
  const [loading, setLoading] = useState(!EMBEDDED);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState(null);
  const [auto, setAuto] = useState(true);
  const [isLive, setIsLive] = useState(false); // connected to the real API
  const [volume, setVolume] = useState(null); // selected external drive
  const [flash, setFlash] = useState(false); // live-pill ripple on refresh
  const [removing, setRemoving] = useState(null); // widget mid-hide animation
  const [purging, setPurging] = useState(false); // RAM cache flush in flight
  const [peaks, setPeaks] = useState({ down: 0, up: 0 }); // Wi-Fi max ↓/↑ this session
  const gridRef = useRef(null);
  const wsConnectedRef = useRef(false);
  const [order, setOrder] = useState(() => {
    const def = WIDGETS.map((w) => w.key);
    const stored = store.get('cs_order', null);
    if (!Array.isArray(stored)) return def;
    const valid = stored.filter((k) => def.includes(k));
    return [...valid, ...def.filter((k) => !valid.includes(k))]; // keep new widgets
  });
  const [hidden, setHidden] = useState(() => new Set(store.get('cs_hidden', [])));
  const [dragKey, setDragKey] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [compact, setCompact] = useState(() => store.get('cs_compact', false));
  const historyRef = useRef([]);

  useEffect(() => store.set('cs_order', order), [order]);
  useEffect(() => store.set('cs_hidden', [...hidden]), [hidden]);
  useEffect(() => store.set('cs_compact', compact), [compact]);

  const poll = useCallback(
    async (vol) => {
      const qs = vol || volume ? `?volume=${encodeURIComponent(vol || volume)}` : '';
      try {
        const res = await fetch(`${API_BASE}/api/status${qs}`);
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
      setError(null);
      setIsLive(true);
      setFlash(true);
      setTimeout(() => setFlash(false), 800);
      trackPeaks(json.internet?.down_mbps, json.internet?.up_mbps);
      historyRef.current = [
        ...historyRef.current.slice(-(HISTORY_MAX - 1)),
        {
          ts: Date.now(),
          live: json.cable?.live_mb_per_sec ?? null,
          watts: json.power?.live_watts ?? null,
          down: json.internet?.down_mbps ?? null,
          up: json.internet?.up_mbps ?? null,
          mem: json.memory?.percent_used ?? null,
          bat: json.power?.battery_percent ?? null,
          cpu: json.cpu?.load_pct ?? null,
        },
      ];
      } catch (err) {
        if (EMBEDDED) {
          setData(EMBEDDED);
          setIsLive(false);
          setError(null);
        } else {
          setError(err.message || String(err));
        }
      } finally {
        setLoading(false);
      }
    },
    [volume]
  );

  const trackPeaks = useCallback((down, up) => {
    setPeaks((p) => ({
      down: down != null && down > p.down ? down : p.down,
      up: up != null && up > p.up ? up : p.up,
    }));
  }, []);

  const resetPeaks = useCallback(() => setPeaks({ down: 0, up: 0 }), []);

  const purgeMemory = useCallback(async () => {
    setPurging(true);
    try {
      const res = await fetch(`${API_BASE}/api/purge`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) throw new Error(json.error || `API returned ${res.status}`);
      setFlash(true);
      setTimeout(() => setFlash(false), 800);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setPurging(false);
    }
  }, []);

  const runFullTest = useCallback(async () => {
    setTesting(true);
    try {
      const qs = volume ? `?volume=${encodeURIComponent(volume)}` : '';
      const res = await fetch(`${API_BASE}/api/benchmark${qs}`);
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
      setError(null);
      setIsLive(true);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setTesting(false);
    }
  }, [volume]);

  useEffect(() => {
    if (!auto) return undefined;
    poll();
    // HTTP fallback while the WebSocket is down (e.g. server restarting).
    const t = setInterval(() => {
      if (!wsConnectedRef.current) poll();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [auto, poll]);

  // Live WebSocket stream — the server pushes fresh diagnostics ~1.5s apart,
  // so nothing polls while the socket is up. Auto-reconnects with backoff.
  useEffect(() => {
    if (!auto) return undefined;
    let ws = null;
    let stopped = false;
    let retry = 0;
    let retryTimer = null;
    const wsUrl = EMBEDDED
      ? 'ws://localhost:8787/ws'
      : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
    const apply = (json) => {
      if (!json || json.error) return;
      setData(json);
      setError(null);
      setIsLive(true);
      trackPeaks(json.internet?.down_mbps, json.internet?.up_mbps);
      historyRef.current = [
        ...historyRef.current.slice(-(HISTORY_MAX - 1)),
        {
          ts: Date.now(),
          live: json.cable?.live_mb_per_sec ?? null,
          watts: json.power?.live_watts ?? null,
          down: json.internet?.down_mbps ?? null,
          up: json.internet?.up_mbps ?? null,
          mem: json.memory?.percent_used ?? null,
          bat: json.power?.battery_percent ?? null,
          cpu: json.cpu?.load_pct ?? null,
        },
      ];
    };
    const connect = () => {
      if (stopped) return;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        retryTimer = setTimeout(connect, 1000 * Math.min(retry + 1, 5));
        return;
      }
      ws.onopen = () => {
        retry = 0;
        wsConnectedRef.current = true;
        setIsLive(true);
        setFlash(true);
        setTimeout(() => setFlash(false), 800);
      };
      ws.onmessage = (ev) => {
        try {
          apply(JSON.parse(ev.data));
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onerror = () => {
        /* handled by onclose */
      };
      ws.onclose = () => {
        wsConnectedRef.current = false;
        setIsLive(false);
        if (stopped) return;
        retry = Math.min(retry + 1, 5);
        retryTimer = setTimeout(connect, 1000 * retry);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      wsConnectedRef.current = false;
      if (ws) ws.close();
    };
  }, [auto]);

  const visible = order.filter((k) => !hidden.has(k));
  const hiddenWidgets = WIDGETS.filter((w) => hidden.has(w.key));

  const reorder = (from, to) => {
    setOrder((prev) => {
      const arr = prev.filter((k) => k !== from);
      const idx = arr.indexOf(to);
      arr.splice(idx < 0 ? arr.length : idx, 0, from);
      return arr;
    });
  };

  const hideWidget = (key) => {
    setRemoving(key);
    setTimeout(() => {
      setHidden((h) => new Set([...h, key]));
      setRemoving(null);
    }, 240);
  };

  const ctx = {
    cable: data?.cable || {},
    power: data?.power || {},
    internet: data?.internet || {},
    memory: data?.memory || {},
    cpu: data?.cpu || {},
    wifi: data?.wifi || {},
    testing,
    runFullTest,
    purgeMemory,
    purging,
    peaks,
    resetPeaks,
    history: historyRef.current,
  };
  const live = data?.cable?.live_mb_per_sec;

  return (
    <>
      <div className="aurora">
        <span className="blob" />
      </div>
      <header className="top">
        <div>
          <h1>
            Cable &amp; Charging <span className="accent">Monitor</span>
          </h1>
          <div className="subtitle">
            Live system monitor · cpu · memory · network · power
            {EMBEDDED && !isLive && <span className="static-note"> · static snapshot</span>}
          </div>
        </div>
        <div className={`live-pill${error ? ' error' : ''}${flash ? ' flash' : ''}`}>
          <span className={`dot${error ? ' error' : ''}`} />
          {error ? 'offline' : isLive ? 'live' : EMBEDDED ? 'snapshot' : data ? 'live' : '…'}
        </div>
      </header>

      {data?.cable?.drives && data.cable.drives.length > 0 && (
        <div className="drives-strip">
          <span className="drives-label">Hard drive cable speed</span>
          {data.cable.drives.map((d) => {
            const active = d.volume === (volume || data.cable.volume);
            return (
              <button
                key={d.volume}
                className={`drive-chip${active ? ' active' : ''}`}
                onClick={() => setVolume(d.volume)}
                title={`Monitor ${d.name}`}
              >
                <span className="drive-name">{d.name}</span>
                <span className="drive-link">
                  {active ? data.cable.device?.speed_label || d.protocol || '—' : d.protocol || '—'}
                </span>
                <span className="drive-live">
                  {fmtMBs(d.live_mb_per_sec)}
                  <i>MB/s</i>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div className="error-box">
          <strong>Can&apos;t reach the diagnostics API.</strong> Start it with <code>npm start</code> (or{' '}
          <code>npm run api</code>) in the app folder, then refresh.
          <div className="err-detail">Last error: {error}</div>
        </div>
      )}

      {loading && !data && !error && (
        <div className="loading">
          <span className="bar">
            <i className="fill" style={{ width: '40%', background: 'var(--blue)' }} />
          </span>
          Reading link speed, disk I/O and power state…
        </div>
      )}

      {data && (              <main ref={gridRef} className={`grid${compact ? ' compact' : ''}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}>
          {visible.map((key, i) => {
            const w = WIDGETS.find((x) => x.key === key);
            if (!w) return null;
            return (
              <section
                key={key}
                data-key={key}
                className={`widget${w.span === 2 ? ' w-2' : ''}${dragKey === key ? ' dragging' : ''}${removing === key ? ' removing' : ''}`}
                draggable
                onDragStart={(e) => {
                  setDragKey(key);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragKey && dragKey !== key) reorder(dragKey, key);
                  setDragKey(null);
                }}
              >
                <div className="w-head">
                  <span className="w-icon">{w.icon}</span>
                  <span className="w-title">{w.title}</span>
                  <span className="w-actions">
                    <button className="w-x" title="Hide widget" onClick={() => hideWidget(key)}>
                      {ICONS.close}
                    </button>
                    <span className="grip" title="Drag to reorder">{ICONS.grip}</span>
                  </span>
                </div>
                {w.render(ctx)}
              </section>
            );
          })}
        </main>
      )}

      {data && hiddenWidgets.length > 0 && (
        <div className="picker">
          <span className="picker-label">Add widget</span>
          {hiddenWidgets.map((w) => (
            <button key={w.key} className="chip" onClick={() => setHidden((h) => new Set([...h].filter((k) => k !== w.key)))}>
              {w.icon} {w.title}
            </button>
          ))}
        </div>
      )}

      <div className="controls">
        <button className="recheck" onClick={poll} disabled={loading}>
          {loading && <span className="spin" />}
          {loading ? 'Refreshing…' : '↻  Refresh'}
        </button>
        <label className="toggle">
          <input
            type="checkbox"
            className="switch-input"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />
          <span className={`switch${auto ? ' on' : ''}`}>
            <span className="knob" />
          </span>
          Live updates · WebSocket
        </label>
        <button className={`compact-btn${compact ? ' on' : ''}`} onClick={() => setCompact(!compact)} title="Single dense column for small windows">
          {compact ? '◫ Wide layout' : '▦ Compact mode'}
        </button>
        {data?.ts && <span className="updated">updated {new Date(data.ts).toLocaleTimeString()}</span>}
      </div>
    </>
  );
}
