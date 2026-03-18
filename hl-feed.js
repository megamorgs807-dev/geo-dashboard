/* ══════════════════════════════════════════════════════════════════════════════
   HL-FEED v3 — Hyperliquid Real-Time Price Feed (Primary Source)
   ══════════════════════════════════════════════════════════════════════════════
   Connects to Hyperliquid's WebSocket (wss://api.hyperliquid.xyz/ws) and
   subscribes to allMids — streaming mid-prices for 300+ trading pairs including
   WTI, Brent crude, Gold, Silver, BTC/ETH/SOL, and 150+ US equities.

   v3 changes vs v2:
   ─ All dead named equity/commodity entries (CL, BRENTOIL, GOLD, NVDA…) removed
   ─ Replaced with @N spot token pair-index format (e.g. @247=TSLA, @251=AAPL)
     discovered via HL spotMeta endpoint — these actually stream in allMids
   ─ Now covers: BTC ETH SOL XRP BNB ADA (crypto perps) + TSLA AAPL AMZN META
     QQQ MSFT GOOGL HOOD SPY SLV GLD (HL spot equity/ETF tokens)
   ─ (v2) _hlPrices store, highest-priority source, HL fee model, richer API

   Public API: window.HLFeed
     .getPrice(eeName)   → { price, ts, ageSec, fresh, hlTicker } | null
     .covers(eeName)     → true if HL has this asset (regardless of WS state)
     .isAvailable(eeName)→ true if covered AND fresh price exists (< 30s old)
     .costs(eeName)      → HL cost object for sector | null if not HL-covered
     .coverage()         → sorted array of all EE asset names HL covers
     .status()           → { connected, lastTs, lastUpdate, pairsReceived, injected, errors }
     .tickers()          → { 'CL': '73.50', ... } last raw HL prices
     .restart()          → force reconnect

   @N spot tokens: HL lists equity/ETF/commodity spot tokens by pair-index in
   allMids (e.g. @247=TSLA, @251=AAPL). Prices are in fractional token units
   (not real USD). TA direction signals remain valid; stop/target values are in
   token units consistent with EE's HL spot trading. Never fall back to TD/AV
   for @N assets — incompatible price scale.
   GLD (@259) and SLV (@248) are HL spot ETF tokens, now included.
   ══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var HL_WS_URL     = 'wss://api.hyperliquid.xyz/ws';
  var HL_FRESH_MS   = 30000;    // price < 30s old = "fresh" (WS actively streaming)
  var RECONNECT_MS  = 12000;    // gap between reconnect attempts
  var MAX_ERRORS    = 10;       // suppress parse error logs after this many

  /* ── HL ticker/pair-index → EE asset name mapping ──────────────────────────
     Crypto perps use named tickers (e.g. 'BTC') — these match allMids keys.
     Equity/ETF/commodity spot tokens use @N pair-index format (e.g. '@247')
     discovered via POST /info {type:'spotMeta'} → universe[N].name.
     Array order matters: first name is the "canonical" EE name for display.
     Assets NOT in HL spotMeta (TLT, TSM, XLE, SMH, SOXX, WTI, BRENT, WHEAT)
     are omitted — they continue using TD/AV.                                */
  var HL_MAP = {
    /* Crypto perps — named tickers present in allMids */
    'BTC':   ['BTC', 'BITCOIN'],
    'ETH':   ['ETH', 'ETHEREUM'],
    'SOL':   ['SOL'],
    'XRP':   ['XRP'],
    'BNB':   ['BNB'],
    'ADA':   ['ADA'],

    /* Spot equity/ETF tokens — @N pair-index from spotMeta universe */
    '@247':  ['TSLA'],
    '@248':  ['SLV', 'SILVER', 'XAG'],
    '@249':  ['GOOGL'],
    '@251':  ['AAPL'],
    '@254':  ['HOOD'],
    '@259':  ['GLD'],
    '@262':  ['SPY'],
    '@263':  ['AMZN'],
    '@270':  ['META'],
    '@271':  ['QQQ'],
    '@272':  ['MSFT']
  };

  /* ── HL-accurate cost model for paper-trading simulation ───────────────────
     Source: Hyperliquid fee schedule (March 2026)
       Taker (market/SL orders): 0.05%  = 0.0005
       Maker (limit/TP orders):  0.02%  = 0.0002
       We use taker rate as the per-side commission (conservative; most
       entries and SL exits are market orders on a perp DEX).
     Spreads are tighter than traditional CFD because HL runs an on-chain
     order book with active market makers.
     Funding: HL perpetuals use ~1h intervals. We store as 8h-equivalent
     (÷8 from 8h traditional rate) for compatibility with EE funding logic. */
  var HL_TRADING_COSTS = {
    crypto:   { spread: 0.0002, slippage: 0.0001, commission: 0.0005, funding8h: 0.0001  },
    energy:   { spread: 0.0003, slippage: 0.0002, commission: 0.0005, funding8h: 0.00005 },
    precious: { spread: 0.0002, slippage: 0.0001, commission: 0.0005, funding8h: 0.00005 },
    equity:   { spread: 0.0002, slippage: 0.0001, commission: 0.0005, funding8h: 0       },
    def:      { spread: 0.0003, slippage: 0.0002, commission: 0.0005, funding8h: 0       }
  };

  /* ── Sector classification for HL cost lookup ───────────────────────────────
     Maps every EE asset name that HL covers → cost sector key.               */
  var HL_SECTOR = {
    /* Crypto perps */
    'BTC':     'crypto',  'BITCOIN':  'crypto',
    'ETH':     'crypto',  'ETHEREUM': 'crypto',
    'SOL':     'crypto',  'XRP':      'crypto',
    'BNB':     'crypto',  'ADA':      'crypto',
    /* Spot equity/ETF tokens (canonical EE names from HL_MAP) */
    'TSLA':    'equity',  'GOOGL':   'equity',
    'AAPL':    'equity',  'HOOD':    'equity',
    'SPY':     'equity',  'AMZN':    'equity',
    'META':    'equity',  'QQQ':     'equity',
    'MSFT':    'equity',
    'SLV':     'precious','SILVER':  'precious','XAG': 'precious',
    'GLD':     'equity'   // HL spot ETF token — priced in token units
  };

  /* ── Build static coverage set and reverse-map at init ─────────────────────
     _hlCoveredAssets: { 'WTI': true, 'BTC': true, ... }
     _eeToHL:          { 'WTI': 'CL', 'BRENT': 'BRENTOIL', ... }             */
  var _hlCoveredAssets = {};
  var _eeToHL          = {};
  Object.keys(HL_MAP).forEach(function (hlTicker) {
    HL_MAP[hlTicker].forEach(function (eeName) {
      _hlCoveredAssets[eeName] = true;
      _eeToHL[eeName]          = hlTicker;
    });
  });

  /* ── State ──────────────────────────────────────────────────────────────────
     _hlPrices: per-EE-asset, updated on every allMids message.               */
  var _ws             = null;
  var _connected      = false;
  var _lastTs         = null;
  var _pairsReceived  = 0;
  var _injected       = 0;
  var _errors         = 0;
  var _reconnectTimer = null;
  var _lastRawPrices  = {};   // { 'CL': '73.50', ... } for HLFeed.tickers()
  var _hlPrices       = {};   // { 'WTI': { price: 73.5, ts: ..., hlTicker: 'CL' }, ... }
  var _eeReady        = false;

  /* ── EE availability check ──────────────────────────────────────────────── */
  function _checkEE() {
    if (window.EE && typeof window.EE.injectPrice === 'function') {
      _eeReady = true;
      return true;
    }
    return false;
  }

  /* ── WebSocket connection ───────────────────────────────────────────────── */
  function _connect() {
    if (_ws && (_ws.readyState === WebSocket.CONNECTING ||
                _ws.readyState === WebSocket.OPEN)) return;
    if (typeof WebSocket === 'undefined') return;
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }

    try {
      _ws = new WebSocket(HL_WS_URL);

      _ws.onopen = function () {
        _connected = true;
        _errors    = 0;
        _ws.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'allMids' }
        }));
        _log('HL WebSocket connected — allMids subscribed (primary price source active)');
      };

      _ws.onmessage = function (evt) {
        try {
          var msg = JSON.parse(evt.data);
          if (!msg || msg.channel !== 'allMids' || !msg.data || !msg.data.mids) return;

          var mids = msg.data.mids;   // { 'CL': '73.50', 'GOLD': '3185.20', ... }
          _lastTs        = Date.now();
          _pairsReceived = Object.keys(mids).length;

          if (!_eeReady && !_checkEE()) return;

          Object.keys(HL_MAP).forEach(function (hlTicker) {
            var rawStr = mids[hlTicker];
            if (rawStr === undefined || rawStr === null) return;
            var price = parseFloat(rawStr);
            if (!isFinite(price) || price <= 0) return;

            /* Store raw for tickers() snapshot */
            _lastRawPrices[hlTicker] = rawStr;

            /* Store parsed price per EE asset name */
            HL_MAP[hlTicker].forEach(function (eeName) {
              _hlPrices[eeName] = { price: price, ts: _lastTs, hlTicker: hlTicker };
              /* Also push into EE's general price cache via injectPrice() */
              EE.injectPrice(eeName, price);
              _injected++;
            });
          });

        } catch (e) {
          _errors++;
          if (_errors <= MAX_ERRORS) {
            _log('Parse error: ' + (e.message || String(e)), true);
          }
        }
      };

      _ws.onclose = function () {
        _connected = false;
        _log('HL WebSocket closed — reconnecting in ' + (RECONNECT_MS / 1000) + 's');
        _reconnectTimer = setTimeout(_connect, RECONNECT_MS);
      };

      _ws.onerror = function () {
        _connected = false;
        /* onclose fires after onerror — reconnect handled there */
      };

    } catch (e) {
      _log('WebSocket unavailable: ' + (e.message || String(e)), true);
      _reconnectTimer = setTimeout(_connect, RECONNECT_MS * 2);
    }
  }

  /* ── Minimal logger ─────────────────────────────────────────────────────── */
  function _log(msg, isWarn) {
    if (typeof console === 'undefined') return;
    var prefix = '[HL-Feed] ';
    if (isWarn) console.warn(prefix + msg);
    else        console.log(prefix + msg);
  }

  /* ════════════════════════════════════════════════════════════════════════════
     PUBLIC API — window.HLFeed
     ════════════════════════════════════════════════════════════════════════════ */
  window.HLFeed = {

    /* ── Price lookup ───────────────────────────────────────────────────────
       Returns the most recent HL price for an EE asset name.
       fresh = price age < HL_FRESH_MS (30s) — WS is actively streaming.
       Returns null if asset is not HL-covered or no price received yet.    */
    getPrice: function (eeName) {
      var entry = _hlPrices[eeName ? eeName.toUpperCase() : ''];
      if (!entry) return null;
      var ageSec = Math.round((Date.now() - entry.ts) / 1000);
      return {
        price:    entry.price,
        ts:       entry.ts,
        ageSec:   ageSec,
        fresh:    (Date.now() - entry.ts) < HL_FRESH_MS,
        hlTicker: entry.hlTicker
      };
    },

    /* ── Asset coverage ─────────────────────────────────────────────────────
       Returns true if this asset is mapped in HL_MAP regardless of WS state.
       Used by _getCosts() — always use HL fee model for HL-covered assets.  */
    covers: function (eeName) {
      return !!_hlCoveredAssets[eeName ? eeName.toUpperCase() : ''];
    },

    /* ── Live availability ──────────────────────────────────────────────────
       Returns true if covered AND a fresh price (< 30s) exists.
       Used by buildTrade() to set price_source = 'HYPERLIQUID'.            */
    isAvailable: function (eeName) {
      var tok = eeName ? eeName.toUpperCase() : '';
      if (!_hlCoveredAssets[tok]) return false;
      var entry = _hlPrices[tok];
      return !!(entry && (Date.now() - entry.ts) < HL_FRESH_MS);
    },

    /* ── Cost model ─────────────────────────────────────────────────────────
       Returns HL perpetual fee structure for the asset's sector.
       Returns null if asset is not HL-covered (caller falls back to
       existing TRADING_COSTS sector lookup).                               */
    costs: function (eeName) {
      var tok    = eeName ? eeName.toUpperCase() : '';
      var sector = HL_SECTOR[tok];
      if (!sector) return null;
      return HL_TRADING_COSTS[sector] || HL_TRADING_COSTS.def;
    },

    /* ── Coverage list ──────────────────────────────────────────────────────
       Returns sorted array of all EE asset names HL covers.
       Useful for console inspection: HLFeed.coverage()                     */
    coverage: function () {
      return Object.keys(_hlCoveredAssets).sort();
    },

    /* ── Status ─────────────────────────────────────────────────────────── */
    status: function () {
      return {
        connected:     _connected,
        lastTs:        _lastTs,
        lastUpdate:    _lastTs
          ? Math.round((Date.now() - _lastTs) / 1000) + 's ago'
          : 'never',
        pairsReceived: _pairsReceived,
        injected:      _injected,
        errors:        _errors,
        coveredAssets: Object.keys(_hlCoveredAssets).length,
        freshPrices:   Object.keys(_hlPrices).filter(function (k) {
          return _hlPrices[k] && (Date.now() - _hlPrices[k].ts) < HL_FRESH_MS;
        }).length
      };
    },

    /* ── Raw ticker snapshot ────────────────────────────────────────────── */
    tickers: function () {
      return Object.assign({}, _lastRawPrices);
    },

    /* ── Force reconnect ────────────────────────────────────────────────── */
    restart: function () {
      if (_ws) { try { _ws.close(); } catch (e) {} }
      _connected = false;
      _connect();
    }
  };

  /* ── Boot: start 6s after page load to avoid clash with IC 4s bootstrap ── */
  window.addEventListener('load', function () {
    setTimeout(function () {
      _checkEE();
      _connect();
    }, 6000);
  });

}());
