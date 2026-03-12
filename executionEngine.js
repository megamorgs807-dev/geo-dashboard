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
  var CFG_KEY     = 'geodash_ee_config_v1';
  var TRADES_KEY  = 'geodash_ee_trades_v1';
  var SIGLOG_KEY  = 'geodash_ee_siglog_v1';

  /* ── Default risk configuration ────────────────────────────────────────────── */
  var DEFAULTS = {
    mode:                  'SIMULATION', // 'SIMULATION' | 'LIVE'
    enabled:               true,         // auto-execution always on by default
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
  var _cfg       = {};   // active config (merged DEFAULTS + localStorage)
  var _trades    = [];   // all trades: open + closed
  var _cooldown  = {};   // asset → timestamp of last signal processed
  var _log       = [];   // activity log entries
  var _seq       = 0;    // ID sequence counter
  var _livePrice   = {};   // trade_id → most-recently fetched market price
  var _lastSignals = [];   // most recent IC signal batch — used by the re-scan loop
  var _signalLog   = [];   // full history of every IC signal seen (capped at 200)

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
    'BA':      'BA',     // Boeing
    'XOM':     'XOM',    // ExxonMobil
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
  var _CACHE_TTL    = 25000; // 25 s — reuse within same 30-s monitor cycle

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

  function loadSigLog() {
    try {
      var raw = localStorage.getItem(SIGLOG_KEY);
      _signalLog = raw ? JSON.parse(raw) : [];
    } catch (e) { _signalLog = []; }
  }

  function saveSigLog() {
    try { localStorage.setItem(SIGLOG_KEY, JSON.stringify(_signalLog)); } catch (e) {}
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
    if (_signalLog.length > 200) _signalLog.length = 200;  // cap at 200
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

  var _CORS_PROXY = 'https://corsproxy.io/?';

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
      .catch(function () { cb(_priceCache[token] || null); });
  }

  /* Yahoo Finance chart API routed through corsproxy.io (CORS-open) */
  function _fetchYahoo(token, sym, cb) {
    if (_cacheFresh(token)) { cb(_priceCache[token] || null); return; }
    var yahooUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                   encodeURIComponent(sym) + '?interval=1m&range=1d';
    fetch(_CORS_PROXY + encodeURIComponent(yahooUrl))
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (data) {
        var meta  = data && data.chart && data.chart.result &&
                    data.chart.result[0] && data.chart.result[0].meta;
        var price = meta ? parseFloat(meta.regularMarketPrice) : NaN;
        if (!isNaN(price) && price > 0) {
          var isFirst = !_priceCache[token];
          _cacheSet(token, price);
          if (isFirst) log('PRICE', 'Yahoo → ' + sym + ' $' + price.toFixed(2), 'dim');
        }
        cb(!isNaN(price) && price > 0 ? price : (_priceCache[token] || null));
      })
      .catch(function () { cb(_priceCache[token] || null); });
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

    // 1. Binance — crypto USDT pairs (public, no key, CORS-open)
    if (PRICE_SOURCES[token]) {
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=' + PRICE_SOURCES[token])
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var price = parseFloat(d.price);
          if (!isNaN(price)) _cacheSet(token, price);
          cb(!isNaN(price) ? price : (_priceCache[token] || null));
        })
        .catch(function () { cb(_priceCache[token] || null); });
      return;
    }

    // 2. CoinGecko — gold (XAU via PAX Gold; 1 PAXG ≈ 1 troy oz)
    if (COINGECKO_SOURCES[token]) { _fetchCoinGecko(token, COINGECKO_SOURCES[token], cb); return; }

    // 3. corsproxy + Yahoo Finance — oil, silver, nat-gas, stocks, ETFs
    if (YAHOO_SOURCES[token]) { _fetchYahoo(token, YAHOO_SOURCES[token], cb); return; }

    // 4. Frankfurter — major forex spot rates (ECB data)
    if (FRANKFURTER_SOURCES[token]) { _fetchFrankfurter(token, FRANKFURTER_SOURCES[token], cb); return; }

    // 5. Dashboard live ticker (prices already shown on-page)
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

    // Position sizing: base risk scaled by signal impact strength
    // sig.impactMult (0.5–2.0) comes from the IMPACT_MAP scorer in renderTrades()
    // Minor event → 0.5× normal size; major event → up to 2× normal size
    var impactMult = (sig.impactMult && isFinite(sig.impactMult))
      ? Math.max(0.5, Math.min(2.0, sig.impactMult))
      : 1.0;
    var riskAmt  = _cfg.virtual_balance * _cfg.risk_per_trade_pct / 100 * impactMult;
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
    if (!sigs || !sigs.length) return;
    _lastSignals = sigs;                 // always cache — re-scan loop needs these

    sigs.forEach(function (sig) {
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

      // All checks passed — log as TRADED then fetch price and open
      _logSignal(sig, 'TRADED', null);
      fetchPrice(sig.asset, function (price) {
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

        // Store live price so renderOpenTrades() can show unrealised P&L
        _livePrice[trade.trade_id] = price;

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
    // Refresh strategy analytics panel
    renderAnalytics();
    // Refresh signal history + risk simulator
    renderSigLog();
    renderSim();
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
      var dirCls  = t.direction === 'LONG' ? 'ee-dir-long' : 'ee-dir-short';
      var livePx  = _livePrice[t.trade_id] || null;

      // Unrealised P&L row (only if we have a live price)
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
          'Entry: <b>' + _num(t.entry_price) + '</b>' +
          ' &nbsp; <span class="ee-tc-sl">SL: ' + _num(t.stop_loss) + '</span>' +
          ' &nbsp; <span class="ee-tc-tp">TP: ' + _num(t.take_profit) + '</span>' +
          ' &nbsp; Size: $' + _num(t.size_usd) +
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

  /* ── Signal History Log ─────────────────────────────────────────────────────── */

  function renderSigLog() {
    var el = document.getElementById('eeSigLog');
    if (!el) return;
    if (!_signalLog.length) {
      el.innerHTML = '<div class="ee-placeholder">No signals seen yet — waiting for IC cycle.</div>';
      return;
    }
    el.innerHTML = _signalLog.slice(0, 50).map(function (e) {
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

    return {
      closed: closed.length, equity: equity,
      maxDDPct: maxDDPct, maxDDUsd: maxDDUsd,
      avgWinPct: avgWinPct, avgLossPct: avgLossPct,
      avgWinUsd: avgWinUsd, avgLossUsd: avgLossUsd,
      profitFactor: profitFactor, expectancy: expectancy,
      wrDay: wrDay, wrWeek: wrWeek, wrAll: wrAll,
      avgDur: avgDur, minDur: minDur, maxDur: maxDur,
      assetMap: assetMap, regionMap: regionMap, buckets: buckets
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

    var regionItems = Object.keys(a.regionMap).map(function (k) {
      return { label: k, pnl_usd: a.regionMap[k].pnl_usd };
    }).sort(function (x, y) { return Math.abs(y.pnl_usd) - Math.abs(x.pnl_usd); });
    drawHBar('eeChartRegion', regionItems, 'pnl_usd', 'label',
      function (v) { return v >= 0 ? '#00c8a0' : '#ff4444'; });
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     PUBLIC API  (window.EE)
     ══════════════════════════════════════════════════════════════════════════════ */

  window.EE = {

    /* ── Called by renderTrades() hook each cycle ── */
    onSignals: onSignals,

    /* ── Risk Simulator: called by slider oninput events ── */
    updateSim: function () { renderSim(); },

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
    loadSigLog();

    /* Always-on: force auto-execution on every page load.
       User can still pause mid-session via the STOP AUTO button,
       but it resets to ON on next reload — by design. */
    _cfg.enabled = true;
    saveCfg();

    setInterval(monitorTrades, 30000);  // price-check open trades every 30 s

    /* Re-scan loop: every 5 minutes re-process the last IC signal batch.
       Keeps the engine finding trades even when IC cycles are slow / paused. */
    setInterval(function () {
      if (_cfg.enabled && _lastSignals.length) {
        log('SCAN', 'Periodic re-scan — ' + _lastSignals.length + ' signal(s) re-evaluated', 'dim');
        onSignals(_lastSignals);
      }
    }, 300000);  // 5 minutes

    renderUI();
    log('SYSTEM', 'Execution Engine v1.0 ready — ' + _cfg.mode + ' mode  |  ' +
        'Auto-scan ALWAYS ON  |  ' + openTrades().length + ' open trade(s) restored', 'green');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
