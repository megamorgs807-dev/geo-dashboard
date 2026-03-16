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
  var CFG_KEY     = 'geodash_ee_config_v2';
  var TRADES_KEY  = 'geodash_ee_trades_v1';
  var SIGLOG_KEY  = 'geodash_ee_siglog_v1';

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
    min_confidence:        65,           // minimum IC confidence % to auto-execute
    virtual_balance:       1000,         // starting virtual balance (USD)
    risk_per_trade_pct:    3,            // % of balance risked per trade
    stop_loss_pct:         3,            // % distance from entry for stop-loss
    take_profit_ratio:     2,            // R:R multiplier (TP = SL distance × ratio)
    max_open_trades:       8,            // max concurrent open trades
    max_per_region:        3,            // max open trades per geopolitical region
    max_per_sector:        2,            // max open trades per asset sector (energy, crypto, etc.)
    max_exposure_pct:      30,           // max % of balance in open positions
    cooldown_ms:           120000,       // 2 min cooldown between same-asset signals
    broker:                'SIMULATION', // future: 'BINANCE' | 'ALPACA' | 'POLYMARKET'
    auto_start:            true,         // if false, auto-execution stays OFF on page load
    max_siglog:            200,          // max entries kept in signal log
    // ── Risk management additions ──────────────────────────────────────────────
    trailing_stop_enabled: true,         // move stop up as price moves in favour
    trailing_stop_pct:     1.5,          // trail distance as % of entry price
    break_even_enabled:    true,         // move stop to entry once 50% to TP
    partial_tp_enabled:    true,         // take 50% profit at TP1 (midpoint to TP)
    daily_loss_limit_pct:  5,            // pause if session P&L drops below -5%
    event_gate_enabled:    true,         // block new trades near major calendar events
    event_gate_hours:      0.5           // hours before event to block (0.5 = 30min)
  };

  /* ── Sector map — used for max_per_sector concentration cap ──────────────── */
  var EE_SECTOR_MAP = {
    'WTI':'energy',   'BRENT':'energy', 'XLE':'energy',  'XOM':'energy',   'GAS':'energy',
    'XAU':'precious', 'GLD':'precious', 'SLV':'precious',
    'XAR':'defense',  'LMT':'defense',  'RTX':'defense',  'NOC':'defense',
    'BTC':'crypto',   'ETH':'crypto',   'SOL':'crypto',   'BNB':'crypto',   'ADA':'crypto',
    'SPY':'equity',   'QQQ':'equity',   'VIX':'equity',   'EEM':'equity',   'FXI':'equity',
    'SMH':'semis',    'TSM':'semis',    'NVDA':'semis',   'ASML':'semis',
    'WHT':'agri',     'CORN':'agri',    'SOYB':'agri',
    'DAL':'airlines', 'UAL':'airlines',
    'LIT':'battery',  'COPX':'metals',  'XME':'metals',
    'JPY':'forex',    'CHF':'forex',    'NOK':'forex',    'GBP':'forex',
    'INDA':'em',      'TSLA':'ev'
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
  var _cfg         = {};   // active config (merged DEFAULTS + localStorage)
  var _trades      = [];   // all trades: open + closed
  var _cooldown    = {};   // asset → timestamp of last signal processed
  var _log         = [];   // activity log entries
  var _seq         = 0;    // ID sequence counter
  var _livePrice   = {};   // trade_id → most-recently fetched market price
  var _lastSignals = [];   // most recent IC signal batch — used by the re-scan loop
  var _signalLog   = [];   // full history of every IC signal seen (capped at 200)
  var _pendingOpen = {};   // asset → true while a fetchPrice is in-flight (prevents duplicate opens)
  var _initialised = false; // reentrancy guard — prevents duplicate intervals if init() called twice
  var _showAllClosed        = false; // UI toggle: show all closed trades vs capped at 25
  var _closedSessionOnly    = false; // UI toggle: show only this-session closed trades
  var _sessionStartBalance  = null;  // balance at session start — for daily loss limit
  var _lossStreak           = 0;     // consecutive losses counter — for streak sizing
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
    'VIX':     '^VIX'
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
      _trades = raw ? JSON.parse(raw) : [];
    } catch (e) { _trades = []; }
  }

  function saveTrades() {
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
    return String(asset || '').toUpperCase().replace(/[^A-Z0-9]/g, ' ').trim().split(' ')[0];
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
  var _TICKER_ALIASES = { 'GLD':'GOLD', 'XAU':'GOLD', 'XAG':'SILVER', 'SLV':'SILVER', 'OIL':'WTI', 'CRUDE':'WTI', 'BRENT':'OIL', 'GAS':'NATGAS' };
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

    if (open.some(function (t) { return t.asset === sig.asset; }))
      return { ok: false, reason: 'Already have open trade for ' + sig.asset };

    // Pending lock: fetchPrice is async — block second signal for same asset while first is in flight
    if (_pendingOpen[normaliseAsset(sig.asset)])
      return { ok: false, reason: 'Price fetch already in progress for ' + sig.asset };

    // Correlation guard: block if a correlated asset is already open in the same direction
    var corrGroup = _getCorrGroup(sig.asset);
    if (corrGroup) {
      var corrConflict = open.find(function (t) {
        return corrGroup.indexOf(t.asset) !== -1 && t.direction === sig.dir;
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
    var exposure = open.reduce(function (s, t) {
      var slDist = Math.abs((t.entry_price || 0) - (t.stop_loss || 0));
      return s + (slDist > 0 ? (t.units || 0) * slDist : 0);
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

    // Position sizing: base risk scaled by signal impact strength
    // sig.impactMult (0.5–2.0) comes from the IMPACT_MAP scorer in renderTrades()
    // Minor event → 0.5× normal size; major event → up to 2× normal size
    var impactMult = (sig.impactMult && isFinite(sig.impactMult))
      ? Math.max(0.5, Math.min(2.0, sig.impactMult))
      : 1.0;

    // EV/Kelly adjustment: if self-learning has a win rate on this asset+direction,
    // scale size by a simplified Kelly fraction (capped to 0.5× – 1.5× of base risk).
    // Kelly f* = (W * R - L) / R  where W=winRate, L=1-W, R=TP:SL ratio
    // We use a half-Kelly approach (×0.5) for safety, and require ≥5 trades of history.
    var kellyMult = 1.0;
    if (window.GII && typeof GII.agentReputations === 'function') {
      var reps = GII.agentReputations();
      var assetKey = normaliseAsset(sig.asset);
      var biasKey  = dir === 'LONG' ? 'long' : 'short';
      // Find any feedback entry matching this asset+direction
      var repEntry = null;
      Object.keys(reps).forEach(function (k) {
        if (k.indexOf(assetKey) !== -1 && k.indexOf(biasKey) !== -1 && reps[k].total >= 5) {
          repEntry = reps[k];
        }
      });
      if (repEntry && typeof repEntry.winRate === 'number') {
        var W = repEntry.winRate;
        var R = _cfg.take_profit_ratio;   // reward:risk ratio
        var kelly = (W * R - (1 - W)) / R;
        if (kelly > 0) {
          // Half-Kelly, clamped between 0.5 and 1.5
          kellyMult = Math.max(0.5, Math.min(1.5, kelly * 0.5 / 0.25));   // normalise: base kelly ~0.25 = mult 1.0
        } else {
          kellyMult = 0.5;   // negative EV → halve position size
        }
      }
    }

    // Loss streak sizing: halve risk after 3+ consecutive losses, 75% after 2
    var streakMult = _lossStreak >= 3 ? 0.50 : _lossStreak >= 2 ? 0.75 : 1.0;
    if (streakMult < 1.0) {
      // Logged on open so the user can see why size is reduced
    }

    var riskAmt  = _cfg.virtual_balance * _cfg.risk_per_trade_pct / 100 * impactMult * kellyMult * streakMult;
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
      // ── Trailing / break-even / partial TP state ────────────────────────────
      trailing_stop_active: false,   // activated once break-even is hit
      highest_price:        null,    // LONG: tracks peak price for trail
      lowest_price:         null,    // SHORT: tracks trough price for trail
      break_even_done:      false,   // true once stop moved to entry
      partial_tp_taken:     false,   // true once TP1 partial close fired
      partial_tp_price:     null,    // price at which partial was taken
      partial_pnl_usd:      null,    // P&L banked from partial close
      // ────────────────────────────────────────────────────────────────────────
      broker:           _cfg.mode === 'LIVE' ? _cfg.broker : 'SIMULATION',
      // Broker integration stubs — set by adapter on live execution
      broker_order_id:  null,
      broker_status:    null,
      // Entry thesis fingerprint — stored by gii-entry for exit validation
      thesis:           sig.thesis || null
    };
  }

  /* Open a trade: build object, persist, sync HRS, log */
  function openTrade(sig, entryPrice) {
    var trade = buildTrade(sig, entryPrice);
    _trades.unshift(trade);
    _cooldown[sig.asset] = Date.now();
    saveTrades();
    _apiPostTrade(trade);   // async push to SQLite (fire-and-forget)

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
      '  Conf:' + trade.confidence + '%' +
      (trade.streak_mult < 1 ? '  ⚠ streak×' + trade.streak_mult : ''),
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
        // TP/SL are unambiguous; manual closes within ±$5 of breakeven are neutral
        // (avoids inflating win rate from near-zero P&L manual exits)
        var outcome;
        if (reason === 'TAKE_PROFIT') {
          outcome = 'hit';
        } else if (reason === 'STOP_LOSS') {
          outcome = 'miss';
        } else {
          var pnlAbs = Math.abs(trade.pnl_usd || 0);
          outcome = pnlAbs < 5 ? 'neutral'
                  : (trade.pnl_usd >= 0) ? 'hit' : 'miss';
        }
        HRS.evaluate(hrsSig.signal_id, outcome, closePrice);
      }
    }

    saveTrades();
    // Async push updated trade to SQLite (fire-and-forget)
    _apiPatchTrade(trade.trade_id, {
      status:          trade.status,
      close_price:     trade.close_price,
      timestamp_close: trade.timestamp_close,
      close_reason:    trade.close_reason,
      pnl_pct:         trade.pnl_pct,
      pnl_usd:         trade.pnl_usd
    });

    log('CLOSED',
      trade.asset + ' ' + trade.direction +
      ' → ' + reason +
      ' @ ' + _num(closePrice) +
      '  P&L: ' + (trade.pnl_pct >= 0 ? '+' : '') + trade.pnl_pct + '%' +
      '  (' + (trade.pnl_usd >= 0 ? '+$' : '-$') + _num(Math.abs(trade.pnl_usd)) + ')',
      trade.pnl_pct >= 0 ? 'green' : 'red');

    // Browser notification for TP/SL hits (only when tab is not visible)
    if ((reason === 'TAKE_PROFIT' || reason === 'STOP_LOSS') &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted') {
      var isTP   = reason === 'TAKE_PROFIT';
      var sign   = trade.pnl_usd >= 0 ? '+' : '-';
      var pnlStr = sign + '$' + _num(Math.abs(trade.pnl_usd)) +
                   ' (' + (trade.pnl_pct >= 0 ? '+' : '') + trade.pnl_pct + '%)';
      try {
        new Notification(
          (isTP ? '✅ Take Profit' : '❌ Stop Loss') + ' — ' + trade.asset,
          {
            body: trade.direction + ' closed @ ' + _num(closePrice) + '\nP&L: ' + pnlStr,
            icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="' + (isTP ? '%2300e676' : '%23ff1744') + '"/></svg>',
            tag: 'ee-trade-' + trade.trade_id,
            requireInteraction: false
          }
        );
      } catch (e) { /* notification may fail silently */ }
    }

    // Update loss streak counter (used for position sizing on future trades)
    if (trade.pnl_usd > 0) {
      if (_lossStreak > 0) log('RISK', 'Loss streak ended at ' + _lossStreak + ' — full size restored', 'green');
      _lossStreak = 0;
    } else {
      _lossStreak++;
      if (_lossStreak >= 3)      log('RISK', 'Streak ' + _lossStreak + ' losses — position size halved until next win', 'red');
      else if (_lossStreak >= 2) log('RISK', 'Streak ' + _lossStreak + ' losses — position size at 75%', 'amber');
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
          sessionLossPct.toFixed(1) + '%) — auto-execution paused', 'red');
        _notify('⛔ Daily Loss Limit Hit',
          'Session P&L: ' + sessionLossPct.toFixed(1) + '% — auto-execution paused',
          'ee-daily-limit');
        renderUI();
      }
    }

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

        // ── Partial TP1: take 50% at halfway to full TP ─────────────────────
        if (_cfg.partial_tp_enabled && !trade.partial_tp_taken) {
          var tp1 = isLong
            ? trade.entry_price + 0.5 * (trade.take_profit - trade.entry_price)
            : trade.entry_price - 0.5 * (trade.entry_price - trade.take_profit);
          var hitTP1 = isLong ? (price >= tp1) : (price <= tp1);
          if (hitTP1) {
            var closedUnits  = trade.units * 0.5;
            var pnlPerUnit   = isLong ? (price - trade.entry_price) : (trade.entry_price - price);
            var partialPnl   = +(closedUnits * pnlPerUnit).toFixed(2);
            trade.partial_tp_taken  = true;
            trade.partial_tp_price  = +price.toFixed(6);
            trade.partial_pnl_usd   = partialPnl;
            trade.units             = +(trade.units * 0.5).toFixed(6);
            trade.size_usd          = +(trade.units * price).toFixed(2);
            // Move stop to entry ± tiny buffer (break-even)
            var beStop = isLong
              ? +(trade.entry_price * 1.001).toFixed(6)
              : +(trade.entry_price * 0.999).toFixed(6);
            trade.stop_loss        = beStop;
            trade.break_even_done  = true;
            trade.trailing_stop_active = true;
            // Bank partial P&L into balance
            _cfg.virtual_balance  += partialPnl;
            saveCfg();
            saved = true;
            log('PARTIAL',
              trade.asset + ' 50% TP @ ' + _num(price) +
              '  Banked: +$' + _num(partialPnl) + '  SL→breakeven', 'green');
            _notify('🎯 Partial TP — ' + trade.asset,
              '50% closed @ ' + _num(price) + ' (+$' + _num(partialPnl) + ')\nStop moved to break-even.',
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
            var newBEStop = isLong
              ? +(trade.entry_price * 1.001).toFixed(6)
              : +(trade.entry_price * 0.999).toFixed(6);
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
        if (_cfg.trailing_stop_enabled && trade.trailing_stop_active) {
          var trailDist = trade.entry_price * (_cfg.trailing_stop_pct / 100);
          if (isLong) {
            var newHigh = Math.max(price, trade.highest_price || price);
            trade.highest_price = newHigh;
            var trailedStop = +(newHigh - trailDist).toFixed(6);
            if (trailedStop > trade.stop_loss) {
              trade.stop_loss = trailedStop;
              saved = true;
            }
          } else {
            var newLow = Math.min(price, trade.lowest_price || price);
            trade.lowest_price = newLow;
            var trailedStopS = +(newLow + trailDist).toFixed(6);
            if (trailedStopS < trade.stop_loss) {
              trade.stop_loss = trailedStopS;
              saved = true;
            }
          }
        }

        if (saved) saveTrades();

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
            _cacheSet('BTC', price);
            _cacheSet('BITCOIN', price);
            _priceFeedHealth['ws_binance'] = { ok: true, lastOk: Date.now(), lastFail: null };
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
        log('SYSTEM', 'Binance WebSocket connected — real-time BTC price active', 'green');
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
    if (_log.length > 60) _log.pop();
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
    var realisedPnl = sessionClosed.reduce(function (s, t) { return s + (t.pnl_usd || 0); }, 0);

    // Unrealised P&L from open trades using live prices
    var unrealisedPnl = 0;
    openTrades().forEach(function (t) {
      var px = _livePrice[t.trade_id] || _priceCache[normaliseAsset(t.asset)] || null;
      if (!px) return;
      var diff = t.direction === 'LONG' ? (px - t.entry_price) : (t.entry_price - px);
      unrealisedPnl += t.units * diff;
    });

    var startBalance = DEFAULTS.virtual_balance;
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
                  'virtual_balance','trailing_stop_pct','daily_loss_limit_pct','event_gate_hours'];
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
      if (_lossStreak === 0) {
        streakEl.textContent = '';
        streakEl.style.display = 'none';
      } else {
        streakEl.style.display = 'inline';
        var mult = _lossStreak >= 3 ? '½ size' : '¾ size';
        streakEl.textContent = '⚠ ' + _lossStreak + ' loss streak — ' + mult;
        streakEl.style.color = _lossStreak >= 3 ? 'var(--red)' : 'var(--amber)';
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
      if (livePx) {
        var uPct = t.direction === 'LONG'
          ? (livePx - t.entry_price) / t.entry_price * 100
          : (t.entry_price - livePx) / t.entry_price * 100;
        var uUsd = t.units * Math.abs(livePx - t.entry_price) * (uPct >= 0 ? 1 : -1);
        var uCol = uPct >= 0 ? '#00c8a0' : '#ff4444';
        // Distance to SL and TP as % of entry
        var slDist = Math.abs(livePx - t.stop_loss)   / t.entry_price * 100;
        var tpDist = Math.abs(t.take_profit - livePx) / t.entry_price * 100;
        liveRow =
          '<div style="font-size:9px;margin:5px 0 0 0;padding-top:5px;border-top:1px solid rgba(255,255,255,0.07)">' +
            'Live: <b style="color:var(--text)">$' + _num(livePx) + '</b>' +
            '&nbsp;&nbsp;Unrealised: ' +
            '<b style="color:' + uCol + '">' +
              (uPct >= 0 ? '+' : '') + uPct.toFixed(2) + '%&thinsp;' +
              '(' + (uUsd >= 0 ? '+$' : '-$') + _num(Math.abs(uUsd)) + ')' +
            '</b>' +
            '&nbsp;&nbsp;<span style="color:var(--dim)">SL&nbsp;' + slDist.toFixed(1) + '% away' +
            '&nbsp;·&nbsp;TP&nbsp;' + tpDist.toFixed(1) + '% away</span>' +
          '</div>';
      } else {
        liveRow =
          '<div style="font-size:9px;margin:5px 0 0 0;padding-top:5px;border-top:1px solid rgba(255,255,255,0.07);color:var(--dim)">' +
            'Unrealised P&amp;L: <span style="color:#888">awaiting price feed&hellip;</span>' +
          '</div>';
      }

      return '<div class="ee-trade-card">' +
        '<div class="ee-tc-hdr">' +
          '<span class="' + dirCls + '">' + t.direction + '</span>' +
          '<span class="ee-tc-asset">' + _esc(t.asset) + '</span>' +
          '<span class="ee-tc-conf">' + t.confidence + '%</span>' +
          '<span class="ee-tc-age">' + _age(t.timestamp_open) + '</span>' +
          '<span class="ee-tc-mode ' + (t.mode === 'LIVE' ? 'live' : 'sim') + '">' + t.mode + '</span>' +
        '</div>' +
        '<div class="ee-tc-prices">' +
          (t.entry_price === 100 ? '<div style="font-size:9px;color:#ff9500;margin-bottom:4px">⚠️ Entry price unavailable at open — P&amp;L unreliable. Consider closing &amp; re-entering.</div>' : '') +
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
      var icon    = t.close_reason === 'TAKE_PROFIT' ? '\u2713' : t.close_reason === 'STOP_LOSS' ? '\u2717' : '\u2014';
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
      if (t.close_reason === 'TAKE_PROFIT') {
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
      scalperStats: scalperStats, openScalpers: openScalpers
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
          if (t.close_reason === 'TAKE_PROFIT') assetStats[k].wins++;
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
        trailing_stop_pct:    { min: 0.1, max: 10,       int: false },
        daily_loss_limit_pct: { min: 1,   max: 20,       int: false },
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
        closeTrade(tradeId, price || trade.entry_price, 'MANUAL');
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
        closeTrade(tradeId, price || trade.entry_price, reason || 'GII-EXIT');
      });
      return true;
    },

    /* ── gii-exit: get last known price for an asset from the price cache ── */
    getLastPrice: function (asset) {
      if (!asset) return null;
      var token = _normaliseToken(asset);
      var price = _priceCache[token];
      return (price && isFinite(price)) ? price : null;
    },

    /* ── Reset virtual balance to $10,000 ── */
    resetBalance: function () {
      if (!confirm('Reset virtual balance to $1,000? This will not affect trade history.')) return;
      _cfg.virtual_balance = DEFAULTS.virtual_balance;
      saveCfg();
      log('CONFIG', 'Virtual balance reset to $' + DEFAULTS.virtual_balance, 'amber');
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

    /* ── Full reset — wipes everything and starts fresh ── */
    fullReset: function () {
      if (!confirm('Full reset: close ALL open trades, clear all history and reset balance to $' + DEFAULTS.virtual_balance + '?\n\nThis cannot be undone.')) return;
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

    /* ── Future broker integration (stubs) ── */
    connectBroker: connectBroker,

    /* ── Data access for external scripts / debugging ── */
    getOpenTrades:  function () { return openTrades().slice(); },
    getAllTrades:    function () { return _trades.slice(); },

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

    // Record balance at session start for daily loss limit tracking
    _sessionStartBalance = _cfg.virtual_balance;

    /* Auto-start: honour the auto_start config flag (M6).
       Defaults to true (original behaviour) — set auto_start: false to keep
       auto-execution OFF on page load (e.g. review mode).                    */
    if (_cfg.auto_start !== false) {
      _cfg.enabled = true;
    }
    saveCfg();

    setTimeout(monitorTrades, 2000);    // first price-check 2 s after load
    setInterval(monitorTrades, 30000);  // then every 30 s
    _startBinanceWS();                  // real-time BTC price feed (WebSocket)

    /* Re-scan loop: every 5 minutes re-process the last IC signal batch.
       Only re-evaluates signals for assets that have no open trade AND whose
       cooldown has expired — prevents re-opening a trade that was just closed. */
    setInterval(function () {
      if (!_cfg.enabled || !_lastSignals.length) return;
      var now  = Date.now();
      var open = openTrades();
      var freshSigs = _lastSignals.filter(function (s) {
        var asset = normaliseAsset(s.asset);
        // Skip if we already have an open trade for this asset
        if (open.some(function (t) { return normaliseAsset(t.asset) === asset; })) return false;
        // Skip if still in cooldown (trade was recently closed or opened)
        var cd = _cooldown[asset];
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
