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
  var CFG_KEY         = 'geodash_ee_config_v2';
  var TRADES_KEY      = 'geodash_ee_trades_v1';
  var SIGLOG_KEY      = 'geodash_ee_siglog_v1';
  var PNL_HISTORY_KEY = 'geodash_pnl_history_v1';
  var STATE_VERSION   = '2.0';

  /* ── SQLite API ─────────────────────────────────────────────────────────────
     Primary persistence: GeoIntel backend on port 8765.
     Falls back to localStorage silently if the backend isn't running.         */
  // API base: reads from localStorage first (set via the Backend URL field in config),
  // then falls back to window.GEO_API_BASE (set via script tag), then localhost.
  var _BACKEND_URL_KEY = 'geodash_backend_url_v1';
  var _API_BASE = (function () {
    try {
      var saved = localStorage.getItem(_BACKEND_URL_KEY);
      if (saved && saved.length > 4) return saved.replace(/\/$/, '');
    } catch (e) {}
    return (typeof window !== 'undefined' && window.GEO_API_BASE) || 'https://geo-dashboard-2okm.onrender.com';
  })();
  var _apiOnline    = false;   // set true after first successful /api/status ping
  var _backendChecked = false; // set true after first ping attempt resolves (ok or fail)

  /* ── Default risk configuration ────────────────────────────────────────────── */
  var DEFAULTS = {
    mode:                  'SIMULATION', // 'SIMULATION' | 'LIVE'
    enabled:               true,         // auto-execution always on by default
    min_confidence:        70,           // minimum IC confidence % to auto-execute — raised from 65 (audit: low-conf trades not profitable)
    virtual_balance:       1000,         // starting virtual balance (USD)
    risk_per_trade_pct:    2,            // % of balance risked per trade — v61: reduced from 3% to limit concurrent exposure
    stop_loss_pct:         1.5,          // % distance from entry — tighter than original 3%, better capital preservation
    take_profit_ratio:     2.5,          // R:R multiplier — improved from 2:1, more profit per win
    max_open_trades:       5,            // audit: lowered 8→5 — only hold highest-conviction ideas, reduces correlation risk
    max_per_region:        2,            // audit: lowered 3→2 — tighter regional concentration cap
    max_per_sector:        2,            // max open trades per asset sector
    max_exposure_pct:      30,           // max % of balance in open positions
    cooldown_ms:           120000,       // 2 min cooldown between same-asset signals
    broker:                'SIMULATION', // future: 'BINANCE' | 'ALPACA' | 'POLYMARKET'
    auto_start:            true,         // if false, auto-execution stays OFF on page load
    max_siglog:            200,          // max entries kept in signal log
    // ── Risk management additions ──────────────────────────────────────────────
    trailing_stop_enabled: false,        // audit: DISABLED — gii-exit _progressiveTrailCheck owns stop management
                                         // (milestone-based: 1R→BE, 1.5R→+0.5R). Crude 1% trail conflicted with it.
    trailing_stop_pct:     1.0,          // kept for reference (not active while trailing_stop_enabled=false)
    break_even_enabled:    true,         // move stop to entry once 50% to TP (still active as fallback)
    partial_tp_enabled:    true,         // take partial profit at TP1 (midpoint to TP)
    daily_loss_limit_pct:  10,           // audit: lowered 50%→10% — 50% was not a real circuit breaker
    event_gate_enabled:    true,         // block new trades near major calendar events
    event_gate_hours:      0.5,          // hours before event to block (0.5 = 30min)
    max_risk_usd:          50            // v61: hard cap reduced from $75 → $50 — kicks in earlier at ~$2.5k balance
  };

  /* ── Sector map — used for max_per_sector concentration cap ──────────────── */
  var EE_SECTOR_MAP = {
    /* Energy — not on HL spot (flagged) */
    'WTI':'energy',   'BRENT':'energy', 'XLE':'energy',  'XOM':'energy',   'GAS':'energy',
    /* Precious */
    'XAU':'precious', 'GLD':'precious', 'SLV':'precious', 'SILVER':'precious',
    /* Defense — not on HL spot (flagged) */
    'XAR':'defense',  'LMT':'defense',  'RTX':'defense',  'NOC':'defense',
    /* Crypto perps */
    'BTC':'crypto',   'ETH':'crypto',   'SOL':'crypto',   'BNB':'crypto',   'ADA':'crypto',
    /* HL spot equity tokens */
    'TSLA':'equity',  'AAPL':'equity',  'AMZN':'equity',  'META':'equity',
    'QQQ':'equity',   'MSFT':'equity',  'GOOGL':'equity', 'HOOD':'equity',
    'SPY':'equity',   'CRCL':'equity',
    /* Other equities — various HL coverage status */
    'VIX':'equity',   'VXX':'equity',   'EEM':'equity',   'FXI':'equity',
    /* Semis — mostly not on HL (flagged) */
    'SMH':'semis',    'TSM':'semis',    'NVDA':'semis',   'ASML':'semis',
    /* Agri — not on HL (flagged) */
    'WHT':'agri',     'CORN':'agri',    'SOYB':'agri',
    'DAL':'airlines', 'UAL':'airlines',
    'LIT':'battery',  'COPX':'metals',  'XME':'metals',
    'JPY':'forex',    'CHF':'forex',    'NOK':'forex',    'GBP':'forex',
    'INDA':'em'
  };

  /* ── Flagged trades state (assets not available on Hyperliquid) ─────────────
     Captured BEFORE canExecute() so we record every opportunity missed due to
     HL unavailability, regardless of other risk limits.
     Stored in localStorage (FLAG_STORE_KEY) and rendered in #eeFlaggedTrades. */
  var _flaggedTrades  = [];
  var FLAG_STORE_KEY  = 'ee_flagged_v1';
  var FLAG_MAX        = 500;

  function _loadFlaggedTrades() {
    try { _flaggedTrades = JSON.parse(localStorage.getItem(FLAG_STORE_KEY) || '[]'); }
    catch (e) { _flaggedTrades = []; }
  }
  function _saveFlaggedTrades() {
    try { localStorage.setItem(FLAG_STORE_KEY, JSON.stringify(_flaggedTrades.slice(0, FLAG_MAX))); }
    catch (e) {}
  }

  /* Create a flag record from a signal and persist it */
  function _flagTrade(sig, hlReason) {
    var record = {
      id:          'FLAG-' + Date.now().toString(36).toUpperCase(),
      flaggedAt:   new Date().toISOString(),
      asset:       sig.asset  || '—',
      direction:   sig.dir    || '—',
      confidence:  sig.conf   || 0,
      signalSource:sig.from   || sig.source || (sig.reason ? sig.reason.split(':')[0] : '—'),
      region:      sig.region || '—',
      signalReason:sig.reason || '',
      hlReason:    hlReason,
      intendedRiskPct: _cfg.risk_per_trade_pct
    };
    _flaggedTrades.unshift(record);
    if (_flaggedTrades.length > FLAG_MAX) _flaggedTrades.pop();
    _saveFlaggedTrades();
    _renderFlaggedTrades();
    log('FLAG', record.asset + ' ' + record.direction +
        ' ' + record.confidence + '% — ' + hlReason, 'dim');
  }

  /* Summarise flagged trades: top blocked assets over last 7 days */
  function _getFlagSummary() {
    var cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    var recent = _flaggedTrades.filter(function (f) {
      return new Date(f.flaggedAt).getTime() >= cutoff;
    });
    var counts = {};
    recent.forEach(function (f) {
      counts[f.asset] = (counts[f.asset] || 0) + 1;
    });
    return Object.keys(counts)
      .sort(function (a, b) { return counts[b] - counts[a]; })
      .slice(0, 5)
      .map(function (asset) { return { asset: asset, count: counts[asset] }; });
  }

  /* Render the flagged trades panel */
  function _renderFlaggedTrades() {
    var panel = document.getElementById('eeFlaggedTrades');
    if (!panel) return;
    var todayCutoff = Date.now() - 24 * 3600 * 1000;
    var todayFlags  = _flaggedTrades.filter(function (f) { return new Date(f.flaggedAt).getTime() >= todayCutoff; });
    var weekFlags   = _flaggedTrades.filter(function (f) { return new Date(f.flaggedAt).getTime() >= Date.now() - 7 * 24 * 3600 * 1000; });

    // Update counters
    var todayEl = document.getElementById('eeFlaggedToday');
    var weekEl  = document.getElementById('eeFlaggedWeek');
    if (todayEl) todayEl.textContent = todayFlags.length;
    if (weekEl)  weekEl.textContent  = weekFlags.length;

    // Top missed assets summary
    var summary = _getFlagSummary();
    var summaryEl = document.getElementById('eeFlaggedSummary');
    if (summaryEl && summary.length) {
      summaryEl.textContent = 'Most missed this week: ' +
        summary.map(function (s) { return s.asset + ' (' + s.count + '×)'; }).join('  ·  ');
    }

    // Rows — show last 25
    var show = _flaggedTrades.slice(0, 25);
    panel.innerHTML = show.length ? show.map(function (f) {
      var t   = new Date(f.flaggedAt);
      var ts  = (t.getHours() < 10 ? '0' : '') + t.getHours() + ':' +
                (t.getMinutes() < 10 ? '0' : '') + t.getMinutes();
      var dir = f.direction === 'LONG' ? '<span style="color:#4fc">▲ LONG</span>'
                                       : '<span style="color:#f88">▼ SHORT</span>';
      return '<div class="ee-flag-row">' +
        '<span class="ee-flag-ts">'   + ts               + '</span>' +
        '<span class="ee-flag-asset">'+ f.asset          + '</span>' +
        '<span class="ee-flag-dir">'  + dir              + '</span>' +
        '<span class="ee-flag-conf">' + f.confidence     + '%</span>' +
        '<span class="ee-flag-src">'  + (f.signalSource || '—').substring(0,18) + '</span>' +
        '<span class="ee-flag-why">'  + f.hlReason       + '</span>' +
        '</div>';
    }).join('') : '<div class="ee-flag-empty">No flagged trades yet — all signals so far are on HL</div>';
  }

  /* Render the portfolio watchlist panel (from gii-portfolio agent) */
  function renderPortfolioWatchlist() {
    var listEl = document.getElementById('eePortfolioWatchlist');
    var metaEl = document.getElementById('eePortfolioMeta');
    var rotEl  = document.getElementById('eePortfolioLastRotation');
    if (!listEl) return;

    var agent = window.GII_AGENT_PORTFOLIO;
    if (!agent) {
      listEl.innerHTML = '<div class="ee-flag-empty">Portfolio agent not loaded</div>';
      return;
    }

    var wl  = agent.watchlist();
    var st  = agent.status();
    var rot = agent.rotations();

    /* Meta stats */
    if (metaEl) {
      var ago = st.lastPoll ? Math.round((Date.now() - st.lastPoll) / 1000) + 's ago' : 'never';
      metaEl.textContent = 'Cycle #' + st.pollCount +
        '  ·  ' + (st.stats.scanned || 0) + ' combos scanned' +
        '  ·  ' + (st.stats.candidates || 0) + ' candidates' +
        '  ·  last: ' + ago;
    }

    /* Candidate rows */
    if (!wl.length) {
      listEl.innerHTML = '<div class="ee-flag-empty">No candidates yet — waiting for first scan</div>';
    } else {
      listEl.innerHTML = wl.slice(0, 15).map(function (c, i) {
        var dirHtml = c.dir === 'LONG'
          ? '<span style="color:#4fc">▲ LONG</span>'
          : '<span style="color:#f88">▼ SHORT</span>';
        var scoreColor = c.score >= 4 ? '#4fc' : c.score >= 2.5 ? '#fc4' : '#aaa';
        return '<div class="ee-pw-row">' +
          '<span class="ee-pw-asset">' + (i + 1) + '. ' + c.asset + '</span>' +
          '<span class="ee-pw-dir">' + dirHtml + '</span>' +
          '<span class="ee-pw-score" style="color:' + scoreColor + '">' + c.score.toFixed(2) + '</span>' +
          '<span class="ee-pw-agents" style="color:#888">' + c.agentCount + '</span>' +
          '<span class="ee-pw-reason">' + (c.reason || '').substring(0, 60) + '</span>' +
          '</div>';
      }).join('');
    }

    /* Last rotation */
    if (rotEl) {
      var r = rot[0];
      rotEl.textContent = r
        ? 'Last rotation: closed ' + r.closed + ' (' + r.closedScore + ') → ' +
          r.opened + ' (' + r.openScore + ')  Δ' + r.delta
        : 'No rotations yet';
    }
  }

  /* ── Asset remap table ─────────────────────────────────────────────────────
     Maps signal asset names that are not directly tradeable to their real-market
     proxies. Applied in onSignals() before any execution logic runs.
     VIX (CBOE Volatility Index) is a spot index — cannot be bought/sold directly.
     VXX (iPath S&P 500 VIX Short-Term Futures ETN) is the standard retail proxy.  */
  var ASSET_REMAP = {
    'VIX':  'VXX'   // volatility index → tradeable VIX ETN
  };

  /* ── Correlation groups — assets within each group are treated as equivalent
     exposure. Only ONE asset per group (in the same direction) can be open at
     a time. Prevents doubling up on WTI + BRENT, BTC + ETH, etc.              */
  var CORR_GROUPS = [
    ['WTI',  'BRENT', 'XLE', 'XOM'],    // oil / energy
    ['GLD',  'XAU'],                     // gold
    ['BTC',  'ETH',  'SOL'],            // crypto
    ['LMT',  'RTX',  'NOC',  'XAR'],   // defense
    ['TSM',  'NVDA', 'SMH',  'ASML'],  // semis
    ['SPY',  'QQQ'],                     // US equities
    ['FXI',  'EEM'],                     // emerging markets
    ['DAL',  'UAL'],                     // airlines
  ];

  /* Returns the correlation group containing `asset`, or null */
  function _getCorrGroup(asset) {
    for (var i = 0; i < CORR_GROUPS.length; i++) {
      if (CORR_GROUPS[i].indexOf(asset) !== -1) return CORR_GROUPS[i];
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     EXECUTION REALITY CHECKS — cost model, slippage, liquidity, hold-time guard
     All values are conservative estimates based on retail CFD / futures brokers.
     ══════════════════════════════════════════════════════════════════════════════ */

  /* Per-asset-class cost model
     spread:     one-way half-spread as fraction of price (e.g. 0.0002 = 0.02%)
     slippage:   extra fill degradation on market orders (entries + SL exits)
     commission: per-side rate; round-trip = 2× (e.g. 0.0007 = 0.07% per side)
     funding8h:  crypto perpetual funding rate per 8-hour period                */
  var TRADING_COSTS = {
    crypto:   { spread: 0.0008, slippage: 0.0005, commission: 0.0010, funding8h: 0.0001 },
    energy:   { spread: 0.0004, slippage: 0.0003, commission: 0.0007, funding8h: 0      },
    precious: { spread: 0.0002, slippage: 0.0002, commission: 0.0007, funding8h: 0      },
    equity:   { spread: 0.0001, slippage: 0.0001, commission: 0.0005, funding8h: 0      },
    forex:    { spread: 0.0003, slippage: 0.0002, commission: 0.0006, funding8h: 0      },
    def:      { spread: 0.0006, slippage: 0.0004, commission: 0.0008, funding8h: 0      }
  };

  /* Max realistic position notional per asset class (prevents market-moving sizes) */
  var LIQUIDITY_CAPS = {
    crypto:   500000,
    energy:   200000,
    precious:  50000,
    equity:   100000,
    def:       25000
  };

  /* Minimum time a trade must be open before TP/SL can trigger (ms).
     Prevents instant open→close in a single 30s monitor cycle. */
  var MIN_HOLD_MS = 90000;   // 1.5 minutes
  /* Maximum time a geopolitical trade can remain open before auto-expiry.
     Geopolitical events resolve/price-in within days. A trade still open
     after 7 days means the thesis was never invalidated and exit signals
     failed — safer to close stale positions than hold indefinitely.
     Scalper trades use a much tighter 6-hour limit (set per-trade via source). */
  var MAX_HOLD_MS_GEO     = 7 * 24 * 60 * 60 * 1000;  // 7 days
  var MAX_HOLD_MS_SCALPER = 6 * 60 * 60 * 1000;        // 6 hours

  /* Maximum realistic leverage (notional / balance).
     Standard retail CFD/futures cap — resets to this if exceeded. */
  var MAX_LEVERAGE = 20;

  /* Look up cost profile for an asset.
     HL-covered assets use HL perpetual fees (0.05% taker, tighter spreads).
     Non-HL assets fall back to the existing sector-based CFD/futures model.  */
  function _getCosts(asset) {
    // HL fee override: if this asset trades on Hyperliquid, use HL cost model
    // regardless of whether the WS is currently connected (intent is HL trading).
    try {
      if (window.HLFeed && typeof HLFeed.costs === 'function') {
        var _hlCosts = HLFeed.costs(normaliseAsset(asset));
        if (_hlCosts) return _hlCosts;
      }
    } catch (e) { /* HLFeed mid-reconnect — fall through to sector model */ }
    var sector = EE_SECTOR_MAP[normaliseAsset(asset)] || '';
    if (sector === 'crypto')   return TRADING_COSTS.crypto;
    if (sector === 'energy')   return TRADING_COSTS.energy;
    if (sector === 'precious') return TRADING_COSTS.precious;
    if (sector === 'forex')    return TRADING_COSTS.forex;
    if (['equity','defense','semis','airlines','em','ev','battery','metals'].indexOf(sector) !== -1)
      return TRADING_COSTS.equity;
    return TRADING_COSTS.def;
  }

  /* Adjust entry price for spread (half) + slippage (market order fill degradation).
     LONG buys at ask (higher); SHORT sells at bid (lower). */
  function _adjustedEntryPrice(asset, price, dir) {
    var c   = _getCosts(asset);
    var adj = c.spread / 2 + c.slippage;
    return dir === 'LONG' ? price * (1 + adj) : price * (1 - adj);
  }

  /* Adjust exit price for spread (half) and, for market orders, slippage.
     TP = limit order (spread only — guaranteed fill at limit);
     SL / manual = market order (spread + extra slippage — can gap through).
     LONG sells at bid (lower); SHORT buys back at ask (higher). */
  function _adjustedExitPrice(asset, price, dir, reason) {
    var c          = _getCosts(asset);
    var marketOrder = (reason !== 'TAKE_PROFIT');
    var adj         = c.spread / 2 + (marketOrder ? c.slippage : 0);
    return dir === 'LONG' ? price * (1 - adj) : price * (1 + adj);
  }

  /* Check position notional against liquidity cap; log warning if exceeded */
  // Returns true if position is within liquidity limits, false if it should be rejected.
  // Hard cap: reject if position > 2× the liquidity cap (would cause serious market impact).
  // Soft warning: log if position > 1× cap (oversized but may fill with extra slippage).
  function _checkLiquidity(asset, sizeUsd) {
    var sector = EE_SECTOR_MAP[normaliseAsset(asset)] || 'def';
    var cap    = LIQUIDITY_CAPS[sector] || LIQUIDITY_CAPS.def;
    if (sizeUsd > cap * 2) {
      log('AUDIT', '⛔ LIQUIDITY REJECT: ' + asset + ' position $' + _num(sizeUsd) +
        ' exceeds hard cap $' + _num(cap * 2) + ' — trade blocked (would move market)', 'red');
      return false;
    }
    if (sizeUsd > cap) {
      log('AUDIT', '⚠ LIQUIDITY: ' + asset + ' position $' + _num(sizeUsd) +
        ' exceeds soft cap $' + _num(cap) + ' — expect extra slippage on real exchange', 'amber');
    }
    return true;
  }

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
       close_reason:    string|null  — "TAKE_PROFIT"|"STOP_LOSS"|"TRAILING_STOP"|"MANUAL"|"EXPIRED"
       price_source:    string   — "HYPERLIQUID" (HL WS live at open) | "SIMULATED" (HTTP fallback)
       region:          string   — geopolitical region that triggered signal
       reason:          string   — human-readable signal reason from IC
       broker:          string   — "SIMULATION" | future broker name
       broker_order_id: string|null  — set by broker adapter on live execution
       broker_status:   string|null  — broker-side order status
     }
     ══════════════════════════════════════════════════════════════════════════════ */

  /* ── State ─────────────────────────────────────────────────────────────────── */
  var _cfg         = {};   // active config (merged DEFAULTS + localStorage)
  var _trades      = [];   // all trades: open + closed
  var _cooldown    = {};   // asset → timestamp of last signal processed
  var _log         = [];   // activity log entries
  var _seq         = 0;    // ID sequence counter
  var _livePrice   = {};   // trade_id → most-recently fetched market price
  var _lastSignals = [];   // most recent IC signal batch — used by the re-scan loop
  var _signalLog   = [];   // full history of every IC signal seen (capped at 200)
  var _pnlHistory  = [];   // { ts, balance, event, pnl_usd } balance timeline (capped at 500)
  var _pendingOpen = {};   // asset → true while a fetchPrice is in-flight (prevents duplicate opens)
  var _initialised = false; // reentrancy guard — prevents duplicate intervals if init() called twice
  var _showAllClosed        = false; // UI toggle: show all closed trades vs capped at 25
  var _closedSessionOnly    = false; // UI toggle: show only this-session closed trades
  var _sessionStartBalance  = null;  // balance at session start — for daily loss limit
  var _lossStreak           = { long: 0, short: 0 };  // v61: per-direction streak — long losses don't penalise short sizing
  var _wsConnected          = false; // Binance WebSocket status
  var _wsBtcWs              = null;  // WebSocket instance (BTC real-time)
  var _backendPrices = {};  // symbol → price, populated by _pollBackendPrices() every 25 s (H4)
  var _sessionStart  = null; // ISO timestamp — set on init, reset on analyticsReset/fullReset
  var _priceFeedHealth = {}; // source → { ok: bool, lastOk: ms, lastFail: ms }

  /* ── Price source maps ──────────────────────────────────────────────────────── */

  // 1. Binance: crypto USDT pairs — public REST, no API key required
  var PRICE_SOURCES = {
    'BTC':   'BTCUSDT',
    'ETH':   'ETHUSDT',
    'BNB':   'BNBUSDT',
    'SOL':   'SOLUSDT',
    'ADA':   'ADAUSDT',
    'DOGE':  'DOGEUSDT',
    'XRP':   'XRPUSDT',
    'AVAX':  'AVAXUSDT',
    'LINK':  'LINKUSDT',
    'DOT':   'DOTUSDT'
  };

  // 2. CoinGecko: tokenised gold — 1 PAXG = 1 troy oz gold (CORS-open, no key)
  // https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd
  var COINGECKO_SOURCES = {
    'XAU':  'pax-gold',    // PAX Gold ≈ spot gold price
    'GOLD': 'pax-gold',
    'PAXG': 'pax-gold',
    'XAUT': 'tether-gold'  // Tether Gold: alternative gold token
  };

  // 3. Yahoo Finance via corsproxy.io: commodities, equities, ETFs
  // corsproxy.io adds CORS headers; Yahoo itself blocks direct browser requests.
  // https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1m&range=1d
  var YAHOO_SOURCES = {
    'WTI':     'CL=F',   // WTI Crude Oil futures
    'CRUDE':   'CL=F',
    'OIL':     'CL=F',
    'BRENT':   'BZ=F',   // Brent Crude futures
    'XAG':     'SI=F',   // Silver futures
    'SILVER':  'SI=F',
    'GAS':     'NG=F',   // Natural Gas futures
    'NATURAL': 'NG=F',   // "Natural Gas" → first token = NATURAL
    'NATGAS':  'NG=F',
    'COPPER':  'HG=F',   // Copper futures
    'GDX':     'GDX',    // VanEck Gold Miners ETF
    'GLD':     'GLD',    // SPDR Gold Shares
    'SLV':     'SLV',    // iShares Silver Trust
    'SPY':     'SPY',
    'QQQ':     'QQQ',
    'DAL':     'DAL',    // Delta Air Lines
    'UAL':     'UAL',    // United Airlines
    'LMT':     'LMT',    // Lockheed Martin
    'RTX':     'RTX',    // Raytheon Technologies
    'NOC':     'NOC',    // Northrop Grumman
    'GD':      'GD',     // General Dynamics
    'BA':      'BA',     // Boeing
    'XAR':     'XAR',    // iShares Aerospace & Defense ETF (emitted by gii-macro)
    'ITA':     'ITA',    // iShares U.S. Aerospace & Defense ETF
    'XOM':     'XOM',    // ExxonMobil
    'CVX':     'CVX',    // Chevron
    'TSM':     'TSM',    // Taiwan Semiconductor
    'NVDA':    'NVDA',
    'AMD':     'AMD',
    'TLT':     'TLT',    // iShares 20+ Year Treasury Bond
    'IEF':     'IEF',    // iShares 7-10 Year Treasury Bond
    'HYG':     'HYG',    // iShares High Yield Corporate Bond
    'DXY':     'DX-Y.NYB', // US Dollar Index
    'WEAT':    'WEAT',   // Teucrium Wheat Fund
    'WHT':     'WEAT',   // "Wheat" shorthand → Teucrium Wheat Fund
    'WHEAT':   'WEAT',
    'CORN':    'CORN',   // Teucrium Corn Fund
    'TSLA':    'TSLA',
    'MSFT':    'MSFT',
    'AAPL':    'AAPL',
    'AMZN':    'AMZN',
    'GOOGL':   'GOOGL',
    'META':    'META',
    'INDA':    'INDA',   // iShares MSCI India ETF
    'EEM':     'EEM',    // iShares MSCI Emerging Markets
    'EWZ':     'EWZ',    // iShares MSCI Brazil
    'EWJ':     'EWJ',    // iShares MSCI Japan
    'LIT':     'LIT',    // Global X Lithium & Battery Tech ETF
    'COPX':    'COPX',   // Global X Copper Miners ETF
    'URA':     'URA',    // Global X Uranium ETF
    'URBN':    'URBN',
    'VIX':     '^VIX',   // kept for price reference only — trades remap to VXX
    'VXX':     'VXX'    // iPath Series B S&P 500 VIX Short-Term Futures ETN (actual tradeable proxy)
  };

  // 4. Frankfurter API: ECB forex rates (CORS-open, no key)
  // https://api.frankfurter.app/latest?base={CURRENCY}&symbols=USD → rates.USD
  var FRANKFURTER_SOURCES = {
    'EUR':    'EUR',  'EURUSD': 'EUR',
    'GBP':    'GBP',  'GBPUSD': 'GBP',
    'CHF':    'CHF',
    'JPY':    'JPY',
    'AUD':    'AUD',
    'CAD':    'CAD',
    'NOK':    'NOK'
  };

  var _priceCache   = {};   // token → last known price (any source)
  var _priceCacheTs = {};   // token → ms timestamp of last successful fetch
  var _CACHE_TTL    = 15000; // 15 s — shorter than 30-s monitor cycle so prices are fresh

  /* ══════════════════════════════════════════════════════════════════════════════
     PERSISTENCE
     ══════════════════════════════════════════════════════════════════════════════
     Primary store  : SQLite via GeoIntel backend (http://localhost:8765/api/trades)
     Fallback store : localStorage (always written as an immediate backup)

     Strategy:
       1. On init, try API. If online → load from DB (authoritative).
       2. Migrate any localStorage trades not in the DB (one-time, then clear LS).
       3. On openTrade / closeTrade → fire async POST/PATCH to API (fire-and-forget).
       4. localStorage is always written synchronously so the UI works offline.
     ══════════════════════════════════════════════════════════════════════════════ */

  /* ── Config (localStorage only — lightweight, no history needed) ─────────── */

  function loadCfg() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      _cfg = raw ? Object.assign({}, DEFAULTS, JSON.parse(raw)) : Object.assign({}, DEFAULTS);
      if (_cfg._state_version !== STATE_VERSION) {
        console.info('[EE] State version migrating from', _cfg._state_version || 'none', '→', STATE_VERSION);
      }
      _cfg._state_version = STATE_VERSION;
      // audit-v2 migration: daily loss limit 50%→10% (50% was not a real circuit breaker)
      if (_cfg.daily_loss_limit_pct > 10 || _cfg.daily_loss_limit_pct < 1) {
        _cfg.daily_loss_limit_pct = DEFAULTS.daily_loss_limit_pct;
      }
      // audit-v2 migration: max_open_trades 8→5 (only hold highest-conviction ideas)
      if (_cfg.max_open_trades > 5) {
        _cfg.max_open_trades = DEFAULTS.max_open_trades;
      }
      // audit-v2 migration: max_per_region 3→2 (tighter regional concentration cap)
      if (_cfg.max_per_region > 2) {
        _cfg.max_per_region = DEFAULTS.max_per_region;
      }
      // audit-v2 migration: disable crude trailing stop — gii-exit progressive trail owns this now
      _cfg.trailing_stop_enabled = false;
      // audit migration: raise min_confidence from legacy 65 to 70
      if (_cfg.min_confidence < 70) {
        _cfg.min_confidence = DEFAULTS.min_confidence;
      }
    } catch (e) { _cfg = Object.assign({}, DEFAULTS); }
  }

  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(_cfg)); } catch (e) {}
  }

  /* ── Trades — synchronous localStorage (immediate) ───────────────────────── */

  function loadTrades() {
    try {
      var raw = localStorage.getItem(TRADES_KEY);
      // Migration: check legacy key names so version bumps don't silently orphan history
      if (!raw) {
        var legacyKeys = ['geodash_ee_trades', 'geodash_ee_trades_v0'];
        for (var i = 0; i < legacyKeys.length; i++) {
          var legacyRaw = localStorage.getItem(legacyKeys[i]);
          if (legacyRaw) {
            raw = legacyRaw;
            localStorage.setItem(TRADES_KEY, raw);
            localStorage.removeItem(legacyKeys[i]);
            break;
          }
        }
      }
      if (raw) {
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('trades not array');
        _trades = parsed;
      } else {
        _trades = [];
      }
    } catch (e) { _trades = []; }
  }

  function saveTrades() {
    // v60: in-memory soft cap — keep ALL open trades + last 500 closed.
    // Full history is always safe in localStorage and the Render SQLite backend.
    var open   = _trades.filter(function (t) { return t.status === 'OPEN'; });
    var closed = _trades.filter(function (t) { return t.status !== 'OPEN'; });
    if (closed.length > 500) {
      closed = closed.slice(-500);   // keep most-recent 500 closed
      _trades = open.concat(closed);
    }
    try {
      localStorage.setItem(TRADES_KEY, JSON.stringify(_trades));
    } catch (e) {
      // QuotaExceededError: browser storage is full — warn the user visibly
      var isQuota = e && (e.name === 'QuotaExceededError' ||
                          e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
                          e.code === 22 || e.code === 1014);
      if (isQuota) {
        log('ERROR', 'localStorage FULL — trades not saved locally. Export now!', 'red');
        var banner = document.getElementById('eeDataSafetyBanner');
        if (banner) {
          banner.style.display = 'block';
          banner.innerHTML =
            '<span style="color:#e84040;font-weight:bold">&#9888; STORAGE FULL</span>' +
            '<span style="color:var(--dim);margin-left:8px">Browser storage is full — new trades are NOT being saved locally.</span>' +
            '<button onclick="EE.exportJSON()" style="margin-left:10px;padding:2px 10px;background:#e84040;color:#fff;border:none;font-family:inherit;font-size:10px;font-weight:bold;cursor:pointer">&#8595; EXPORT NOW</button>';
        }
      }
    }
  }

  /* ── Signal log (localStorage only) ────────────────────────────────────────── */

  function loadSigLog() {
    try {
      var raw = localStorage.getItem(SIGLOG_KEY);
      _signalLog = raw ? JSON.parse(raw) : [];
    } catch (e) { _signalLog = []; }
  }

  function saveSigLog() {
    try { localStorage.setItem(SIGLOG_KEY, JSON.stringify(_signalLog)); } catch (e) {}
  }

  /* ── P&L History (localStorage) ─────────────────────────────────────────── */

  function loadPnlHistory() {
    try {
      var raw = localStorage.getItem(PNL_HISTORY_KEY);
      _pnlHistory = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(_pnlHistory)) _pnlHistory = [];
    } catch (e) { _pnlHistory = []; }
  }

  function savePnlHistory() {
    try { localStorage.setItem(PNL_HISTORY_KEY, JSON.stringify(_pnlHistory)); } catch (e) {}
  }

  function _recordPnlSnapshot(event, pnl_usd) {
    _pnlHistory.push({
      ts:      Date.now(),
      balance: _cfg.virtual_balance,
      event:   event || 'unknown',
      pnl_usd: pnl_usd || 0
    });
    if (_pnlHistory.length > 500) _pnlHistory = _pnlHistory.slice(-500);
    savePnlHistory();
  }

  /* ── Backup — snapshot state before destructive operations ──────────────── */

  function _createBackup() {
    try {
      var ts  = Date.now();
      var bak = {
        version:    STATE_VERSION,
        created:    new Date().toISOString(),
        cfg:        JSON.stringify(_cfg),
        trades:     JSON.stringify(_trades),
        sigLog:     JSON.stringify(_signalLog.slice(0, 50)),
        pnlHistory: JSON.stringify(_pnlHistory)
      };
      localStorage.setItem('geodash_backup_' + ts, JSON.stringify(bak));
      // Keep only the 3 most recent backups to stay within quota
      var bkeys = Object.keys(localStorage)
        .filter(function (k) { return k.indexOf('geodash_backup_') === 0; })
        .sort();
      while (bkeys.length > 3) { try { localStorage.removeItem(bkeys.shift()); } catch(e) {} }
      return ts;
    } catch (e) { return null; }
  }

  /* ── API helpers (async, fire-and-forget) ────────────────────────────────── */

  function _apiFetch(path, opts) {
    return fetch(_API_BASE + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  }

  /* POST a single trade to the API (insert/upsert) */
  function _apiPostTrade(trade) {
    if (!_apiOnline) return;
    _apiFetch('/api/trades', { method: 'POST', body: JSON.stringify(trade) })
      .catch(function () { _apiOnline = false; });
  }

  /* PATCH an existing trade in the API (e.g. after close) */
  function _apiPatchTrade(tradeId, updates) {
    if (!_apiOnline) return;
    _apiFetch('/api/trades/' + encodeURIComponent(tradeId), {
      method: 'PATCH',
      body:   JSON.stringify(updates)
    }).catch(function () { _apiOnline = false; });
  }

  /* ── API startup: check online, load DB trades, migrate localStorage ──────── */

  function _apiInit(retryCount) {
    retryCount = retryCount || 0;
    var RETRY_DELAYS = [2000, 4000, 8000];   // backoff: 2s, 4s, 8s then give up

    _apiFetch('/api/status')
      .then(function (r) {
        if (!r.ok) throw new Error('status ' + r.status);
        _apiOnline = true;
        _backendChecked = true;
        _pollBackendPrices();                    // H4: prime the price cache immediately
        setInterval(_pollBackendPrices, 25000);  // H4: refresh every 25 s
        return _apiFetch('/api/trades');
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var dbTrades = data.trades || [];

        // Build lookup of trade_ids already in DB
        var inDb = {};
        dbTrades.forEach(function (t) { inDb[t.trade_id] = true; });

        // Migrate any localStorage trades not yet in DB (one-time)
        var toMigrate = _trades.filter(function (t) { return !inDb[t.trade_id]; });
        if (toMigrate.length) {
          _apiFetch('/api/trades', { method: 'POST', body: JSON.stringify(toMigrate) })
            .then(function () {
              log('SYSTEM', 'Migrated ' + toMigrate.length + ' trade(s) from localStorage → SQLite', 'dim');
            })
            .catch(function () {});
        }

        // ID-based merge: union of DB + local, DB wins for same trade_id.
        // This prevents a count-based comparison from silently discarding trades that
        // exist locally but not yet in the DB (e.g. opened while backend was offline).
        var merged = {};
        _trades.forEach(function (t) { if (t.trade_id) merged[t.trade_id] = t; });
        dbTrades.forEach(function (t) { if (t.trade_id) merged[t.trade_id] = t; }); // DB wins
        var mergedArr = Object.keys(merged).map(function (id) { return merged[id]; });
        mergedArr.sort(function (a, b) {
          return new Date(b.timestamp_open) - new Date(a.timestamp_open);
        });
        _trades = mergedArr;
        saveTrades();   // keep localStorage in sync
        renderUI();
        log('SYSTEM',
          'SQLite backend online — ' + dbTrades.length + ' DB + ' + toMigrate.length + ' migrated → ' + _trades.length + ' total',
          'green');
      })
      .catch(function (err) {
        _apiOnline = false;
        if (retryCount < RETRY_DELAYS.length) {
          var delay = RETRY_DELAYS[retryCount];
          log('SYSTEM', 'Backend unreachable — retrying in ' + (delay / 1000) + 's (attempt ' + (retryCount + 1) + '/' + RETRY_DELAYS.length + ')', 'dim');
          setTimeout(function () { _apiInit(retryCount + 1); }, delay);
        } else {
          _backendChecked = true;
          log('SYSTEM', 'SQLite backend offline — using localStorage only', 'dim');
          renderUI(); // refresh banner
        }
      });
  }

  /* H4 — Poll backend /api/market and cache prices in _backendPrices.
     Runs every 25 s while backend is online. Gives fetchPrice() a privacy-safe
     step-0 source that avoids corsproxy.io for all backend-tracked symbols.     */
  function _pollBackendPrices() {
    if (!_apiOnline) return;
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var tid = controller ? setTimeout(function () { controller.abort(); }, 5000) : null;
    _apiFetch('/api/market', controller ? { signal: controller.signal } : {})
      .then(function (r) { clearTimeout(tid); return r.json(); })
      .then(function (data) {
        Object.keys(data).forEach(function (sym) {
          var entry = data[sym];
          if (entry && typeof entry.price === 'number' && entry.price > 0) {
            _backendPrices[sym] = entry.price;
          }
        });
      })
      .catch(function () { clearTimeout(tid); });   // silent — fetchPrice falls through to other sources

    // v60: prune stale _priceCache entries (older than 5 min) to prevent unbounded growth
    var _PRUNE_AGE = 300000;
    var _now = Date.now();
    Object.keys(_priceCacheTs).forEach(function (tok) {
      if (_now - _priceCacheTs[tok] > _PRUNE_AGE) {
        delete _priceCache[tok];
        delete _priceCacheTs[tok];
      }
    });
  }

  /* Record one signal event — action: 'TRADED' | 'SKIPPED' | 'WATCH' */
  function _logSignal(sig, action, skipReason) {
    _signalLog.unshift({
      ts:          new Date().toISOString(),
      asset:       sig.asset  || '—',
      dir:         sig.dir    || '—',
      conf:        sig.conf   || 0,
      reason:      sig.reason || '',
      region:      sig.region || '—',
      action:      action,
      skip_reason: skipReason || null
    });
    var _maxLog = _cfg.max_siglog || 200;
    if (_signalLog.length > _maxLog) _signalLog.length = _maxLog;  // cap (configurable via max_siglog)
    saveSigLog();
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     PRICE FETCHING
     Waterfall — all paths fire cb(price|null), never throw.

       API coverage (all confirmed CORS-open from browser):
         Binance      → crypto: BTC, ETH, SOL, …
         CoinGecko    → gold: XAU/GOLD (via PAX Gold token 1 PAXG ≈ 1 troy oz)
         corsproxy.io → commodities, stocks, ETFs via Yahoo Finance charts
                        WTI/Brent oil, Silver, Nat-Gas, DAL, LMT, GDX, SPY, …
         Frankfurter  → forex spot: EUR/USD, GBP/USD, …
         Ticker scrape→ any price already shown in the dashboard ticker bar
         Cache        → last-known price from any prior source

       CORS situation (as of March 2026):
         Yahoo Finance directly = CORS-blocked  ✗
         metals.live directly  = CORS-blocked  ✗
         Stooq directly        = CORS-blocked  ✗
         Binance               = CORS-open     ✓
         CoinGecko             = CORS-open     ✓
         corsproxy.io (proxy)  = CORS-open     ✓
         Frankfurter           = CORS-open     ✓
     ══════════════════════════════════════════════════════════════════════════════ */

  /* CORS proxy list — tried in order if primary fails.
     corsproxy.io: fast, reliable, but single point of failure.
     allorigins.win/raw: independent backup, same raw-content interface. */
  var _CORS_PROXIES = [
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url='
  ];
  var _CORS_PROXY = _CORS_PROXIES[0];   // kept for any other usages

  function normaliseAsset(asset) {
    // "WTI Crude Oil"→"WTI",  "BTC/USD"→"BTC",  "GDX (Gold Miners)"→"GDX"
    // Known multi-word aliases: "NATURAL GAS" was incorrectly → "NATURAL" (not "GAS").
    // Check full-string alias table before falling through to first-token logic.
    var MULTI_WORD_ALIASES = {
      'NATURAL GAS':  'GAS',   'NAT GAS':      'GAS',
      'CRUDE OIL':    'WTI',   'US OIL':       'WTI',   'LIGHT CRUDE':  'WTI',
      'BRENT CRUDE':  'BRENT', 'BRENT OIL':    'BRENT',
      'GOLD':         'XAU',   'SPOT GOLD':    'XAU',
      'SILVER':       'SLV',   'SPOT SILVER':  'SLV',
      'S&P 500':      'SPY',   'S&P500':       'SPY',   'SP500':        'SPY',
      'NASDAQ':       'QQQ',   'NASDAQ 100':   'QQQ',   'NASDAQ100':    'QQQ',
      'DOW JONES':    'DIA',   'DOW':          'DIA',
      'BITCOIN':      'BTC',   'ETHEREUM':     'ETH',
      'JAPANESE YEN': 'JPY',   'SWISS FRANC':  'CHF'
    };
    var up = String(asset || '').toUpperCase().trim();
    if (MULTI_WORD_ALIASES[up]) return MULTI_WORD_ALIASES[up];
    return up.replace(/[^A-Z0-9]/g, ' ').trim().split(' ')[0];
  }

  function _cacheSet(token, price) {
    _priceCache[token]   = price;
    _priceCacheTs[token] = Date.now();
  }

  function _cacheFresh(token) {
    return _priceCacheTs[token] && (Date.now() - _priceCacheTs[token]) < _CACHE_TTL;
  }

  /* Scrape the on-page live ticker for a price — used as a reliable fallback
     when external APIs (Yahoo/CoinGecko) fail due to CORS or rate limits.
     Handles aliases: GLD→GOLD, XAG→SILVER, OIL→WTI so tickers with
     different names are still matched. */
  // Note: GLD is intentionally excluded — GLD is the SPDR ETF (~1/10 oz gold), NOT spot gold.
  // If Yahoo Finance fails, returning the dashboard's spot GOLD price (10× higher) would corrupt
  // position sizing. Better to return null (skip trade) than trade at 10× the wrong price.
  var _TICKER_ALIASES = { 'XAU':'GOLD', 'XAG':'SILVER', 'SLV':'SILVER', 'OIL':'WTI', 'CRUDE':'WTI', 'BRENT':'OIL', 'GAS':'NATGAS' };
  function _tickerPrice(token) {
    var searches = [token];
    if (_TICKER_ALIASES[token]) searches.push(_TICKER_ALIASES[token]);
    var found = null;
    var els = document.querySelectorAll('.tick-item');
    els.forEach(function (el) {
      if (found) return;
      var txt = (el.textContent || '').toUpperCase();
      for (var i = 0; i < searches.length; i++) {
        if (txt.indexOf(searches[i]) !== -1) {
          var m = txt.match(/\$([\d,]+\.?\d*)/);
          if (m) { found = parseFloat(m[1].replace(/,/g, '')); break; }
        }
      }
    });
    return found;
  }

  /* Gold via CoinGecko PAX Gold (1 PAXG = 1 troy oz, price tracks spot) */
  function _fetchCoinGecko(token, coinId, cb) {
    if (_cacheFresh(token)) { cb(_priceCache[token] || null); return; }
    var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' +
              encodeURIComponent(coinId) + '&vs_currencies=usd';
    fetch(url)
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (data) {
        var price = data && data[coinId] && parseFloat(data[coinId].usd);
        if (!isNaN(price) && price > 0) {
          var isFirst = !_priceCache[token];
          _cacheSet(token, price);
          if (isFirst) log('PRICE', 'CoinGecko → ' + token + ' $' + price.toFixed(2) +
                           ' (via ' + coinId + ')', 'dim');
        }
        cb(!isNaN(price) && price > 0 ? price : (_priceCache[token] || null));
      })
      .catch(function () {
        var tp = _tickerPrice(token);
        if (tp) { _cacheSet(token, tp); cb(tp); return; }
        cb(_priceCache[token] || null);
      });
  }

  /* Yahoo Finance chart API — tries each CORS proxy in sequence on failure */
  function _fetchYahoo(token, sym, cb) {
    if (_cacheFresh(token)) { cb(_priceCache[token] || null); return; }
    var yahooUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                   encodeURIComponent(sym) + '?interval=1m&range=1d';
    var proxyIdx = 0;

    function tryProxy() {
      if (proxyIdx >= _CORS_PROXIES.length) {
        // All proxies failed — fall back to on-page ticker then cache
        var tp = _tickerPrice(token);
        if (tp) {
          _cacheSet(token, tp);
          log('PRICE', 'Ticker fallback → ' + token + ' $' + tp.toFixed(2) + ' (Yahoo unavailable)', 'dim');
          cb(tp);
          return;
        }
        if (_priceCache[token]) {
          log('PRICE', 'Cache fallback → ' + token + ' $' + _priceCache[token].toFixed(2) + ' (stale)', 'dim');
        }
        cb(_priceCache[token] || null);
        return;
      }
      var proxy = _CORS_PROXIES[proxyIdx++];
      fetch(proxy + encodeURIComponent(yahooUrl))
        .then(function (r) { if (!r.ok) throw 0; return r.json(); })
        .then(function (data) {
          var meta  = data && data.chart && data.chart.result &&
                      data.chart.result[0] && data.chart.result[0].meta;
          var price = meta ? parseFloat(meta.regularMarketPrice) : NaN;
          if (!isNaN(price) && price > 0) {
            var isFirst = !_priceCache[token];
            _cacheSet(token, price);
            if (isFirst) log('PRICE', 'Yahoo → ' + sym + ' $' + price.toFixed(2), 'dim');
            cb(price);
          } else {
            tryProxy();   // try next proxy — bad data
          }
        })
        .catch(function () { tryProxy(); });   // try next proxy — network error
    }
    tryProxy();
  }

  /* Frankfurter API — ECB-sourced forex spot rates, no API key needed */
  function _fetchFrankfurter(token, base, cb) {
    if (_cacheFresh(token)) { cb(_priceCache[token] || null); return; }
    fetch('https://api.frankfurter.app/latest?base=' + base + '&symbols=USD')
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (data) {
        var price = data && data.rates && parseFloat(data.rates.USD);
        if (!isNaN(price) && price > 0) {
          var isFirst = !_priceCache[token];
          _cacheSet(token, price);
          if (isFirst) log('PRICE', 'Frankfurter → ' + base + '/USD ' + price.toFixed(4), 'dim');
        }
        cb(!isNaN(price) && price > 0 ? price : (_priceCache[token] || null));
      })
      .catch(function () { cb(_priceCache[token] || null); });
  }

  /* Main entry point — routes to correct source, falls through to cache */
  function fetchPrice(asset, cb) {
    var token = normaliseAsset(asset);

    function _feedOk(src)   { _priceFeedHealth[src] = { ok: true,  lastOk:   Date.now(), lastFail: (_priceFeedHealth[src]||{}).lastFail||null }; }
    function _feedFail(src) { _priceFeedHealth[src] = { ok: false, lastOk:   (_priceFeedHealth[src]||{}).lastOk||null, lastFail: Date.now() }; }

    // -1. Hyperliquid WebSocket — real-time prices, highest priority when connected.
    //     HL streams allMids for 300+ pairs incl. WTI, Brent, Gold, BTC, equities.
    //     Only used when the price is fresh (< 30s), meaning the WS is actively streaming.
    //     Falls through to the backend/HTTP chain if WS is down or asset not on HL.
    if (window.HLFeed && typeof HLFeed.getPrice === 'function') {
      var _hlr = HLFeed.getPrice(token);
      if (_hlr && _hlr.fresh) {
        _cacheSet(token, _hlr.price);
        _priceFeedHealth['hl'] = { ok: true, lastOk: Date.now(),
          lastFail: (_priceFeedHealth['hl'] || {}).lastFail || null };
        cb(_hlr.price);
        return;
      }
      // HL covers this asset but price is stale (WS briefly disconnected) —
      // mark feed as degraded and fall through to backup sources.
      if (_hlr && !_hlr.fresh && window.HLFeed.covers(token)) {
        _priceFeedHealth['hl'] = { ok: false, lastOk: (_priceFeedHealth['hl'] || {}).lastOk || null,
          lastFail: Date.now() };
      }
    }

    // 0. Backend market cache — privacy-safe, no corsproxy needed (H4)
    //    Covers WTI, BRENT, GLD, LMT, TSM, SPY, BTC, ETH, etc.
    if (_apiOnline && _backendPrices[token] !== undefined) {
      _cacheSet(token, _backendPrices[token]);
      _feedOk('backend');
      cb(_backendPrices[token]);
      return;
    }

    // 1. Binance — crypto USDT pairs (public, no key, CORS-open)
    if (PRICE_SOURCES[token]) {
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=' + PRICE_SOURCES[token])
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var price = parseFloat(d.price);
          if (!isNaN(price)) { _cacheSet(token, price); _feedOk('binance'); }
          else { _feedFail('binance'); }
          cb(!isNaN(price) ? price : (_priceCache[token] || null));
        })
        .catch(function () { _feedFail('binance'); cb(_priceCache[token] || null); });
      return;
    }

    // 2. CoinGecko — gold (XAU via PAX Gold; 1 PAXG ≈ 1 troy oz)
    if (COINGECKO_SOURCES[token]) {
      _fetchCoinGecko(token, COINGECKO_SOURCES[token], function(p) {
        if (p) _feedOk('coingecko'); else _feedFail('coingecko');
        cb(p);
      });
      return;
    }

    // 3. corsproxy + Yahoo Finance — oil, silver, nat-gas, stocks, ETFs
    if (YAHOO_SOURCES[token]) {
      _fetchYahoo(token, YAHOO_SOURCES[token], function(p) {
        if (p) _feedOk('yahoo'); else _feedFail('yahoo');
        cb(p);
      });
      return;
    }

    // 4. Frankfurter — major forex spot rates (ECB data)
    if (FRANKFURTER_SOURCES[token]) {
      _fetchFrankfurter(token, FRANKFURTER_SOURCES[token], function(p) {
        if (p) _feedOk('frankfurter'); else _feedFail('frankfurter');
        cb(p);
      });
      return;
    }

    // 5. Dashboard live ticker (prices already shown on-page, handles aliases GLD→GOLD etc.)
    var found = _tickerPrice(token);
    if (found) { _cacheSet(token, found); cb(found); return; }

    // 6. Last-known price from any prior source
    cb(_priceCache[token] || null);
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

    // Source corroboration: require at least 2 independent data sources for non-scalper signals.
    // Single-source signals (srcCount=1) have high false-positive rate — audit found no win-rate benefit.
    var _isSrcScalper = sig.reason && (sig.reason.indexOf('SCALPER') === 0 || sig.reason.indexOf('GII:') === 0);
    if (!_isSrcScalper && sig.srcCount !== undefined && sig.srcCount < 2)
      return { ok: false, reason: 'srcCount ' + sig.srcCount + ' < 2 — single-source signal not confirmed' };

    var open = openTrades();

    if (open.length >= _cfg.max_open_trades)
      return { ok: false, reason: 'Max open trades (' + _cfg.max_open_trades + ') reached' };

    var regionOpen = open.filter(function (t) { return t.region === sig.region; }).length;
    if (regionOpen >= _cfg.max_per_region)
      return { ok: false, reason: 'Max per region (' + _cfg.max_per_region + ') reached for ' + sig.region };

    // Sector concentration cap: prevent overloading a single sector (energy, crypto, etc.)
    var sector = EE_SECTOR_MAP[normaliseAsset(sig.asset)];
    if (sector && _cfg.max_per_sector) {
      var sectorOpen = open.filter(function (t) { return EE_SECTOR_MAP[normaliseAsset(t.asset)] === sector; }).length;
      if (sectorOpen >= _cfg.max_per_sector)
        return { ok: false, reason: 'Max per sector (' + _cfg.max_per_sector + ') reached for ' + sector };
    }

    if (open.some(function (t) { return normaliseAsset(t.asset) === normaliseAsset(sig.asset); }))
      return { ok: false, reason: 'Already have open trade for ' + sig.asset };

    // Pending lock: fetchPrice is async — block second signal for same asset while first is in flight
    if (_pendingOpen[normaliseAsset(sig.asset)])
      return { ok: false, reason: 'Price fetch already in progress for ' + sig.asset };

    // Correlation guard: block if a correlated asset is already open in the same direction
    var corrGroup = _getCorrGroup(normaliseAsset(sig.asset));
    if (corrGroup) {
      var corrConflict = open.find(function (t) {
        return corrGroup.indexOf(normaliseAsset(t.asset)) !== -1 && t.direction === sig.dir;
      });
      if (corrConflict)
        return { ok: false, reason: 'Correlated position open: ' + corrConflict.asset + ' ' + corrConflict.direction };
    }

    var lastTs = _cooldown[sig.asset];
    if (lastTs && (Date.now() - lastTs) < _cfg.cooldown_ms)
      return { ok: false, reason: 'Cooldown active for ' + sig.asset };

    // Exposure = total risk dollars at stake (units × |entry−stop| per trade).
    // Using notional size_usd here would falsely block every trade because
    // position sizing math produces size_usd ≈ full balance per trade.
    // Correlated positions (same CORR_GROUP) are weighted 1.5× because they
    // tend to move together — opening BTC while ETH is live = ~1.5× real BTC risk.
    var _newCorrGroup = _getCorrGroup(normaliseAsset(sig.asset));
    var exposure = open.reduce(function (s, t) {
      var slDist = Math.abs((t.entry_price || 0) - (t.stop_loss || 0));
      var riskDollars = slDist > 0 ? (t.units || 0) * slDist : 0;
      var corrMult = (_newCorrGroup && _newCorrGroup.indexOf(normaliseAsset(t.asset)) !== -1) ? 1.5 : 1.0;
      return s + riskDollars * corrMult;
    }, 0);
    var maxExp   = _cfg.virtual_balance * _cfg.max_exposure_pct / 100;
    if (exposure >= maxExp)
      return { ok: false, reason: 'Max exposure ' + _cfg.max_exposure_pct + '% reached' };

    // Session daily loss limit (configurable, replaces hard-coded 10% check)
    if (_sessionStartBalance && _cfg.daily_loss_limit_pct > 0) {
      var sessionLossPct = (_cfg.virtual_balance - _sessionStartBalance) / _sessionStartBalance * 100;
      if (sessionLossPct < -_cfg.daily_loss_limit_pct) {
        return { ok: false, reason: 'Daily loss limit -' + _cfg.daily_loss_limit_pct + '% reached — execution paused' };
      }
    }

    // Pre-event gate: block new trades within event_gate_hours of major calendar events
    if (_cfg.event_gate_enabled) {
      var calAgent = window.GII_AGENT_CALENDAR;
      if (calAgent && typeof calAgent.upcoming === 'function') {
        try {
          var upcoming = calAgent.upcoming();
          var gateHours = _cfg.event_gate_hours || 0.5;
          var blocked = upcoming.filter(function (ev) {
            // ev.days is days until event; 0 = today, negative = past
            return ev.importance >= 3 && ev.days >= 0 && ev.days <= (gateHours / 24);
          });
          if (blocked.length) {
            var ev0 = blocked[0];
            var minsAway = Math.round(ev0.days * 24 * 60);
            return { ok: false, reason: 'Event gate: "' + ev0.label.substring(0, 45) + '" in ' + minsAway + 'min' };
          }
        } catch (e) { /* calendar agent unavailable — skip gate */ }
      }
    }

    // Time-of-day filter: avoid first and last 30 min of US equity session.
    // Open (09:30–10:00 ET) and close (15:30–16:00 ET) have wide spreads,
    // erratic price action, and high false-signal rates for news-based entries.
    // Scalper signals are exempt — they are specifically designed for short-term moves.
    var _isScalperForTod = sig.reason && (sig.reason.indexOf('SCALPER') === 0 || sig.reason.indexOf('GII:') === 0);
    if (!_isScalperForTod) {
      var _now = new Date();
      // Convert to US Eastern Time (UTC-5 standard, UTC-4 daylight saving).
      // Simple approximation: ET = UTC - 5h (adjust for DST where needed).
      var _utcH = _now.getUTCHours(), _utcM = _now.getUTCMinutes();
      var _etMins = (_utcH * 60 + _utcM + 1440 - 300) % 1440;  // minutes since midnight ET (EST offset)
      var _openStart = 9 * 60 + 30, _openEnd = 10 * 60;         // 09:30–10:00
      var _closeStart = 15 * 60 + 30, _closeEnd = 16 * 60;      // 15:30–16:00
      if ((_etMins >= _openStart && _etMins < _openEnd) ||
          (_etMins >= _closeStart && _etMins < _closeEnd)) {
        return { ok: false, reason: 'Time-of-day gate: US session open/close window (avoid first/last 30min)' };
      }
    }

    // Signal age check: if the signal carries a timestamp and it is older than
    // 15 minutes, reject. The market has already moved on — we're chasing.
    // Scalper signals are exempt (they expire via their own TTL mechanism).
    var _isScalperForAge = sig.reason && (sig.reason.indexOf('SCALPER') === 0 || sig.reason.indexOf('GII:') === 0);
    if (!_isScalperForAge && sig.ts && (Date.now() - sig.ts) > 15 * 60 * 1000) {
      return { ok: false, reason: 'Signal stale — ' + Math.round((Date.now() - sig.ts) / 60000) + 'min old (>15min threshold)' };
    }

    return { ok: true, reason: 'All risk checks passed' };
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     TRADE LIFECYCLE
     ══════════════════════════════════════════════════════════════════════════════ */

  function makeId(prefix) {
    // timestamp(base36) + sequence(base36) + 4-char random hex → collision-safe unique IDs
    var r = ('000' + Math.floor(Math.random() * 0xFFFF).toString(16)).slice(-4).toUpperCase();
    return prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + (++_seq).toString(36).toUpperCase() + '-' + r;
  }

  /* Infer signal source from reason string — fallback for pre-tagging legacy trades */
  function _inferSource(reason) {
    if (reason.indexOf('SCALPER-SESSION:') === 0) return 'scalper-session';
    if (reason.indexOf('SCALPER:')         === 0) return 'scalper';
    if (reason.indexOf('GII:')             === 0) return 'gii';
    return 'ic';  // default: IC-sourced trade
  }

  /* Build a complete trade object from a signal + entry price */
  function buildTrade(sig, entryPrice) {
    var dir     = sig.dir === 'SHORT' ? 'SHORT' : 'LONG';
    // ATR-based stop/target: prefer per-signal values from gii-technicals
    // over the global fixed-percentage config (backward-compatible fallback).
    // Also accepts sig.stopPct / sig.tpRatio for volatility-adjusted sizing
    // from gii-entry (asset-specific percentage stops, e.g. BTC=6%, GLD=2%).
    var sigStopPct = (sig.stopPct  && isFinite(sig.stopPct)  && sig.stopPct  > 0) ? sig.stopPct  : _cfg.stop_loss_pct;
    var sigTpRatio = (sig.tpRatio  && isFinite(sig.tpRatio)  && sig.tpRatio  > 0) ? sig.tpRatio  : _cfg.take_profit_ratio;
    var defaultSlDist = entryPrice * (sigStopPct / 100);
    var slDist_ = (sig.atrStop  && isFinite(sig.atrStop)  && sig.atrStop  > 0) ? sig.atrStop  : defaultSlDist;
    var tpDist_ = (sig.atrTarget && isFinite(sig.atrTarget) && sig.atrTarget > 0) ? sig.atrTarget : slDist_ * sigTpRatio;

    var stopLoss, takeProfit;
    if (dir === 'LONG') {
      stopLoss   = entryPrice - slDist_;
      takeProfit = entryPrice + tpDist_;
    } else {
      stopLoss   = entryPrice + slDist_;
      takeProfit = entryPrice - tpDist_;
    }

    // Sanity check: stop must be on correct side of entry, and slDist must be
    // reasonable (≤ 20% of entry). Catches GLD spot/ETF price mix-ups and
    // wrong-direction stops from GII signals that reference a different price source.
    var rawSlDist = Math.abs(entryPrice - stopLoss);
    var maxSlDist  = entryPrice * 0.20;
    var stopOnWrongSide = (dir === 'LONG' && stopLoss >= entryPrice) ||
                          (dir === 'SHORT' && stopLoss <= entryPrice);
    if (stopOnWrongSide || rawSlDist > maxSlDist) {
      slDist_ = entryPrice * (_cfg.stop_loss_pct / 100);
      tpDist_ = slDist_ * sigTpRatio;
      stopLoss   = dir === 'LONG' ? entryPrice - slDist_ : entryPrice + slDist_;
      takeProfit = dir === 'LONG' ? entryPrice + tpDist_ : entryPrice - tpDist_;
    }

    // Position sizing: base risk scaled by signal impact strength
    // sig.impactMult: GTI size reduction (0.45–1.0) OR event impact (0.5–2.0)
    // Floor lowered to 0.1 so GTI extreme-tension 0.45 passes through correctly
    var impactMult = (sig.impactMult && isFinite(sig.impactMult))
      ? Math.max(0.1, Math.min(2.0, sig.impactMult))
      : 1.0;

    // EV/Kelly adjustment: scale size by simplified Kelly fraction using
    // historical win rate. Uses a global prior from total trade history so that
    // every trade (not just those with 5+ asset-specific records) gets Kelly sizing.
    // Kelly f* = (W * R - L) / R  where W=winRate, L=1-W, R=TP:SL ratio
    // We use a half-Kelly approach (×0.5) for safety.
    //
    // Audit fix: previous version used kellyMult=1.0 for assets without ≥5 trades,
    // meaning untested assets always got full sizing. At a 13% system win rate,
    // Kelly says negative EV — we should be sizing DOWN on all untested trades.
    // Now: calculate global win rate from all closed trades as the default prior.
    var kellyMult = 1.0;
    (function () {
      var R = _cfg.take_profit_ratio;
      if (R <= 1.0) return;   // degenerate config — Kelly undefined

      // Global prior: actual win rate across all closed trades (min 10 to trust it)
      var _allClosed = _trades.filter(function (t) { return t.status === 'CLOSED'; });
      var _globalW = _allClosed.length >= 10
        ? _allClosed.filter(function (t) { return (t.pnl_usd || 0) > 0; }).length / _allClosed.length
        : 0.30;   // conservative prior: 30% until 10 trades close (was 35%).
                  // 30% is still above 2.5R breakeven (28.6%) but sizes trades
                  // ~55% smaller than a 35% prior until the system is proven.
                  // Kelly f ≈ 4% at 30% vs 9% at 35% — meaningful protection.

      // Per-asset prior: if ≥5 trades exist for this asset+direction, use that instead
      var W = _globalW;
      if (window.GII && typeof GII.agentReputations === 'function') {
        try {
          var reps    = GII.agentReputations();
          var assetKey = normaliseAsset(sig.asset);
          var biasKey  = dir === 'LONG' ? 'long' : 'short';
          Object.keys(reps).forEach(function (k) {
            if (k.indexOf(assetKey) !== -1 && k.indexOf(biasKey) !== -1 && reps[k].total >= 5) {
              W = reps[k].winRate;
            }
          });
        } catch (e) {}
      }

      var kelly = (W * R - (1 - W)) / R;
      var baseKelly = Math.max(0.01, (0.5 * R - 0.5) / R);  // BE kelly at 50% win rate
      if (kelly > 0) {
        kellyMult = Math.max(0.5, Math.min(1.5, kelly * 0.5 / baseKelly));
      } else {
        kellyMult = 0.5;   // negative EV → halve position size
      }
    })();

    // v61: per-direction loss streak — long losses don't penalise short sizing
    var _dirKey    = (sig.dir || 'LONG').toLowerCase() === 'short' ? 'short' : 'long';
    var _dirStreak = _lossStreak[_dirKey] || 0;
    var streakMult = _dirStreak >= 3 ? 0.50 : _dirStreak >= 2 ? 0.75 : 1.0;
    if (streakMult < 1.0) {
      // Logged on open so the user can see why size is reduced
    }

    var riskAmt  = _cfg.virtual_balance * _cfg.risk_per_trade_pct / 100 * impactMult * kellyMult * streakMult;
    // Hard cap: prevents compounding from creating unrealistically large positions
    // e.g. at $147k balance, 3% = $4,410 per trade — way more than intended
    if (_cfg.max_risk_usd > 0) riskAmt = Math.min(riskAmt, _cfg.max_risk_usd);

    // Scalper-specific risk cap: scraper/scalper signals are short-timeframe with
    // fast-moving entries — cap them at $15 max to prevent a single BTC scalp
    // from taking a large chunk of the session balance.
    var _isScalperSig = (sig.reason && sig.reason.indexOf('SCALPER') === 0) ||
                        (sig.from  && sig.from.toLowerCase().indexOf('scalp')   !== -1) ||
                        (sig.from  && sig.from.toLowerCase().indexOf('scraper') !== -1);
    var SCALPER_RISK_CAP = 15;  // $15 max per scalp entry
    if (_isScalperSig && riskAmt > SCALPER_RISK_CAP) {
      log('SCALPER', sig.asset + ' scalper risk capped $' + riskAmt.toFixed(2) + ' → $' + SCALPER_RISK_CAP, 'dim');
      riskAmt = SCALPER_RISK_CAP;
    }

    // Crypto volatility discount: BTC/ETH/SOL are 3-5× more volatile than equities/energy.
    // Wide stops (6-7%) mean larger notional positions — cap by halving the risk budget.
    var _cryptoAssets = { 'BTC': true, 'ETH': true, 'SOL': true, 'BNB': true, 'ADA': true };
    if (_cryptoAssets[normaliseAsset(sig.asset)]) {
      var _beforeCrypto = riskAmt;
      riskAmt = riskAmt * 0.50;
      log('RISK', sig.asset + ' crypto size discount: $' + _beforeCrypto.toFixed(2) + ' → $' + riskAmt.toFixed(2) + ' (50% vol cap)', 'dim');
    }
    var slDist   = Math.abs(entryPrice - stopLoss);

    // Risk-of-ruin guard: scale down so total max drawdown stays ≤ 20% of balance
    var maxRiskBudget = _cfg.virtual_balance * 0.20;
    var currentMaxLoss = openTrades().reduce(function (s, t) {
      var td = Math.abs(t.entry_price - t.stop_loss);
      return s + (td > 0 ? t.units * td : 0);
    }, 0);
    var remainingBudget = maxRiskBudget - currentMaxLoss;
    if (remainingBudget < riskAmt) {
      riskAmt = Math.max(0, remainingBudget);   // scale down rather than reject outright
    }

    var units    = (slDist > 0 && riskAmt > 0) ? riskAmt / slDist : 0;
    var sizeUsd  = units * entryPrice;

    // Reality check 6 — leverage validation: if notional exceeds MAX_LEVERAGE × balance,
    // scale units down to the cap. Prevents positions a retail broker would reject.
    if (_cfg.virtual_balance > 0 && sizeUsd / _cfg.virtual_balance > MAX_LEVERAGE) {
      units   = (_cfg.virtual_balance * MAX_LEVERAGE) / entryPrice;
      sizeUsd = units * entryPrice;
      log('AUDIT', '⚠ LEVERAGE: ' + sig.asset + ' capped at ' + MAX_LEVERAGE + '× — units reduced to ' + units.toFixed(4), 'amber');
    }

    // Reality check 7 — reject zero-size positions: risk budget exhausted or SL too wide.
    // Previously these slipped through as phantom trades (units=0) blocking asset slots.
    var MIN_SIZE_USD = 1.0;  // absolute floor — $1 minimum position
    if (units <= 0 || sizeUsd < MIN_SIZE_USD) {
      log('RISK', sig.asset + ' rejected — position too small ($' + sizeUsd.toFixed(2) + '): risk budget exhausted or SL distance too wide', 'amber');
      return null;
    }

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
      region:           sig.region           || 'GLOBAL',
      reason:           sig.reason           || '',
      matched_keywords: sig.matchedKeywords  || [],  // learning loop: keywords that triggered this trade
      source:           sig.source           || _inferSource(sig.reason || ''),
      kelly_mult:       +kellyMult.toFixed(2),       // EV sizing multiplier applied (for display/audit)
      streak_mult:      +streakMult.toFixed(2),      // loss-streak sizing reduction
      // v61: signal metadata for smart partial TP and trailing logic
      signal_conf:  sig.conf  || 0,
      entry_type:   sig.entryType || ((sig.reason || '').toLowerCase().indexOf('breakout') !== -1 ? 'breakout' : 'other'),
      // ── Trailing / break-even / partial TP state ────────────────────────────
      // v61: breakout trades start with trailing active immediately (no need to wait for partial TP)
      trailing_stop_active: !!(_cfg.trailing_stop_enabled &&
        (sig.entryType === 'breakout' || (sig.reason || '').toLowerCase().indexOf('breakout') !== -1)),
      highest_price:        null,    // LONG: tracks peak price for trail
      lowest_price:         null,    // SHORT: tracks trough price for trail
      break_even_done:      false,   // true once stop moved to entry
      partial_tp_taken:     false,   // true once TP1 partial close fired
      partial_tp_price:     null,    // price at which partial was taken
      partial_pnl_usd:      null,    // P&L banked from partial close
      // ────────────────────────────────────────────────────────────────────────
      venue:            sig._venue || 'HL',  // 'HL' | 'ALPACA' — which platform executed
      broker:           _cfg.mode === 'LIVE' ? _cfg.broker : 'SIMULATION',
      // Broker integration stubs — set by adapter on live execution
      broker_order_id:  null,
      broker_status:    null,
      // Entry thesis fingerprint — stored by gii-entry for exit validation
      thesis:           sig.thesis || null,
      // ── Execution Reality Check audit fields ────────────────────────────────
      raw_entry_price:      null,    // pre-slippage mid price (set by openTrade)
      entry_slippage_pct:   null,    // % degradation applied at entry
      open_commission:      0,       // fee deducted at open
      costs_usd:            0,       // total round-trip cost (open + partial + close)
      funding_periods_paid: 0,       // crypto: 8h funding periods already charged
      raw_close_price:      null,    // pre-slippage exit price (TP/SL level)
      // Price source: HYPERLIQUID when HL WS was live at open; SIMULATED when
      // prices came from backend cache / Yahoo / Binance / etc.
      price_source: (window.HLFeed && typeof HLFeed.isAvailable === 'function' &&
                     HLFeed.isAvailable(normaliseAsset(sig.asset)))
                    ? 'HYPERLIQUID' : 'SIMULATED',
      // Intended leverage from gii-routing (1 = no leverage). The actual
      // notional leverage may differ if risk caps were hit — compare with
      // size_usd / virtual_balance in the UI to see the effective leverage.
      leverage:     sig.leverage || 1,
      // Original (pre-routing) asset name if gii-routing remapped it (e.g. GLD→XAU).
      original_asset: sig.original_asset || null
    };
  }

  /* Open a trade: build object, persist, sync HRS, log */
  function openTrade(sig, entryPrice) {
    // Belt-and-suspenders: final same-asset guard before writing to _trades.
    // Catches any path that bypassed canExecute (rotation timing, re-scan race, etc.).
    if (openTrades().some(function (t) { return t.asset === sig.asset; })) {
      log('TRADE', sig.asset + ' openTrade blocked — position already open (final guard)', 'amber');
      return;
    }
    // Reality check 1+2 — realistic fill: adjust raw mid-price for spread + slippage
    var dir = sig.dir === 'SHORT' ? 'SHORT' : 'LONG';
    var adjustedEntry = _adjustedEntryPrice(sig.asset, entryPrice, dir);

    var trade = buildTrade(sig, adjustedEntry);

    // Zero-size guard: risk-of-ruin budget can be exhausted by existing open trades,
    // leaving riskAmt=0 for the next signal. Opening a 0-unit trade is pointless —
    // it costs commission, clutters the log, and never closes. Skip it cleanly.
    if (!trade || trade.units < 0.001) {
      log('TRADE', sig.asset + ' ' + dir + ' skipped — risk budget exhausted by open positions (0 units available)', 'amber');
      return;
    }

    // Store raw (pre-slippage) price for audit display
    trade.raw_entry_price    = +entryPrice.toFixed(6);
    trade.entry_slippage_pct = +((adjustedEntry / entryPrice - 1) * 100).toFixed(4);

    // Reality check 3 — liquidity: block if position would move the market
    if (!_checkLiquidity(sig.asset, trade.size_usd)) return;

    // Reality check 5 — open commission: deduct immediately so it cannot compound
    var openComm = trade.size_usd * _getCosts(sig.asset).commission;
    trade.open_commission = +openComm.toFixed(4);
    trade.costs_usd       = trade.open_commission;
    _cfg.virtual_balance -= openComm;
    saveCfg();

    _trades.unshift(trade);
    _cooldown[sig.asset] = Date.now();
    saveTrades();
    _apiPostTrade(trade);   // async push to SQLite (fire-and-forget)

    // ── Fire Alpaca order if this trade is routed to Alpaca ──────────────
    if (trade.venue === 'ALPACA' && window.AlpacaBroker && AlpacaBroker.isConnected()) {
      var _alpSide = trade.direction === 'LONG' ? 'buy' : 'sell';
      AlpacaBroker.placeOrder(trade.asset, null, _alpSide, { notional: trade.size_usd })
        .then(function (order) {
          trade.broker_order_id = order.id;
          trade.broker_status   = order.status;
          saveTrades();
          log('ALPACA', trade.asset + ' order placed: ' + order.id + ' (' + order.status + ')', 'cyan');
        })
        .catch(function (e) {
          log('ALPACA', '⚠ Order failed for ' + trade.asset + ': ' + e.message, 'amber');
        });
    }

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
      '  (mid ' + _num(trade.raw_entry_price) + '  slip ' + (trade.entry_slippage_pct > 0 ? '+' : '') + trade.entry_slippage_pct + '%)' +
      '  SL:' + _num(trade.stop_loss) +
      '  TP:' + _num(trade.take_profit) +
      '  Conf:' + trade.confidence + '%' +
      '  comm:-$' + _num(trade.open_commission) +
      (trade.streak_mult < 1 ? '  ⚠ streak×' + trade.streak_mult : '') +
      '  [' + (trade.price_source === 'HYPERLIQUID' ? '🟣 HL' : 'SIM') + ']',
      'green');

    renderUI();
    return trade;
  }

  /* Close a trade: compute P&L, update balance, sync HRS, log */
  function closeTrade(tradeId, closePrice, reason) {
    var trade = _trades.find(function (t) { return t.trade_id === tradeId; });
    if (!trade || trade.status !== 'OPEN') return;

    trade.status          = 'CLOSED';
    trade.timestamp_close = new Date().toISOString();
    trade.close_reason    = reason;

    // Reality check 2 — exit slippage: adjust fill price for spread + market-order slippage.
    // TP = limit order (spread only); SL / manual = market order (spread + slippage gap risk).
    var rawClosePrice = parseFloat(closePrice);
    var adjClosePrice = _adjustedExitPrice(trade.asset, rawClosePrice, trade.direction, reason);
    trade.raw_close_price = +rawClosePrice.toFixed(6);
    trade.close_price     = +adjClosePrice.toFixed(6);

    // Guard: invalid entry_price (0, null, NaN) would cause division-by-zero or
    // sign-flip in P&L. Set P&L to 0 and log rather than corrupt the balance.
    if (!trade.entry_price || !isFinite(trade.entry_price) || trade.entry_price <= 0) {
      log('TRADE', trade.asset + ' closeTrade: invalid entry_price (' + trade.entry_price + ') — P&L set to 0', 'amber');
      trade.pnl_pct = 0;
      trade.pnl_usd = 0;
    } else {
      var effClose  = adjClosePrice;
      var rawPnlPct = trade.direction === 'LONG'
        ? (effClose - trade.entry_price) / trade.entry_price * 100
        : (trade.entry_price - effClose) / trade.entry_price * 100;

      trade.pnl_pct = +rawPnlPct.toFixed(2);
      trade.pnl_usd = +(trade.units * Math.abs(effClose - trade.entry_price) * (rawPnlPct >= 0 ? 1 : -1)).toFixed(2);
    }

    // Reality check 5 — close commission: deducted from gross P&L
    var closeComm = (trade.units * adjClosePrice) * _getCosts(trade.asset).commission;
    trade.pnl_usd  = +(trade.pnl_usd - closeComm).toFixed(2);
    trade.costs_usd = +((trade.costs_usd || 0) + closeComm).toFixed(4);

    // NOTE: do NOT subtract funding_cost_usd here.
    // Funding is already deducted from virtual_balance in real-time inside monitorTrades()
    // (balance -= fundingCost each 8h period). Subtracting again here would double-charge
    // the account. The pnl_usd stored on the trade reflects price movement minus commissions;
    // the real-time balance already captures the funding impact separately.

    // Recalculate pnl_pct from the final net pnl_usd (after commission + funding).
    // pnl_pct was set earlier from the raw price move — it doesn't reflect real costs.
    // Avoids the situation where pnl_pct shows +2.5% but pnl_usd shows only +$8 (net fees).
    if (trade.size_usd && trade.size_usd > 0) {
      trade.pnl_pct = +(trade.pnl_usd / trade.size_usd * 100).toFixed(2);
    }

    // Reality check 8 — plausibility: detect wrong-side close prices (price corruption)
    // and cap P&L at theoretical max. Two-tier check:
    //   Tier A (hard): close price moved in wrong direction vs. entry for the given reason.
    //       e.g. LONG+STOP_LOSS close_price > entry_price is impossible — price must fall to hit SL.
    //       Fix: recalculate P&L using the correct SL/TP level.
    //   Tier B (warn): |P&L| > 10× theoretical max even after correct-side check — extreme outlier.
    var isLongClose  = trade.direction === 'LONG';
    var wrongSide    = isLongClose
      ? (reason === 'STOP_LOSS'   && adjClosePrice > trade.entry_price && !trade.trailing_stop_active)   // LONG SL: price must be below entry (unless trailing already in profit)
      || (reason === 'TAKE_PROFIT' && adjClosePrice < trade.entry_price)   // LONG TP: price must be above entry
      : (reason === 'STOP_LOSS'   && adjClosePrice < trade.entry_price && !trade.trailing_stop_active)   // SHORT SL: price must be above entry (unless trailing already in profit)
      || (reason === 'TAKE_PROFIT' && adjClosePrice > trade.entry_price);  // SHORT TP: price must be below entry

    if (wrongSide) {
      // Corrupt price — recalculate using the correct reference level
      var correctRef  = (reason === 'TAKE_PROFIT') ? trade.take_profit : trade.stop_loss;
      var adjCorrect  = _adjustedExitPrice(trade.asset, correctRef, trade.direction, reason);
      var rawPnlCorrect = isLongClose
        ? (adjCorrect - trade.entry_price) / trade.entry_price * 100
        : (trade.entry_price - adjCorrect) / trade.entry_price * 100;
      var correctedPnl = +(trade.units * Math.abs(adjCorrect - trade.entry_price) * (rawPnlCorrect >= 0 ? 1 : -1)).toFixed(2);
      var corrCloseComm = (trade.units * Math.abs(adjCorrect)) * _getCosts(trade.asset).commission;
      correctedPnl = +(correctedPnl - corrCloseComm).toFixed(2);
      log('AUDIT',
        '⚠ PRICE CORRUPTION: ' + trade.asset + ' ' + reason + ' close @ ' + adjClosePrice.toFixed(4) +
        ' is on wrong side of entry ' + trade.entry_price.toFixed(4) +
        ' — P&L corrected from $' + trade.pnl_usd + ' → $' + correctedPnl +
        ' using ' + reason + ' level ' + correctRef.toFixed(4), 'amber');
      trade.close_price    = +adjCorrect.toFixed(6);
      trade.pnl_usd        = correctedPnl;
      trade.pnl_pct        = +rawPnlCorrect.toFixed(2);
      trade.costs_usd      = +((trade.costs_usd || 0) - closeComm + corrCloseComm).toFixed(4);
    } else {
      // Tier B: warn (but don't correct) if P&L still > 10× theoretical max after passing side check
      // (trailing stop can legitimately exceed 2× by riding past original TP, so threshold is 10×)
      // Use original full units (×2 if partial TP has already halved them) for the theoretical max
      // so the check isn't artificially loosened on partial-close trades.
      var fullUnits = trade.partial_tp_taken ? trade.units * 2 : trade.units;
      var theoreticalMax = Math.abs(fullUnits * (trade.take_profit - trade.entry_price));
      if (theoreticalMax > 0 && Math.abs(trade.pnl_usd) > theoreticalMax * 10) {
        log('AUDIT',
          '⚠ PLAUSIBILITY: ' + trade.asset + ' P&L $' + trade.pnl_usd +
          ' is ' + (Math.abs(trade.pnl_usd) / theoreticalMax).toFixed(1) + '× theoretical max $' +
          theoreticalMax.toFixed(2) + ' — check price sources', 'amber');
      }
    }

    // v48 fix: relabel trailing-stop closes that fired in profit.
    // A trailing stop that banked profit should show as 'TRAILING_STOP', not 'STOP_LOSS',
    // so win-rate stats and trade history correctly count it as a win.
    if (reason === 'STOP_LOSS' && trade.trailing_stop_active && trade.pnl_usd > 0) {
      trade.close_reason = 'TRAILING_STOP';
    }

    // Update virtual balance (pnl_usd is net of close commission; open commission already deducted at open)
    _cfg.virtual_balance += trade.pnl_usd;
    saveCfg();
    _recordPnlSnapshot('close:' + reason, trade.pnl_usd);

    // Sync outcome back to Hit Rate Tracker
    if (window.HRS && typeof HRS.signals !== 'undefined') {
      var hrsSig = HRS.signals.find(function (s) { return s.signal_id === trade.signal_id; });
      if (hrsSig) {
        // TP/SL are unambiguous; manual closes within ±$5 of breakeven are neutral
        // (avoids inflating win rate from near-zero P&L manual exits)
        var outcome;
        if (trade.close_reason === 'TAKE_PROFIT' || trade.close_reason === 'TRAILING_STOP') {
          outcome = 'hit';
        } else if (trade.close_reason === 'STOP_LOSS') {
          outcome = 'miss';
        } else {
          var pnlAbs = Math.abs(trade.pnl_usd || 0);
          outcome = pnlAbs < 5 ? 'neutral'
                  : (trade.pnl_usd >= 0) ? 'hit' : 'miss';
        }
        HRS.evaluate(hrsSig.signal_id, outcome, closePrice);
      }
    }

    // ── Close Alpaca position if routed there ────────────────────────────
    if (trade.venue === 'ALPACA' && window.AlpacaBroker && AlpacaBroker.isConnected()) {
      AlpacaBroker.closePosition(trade.asset).catch(function (e) {
        log('ALPACA', '⚠ Close position failed for ' + trade.asset + ': ' + e.message, 'amber');
      });
    }

    saveTrades();
    // Async push updated trade to SQLite (fire-and-forget)
    _apiPatchTrade(trade.trade_id, {
      status:          trade.status,
      close_price:     trade.close_price,
      timestamp_close: trade.timestamp_close,
      close_reason:    trade.close_reason,
      pnl_pct:         trade.pnl_pct,
      pnl_usd:         trade.pnl_usd,
      price_source:    trade.price_source || 'SIMULATED'
    });

    log('CLOSED',
      trade.asset + ' ' + trade.direction +
      ' → ' + reason +
      ' @ ' + _num(trade.close_price) +
      '  (raw ' + _num(trade.raw_close_price) + ')' +
      '  P&L: ' + (trade.pnl_pct >= 0 ? '+' : '') + trade.pnl_pct + '%' +
      '  (' + (trade.pnl_usd >= 0 ? '+$' : '-$') + _num(Math.abs(trade.pnl_usd)) + ' net)' +
      '  costs:-$' + _num(trade.costs_usd),
      trade.pnl_pct >= 0 ? 'green' : 'red');

    // Browser notification for TP/SL hits (only when tab is not visible)
    if ((trade.close_reason === 'TAKE_PROFIT' || trade.close_reason === 'STOP_LOSS' || trade.close_reason === 'TRAILING_STOP') &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted') {
      var isTP   = trade.close_reason === 'TAKE_PROFIT' || trade.close_reason === 'TRAILING_STOP';
      var sign   = trade.pnl_usd >= 0 ? '+' : '-';
      var pnlStr = sign + '$' + _num(Math.abs(trade.pnl_usd)) +
                   ' (' + (trade.pnl_pct >= 0 ? '+' : '') + trade.pnl_pct + '%)';
      try {
        var _ntfLabel = trade.close_reason === 'TAKE_PROFIT' ? '✅ Take Profit'
                      : trade.close_reason === 'TRAILING_STOP' ? '🎯 Trailing Stop'
                      : '❌ Stop Loss';
        new Notification(
          _ntfLabel + ' — ' + trade.asset,
          {
            body: trade.direction + ' closed @ ' + _num(closePrice) + '\nP&L: ' + pnlStr,
            icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="' + (isTP ? '%2300e676' : '%23ff1744') + '"/></svg>',
            tag: 'ee-trade-' + trade.trade_id,
            requireInteraction: false
          }
        );
      } catch (e) { /* notification may fail silently */ }
    }

    // v61: per-direction loss streak (long/short tracked independently)
    var _tradeDir = (trade.direction || 'LONG').toLowerCase() === 'short' ? 'short' : 'long';
    if (trade.pnl_usd > 0) {
      if (_lossStreak[_tradeDir] > 0) log('RISK', _tradeDir.toUpperCase() + ' loss streak ended at ' + _lossStreak[_tradeDir] + ' — full size restored', 'green');
      _lossStreak[_tradeDir] = 0;
    } else {
      _lossStreak[_tradeDir]++;
      if (_lossStreak[_tradeDir] >= 3)      log('RISK', _tradeDir.toUpperCase() + ' streak ' + _lossStreak[_tradeDir] + ' losses — position size halved', 'red');
      else if (_lossStreak[_tradeDir] >= 2) log('RISK', _tradeDir.toUpperCase() + ' streak ' + _lossStreak[_tradeDir] + ' losses — position size at 75%', 'amber');
    }

    renderUI();

    /* Learning loop feedback: notify dashboard of trade outcome */
    if (typeof window.onTradeClose === 'function') window.onTradeClose(trade);
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     SIGNAL LISTENER — called by renderTrades() each IC cycle
     Signature: EE.onSignals(sigs)
     sigs: Array<{ asset, dir, conf, reason, region }>
     ══════════════════════════════════════════════════════════════════════════════ */

  /* Validate a signal object before it enters the execution pipeline.
     Returns { ok: true } or { ok: false, reason: string }.
     Rejects malformed/incomplete signals before they hit canExecute. */
  function validateSignal(sig) {
    if (!sig || typeof sig !== 'object')
      return { ok: false, reason: 'Signal is not an object' };
    if (!sig.asset || typeof sig.asset !== 'string' || sig.asset.trim().length < 1)
      return { ok: false, reason: 'Signal missing valid asset' };
    if (!sig.dir || ['LONG', 'SHORT', 'WATCH'].indexOf(sig.dir) === -1)
      return { ok: false, reason: 'Signal dir must be LONG/SHORT/WATCH, got: ' + sig.dir };
    if (typeof sig.conf !== 'number' || isNaN(sig.conf) || sig.conf < 0 || sig.conf > 100)
      return { ok: false, reason: 'Signal conf must be 0–100, got: ' + sig.conf };
    return { ok: true };
  }

  function onSignals(sigs) {
    if (!sigs || !sigs.length) return;
    _lastSignals = sigs;                 // always cache — re-scan loop needs these

    sigs.forEach(function (sig) {
      // Asset remap: replace untradeable index/spot assets with their tradeable proxies.
      // Mutates a shallow copy so the original signal object is not modified.
      if (sig.asset && ASSET_REMAP[normaliseAsset(sig.asset)]) {
        var remapped = ASSET_REMAP[normaliseAsset(sig.asset)];
        log('SYSTEM', sig.asset + ' remapped → ' + remapped + ' (untradeable asset replaced with proxy)', 'dim');
        sig = Object.assign({}, sig, { asset: remapped });
      }

      // GII Routing: check if there is a better HL instrument (e.g. GLD → XAU)
      // and whether leverage improves EV for this confidence level.
      // Runs after ASSET_REMAP so routing sees the final tradeable asset name.
      if (window.GII_ROUTING && typeof GII_ROUTING.route === 'function') {
        var _routed = GII_ROUTING.route(sig);
        if (_routed !== sig) {
          var _routeNote = (_routed.asset !== sig.asset)
            ? sig.asset + ' → ' + _routed.asset + (_routed.leverage > 1 ? ' ' + _routed.leverage + '×' : '')
            : (_routed.leverage > 1 ? sig.asset + ' ' + _routed.leverage + '× lev' : null);
          if (_routeNote) log('ROUTING', _routeNote, 'purple');
          sig = _routed;
        }
      }

      // Pre-validate signal shape before any further processing
      var valid = validateSignal(sig);
      if (!valid.ok) {
        log('SYSTEM', 'Invalid signal dropped: ' + valid.reason, 'dim');
        return;
      }

      // WATCH signals: log but never execute
      if (sig.dir === 'WATCH') {
        _logSignal(sig, 'WATCH', null);
        return;
      }

      // ── Venue router: HL → Alpaca → flag ────────────────────────────────────
      // Runs before the enabled check so every signal is routed or captured.
      // Priority: HL spot/perp first (lowest cost + fastest execution), then
      // Alpaca for US stocks/ETFs not on HL, else flag for future integration.
      var _asset = normaliseAsset(sig.asset);
      var _venue;
      if (window.HLFeed && HLFeed.covers(_asset)) {
        _venue = 'HL';
      } else if (window.AlpacaBroker && AlpacaBroker.covers(_asset)) {
        _venue = 'ALPACA';
      } else {
        _flagTrade(sig, 'No venue — not on Hyperliquid or Alpaca. Add broker for this asset.');
        _logSignal(sig, 'SKIPPED', 'No venue: ' + sig.asset);
        return;
      }
      sig = Object.assign({}, sig, { _venue: _venue });

      if (!_cfg.enabled) {
        _logSignal(sig, 'SKIPPED', 'Auto-execution paused');
        return;
      }

      var check = canExecute(sig);
      if (!check.ok) {
        _logSignal(sig, 'SKIPPED', check.reason);
        return;
      }

      // All checks passed — acquire pending lock, then fetch price and open
      var _lockKey = normaliseAsset(sig.asset);
      _pendingOpen[_lockKey] = true;
      fetchPrice(sig.asset, function (price) {
        delete _pendingOpen[_lockKey];   // release lock regardless of outcome
        if (!price) {
          // No price available — skip this trade entirely rather than open at
          // a meaningless $100 fallback which would corrupt P&L. The 5-min
          // re-scan loop will retry this signal when a price becomes available.
          _logSignal(sig, 'SKIPPED', 'Price unavailable — will retry');
          log('TRADE', sig.asset + ' skipped: no price feed. Re-scan will retry.', 'amber');
          return;
        }
        // Re-validate after async gap — another signal for same asset may have
        // opened while price was being fetched (fixes duplicate-position race condition)
        var recheck = canExecute(sig);
        if (!recheck.ok) {
          _logSignal(sig, 'SKIPPED', 'post-fetch recheck: ' + recheck.reason);
          return;
        }
        _logSignal(sig, 'TRADED', null);
        openTrade(sig, price);
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     TRADE MONITOR — runs every 30s, checks open trades against live prices
     ══════════════════════════════════════════════════════════════════════════════ */

  function monitorTrades() {
    // Daily loss limit check: if session P&L hits the limit, disable auto-execution
    if (_sessionStartBalance && _cfg.daily_loss_limit_pct > 0 && _cfg.enabled) {
      var sessionLossPct = (_cfg.virtual_balance - _sessionStartBalance) / _sessionStartBalance * 100;
      if (sessionLossPct < -_cfg.daily_loss_limit_pct) {
        _cfg.enabled = false;
        saveCfg();
        log('RISK', 'Daily loss limit -' + _cfg.daily_loss_limit_pct + '% reached (' +
          sessionLossPct.toFixed(1) + '%) — no new trades until tomorrow', 'red');
        _notify('⚠ Daily Loss Limit Hit',
          'Session P&L: ' + sessionLossPct.toFixed(1) + '% — paused for new entries. Existing trades run to TP/SL.',
          'ee-daily-limit');
        // Existing open trades are left to run to their natural TP/SL —
        // force-closing mid-trade locks in losses and can turn recoverable
        // drawdowns into confirmed ones. The stop-loss on each trade IS the
        // real risk-management tool.
        renderUI();
      }
    }

    // Zombie position cleanup: cancel any open trade with $0 size that has been
    // sitting for >5 minutes. These are phantom positions (price feed failed at open)
    // that occupy slots and block real signals but contribute nothing.
    var _zombieMs = 5 * 60 * 1000;
    openTrades().forEach(function (zt) {
      if ((zt.size_usd === 0 || !zt.size_usd) && zt.units === 0) {
        var ageMs = Date.now() - new Date(zt.timestamp_open || 0).getTime();
        if (ageMs > _zombieMs) {
          log('TRADE', 'Zombie position cancelled: ' + zt.asset + ' (size=$0, age=' +
            Math.round(ageMs / 60000) + 'min)', 'amber');
          closeTrade(zt.trade_id, zt.entry_price || 0, 'ZOMBIE-CANCEL');
        }
      }
    });

    openTrades().forEach(function (trade) {
      fetchPrice(trade.asset, function (price) {
        // Use cached price as display fallback so unrealised P&L always renders
        var displayPrice = price || _priceCache[normaliseAsset(trade.asset)] || null;
        if (displayPrice) _livePrice[trade.trade_id] = displayPrice;
        if (!price) { renderUI(); return; }  // no live price — skip TP/SL checks

        _livePrice[trade.trade_id] = price;
        var saved = false;  // track if we need to saveTrades() this cycle

        var isLong  = trade.direction === 'LONG';
        var isShort = trade.direction === 'SHORT';

        // ── Partial TP1: dynamic fraction based on signal confidence ────────
        // v61: high-conf breakouts skip partial TP to capture full move;
        //      lower-conf / mean-reversion trades take 50% early as protection.
        var _sconf       = trade.signal_conf || 65;
        var _skipPartial = _sconf >= 75 && trade.entry_type === 'breakout';
        var _partialFrac = _sconf >= 70 ? 0.25 : 0.50;
        if (_cfg.partial_tp_enabled && !trade.partial_tp_taken && !_skipPartial) {
          var tp1 = isLong
            ? trade.entry_price + 0.5 * (trade.take_profit - trade.entry_price)
            : trade.entry_price - 0.5 * (trade.entry_price - trade.take_profit);
          var hitTP1 = isLong ? (price >= tp1) : (price <= tp1);
          if (hitTP1) {
            var closedUnits  = trade.units * _partialFrac;
            // Use tp1 price (not current price) so partial P&L is always capped at 1×R.
            var partialClosePrice = isLong ? Math.min(price, tp1) : Math.max(price, tp1);
            // Reality check 2 — apply limit-order exit slippage (spread only, no market slippage)
            var adjPartialClose = _adjustedExitPrice(trade.asset, partialClosePrice, trade.direction, 'TAKE_PROFIT');
            var pnlPerUnit   = isLong ? (adjPartialClose - trade.entry_price) : (trade.entry_price - adjPartialClose);
            var partialPnl   = +(closedUnits * pnlPerUnit).toFixed(2);
            // Reality check 5 — deduct commission on partial close
            var partialComm = (closedUnits * adjPartialClose) * _getCosts(trade.asset).commission;
            partialPnl = +(partialPnl - partialComm).toFixed(2);
            trade.partial_tp_taken  = true;
            trade.partial_tp_price  = +adjPartialClose.toFixed(6);
            trade.partial_pnl_usd   = partialPnl;
            trade.costs_usd         = +((trade.costs_usd || 0) + partialComm).toFixed(4);
            trade.units             = +(trade.units * (1 - _partialFrac)).toFixed(6);
            trade.size_usd          = +(trade.units * trade.entry_price).toFixed(2); // v48 fix: use entry price, not live price
            // Move stop to entry + round-trip exit cost (break-even) — v53: cost-based, not hardcoded
            var _beCosts = _getCosts(trade.asset);
            var _beBuf   = _beCosts.commission + _beCosts.spread * 0.5 + (_beCosts.slippage || 0);
            var beStop = isLong
              ? +(trade.entry_price * (1 + _beBuf)).toFixed(6)
              : +(trade.entry_price * (1 - _beBuf)).toFixed(6);
            trade.stop_loss        = beStop;
            trade.break_even_done  = true;
            trade.trailing_stop_active = true;
            // Bank partial P&L into balance (net of commission)
            _cfg.virtual_balance  += partialPnl;
            saveCfg();
            saved = true;
            log('PARTIAL',
              trade.asset + ' ' + Math.round(_partialFrac * 100) + '% TP @ ' + _num(adjPartialClose) +
              '  Banked: ' + (partialPnl >= 0 ? '+' : '') + '$' + _num(partialPnl) +
              '  comm:-$' + _num(partialComm) +
              '  SL→breakeven', 'green');
            _notify('🎯 Partial TP — ' + trade.asset,
              Math.round(_partialFrac * 100) + '% closed @ ' + _num(adjPartialClose) + ' (+$' + _num(partialPnl) + ' net)\nStop moved to break-even.',
              'ee-partial-' + trade.trade_id);
          }
        }

        // ── Break-even stop: move stop to entry once 50% to TP ──────────────
        if (_cfg.break_even_enabled && !trade.break_even_done && !trade.partial_tp_taken) {
          var halfDist = isLong
            ? 0.5 * (trade.take_profit - trade.entry_price)
            : 0.5 * (trade.entry_price - trade.take_profit);
          var beTrigger = isLong
            ? trade.entry_price + halfDist
            : trade.entry_price - halfDist;
          var hitBE = isLong ? (price >= beTrigger) : (price <= beTrigger);
          if (hitBE) {
            var _beCosts2 = _getCosts(trade.asset);
            var _beBuf2   = _beCosts2.commission + _beCosts2.spread * 0.5 + (_beCosts2.slippage || 0);
            var newBEStop = isLong
              ? +(trade.entry_price * (1 + _beBuf2)).toFixed(6)
              : +(trade.entry_price * (1 - _beBuf2)).toFixed(6);
            if ((isLong && newBEStop > trade.stop_loss) ||
                (isShort && newBEStop < trade.stop_loss)) {
              trade.stop_loss           = newBEStop;
              trade.break_even_done     = true;
              trade.trailing_stop_active = true;
              saved = true;
              log('TRAIL', trade.asset + ' break-even stop @ ' + _num(newBEStop), 'amber');
              _notify('🔒 Break-Even — ' + trade.asset,
                'Stop moved to entry price. Trade is now risk-free.',
                'ee-be-' + trade.trade_id);
            }
          }
        }

        // ── Trailing stop: once active, trail price by trailing_stop_pct ────
        // Guard: skip if the TP level has already been reached this cycle.
        // Without this, a SHORT's trailing stop can be clamped to trade.take_profit
        // and then immediately trigger hitSL (price >= stop_loss == take_profit),
        // closing a profitable trade as STOP_LOSS instead of TAKE_PROFIT.
        // Checking TP first and skipping the trail update avoids the race entirely.
        var _tpAlreadyHit = isLong ? price >= trade.take_profit : price <= trade.take_profit;
        if (_cfg.trailing_stop_enabled && trade.trailing_stop_active && !_tpAlreadyHit) {
          var trailDist = trade.entry_price * (_cfg.trailing_stop_pct / 100);
          if (isLong) {
            var newHigh = Math.max(price, trade.highest_price || price);
            trade.highest_price = newHigh;
            var trailedStop = +(newHigh - trailDist).toFixed(6);
            // Symmetric TP clamp for LONG: trail must not exceed TP (mirrors SHORT clamp below)
            if (trade.take_profit && trailedStop > trade.take_profit) trailedStop = +trade.take_profit.toFixed(6);
            if (trailedStop > trade.stop_loss) {
              trade.stop_loss = trailedStop;
              saved = true;
            }
          } else {
            var newLow = Math.min(price, trade.lowest_price || price);
            trade.lowest_price = newLow;
            var trailedStopS = +(newLow + trailDist).toFixed(6);
            // Clamp: trailing SL for SHORT must not go below the TP level.
            // If SL went below TP, price could skip past TP in one monitoring cycle
            // and close as STOP_LOSS instead of TAKE_PROFIT, garbling the close reason
            // and bypassing the correct TP-level P&L calculation.
            if (trailedStopS < trade.take_profit) trailedStopS = +trade.take_profit.toFixed(6);
            if (trailedStopS < trade.stop_loss) {
              trade.stop_loss = trailedStopS;
              saved = true;
            }
          }
        }

        if (saved) saveTrades();

        // Reality check 4 — minimum hold time: trades cannot open and close within
        // the same monitor cycle. Prevents unrealistic instant fills in fast moves.
        var tradeAgeMs = Date.now() - new Date(trade.timestamp_open).getTime();
        if (tradeAgeMs < MIN_HOLD_MS) {
          renderUI();
          return;
        }

        // Reality check 4b — maximum hold time: auto-expire stale trades.
        // Geopolitical trades go stale after ~7 days; scalper trades after 6h.
        // If exit signals haven't fired by then, the trade is a zombie — close it.
        var _isScalperTrade = trade.source === 'scalper' || trade.source === 'scalper-session';
        var _maxHoldMs = _isScalperTrade ? MAX_HOLD_MS_SCALPER : MAX_HOLD_MS_GEO;
        if (tradeAgeMs > _maxHoldMs) {
          var _expiredHrs = Math.round(tradeAgeMs / 3600000);
          log('TRADE', trade.asset + ' ' + trade.direction + ' auto-expired after ' +
            _expiredHrs + 'h (max=' + (_maxHoldMs / 3600000) + 'h)', 'amber');
          closeTrade(trade.trade_id, _getPrice(trade.asset) || trade.entry_price, 'MAX-HOLD-EXPIRED');
          return;
        }

        // Reality check 5 — crypto funding rate: deducted every 8 hours.
        // Simulates perpetual swap funding charged on leveraged crypto positions.
        var tradeCosts = _getCosts(trade.asset);
        if (tradeCosts.funding8h > 0) {
          var ageHours        = tradeAgeMs / 3600000;
          var fundingDue      = Math.floor(ageHours / 8);
          var fundingPaid     = trade.funding_periods_paid || 0;
          if (fundingDue > fundingPaid) {
            var fundingCost = trade.size_usd * tradeCosts.funding8h * (fundingDue - fundingPaid);
            trade.funding_periods_paid = fundingDue;
            trade.costs_usd = +((trade.costs_usd || 0) + fundingCost).toFixed(4);
            // Track running funding deduction on the trade itself so win/loss stats
            // reflect actual net P&L (not just price movement minus entry commission).
            trade.funding_cost_usd = +((trade.funding_cost_usd || 0) + fundingCost).toFixed(4);
            _cfg.virtual_balance -= fundingCost;
            saveCfg();
            saved = true;
            log('COST', trade.asset + ' funding ×' + (fundingDue - fundingPaid) +
              ' periods  -$' + _num(fundingCost), 'dim');
          }
        }

        // ── TP / SL checks (with updated stop) ──────────────────────────────
        var hitTP, hitSL;
        if (isLong) {
          hitTP = price >= trade.take_profit;
          hitSL = price <= trade.stop_loss;
        } else {
          hitTP = price <= trade.take_profit;
          hitSL = price >= trade.stop_loss;
        }

        if (hitTP)      closeTrade(trade.trade_id, trade.take_profit, 'TAKE_PROFIT');
        else if (hitSL) closeTrade(trade.trade_id, trade.stop_loss,   'STOP_LOSS');
        else            renderUI();
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
  }

  /* ── Binance WebSocket — real-time BTC price (no API key needed) ────────────── */
  function _startBinanceWS() {
    if (_wsConnected || typeof WebSocket === 'undefined') return;
    try {
      var ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@miniTicker');
      ws.onmessage = function (evt) {
        try {
          var data = JSON.parse(evt.data);
          var price = parseFloat(data.c);   // close price of miniTicker
          if (price > 0) {
            // HL-Feed is higher priority for BTC. If HL has a fresh price, record
            // Binance as healthy (it's still streaming) but don't overwrite HL's price.
            _priceFeedHealth['binance'] = { ok: true, lastOk: Date.now(),
              lastFail: (_priceFeedHealth['binance'] || {}).lastFail || null };
            if (window.HLFeed && typeof HLFeed.isAvailable === 'function' &&
                HLFeed.isAvailable('BTC')) {
              return;   // HL has fresh BTC — Binance is warm fallback only
            }
            _cacheSet('BTC', price);
            _cacheSet('BITCOIN', price);
            // Push real-time price to all open BTC trades so P&L updates without polling
            _trades.forEach(function (t) {
              if (t.status === 'OPEN' && normaliseAsset(t.asset) === 'BTC') {
                _livePrice[t.trade_id] = price;
              }
            });
          }
        } catch (e) {}
      };
      ws.onopen  = function () {
        _wsConnected = true;
        log('SYSTEM', 'Binance WebSocket connected — BTC fallback feed active (yields to HL when live)', 'dim');
      };
      ws.onclose = function () {
        _wsConnected = false;
        setTimeout(_startBinanceWS, 10000);  // reconnect after 10 s
      };
      ws.onerror = function () { _wsConnected = false; };
      _wsBtcWs = ws;
    } catch (e) {
      log('SYSTEM', 'BTC WebSocket unavailable: ' + (e.message || String(e)), 'dim');
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     ACTIVITY LOG
     ══════════════════════════════════════════════════════════════════════════════ */

  function log(action, msg, colour) {
    _log.unshift({ ts: new Date().toISOString(), action: action, msg: msg, colour: colour || 'dim' });
    if (_log.length > 200) _log.length = 200;   // v60: raised cap to 200; trim in-place
    var el = document.getElementById('eeActivityLog');
    if (el) renderLog(el);
  }

  /* ── Browser notification helper (respects existing permission) ─────────────── */
  function _notify(title, body, tag) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try { new Notification(title, { body: body, tag: tag || ('ee-' + Date.now()), requireInteraction: false }); }
    catch (e) { /* silent */ }
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     UI RENDERING
     ══════════════════════════════════════════════════════════════════════════════ */

  function renderUI() {
    renderStatusBar();
    renderPortfolioSummary();
    renderConfigFields();
    renderOpenTrades();
    renderClosedTrades();
    _renderFlaggedTrades();
    var el = document.getElementById('eeActivityLog');
    if (el) renderLog(el);
    // Show/hide live mode warning
    var warn = document.getElementById('eeLiveWarning');
    if (warn) warn.classList.toggle('show', _cfg.mode === 'LIVE');
    // Refresh strategy analytics panel
    renderAnalytics();
    // Refresh signal history + risk simulator
    renderSigLog();
    renderSim();
    renderPriceFeedHealth();
    renderPortfolioWatchlist();
  }

  function renderPortfolioSummary() {
    var el = document.getElementById('eePortfolioSummary');
    if (!el) return;

    // Realised P&L from all closed trades this session
    var sessionTs = _sessionStart ? new Date(_sessionStart).getTime() : 0;
    var closed = _trades.filter(function (t) { return t.status === 'CLOSED'; });
    var sessionClosed = closed.filter(function (t) {
      return t.timestamp_close && new Date(t.timestamp_close).getTime() >= sessionTs;
    });
    var realisedPnl = sessionClosed.reduce(function (s, t) { return s + (t.pnl_usd || 0) + (t.partial_pnl_usd || 0); }, 0);

    // Unrealised P&L from open trades using live prices
    var unrealisedPnl = 0;
    openTrades().forEach(function (t) {
      var px = _livePrice[t.trade_id] || _priceCache[normaliseAsset(t.asset)] || null;
      if (!px) return;
      var diff = t.direction === 'LONG' ? (px - t.entry_price) : (t.entry_price - px);
      unrealisedPnl += t.units * diff;
    });

    // Use actual session-start balance, not the hardcoded DEFAULTS constant.
    // _sessionStartBalance is set at init time from the live virtual_balance config.
    var startBalance = _sessionStartBalance || DEFAULTS.virtual_balance;
    var totalPnl     = realisedPnl + unrealisedPnl;
    var returnPct    = startBalance > 0 ? (totalPnl / startBalance * 100) : 0;
    var retCol       = returnPct >= 0 ? '#00c8a0' : '#ff4444';
    var uCol         = unrealisedPnl >= 0 ? '#00c8a0' : '#ff4444';
    var rCol         = realisedPnl   >= 0 ? '#00c8a0' : '#ff4444';

    // Session duration
    var sessionAge = '';
    if (_sessionStart) {
      var mins = Math.floor((Date.now() - new Date(_sessionStart).getTime()) / 60000);
      sessionAge = mins < 60
        ? mins + 'm'
        : Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
    }

    el.innerHTML =
      '<div class="ee-psb-item">' +
        '<span class="ee-psb-label">Balance</span>' +
        '<span class="ee-psb-val">' +
          '<b style="color:var(--bright)">$' + _num(_cfg.virtual_balance) + '</b>' +
        '</span>' +
      '</div>' +
      '<div class="ee-psb-item">' +
        '<span class="ee-psb-label">Unrealised</span>' +
        '<span class="ee-psb-val" style="color:' + uCol + '">' +
          (unrealisedPnl >= 0 ? '+' : '') + '$' + _num(Math.abs(unrealisedPnl)) +
        '</span>' +
      '</div>' +
      '<div class="ee-psb-item">' +
        '<span class="ee-psb-label">Realised</span>' +
        '<span class="ee-psb-val" style="color:' + rCol + '">' +
          (realisedPnl >= 0 ? '+' : '-') + '$' + _num(Math.abs(realisedPnl)) +
        '</span>' +
      '</div>' +
      '<div class="ee-psb-item">' +
        '<span class="ee-psb-label">Session Return</span>' +
        '<span class="ee-psb-val" style="color:' + retCol + ';font-weight:700">' +
          (returnPct >= 0 ? '+' : '') + returnPct.toFixed(2) + '%' +
        '</span>' +
      '</div>' +
      '<div class="ee-psb-item ee-psb-session">' +
        '<span class="ee-psb-label">Session started</span>' +
        '<span class="ee-psb-val" style="color:var(--dim)">' +
          (_sessionStart ? new Date(_sessionStart).toUTCString().replace(' GMT','') : '—') +
          (sessionAge ? ' (' + sessionAge + ' ago)' : '') +
        '</span>' +
      '</div>';
  }

  function renderPriceFeedHealth() {
    var el = document.getElementById('eePriceFeedHealth');
    if (!el) return;
    var sources = [
      { name: 'Hyperliquid',key: 'hl'         },   // highest-priority WS feed
      { name: 'Backend',    key: 'backend'    },
      { name: 'Binance',    key: 'binance'    },
      { name: 'Yahoo',      key: 'yahoo'      },
      { name: 'CoinGecko',  key: 'coingecko'  },
      { name: 'Frankfurter',key: 'frankfurter'}
    ];
    el.innerHTML = '<span style="color:var(--dim);font-size:9px;margin-right:6px">Price feeds:</span>' +
      sources.map(function (s) {
        var h   = _priceFeedHealth[s.key];
        var ok  = h && h.ok;
        var age = h && h.lastOk ? Math.floor((Date.now() - h.lastOk) / 60000) : null;
        var dot = ok ? '#00c8a0' : (h ? '#ff4444' : '#555');
        var tip = ok ? (age !== null ? s.name + ' OK (' + age + 'm ago)' : s.name + ' OK')
                     : (h ? s.name + ' failing' : s.name + ' untested');
        return '<span title="' + tip + '" style="font-size:9px;margin-right:8px">' +
               '<span style="color:' + dot + '">●</span> ' +
               '<span style="color:var(--dim)">' + s.name + '</span></span>';
      }).join('');
  }

  function renderStatusBar() {
    var open   = openTrades();
    var closed = _trades.filter(function (t) { return t.status === 'CLOSED'; });
    var wins   = closed.filter(function (t) { return t.close_reason === 'TAKE_PROFIT' || t.close_reason === 'TRAILING_STOP'; });
    // Use balance growth as P&L — this always reconciles with the displayed balance
    // and captures partial TP credits that pnl_usd alone misses.
    var totPnl = _cfg.virtual_balance - DEFAULTS.virtual_balance;
    var rate   = closed.length ? Math.round(wins.length / closed.length * 100) : null;

    var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
    set('eeBadgeMode',    _cfg.mode);
    set('eeBadgeEnabled', _cfg.enabled ? 'AUTO ON' : 'AUTO OFF');
    set('eeBadgeBalance', '$' + _num(_cfg.virtual_balance));
    set('eeBadgeOpen',    open.length + ' OPEN');
    set('eeBadgePnl',     (totPnl >= 0 ? '+$' : '-$') + _num(Math.abs(totPnl)) + ' P&L');
    set('eeBadgeRate',    rate !== null ? rate + '% WIN' : '— WIN');
    set('eeOpenCount',    open.length);

    // Data safety banner: show until there are closed trades on record
    var banner = document.getElementById('eeDataSafetyBanner');
    if (banner) banner.style.display = closed.length === 0 ? 'block' : 'none';

    // Backend offline warning banner
    var backendBanner = document.getElementById('eeBackendBanner');
    if (backendBanner) {
      if (!_apiOnline && _backendChecked) {
        backendBanner.style.display = 'flex';
        // Show how long backend has been offline (last check time)
        var bfh = _priceFeedHealth['backend'];
        if (bfh && bfh.lastFail) {
          var offSec = Math.round((Date.now() - bfh.lastFail) / 1000);
          var offStr = offSec < 60 ? offSec + 's' : Math.round(offSec / 60) + 'm';
          var timerEl = document.getElementById('eeBackendRetryTimer');
          if (timerEl) timerEl.textContent = 'Offline ' + offStr;
        }
      } else {
        backendBanner.style.display = 'none';
      }
    }

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
                  'take_profit_ratio','max_open_trades','max_per_region','max_per_sector',
                  'virtual_balance','max_risk_usd','trailing_stop_pct','daily_loss_limit_pct','event_gate_hours'];
    fields.forEach(function (f) {
      var el = document.getElementById('eeCfg_' + f);
      if (el && document.activeElement !== el) el.value = _cfg[f];
    });
    // Sync checkbox toggles
    var toggles = ['trailing_stop_enabled','break_even_enabled','partial_tp_enabled','event_gate_enabled'];
    toggles.forEach(function (f) {
      var el = document.getElementById('eeCfg_' + f);
      if (el) el.checked = !!_cfg[f];
    });
    // Streak indicator
    var streakEl = document.getElementById('eeStreakBadge');
    if (streakEl) {
      var _totalStreak = (_lossStreak.long || 0) + (_lossStreak.short || 0);
      var _maxStreak   = Math.max(_lossStreak.long || 0, _lossStreak.short || 0);
      if (_totalStreak === 0) {
        streakEl.textContent = '';
        streakEl.style.display = 'none';
      } else {
        streakEl.style.display = 'inline';
        var streakParts = [];
        if (_lossStreak.long  > 0) streakParts.push('L×' + _lossStreak.long);
        if (_lossStreak.short > 0) streakParts.push('S×' + _lossStreak.short);
        var mult = _maxStreak >= 3 ? '½ size' : '¾ size';
        streakEl.textContent = '⚠ ' + streakParts.join(' ') + ' — ' + mult;
        streakEl.style.color = _maxStreak >= 3 ? 'var(--red)' : 'var(--amber)';
      }
    }
    // WebSocket status
    var wsEl = document.getElementById('eeWsBadge');
    if (wsEl) {
      wsEl.textContent = _wsConnected ? '⚡ WS BTC' : '· WS off';
      wsEl.style.color = _wsConnected ? 'var(--green)' : 'var(--dim)';
    }
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
      var dirCls  = t.direction === 'LONG' ? 'ee-dir-long' : 'ee-dir-short';
      // Prefer freshly-polled price → price cache → on-page ticker scrape
      var _tok = normaliseAsset(t.asset);
      var livePx = _livePrice[t.trade_id] || _priceCache[_tok] || _tickerPrice(_tok) || null;

      // Unrealised P&L row — always rendered; shows placeholder if price unavailable
      var liveRow = '';
      if (livePx && t.entry_price && t.entry_price > 0) {
        var uPct = t.direction === 'LONG'
          ? (livePx - t.entry_price) / t.entry_price * 100
          : (t.entry_price - livePx) / t.entry_price * 100;
        var uUsd = t.units * Math.abs(livePx - t.entry_price) * (uPct >= 0 ? 1 : -1);
        var uCol = uPct >= 0 ? '#00c8a0' : '#ff4444';
        // Distance to SL and TP as % of entry
        var slDist = t.stop_loss   ? Math.abs(livePx - t.stop_loss)   / t.entry_price * 100 : null;
        var tpDist = t.take_profit ? Math.abs(t.take_profit - livePx) / t.entry_price * 100 : null;
        liveRow =
          '<div style="font-size:9px;margin:5px 0 0 0;padding-top:5px;border-top:1px solid rgba(255,255,255,0.07)">' +
            'Live: <b style="color:var(--text)">$' + _num(livePx) + '</b>' +
            '&nbsp;&nbsp;Unrealised: ' +
            '<b style="color:' + uCol + '">' +
              (uPct >= 0 ? '+' : '') + uPct.toFixed(2) + '%&thinsp;' +
              '(' + (uUsd >= 0 ? '+$' : '-$') + _num(Math.abs(uUsd)) + ')' +
            '</b>' +
            (slDist !== null || tpDist !== null
              ? '&nbsp;&nbsp;<span style="color:var(--dim)">' +
                  (slDist !== null ? 'SL&nbsp;' + slDist.toFixed(1) + '% away' : '') +
                  (slDist !== null && tpDist !== null ? '&nbsp;·&nbsp;' : '') +
                  (tpDist !== null ? 'TP&nbsp;' + tpDist.toFixed(1) + '% away' : '') +
                '</span>'
              : '') +
          '</div>';
      } else {
        liveRow =
          '<div style="font-size:9px;margin:5px 0 0 0;padding-top:5px;border-top:1px solid rgba(255,255,255,0.07);color:var(--dim)">' +
            'Unrealised P&amp;L: <span style="color:#888">awaiting price feed&hellip;</span>' +
          '</div>';
      }

      var venueBadge = t.venue === 'ALPACA'
        ? '<span style="font-size:7px;padding:1px 4px;border-radius:2px;background:#1a2a4a;color:#4da6ff;margin-left:4px;letter-spacing:0.5px">ALPACA</span>'
        : '<span style="font-size:7px;padding:1px 4px;border-radius:2px;background:#1a1a3a;color:#a78bfa;margin-left:4px;letter-spacing:0.5px">HL</span>';
      return '<div class="ee-trade-card">' +
        '<div class="ee-tc-hdr">' +
          '<span class="' + dirCls + '">' + t.direction + '</span>' +
          '<span class="ee-tc-asset">' + _esc(t.asset) + '</span>' +
          venueBadge +
          '<span class="ee-tc-conf">' + t.confidence + '%</span>' +
          '<span class="ee-tc-age">' + _age(t.timestamp_open) + '</span>' +
          '<span class="ee-tc-mode ' + (t.mode === 'LIVE' ? 'live' : 'sim') + '">' + t.mode + '</span>' +
        '</div>' +
        '<div class="ee-tc-prices">' +
          'Entry: <b>' + _num(t.entry_price) + '</b>' +
          ' &nbsp; <span class="ee-tc-sl">SL: ' + _num(t.stop_loss) + '</span>' +
          ' &nbsp; <span class="ee-tc-tp">TP: ' + _num(t.take_profit) + '</span>' +
          ' &nbsp; Size: $' + _num(t.size_usd) +
          ' &nbsp; <span style="color:#e040fb">Lev: ' + (t.size_usd > 0 ? (t.size_usd / _cfg.virtual_balance).toFixed(2) : '—') + '×</span>' +
          liveRow +
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

    // Session filter: only show trades closed after session start
    var sessionTs = _sessionStart ? new Date(_sessionStart).getTime() : 0;
    var allClosed = _trades.filter(function (t) {
      if (t.status !== 'CLOSED') return false;
      if (_closedSessionOnly && sessionTs) {
        var closeTs = t.timestamp_close ? new Date(t.timestamp_close).getTime() : 0;
        return closeTs >= sessionTs;
      }
      return true;
    });

    // Update toggle button label
    var btn = document.getElementById('eeClosedSessionBtn');
    if (btn) {
      btn.textContent = _closedSessionOnly ? 'All Time' : 'This Session';
      btn.style.color = _closedSessionOnly ? 'var(--green, #00e676)' : 'var(--dim)';
      btn.style.borderColor = _closedSessionOnly ? 'var(--green, #00e676)' : 'var(--dim)';
    }

    var closed    = _showAllClosed ? allClosed : allClosed.slice(0, 25);

    if (!allClosed.length) {
      // Show open trades as context instead of a blank panel
      var open = _trades.filter(function (t) { return t.status === 'OPEN'; });
      if (open.length) {
        el.innerHTML = '<div class="ee-placeholder" style="margin-bottom:6px">No closed trades yet — ' + open.length + ' position(s) open.</div>'
          + open.map(function (t) {
            return '<div class="ee-closed-row" style="opacity:0.6">'
              + '<span class="ee-cr-reason" style="color:var(--amber)">●</span>'
              + '<span class="ee-cr-asset">' + _esc(t.asset) + '</span>'
              + '<span class="ee-cr-dir ' + t.direction.toLowerCase() + '">' + t.direction + '</span>'
              + '<span class="ee-cr-pnl" style="color:var(--amber)">OPEN</span>'
              + '<span class="ee-cr-ts">' + _age(t.timestamp_open) + '</span>'
            + '</div>';
          }).join('');
      } else {
        el.innerHTML = '<div class="ee-placeholder">No closed trades yet.</div>';
      }
      return;
    }

    var rows = closed.map(function (t) {
      var pc  = t.pnl_pct || 0;
      var pu  = t.pnl_usd || 0;
      var cls = pc >= 0 ? 'pos' : 'neg';
      var icon    = (t.close_reason === 'TAKE_PROFIT' || t.close_reason === 'TRAILING_STOP') ? '\u2713' : t.close_reason === 'STOP_LOSS' ? '\u2717' : '\u2014';
      var iconCls = (t.close_reason === 'TAKE_PROFIT' || t.close_reason === 'TRAILING_STOP') ? 'tp' : 'sl';
      return '<div class="ee-closed-row">' +
        '<span class="ee-cr-reason ' + iconCls + '">' + icon + '</span>' +
        '<span class="ee-cr-asset">' + _esc(t.asset) + '</span>' +
        '<span class="ee-cr-dir ' + t.direction.toLowerCase() + '">' + t.direction + '</span>' +
        '<span class="ee-cr-pnl ' + cls + '">' + (pc >= 0 ? '+' : '') + pc + '%</span>' +
        '<span class="ee-cr-usd ' + cls + '">' + (pu >= 0 ? '+$' : '-$') + _num(Math.abs(pu)) + '</span>' +
        '<span class="ee-cr-ts">' + _age(t.timestamp_open) + '</span>' +
      '</div>';
    }).join('');

    // Show-all toggle when there are more than 25 closed trades
    var toggleBtn = '';
    if (allClosed.length > 25) {
      var label = _showAllClosed
        ? '&#9650; Show recent 25'
        : '&#9660; Show all ' + allClosed.length + ' trades';
      toggleBtn = '<div style="text-align:center;margin-top:6px">' +
        '<button onclick="EE.toggleAllClosed()" style="background:none;border:1px solid var(--dim);color:var(--dim);font-family:inherit;font-size:10px;padding:2px 10px;cursor:pointer;letter-spacing:1px">' +
        label + '</button></div>';
    }

    el.innerHTML = rows + toggleBtn;
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

  /* ── Signal History Log ─────────────────────────────────────────────────────── */

  var _sigLogSessionOnly = false; // toggle: show this session's signals only

  function renderSigLog() {
    var el = document.getElementById('eeSigLog');
    if (!el) return;

    // Session filter
    var sessionTs  = _sessionStart ? new Date(_sessionStart).getTime() : 0;
    var logs = _sigLogSessionOnly
      ? _signalLog.filter(function (e) { return new Date(e.ts).getTime() >= sessionTs; })
      : _signalLog;

    // Update toggle button label
    var btn = document.getElementById('eeSigLogSessionBtn');
    if (btn) btn.textContent = _sigLogSessionOnly ? 'All Signals' : 'This Session';

    if (!logs.length) {
      el.innerHTML = '<div class="ee-placeholder">' +
        (_sigLogSessionOnly ? 'No signals this session yet.' : 'No signals seen yet — waiting for IC cycle.') +
        '</div>';
      return;
    }
    el.innerHTML = logs.slice(0, 50).map(function (e) {
      var d   = new Date(e.ts);
      var ts  = String(d.getMonth()+1).padStart(2,'0') + '/' +
                String(d.getDate()).padStart(2,'0') + ' ' +
                String(d.getHours()).padStart(2,'0') + ':' +
                String(d.getMinutes()).padStart(2,'0');
      var actionCls = e.action === 'TRADED' ? 'sl-act-traded'
                    : e.action === 'WATCH'  ? 'sl-act-watch'
                    : 'sl-act-skipped';
      var actionLbl = e.action === 'TRADED' ? '&#10003; TRADED'
                    : e.action === 'WATCH'  ? '&#9900; WATCH'
                    : '&#8212; SKIP';
      var dirCls  = e.dir === 'LONG' ? 'sl-long' : e.dir === 'SHORT' ? 'sl-short' : 'sl-watch-dir';
      var skipHtml = e.skip_reason
        ? '<span class="sl-skip-reason">' + _esc(e.skip_reason) + '</span>'
        : '';
      return '<div class="ee-sl-row">' +
        '<span class="ee-sl-ts">'  + ts + '</span>' +
        '<span class="ee-sl-asset">' + _esc(e.asset) + '</span>' +
        '<span class="ee-sl-dir ' + dirCls + '">' + _esc(e.dir) + '</span>' +
        '<span class="ee-sl-conf">' + e.conf + '%</span>' +
        '<span class="ee-sl-act ' + actionCls + '">' + actionLbl + '</span>' +
        '<span class="ee-sl-region">' + _esc(e.region) + '</span>' +
        skipHtml +
      '</div>';
    }).join('');
  }

  /* ── Risk Tuning Simulator ──────────────────────────────────────────────────── */

  /* Replay closed trades using different risk settings — pure read-only calc */
  function simAnalytics(cfg) {
    var closed   = _trades.filter(function (t) { return t.status === 'CLOSED'; });
    var eligible = closed.filter(function (t) { return (t.confidence || 0) >= cfg.min_confidence; });
    if (!eligible.length) return { count: 0, winRate: 0, totalPnl: 0, maxDD: 0, pf: null };

    var balance  = _cfg.virtual_balance || 10000;
    var riskUsd  = balance * cfg.risk_per_trade_pct / 100;
    var wins = 0, totalPnl = 0, peak = 0, running = 0, maxDD = 0, grossWins = 0, grossLoss = 0;

    eligible.forEach(function (t) {
      var pnl;
      if (t.close_reason === 'TAKE_PROFIT' || t.close_reason === 'TRAILING_STOP') {
        pnl = riskUsd * cfg.take_profit_ratio;
        wins++;
        grossWins += pnl;
      } else {
        pnl = -riskUsd;
        grossLoss += riskUsd;
      }
      totalPnl += pnl;
      running  += pnl;
      if (running > peak) peak = running;
      var dd = peak - running;
      if (dd > maxDD) maxDD = dd;
    });

    return {
      count:    eligible.length,
      winRate:  wins / eligible.length * 100,
      totalPnl: totalPnl,
      maxDD:    maxDD,
      pf:       grossLoss > 0 ? grossWins / grossLoss : (grossWins > 0 ? Infinity : null)
    };
  }

  function renderSim() {
    var wrap = document.getElementById('eeSimWrap');
    if (!wrap) return;

    var closed = _trades.filter(function (t) { return t.status === 'CLOSED'; });
    var countEl = document.getElementById('eeSimTradeCount');
    if (countEl) countEl.textContent = closed.length + ' closed trade' + (closed.length !== 1 ? 's' : '');
    var balEl = document.getElementById('eeSimBal');
    if (balEl) balEl.textContent = (_cfg.virtual_balance || 10000).toLocaleString();

    /* Read slider values */
    function slVal(id, def) {
      var e = document.getElementById(id);
      return e ? parseFloat(e.value) : def;
    }
    var testCfg = {
      min_confidence:     slVal('simConf',   _cfg.min_confidence    || 65),
      stop_loss_pct:      slVal('simSL',     _cfg.stop_loss_pct     || 3),
      take_profit_ratio:  slVal('simTP',     _cfg.take_profit_ratio || 2),
      risk_per_trade_pct: slVal('simRisk',   _cfg.risk_per_trade_pct|| 2)
    };

    /* Update displayed values next to sliders */
    function setLabel(id, val, suffix) {
      var e = document.getElementById(id); if (e) e.textContent = val + (suffix || '');
    }
    setLabel('simConfVal',  testCfg.min_confidence,     '%');
    setLabel('simSLVal',    testCfg.stop_loss_pct,       '%');
    setLabel('simTPVal',    testCfg.take_profit_ratio,   'x');
    setLabel('simRiskVal',  testCfg.risk_per_trade_pct,  '%');

    /* Current actual settings */
    var curCfg = {
      min_confidence:     _cfg.min_confidence,
      stop_loss_pct:      _cfg.stop_loss_pct,
      take_profit_ratio:  _cfg.take_profit_ratio,
      risk_per_trade_pct: _cfg.risk_per_trade_pct
    };

    var cur  = simAnalytics(curCfg);
    var test = simAnalytics(testCfg);

    function fmt(v, prefix, decimals) {
      if (v === null || v === undefined) return '—';
      if (v === Infinity) return '∞';
      return (prefix || '') + v.toFixed(decimals !== undefined ? decimals : 2);
    }
    function colClass(v) { return v > 0 ? 'sim-pos' : v < 0 ? 'sim-neg' : ''; }

    var rows = [
      ['Trades Taken',   cur.count,    test.count,    '', 0],
      ['Win Rate',       cur.winRate,  test.winRate,  '%', 1],
      ['Total P&L',      cur.totalPnl, test.totalPnl, '$', 2],
      ['Max Drawdown',   -cur.maxDD,   -test.maxDD,   '$', 2],
      ['Profit Factor',  cur.pf,       test.pf,       '',  2]
    ];

    var tbody = document.getElementById('eeSimTbody');
    if (tbody) {
      tbody.innerHTML = rows.map(function (r) {
        var label = r[0], cV = r[1], tV = r[2], sfx = r[3], dec = r[4];
        var cStr = (cV === null || cV === undefined) ? '—'
                 : (sfx === '$' ? (cV >= 0 ? '+$' : '-$') + Math.abs(cV).toFixed(dec) : cV.toFixed(dec) + sfx);
        var tStr = (tV === null || tV === undefined) ? '—'
                 : (sfx === '$' ? (tV >= 0 ? '+$' : '-$') + Math.abs(tV).toFixed(dec) : tV.toFixed(dec) + sfx);
        if (r[0] === 'Trades Taken' || r[0] === 'Profit Factor') {
          cStr = cV === null ? '—' : (cV === Infinity ? '∞' : cV.toFixed ? cV.toFixed(dec) : cV);
          tStr = tV === null ? '—' : (tV === Infinity ? '∞' : tV.toFixed ? tV.toFixed(dec) : tV);
        }
        var diff = (typeof cV === 'number' && typeof tV === 'number') ? (tV - cV) : null;
        var diffStr = diff === null ? ''
                    : diff > 0 ? '<span class="sim-pos">▲ ' + Math.abs(diff).toFixed(dec) + sfx + '</span>'
                    : diff < 0 ? '<span class="sim-neg">▼ ' + Math.abs(diff).toFixed(dec) + sfx + '</span>'
                    : '<span class="sim-flat">= no change</span>';
        return '<tr>' +
          '<td class="sim-label">' + label + '</td>' +
          '<td class="' + colClass(cV) + '">' + cStr + '</td>' +
          '<td class="' + colClass(tV) + '">' + tStr + '</td>' +
          '<td>' + diffStr + '</td>' +
        '</tr>';
      }).join('');
    }
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
     STRATEGY ANALYTICS
     ══════════════════════════════════════════════════════════════════════════════ */

  /* Compute all analytics metrics from closed trade history */
  function calcAnalytics() {
    var closed = _trades.filter(function (t) { return t.status === 'CLOSED'; });
    var sorted = closed.slice().sort(function (a, b) {
      return new Date(a.timestamp_close) - new Date(b.timestamp_close);
    });

    var wins   = closed.filter(function (t) { return (t.pnl_usd || 0) > 0; });
    var losses = closed.filter(function (t) { return (t.pnl_usd || 0) <= 0; });

    /* Equity curve ─ cumulative P&L */
    var equity = [];
    var cumPnl = 0;
    sorted.forEach(function (t) {
      cumPnl += (t.pnl_usd || 0);
      equity.push({ ts: t.timestamp_close, bal: cumPnl });
    });

    /* Max drawdown */
    var maxDDPct = 0, maxDDUsd = 0, peak = 0, running = 0;
    sorted.forEach(function (t) {
      running += (t.pnl_usd || 0);
      if (running > peak) peak = running;
      var dd = peak - running;
      if (dd > maxDDUsd) {
        maxDDUsd = dd;
        maxDDPct = peak > 0 ? dd / peak * 100 : 0;
      }
    });

    /* Sharpe ratio — per-trade return (pnl / size_usd), annualised
       Uses avg trade duration to estimate trades-per-year.
       Formula: mean(r) / stdev(r) × sqrt(tradesPerYear)
       Returns null if < 3 trades (not meaningful). */
    /* Duration stats (hours) — computed FIRST so Sharpe can use avgDur */
    var _dursEarly = sorted.filter(function (t) {
      return t.timestamp_close && t.timestamp_open;
    }).map(function (t) {
      return (new Date(t.timestamp_close) - new Date(t.timestamp_open)) / 3600000;
    });
    var _avgDurEarly = _dursEarly.length
      ? _dursEarly.reduce(function (s, v) { return s + v; }, 0) / _dursEarly.length
      : null;

    var sharpeRatio = null;
    if (closed.length >= 3) {
      var returns = closed.map(function (t) {
        var sz = t.size_usd || 1;
        return (t.pnl_usd || 0) / sz;
      });
      var meanR = returns.reduce(function (s, r) { return s + r; }, 0) / returns.length;
      var variance = returns.reduce(function (s, r) {
        return s + (r - meanR) * (r - meanR);
      }, 0) / (returns.length - 1);          // sample variance
      var stdR = Math.sqrt(variance);
      if (stdR > 0) {
        var avgDurHrs = (_avgDurEarly !== null) ? _avgDurEarly : 24;
        var tradesPerYear = 8760 / Math.max(avgDurHrs, 0.25);
        sharpeRatio = +(meanR / stdR * Math.sqrt(tradesPerYear)).toFixed(2);
      }
    }

    /* Averages */
    function avg(arr, key) {
      return arr.length ? arr.reduce(function (s, t) { return s + (t[key] || 0); }, 0) / arr.length : 0;
    }
    var avgWinPct  = avg(wins,   'pnl_pct');
    var avgLossPct = avg(losses, 'pnl_pct');
    var avgWinUsd  = avg(wins,   'pnl_usd');
    var avgLossUsd = avg(losses, 'pnl_usd');

    /* Profit factor */
    var grossWins = wins.reduce(function (s, t) { return s + (t.pnl_usd || 0); }, 0);
    var grossLoss = Math.abs(losses.reduce(function (s, t) { return s + (t.pnl_usd || 0); }, 0));
    var profitFactor = grossLoss > 0 ? grossWins / grossLoss : (grossWins > 0 ? Infinity : null);

    /* Expectancy */
    var winRate    = closed.length ? wins.length / closed.length : 0;
    var expectancy = winRate * avgWinUsd + (1 - winRate) * avgLossUsd;

    /* Timeframe win rates */
    var now = Date.now();
    function tfStats(sinceMs) {
      var tf = closed.filter(function (t) {
        return sinceMs === null ||
          (now - new Date(t.timestamp_close).getTime()) <= sinceMs;
      });
      var w = tf.filter(function (t) { return (t.pnl_usd || 0) > 0; }).length;
      return { wins: w, losses: tf.length - w, total: tf.length,
               pct: tf.length ? Math.round(w / tf.length * 100) : null };
    }
    var wrDay  = tfStats(86400000);
    var wrWeek = tfStats(604800000);
    var wrAll  = tfStats(null);

    /* Duration stats (hours) */
    var durs = sorted.filter(function (t) {
      return t.timestamp_close && t.timestamp_open;
    }).map(function (t) {
      return (new Date(t.timestamp_close) - new Date(t.timestamp_open)) / 3600000;
    });
    var avgDur = durs.length ? durs.reduce(function (s, v) { return s + v; }, 0) / durs.length : null;
    var minDur = durs.length ? Math.min.apply(null, durs) : null;
    var maxDur = durs.length ? Math.max.apply(null, durs) : null;

    /* Per-asset breakdown */
    var assetMap = {};
    closed.forEach(function (t) {
      var k = t.asset || 'Unknown';
      if (!assetMap[k]) assetMap[k] = { wins: 0, losses: 0, pnl_usd: 0 };
      if ((t.pnl_usd || 0) > 0) assetMap[k].wins++; else assetMap[k].losses++;
      assetMap[k].pnl_usd += (t.pnl_usd || 0);
    });

    /* Per-region breakdown */
    var regionMap = {};
    closed.forEach(function (t) {
      var k = t.region || 'GLOBAL';
      if (!regionMap[k]) regionMap[k] = { wins: 0, losses: 0, pnl_usd: 0 };
      if ((t.pnl_usd || 0) > 0) regionMap[k].wins++; else regionMap[k].losses++;
      regionMap[k].pnl_usd += (t.pnl_usd || 0);
    });

    /* P&L distribution buckets */
    var buckets = { '<-5%': 0, '-5~-2%': 0, '-2~0%': 0, '0~2%': 0, '2~5%': 0, '>5%': 0 };
    closed.forEach(function (t) {
      var p = t.pnl_pct || 0;
      if      (p < -5) buckets['<-5%']++;
      else if (p < -2) buckets['-5~-2%']++;
      else if (p <  0) buckets['-2~0%']++;
      else if (p <  2) buckets['0~2%']++;
      else if (p <  5) buckets['2~5%']++;
      else             buckets['>5%']++;
    });

    /* Per-scalper-agent breakdown */
    var scalperStats = {};
    closed.forEach(function (t) {
      // Use stored source; fall back to inferring from reason for legacy trades
      var src = t.source || _inferSource(t.reason || '');
      if (!src || src.indexOf('scalper') === -1) return;
      if (!scalperStats[src]) scalperStats[src] = { trades: 0, wins: 0, losses: 0, pnl: 0, partial: 0, durs: [] };
      var s = scalperStats[src];
      s.trades++;
      if ((t.pnl_usd || 0) > 0) s.wins++; else s.losses++;
      s.pnl += (t.pnl_usd || 0) + (t.partial_pnl_usd || 0);
      if (t.partial_tp_taken) s.partial++;
      if (t.timestamp_open && t.timestamp_close) {
        var dur = (new Date(t.timestamp_close).getTime() - new Date(t.timestamp_open).getTime()) / 60000;
        if (dur > 0) s.durs.push(dur);
      }
    });
    // Also include all-time open scalp count
    var openScalpers = _trades.filter(function (t) {
      if (t.status !== 'OPEN') return false;
      var src = t.source || _inferSource(t.reason || '');
      return src && src.indexOf('scalper') !== -1;
    });

    return {
      closed: closed.length, equity: equity,
      maxDDPct: maxDDPct, maxDDUsd: maxDDUsd,
      avgWinPct: avgWinPct, avgLossPct: avgLossPct,
      avgWinUsd: avgWinUsd, avgLossUsd: avgLossUsd,
      profitFactor: profitFactor, expectancy: expectancy,
      wrDay: wrDay, wrWeek: wrWeek, wrAll: wrAll,
      avgDur: avgDur, minDur: minDur, maxDur: maxDur,
      assetMap: assetMap, regionMap: regionMap, buckets: buckets,
      scalperStats: scalperStats, openScalpers: openScalpers,
      sharpeRatio: sharpeRatio
    };
  }

  /* ── Canvas chart helpers ──────────────────────────────────────────────── */

  function _setupCanvas(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    var dpr  = window.devicePixelRatio || 1;
    var cw   = el.offsetWidth || 400;
    var ch   = parseInt(el.getAttribute('height'), 10) || 160;
    el.width  = Math.round(cw * dpr);
    el.height = Math.round(ch * dpr);
    el.style.width  = cw + 'px';
    el.style.height = ch + 'px';
    var ctx = el.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx: ctx, w: cw, h: ch };
  }

  function _clearCanvas(ctx, w, h) {
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);
  }

  function _noData(ctx, w, h, msg) {
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg || 'No data yet', w / 2, h / 2);
  }

  /* Cumulative equity / P&L curve */
  function drawEquityCurve(canvasId, points) {
    var c = _setupCanvas(canvasId);
    if (!c) return;
    var ctx = c.ctx, w = c.w, h = c.h;
    _clearCanvas(ctx, w, h);

    if (!points || !points.length) { _noData(ctx, w, h, 'No closed trades yet'); return; }

    var pad = { t: 10, r: 10, b: 24, l: 52 };
    var cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;

    var allVals = [0].concat(points.map(function (p) { return p.bal; }));
    var minV = Math.min.apply(null, allVals), maxV = Math.max.apply(null, allVals);
    var range = maxV - minV || 1;

    /* Horizontal grid */
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (var gi = 0; gi <= 4; gi++) {
      var gy = pad.t + ch - (gi / 4) * ch;
      ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(pad.l + cw, gy); ctx.stroke();
      var lv = minV + (gi / 4) * range;
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '8px monospace'; ctx.textAlign = 'right';
      ctx.fillText((lv >= 0 ? '+$' : '-$') + _num(Math.abs(lv)), pad.l - 4, gy + 3);
    }

    /* Zero dashed line */
    var zeroY = pad.t + ch - ((0 - minV) / range * ch);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pad.l, zeroY); ctx.lineTo(pad.l + cw, zeroY); ctx.stroke();
    ctx.setLineDash([]);

    /* Plot coordinates */
    var coords = allVals.map(function (v, i) {
      return { x: pad.l + (i / (allVals.length - 1 || 1)) * cw,
               y: pad.t + ch - ((v - minV) / range * ch) };
    });

    var lastBal  = allVals[allVals.length - 1];
    var lineCol  = lastBal >= 0 ? '#00c8a0' : '#ff4444';
    var fillTop  = lastBal >= 0 ? 'rgba(0,200,160,0.22)' : 'rgba(255,68,68,0.22)';

    /* Fill under curve */
    var grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch);
    grad.addColorStop(0, fillTop); grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.moveTo(coords[0].x, pad.t + ch);
    coords.forEach(function (p) { ctx.lineTo(p.x, p.y); });
    ctx.lineTo(coords[coords.length - 1].x, pad.t + ch);
    ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

    /* Line */
    ctx.beginPath();
    ctx.moveTo(coords[0].x, coords[0].y);
    coords.slice(1).forEach(function (p) { ctx.lineTo(p.x, p.y); });
    ctx.strokeStyle = lineCol; ctx.lineWidth = 2; ctx.stroke();

    /* Terminal dot */
    var last = coords[coords.length - 1];
    ctx.beginPath(); ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = lineCol; ctx.fill();
  }

  /* P&L distribution — vertical bar chart */
  function drawDistribution(canvasId, buckets) {
    var c = _setupCanvas(canvasId);
    if (!c) return;
    var ctx = c.ctx, w = c.w, h = c.h;
    _clearCanvas(ctx, w, h);

    var pad  = { t: 14, r: 10, b: 38, l: 20 };
    var cw   = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    var lbls = Object.keys(buckets);
    var vals = lbls.map(function (k) { return buckets[k]; });
    var maxV = Math.max.apply(null, vals) || 1;
    var bw   = cw / lbls.length;
    var bp   = 4;
    var cols = ['#cc3333','#ee6644','#ffaa44','#44aa88','#00c8a0','#00ddbb'];

    lbls.forEach(function (lbl, i) {
      var v   = vals[i];
      var bh  = ch * (v / maxV);
      var x   = pad.l + i * bw + bp;
      var bww = bw - bp * 2;
      var y   = pad.t + ch - bh;

      ctx.fillStyle = cols[i] || '#888';
      ctx.fillRect(x, y, bww, bh);

      if (v > 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = '9px monospace'; ctx.textAlign = 'center';
        ctx.fillText(v, x + bww / 2, y - 3);
      }

      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.font = '7px monospace'; ctx.textAlign = 'center';
      ctx.fillText(lbl, x + bww / 2, pad.t + ch + 12);
    });
  }

  /* Trades per asset — stacked win/loss vertical bars */
  function drawTradesPerAsset(canvasId, assetMap) {
    var c = _setupCanvas(canvasId);
    if (!c) return;
    var ctx = c.ctx, w = c.w, h = c.h;
    _clearCanvas(ctx, w, h);

    var entries = Object.keys(assetMap).map(function (k) {
      var d = assetMap[k];
      return { label: k, wins: d.wins, losses: d.losses, total: d.wins + d.losses };
    }).sort(function (a, b) { return b.total - a.total; }).slice(0, 8);

    if (!entries.length) { _noData(ctx, w, h); return; }

    var pad  = { t: 14, r: 10, b: 36, l: 10 };
    var cw   = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    var maxT = Math.max.apply(null, entries.map(function (e) { return e.total; })) || 1;
    var bw   = cw / entries.length, bp = 3;

    entries.forEach(function (e, i) {
      var x    = pad.l + i * bw + bp;
      var bww  = bw - bp * 2;
      var winH = ch * (e.wins   / maxT);
      var losH = ch * (e.losses / maxT);

      ctx.fillStyle = 'rgba(0,200,160,0.72)';
      ctx.fillRect(x, pad.t + ch - winH - losH, bww, winH);
      ctx.fillStyle = 'rgba(255,68,68,0.72)';
      ctx.fillRect(x, pad.t + ch - losH, bww, losH);

      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '8px monospace'; ctx.textAlign = 'center';
      if (e.total > 0) ctx.fillText(e.total, x + bww / 2, pad.t + ch - winH - losH - 3);

      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.font = '7px monospace'; ctx.textAlign = 'center';
      ctx.fillText(e.label.split(' ')[0].substring(0, 6), x + bww / 2, pad.t + ch + 14);
    });
  }

  /* Horizontal bar chart — asset P&L or region P&L */
  function drawHBar(canvasId, items, valueKey, labelKey, colorFn) {
    var c = _setupCanvas(canvasId);
    if (!c) return;
    var ctx = c.ctx, w = c.w, h = c.h;
    _clearCanvas(ctx, w, h);

    var slice = (items || []).slice(0, 8);
    if (!slice.length) { _noData(ctx, w, h); return; }

    var labW = 82, valW = 52;
    var barAreaW = w - labW - valW - 8;
    var rowH = h / slice.length;
    var vals = slice.map(function (d) { return Math.abs(d[valueKey] || 0); });
    var maxV = Math.max.apply(null, vals) || 1;

    slice.forEach(function (d, i) {
      var v   = d[valueKey] || 0;
      var bw  = barAreaW * (Math.abs(v) / maxV);
      var y   = i * rowH;
      var midY = y + rowH / 2;

      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'transparent';
      ctx.fillRect(0, y, w, rowH);

      var col = colorFn ? colorFn(v) : (v >= 0 ? '#00c8a0' : '#ff4444');
      ctx.fillStyle = col;
      ctx.fillRect(labW, midY - rowH * 0.3, bw, rowH * 0.6);

      /* Label */
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.font = '8px monospace'; ctx.textAlign = 'right';
      ctx.fillText(String(d[labelKey] || '').substring(0, 11), labW - 5, midY + 3);

      /* Value */
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.fillText((v >= 0 ? '+$' : '-$') + _num(Math.abs(v)), labW + bw + 5, midY + 3);
    });
  }

  /* ── renderAnalytics — updates all KPIs and redraws all charts ─────────── */

  function renderAnalytics() {
    var a = calcAnalytics();

    var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };

    /* ── Win rates ── */
    function wrText(wr) { return wr.total === 0 ? '—' : wr.pct + '%'; }
    function wrSub(wr)  {
      if (wr.total === 0) return 'No closed trades';
      return wr.wins + 'W / ' + wr.losses + 'L  (' + wr.total + ')';
    }
    function applyWrCls(id, wr) {
      var el = document.getElementById(id);
      if (!el) return;
      el.className = 'ee-an-wr-val' +
        (wr.total === 0 ? ' dim' : wr.pct >= 55 ? ' good' : wr.pct < 45 ? ' bad' : '');
    }

    set('eeAnWinDay',     wrText(a.wrDay));
    set('eeAnWinDaySub',  wrSub(a.wrDay));
    applyWrCls('eeAnWinDay', a.wrDay);

    set('eeAnWinWeek',    wrText(a.wrWeek));
    set('eeAnWinWeekSub', wrSub(a.wrWeek));
    applyWrCls('eeAnWinWeek', a.wrWeek);

    set('eeAnWinAll',    wrText(a.wrAll));
    set('eeAnWinAllSub', wrSub(a.wrAll));
    applyWrCls('eeAnWinAll', a.wrAll);

    /* ── KPIs ── */
    set('eeAnMaxDD',  a.closed ? '-' + a.maxDDPct.toFixed(1) + '%' : '—');
    set('eeAnAvgWin', a.closed ? '+' + a.avgWinPct.toFixed(2) + '%' : '—');
    set('eeAnAvgLoss', a.closed ? a.avgLossPct.toFixed(2) + '%' : '—');

    var pfEl = document.getElementById('eeAnPF');
    if (pfEl) {
      if (a.profitFactor === null) {
        pfEl.textContent = '—'; pfEl.className = 'ee-an-kpi-val dim';
      } else if (!isFinite(a.profitFactor)) {
        pfEl.textContent = '∞'; pfEl.className = 'ee-an-kpi-val green';
      } else {
        pfEl.textContent = a.profitFactor.toFixed(2);
        pfEl.className = 'ee-an-kpi-val ' +
          (a.profitFactor >= 1.5 ? 'green' : a.profitFactor < 1 ? 'red' : '');
      }
    }

    var exEl = document.getElementById('eeAnExpect');
    if (exEl) {
      if (!a.closed) { exEl.textContent = '—'; exEl.className = 'ee-an-kpi-val dim'; }
      else {
        exEl.textContent = (a.expectancy >= 0 ? '+$' : '-$') + _num(Math.abs(a.expectancy));
        exEl.className = 'ee-an-kpi-val ' + (a.expectancy > 0 ? 'green' : 'red');
      }
    }

    /* ── Sharpe Ratio & Max DD USD ── */
    var srEl = document.getElementById('eeAnSharpe');
    if (srEl) {
      if (a.sharpeRatio === null) {
        srEl.textContent = '—';
        srEl.className = 'ee-an-kpi-val dim';
      } else {
        srEl.textContent = a.sharpeRatio.toFixed(2);
        srEl.className = 'ee-an-kpi-val ' +
          (a.sharpeRatio >= 1.5 ? 'green' : a.sharpeRatio < 0 ? 'red' : '');
      }
    }

    /* Max DD in USD (already have pct; also show dollar amount) */
    var ddUsdEl = document.getElementById('eeAnMaxDDUsd');
    if (ddUsdEl) {
      ddUsdEl.textContent = a.closed && a.maxDDUsd > 0 ? '-$' + _num(a.maxDDUsd) : '—';
    }

    /* ── Duration stats ── */
    function fmtDur(hrs) {
      if (hrs === null) return '—';
      if (hrs < 1)  return Math.round(hrs * 60) + 'm';
      if (hrs < 24) return hrs.toFixed(1) + 'h';
      return (hrs / 24).toFixed(1) + 'd';
    }
    set('eeAnAvgDur', fmtDur(a.avgDur));
    set('eeAnMinDur', fmtDur(a.minDur));
    set('eeAnMaxDur', fmtDur(a.maxDur));

    /* ── Charts ── */
    drawEquityCurve('eeChartEquity', a.equity);
    drawDistribution('eeChartDist', a.buckets);
    drawTradesPerAsset('eeChartAsset', a.assetMap);

    var assetPnlItems = Object.keys(a.assetMap).map(function (k) {
      return { label: k, pnl_usd: a.assetMap[k].pnl_usd };
    }).sort(function (x, y) { return Math.abs(y.pnl_usd) - Math.abs(x.pnl_usd); });
    drawHBar('eeChartAssetPnl', assetPnlItems, 'pnl_usd', 'label',
      function (v) { return v >= 0 ? '#00c8a0' : '#ff4444'; });

    /* ── Open positions unrealised P&L bar ── */
    var openEl = document.getElementById('eeAnOpenPnl');
    if (openEl) {
      var openT = openTrades();
      if (!openT.length) {
        openEl.textContent = 'No open positions';
        openEl.style.color = 'var(--dim)';
      } else {
        var totPct = 0, totUsd = 0, priced = 0;
        openT.forEach(function (t) {
          var px = _livePrice[t.trade_id] || null;
          if (!px) return;
          var p = t.direction === 'LONG'
            ? (px - t.entry_price) / t.entry_price * 100
            : (t.entry_price - px) / t.entry_price * 100;
          totPct += p;
          totUsd += t.units * Math.abs(px - t.entry_price) * (p >= 0 ? 1 : -1);
          priced++;
        });
        if (priced === 0) {
          openEl.textContent = openT.length + ' open trade' + (openT.length > 1 ? 's' : '') + ' — awaiting price feed';
          openEl.style.color = 'var(--dim)';
        } else {
          var ap = Math.round(totPct * 100) / 100;
          var au = Math.round(totUsd * 100) / 100;
          openEl.textContent = openT.length + ' open · Unrealised: ' +
            (ap >= 0 ? '+' : '') + ap.toFixed(1) + '%  (' +
            (au >= 0 ? '+$' : '-$') + _num(Math.abs(au)) + ')';
          openEl.style.color = totUsd >= 0 ? 'var(--green)' : 'var(--red)';
        }
      }
    }

    var regionItems = Object.keys(a.regionMap).map(function (k) {
      return { label: k, pnl_usd: a.regionMap[k].pnl_usd };
    }).sort(function (x, y) { return Math.abs(y.pnl_usd) - Math.abs(x.pnl_usd); });
    drawHBar('eeChartRegion', regionItems, 'pnl_usd', 'label',
      function (v) { return v >= 0 ? '#00c8a0' : '#ff4444'; });

    // ── Per-asset win rate breakdown ─────────────────────────────────────────
    var assetEl = document.getElementById('eeAssetWinRate');
    if (assetEl) {
      var closed = _trades.filter(function (t) { return t.status === 'CLOSED'; });
      if (!closed.length) {
        assetEl.innerHTML = '<span style="color:var(--dim);font-size:10px">No closed trades yet.</span>';
      } else {
        // Build per-asset stats
        var assetStats = {};
        closed.forEach(function (t) {
          var k = t.asset || '?';
          if (!assetStats[k]) assetStats[k] = { wins: 0, losses: 0, pnl: 0, partial: 0 };
          if (t.close_reason === 'TAKE_PROFIT' || t.close_reason === 'TRAILING_STOP') assetStats[k].wins++;
          else assetStats[k].losses++;
          assetStats[k].pnl += (t.pnl_usd || 0) + (t.partial_pnl_usd || 0);
          if (t.partial_tp_taken) assetStats[k].partial++;
        });
        var assetKeys = Object.keys(assetStats).sort(function (a, b) {
          return Math.abs(assetStats[b].pnl) - Math.abs(assetStats[a].pnl);
        });
        var rows = assetKeys.map(function (k) {
          var s = assetStats[k];
          var tot = s.wins + s.losses;
          var wr = tot ? Math.round(s.wins / tot * 100) : 0;
          var wrCls = wr >= 60 ? 'color:var(--green)' : wr < 40 ? 'color:var(--red)' : 'color:var(--amber)';
          var pnlCls = s.pnl >= 0 ? 'color:var(--green)' : 'color:var(--red)';
          var pnlStr = (s.pnl >= 0 ? '+$' : '-$') + _num(Math.abs(s.pnl));
          return '<tr style="border-bottom:1px solid rgba(255,255,255,0.05)">' +
            '<td style="padding:3px 8px;font-weight:700">' + _esc(k) + '</td>' +
            '<td style="padding:3px 8px">' + tot + '</td>' +
            '<td style="padding:3px 8px;' + wrCls + '">' + wr + '%</td>' +
            '<td style="padding:3px 8px">' + s.wins + '/' + s.losses + '</td>' +
            '<td style="padding:3px 8px;' + pnlCls + '">' + pnlStr + '</td>' +
            '<td style="padding:3px 8px;color:var(--dim)">' + (s.partial ? '½×' + s.partial : '—') + '</td>' +
            '</tr>';
        }).join('');
        assetEl.innerHTML =
          '<table style="width:100%;border-collapse:collapse;font-size:10px">' +
          '<thead><tr style="color:rgba(255,255,255,0.45);font-size:9px">' +
          '<th style="padding:3px 8px;text-align:left">Asset</th>' +
          '<th style="padding:3px 8px;text-align:left">Trades</th>' +
          '<th style="padding:3px 8px;text-align:left">Win%</th>' +
          '<th style="padding:3px 8px;text-align:left">W/L</th>' +
          '<th style="padding:3px 8px;text-align:left">P&L</th>' +
          '<th style="padding:3px 8px;text-align:left">Partial</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table>';
      }
    }

    // ── Correlation heat map ──────────────────────────────────────────────────
    var heatEl = document.getElementById('eeCorrHeat');
    if (heatEl) {
      var open = openTrades();
      if (!open.length) {
        heatEl.innerHTML = '<span style="color:var(--dim);font-size:10px">No open positions.</span>';
      } else {
        // Count by sector and direction
        var sectorCounts = {};
        open.forEach(function (t) {
          var sector = EE_SECTOR_MAP[normaliseAsset(t.asset)] || 'other';
          if (!sectorCounts[sector]) sectorCounts[sector] = { long: 0, short: 0, assets: [] };
          sectorCounts[sector][t.direction === 'LONG' ? 'long' : 'short']++;
          sectorCounts[sector].assets.push(t.asset);
        });
        var sectorKeys = Object.keys(sectorCounts).sort(function (a, b) {
          var ta = sectorCounts[a].long + sectorCounts[a].short;
          var tb = sectorCounts[b].long + sectorCounts[b].short;
          return tb - ta;
        });
        heatEl.innerHTML = sectorKeys.map(function (s) {
          var c = sectorCounts[s];
          var tot = c.long + c.short;
          var maxPerSector = _cfg.max_per_sector || 2;
          var heat = tot >= maxPerSector ? '#ff4444' : tot >= maxPerSector - 1 ? '#ffc107' : '#00e676';
          return '<div style="display:inline-flex;align-items:center;gap:4px;' +
            'margin:2px 6px 2px 0;padding:3px 8px;background:rgba(255,255,255,0.05);' +
            'border:1px solid ' + heat + ';border-radius:4px;font-size:10px">' +
            '<span style="color:' + heat + '">●</span>' +
            '<span style="color:var(--text)">' + s + '</span>' +
            '<span style="color:var(--dim)">' + c.assets.join('/') + '</span>' +
            (c.long  ? '<span style="color:var(--green)">↑' + c.long  + '</span>' : '') +
            (c.short ? '<span style="color:var(--red)">↓'   + c.short + '</span>' : '') +
            '</div>';
        }).join('');
      }
    }

    // ── Scalper agent performance panel ──────────────────────────────────────
    var scalperEl = document.getElementById('eeScalperStats');
    if (scalperEl) {
      var stats   = a.scalperStats || {};
      var sources = Object.keys(stats);

      // Live status badges from agent globals
      var agentStatus = [
        { key: 'scalper',         global: 'GII_AGENT_SCALPER',         label: '24/7 Scalper',    icon: '⚡' },
        { key: 'scalper-session', global: 'GII_AGENT_SCALPER_SESSION', label: 'Session Scalper', icon: '🕐' }
      ];

      var liveHtml = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
      agentStatus.forEach(function (ag) {
        var agObj = window[ag.global];
        var st    = agObj ? (function () { try { return agObj.status(); } catch(e) { return {}; } })() : null;
        var isActive   = st && st.activeScalp;
        var isSessionOff = st && st.note && st.note.indexOf('Outside session') !== -1;
        var isGated    = st && st.gtiGated;
        var badgeColor = isActive ? '#00e676' : (isSessionOff || isGated) ? 'rgba(255,255,255,0.3)' : 'var(--amber)';
        var stateLabel = isActive ? '⚡ Active: BTC ' + (st.activeScalp.bias || '').toUpperCase()
                       : isSessionOff ? 'Outside session'
                       : isGated      ? 'GTI gated'
                       : st           ? 'Scanning'
                       :                'Not loaded';
        liveHtml += '<div style="padding:5px 10px;background:var(--bg3);border:1px solid ' + badgeColor +
          ';border-radius:4px;font-size:10px">' +
          '<span style="color:' + badgeColor + ';font-weight:700">' + ag.icon + ' ' + ag.label + '</span>' +
          '<span style="color:rgba(255,255,255,0.5);margin-left:8px">' + stateLabel + '</span>' +
          (st && typeof st.rsi5m === 'number'
            ? '<span style="color:rgba(255,255,255,0.4);margin-left:8px;font-size:9px">RSI ' + st.rsi5m +
              ' | Vol×' + (st.volRatio || '—') + '</span>'
            : '') +
          '</div>';
      });
      liveHtml += '</div>';

      if (!sources.length) {
        scalperEl.innerHTML = liveHtml +
          '<span style="color:var(--dim);font-size:10px">No closed scalper trades yet — stats will appear here once a BTC scalp closes.</span>';
      } else {
        var combined = { trades: 0, wins: 0, losses: 0, pnl: 0, partial: 0, durs: [] };
        sources.forEach(function (k) {
          var s = stats[k];
          combined.trades += s.trades; combined.wins += s.wins; combined.losses += s.losses;
          combined.pnl += s.pnl; combined.partial += s.partial;
          combined.durs = combined.durs.concat(s.durs);
        });

        var LABELS = { 'scalper': '24/7 Scalper', 'scalper-session': 'Session Scalper' };

        var rows = sources.concat(['combined']).map(function (k) {
          var s = (k === 'combined') ? combined : stats[k];
          if (!s || !s.trades) return '';
          var tot  = s.wins + s.losses;
          var wr   = tot ? Math.round(s.wins / tot * 100) : 0;
          var wrCl = wr >= 60 ? 'var(--green)' : wr < 40 ? 'var(--red)' : 'var(--amber)';
          var pnlCl = s.pnl >= 0 ? 'var(--green)' : 'var(--red)';
          var avgDur = s.durs.length
            ? (s.durs.reduce(function (a, b) { return a + b; }, 0) / s.durs.length).toFixed(0) + 'm'
            : '—';
          var label = k === 'combined' ? '<b>COMBINED</b>' : (LABELS[k] || k);
          var rowStyle = k === 'combined'
            ? 'border-top:1px solid rgba(255,255,255,0.15);font-weight:700'
            : 'border-bottom:1px solid rgba(255,255,255,0.05)';
          return '<tr style="' + rowStyle + '">' +
            '<td style="padding:4px 8px">' + label + '</td>' +
            '<td style="padding:4px 8px">' + s.trades + '</td>' +
            '<td style="padding:4px 8px;color:' + wrCl + '">' + wr + '%</td>' +
            '<td style="padding:4px 8px">' + s.wins + ' / ' + s.losses + '</td>' +
            '<td style="padding:4px 8px;color:' + pnlCl + '">' + (s.pnl >= 0 ? '+$' : '-$') + _num(Math.abs(s.pnl)) + '</td>' +
            '<td style="padding:4px 8px;color:var(--dim)">' + avgDur + '</td>' +
            '<td style="padding:4px 8px;color:var(--dim)">' + (s.partial ? '½×' + s.partial : '—') + '</td>' +
            '</tr>';
        }).join('');

        scalperEl.innerHTML = liveHtml +
          '<table style="width:100%;border-collapse:collapse;font-size:10px">' +
          '<thead><tr style="color:rgba(255,255,255,0.4);font-size:9px;border-bottom:1px solid rgba(255,255,255,0.12)">' +
          '<th style="padding:4px 8px;text-align:left">Agent</th>' +
          '<th style="padding:4px 8px;text-align:left">Trades</th>' +
          '<th style="padding:4px 8px;text-align:left">Win%</th>' +
          '<th style="padding:4px 8px;text-align:left">W / L</th>' +
          '<th style="padding:4px 8px;text-align:left">P&amp;L</th>' +
          '<th style="padding:4px 8px;text-align:left">Avg Hold</th>' +
          '<th style="padding:4px 8px;text-align:left">Partial TPs</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table>';
      }
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     PUBLIC API  (window.EE)
     ══════════════════════════════════════════════════════════════════════════════ */

  window.EE = {

    /* ── Called by renderTrades() hook each cycle ── */
    onSignals: onSignals,

    /* ── Risk Simulator: called by slider oninput events ── */
    updateSim: function () { renderSim(); },

    /* ── Reset all learned weight adjustments (called by learning panel) ── */
    resetLearning: function () {
      if (!confirm('Reset all learned weight adjustments?\n\nThis clears the model\'s training history. The IMPACT_MAP base scores will be used instead.')) return;
      if (typeof window._learnedWeights !== 'undefined') {
        // Clear via dashboard's exposed reset hook
        if (typeof window.onLearnReset === 'function') window.onLearnReset();
        else {
          try { localStorage.removeItem('geodash_learned_weights_v1'); } catch(e) {}
          log('LEARN', 'Learning weights reset — all adjustments cleared', 'amber');
          renderUI();
        }
      }
    },

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
        min_confidence:       { min: 10,  max: 95,       int: true  },
        risk_per_trade_pct:   { min: 0.1, max: 10,       int: false },
        stop_loss_pct:        { min: 0.1, max: 20,       int: false },
        take_profit_ratio:    { min: 0.5, max: 10,       int: false },
        max_open_trades:      { min: 1,   max: 20,       int: true  },
        max_per_region:       { min: 1,   max: 5,        int: true  },
        max_per_sector:       { min: 1,   max: 5,        int: true  },
        virtual_balance:      { min: 100, max: 10000000, int: false },
        max_risk_usd:         { min: 0,   max: 10000,    int: false },
        trailing_stop_pct:    { min: 0.1, max: 10,       int: false },
        daily_loss_limit_pct: { min: 1,   max: 100,      int: false },
        event_gate_hours:     { min: 0,   max: 4,        int: false }
      };
      Object.keys(rules).forEach(function (f) {
        var el = document.getElementById('eeCfg_' + f);
        if (!el) return;
        var v = parseFloat(el.value), r = rules[f];
        if (isNaN(v) || v < r.min || v > r.max) return;
        _cfg[f] = r.int ? Math.round(v) : v;
      });
      // Sync checkbox toggles
      ['trailing_stop_enabled','break_even_enabled','partial_tp_enabled','event_gate_enabled'].forEach(function (f) {
        var el = document.getElementById('eeCfg_' + f);
        if (el) _cfg[f] = el.checked;
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
        // Cascade: fresh fetch → cache → live-price map → stop level → entry price.
        // Never fall back to entry_price alone — a real close at entry hides all losses.
        var _tok     = normaliseAsset(trade.asset);
        var _closeAt = price
                    || _priceCache[_tok]
                    || _livePrice[trade.trade_id]
                    || trade.stop_loss
                    || trade.entry_price;
        if (!price) log('PRICE', 'Manual close ' + trade.asset + ' — using cached price $' + _num(_closeAt), 'amber');
        closeTrade(tradeId, _closeAt, 'MANUAL');
      });
    },

    /* ── gii-exit: update stop/TP on an open trade without closing it ──
       changes = { stop_loss, take_profit }  (either or both)               */
    updateOpenTrade: function (tradeId, changes) {
      var trade = _trades.find(function (t) {
        return t.trade_id === tradeId && t.status === 'OPEN';
      });
      if (!trade) return false;
      if (changes.stop_loss   !== undefined) trade.stop_loss   = +changes.stop_loss;
      if (changes.take_profit !== undefined) trade.take_profit = +changes.take_profit;
      saveTrades();
      renderUI();
      return true;
    },

    /* ── gii-exit: force-close an open trade at current market price ──
       reason should be prefixed 'GII-EXIT: ...' for log clarity           */
    forceCloseTrade: function (tradeId, reason) {
      var trade = _trades.find(function (t) {
        return t.trade_id === tradeId && t.status === 'OPEN';
      });
      if (!trade) return false;
      fetchPrice(trade.asset, function (price) {
        var _tok     = normaliseAsset(trade.asset);
        var _closeAt = price
                    || _priceCache[_tok]
                    || _livePrice[trade.trade_id]
                    || trade.stop_loss
                    || trade.entry_price;
        if (!price) log('PRICE', 'Force-close ' + trade.asset + ' — using cached price $' + _num(_closeAt), 'amber');
        closeTrade(tradeId, _closeAt, reason || 'GII-EXIT');
      });
      return true;
    },

    /* ── gii-exit: get last known price for an asset from the price cache ── */
    getLastPrice: function (asset) {
      if (!asset) return null;
      var token = normaliseAsset(asset);
      var price = _priceCache[token];
      return (price && isFinite(price)) ? price : null;
    },

    /* ── Soft reset — close all open trades at market, keep everything else ── */
    softReset: function () {
      var open = openTrades();
      if (!open.length) { alert('No open trades to close.'); return; }
      if (!confirm('Close all ' + open.length + ' open trade(s) at current market price?\n\nBalance, history and learning data are preserved.')) return;
      var n = open.length;
      open.forEach(function (t) {
        var token = normaliseAsset(t.asset);
        var price = _priceCache[token] || _livePrice[t.trade_id] || t.entry_price;
        closeTrade(t.trade_id, price, 'MANUAL');
      });
      log('CONFIG', 'Soft reset: ' + n + ' open trade(s) closed at market', 'amber');
      renderUI();
    },

    /* ── Account reset — reset balance + P&L timeline, keep trade history ── */
    accountReset: function () {
      if (!confirm(
        'Account Reset:\n\n' +
        '✓ Reset balance to $' + DEFAULTS.virtual_balance + '\n' +
        '✓ Clear P&L timeline\n\n' +
        '✗ Trade history kept\n' +
        '✗ Learning weights kept\n' +
        '✗ Settings kept'
      )) return;
      _cfg.virtual_balance = DEFAULTS.virtual_balance;
      saveCfg();
      _pnlHistory = [];
      savePnlHistory();
      _sessionStart = new Date().toISOString();
      _sessionStartBalance = DEFAULTS.virtual_balance;
      try { localStorage.setItem('geodash_session_start_v1', _sessionStart); } catch(e) {}
      try { localStorage.removeItem('geodash_session_balance_v1'); } catch(e) {}   // v63: clear persisted day-open balance on reset
      _recordPnlSnapshot('account-reset', 0);
      log('CONFIG', 'Account reset: balance restored to $' + DEFAULTS.virtual_balance, 'amber');
      renderUI();
    },

    /* ── Reset virtual balance (alias kept for any existing onclick refs) ── */
    resetBalance: function () { return this.accountReset(); },

    /* ── Clear closed trade history ── */
    clearHistory: function () {
      if (!confirm('Clear all closed trade history? Open trades are not affected.')) return;
      _trades = _trades.filter(function (t) { return t.status === 'OPEN'; });
      saveTrades();
      log('CONFIG', 'Closed trade history cleared', 'amber');
      renderUI();
    },

    /* ── Full reset — wipes everything and starts fresh ── */
    fullReset: function () {
      if (!confirm('Full reset: close ALL open trades, clear all history and reset balance to $' + DEFAULTS.virtual_balance + '?\n\nThis cannot be undone.')) return;
      // 0. Backup current state before wiping (survives the reload)
      var _bts = _createBackup();
      if (_bts) console.info('[EE] Full-reset backup saved: geodash_backup_' + _bts);
      // 1. Wipe backend DB first (fire-and-forget with log)
      if (_apiOnline) {
        _apiFetch('/api/trades', { method: 'DELETE' })
          .then(function (r) { return r.json(); })
          .then(function (d) { log('CONFIG', 'Backend wiped — ' + (d.deleted || 0) + ' trades deleted', 'amber'); })
          .catch(function () { log('CONFIG', 'Backend wipe failed — restart backend to clear DB', 'red'); });
      }
      // 2. Wipe in-memory state
      _trades       = [];
      _livePrice    = {};
      _cooldown     = {};
      _pendingOpen  = {};
      _lastSignals  = [];
      _cfg.virtual_balance = DEFAULTS.virtual_balance;
      // 3. Reset HRS in memory immediately (don't wait for reload)
      if (window.HRS && typeof HRS.reset === 'function') HRS.reset();
      // 4. Sweep ALL geodash_* and gii_* keys so nothing is missed
      try {
        Object.keys(localStorage).forEach(function (k) {
          if (k.indexOf('geodash_') === 0 || k.indexOf('gii_') === 0) {
            localStorage.removeItem(k);
          }
        });
      } catch (e) {}
      saveTrades();
      saveCfg();
      // Reload so all other in-memory state reinitialises cleanly
      window.location.reload();
    },

    /* ── Analytics Reset — clears all performance data, keeps settings & agents ── */
    analyticsReset: function () {
      if (!confirm(
        'Start a new tracking session?\n\n' +
        'This will:\n' +
        '✓ Clear all trade history and P&L stats\n' +
        '✓ Clear signal log\n' +
        '✓ Reset all agent win-rate / hit-rate feedback\n\n' +
        '✗ Will NOT change your settings, balance, or agent configs\n' +
        '✗ Will NOT stop agents or signal scanning\n\n' +
        'The page will reload to start cleanly. Continue?'
      )) return;

      // 1. Wipe backend trade DB (analytics only — no config tables)
      var apiWipe = _apiOnline
        ? _apiFetch('/api/trades', { method: 'DELETE' }).catch(function () {})
        : Promise.resolve();

      apiWipe.then(function () {
        // 2. Reset HRS in memory immediately
        if (window.HRS && typeof HRS.reset === 'function') HRS.reset();
        // 3. Sweep ALL geodash_* and gii_* keys (catches anything we might have missed)
        //    Keep geodash_ee_config_v2 so settings/balance are preserved
        try {
          Object.keys(localStorage).forEach(function (k) {
            if (k === 'geodash_ee_config_v2') return; // keep settings
            if (k.indexOf('geodash_') === 0 || k.indexOf('gii_') === 0) {
              localStorage.removeItem(k);
            }
          });
        } catch (e) {}
        // 4. Reload page — agents reinitialise fresh, scanning resumes immediately
        window.location.reload();
      });
    },

    /* ── P&L timeline access ── */
    getPnlHistory: function () { return _pnlHistory.slice(); },

    /* ── Backup management ── */
    listBackups: function () {
      try {
        return Object.keys(localStorage)
          .filter(function (k) { return k.indexOf('geodash_backup_') === 0; })
          .map(function (k) {
            try {
              var b = JSON.parse(localStorage.getItem(k));
              return { key: k, created: b.created, version: b.version,
                       trades: JSON.parse(b.trades || '[]').length };
            } catch(e) { return { key: k, created: null }; }
          }).sort(function (a, b) { return b.key > a.key ? -1 : 1; });
      } catch(e) { return []; }
    },

    restoreBackup: function (ts) {
      try {
        var key = 'geodash_backup_' + ts;
        var raw = localStorage.getItem(key);
        if (!raw) { alert('Backup not found: ' + key); return; }
        var b = JSON.parse(raw);
        var tradeCount = JSON.parse(b.trades || '[]').length;
        if (!confirm('Restore backup from ' + b.created + ' (' + tradeCount + ' trades)?\n\nCurrent state will be overwritten. Page will reload.')) return;
        try { localStorage.setItem(CFG_KEY,          b.cfg);         } catch(e) {}
        try { localStorage.setItem(TRADES_KEY,        b.trades);     } catch(e) {}
        try { localStorage.setItem(SIGLOG_KEY,        b.sigLog);     } catch(e) {}
        try { localStorage.setItem(PNL_HISTORY_KEY,   b.pnlHistory); } catch(e) {}
        window.location.reload();
      } catch(e) { alert('Restore failed: ' + (e.message || String(e))); }
    },

    /* ── Future broker integration (stubs) ── */
    connectBroker: connectBroker,

    /* ── Data access for external scripts / debugging ── */
    getOpenTrades:  function () { return openTrades().slice(); },
    getAllTrades:    function () { return _trades.slice(); },

    /* ── v60: Memory stats — call EE.memStats() in console to inspect sizes ── */
    memStats: function () {
      return {
        log:           _log.length,
        trades:        _trades.length,
        tradesOpen:    openTrades().length,
        tradesClosed:  _trades.filter(function(t){ return t.status !== 'OPEN'; }).length,
        signalLog:     _signalLog.length,
        pnlHistory:    _pnlHistory.length,
        priceCache:    Object.keys(_priceCache).length,
        backendPrices: Object.keys(_backendPrices).length,
        livePrice:     Object.keys(_livePrice).length,
        priceFeedHealth: Object.keys(_priceFeedHealth).length
      };
    },

    /* ── Unrealised P&L for open trades using latest live prices ── */
    unrealisedPnl: function () {
      var result = [];
      openTrades().forEach(function (t) {
        var px = _livePrice[t.trade_id] || null;
        if (!px) return;
        var pct = t.direction === 'LONG'
          ? (px - t.entry_price) / t.entry_price * 100
          : (t.entry_price - px) / t.entry_price * 100;
        var usd = t.units * Math.abs(px - t.entry_price) * (pct >= 0 ? 1 : -1);
        result.push({ trade_id: t.trade_id, signal_id: t.signal_id, asset: t.asset,
                      pct: Math.round(pct * 100) / 100, usd: Math.round(usd * 100) / 100 });
      });
      return result;
    },
    getConfig:      function () { return Object.assign({}, _cfg); },
    exportJSON:     function () {
      var blob = new Blob([JSON.stringify(_trades, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ee_trades_' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(a.href);
    },

    exportCSV:      function () {
      // Build CSV: closed trades ordered newest-first
      var cols = [
        'trade_id','asset','direction','status','confidence',
        'entry_price','stop_loss','take_profit','close_price',
        'pnl_pct','pnl_usd','close_reason',
        'timestamp_open','timestamp_close',
        'units','size_usd','region','reason','kelly_mult'
      ];
      var rows = [cols.join(',')];
      _trades.forEach(function (t) {
        rows.push(cols.map(function (c) {
          var v = t[c];
          if (v === null || v === undefined) return '';
          // Wrap strings with commas or quotes in double-quotes
          var s = String(v);
          if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
            s = '"' + s.replace(/"/g, '""') + '"';
          }
          return s;
        }).join(','));
      });
      var blob = new Blob([rows.join('\n')], { type: 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ee_trades_' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(a.href);
    },

    render: renderUI,

    /* ── External price injection — called by hl-feed.js (and any future feed) ── */
    /* Pushes a real-time price into the cache and live-price map so monitorTrades  */
    /* uses fresh data without waiting for the next HTTP poll cycle.                */
    injectPrice: function (asset, price) {
      if (!asset || !price || price <= 0 || !isFinite(price)) return;
      var tok = normaliseAsset(asset);
      _cacheSet(tok, price);
      // Mark HL feed health as ok whenever a price is injected from HL.
      // Without this the feed dot stays grey even when the WS is streaming.
      if (window.HLFeed && typeof HLFeed.covers === 'function' && HLFeed.covers(tok)) {
        _priceFeedHealth['hl'] = { ok: true, lastOk: Date.now(),
          lastFail: (_priceFeedHealth['hl'] || {}).lastFail || null };
      }
      // Also set any aliases so all spelling variants get the update
      // Note: BRENT intentionally excluded — Brent and WTI are separate instruments
      // ($3-5 spread) and must not share a price cache entry.
      var aliasMap = { 'OIL': 'WTI', 'CRUDE': 'WTI', 'XAU': 'GOLD', 'XAG': 'SILVER' };
      if (aliasMap[tok]) _cacheSet(aliasMap[tok], price);
      if (aliasMap[tok] === 'WTI' || tok === 'WTI') { _cacheSet('WTI', price); _cacheSet('OIL', price); }
      // Push to live-price map for all open trades on this asset
      _trades.forEach(function (t) {
        if (t.status === 'OPEN' && normaliseAsset(t.asset) === tok) {
          _livePrice[t.trade_id] = price;
        }
      });
    },

    /* ── Toggle full closed-trade history in the UI ── */
    toggleAllClosed: function () {
      _showAllClosed = !_showAllClosed;
      renderClosedTrades();
    },
    toggleSigLogSession: function () {
      _sigLogSessionOnly = !_sigLogSessionOnly;
      renderSigLog();
    },
    toggleClosedSession: function () {
      _closedSessionOnly = !_closedSessionOnly;
      renderClosedTrades();
    },

    /* ── Browser notification permission ── */
    requestNotifications: function () {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'granted') {
        // Already granted — show a test notification
        try {
          new Notification('✅ EE Alerts active', {
            body: 'You will be notified when a trade hits TP or SL.',
            tag: 'ee-test-notif'
          });
        } catch (e) {}
        return;
      }
      Notification.requestPermission().then(function (perm) {
        var btn = document.getElementById('eeNotifBtn');
        if (perm === 'granted') {
          if (btn) { btn.style.color = 'var(--green, #00e676)'; btn.style.borderColor = 'var(--green, #00e676)'; btn.textContent = '🔔 Alerts ON'; }
          try { new Notification('✅ EE Alerts active', { body: 'You will be notified on TP/SL hits.', tag: 'ee-test-notif' }); } catch (e) {}
        } else {
          if (btn) { btn.textContent = '🔕 Blocked'; }
        }
      });
    },

    saveBackendUrl: function () {
      var input  = document.getElementById('eeBackendUrl');
      var status = document.getElementById('eeBackendUrlStatus');
      if (!input) return;
      var url = input.value.trim().replace(/\/$/, '');
      if (!url) {
        // Clear saved URL — revert to Render default
        try { localStorage.removeItem(_BACKEND_URL_KEY); } catch (e) {}
        _API_BASE = 'https://geo-dashboard-2okm.onrender.com';
        _apiOnline = false;
        _backendChecked = false;
        input.style.borderColor = 'var(--border)';
        if (status) { status.textContent = 'Cleared — using Render default'; status.style.color = 'var(--dim)'; }
        return;
      }
      if (!/^https?:\/\//.test(url)) url = 'https://' + url;
      _API_BASE = url;
      try { localStorage.setItem(_BACKEND_URL_KEY, url); } catch (e) {}
      _apiOnline = false;
      _backendChecked = false;
      input.style.borderColor = 'var(--amber)';
      if (status) { status.textContent = 'Connecting…'; status.style.color = 'var(--amber)'; }
      // Ping the new URL
      fetch(url + '/api/status', { headers: { 'Content-Type': 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function () {
          _apiOnline = true;
          _backendChecked = true;
          input.style.borderColor = 'var(--green, #00e676)';
          if (status) { status.textContent = '● Connected'; status.style.color = 'var(--green, #00e676)'; }
          log('SYSTEM', 'Backend connected: ' + url, 'green');
          // Re-run startup sync now that backend is online
          _apiInit();
        })
        .catch(function () {
          _apiOnline = false;
          _backendChecked = true;
          input.style.borderColor = 'var(--red)';
          if (status) { status.textContent = '✗ Unreachable — check URL'; status.style.color = 'var(--red)'; }
          log('SYSTEM', 'Backend unreachable: ' + url, 'red');
        });
    }
  };

  /* ══════════════════════════════════════════════════════════════════════════════
     INITIALISATION
     ══════════════════════════════════════════════════════════════════════════════ */

  function init() {
    if (_initialised) return;   // guard against duplicate intervals if called twice
    _initialised = true;

    loadCfg();
    loadTrades();
    loadSigLog();
    loadPnlHistory();
    _loadFlaggedTrades();

    // Populate backend URL input with saved value (if any)
    try {
      var savedUrl = localStorage.getItem(_BACKEND_URL_KEY);
      var urlInput = document.getElementById('eeBackendUrl');
      if (urlInput) urlInput.value = savedUrl || '';
    } catch (e) {}

    // Session start — restore from localStorage so it survives page reloads
    // but gets wiped by analyticsReset/fullReset (they clear geodash_* keys)
    var storedSession = null;
    try { storedSession = localStorage.getItem('geodash_session_start_v1'); } catch(e) {}
    _sessionStart = storedSession || new Date().toISOString();
    try { localStorage.setItem('geodash_session_start_v1', _sessionStart); } catch(e) {}

    // Record balance at session start for daily loss limit tracking.
    // v63: persist to localStorage so page reloads don't reset the baseline —
    // otherwise a reload after a 3% loss lets the engine lose another 5% (8% total).
    var _todayKey = new Date().toISOString().slice(0, 10);   // 'YYYY-MM-DD' UTC
    var _savedSBal = null;
    try {
      var _sbRaw = localStorage.getItem('geodash_session_balance_v1');
      if (_sbRaw) {
        var _sb = JSON.parse(_sbRaw);
        if (_sb && _sb.date === _todayKey && typeof _sb.balance === 'number') _savedSBal = _sb.balance;
      }
    } catch(e) {}
    if (_savedSBal !== null) {
      _sessionStartBalance = _savedSBal;   // reload mid-session — restore today's opening balance
      log('RISK', 'Session balance restored from today\'s open: $' + _savedSBal.toFixed(2), 'dim');
    } else {
      _sessionStartBalance = _cfg.virtual_balance;
      try { localStorage.setItem('geodash_session_balance_v1', JSON.stringify({ date: _todayKey, balance: _sessionStartBalance })); } catch(e) {}
    }

    /* Auto-start: honour the auto_start config flag (M6).
       Defaults to true (original behaviour) — set auto_start: false to keep
       auto-execution OFF on page load (e.g. review mode).                    */
    if (_cfg.auto_start !== false) {
      _cfg.enabled = true;
    }
    saveCfg();

    // Autosave safety net — belt-and-suspenders every 7 s
    setInterval(function () { saveTrades(); saveCfg(); }, 7000);

    // Record starting balance for P&L timeline
    _recordPnlSnapshot('load', 0);

    // First monitor at 9s: HL-Feed connects at 6s + ~1-2s for WS handshake and first
    // allMids message. Waiting until 9s ensures the first stop/TP check has real prices.
    setTimeout(monitorTrades, 9000);
    setInterval(monitorTrades, 30000);  // then every 30 s
    _startBinanceWS();                  // BTC fallback feed — yields to HL when live

    /* Re-scan loop: every 5 minutes re-process the last IC signal batch.
       Only re-evaluates signals for assets that have no open trade AND whose
       cooldown has expired — prevents re-opening a trade that was just closed. */
    setInterval(function () {
      if (!_cfg.enabled || !_lastSignals.length) return;
      var now  = Date.now();
      var open = openTrades();
      var freshSigs = _lastSignals.filter(function (s) {
        var asset = normaliseAsset(s.asset);
        // Skip WATCH-direction signals — informational only, not tradeable.
        if (s.dir === 'WATCH') return false;
        // Skip signals already successfully traded in _signalLog (same asset+dir).
        // After cooldown expires the re-scan would otherwise re-open a position for a
        // signal that was already executed and then closed — a stale IC batch.
        // Time-bounded to 2 hours: a TRADED entry older than 2h is a different market
        // event; a fresh IC signal for the same asset should be allowed through.
        var _2h = 2 * 60 * 60 * 1000;
        if (_signalLog.some(function (e) {
          return normaliseAsset(e.asset) === asset && e.dir === s.dir && e.action === 'TRADED' &&
                 (now - new Date(e.ts).getTime()) < _2h;
        })) return false;
        // Skip if we already have an open trade for this asset.
        // Also check original_asset (pre-remap): GII_ROUTING maps GLD→XAU at signal
        // time. The open trade stores asset='XAU', but _lastSignals still has 'GLD'.
        // Without checking original_asset, the re-scan would re-fire the GLD signal
        // and open a second XAU position while the first is still live.
        if (open.some(function (t) {
          return normaliseAsset(t.asset) === asset ||
                 (t.original_asset && normaliseAsset(t.original_asset) === asset);
        })) return false;
        // Skip if still in cooldown (trade was recently closed or opened)
        var cd = _cooldown[asset] || _cooldown[normaliseAsset(s.original_asset || '')];
        return !cd || (now - cd) > _cfg.cooldown_ms;
      });
      if (freshSigs.length) {
        log('SCAN', 'Periodic re-scan — ' + freshSigs.length + '/' + _lastSignals.length + ' signal(s) eligible', 'dim');
        onSignals(freshSigs);
      }
    }, 300000);  // 5 minutes

    // Update notification button state based on existing permission
    (function () {
      var btn = document.getElementById('eeNotifBtn');
      if (!btn || typeof Notification === 'undefined') return;
      if (Notification.permission === 'granted') {
        btn.style.color = 'var(--green, #00e676)';
        btn.style.borderColor = 'var(--green, #00e676)';
        btn.textContent = '🔔 Alerts ON';
      } else if (Notification.permission === 'denied') {
        btn.textContent = '🔕 Blocked';
        btn.disabled = true;
      }
    })();

    renderUI();
    log('SYSTEM', 'Execution Engine v1.0 ready — ' + _cfg.mode + ' mode  |  ' +
        'Auto-scan ALWAYS ON  |  ' + openTrades().length + ' open trade(s) restored', 'green');

    // Async: connect to SQLite backend, migrate localStorage data if needed
    _apiInit();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
