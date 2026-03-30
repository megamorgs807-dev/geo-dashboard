/* ══════════════════════════════════════════════════════════════════════════════
   HL-FEED v3 — Hyperliquid Real-Time Price Feed (Primary Source)
   ══════════════════════════════════════════════════════════════════════════════
   Connects to Hyperliquid's WebSocket (wss://api.hyperliquid.xyz/ws) and
   subscribes to allMids — streaming mid-prices for 300+ trading pairs including
   Gold, Silver, WTI/Brent crude (speculative), BTC/ETH/SOL, and 150+ US equities.

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
     Equity/ETF spot tokens use @N pair-index from:
       POST /info {type:'spotMeta'} → universe[].index → '@N' key in allMids.
     Verified Mar 2026: spotMeta max pair index = 300. @263-@289 are the NEW
     full-USD-price equity tokens (TSLA at ~$246, META at ~$620, MSFT ~$399).
     Old fractional @247-@272 range (FI, MMOVE, RISK…) removed — wrong prices.
     Array order matters: first name is the "canonical" EE name for display.
     Not on HL spot (flagged by HL gate): LMT, RTX, NOC, TSM, ASML, XLE,
     SMH, SOXX, TLT, XOM, GDX, CORN, WHEAT, DAL, UAL.
     NVDA has a registered spot token (@408) but no confirmed active trading pair.
     WTI and BRENT are speculatively added — user-confirmed present on HL.  */
  var HL_MAP = {
    /* Crypto perps — named tickers present in allMids */
    'BTC':      ['BTC', 'BITCOIN'],
    'ETH':      ['ETH', 'ETHEREUM'],
    'SOL':      ['SOL'],
    'XRP':      ['XRP'],
    'BNB':      ['BNB'],
    'ADA':      ['ADA'],
    'DOGE':     ['DOGE'],
    'AVAX':     ['AVAX'],
    'DOT':      ['DOT'],
    'LINK':     ['LINK'],
    'LTC':      ['LTC'],
    'UNI':      ['UNI'],
    'AAVE':     ['AAVE'],
    'INJ':      ['INJ'],
    'SUI':      ['SUI'],
    'APT':      ['APT'],
    'TIA':      ['TIA'],
    'TON':      ['TON'],
    'NEAR':     ['NEAR'],
    'FIL':      ['FIL'],
    'ARB':      ['ARB'],
    'OP':       ['OP'],
    'ATOM':     ['ATOM'],
    'HYPE':     ['HYPE'],
    'WIF':      ['WIF'],
    'PEPE':     ['kPEPE', 'PEPE'],
    'BONK':     ['kBONK', 'BONK'],
    'FLOKI':    ['kFLOKI', 'FLOKI'],
    'SHIB':     ['kSHIB', 'SHIB'],
    'TAO':      ['TAO'],
    'RENDER':   ['RENDER'],
    'FET':      ['FET'],
    'IMX':      ['IMX'],
    'SAND':     ['SAND'],
    'ALGO':     ['ALGO'],
    'XLM':      ['XLM'],
    'HBAR':     ['HBAR'],
    'ICP':      ['ICP'],
    'ETC':      ['ETC'],
    'BCH':      ['BCH'],
    'TRX':      ['TRX'],
    'SEI':      ['SEI'],
    'RUNE':     ['RUNE'],
    'ONDO':     ['ONDO'],
    'PENDLE':   ['PENDLE'],
    'JUP':      ['JUP'],
    'ENS':      ['ENS'],
    'MKR':      ['MKR'],
    'COMP':     ['COMP'],
    'SNX':      ['SNX'],
    'LDO':      ['LDO'],
    'ZRO':      ['ZRO'],
    'BLUR':     ['BLUR'],
    'GMX':      ['GMX'],
    /* Additional active perps on HL — confirmed live (Mar 2026) */
    'TRUMP':    ['TRUMP'],
    'WLD':      ['WLD'],
    'ENA':      ['ENA'],
    'EIGEN':    ['EIGEN'],
    'PYTH':     ['PYTH'],
    'CRV':      ['CRV'],

    /* Commodity perps — confirmed live on HL (Mar 2026)
       GAS maxLev confirmed = 3 (HL API, Mar 2026).
       PAXG maxLev confirmed = 10 (HL API, Mar 2026).
       WTI and BRENT added speculatively (user-confirmed present on HL). */
    'GAS':      ['GAS', 'NATGAS'],        // Natural gas perp (allMids key = 'GAS'); maxLev 3 per HL API
    'PAXG':     ['PAXG', 'XAU', 'GOLD'],  // PAX Gold — gold-backed token on HL; maxLev 10 per HL API; XAU/GOLD aliases
    'WTI':      ['WTI', 'CRUDE', 'OIL'],  // WTI crude oil perp (user-confirmed on HL)
    'BRENT':    ['BRENT', 'BRENTOIL'],    // Brent crude perp (user-confirmed on HL)

    /* Spot equity/ETF tokens — @N pair-index, full USD price (Mar 2026 spotMeta)
       Prices ~10-20% of real stock price on some tokens due to oracle/synthetic
       pricing; direction and TA signals remain valid.                        */
    '@263':  ['CRCL'],                  // Circle (pre-IPO),  ~$126
    '@264':  ['TSLA'],                  // Tesla,             ~$246
    '@265':  ['SLV', 'SILVER', 'XAG'], // Silver ETF token,  ~$72
    '@266':  ['GOOGL'],                 // Alphabet,          ~$310
    '@268':  ['AAPL'],                  // Apple,             ~$253
    '@271':  ['HOOD'],                  // Robinhood,         ~$77
    '@276':  ['GLD'],                   // Gold ETF token,    ~$467
    '@279':  ['SPY'],                   // S&P 500 ETF token, ~$665
    '@280':  ['AMZN'],                  // Amazon,            ~$213
    '@287':  ['META'],                  // Meta,              ~$620
    '@288':  ['QQQ'],                   // Nasdaq 100 ETF,    ~$600
    '@289':  ['MSFT']                   // Microsoft,         ~$399
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
    'CRCL':    'equity',
    'TSLA':    'equity',  'GOOGL':   'equity',
    'AAPL':    'equity',  'HOOD':    'equity',
    'SPY':     'equity',  'AMZN':    'equity',
    'META':    'equity',  'QQQ':     'equity',
    'MSFT':    'equity',
    'SLV':     'precious','SILVER':  'precious','XAG': 'precious',
    'GLD':     'precious',
    'PAXG':    'precious', 'XAU': 'precious', 'GOLD': 'precious',
    /* Energy commodity perps on HL */
    'GAS':     'energy',  'NATGAS': 'energy',
    'WTI':     'energy',  'CRUDE':  'energy',  'OIL':   'energy',
    'BRENT':   'energy',  'BRENTOIL': 'energy',
    /* Extended crypto perps */
    'DOGE':    'crypto',  'AVAX':   'crypto',  'DOT':    'crypto',
    'LINK':    'crypto',  'LTC':    'crypto',  'UNI':    'crypto',
    'AAVE':    'crypto',  'INJ':    'crypto',  'SUI':    'crypto',
    'APT':     'crypto',  'TIA':    'crypto',  'TON':    'crypto',
    'NEAR':    'crypto',  'FIL':    'crypto',  'ARB':    'crypto',
    'OP':      'crypto',  'ATOM':   'crypto',  'HYPE':   'crypto',
    'WIF':     'crypto',  'PEPE':   'crypto',  'BONK':   'crypto',
    'FLOKI':   'crypto',  'SHIB':   'crypto',  'TAO':    'crypto',
    'RENDER':  'crypto',  'FET':    'crypto',  'IMX':    'crypto',
    'SAND':    'crypto',  'ALGO':   'crypto',  'XLM':    'crypto',
    'HBAR':    'crypto',  'ICP':    'crypto',  'ETC':    'crypto',
    'BCH':     'crypto',  'TRX':    'crypto',  'SEI':    'crypto',
    'RUNE':    'crypto',  'ONDO':   'crypto',  'PENDLE': 'crypto',
    'JUP':     'crypto',  'ENS':    'crypto',  'MKR':    'crypto',
    'COMP':    'crypto',  'SNX':    'crypto',  'LDO':    'crypto',
    'ZRO':     'crypto',  'BLUR':   'crypto',  'GMX':    'crypto',
    'kPEPE':   'crypto',  'kBONK':  'crypto',  'kFLOKI': 'crypto', 'kSHIB': 'crypto',
    'TRUMP':   'crypto',  'WLD':    'crypto',  'ENA':    'crypto',
    'EIGEN':   'crypto',  'PYTH':   'crypto',  'CRV':    'crypto'
  };

  /* ── Build static coverage set and reverse-map at init ─────────────────────
     _hlCoveredAssets: { 'BTC': true, 'WTI': true, ... }
     _eeToHL:          { 'BTC': 'BTC', 'WTI': 'WTI', 'CRUDE': 'WTI', ... }  */
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
  var _ws                = null;
  var _connected         = false;
  var _lastTs            = null;
  var _reconnectTs       = null;  // timestamp of most recent successful reconnection
  var _pairsReceived     = 0;
  var _injected          = 0;
  var _errors            = 0;
  var _reconnectTimer    = null;
  var _reconnectAttempts = 0;   // consecutive failures — drives exponential backoff
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
        _connected         = true;
        _errors            = 0;
        _reconnectAttempts = 0;   // reset backoff on successful connection
        _reconnectTs       = Date.now();  // track reconnect time for price cooldown
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
        _reconnectAttempts++;
        /* Exponential backoff: 12s → 24s → 48s → 60s cap, ±20% jitter.
           Prevents hammering the API during outages or auth failures.    */
        var base    = Math.min(60000, RECONNECT_MS * Math.pow(2, _reconnectAttempts - 1));
        var jitter  = base * 0.2 * (Math.random() * 2 - 1);   // ±20%
        var delay   = Math.round(base + jitter);
        _log('HL WebSocket closed — reconnecting in ' + (delay / 1000).toFixed(1) +
             's (attempt ' + _reconnectAttempts + ')');
        _reconnectTimer = setTimeout(_connect, delay);
      };

      _ws.onerror = function () {
        _connected = false;
        /* onclose fires after onerror — reconnect and backoff handled there */
      };

    } catch (e) {
      _log('WebSocket unavailable: ' + (e.message || String(e)), true);
      _reconnectAttempts++;
      var _errBase  = Math.min(60000, RECONNECT_MS * Math.pow(2, _reconnectAttempts));
      var _errDelay = Math.round(_errBase * (0.8 + Math.random() * 0.4));
      _reconnectTimer = setTimeout(_connect, _errDelay);
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
        reconnectTs:   _reconnectTs,
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

  /* ── Structured asset registry — console: HL_ASSET_REGISTRY.table() ────── */
  window.HL_ASSET_REGISTRY = (function () {
    var ENTRIES = [
      /* Crypto perps */
      { eeName:'BTC',   hlTicker:'BTC',   assetClass:'crypto',   region:'GLOBAL', sector:'crypto',   onHL:true, fullPrice:true,  notes:'BTC perpetual' },
      { eeName:'ETH',   hlTicker:'ETH',   assetClass:'crypto',   region:'GLOBAL', sector:'crypto',   onHL:true, fullPrice:true,  notes:'ETH perpetual' },
      { eeName:'SOL',   hlTicker:'SOL',   assetClass:'crypto',   region:'GLOBAL', sector:'crypto',   onHL:true, fullPrice:true,  notes:'' },
      { eeName:'XRP',   hlTicker:'XRP',   assetClass:'crypto',   region:'GLOBAL', sector:'crypto',   onHL:true, fullPrice:true,  notes:'' },
      { eeName:'BNB',   hlTicker:'BNB',   assetClass:'crypto',   region:'GLOBAL', sector:'crypto',   onHL:true, fullPrice:true,  notes:'' },
      { eeName:'ADA',   hlTicker:'ADA',   assetClass:'crypto',   region:'GLOBAL', sector:'crypto',   onHL:true, fullPrice:true,  notes:'' },
      /* HL spot equity/ETF tokens (full USD price, Mar 2026) */
      { eeName:'CRCL',  hlTicker:'@263',  assetClass:'equity',   region:'US',     sector:'fintech',  onHL:true, fullPrice:true,  notes:'Circle pre-IPO, ~$126' },
      { eeName:'TSLA',  hlTicker:'@264',  assetClass:'equity',   region:'US',     sector:'ev',       onHL:true, fullPrice:true,  notes:'Tesla, ~$246' },
      { eeName:'SLV',   hlTicker:'@265',  assetClass:'precious', region:'GLOBAL', sector:'precious', onHL:true, fullPrice:false, notes:'Silver token, ~$72 (not ETF price)' },
      { eeName:'GOOGL', hlTicker:'@266',  assetClass:'equity',   region:'US',     sector:'tech',     onHL:true, fullPrice:false, notes:'Alphabet, ~$310 (premium vs real)' },
      { eeName:'AAPL',  hlTicker:'@268',  assetClass:'equity',   region:'US',     sector:'tech',     onHL:true, fullPrice:false, notes:'Apple, ~$253 (small premium)' },
      { eeName:'HOOD',  hlTicker:'@271',  assetClass:'equity',   region:'US',     sector:'fintech',  onHL:true, fullPrice:false, notes:'Robinhood, ~$77 (premium vs real)' },
      { eeName:'GLD',   hlTicker:'@276',  assetClass:'precious', region:'GLOBAL', sector:'precious', onHL:true, fullPrice:false, notes:'Gold ETF token, ~$467' },
      { eeName:'SPY',   hlTicker:'@279',  assetClass:'equity',   region:'US',     sector:'index',    onHL:true, fullPrice:false, notes:'S&P 500 ETF token, ~$665' },
      { eeName:'AMZN',  hlTicker:'@280',  assetClass:'equity',   region:'US',     sector:'tech',     onHL:true, fullPrice:true,  notes:'Amazon, ~$213' },
      { eeName:'META',  hlTicker:'@287',  assetClass:'equity',   region:'US',     sector:'tech',     onHL:true, fullPrice:true,  notes:'Meta, ~$620 (accurate)' },
      { eeName:'QQQ',   hlTicker:'@288',  assetClass:'equity',   region:'US',     sector:'index',    onHL:true, fullPrice:false, notes:'Nasdaq 100 ETF token, ~$600' },
      { eeName:'MSFT',  hlTicker:'@289',  assetClass:'equity',   region:'US',     sector:'tech',     onHL:true, fullPrice:true,  notes:'Microsoft, ~$399 (accurate)' },
      /* Commodity perps on HL */
      { eeName:'GAS',    hlTicker:'GAS',     assetClass:'commodity', region:'GLOBAL', sector:'energy', onHL:true,  fullPrice:true,  notes:'Natural gas perp — allMids key GAS (~$1.66); maxLev 3 per HL API' },
      { eeName:'WTI',    hlTicker:'WTI',     assetClass:'commodity', region:'GLOBAL', sector:'energy', onHL:true,  fullPrice:true,  notes:'WTI crude oil perp — user-confirmed on HL (speculative)' },
      { eeName:'BRENT',  hlTicker:'BRENT',   assetClass:'commodity', region:'GLOBAL', sector:'energy', onHL:true,  fullPrice:true,  notes:'Brent crude perp — user-confirmed on HL (speculative)' },
      { eeName:'LMT',   hlTicker:null,    assetClass:'equity',   region:'US',     sector:'defense',  onHL:false, fullPrice:false, notes:'No HL spot token — flag for Alpaca/TD' },
      { eeName:'RTX',   hlTicker:null,    assetClass:'equity',   region:'US',     sector:'defense',  onHL:false, fullPrice:false, notes:'No HL spot token' },
      { eeName:'NOC',   hlTicker:null,    assetClass:'equity',   region:'US',     sector:'defense',  onHL:false, fullPrice:false, notes:'No HL spot token' },
      { eeName:'NVDA',  hlTicker:null,    assetClass:'equity',   region:'US',     sector:'semis',    onHL:false, fullPrice:false, notes:'Registered HL spot token @408 but no confirmed active trading pair — exclude until pair is live' },
      { eeName:'TSM',   hlTicker:null,    assetClass:'equity',   region:'TAIWAN', sector:'semis',    onHL:false, fullPrice:false, notes:'No HL spot token' },
      { eeName:'ASML',  hlTicker:null,    assetClass:'equity',   region:'EU',     sector:'semis',    onHL:false, fullPrice:false, notes:'No HL spot token' },
      { eeName:'XLE',   hlTicker:null,    assetClass:'equity',   region:'US',     sector:'energy',   onHL:false, fullPrice:false, notes:'No HL spot token' },
      { eeName:'SMH',   hlTicker:null,    assetClass:'equity',   region:'US',     sector:'semis',    onHL:false, fullPrice:false, notes:'No HL spot token' },
      { eeName:'TLT',   hlTicker:null,    assetClass:'equity',   region:'US',     sector:'bonds',    onHL:false, fullPrice:false, notes:'No HL spot token' },
    ];
    return {
      all:      function () { return ENTRIES.slice(); },
      onHL:     function () { return ENTRIES.filter(function(e){ return e.onHL; }); },
      notOnHL:  function () { return ENTRIES.filter(function(e){ return !e.onHL; }); },
      find:     function (ee) { return ENTRIES.find(function(e){ return e.eeName === ee.toUpperCase(); }) || null; },
      table:    function () {
        var w = ['eeName','hlTicker','assetClass','sector','onHL','notes'];
        var rows = ENTRIES.map(function(e){
          return [e.eeName, e.hlTicker||'—', e.assetClass, e.sector, e.onHL?'✓':'✗', e.notes];
        });
        console.table(rows.reduce(function(o,r){ o[r[0]]={hlTicker:r[1],class:r[2],sector:r[3],onHL:r[4],notes:r[5]}; return o; }, {}));
      }
    };
  }());

  /* ── Boot: start 6s after page load to avoid clash with IC 4s bootstrap ── */
  window.addEventListener('load', function () {
    setTimeout(function () {
      _checkEE();
      _connect();
    }, 6000);
  });

}());
