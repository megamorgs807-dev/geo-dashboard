/* ══════════════════════════════════════════════════════════════════════════════
   EXECUTION ENGINE (EE) — Signal-Driven Trade Automation
   ══════════════════════════════════════════════════════════════════════════════
   Architecture:
     Signal bus hook   → EE.onSignals(sigs) called by renderTrades() each cycle
     Risk gate         → canExecute(sig) checks all risk rules before opening
     Trade lifecycle   → openTrade() → monitorTrades() → closeTrade()
     Persistence       → localStorage for config + full trade history
     HRS bridge        → auto-captures & evaluates in the Hit Rate Tracker
     Broker stubs      → connectBroker() interface ready for Binance / Alpaca / Polymarket

   Modes:
     SIMULATION  — paper trades with virtual balance, real prices where available
     LIVE        — real execution via broker API (not yet wired, stubs only)

   Design constraints:
     • Does NOT modify the intelligence pipeline (scoreEvent, ingest, regionStates)
     • renderTrades() only gained one non-breaking emit line
     • All EE logic is fully isolated in this file
   ══════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Storage keys ──────────────────────────────────────────────────────────── */
  var CFG_KEY    = 'geodash_ee_config_v1';
  var TRADES_KEY = 'geodash_ee_trades_v1';

  /* ── Default risk configuration ────────────────────────────────────────────── */
  var DEFAULTS = {
    mode:                  'SIMULATION', // 'SIMULATION' | 'LIVE'
    enabled:               false,        // auto-execution on/off
    min_confidence:        65,           // minimum IC confidence % to auto-execute
    virtual_balance:       10000,        // starting virtual balance (USD)
    risk_per_trade_pct:    2,            // % of balance risked per trade
    stop_loss_pct:         3,            // % distance from entry for stop-loss
    take_profit_ratio:     2,            // R:R multiplier (TP = SL distance × ratio)
    max_open_trades:       5,            // max concurrent open trades
    max_per_region:        2,            // max open trades per geopolitical region
    max_exposure_pct:      20,           // max % of balance in open positions
    cooldown_ms:           300000,       // 5 min cooldown between same-asset signals
    broker:                'SIMULATION'  // future: 'BINANCE' | 'ALPACA' | 'POLYMARKET'
  };

  /* ══════════════════════════════════════════════════════════════════════════════
     TRADE OBJECT SCHEMA
     Each trade stored in _trades[] follows this exact structure — designed to be
     read directly by a future bot / broker adapter without transformation.
     ══════════════════════════════════════════════════════════════════════════════
     {
       trade_id:        string   — unique "TRD-xxxx" identifier
       signal_id:       string   — source signal ID (IC-generated or HRS)
       timestamp_open:  ISO8601  — UTC time trade was opened
       asset:           string   — e.g. "WTI Crude Oil", "BTC/USD"
       direction:       string   — "LONG" | "SHORT"
       confidence:      number   — IC confidence 0–100
       entry_price:     number   — price at open
       stop_loss:       number   — absolute price level
       take_profit:     number   — absolute price level
       units:           number   — position size in asset units
       size_usd:        number   — notional USD value of position
       mode:            string   — "SIMULATION" | "LIVE"
       status:          string   — "OPEN" | "CLOSED" | "CANCELLED"
       close_price:     number|null
       timestamp_close: ISO8601|null
       pnl_pct:         number|null  — % P&L from entry
       pnl_usd:         number|null  — USD P&L
       close_reason:    string|null  — "TAKE_PROFIT"|"STOP_LOSS"|"MANUAL"|"EXPIRED"
       region:          string   — geopolitical region that triggered signal
       reason:          string   — human-readable signal reason from IC
       broker:          string   — "SIMULATION" | future broker name
       broker_order_id: string|null  — set by broker adapter on live execution
       broker_status:   string|null  — broker-side order status
     }
     ══════════════════════════════════════════════════════════════════════════════ */

  /* ── State ─────────────────────────────────────────────────────────────────── */
  var _cfg      = {};   // active config (merged DEFAULTS + localStorage)
  var _trades   = [];   // all trades: open + closed
  var _cooldown = {};   // asset → timestamp of last signal processed
  var _log      = [];   // activity log entries
  var _seq      = 0;    // ID sequence counter

  /* ── Asset → price source map ──────────────────────────────────────────────── */
  // Maps normalised asset tokens to Binance symbols for live price fetching.
  // Add entries here as new assets are supported.
  var PRICE_SOURCES = {
    'BTC':   'BTCUSDT',
    'ETH':   'ETHUSDT',
    'BNB':   'BNBUSDT',
    'SOL':   'SOLUSDT',
    'XAU':   'XAUUSDT',   // Gold (via Binance)
    'GOLD':  'XAUUSDT',
    'ADA':   'ADAUSDT',
    'DOGE':  'DOGEUSDT'
  };

  var _priceCache = {};  // last known prices by asset token

  /* ══════════════════════════════════════════════════════════════════════════════
     PERSISTENCE
     ══════════════════════════════════════════════════════════════════════════════ */

  function loadCfg() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      _cfg = raw ? Object.assign({}, DEFAULTS, JSON.parse(raw)) : Object.assign({}, DEFAULTS);
    } catch (e) { _cfg = Object.assign({}, DEFAULTS); }
  }

  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(_cfg)); } catch (e) {}
  }

  function loadTrades() {
    try {
      var raw = localStorage.getItem(TRADES_KEY);
      _trades = raw ? JSON.parse(raw) : [];
    } catch (e) { _trades = []; }
  }

  function saveTrades() {
    try { localStorage.setItem(TRADES_KEY, JSON.stringify(_trades)); } catch (e) {}
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     PRICE FETCHING
     Strategy:
       1. Try Binance REST for known crypto/commodity tokens
       2. Fall back to last cached price
       3. Fall back to null (caller decides what to do)
     ══════════════════════════════════════════════════════════════════════════════ */

  function normaliseAsset(asset) {
    // Extract first meaningful token from asset name
    // "WTI Crude Oil" → "WTI", "BTC/USD" → "BTC", "GDX (Gold Miners)" → "GDX"
    return String(asset || '').toUpperCase().replace(/[^A-Z0-9]/g, ' ').trim().split(' ')[0];
  }

  function fetchPrice(asset, cb) {
    var token = normaliseAsset(asset);
    var sym   = PRICE_SOURCES[token];

    if (sym) {
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=' + sym)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var price = parseFloat(d.price);
          if (!isNaN(price)) _priceCache[token] = price;
          cb(!isNaN(price) ? price : (_priceCache[token] || null));
        })
        .catch(function () { cb(_priceCache[token] || null); });
    } else {
      // Try to read from the dashboard live ticker
      var tickEls = document.querySelectorAll('.tick-item');
      var found   = null;
      tickEls.forEach(function (el) {
        if (found) return;
        var txt = (el.textContent || '').toUpperCase();
        if (txt.indexOf(token) !== -1) {
          var m = txt.match(/\$([\d,]+\.?\d*)/);
          if (m) found = parseFloat(m[1].replace(/,/g, ''));
        }
      });
      if (found) { _priceCache[token] = found; cb(found); }
      else cb(_priceCache[token] || null);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     RISK GATE — canExecute(sig)
     Returns { ok: boolean, reason: string }
     All rules must pass before a trade is opened.
     ══════════════════════════════════════════════════════════════════════════════ */

  function openTrades() {
    return _trades.filter(function (t) { return t.status === 'OPEN'; });
  }

  function canExecute(sig) {
    if (!_cfg.enabled)
      return { ok: false, reason: 'Auto-execution disabled' };

    if (sig.dir === 'WATCH')
      return { ok: false, reason: 'WATCH signals are excluded from execution' };

    if (sig.conf < _cfg.min_confidence)
      return { ok: false, reason: 'Conf ' + sig.conf + '% < threshold ' + _cfg.min_confidence + '%' };

    var open = openTrades();

    if (open.length >= _cfg.max_open_trades)
      return { ok: false, reason: 'Max open trades (' + _cfg.max_open_trades + ') reached' };

    var regionOpen = open.filter(function (t) { return t.region === sig.region; }).length;
    if (regionOpen >= _cfg.max_per_region)
      return { ok: false, reason: 'Max per region (' + _cfg.max_per_region + ') reached for ' + sig.region };

    if (open.some(function (t) { return t.asset === sig.asset; }))
      return { ok: false, reason: 'Already have open trade for ' + sig.asset };

    var lastTs = _cooldown[sig.asset];
    if (lastTs && (Date.now() - lastTs) < _cfg.cooldown_ms)
      return { ok: false, reason: 'Cooldown active for ' + sig.asset };

    var exposure = open.reduce(function (s, t) { return s + (t.size_usd || 0); }, 0);
    var maxExp   = _cfg.virtual_balance * _cfg.max_exposure_pct / 100;
    if (exposure >= maxExp)
      return { ok: false, reason: 'Max exposure ' + _cfg.max_exposure_pct + '% reached' };

    return { ok: true, reason: 'All risk checks passed' };
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     TRADE LIFECYCLE
     ══════════════════════════════════════════════════════════════════════════════ */

  function makeId(prefix) {
    return prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + (++_seq).toString(36).toUpperCase();
  }

  /* Build a complete trade object from a signal + entry price */
  function buildTrade(sig, entryPrice) {
    var dir     = sig.dir === 'SHORT' ? 'SHORT' : 'LONG';
    var slPct   = _cfg.stop_loss_pct / 100;
    var tpPct   = slPct * _cfg.take_profit_ratio;

    var stopLoss, takeProfit;
    if (dir === 'LONG') {
      stopLoss   = entryPrice * (1 - slPct);
      takeProfit = entryPrice * (1 + tpPct);
    } else {
      stopLoss   = entryPrice * (1 + slPct);
      takeProfit = entryPrice * (1 - tpPct);
    }

    // Position sizing: risk a fixed % of balance per trade
    var riskAmt  = _cfg.virtual_balance * _cfg.risk_per_trade_pct / 100;
    var slDist   = Math.abs(entryPrice - stopLoss);
    var units    = slDist > 0 ? riskAmt / slDist : 0;
    var sizeUsd  = units * entryPrice;

    return {
      trade_id:        makeId('TRD'),
      signal_id:       makeId('IC-' + normaliseAsset(sig.asset)),
      timestamp_open:  new Date().toISOString(),
      asset:           sig.asset,
      direction:       dir,
      confidence:      sig.conf,
      entry_price:     entryPrice,
      stop_loss:       +stopLoss.toFixed(6),
      take_profit:     +takeProfit.toFixed(6),
      units:           +units.toFixed(6),
      size_usd:        +sizeUsd.toFixed(2),
      mode:            _cfg.mode,
      status:          'OPEN',
      close_price:     null,
      timestamp_close: null,
      pnl_pct:         null,
      pnl_usd:         null,
      close_reason:    null,
      region:          sig.region  || 'GLOBAL',
      reason:          sig.reason  || '',
      broker:          _cfg.mode === 'LIVE' ? _cfg.broker : 'SIMULATION',
      // Broker integration stubs — set by adapter on live execution
      broker_order_id: null,
      broker_status:   null
    };
  }

  /* Open a trade: build object, persist, sync HRS, log */
  function openTrade(sig, entryPrice) {
    var trade = buildTrade(sig, entryPrice);
    _trades.unshift(trade);
    _cooldown[sig.asset] = Date.now();
    saveTrades();

    // Auto-capture in Hit Rate Tracker if available
    if (window.HRS && typeof HRS.capture === 'function') {
      HRS.capture({
        signal_id:       trade.signal_id,
        asset:           trade.asset,
        direction:       trade.direction,
        entry_price:     trade.entry_price,
        target_price:    trade.take_profit,
        stop_loss:       trade.stop_loss,
        confidence:      trade.confidence / 100,
        duration_target: '1w',
        source:          'EE-' + _cfg.mode,
        notes:           trade.reason
      });
    }

    log('OPENED',
      trade.asset + ' ' + trade.direction +
      ' @ ' + _num(trade.entry_price) +
      '  SL:' + _num(trade.stop_loss) +
      '  TP:' + _num(trade.take_profit) +
      '  Conf:' + trade.confidence + '%',
      'green');

    renderUI();
    return trade;
  }

  /* Close a trade: compute P&L, update balance, sync HRS, log */
  function closeTrade(tradeId, closePrice, reason) {
    var trade = _trades.find(function (t) { return t.trade_id === tradeId; });
    if (!trade || trade.status !== 'OPEN') return;

    trade.status          = 'CLOSED';
    trade.close_price     = +parseFloat(closePrice).toFixed(6);
    trade.timestamp_close = new Date().toISOString();
    trade.close_reason    = reason;

    var rawPnlPct = trade.direction === 'LONG'
      ? (closePrice - trade.entry_price) / trade.entry_price * 100
      : (trade.entry_price - closePrice) / trade.entry_price * 100;

    trade.pnl_pct = +rawPnlPct.toFixed(2);
    trade.pnl_usd = +(trade.units * Math.abs(closePrice - trade.entry_price) * (rawPnlPct >= 0 ? 1 : -1)).toFixed(2);

    // Update virtual balance
    _cfg.virtual_balance += trade.pnl_usd;
    saveCfg();

    // Sync outcome back to Hit Rate Tracker
    if (window.HRS && typeof HRS.signals !== 'undefined') {
      var hrsSig = HRS.signals.find(function (s) { return s.signal_id === trade.signal_id; });
      if (hrsSig) {
        var outcome = reason === 'TAKE_PROFIT' ? 'hit'
                    : reason === 'STOP_LOSS'   ? 'miss' : 'neutral';
        HRS.evaluate(hrsSig.signal_id, outcome, closePrice);
      }
    }

    saveTrades();
    log('CLOSED',
      trade.asset + ' ' + trade.direction +
      ' → ' + reason +
      ' @ ' + _num(closePrice) +
      '  P&L: ' + (trade.pnl_pct >= 0 ? '+' : '') + trade.pnl_pct + '%' +
      '  (' + (trade.pnl_usd >= 0 ? '+$' : '-$') + _num(Math.abs(trade.pnl_usd)) + ')',
      trade.pnl_pct >= 0 ? 'green' : 'red');

    renderUI();
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     SIGNAL LISTENER — called by renderTrades() each IC cycle
     Signature: EE.onSignals(sigs)
     sigs: Array<{ asset, dir, conf, reason, region }>
     ══════════════════════════════════════════════════════════════════════════════ */

  function onSignals(sigs) {
    if (!_cfg.enabled || !sigs || !sigs.length) return;

    sigs.forEach(function (sig) {
      var check = canExecute(sig);
      if (!check.ok) return;

      fetchPrice(sig.asset, function (price) {
        // If we can't get a real price, use a normalised synthetic price of 100
        // so position sizing still works in simulation
        openTrade(sig, price || 100);
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     TRADE MONITOR — runs every 30s, checks open trades against live prices
     ══════════════════════════════════════════════════════════════════════════════ */

  function monitorTrades() {
    openTrades().forEach(function (trade) {
      fetchPrice(trade.asset, function (price) {
        if (!price) return;

        var hitTP, hitSL;
        if (trade.direction === 'LONG') {
          hitTP = price >= trade.take_profit;
          hitSL = price <= trade.stop_loss;
        } else {
          hitTP = price <= trade.take_profit;
          hitSL = price >= trade.stop_loss;
        }

        if (hitTP)      closeTrade(trade.trade_id, trade.take_profit, 'TAKE_PROFIT');
        else if (hitSL) closeTrade(trade.trade_id, trade.stop_loss,   'STOP_LOSS');
        else            renderUI(); // refresh unrealised P&L display
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     BROKER ADAPTER INTERFACE
     Implement these stubs in a separate adapter file for each broker.
     Connect via: EE.connectBroker('BINANCE', { apiKey, apiSecret })
     ══════════════════════════════════════════════════════════════════════════════ */

  var _brokerAdapter = null;

  var BROKER_STUBS = {
    /*
    BINANCE: {
      name: 'Binance',
      placeOrder: function(trade, cfg) { ... POST /api/v3/order ... },
      cancelOrder: function(orderId, cfg) { ... DELETE /api/v3/order ... },
      getPrice: function(symbol, cb) { ... GET /api/v3/ticker/price ... }
    },
    ALPACA: {
      name: 'Alpaca',
      placeOrder: function(trade, cfg) { ... POST /v2/orders ... },
      cancelOrder: function(orderId, cfg) { ... DELETE /v2/orders/:id ... },
      getPrice: function(symbol, cb) { ... GET /v2/stocks/:symbol/quotes/latest ... }
    },
    POLYMARKET: {
      name: 'Polymarket',
      placeOrder: function(trade, cfg) { ... CLOB API ... },
      cancelOrder: function(orderId, cfg) { ... },
      getPrice: function(marketId, cb) { ... }
    }
    */
  };

  function connectBroker(brokerName, credentials) {
    // Placeholder — implement adapter in a separate file
    // adapter should set _brokerAdapter to an object with placeOrder / cancelOrder / getPrice
    log('BROKER', 'connectBroker(' + brokerName + ') — not yet implemented', 'amber');
    console.warn('[EE] Broker adapter for', brokerName, 'not yet implemented.');
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     ACTIVITY LOG
     ══════════════════════════════════════════════════════════════════════════════ */

  function log(action, msg, colour) {
    _log.unshift({ ts: new Date().toISOString(), action: action, msg: msg, colour: colour || 'dim' });
    if (_log.length > 60) _log.pop();
    var el = document.getElementById('eeActivityLog');
    if (el) renderLog(el);
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     UI RENDERING
     ══════════════════════════════════════════════════════════════════════════════ */

  function renderUI() {
    renderStatusBar();
    renderConfigFields();
    renderOpenTrades();
    renderClosedTrades();
    var el = document.getElementById('eeActivityLog');
    if (el) renderLog(el);
    // Show/hide live mode warning
    var warn = document.getElementById('eeLiveWarning');
    if (warn) warn.classList.toggle('show', _cfg.mode === 'LIVE');
  }

  function renderStatusBar() {
    var open   = openTrades();
    var closed = _trades.filter(function (t) { return t.status === 'CLOSED'; });
    var wins   = closed.filter(function (t) { return t.close_reason === 'TAKE_PROFIT'; });
    var totPnl = closed.reduce(function (s, t) { return s + (t.pnl_usd || 0); }, 0);
    var rate   = closed.length ? Math.round(wins.length / closed.length * 100) : null;

    var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
    set('eeBadgeMode',    _cfg.mode);
    set('eeBadgeEnabled', _cfg.enabled ? 'AUTO ON' : 'AUTO OFF');
    set('eeBadgeBalance', '$' + _num(_cfg.virtual_balance));
    set('eeBadgeOpen',    open.length + ' OPEN');
    set('eeBadgePnl',     (totPnl >= 0 ? '+$' : '-$') + _num(Math.abs(totPnl)) + ' P&L');
    set('eeBadgeRate',    rate !== null ? rate + '% WIN' : '— WIN');
    set('eeOpenCount',    open.length);

    var pnlEl = document.getElementById('eeBadgePnl');
    if (pnlEl) {
      pnlEl.className = 'ee-badge ' + (totPnl > 0 ? 'pos' : totPnl < 0 ? 'neg' : '');
    }

    var toggleBtn = document.getElementById('eeToggleBtn');
    if (toggleBtn) {
      toggleBtn.textContent = _cfg.enabled ? '\u25a0 STOP AUTO' : '\u25b6 START AUTO';
      toggleBtn.className   = 'ee-toggle-btn' + (_cfg.enabled ? ' active' : '');
    }
    var modeBtn = document.getElementById('eeModeBtn');
    if (modeBtn) {
      modeBtn.textContent = 'MODE: ' + _cfg.mode;
      modeBtn.className   = 'ee-mode-btn ' + (_cfg.mode === 'LIVE' ? 'live' : 'sim');
    }
  }

  function renderConfigFields() {
    var fields = ['min_confidence','risk_per_trade_pct','stop_loss_pct',
                  'take_profit_ratio','max_open_trades','max_per_region','virtual_balance'];
    fields.forEach(function (f) {
      var el = document.getElementById('eeCfg_' + f);
      if (el && document.activeElement !== el) el.value = _cfg[f];
    });
  }

  function renderOpenTrades() {
    var el = document.getElementById('eeOpenTrades');
    if (!el) return;
    var open = openTrades();
    if (!open.length) {
      el.innerHTML = '<div class="ee-placeholder">No open trades. Enable auto-execution or wait for a high-confidence signal.</div>';
      return;
    }
    el.innerHTML = open.map(function (t) {
      var dirCls = t.direction === 'LONG' ? 'ee-dir-long' : 'ee-dir-short';
      return '<div class="ee-trade-card">' +
        '<div class="ee-tc-hdr">' +
          '<span class="' + dirCls + '">' + t.direction + '</span>' +
          '<span class="ee-tc-asset">' + _esc(t.asset) + '</span>' +
          '<span class="ee-tc-conf">' + t.confidence + '%</span>' +
          '<span class="ee-tc-age">' + _age(t.timestamp_open) + '</span>' +
          '<span class="ee-tc-mode ' + (t.mode === 'LIVE' ? 'live' : 'sim') + '">' + t.mode + '</span>' +
        '</div>' +
        '<div class="ee-tc-prices">' +
          'Entry: <b>' + _num(t.entry_price) + '</b>' +
          ' &nbsp; <span class="ee-tc-sl">SL: ' + _num(t.stop_loss) + '</span>' +
          ' &nbsp; <span class="ee-tc-tp">TP: ' + _num(t.take_profit) + '</span>' +
          ' &nbsp; Size: $' + _num(t.size_usd) +
        '</div>' +
        '<div class="ee-tc-actions">' +
          '<button class="ee-tc-btn close-btn" onclick="EE.manualClose(\'' + t.trade_id + '\')">&#10005; Close</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderClosedTrades() {
    var el = document.getElementById('eeClosedTrades');
    if (!el) return;
    var closed = _trades.filter(function (t) { return t.status === 'CLOSED'; }).slice(0, 25);
    if (!closed.length) {
      el.innerHTML = '<div class="ee-placeholder">No closed trades yet.</div>';
      return;
    }
    el.innerHTML = closed.map(function (t) {
      var pc  = t.pnl_pct || 0;
      var pu  = t.pnl_usd || 0;
      var cls = pc >= 0 ? 'pos' : 'neg';
      var icon = t.close_reason === 'TAKE_PROFIT' ? '\u2713' : t.close_reason === 'STOP_LOSS' ? '\u2717' : '\u2014';
      var iconCls = t.close_reason === 'TAKE_PROFIT' ? 'tp' : 'sl';
      return '<div class="ee-closed-row">' +
        '<span class="ee-cr-reason ' + iconCls + '">' + icon + '</span>' +
        '<span class="ee-cr-asset">' + _esc(t.asset) + '</span>' +
        '<span class="ee-cr-dir ' + t.direction.toLowerCase() + '">' + t.direction + '</span>' +
        '<span class="ee-cr-pnl ' + cls + '">' + (pc >= 0 ? '+' : '') + pc + '%</span>' +
        '<span class="ee-cr-usd ' + cls + '">' + (pu >= 0 ? '+$' : '-$') + _num(Math.abs(pu)) + '</span>' +
        '<span class="ee-cr-ts">' + _age(t.timestamp_open) + '</span>' +
      '</div>';
    }).join('');
  }

  function renderLog(el) {
    if (!_log.length) {
      el.innerHTML = '<div class="ee-placeholder">No activity yet.</div>';
      return;
    }
    el.innerHTML = _log.slice(0, 20).map(function (e) {
      var ts = new Date(e.ts);
      var t  = String(ts.getHours()).padStart(2, '0') + ':' + String(ts.getMinutes()).padStart(2, '0');
      return '<div class="ee-log-row">' +
        '<span class="ee-log-ts">' + t + '</span>' +
        '<span class="ee-log-action ' + (e.colour || 'dim') + '">' + e.action + '</span>' +
        '<span class="ee-log-msg">' + _esc(e.msg) + '</span>' +
      '</div>';
    }).join('');
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     HELPERS
     ══════════════════════════════════════════════════════════════════════════════ */

  function _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function _num(n) {
    var v = parseFloat(n);
    if (isNaN(v)) return '—';
    if (v >= 10000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (v >= 100)   return v.toFixed(2);
    if (v >= 1)     return v.toFixed(4);
    return v.toFixed(6);
  }

  function _age(ts) {
    var ms = Date.now() - new Date(ts).getTime();
    var m  = Math.floor(ms / 60000);
    var h  = Math.floor(m / 60);
    var d  = Math.floor(h / 24);
    if (d > 0) return d + 'd ago';
    if (h > 0) return h + 'h ago';
    return m + 'm ago';
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     PUBLIC API  (window.EE)
     ══════════════════════════════════════════════════════════════════════════════ */

  window.EE = {

    /* ── Called by renderTrades() hook each cycle ── */
    onSignals: onSignals,

    /* ── Toggle auto-execution on/off ── */
    toggleAuto: function () {
      _cfg.enabled = !_cfg.enabled;
      saveCfg();
      log('CONFIG', 'Auto-execution ' + (_cfg.enabled ? 'ENABLED' : 'DISABLED'),
          _cfg.enabled ? 'green' : 'amber');
      renderUI();
    },

    /* ── Toggle SIMULATION ↔ LIVE mode ── */
    toggleMode: function () {
      if (_cfg.mode === 'LIVE') {
        _cfg.mode = 'SIMULATION';
        log('CONFIG', 'Switched to SIMULATION mode', 'amber');
        saveCfg(); renderUI();
      } else {
        if (!confirm(
          'Switch to LIVE MODE?\n\n' +
          'This will send REAL orders to connected exchanges.\n' +
          'Ensure broker API keys are configured and risk parameters are correct.\n\n' +
          'Broker integrations are currently stubs — no real orders will fire\n' +
          'until a broker adapter is implemented.'
        )) return;
        _cfg.mode = 'LIVE';
        log('CONFIG', 'Switched to LIVE mode — broker adapter required for real execution', 'amber');
        saveCfg(); renderUI();
      }
    },

    /* ── Save updated risk parameters from form ── */
    updateConfig: function () {
      var rules = {
        min_confidence:     { min: 10,  max: 95,      int: true  },
        risk_per_trade_pct: { min: 0.1, max: 10,      int: false },
        stop_loss_pct:      { min: 0.1, max: 20,      int: false },
        take_profit_ratio:  { min: 0.5, max: 10,      int: false },
        max_open_trades:    { min: 1,   max: 20,      int: true  },
        max_per_region:     { min: 1,   max: 5,       int: true  },
        virtual_balance:    { min: 100, max: 10000000, int: false }
      };
      Object.keys(rules).forEach(function (f) {
        var el = document.getElementById('eeCfg_' + f);
        if (!el) return;
        var v = parseFloat(el.value), r = rules[f];
        if (isNaN(v) || v < r.min || v > r.max) return;
        _cfg[f] = r.int ? Math.round(v) : v;
      });
      saveCfg();
      log('CONFIG', 'Risk parameters updated', 'amber');
      renderUI();
    },

    /* ── Manually close an open trade ── */
    manualClose: function (tradeId) {
      var trade = _trades.find(function (t) { return t.trade_id === tradeId; });
      if (!trade) return;
      fetchPrice(trade.asset, function (price) {
        closeTrade(tradeId, price || trade.entry_price, 'MANUAL');
      });
    },

    /* ── Reset virtual balance to $10,000 ── */
    resetBalance: function () {
      if (!confirm('Reset virtual balance to $10,000? This will not affect trade history.')) return;
      _cfg.virtual_balance = 10000;
      saveCfg();
      log('CONFIG', 'Virtual balance reset to $10,000', 'amber');
      renderUI();
    },

    /* ── Clear closed trade history ── */
    clearHistory: function () {
      if (!confirm('Clear all closed trade history? Open trades are not affected.')) return;
      _trades = _trades.filter(function (t) { return t.status === 'OPEN'; });
      saveTrades();
      log('CONFIG', 'Closed trade history cleared', 'amber');
      renderUI();
    },

    /* ── Future broker integration (stubs) ── */
    connectBroker: connectBroker,

    /* ── Data access for external scripts / debugging ── */
    getOpenTrades:  function () { return openTrades().slice(); },
    getAllTrades:    function () { return _trades.slice(); },
    getConfig:      function () { return Object.assign({}, _cfg); },
    exportJSON:     function () {
      var blob = new Blob([JSON.stringify(_trades, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ee_trades_' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(a.href);
    },

    render: renderUI
  };

  /* ══════════════════════════════════════════════════════════════════════════════
     INITIALISATION
     ══════════════════════════════════════════════════════════════════════════════ */

  function init() {
    loadCfg();
    loadTrades();
    setInterval(monitorTrades, 30000);  // price-check open trades every 30s
    renderUI();
    log('SYSTEM', 'Execution Engine v1.0 ready — ' + _cfg.mode + ' mode  |  ' +
        openTrades().length + ' open trade(s) restored from storage', 'amber');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
