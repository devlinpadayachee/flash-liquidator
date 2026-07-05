/* ILLYRIAN dashboard client — SSE stream + instrument rendering. */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    status: {}, config: {}, connection: {},
    stats: {}, positions: { atRisk: [], liquidatable: [] },
    events: [], profitHistory: [], logs: [],
  };

  // ---- token handling ----
  const urlToken = new URLSearchParams(location.search).get('token');
  let token = urlToken || localStorage.getItem('illyrian_token') || '';
  if (urlToken) localStorage.setItem('illyrian_token', urlToken);
  const withToken = (url) => (token ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : url);

  // ================= helpers =================
  const money = (n, dp = 2) => {
    const v = Number(n) || 0;
    const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    return (v < 0 ? '-$' : '$') + s;
  };
  const compact = (n) => {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(Math.round(v));
  };
  const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
  const pad2 = (n) => String(n).padStart(2, '0');
  const hashUnit = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };
  const threshold = () => { const t = Number(state.config.watchThreshold) || 1.5; return t > 1.02 ? t : 1.5; };
  const hfColor = (hf) => hf <= 1.03 ? '#FF5E4D' : hf <= 1.12 ? '#F4B740' : '#35C8B6';
  const timeAgo = (ts) => {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  };
  const setText = (sel, text, flash) => {
    const el = typeof sel === 'string' ? $(sel) : sel;
    if (!el || el.textContent === text) return;
    el.textContent = text;
    if (flash && !reduceMotion) { el.classList.remove('value-flash'); void el.offsetWidth; el.classList.add('value-flash'); }
  };

  // count-up for the hero number
  const counters = new WeakMap();
  function countTo(el, to, fmt) {
    if (!el) return;
    const from = counters.get(el) ?? to;
    counters.set(el, to);
    if (reduceMotion || from === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 600;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ================= canvas base =================
  function fitCanvas(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = cv.getBoundingClientRect();
    cv.width = Math.max(1, Math.floor(r.width * dpr));
    cv.height = Math.max(1, Math.floor(r.height * dpr));
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: r.width, h: r.height };
  }

  // ================= ECG heartbeat =================
  const ecg = $('#ecg');
  let ecgPhase = 0, beatKick = 0;
  function drawEcg() {
    if (!ecg) return;
    const { ctx, w, h } = fitCanvas(ecg);
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    ctx.lineWidth = 1.4; ctx.strokeStyle = '#35C8B6';
    ctx.shadowColor = '#35C8B6'; ctx.shadowBlur = 6;
    ctx.beginPath();
    for (let x = 0; x <= w; x++) {
      const p = (x / w) * 6 + ecgPhase;
      const beat = p % 2;
      let y = 0;
      if (beat > 1.5 && beat < 1.72) { const q = (beat - 1.5) / 0.22; y = Math.sin(q * Math.PI * 2) * (0.9 + beatKick); }
      else y = Math.sin(p * 3) * 0.06;
      const yy = mid - y * (h * 0.36);
      x === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
    }
    ctx.stroke(); ctx.shadowBlur = 0;
  }

  // ================= THE LINE =================
  const line = $('#line'), tip = $('#tip'), lineEmpty = $('#lineEmpty');
  const dots = new Map(); // address -> {x, tx, y, r, hf, debt, strike}
  let hover = null;
  function syncDots() {
    const th = threshold();
    const seen = new Set();
    const place = (list, strike) => {
      for (const p of list) {
        if (!p.address) continue;
        seen.add(p.address);
        const t = Math.max(0, Math.min(1, (p.healthFactor - 1) / (th - 1)));
        const d = dots.get(p.address) || { x: null, y: hashUnit(p.address), r: 4, born: performance.now() };
        d.t = t; d.hf = p.healthFactor; d.debt = p.totalDebtUSD; d.strike = strike; d.proto = p.protocol;
        d.r = Math.max(3, Math.min(15, 3 + Math.sqrt((p.totalDebtUSD || 0)) / 6));
        dots.set(p.address, d);
      }
    };
    place(state.positions.atRisk || [], false);
    place(state.positions.liquidatable || [], true);
    for (const k of dots.keys()) if (!seen.has(k)) dots.delete(k);
    const empty = dots.size === 0;
    if (lineEmpty) lineEmpty.hidden = !empty;
  }
  function drawLine(now) {
    if (!line) return;
    const { ctx, w, h } = fitCanvas(line);
    ctx.clearRect(0, 0, w, h);
    const padL = 34, padT = 16, padB = 26;
    const lineX = w * 0.84, plotH = h - padT - padB;

    // strike zone wash
    const g = ctx.createLinearGradient(lineX, 0, w, 0);
    g.addColorStop(0, 'rgba(255,94,77,.14)'); g.addColorStop(1, 'rgba(255,94,77,.02)');
    ctx.fillStyle = g; ctx.fillRect(lineX, padT - 6, w - lineX, plotH + 12);

    // HF axis ticks
    const th = threshold();
    ctx.font = '10px "JetBrains Mono", monospace'; ctx.textAlign = 'center';
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const hf = 1 + (th - 1) * (1 - i / ticks);
      const t = (hf - 1) / (th - 1);
      const x = lineX - t * (lineX - padL);
      ctx.strokeStyle = 'rgba(27,58,68,.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padT - 6); ctx.lineTo(x, h - padB + 4); ctx.stroke();
      ctx.fillStyle = '#3C565E'; ctx.fillText(hf.toFixed(2), x, h - padB + 16);
    }

    // the liquidation line
    const pulse = reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(now / 380);
    ctx.strokeStyle = '#FF5E4D'; ctx.lineWidth = 2;
    ctx.shadowColor = '#FF5E4D'; ctx.shadowBlur = 10 + pulse * 14;
    ctx.beginPath(); ctx.moveTo(lineX, padT - 6); ctx.lineTo(lineX, h - padB + 4); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#FF5E4D'; ctx.textAlign = 'left'; ctx.font = '9px "JetBrains Mono", monospace';
    ctx.save(); ctx.translate(lineX + 5, padT + 2); ctx.fillText('LIQUIDATION', 0, 0); ctx.restore();

    // dots
    hover = null;
    const mx = mouse.x, my = mouse.y;
    for (const [addr, d] of dots) {
      const targetX = d.strike ? lineX + (w - lineX) * (0.25 + d.y * 0.5) : lineX - d.t * (lineX - padL);
      if (d.x == null) d.x = targetX;
      d.x += (targetX - d.x) * (reduceMotion ? 1 : 0.12);
      const y = padT + d.y * plotH;
      const near = d.hf <= 1.03 || d.strike;
      const beat = near && !reduceMotion ? 1 + 0.25 * Math.sin(now / 180 + d.y * 6) : 1;
      const r = d.r * beat;
      const col = d.strike ? '#FF5E4D' : hfColor(d.hf);
      ctx.beginPath(); ctx.arc(d.x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.globalAlpha = d.strike ? (0.6 + 0.4 * Math.abs(Math.sin(now / 200))) : 0.85;
      if (near) { ctx.shadowColor = col; ctx.shadowBlur = 12; }
      ctx.fill(); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      // halo ring
      ctx.beginPath(); ctx.arc(d.x, y, r + 3, 0, Math.PI * 2);
      ctx.strokeStyle = col; ctx.globalAlpha = 0.18; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
      if (mx != null && Math.hypot(mx - d.x, my - y) < r + 5) hover = { addr, d, x: d.x, y };
    }

    // tooltip
    if (hover && tip) {
      tip.hidden = false;
      tip.style.left = hover.x + 'px'; tip.style.top = hover.y + 'px';
      tip.innerHTML = `<b>${short(hover.addr)}</b><br>HF <span class="hf">${hover.d.hf.toFixed(4)}</span><br>debt ${money(hover.d.debt, 0)}${hover.d.strike ? '<br>⚡ liquidatable' : ''}`;
    } else if (tip) tip.hidden = true;
  }

  const mouse = { x: null, y: null };
  if (line) {
    const stage = line.parentElement;
    stage.addEventListener('mousemove', (e) => { const r = line.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; });
    stage.addEventListener('mouseleave', () => { mouse.x = mouse.y = null; });
  }

  // ================= sparkline =================
  const spark = $('#spark');
  function drawSpark() {
    if (!spark) return;
    const { ctx, w, h } = fitCanvas(spark);
    ctx.clearRect(0, 0, w, h);
    const hist = state.profitHistory || [];
    const pad = 6;
    const vals = hist.map((p) => p.cumulative);
    const max = Math.max(0.0001, ...vals), min = Math.min(0, ...vals);
    const range = max - min || 1;
    const n = hist.length;
    const X = (i) => pad + (n <= 1 ? 0 : (i / (n - 1)) * (w - pad * 2));
    const Y = (v) => h - pad - ((v - min) / range) * (h - pad * 2);

    // baseline
    ctx.strokeStyle = 'rgba(27,58,68,.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, Y(0)); ctx.lineTo(w - pad, Y(0)); ctx.stroke();

    if (n === 0) {
      ctx.fillStyle = '#3C565E'; ctx.font = '11px "JetBrains Mono", monospace'; ctx.textAlign = 'center';
      ctx.fillText('awaiting first take', w / 2, h / 2); return;
    }
    // area
    ctx.beginPath(); ctx.moveTo(X(0), Y(vals[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(X(i), Y(vals[i]));
    const lastX = X(n - 1), lastY = Y(vals[n - 1]);
    ctx.lineTo(lastX, Y(min)); ctx.lineTo(X(0), Y(min)); ctx.closePath();
    const fill = ctx.createLinearGradient(0, 0, 0, h);
    fill.addColorStop(0, 'rgba(244,183,64,.28)'); fill.addColorStop(1, 'rgba(244,183,64,0)');
    ctx.fillStyle = fill; ctx.fill();
    // line
    ctx.beginPath(); ctx.moveTo(X(0), Y(vals[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(X(i), Y(vals[i]));
    ctx.strokeStyle = '#F4B740'; ctx.lineWidth = 1.6; ctx.shadowColor = '#F4B740'; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
    // head
    ctx.beginPath(); ctx.arc(lastX, lastY, 3, 0, Math.PI * 2); ctx.fillStyle = '#F4B740'; ctx.fill();
  }

  // ================= renderers =================
  function renderStatus() {
    const s = state.status;
    setText('[data-f="chain"]', s.chain || '—');
    setText('[data-f="wallet"]', s.walletShort || short(s.wallet));
    setText('[data-f="balance"]', s.balanceNative != null ? (Number(s.balanceNative).toFixed(3) + ' ' + (s.nativeToken || '')) : '—');
    setText('[data-f="contract"]', s.contractShort || '—');

    const pill = $('#statePill'), txt = $('#stateText');
    pill.classList.remove('is-live', 'is-dry', 'is-down');
    if (!connected) { pill.classList.add('is-down'); txt.textContent = 'OFFLINE'; }
    else if (s.dryRun) { pill.classList.add('is-dry'); txt.textContent = 'DRY RUN'; }
    else if (s.running) { pill.classList.add('is-live'); txt.textContent = 'HUNTING'; }
    else { txt.textContent = 'IDLE'; }

    const c = state.config;
    setText('#minProfit', c.minProfitUSD != null ? money(c.minProfitUSD) : '—');
    setText('#maxGas', c.maxGasUSD != null ? money(c.maxGasUSD) : '—');
    setText('#slippage', c.slippagePercent != null ? c.slippagePercent + '%' : '—');
  }

  function renderVitals() {
    const st = state.stats;
    countTo($('#netTake'), st.netProfitUSD || 0, (v) => money(v));
    setText('#grossTake', money(st.totalProfitUSD || 0));
    setText('#gasSpent', money(st.totalGasSpentUSD || 0));
    $('#execRate').innerHTML = (st.liquidationsSuccessful || 0) + '<em>/' + (st.liquidationsAttempted || 0) + '</em>';
    setText('#winRate', (st.liquidationsAttempted ? (st.successRate || 0).toFixed(0) + '%' : '—'));
    setText('#tracked', compact(st.borrowersTracked || 0), true);
    setText('#atRisk', String(st.atRiskCount || 0), true);
    // mode string
    const c = state.connection;
    const modes = [];
    if (c.wss) modes.push('WSS'); if (c.mempool) modes.push('MEMPOOL'); if (c.subgraph) modes.push('SUBGRAPH');
    setText('#modeStr', modes.length ? modes.join(' + ') : 'POLLING');
  }

  function renderConns() {
    const c = state.connection;
    for (const k of ['wss', 'mempool', 'subgraph']) {
      const el = document.querySelector('.conn[data-k="' + k + '"]');
      if (el) el.classList.toggle('on', !!c[k]);
    }
    setText('#rpcMin', String(c.rpcCallsPerMin || 0));
  }

  function renderWatch() {
    const body = $('#watchBody');
    const list = [...(state.positions.atRisk || [])].sort((a, b) => a.healthFactor - b.healthFactor).slice(0, 40);
    setText('#watchCount', String(state.stats.atRiskCount || list.length));
    setText('#strikeCount', String((state.positions.liquidatable || []).length));
    if (!list.length) { body.innerHTML = '<div class="empty">No positions near the line. The market is healthy — standing by.</div>'; return; }
    const th = threshold();
    const seen = new Set([...body.querySelectorAll('.tr')].map((r) => r.dataset.addr));
    body.innerHTML = list.map((p) => {
      const prox = Math.max(0, Math.min(1, 1 - (p.healthFactor - 1) / (th - 1)));
      const col = hfColor(p.healthFactor);
      const isNew = !seen.has(p.address);
      return `<div class="tr ${isNew ? 'row-enter' : ''}" data-addr="${p.address}" role="row">
        <span class="addr">${short(p.address)}</span>
        <span class="hf" style="color:${col}">${p.healthFactor.toFixed(4)}</span>
        <span class="debt">${money(p.totalDebtUSD, 0)}</span>
        <span class="prox"><i style="width:${(prox * 100).toFixed(0)}%;background:${col}"></i></span>
      </div>`;
    }).join('');
  }

  let lastEventTs = 0;
  function renderEvents() {
    const feed = $('#eventFeed');
    const evs = state.events || [];
    if (!evs.length) { feed.innerHTML = '<div class="feed__empty" id="eventEmpty">No attempts yet. On the hunt.</div>'; return; }
    feed.innerHTML = evs.slice(0, 40).map((e) => {
      const cls = e.success ? (e.simulated ? 'ev--sim' : 'ev--win') : 'ev--miss';
      const tag = e.success ? (e.simulated ? 'SIM' : 'EXECUTED') : 'MISS';
      const val = e.success && e.profit != null ? money(e.profit) : '';
      const main = e.success
        ? `<span class="muted">${short(e.borrower)}</span> ${e.txHash ? 'confirmed' : ''}`
        : `<span class="muted">${short(e.borrower)}</span> ${e.reason || 'failed'}`;
      const fresh = e.ts > lastEventTs ? 'ev-in' : '';
      return `<div class="ev ${cls} ${fresh}">
        <span class="ev__tag">${tag}</span>
        <span class="ev__main">${main}</span>
        <span class="ev__val">${val}</span>
        <span class="ev__time">${timeAgo(e.ts)}${e.debtUSD ? ' · debt ' + money(e.debtUSD, 0) : ''}</span>
      </div>`;
    }).join('');
    lastEventTs = evs[0].ts;
  }

  // ---- logs ----
  const logEl = $('#log');
  let logPaused = false;
  $('#pauseLog')?.addEventListener('click', (e) => {
    logPaused = !logPaused; e.target.setAttribute('aria-pressed', String(logPaused)); e.target.textContent = logPaused ? 'resume' : 'pause';
  });
  function appendLog(line) {
    if (!logEl || logPaused) return;
    const t = new Date(line.ts); const ts = pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
    const div = document.createElement('div');
    div.className = 'log__line ' + (line.level || 'info');
    div.innerHTML = `<span class="log__t">${ts}</span><span class="log__m"></span>`;
    div.querySelector('.log__m').textContent = line.msg;
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    logEl.appendChild(div);
    while (logEl.children.length > 400) logEl.removeChild(logEl.firstChild);
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }
  function seedLogs(lines) { if (!logEl) return; logEl.innerHTML = ''; (lines || []).slice(-120).forEach(appendLog); }

  function renderAll() { renderStatus(); renderVitals(); renderConns(); renderWatch(); renderEvents(); syncDots(); drawSpark(); }

  // ================= SSE =================
  let connected = false, es = null;
  function apply(type, data) {
    if (type === 'snapshot') {
      Object.assign(state, data);
      renderAll();
      beatKick = reduceMotion ? 0 : 0.7; // heartbeat kick on each tick
    } else if (type === 'status') {
      if (data.status) Object.assign(state.status, data.status);
      if (data.config) Object.assign(state.config, data.config);
      renderStatus(); renderVitals();
    } else if (type === 'event') {
      state.events.unshift(data); if (state.events.length > 100) state.events.pop();
      renderEvents(); renderVitals();
    } else if (type === 'log') {
      state.logs.push(data); appendLog(data);
    }
  }

  async function boot() {
    // check auth requirement
    try {
      const meta = await fetch('/api/meta').then((r) => r.json());
      if (meta.tokenRequired && !token) return showGate();
    } catch (_) {}
    try {
      const res = await fetch(withToken('/api/state'));
      if (res.status === 401) return showGate(true);
      const data = await res.json();
      Object.assign(state, data);
      seedLogs(state.logs);
      renderAll();
      document.body.dataset.status = 'ready';
    } catch (e) {
      document.body.dataset.status = 'ready';
    }
    connectStream();
  }

  function connectStream() {
    if (es) es.close();
    es = new EventSource(withToken('/api/stream'));
    const bump = () => { connected = true; renderStatus(); };
    es.addEventListener('snapshot', (e) => { bump(); apply('snapshot', JSON.parse(e.data)); });
    es.addEventListener('status', (e) => { bump(); apply('status', JSON.parse(e.data)); });
    es.addEventListener('event', (e) => { bump(); apply('event', JSON.parse(e.data)); });
    es.addEventListener('log', (e) => { bump(); apply('log', JSON.parse(e.data)); });
    es.onopen = bump;
    es.onerror = () => { connected = false; renderStatus(); };
  }

  // ---- gate ----
  function showGate(err) {
    document.body.dataset.status = 'ready';
    const gate = $('#gate'); gate.hidden = false;
    if (err) $('#gateErr').hidden = false;
    $('#gateForm').addEventListener('submit', (e) => {
      e.preventDefault();
      token = $('#gateInput').value.trim();
      localStorage.setItem('illyrian_token', token);
      gate.hidden = true; boot();
    }, { once: true });
    $('#gateInput').focus();
  }

  // ================= clock + rAF =================
  function tickClock() {
    const t = new Date();
    setText('#clock', pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds()));
  }
  setInterval(tickClock, 1000); tickClock();
  setInterval(() => { if (state.events.length) renderEvents(); }, 15000); // refresh "time ago"

  function frame(now) {
    ecgPhase += reduceMotion ? 0 : 0.012;
    beatKick *= 0.94;
    drawEcg();
    drawLine(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(drawSpark, 120); });

  boot();
})();
