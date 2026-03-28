/* ═══════════════════════════════════════════════════════════════════════════
   LIVE MONITOR  v1.0  —  Real-time system health dashboard
   ═══════════════════════════════════════════════════════════════════════════
   Polls all runtime objects every 5s. Reads EE, GII_AGENT_MANAGER,
   broker connections, and feeds. Renders into #lmPanel inside the
   "System Monitor" nav section. No modifications to EE, agents, or APIs.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS      = 5000;
  var HISTORY_MAX  = 60;   // 5 min at 5-second intervals

  /* ── Rolling history buffers ──────────────────────────────────────────── */
  var _hist = {
    ts:          [],
    openTrades:  [],
    sessionPnl:  [],
    agentErrors: [],
    latencyMs:   []
  };

  /* ── Helpers ──────────────────────────────────────────────────────────── */
  function _age(ts) {
    if (!ts) return '—';
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 5)    return 'just now';
    if (s < 60)   return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return Math.round(s / 3600) + 'h';
  }

  function _num(n, dec) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return (+n).toLocaleString(undefined, { maximumFractionDigits: dec !== undefined ? dec : 2 });
  }

  function _safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback !== undefined ? fallback : null; }
  }

  function _push(arr, val) {
    arr.push(val);
    if (arr.length > HISTORY_MAX) arr.shift();
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /* ── Data collection ──────────────────────────────────────────────────── */
  function _collect() {
    var now = Date.now();
    var m = { ts: now, ee: {}, mgr: {}, apis: {}, faults: {}, alerts: [] };

    /* ── EE ── */
    m.ee.loaded       = !!window.EE;
    m.ee.halted       = _safe(function(){ return EE.isHalted(); }, false);
    m.ee.mode         = _safe(function(){ return window._eeCfg ? _eeCfg.mode : null; });
    m.ee.enabled      = _safe(function(){ return window._eeCfg ? _eeCfg.enabled : null; });
    m.ee.balance      = _safe(function(){ return window._eeCfg ? _eeCfg.virtual_balance : null; });
    m.ee.openCount    = _safe(function(){
      var el = document.getElementById('eeOpenCount');
      return el ? parseInt(el.textContent, 10) || 0 : null;
    });
    m.ee.heartbeat    = window._eeLastMonitor || null;
    m.ee.heartbeatAge = m.ee.heartbeat ? (now - m.ee.heartbeat) : null;
    m.ee.fillLatency  = _safe(function(){ return EE.fillLatencyStats(); }, null);
    /* _apiOnline is private inside the EE closure — read via the exposed method */
    m.ee.apiOnline    = _safe(function(){ return EE.isBackendOnline(); }, null);

    /* Session P&L — read from status badge text */
    m.ee.sessionPnl = _safe(function(){
      var el = document.getElementById('eeBadgePnl');
      if (!el) return null;
      var t = el.textContent.replace(/[^0-9.\-]/g, '');
      var v = parseFloat(t);
      return el.textContent.indexOf('-') !== -1 ? -Math.abs(v) : Math.abs(v);
    }, null);

    /* Win rate — from badge */
    m.ee.winRate = _safe(function(){
      var el = document.getElementById('eeBadgeRate');
      if (!el) return null;
      var m2 = el.textContent.match(/(\d+)%/);
      return m2 ? parseInt(m2[1], 10) : null;
    }, null);

    /* Closed trade count (from badge text like "47% WIN (23)") */
    m.ee.closedCount = _safe(function(){
      var el = document.getElementById('eeBadgeRate');
      if (!el) return null;
      var m2 = el.textContent.match(/\((\d+)\)/);
      return m2 ? parseInt(m2[1], 10) : null;
    }, null);

    /* Macro regime */
    m.ee.regime = _safe(function(){
      var el = document.getElementById('macroRegimeBadge');
      return el ? el.textContent.trim() : null;
    }, null);

    /* Econ calendar gate */
    m.ee.econGate = _safe(function(){
      var el = document.getElementById('econCalBadge');
      return el ? el.textContent.trim() : null;
    }, null);

    /* ── Agent Manager ── */
    if (window.GII_AGENT_MANAGER) {
      var st  = _safe(function(){ return GII_AGENT_MANAGER.status(); }, {});
      var hr  = _safe(function(){ return GII_AGENT_MANAGER.healthReport(); }, {});
      m.mgr.lastCheck     = st.lastCheck    || 0;
      m.mgr.checkCount    = st.checkCount   || 0;
      m.mgr.activeAlerts  = st.activeAlerts || 0;
      m.mgr.errors        = st.errors       || 0;
      m.mgr.warnings      = st.warnings     || 0;
      m.mgr.overallHealth = st.overallHealth || 'pending';
      m.mgr.agentStatuses = st.agentStatuses || {};
      m.mgr.agents        = (hr && hr.agents) ? hr.agents : {};
      m.alerts = _safe(function(){ return GII_AGENT_MANAGER.alerts() || []; }, []);
    }

    /* ── Brokers & Feeds ── */
    m.apis.oanda = _safe(function(){
      if (!window.OANDABroker) return null;
      var s = OANDABroker.status ? OANDABroker.status() : {};
      return { connected: OANDABroker.isConnected(), nav: s.nav, account: s.account };
    });
    m.apis.alpaca = _safe(function(){
      if (!window.AlpacaBroker) return null;
      var s = AlpacaBroker.status ? AlpacaBroker.status() : {};
      return { connected: AlpacaBroker.isConnected(), equity: s.equity, buyingPow: s.buyingPow };
    });
    m.apis.hl = _safe(function(){
      if (!window.HLBroker) return null;
      var s = HLBroker.status ? HLBroker.status() : {};
      return { connected: HLBroker.isConnected(), equity: s.equity };
    });
    m.apis.hlFeed = _safe(function(){
      if (!window.HLFEED) return null;
      return {
        connected: typeof HLFEED.isConnected === 'function' ? HLFEED.isConnected() : null,
        lastMsgAge: typeof HLFEED.lastMessageAge === 'function' ? HLFEED.lastMessageAge() : null
      };
    });
    m.apis.oandaRates = _safe(function(){
      if (!window.OANDA_RATES) return null;
      return {
        connected: OANDA_RATES.isConnected(),
        lastUpdate: typeof OANDA_RATES.lastUpdate === 'function' ? OANDA_RATES.lastUpdate() : null
      };
    });
    m.apis.backend = m.ee.apiOnline;

    /* COT backoff */
    m.apis.cotBackoff = _safe(function(){
      return window.COT_SIGNALS && COT_SIGNALS.status ? COT_SIGNALS.status() : null;
    });

    return m;
  }

  /* ── Health score calculation ─────────────────────────────────────────── */
  function _score(m) {
    var pts    = 100;
    var status = 'READY';
    var issues = [];

    if (m.ee.halted) {
      pts -= 25; issues.push('Kill switch ACTIVE');
    }
    if (m.ee.heartbeatAge !== null && m.ee.heartbeatAge > 60000) {
      pts -= 20; issues.push('EE heartbeat stalled ' + _age(m.ee.heartbeat));
    }
    if (m.mgr.errors > 0) {
      pts -= Math.min(30, m.mgr.errors * 8);
      issues.push(m.mgr.errors + ' agent error' + (m.mgr.errors > 1 ? 's' : ''));
    }
    if (m.mgr.warnings > 2) {
      pts -= 5; issues.push(m.mgr.warnings + ' agent warnings');
    }
    if (m.apis.oanda  && !m.apis.oanda.connected)  { pts -= 8;  issues.push('OANDA disconnected'); }
    if (m.apis.alpaca && !m.apis.alpaca.connected)  { pts -= 8;  issues.push('Alpaca disconnected'); }
    if (m.apis.hl     && !m.apis.hl.connected)      { pts -= 8;  issues.push('HL disconnected'); }
    if (m.apis.backend === false)                   { pts -= 5;  issues.push('Backend offline'); }
    if (!m.ee.enabled)                              { pts -= 5;  issues.push('Auto-execute off'); }

    pts = Math.max(0, pts);
    if (pts <= 50) status = 'CRITICAL';
    else if (pts <= 75) status = 'WARNING';

    return { score: pts, status: status, issues: issues };
  }

  /* ── Push to history ──────────────────────────────────────────────────── */
  function _recordHistory(m) {
    _push(_hist.ts,          m.ts);
    _push(_hist.openTrades,  m.ee.openCount || 0);
    _push(_hist.sessionPnl,  m.ee.sessionPnl || 0);
    _push(_hist.agentErrors, m.mgr.errors || 0);
    _push(_hist.latencyMs,   (m.ee.fillLatency && m.ee.fillLatency.avgMs) || 0);
  }

  /* ── Canvas sparkline ─────────────────────────────────────────────────── */
  function _spark(id, data, color, forceMin) {
    var c = document.getElementById(id);
    if (!c || !data || data.length < 2) return;
    var ctx = c.getContext('2d');
    var W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);

    var lo = forceMin !== undefined ? forceMin : Math.min.apply(null, data);
    var hi = Math.max.apply(null, data);
    if (hi === lo) hi = lo + 1;

    /* Fill under line */
    ctx.beginPath();
    data.forEach(function(v, i) {
      var x = (i / (data.length - 1)) * W;
      var y = H - ((v - lo) / (hi - lo)) * (H - 2) - 1;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fillStyle = color.replace(')', ',0.12)').replace('rgb', 'rgba');
    ctx.fill();

    /* Line */
    ctx.beginPath();
    data.forEach(function(v, i) {
      var x = (i / (data.length - 1)) * W;
      var y = H - ((v - lo) / (hi - lo)) * (H - 2) - 1;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    /* Current value dot */
    var lastVal = data[data.length - 1];
    var lx = W, ly = H - ((lastVal - lo) / (hi - lo)) * (H - 2) - 1;
    ctx.beginPath();
    ctx.arc(lx - 1, ly, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  /* ── HTML builder helpers ─────────────────────────────────────────────── */
  var G = '<span class="lm-g">●</span>';
  var A = '<span class="lm-a">●</span>';
  var R = '<span class="lm-r">●</span>';

  function _dot(status) {
    if (status === 'ok'    || status === true)    return G;
    if (status === 'warn'  || status === 'warning') return A;
    if (status === 'error' || status === false)   return R;
    return '<span class="lm-d">●</span>';
  }

  function _conn(v) {
    if (v === null || v === undefined) return '<span class="lm-d">—</span>';
    return v ? '<span class="lm-g">🟢 OK</span>' : '<span class="lm-r">🔴 Down</span>';
  }

  function _tr(cells, cls) {
    return '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' +
      cells.map(function(c){ return '<td>' + c + '</td>'; }).join('') +
    '</tr>';
  }

  /* ── Main render ──────────────────────────────────────────────────────── */
  function _render(m, h) {
    var el = document.getElementById('lmPanel');
    if (!el) return;

    var now = Date.now();
    var html = '';

    /* ──────────── STATUS BANNER ──────────── */
    var bannerCls = h.status === 'READY' ? 'lm-banner-ready'
                  : h.status === 'CRITICAL' ? 'lm-banner-crit' : 'lm-banner-warn';
    html +=
      '<div class="lm-banner ' + bannerCls + '">' +
        '<span class="lm-banner-status">' + h.status + '</span>' +
        '<span class="lm-banner-score">Health&thinsp;' + h.score + '%</span>' +
        '<span class="lm-banner-time">⟳ ' + new Date().toLocaleTimeString() + '</span>' +
        (h.issues.length
          ? '<span class="lm-banner-issues">' + _esc(h.issues.join(' · ')) + '</span>'
          : '<span class="lm-banner-issues lm-g">All systems nominal</span>') +
      '</div>';

    /* ──────────── TOP 5 ALERTS ──────────── */
    var allAlerts = (m.alerts || []).slice();

    /* Inject system-derived critical alerts at the front */
    if (m.ee.halted) {
      allAlerts.unshift({ severity: 'error', agent: 'KILL SWITCH',
        message: 'All new trade execution is HALTED — click HALT button to resume' });
    }
    if (m.ee.heartbeatAge !== null && m.ee.heartbeatAge > 60000) {
      allAlerts.unshift({ severity: 'error', agent: 'EE HEARTBEAT',
        message: 'Monitor loop stalled — last cycle ' + _age(m.ee.heartbeat) + ' ago (expected <30s)' });
    }
    if (m.apis.backend === false) {
      allAlerts.unshift({ severity: 'warn', agent: 'BACKEND',
        message: 'localhost:8765 offline — trades persisting to localStorage fallback only' });
    }
    if (m.apis.hlFeed && m.apis.hlFeed.lastMsgAge > 30000) {
      allAlerts.unshift({ severity: 'warn', agent: 'HL FEED',
        message: 'WebSocket feed stale — last message ' + Math.round(m.apis.hlFeed.lastMsgAge / 1000) + 's ago' });
    }

    var top5 = allAlerts.slice(0, 5);
    html += '<div class="lm-card">';
    html += '<div class="lm-card-title">⚡ TOP ALERTS <span class="lm-count">' + (top5.length || 0) + '</span></div>';
    if (top5.length) {
      top5.forEach(function(a) {
        var isCrit = (a.severity === 'error' || a.severity === 'critical');
        html +=
          '<div class="lm-alert ' + (isCrit ? 'lm-alert-crit' : 'lm-alert-warn') + '">' +
            (isCrit ? '🔴' : '🟡') + ' <strong>' + _esc(a.agent || '') + '</strong>' +
            (a.agent ? ' — ' : '') + _esc(a.message || a.msg || '') +
            (a.time ? ' <span class="lm-alert-ts">' + a.time + '</span>' : '') +
          '</div>';
      });
    } else {
      html += '<div class="lm-none lm-g">✅ No active alerts — all systems normal</div>';
    }
    html += '</div>';

    /* ──────────── EE ENGINE TABLE ──────────── */
    var heartOk   = m.ee.heartbeatAge !== null && m.ee.heartbeatAge < 60000;
    var latStats  = m.ee.fillLatency;
    var pnlCls    = m.ee.sessionPnl === null ? '' : m.ee.sessionPnl >= 0 ? 'lm-g' : (m.ee.sessionPnl < -100 ? 'lm-r' : 'lm-a');

    html += '<div class="lm-card">';
    html += '<div class="lm-card-title">⚙ EE EXECUTION ENGINE</div>';
    html +=
      '<table class="lm-tbl"><thead><tr>' +
        '<th>Metric</th><th>Value</th><th>●</th><th>Notes</th>' +
      '</tr></thead><tbody>';

    html += _tr([
      'Mode',
      '<strong>' + _esc(m.ee.mode || '—') + '</strong>',
      m.ee.mode === 'LIVE' ? A : G,
      m.ee.mode === 'LIVE' ? '⚠ Real-money execution active' : 'Paper trading — safe'
    ]);
    html += _tr([
      'Kill Switch',
      m.ee.halted ? '<span class="lm-r">🛑 HALTED</span>' : '<span class="lm-g">✅ Clear</span>',
      m.ee.halted ? R : G,
      m.ee.halted ? 'Click HALT button in header to resume' : 'No halt active'
    ]);
    html += _tr([
      'Auto-Execute',
      m.ee.enabled ? '<span class="lm-g">▶ ON</span>' : '<span class="lm-a">■ OFF</span>',
      m.ee.enabled ? G : A,
      m.ee.enabled ? 'Accepting signals' : 'Execution paused'
    ]);
    html += _tr([
      'Open Trades',
      m.ee.openCount !== null ? String(m.ee.openCount) : '—',
      m.ee.openCount > 8 ? A : G,
      m.ee.openCount > 8 ? 'Approaching max capacity' : 'Normal'
    ]);
    html += _tr([
      'Session P&L',
      m.ee.sessionPnl !== null
        ? '<span class="' + pnlCls + '">' + (m.ee.sessionPnl >= 0 ? '+$' : '-$') + _num(Math.abs(m.ee.sessionPnl)) + '</span>'
        : '—',
      m.ee.sessionPnl < -100 ? R : m.ee.sessionPnl < 0 ? A : G,
      ''
    ]);
    html += _tr([
      'Win Rate',
      m.ee.winRate !== null
        ? m.ee.winRate + '% <span class="lm-d">(' + (m.ee.closedCount || 0) + ' trades)</span>'
        : '—',
      m.ee.winRate !== null && m.ee.winRate < 40 ? A : G,
      m.ee.closedCount < 20 ? 'Sample too small for significance' : ''
    ]);
    html += _tr([
      'EE Heartbeat',
      m.ee.heartbeat ? _age(m.ee.heartbeat) + ' ago' : '<span class="lm-a">never</span>',
      heartOk ? G : R,
      heartOk ? 'Monitor loop active' : 'Loop may be stalled — check console'
    ]);
    html += _tr([
      'Market Regime',
      _esc(m.ee.regime || '—'),
      G,
      'Affects position sizing multiplier'
    ]);
    html += _tr([
      'Econ Gate',
      _esc(m.ee.econGate || '—'),
      G,
      'Events within gate window block new trades'
    ]);
    html += _tr([
      'Avg Fill Latency',
      latStats && latStats.count
        ? latStats.avgS + 's <span class="lm-d">(' + latStats.count + ' fills)</span>'
        : '<span class="lm-d">— (no fills yet)</span>',
      latStats && latStats.avgMs > 8000 ? A : G,
      latStats && latStats.count ? 'Max: ' + (latStats.maxMs / 1000).toFixed(1) + 's · Min: ' + (latStats.minMs / 1000).toFixed(1) + 's' : ''
    ]);
    html += _tr([
      'Backend (8765)',
      m.ee.apiOnline === null ? '—' : m.ee.apiOnline ? '<span class="lm-g">Online</span>' : '<span class="lm-a">Offline</span>',
      m.ee.apiOnline === false ? A : G,
      m.ee.apiOnline === false ? 'localStorage fallback active' : 'SQLite persistence active'
    ]);

    html += '</tbody></table>';

    /* Sparklines */
    html +=
      '<div class="lm-sparks">' +
        '<div class="lm-spark-cell"><div class="lm-spark-lbl">Open Trades (5 min)</div><canvas id="lmSOpen"  width="150" height="28"></canvas></div>' +
        '<div class="lm-spark-cell"><div class="lm-spark-lbl">Session P&L ($)</div>   <canvas id="lmSPnl"   width="150" height="28"></canvas></div>' +
        '<div class="lm-spark-cell"><div class="lm-spark-lbl">Avg Latency (ms)</div>  <canvas id="lmSLat"   width="150" height="28"></canvas></div>' +
      '</div>';
    html += '</div>';

    /* ──────────── AGENT NETWORK TABLE ──────────── */
    html += '<div class="lm-card">';
    html += '<div class="lm-card-title">🤖 AGENT NETWORK' +
      (m.mgr.checkCount ? ' <span class="lm-d" style="font-weight:normal;font-size:8px">· last check ' + _age(m.mgr.lastCheck) + ' ago · #' + m.mgr.checkCount + '</span>' : '') +
      '</div>';
    html +=
      '<table class="lm-tbl"><thead><tr>' +
        '<th>Agent</th><th>Loaded</th><th>Last Poll</th><th>Status</th><th>Notes</th>' +
      '</tr></thead><tbody>';

    var agentKeys = Object.keys(m.mgr.agents || {});
    if (!agentKeys.length) {
      html += '<tr><td colspan="5" class="lm-d" style="padding:8px;text-align:center">Waiting for first manager health check (~30s after load)…</td></tr>';
    } else {
      agentKeys.forEach(function(name) {
        var ag   = m.mgr.agents[name];
        var short = name.replace('GII_AGENT_', '').replace('GII_SCRAPER_', 'SCR.');
        var ageMs = ag.lastPoll ? (now - ag.lastPoll) : null;
        var ageTxt = ag.lastPoll ? _age(ag.lastPoll) + ' ago' : '—';
        var ageWarn = ageMs !== null && ageMs > 600000; /* >10 min */
        var rowCls = ag.status === 'error' ? 'lm-row-crit' : ag.status === 'warn' ? 'lm-row-warn' : '';
        html += '<tr class="' + rowCls + '">' +
          '<td><strong>' + _esc(short) + '</strong></td>' +
          '<td>' + (ag.loaded ? '<span class="lm-g">✓</span>' : '<span class="lm-r">✗</span>') + '</td>' +
          '<td class="' + (ageWarn ? 'lm-a' : 'lm-d') + '">' + ageTxt + '</td>' +
          '<td>' + _dot(ag.status) + ' <span style="font-size:8px">' + _esc((ag.status || 'unknown').toUpperCase()) + '</span></td>' +
          '<td class="lm-note">' + _esc(ag.message || '') + '</td>' +
        '</tr>';
      });
    }
    html += '</tbody></table></div>';

    /* ──────────── API / INTEGRATION TABLE ──────────── */
    html += '<div class="lm-card">';
    html += '<div class="lm-card-title">🔌 API / INTEGRATION</div>';
    html +=
      '<table class="lm-tbl"><thead><tr>' +
        '<th>Feed / Broker</th><th>Connected</th><th>Freshness</th><th>●</th><th>Notes</th>' +
      '</tr></thead><tbody>';

    function _apiRow(name, data, freshnessStr, statusOverride, note) {
      var c = data ? data.connected : null;
      var fresh = freshnessStr || '—';
      var st = statusOverride || (c === null ? 'd' : c ? 'ok' : 'error');
      var dot = st === 'ok' ? G : st === 'warn' ? A : st === 'd' ? '<span class="lm-d">●</span>' : R;
      return '<tr><td>' + name + '</td><td>' + _conn(c) + '</td><td class="lm-d">' + fresh + '</td><td>' + dot + '</td><td class="lm-note">' + _esc(note || '') + '</td></tr>';
    }

    html += _apiRow('OANDA Broker',
      m.apis.oanda,
      '—',
      null,
      m.apis.oanda ? (m.apis.oanda.nav !== undefined ? 'NAV: $' + _num(m.apis.oanda.nav) : '') : 'Not loaded');

    var oaRatesFresh = m.apis.oandaRates && m.apis.oandaRates.lastUpdate
      ? _age(m.apis.oandaRates.lastUpdate) + ' ago' : '—';
    html += _apiRow('OANDA Rates Feed',
      m.apis.oandaRates,
      oaRatesFresh,
      m.apis.oandaRates && m.apis.oandaRates.lastUpdate && (now - m.apis.oandaRates.lastUpdate) > 120000 ? 'warn' : null,
      '');

    html += _apiRow('Alpaca Broker',
      m.apis.alpaca,
      '—',
      null,
      m.apis.alpaca && m.apis.alpaca.equity ? 'Equity: $' + _num(m.apis.alpaca.equity) : '');

    html += _apiRow('Hyperliquid Broker',
      m.apis.hl,
      '—',
      null,
      m.apis.hl && m.apis.hl.equity ? 'Equity: $' + _num(m.apis.hl.equity) : '');

    var hlFeedFresh = m.apis.hlFeed && m.apis.hlFeed.lastMsgAge !== null
      ? Math.round(m.apis.hlFeed.lastMsgAge / 1000) + 's ago' : '—';
    var hlFeedWarn  = m.apis.hlFeed && m.apis.hlFeed.lastMsgAge > 30000 ? 'warn' : null;
    html += _apiRow('HL WebSocket Feed',
      m.apis.hlFeed,
      hlFeedFresh,
      hlFeedWarn,
      hlFeedWarn ? 'Feed stale — WS may be reconnecting' : 'Live price stream');

    html += _apiRow('SQLite Backend',
      { connected: m.ee.apiOnline !== false },
      '—',
      m.ee.apiOnline === false ? 'warn' : 'ok',
      m.ee.apiOnline === false ? 'localStorage fallback active' : 'localhost:8765 active');

    html += _apiRow('COT Feed',
      null,
      '—',
      'd',
      'Backend /api/cot · hourly · 429 backoff active if needed');

    html += '</tbody></table></div>';

    /* ──────────── FAULT TOLERANCE TABLE ──────────── */
    html += '<div class="lm-card">';
    html += '<div class="lm-card-title">🛡 FAULT TOLERANCE / SAFEGUARDS</div>';
    html +=
      '<table class="lm-tbl"><thead><tr>' +
        '<th>Safeguard</th><th>Triggered?</th><th>●</th><th>Notes</th>' +
      '</tr></thead><tbody>';

    function _faultRow(label, triggered, note, warnIfTriggered) {
      var dot = triggered
        ? (warnIfTriggered ? A : R)
        : G;
      var trigHtml = triggered
        ? '<span class="' + (warnIfTriggered ? 'lm-a' : 'lm-r') + '">YES</span>'
        : '<span class="lm-g">No</span>';
      return '<tr><td>' + label + '</td><td>' + trigHtml + '</td><td>' + dot + '</td><td class="lm-note">' + _esc(note) + '</td></tr>';
    }

    html += _faultRow('Kill Switch',          !!m.ee.halted,        m.ee.halted ? 'Click HALT to resume' : 'Clear');
    html += _faultRow('Auto-Execute Off',      m.ee.enabled === false, m.ee.enabled === false ? 'New trades blocked' : 'Active', true);
    html += _faultRow('EE Heartbeat Stall',    m.ee.heartbeatAge > 60000, m.ee.heartbeatAge > 60000 ? 'Check console for errors' : 'Active every 15s');
    html += _faultRow('HL Reconciliation',     false, 'Every 5 min — detects broker-side closes');
    html += _faultRow('Alpaca Reconciliation', false, 'Every 5 min — detects broker-side closes');
    html += _faultRow('OANDA Reconciliation',  false, 'Every 5 min — detects broker-side closes');
    html += _faultRow('Signal Storm Guard',    false, '>150 signals/10s triggers auto-halt');
    html += _faultRow('Veto 4b Dedup',         false, '30-min re-entry block on recently-closed assets');
    html += _faultRow('Econ Event Gate',       false, 'Blocks new trades before high-impact events');
    html += _faultRow('Dynamic Conf. Floors',  false, 'Per-asset floors updated every 30 min from win-rate data');
    html += _faultRow('COT 429 Backoff',       false, '5-min pause on rate-limit — prevents API ban');
    html += _faultRow('CoinGecko 429 Backoff', false, '90s pause on rate-limit');

    html += '</tbody></table></div>';

    /* ──────────── TREND HISTORY ──────────── */
    html +=
      '<div class="lm-card">' +
        '<div class="lm-card-title">📈 TREND — LAST 5 MINUTES</div>' +
        '<div class="lm-sparks lm-sparks-lg">' +
          '<div class="lm-spark-cell"><div class="lm-spark-lbl">Open Trades</div>    <canvas id="lmHOpen"  width="200" height="40"></canvas></div>' +
          '<div class="lm-spark-cell"><div class="lm-spark-lbl">Session P&amp;L ($)</div><canvas id="lmHPnl"   width="200" height="40"></canvas></div>' +
          '<div class="lm-spark-cell"><div class="lm-spark-lbl">Agent Errors</div>  <canvas id="lmHErrors" width="200" height="40"></canvas></div>' +
          '<div class="lm-spark-cell"><div class="lm-spark-lbl">Avg Latency (ms)</div><canvas id="lmHLat"  width="200" height="40"></canvas></div>' +
        '</div>' +
      '</div>';

    /* ──────────── FOOTER ──────────── */
    html +=
      '<div class="lm-footer">' +
        'Live Monitor · polling every 5s · ' + _hist.ts.length + ' samples collected' +
        ' · <span class="lm-g">●</span> OK &nbsp; <span class="lm-a">●</span> Warning &nbsp; <span class="lm-r">●</span> Critical' +
      '</div>';

    el.innerHTML = html;

    /* Draw sparklines after DOM update */
    requestAnimationFrame(function() {
      _spark('lmSOpen',  _hist.openTrades,  'rgb(255,149,0)',   0);
      _spark('lmSPnl',   _hist.sessionPnl,  'rgb(0,200,160)');
      _spark('lmSLat',   _hist.latencyMs,   'rgb(96,165,250)',  0);
      _spark('lmHOpen',  _hist.openTrades,  'rgb(255,149,0)',   0);
      _spark('lmHPnl',   _hist.sessionPnl,  'rgb(0,200,160)');
      _spark('lmHErrors',_hist.agentErrors, 'rgb(255,68,68)',   0);
      _spark('lmHLat',   _hist.latencyMs,   'rgb(96,165,250)',  0);
    });
  }

  /* ── Nav badge update ─────────────────────────────────────────────────── */
  function _updateNavBadge(m, h) {
    var badge = document.getElementById('lmNavBadge');
    if (!badge) return;
    var crit = (m.mgr.errors || 0) + (m.ee.halted ? 1 : 0) +
               (m.ee.heartbeatAge > 60000 ? 1 : 0);
    badge.textContent  = crit > 0 ? crit : '';
    badge.style.display    = crit > 0 ? 'inline' : 'none';
    badge.style.background = h.status === 'CRITICAL' ? '#e03030'
                           : h.status === 'WARNING'  ? '#ff9500' : '';
  }

  /* ── Main tick ────────────────────────────────────────────────────────── */
  function _tick() {
    var m = _collect();
    var h = _score(m);
    _recordHistory(m);
    _render(m, h);
    _updateNavBadge(m, h);
  }

  /* ── Init ─────────────────────────────────────────────────────────────── */
  window.addEventListener('load', function () {
    /* Wait 4s for EE + all agents to fully initialise */
    setTimeout(function () {
      _tick();
      setInterval(_tick, POLL_MS);
    }, 4000);
  });

  /* Public API — available via console: LIVE_MONITOR.tick(), .history, .collect() */
  window.LIVE_MONITOR = {
    tick:    _tick,
    history: function() { return _hist; },
    collect: _collect,
    score:   function() { return _score(_collect()); }
  };

})();
