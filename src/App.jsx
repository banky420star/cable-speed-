import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

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
  pulse: <Icon path={<path d="M2 12h4l2.5-7 4 14 3-9 2.5 2H22" />} />,
  drive: <Icon path={<><path d="M22 12H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /><path d="M6 16h.01" /><path d="M10 16h.01" /></>} />,
  net: <Icon path={<><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /></>} />,
  chip: <Icon path={<><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M15 2v2M9 2v2M15 20v2M9 20v2M2 15h2M2 9h2M20 15h2M20 9h2" /></>} />,
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
  // Micro-interaction: a quick scale pop whenever the value changes.
  const [pop, setPop] = useState(false);
  const prevVal = useRef(value);
  useEffect(() => {
    if (value !== prevVal.current) {
      prevVal.current = value;
      setPop(true);
      const t = setTimeout(() => setPop(false), 380);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [value]);
  return <span className={`anim-num${pop ? ' pop' : ''}`}>{display.toFixed(decimals)}</span>;
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
      <path d={area} fill={`${color}1f`} stroke="none" />
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
          style={{ transition: 'stroke-dasharray .8s cubic-bezier(.3,.7,.3,1)', filter: `drop-shadow(0 0 6px ${color}66)` }}
        />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

/* ------------------------------- data flow ------------------------------- */
// Realistic fiber-optic flow: a canvas particle system. Light particles stream
// out of the connector, along five glowing fibers, with additive-blend bloom
// and motion trails. Flow intensity is driven by the live push stream rate.
const TAU = Math.PI * 2;

const cubicPoint = (p0, p1, p2, p3, t) => {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
};

function FlowCanvas({ intensity, pushAt, color }) {
  const canvasRef = useRef(null);
  const intensityRef = useRef(intensity);
  const pushAtRef = useRef(pushAt);
  const colorRef = useRef(color);
  intensityRef.current = intensity;
  colorRef.current = color;
  if (pushAt) pushAtRef.current = pushAt;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let parts = [];
    let fiberLayer = null;
    let fibers = [];
    let W = 0;
    let H = 0;
    let lastSeenPush = 0;
    let last = performance.now();

    const drawFiber = (c, f, w, style) => {
      c.beginPath();
      c.moveTo(f.p0.x, f.p0.y);
      c.bezierCurveTo(f.p1.x, f.p1.y, f.p2.x, f.p2.y, f.p3.x, f.p3.y);
      c.lineWidth = w;
      c.strokeStyle = style;
      c.stroke();
    };

    const roundRect = (c, x, y, w, h, r) => {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    };

    const layout = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cy = H / 2;
      const cx = W * 0.12;
      const endX = W * 0.93;
      fibers = [0.24, 0.38, 0.5, 0.62, 0.76].map((f) => {
        const p0 = { x: cx, y: cy };
        const p3 = { x: endX, y: H * f };
        return {
          p0,
          p1: { x: W * 0.4, y: cy + (p3.y - cy) * 0.28 },
          p2: { x: W * 0.68, y: cy + (p3.y - cy) * 0.72 },
          p3,
        };
      });

      // Static fiber layer (rendered once per resize).
      fiberLayer = document.createElement('canvas');
      fiberLayer.width = canvas.width;
      fiberLayer.height = canvas.height;
      const fctx = fiberLayer.getContext('2d');
      fctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Metallic connector housing (like the launcher icon).
      const gx = W * 0.015;
      const gw = W * 0.15;
      const gy = H * 0.5 - H * 0.3;
      const gh = H * 0.6;
      const metal = fctx.createLinearGradient(gx, gy, gx + gw, gy);
      metal.addColorStop(0, '#2b2f3b');
      metal.addColorStop(0.5, '#3e4454');
      metal.addColorStop(1, '#23262f');
      roundRect(fctx, gx, gy, gw, gh, Math.min(10, gw * 0.16));
      fctx.fillStyle = metal;
      fctx.fill();
      fctx.strokeStyle = `${colorRef.current}55`;
      fctx.lineWidth = 1.2;
      fctx.stroke();
      // Inner opening where the fibers emerge.
      const ox = gx + gw * 0.72;
      const orx = gw * 0.24;
      const ory = gh * 0.32;
      const opening = fctx.createRadialGradient(ox, cy, 0, ox, cy, orx);
      opening.addColorStop(0, '#0b0d13');
      opening.addColorStop(1, '#181b23');
      fctx.beginPath();
      fctx.ellipse(ox, cy, orx, ory, 0, 0, TAU);
      fctx.fillStyle = opening;
      fctx.fill();
      fctx.strokeStyle = `${colorRef.current}44`;
      fctx.lineWidth = 1;
      fctx.stroke();
      fibers.forEach((f) => {
        const sy = cy + (f.p3.y - cy) * 0.06;
        fctx.beginPath();
        fctx.arc(ox - orx * 0.4, sy, 1.4, 0, TAU);
        fctx.fillStyle = `${colorRef.current}aa`;
        fctx.fill();
      });

      // Fibers: outer glow, body, bright core.
      fibers.forEach((f) => {
        const grad = fctx.createLinearGradient(f.p0.x, f.p0.y, f.p3.x, f.p3.y);
        grad.addColorStop(0, `${colorRef.current}cc`);
        grad.addColorStop(1, '#8ea4ff');
        drawFiber(fctx, f, 5.5, 'rgba(255,255,255,0.05)');
        drawFiber(fctx, f, 2.4, 'rgba(255,255,255,0.10)');
        drawFiber(fctx, f, 1.1, grad);
        fctx.beginPath();
        fctx.arc(f.p3.x, f.p3.y, 2.4, 0, TAU);
        fctx.fillStyle = '#cfd8ff';
        fctx.fill();
      });
    };

    const spawn = (n, boost = 1) => {
      for (let i = 0; i < n && parts.length < 320; i++) {
        const f = fibers[(Math.random() * fibers.length) | 0];
        parts.push({
          f,
          t: Math.random() * 0.1,
          k: (0.82 + Math.random() * 0.4) * boost,
          size: 0.9 + Math.random() * 1.7,
          accent: Math.random() < 0.22,
        });
      }
    };

    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const inten = intensityRef.current;
      const col = colorRef.current;

      // Trail fade (keeps fibers crisp — they're redrawn on top each frame).
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(10, 12, 18, 0.30)';
      ctx.fillRect(0, 0, W, H);

      // Breathing glow at the connector.
      const pulse = 0.55 + 0.45 * Math.sin(now / 800);
      ctx.globalCompositeOperation = 'lighter';
      const hex = Math.round(70 * pulse).toString(16).padStart(2, '0');
      const cg = ctx.createRadialGradient(W * 0.12, H / 2, 0, W * 0.12, H / 2, W * 0.1);
      cg.addColorStop(0, `${col}${hex}`);
      cg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = cg;
      ctx.fillRect(0, 0, W, H);

      // Light particles streaming along the fibers.
      const speed = (0.4 + inten) / 420; // fiber fraction per frame
      for (const p of parts) {
        p.t += speed * p.k;
        if (p.t >= 1) {
          p.dead = true;
          continue;
        }
        const pt = cubicPoint(p.f.p0, p.f.p1, p.f.p2, p.f.p3, p.t);
        const alpha = Math.min(1, p.t * 8) * Math.min(1, (1 - p.t) * 6);
        const pc = p.accent ? '#7ee7ff' : col;
        ctx.globalAlpha = alpha * 0.22; // halo
        ctx.fillStyle = pc;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, p.size * 3, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = alpha * 0.75; // body
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, p.size, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = alpha; // white-hot core
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, p.size * 0.42, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Crisp fiber layer on top.
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(fiberLayer, 0, 0);

      parts = parts.filter((p) => !p.dead);

      // Keep particle density ∝ flow intensity.
      if (Math.random() < 0.05 + inten * 0.13) spawn(1 + ((Math.random() * 3) | 0));

      // Burst on every incoming push — the cable visibly lights up.
      const cur = pushAtRef.current;
      if (cur && cur !== lastSeenPush) {
        spawn(26, 1.7);
        lastSeenPush = cur;
      }

      raf = requestAnimationFrame(frame);
    };

    layout();
    if (reduced) {
      // Static frame for reduced-motion users.
      ctx.fillStyle = 'rgba(10,12,18,1)';
      ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < 46; i++) spawn(1);
      for (const p of parts) {
        const pt = cubicPoint(p.f.p0, p.f.p1, p.f.p2, p.f.p3, Math.random());
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = colorRef.current;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, p.size, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.drawImage(fiberLayer, 0, 0);
    } else {
      raf = requestAnimationFrame(frame);
    }

    const ro = new ResizeObserver(() => {
      layout();
      parts = [];
    });
    ro.observe(canvas.parentElement);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="flow-canvas" role="img" aria-label="animated data flow through a fiber optic cable" />;
}

function FlowWidget({ cable, pushMs, pushAt }) {
  const v = cable.verdict || {};
  const color = v.color || '#2997ff';
  const live = cable.live_mb_per_sec ?? null;
  const bench = cable.benchmark?.mb_per_sec ?? null;
  const mb = live ?? bench ?? 0;
  // Flow intensity tracks the live push stream rate (faster pushes → stronger
  // flow); falls back to throughput scaling when there's no stream.
  const syncing = pushMs != null && pushMs > 0;
  const intensity = syncing
    ? Math.min(1.6, Math.max(0.15, 0.25 + 900 / pushMs))
    : Math.min(1.2, Math.max(0.15, 0.12 + mb / 400));
  return (
    <div className="widget-body flow-widget">
      <FlowCanvas intensity={intensity} pushAt={pushAt} color={color} />
      <div className="flow-stats">
        <span>
          flow rate <b style={{ color }}>{fmtMBs(live)} MB/s</b>
        </span>
        <span>link {cable.device?.speed_label || '—'}</span>
        <span>full test {fmtMBs(bench)} MB/s</span>
        <span className="flow-hint">
          {syncing
            ? `flow syncs with live stream · push every ${(pushMs / 1000).toFixed(1)}s`
            : 'flow accelerates with data load'}
        </span>
      </div>
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

function MemoryWidget({ memory }) {
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
      </div>
    </div>
  );
}

function InternetWidget({ internet }) {
  const down = internet?.down_mbps ?? null;
  const up = internet?.up_mbps ?? null;
  const iface = internet?.interface;
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
      <div className="net-foot">{iface ? `live via ${iface}` : 'no active network interface'} · pushes update every few seconds</div>
    </div>
  );
}

function TestWidget({ cable, testing, runFullTest }) {
  const bench = cable.benchmark?.mb_per_sec ?? null;
  const capable = cable.capable?.mb_per_sec ?? null;
  const pct = bench != null && capable ? Math.round((bench / capable) * 100) : null;
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
      </div>
    </div>
  );
}

function BatteryWidget({ power }) {
  const pct = power.battery_percent ?? 0;
  const charging = power.charging || (power.live_watts > 1 && !power.fully_charged);
  const color = pct < 20 ? 'var(--red)' : pct < 50 ? 'var(--orange)' : 'var(--green)';
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
      </div>
    </div>
  );
}

function ChargeWidget({ power }) {
  const w = power.live_watts ?? 0;
  const active = w > 1;
  return (
    <div className="widget">
      <div className="widget-body">
        <div className="big" style={{ color: active ? 'var(--green)' : 'var(--muted)' }}>
          {active ? <AnimatedNumber value={w} decimals={1} /> : '0.0'}
          <span className="big-suffix"> W</span>
        </div>
        <div className="sub-line">
          {power.amperage_ma != null && power.voltage_mv != null
            ? `${Math.abs(power.amperage_ma)} mA · ${(power.voltage_mv / 1000).toFixed(1)} V`
            : 'no battery data'}
        </div>
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
  { key: 'flow', title: 'Data Flow', icon: ICONS.pulse, render: ({ cable, pushMs, pushAt }) => <FlowWidget cable={cable} pushMs={pushMs} pushAt={pushAt} />, span: 2 },
  { key: 'cable', title: 'Cable Speed', icon: ICONS.usb, render: ({ cable, history }) => <CableWidget cable={cable} history={history} />, span: 2 },
  { key: 'capacity', title: 'Drive Capacity', icon: ICONS.drive, render: ({ cable }) => <CapacityWidget cable={cable} />, span: 2 },
  { key: 'memory', title: 'RAM Speed', icon: ICONS.chip, render: ({ memory }) => <MemoryWidget memory={memory} />, span: 2 },
  { key: 'internet', title: 'Internet Speed', icon: ICONS.net, render: ({ internet }) => <InternetWidget internet={internet} /> },
  { key: 'battery', title: 'Battery', icon: ICONS.battery, render: ({ power }) => <BatteryWidget power={power} /> },
  { key: 'charge', title: 'Charge Rate', icon: ICONS.bolt, render: ({ power }) => <ChargeWidget power={power} /> },
  { key: 'charger', title: 'Charger', icon: ICONS.plug, render: ({ power }) => <ChargerWidget power={power} /> },
  { key: 'health', title: 'Battery Health', icon: ICONS.heart, render: ({ power }) => <HealthWidget power={power} /> },
  { key: 'test', title: 'Speed Test', icon: ICONS.info, render: ({ cable, testing, runFullTest }) => <TestWidget cable={cable} testing={testing} runFullTest={runFullTest} /> },
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
  const gridRef = useRef(null);
  const posRef = useRef({});
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
  const historyRef = useRef([]);
  const pushTimesRef = useRef([]); // timestamps of incoming stream pushes

  useEffect(() => store.set('cs_order', order), [order]);
  useEffect(() => store.set('cs_hidden', [...hidden]), [hidden]);

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
      historyRef.current = [
        ...historyRef.current.slice(-(HISTORY_MAX - 1)),
        { ts: Date.now(), live: json.cable?.live_mb_per_sec ?? null, watts: json.power?.live_watts ?? null },
      ];
      const now = Date.now();
      const prev = pushTimesRef.current[pushTimesRef.current.length - 1];
      pushTimesRef.current = prev && now - prev < 10000
        ? [...pushTimesRef.current, now].slice(-12)
        : [now];
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
      historyRef.current = [
        ...historyRef.current.slice(-(HISTORY_MAX - 1)),
        { ts: Date.now(), live: json.cable?.live_mb_per_sec ?? null, watts: json.power?.live_watts ?? null },
      ];
      const now = Date.now();
      const prev = pushTimesRef.current[pushTimesRef.current.length - 1];
      pushTimesRef.current = prev && now - prev < 10000
        ? [...pushTimesRef.current, now].slice(-12)
        : [now];
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

  const capturePositions = () => {
    const map = {};
    gridRef.current?.querySelectorAll('.widget').forEach((el) => {
      const r = el.getBoundingClientRect();
      map[el.dataset.key] = { left: r.left, top: r.top };
    });
    posRef.current = map;
  };

  const reorder = (from, to) => {
    capturePositions();
    setOrder((prev) => {
      const arr = prev.filter((k) => k !== from);
      const idx = arr.indexOf(to);
      arr.splice(idx < 0 ? arr.length : idx, 0, from);
      return arr;
    });
  };

  const hideWidget = (key) => {
    capturePositions();
    setRemoving(key);
    setTimeout(() => {
      setHidden((h) => new Set([...h, key]));
      setRemoving(null);
    }, 240);
  };

  // FLIP: glide widgets into their new positions after reorder / hide.
  useLayoutEffect(() => {
    if (!gridRef.current) return undefined;
    const els = gridRef.current.querySelectorAll('.widget');
    const anims = [];
    els.forEach((el) => {
      const prev = posRef.current[el.dataset.key];
      if (!prev) return;
      const r = el.getBoundingClientRect();
      const dx = prev.left - r.left;
      const dy = prev.top - r.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        anims.push(el);
      }
    });
    posRef.current = {};
    if (!anims.length) return undefined;
    let raf1;
    let raf2;
    let cleanupT;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        anims.forEach((el) => {
          el.style.transition = 'transform 0.42s cubic-bezier(0.3, 0.7, 0.3, 1)';
          el.style.transform = '';
        });
        cleanupT = setTimeout(() => {
          anims.forEach((el) => {
            el.style.transition = '';
          });
        }, 460);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(cleanupT);
    };
  }, [order, hidden]);

  // Median interval between incoming stream pushes — drives the Data Flow
  // animation so it syncs with the real push rate (recomputed per push).
  const pushRate = useMemo(() => {
    const arr = pushTimesRef.current;
    if (arr.length < 2) return { ms: null, at: null };
    const gaps = [];
    for (let i = 1; i < arr.length; i++) gaps.push(arr[i] - arr[i - 1]);
    gaps.sort((a, b) => a - b);
    return { ms: gaps[Math.floor(gaps.length / 2)] || null, at: arr[arr.length - 1] };
  }, [data]);
  const pushMs = pushRate.ms;
  const pushAt = pushRate.at;

  const ctx = {
    cable: data?.cable || {},
    power: data?.power || {},
    internet: data?.internet || {},
    memory: data?.memory || {},
    testing,
    runFullTest,
    history: historyRef.current,
    pushMs,
    pushAt,
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
            Live USB throughput · link speed · charge rate
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

      {data && (              <main ref={gridRef} className="grid" onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}>
          {visible.map((key, i) => {
            const w = WIDGETS.find((x) => x.key === key);
            if (!w) return null;
            return (
              <section
                key={key}
                data-key={key}
                className={`widget${w.span === 2 ? ' w-2' : ''}${dragKey === key ? ' dragging' : ''}${removing === key ? ' removing' : ''}`}
                style={{ animationDelay: `${Math.min(i, 6) * 45}ms` }}
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
        {data?.ts && <span className="updated">updated {new Date(data.ts).toLocaleTimeString()}</span>}
      </div>
    </>
  );
}
