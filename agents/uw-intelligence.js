/* ══════════════════════════════════════════════════════════════════════════════
   UNUSUAL WHALES INTELLIGENCE AGENT  —  v3
   ══════════════════════════════════════════════════════════════════════════════
   Polls the backend UW endpoints and:
     1. Renders ShadowBroker-style status card (uwFeedStatusPanel)
     2. Renders live smart-money data (uwDataPanel)
     3. Injects high-confidence flow + congress signals into the EE pipeline
     4. Adjusts EE risk sizing via IV rank (high IV = reduced position size)
     5. Feeds market tide into the regime indicator

   Backend endpoints:
     GET  /api/uw/status        — key status, iv_ranks, tide, per-feed status
     GET  /api/uw/flow-alerts   — options flow (poll every 90s)
     GET  /api/uw/darkpool      — dark pool prints (poll every 5min)
     GET  /api/uw/congress      — congress trades (poll every 30min)
     GET  /api/uw/tide          — tide time series (poll every 5min)
     POST /api/uw/key           — set API key at runtime (persisted)
     POST /api/uw/poll          — force immediate full UW fetch
   ══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var BACKEND      = (location.port === '8765') ? '' : 'http://localhost:8765';
  var STATUS_ID    = 'uwFeedStatusPanel';
  var DATA_ID      = 'uwDataPanel';
  var THRESH_KEY   = 'uw_sig_threshold';

  /* ── State ──────────────────────────────────────────────────────────────── */
  var _state = {
    ready:         false,
    keyConfigured: false,
    flowAlerts:    [],
    darkpool:      [],
    congress:      [],
    tide:          null,
    ivRanks:       {},
    lastFlow:      0,
    stats:         {},
    feedStatus:    {},
    localPoll:     { flow: 0, darkpool: 0, congress: 0, tide: 0, iv: 0 },
  };

  var _sigThreshold = parseInt(localStorage.getItem(THRESH_KEY) || '60', 10);

  /* ── EE Signal injection ─────────────────────────────────────────────────
     Convert a UW event into an EE-compatible signal and inject it.          */
  function _injectToEE(evt) {
    if (!window.EE || typeof EE.onSignals !== 'function') return;
    if (!evt.direction || !evt.ticker) return;
    if ((evt.signal || 0) < _sigThreshold) return;

    var sig = {
      asset:  evt.ticker,
      dir:    evt.direction,
      conf:   Math.min(99, evt.signal || 50),
      region: evt.region || 'US',
      reason: evt.title || ('UW: ' + evt.ticker),
      from:   'UW/' + (evt.uw_type === 'flow_alert' ? 'FlowAlert' :
               evt.uw_type === 'darkpool' ? 'DarkPool' : 'Congress'),
    };
    EE.onSignals([sig]);
    _log('→ EE: ' + sig.asset + ' ' + sig.dir + ' conf=' + sig.conf);
  }

  /* ── IV rank → EE risk adjustment ────────────────────────────────────── */
  function _applyIVRiskAdjustment(ivRanks) {
    if (!window.EE || typeof EE.getConfig !== 'function') return;
    var spyIV = ivRanks['SPY'] || ivRanks['QQQ'] || 50;
    var cfg   = EE.getConfig();
    if (!cfg) return;
    var baseRisk = cfg._uw_base_risk || cfg.max_risk_usd || 100;
    if (!cfg._uw_base_risk) cfg._uw_base_risk = baseRisk;

    var scaled;
    if      (spyIV >= 85) scaled = Math.round(baseRisk * 0.50);
    else if (spyIV >= 70) scaled = Math.round(baseRisk * 0.65);
    else if (spyIV >= 55) scaled = Math.round(baseRisk * 0.80);
    else if (spyIV <= 15) scaled = Math.round(baseRisk * 1.10);
    else                   scaled = baseRisk;

    if (scaled !== cfg.max_risk_usd) {
      var el = document.getElementById('eeCfg_max_risk_usd');
      if (el) {
        el.value = scaled;
        if (typeof EE.updateRiskParams === 'function') {
          EE.updateRiskParams();
          _log('IV rank ' + spyIV.toFixed(0) + '% → EE risk $' + scaled);
        }
      }
    }
  }

  /* ── Tide → EE regime broadcast ──────────────────────────────────────── */
  function _broadcastTide(tide) {
    if (!tide || !window.EE || typeof EE.onSignals !== 'function') return;
    EE.onSignals([{
      asset:  'MARKET',
      dir:    'WATCH',
      conf:   0,
      region: 'GLOBAL',
      reason: '🌊 UW Tide: ' + tide.label +
              '  calls=$' + _fmtM(tide.call_premium) +
              '  puts=$'  + _fmtM(tide.put_premium) +
              '  net='    + (tide.net_premium >= 0 ? '+' : '') + _fmtM(tide.net_premium),
      from:   'UW/MarketTide',
    }]);
  }

  /* ── Fetch helpers ────────────────────────────────────────────────────── */
  function _get(path, cb) {
    fetch(BACKEND + path)
      .then(function (r) { return r.json(); })
      .then(cb)
      .catch(function (e) { _log('GET ' + path + ' failed: ' + e.message); });
  }

  function _post(path, body, cb) {
    fetch(BACKEND + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(cb || function () {})
      .catch(function (e) { _log('POST ' + path + ' failed: ' + e.message); });
  }

  /* ── Poll functions ───────────────────────────────────────────────────── */
  function _pollStatus() {
    _get('/api/uw/status', function (res) {
      _state.keyConfigured = res.key_configured;
      _state.stats         = res.stats       || {};
      _state.ivRanks       = res.iv_ranks    || {};
      _state.feedStatus    = res.feed_status || {};
      if (_state.tide === null && res.tide) _state.tide = res.tide;
      if (Object.keys(_state.ivRanks).length) _applyIVRiskAdjustment(_state.ivRanks);
      _state.ready = true;
      _renderAll();
    });
  }

  function _pollFlowAlerts() {
    _get('/api/uw/flow-alerts?limit=50&hours=24', function (res) {
      var items = res.data || [];
      items.forEach(function (a) {
        var isNew = !_state.flowAlerts.some(function (x) { return x.id === a.id; });
        if (isNew && a.ts > _state.lastFlow) {
          _state.lastFlow = a.ts;
          if (a.signal >= _sigThreshold && a.direction) _injectToEE(a);
        }
      });
      _state.flowAlerts = items;
      _state.localPoll.flow = Date.now();
      _renderAll();
    });
  }

  function _pollDarkPool() {
    _get('/api/uw/darkpool?limit=20&hours=24', function (res) {
      _state.darkpool = res.data || [];
      _state.localPoll.darkpool = Date.now();
      _renderAll();
    });
  }

  function _pollCongress() {
    _get('/api/uw/congress?limit=20&days=90', function (res) {
      var items = res.data || [];
      items.forEach(function (c) {
        var isNew = !_state.congress.some(function (x) { return x.id === c.id; });
        if (isNew && c.direction === 'LONG' && c.signal >= _sigThreshold) _injectToEE(c);
      });
      _state.congress = items;
      _state.localPoll.congress = Date.now();
      _renderAll();
    });
  }

  function _pollTide() {
    _get('/api/uw/tide?hours=8', function (res) {
      var prev = _state.tide;
      _state.tide = res.latest || null;
      _state.localPoll.tide = Date.now();
      if (_state.tide && (!prev || prev.label !== _state.tide.label)) _broadcastTide(_state.tide);
      _renderAll();
    });
  }

  function _startPolling() {
    _pollStatus();
    _pollFlowAlerts();
    _pollDarkPool();
    _pollCongress();
    _pollTide();

    setInterval(_pollFlowAlerts, 90  * 1000);
    setInterval(_pollDarkPool,   5   * 60 * 1000);
    setInterval(_pollTide,       5   * 60 * 1000);
    setInterval(_pollCongress,   30  * 60 * 1000);
    setInterval(_pollStatus,     60  * 1000);
  }

  /* ── Key entry ────────────────────────────────────────────────────────── */
  window._uwConnectKey = function () {
    var el  = document.getElementById('uwKeyInput');
    var btn = document.getElementById('uwConnectBtn');
    if (!el) return;
    var key = el.value.trim();
    if (!key) return;
    btn.textContent = 'CONNECTING…';
    btn.disabled    = true;
    _post('/api/uw/key', { key: key }, function (res) {
      if (res.ok) {
        _state.keyConfigured = true;
        btn.textContent = '✓ CONNECTED';
        setTimeout(function () {
          // Trigger immediate poll after connection
          window._uwPollNow();
        }, 500);
      } else {
        btn.textContent = '✗ FAILED';
        btn.disabled = false;
      }
    });
  };

  window._uwPollNow = function () {
    var btn = document.getElementById('uwPollBtn');
    if (btn) { btn.textContent = '⟳ POLLING…'; btn.disabled = true; }
    _post('/api/uw/poll', {}, function () {
      // Give backend ~2s to fetch, then refresh
      setTimeout(function () {
        _pollStatus();
        _pollFlowAlerts();
        _pollDarkPool();
        _pollTide();
        if (btn) { btn.textContent = '▶ POLL NOW'; btn.disabled = false; }
      }, 2500);
    });
  };

  window._uwSetThreshold = function (val) {
    _sigThreshold = parseInt(val, 10);
    localStorage.setItem(THRESH_KEY, _sigThreshold);
    var lbl = document.getElementById('uwThreshVal');
    if (lbl) lbl.textContent = _sigThreshold;
  };

  /* ── Render ───────────────────────────────────────────────────────────── */
  function _renderAll() {
    _renderStatusPanel();
    _renderDataPanel();
  }

  /* Left card — connection status / key entry */
  function _renderStatusPanel() {
    var el = document.getElementById(STATUS_ID);
    if (!el) return;

    if (!_state.ready) {
      el.innerHTML = '<div style="color:var(--dim);font-size:11px">Connecting to backend…</div>';
      return;
    }

    var html = '';

    if (!_state.keyConfigured) {
      /* ── UW key entry form ─────────────────────────────────────────── */
      html += '<div style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border)">';
      html += '<div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Unusual Whales (paid)</div>';
      html += '<div style="font-size:10px;color:var(--amber);margin-bottom:6px">⚠ No UW key — $50/week at unusualwhales.com/api</div>';
      html += '<div style="display:flex;gap:6px;align-items:center">';
      html += '<input id="uwKeyInput" type="password" placeholder="sk-uw-…" '
            + 'style="flex:1;font-size:10px;padding:4px 8px;background:var(--bg3);'
            + 'border:1px solid var(--border);color:var(--text);outline:none;border-radius:2px" '
            + 'onkeydown="if(event.key===\'Enter\') window._uwConnectKey()">';
      html += '<button id="uwConnectBtn" onclick="window._uwConnectKey()" '
            + 'style="font-size:9px;padding:4px 10px;background:var(--bg3);border:1px solid #7b2fff;'
            + 'color:#a78bfa;cursor:pointer;white-space:nowrap;letter-spacing:0.5px">▶ CONNECT</button>';
      html += '</div></div>';
    } else {
      /* ── Per-feed status dots ──────────────────────────────────────── */
      var feeds = [
        { key: 'flow',     label: 'Flow Alerts',  interval: '90s',  stat: _state.stats.flow_alerts },
        { key: 'darkpool', label: 'Dark Pool',     interval: '5min', stat: _state.stats.darkpool },
        { key: 'congress', label: 'Congress',      interval: '30min',stat: _state.stats.congress },
        { key: 'tide',     label: 'Market Tide',   interval: '5min', stat: _state.stats.tide_snapshots },
        { key: 'iv',       label: 'IV Ranks',      interval: '15min',stat: _state.stats.iv_tickers },
      ];

      html += '<div style="display:grid;grid-template-columns:8px auto 1fr auto;gap:4px 10px;align-items:center">';
      feeds.forEach(function (f) {
        var fs  = _state.feedStatus[f.key] || {};
        var ok  = fs.last_ok && fs.last_ok > 0;
        var err = fs.error;
        var dotCol = err ? 'var(--red)' : ok ? 'var(--green)' : 'var(--dim)';
        var age    = ok ? _relAge(fs.last_ok) : '—';

        html += '<span style="color:' + dotCol + ';font-size:14px;line-height:1">●</span>';
        html += '<span style="font-size:10px;color:var(--text);font-weight:bold">' + f.label + '</span>';
        html += '<span style="font-size:9px;color:var(--dim)">'
              + (f.stat != null ? f.stat + ' records' : '')
              + '</span>';
        html += '<span style="font-size:9px;color:var(--dim);text-align:right">' + age + '</span>';
      });
      html += '</div>';

      // Tide badge
      if (_state.tide) {
        var tc = _tideColor(_state.tide.label);
        html += '<div style="margin-top:10px;display:flex;align-items:center;gap:8px">';
        html += '<span style="font-size:9px;padding:2px 8px;border-radius:3px;background:' + tc.bg
              + ';color:' + tc.fg + ';font-weight:bold">🌊 ' + _state.tide.label.replace(/_/g, ' ') + '</span>';
        var net = _state.tide.net_premium || 0;
        html += '<span style="font-size:9px;color:var(--dim)">net '
              + (net >= 0 ? '+' : '') + '$' + _fmtM(net) + '</span>';
        html += '</div>';
      }
    }

    el.innerHTML = html;
  }

  /* Right card — live data display */
  function _renderDataPanel() {
    var el = document.getElementById(DATA_ID);
    if (!el) return;
    el.innerHTML = _buildDataHTML();
  }

  function _buildDataHTML() {
    if (!_state.ready) return '<div style="color:var(--dim);font-size:11px">Loading…</div>';

    if (!_state.keyConfigured) {
      return '<div style="color:var(--dim);font-size:11px;padding:20px 0;text-align:center">'
           + 'Enter your UW API key in the status panel to see smart money signals.'
           + '</div>';
    }

    var html = '';

    /* ── IV Rank heatmap ── */
    var ivKeys = Object.keys(_state.ivRanks);
    if (ivKeys.length) {
      html += '<div style="margin-bottom:10px">';
      html += '<div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">IV Rank</div>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:4px">';
      ivKeys.forEach(function (t) {
        var iv = _state.ivRanks[t];
        var bg  = iv >= 80 ? 'rgba(255,71,71,0.25)' : iv >= 60 ? 'rgba(255,160,0,0.20)' : iv <= 20 ? 'rgba(40,192,96,0.15)' : 'var(--bg3)';
        var col = iv >= 80 ? 'var(--red)' : iv >= 60 ? 'var(--amber)' : iv <= 20 ? 'var(--green)' : 'var(--text)';
        html += '<div style="font-size:9px;padding:2px 6px;border-radius:3px;background:' + bg + ';color:' + col + '">'
              + t + ' <b>' + iv.toFixed(0) + '</b></div>';
      });
      html += '</div></div>';
    }

    /* ── Flow Alerts ── */
    if (_state.flowAlerts.length) {
      html += '<div style="margin-bottom:10px">';
      html += '<div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px">Options Flow</div>';
      _state.flowAlerts.slice(0, 8).forEach(function (a) {
        var dirCol = a.direction === 'LONG' ? 'var(--green)' : a.direction === 'SHORT' ? 'var(--red)' : 'var(--dim)';
        var sweep  = a.sweep ? '<span style="font-size:7px;padding:1px 3px;background:rgba(255,160,0,0.2);color:var(--amber);border-radius:2px;margin-left:3px">SWEEP</span>' : '';
        var blk    = a.block ? '<span style="font-size:7px;padding:1px 3px;background:rgba(167,139,250,0.2);color:#a78bfa;border-radius:2px;margin-left:3px">BLOCK</span>' : '';
        html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border)">'
              + '<span style="font-size:10px;font-weight:bold;color:var(--text);min-width:40px">' + (a.ticker || '') + '</span>'
              + '<span style="font-size:9px;color:var(--dim)">' + (a.opt_type || '') + ' ' + (a.strike || '') + ' ' + _fmtExpiry(a.expiry) + '</span>'
              + sweep + blk
              + '<span style="margin-left:auto;font-size:9px;font-weight:bold;color:' + dirCol + '">$' + _fmtM(a.premium || 0) + '</span>'
              + '</div>';
      });
      html += '</div>';
    }

    /* ── Dark Pool ── */
    if (_state.darkpool.length) {
      html += '<div style="margin-bottom:10px">';
      html += '<div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px">Dark Pool Prints</div>';
      _state.darkpool.slice(0, 5).forEach(function (d) {
        html += '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--border)">'
              + '<span style="font-size:10px;font-weight:bold;color:var(--text);min-width:40px">' + (d.ticker || '') + '</span>'
              + '<span style="font-size:9px;color:var(--dim)">@ $' + (d.price || 0).toFixed(2) + '  ×' + _fmtK(d.size || 0) + 'sh</span>'
              + '<span style="margin-left:auto;font-size:9px;font-weight:bold;color:#4da6ff">$' + _fmtM(d.value || 0) + '</span>'
              + '</div>';
      });
      html += '</div>';
    }

    /* ── Congress ── */
    if (_state.congress.length) {
      html += '<div>';
      html += '<div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px">Congress Trades</div>';
      _state.congress.slice(0, 8).forEach(function (c) {
        var dirCol  = c.direction === 'LONG' ? 'var(--green)' : 'var(--red)';
        var arrow   = c.direction === 'LONG' ? '▲' : '▼';
        var party   = c.party === 'R' ? '<span style="color:#ff6b6b;font-size:8px">[R]</span>'
                    : c.party === 'D' ? '<span style="color:#4da6ff;font-size:8px">[D]</span>' : '';
        html += '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--border)">'
              + '<span style="font-size:9px;color:' + dirCol + ';font-weight:bold">' + arrow + '</span>'
              + '<span style="font-size:10px;font-weight:bold;color:var(--text)">' + (c.ticker || '') + '</span>'
              + party
              + '<span style="font-size:9px;color:var(--dim);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
              + (c.politician || '').split(' ').pop() + '</span>'
              + '<span style="font-size:9px;color:var(--dim)">' + (c.amount ? '$' + _fmtK(c.amount) : '') + '</span>'
              + '<span style="font-size:8px;color:var(--dim);min-width:28px;text-align:right">' + _relTime(c.ts) + '</span>'
              + '</div>';
      });
      html += '</div>';
    }

    if (!_state.flowAlerts.length && !_state.congress.length && !_state.darkpool.length && !ivKeys.length) {
      html += '<div style="color:var(--dim);font-size:11px;padding:16px 0;text-align:center">'
            + 'No data yet — first UW poll is running…</div>';
    }

    return html;
  }

  /* ── Helpers ─────────────────────────────────────────────────────────── */
  function _fmtM(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return n.toFixed(0);
  }
  function _fmtK(n) {
    n = Number(n) || 0;
    return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n.toFixed(0);
  }
  function _fmtExpiry(s) { return s ? s.slice(5) : ''; }
  function _relTime(ts) {
    if (!ts) return '';
    var d = Math.floor((Date.now() - ts) / 86400000);
    return d === 0 ? 'today' : d + 'd';
  }
  function _relAge(ts) {
    if (!ts) return '—';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5)    return 'just now';
    if (s < 60)   return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }
  function _tideColor(label) {
    if (label === 'STRONGLY_BULLISH') return { bg: 'rgba(40,192,96,0.25)',  fg: 'var(--green)' };
    if (label === 'BULLISH')          return { bg: 'rgba(40,192,96,0.15)',  fg: 'var(--green)' };
    if (label === 'BEARISH')          return { bg: 'rgba(255,71,71,0.18)',  fg: 'var(--red)' };
    if (label === 'STRONGLY_BEARISH') return { bg: 'rgba(255,71,71,0.28)',  fg: 'var(--red)' };
    return { bg: 'var(--bg3)', fg: 'var(--dim)' };
  }
  function _log(msg) {
    console.log('[UW]', msg);
    if (window.EE && typeof EE.log === 'function') EE.log('UW', msg, 'cyan');
  }

  /* ── Init ────────────────────────────────────────────────────────────── */
  function _init() {
    _renderStatusPanel();
    _startPolling();
  }

  /* ── Public API ──────────────────────────────────────────────────────── */
  window.UWIntel = {
    state:      function () { return _state; },
    refresh:    function () { _pollStatus(); _pollFlowAlerts(); _pollDarkPool(); _pollCongress(); _pollTide(); },
    poll:       function () { window._uwPollNow(); },
    getIVRanks: function () { return _state.ivRanks; },
    getTide:    function () { return _state.tide; },
    setThresh:  function (n) { window._uwSetThreshold(n); },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})();
