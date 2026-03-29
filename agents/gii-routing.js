/* ══════════════════════════════════════════════════════════════════════════════
   GII-ROUTING v5 — Instrument Router & Leverage Optimiser  [HL-FIRST MODE]
   ══════════════════════════════════════════════════════════════════════════════
   Called by EE.onSignals() before every signal is processed.

   HL-FIRST philosophy (v3):
     Hyperliquid is the primary trading platform. This agent routes every
     signal to its HL perpetual equivalent whenever possible — even on a
     slightly stale price (up to 2 minutes old). Traditional routes (Yahoo /
     backend cache) are only used when HL has no data at all.

   Three HL tiers:
     FRESH   (price < 30s)  → full routing: optimal leverage via EV model
     WARM    (price 30-120s) → route to HL at 1× only; note the staleness
     COVERED (HL knows asset but no recent price) → TRAD fallback; HL WS down

   Leverage is the secondary optimisation. The EV model picks the level where
   expected return per dollar at risk is maximised, accounting for:
     • Fees that scale with notional (2× lev = 2× fees on the same capital)
     • Noise stopout penalty: stops near the sector floor get hit by random
       intraday movement 50% of the time — quadratic model limits over-tightening
     • GTI regime context: HL is about capturing fast moves, not blowing up in
       extreme markets — EXTREME GTI still allows 2×, just no higher

   ── v3 vs v2 ────────────────────────────────────────────────────────────────
   ✓ HL-FIRST: routes to HL on WARM price tier (30-120s) at 1× — v2 would fall
     back to TRAD if HL WS had a temporary blip. Now sticks with HL.
   ✓ Lower leverage thresholds: conf ≥65%→2× (was 70%), conf ≥75%→3× (was 80%)
   ✓ Softer GTI caps: EXTREME→2× (was 1×), HIGH→3× (was 2×). Big events are
     exactly when HL's fast execution matters — 1× during EXTREME was too timid.
   ✓ Fixed preview() rollback: saves decision before popping it, so the returned
     EV table is from the preview run, not the previous real decision.
   ✓ HL tier shown in routing note: [FRESH], [WARM+1×] in activity log.

   ── v2 improvements (still present) ─────────────────────────────────────────
   ✓ Fixed EV formula: TP is event-driven (fixed pct), not scaled by stop.
     At 2× lev wins DOUBLE (2× units catch same move), losses stay constant.
   ✓ Noise-adjusted W: quadratic penalty near sector noise floor.
   ✓ GTI / regime: reads GII.gti() and GII.status().volatilityBoost.
   ✓ Self-learning: blends empirical win rates from closed trades (5+ needed).
   ✓ Better TP: uses atrTarget → sector defaults × impactMult → SL×ratio.
   ✓ isAvailable() + warm tier replaces v1's covers() raw check.
   ✓ XRP, BNB, ADA, ASML, OIL, CRUDE, XAG added.

   EV model:
     evPerRisk = W_adj × (lev × tpFixed / baseSL) − (1−W_adj) − lev × fees / baseSL
     W_adj = W × (1 − min(0.50, (minSL/adjSL)² × 0.50))  ← quadratic noise penalty
     Result is expected return as multiple of capital at risk (1.0 = 100%).

   Public API: window.GII_ROUTING
     .route(signal)              → modified signal (or original if no HL available)
     .preview(asset, conf, opts) → dry-run EV table; opts: {stopPct, impactMult, dir}
     .decisions()                → last 50 routing decisions with EV tables
     .status()                   → summary stats
   ══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Instrument map: traditional asset → HL perpetual equivalent ────────────
     GLD → XAU is the key remap: GLD is the SPDR ETF (~$275 ≈ 1/10 oz gold).
     HL trades spot GOLD (~$3000). Routing fixes the price and position sizing.  */
  /* hlAsset = EE canonical name (HLFeed.covers/isAvailable accept EE names,
     not raw @N indices — the @N→EEname mapping lives in hl-feed.js HL_MAP).
     Assets NOT on HL spot (WTI, BRENT, LMT, TSM, NVDA…) are kept here so the
     router can still compute EV/sector/leverage for the flagged-trade log.    */
  var INSTRUMENT_MAP = {
    /* Precious metals — GLD/SLV now on HL spot (@276/@265) */
    'GLD':    { hlAsset: 'GLD',    sector: 'precious', maxLev: 3 },
    'SLV':    { hlAsset: 'SLV',    sector: 'precious', maxLev: 3 },
    'SILVER': { hlAsset: 'SLV',    sector: 'precious', maxLev: 3 },
    'XAG':    { hlAsset: 'SLV',    sector: 'precious', maxLev: 3 },
    'XAU':    { hlAsset: 'GLD',    sector: 'precious', maxLev: 3 },
    /* Energy — WTI/BRENT crude perps DELISTED from HL (Mar 2026); routed via OANDA */
    'BRENT':    { hlAsset: null, oandaInstrument: 'BCO_USD',   sector: 'energy', maxLev: 5 },
    'BRENTOIL': { hlAsset: null, oandaInstrument: 'BCO_USD',   sector: 'energy', maxLev: 5 },
    'WTI':      { hlAsset: null, oandaInstrument: 'WTICO_USD', sector: 'energy', maxLev: 5 },
    'OIL':      { hlAsset: null, oandaInstrument: 'WTICO_USD', sector: 'energy', maxLev: 5 },
    'CRUDE':    { hlAsset: null, oandaInstrument: 'WTICO_USD', sector: 'energy', maxLev: 5 },
    /* Natural gas perp still live on HL (allMids key = 'GAS') */
    'GAS':    { hlAsset: 'GAS',    sector: 'energy',   maxLev: 5 },
    'NATGAS': { hlAsset: 'GAS',    sector: 'energy',   maxLev: 5 },
    /* Crypto perps */
    'BTC':    { hlAsset: 'BTC',    sector: 'crypto',   maxLev: 3 },
    'ETH':    { hlAsset: 'ETH',    sector: 'crypto',   maxLev: 3 },
    'SOL':    { hlAsset: 'SOL',    sector: 'crypto',   maxLev: 3 },
    'XRP':    { hlAsset: 'XRP',    sector: 'crypto',   maxLev: 3 },
    'BNB':    { hlAsset: 'BNB',    sector: 'crypto',   maxLev: 3 },
    'ADA':    { hlAsset: 'ADA',    sector: 'crypto',   maxLev: 3 },
    /* HL spot equity tokens (full USD price, @263-@289) */
    'CRCL':   { hlAsset: 'CRCL',   sector: 'equity',   maxLev: 2 },
    'TSLA':   { hlAsset: 'TSLA',   sector: 'equity',   maxLev: 2 },
    'AAPL':   { hlAsset: 'AAPL',   sector: 'equity',   maxLev: 2 },
    'AMZN':   { hlAsset: 'AMZN',   sector: 'equity',   maxLev: 2 },
    'META':   { hlAsset: 'META',   sector: 'equity',   maxLev: 2 },
    'QQQ':    { hlAsset: 'QQQ',    sector: 'equity',   maxLev: 3 },
    'MSFT':   { hlAsset: 'MSFT',   sector: 'equity',   maxLev: 2 },
    'GOOGL':  { hlAsset: 'GOOGL',  sector: 'equity',   maxLev: 2 },
    'HOOD':   { hlAsset: 'HOOD',   sector: 'equity',   maxLev: 2 },
    'SPY':    { hlAsset: 'SPY',    sector: 'equity',   maxLev: 3 },
    /* NOT on HL spot — kept for EV model / flagged-trade context */
    'NVDA':   { hlAsset: 'NVDA',   sector: 'equity',   maxLev: 3 },
    'TSM':    { hlAsset: 'TSM',    sector: 'equity',   maxLev: 3 },
    'ASML':   { hlAsset: 'ASML',   sector: 'equity',   maxLev: 2 },
    'LMT':    { hlAsset: 'LMT',    sector: 'equity',   maxLev: 3 },
    'RTX':    { hlAsset: 'RTX',    sector: 'equity',   maxLev: 3 },
    'NOC':    { hlAsset: 'NOC',    sector: 'equity',   maxLev: 3 },
    'XLE':    { hlAsset: 'XLE',    sector: 'equity',   maxLev: 3 },
    'GDX':    { hlAsset: 'GDX',    sector: 'equity',   maxLev: 2 },
    'SMH':    { hlAsset: 'SMH',    sector: 'equity',   maxLev: 3 },
    'SOXX':   { hlAsset: 'SOXX',  sector: 'equity',   maxLev: 3 },
    'FXI':    { hlAsset: 'FXI',    sector: 'equity',   maxLev: 2 },
    'XOM':    { hlAsset: 'XOM',    sector: 'equity',   maxLev: 2 },
    /* Commodity / thematic ETFs — Alpaca only, no HL equivalent */
    'WEAT':   { hlAsset: 'WEAT',  sector: 'agri',     maxLev: 1 },
    'WHT':    { hlAsset: 'WEAT',  sector: 'agri',     maxLev: 1 },
    'CORN':   { hlAsset: 'CORN',  sector: 'agri',     maxLev: 1 },
    'INDA':   { hlAsset: 'INDA',  sector: 'equity',   maxLev: 1 },
    'LIT':    { hlAsset: 'LIT',   sector: 'energy',   maxLev: 2 },
    'XME':    { hlAsset: 'XME',   sector: 'mining',   maxLev: 2 },
    /* Extended HL crypto perps — added from full 229 asset list */
    'DOGE':   { hlAsset: 'DOGE',  sector: 'crypto',   maxLev: 3 },
    'AVAX':   { hlAsset: 'AVAX',  sector: 'crypto',   maxLev: 3 },
    'DOT':    { hlAsset: 'DOT',   sector: 'crypto',   maxLev: 3 },
    'LINK':   { hlAsset: 'LINK',  sector: 'crypto',   maxLev: 3 },
    'LTC':    { hlAsset: 'LTC',   sector: 'crypto',   maxLev: 3 },
    'UNI':    { hlAsset: 'UNI',   sector: 'crypto',   maxLev: 3 },
    'AAVE':   { hlAsset: 'AAVE',  sector: 'crypto',   maxLev: 3 },
    'INJ':    { hlAsset: 'INJ',   sector: 'crypto',   maxLev: 3 },
    'SUI':    { hlAsset: 'SUI',   sector: 'crypto',   maxLev: 3 },
    'APT':    { hlAsset: 'APT',   sector: 'crypto',   maxLev: 3 },
    'TIA':    { hlAsset: 'TIA',   sector: 'crypto',   maxLev: 3 },
    'TON':    { hlAsset: 'TON',   sector: 'crypto',   maxLev: 3 },
    'NEAR':   { hlAsset: 'NEAR',  sector: 'crypto',   maxLev: 3 },
    'ARB':    { hlAsset: 'ARB',   sector: 'crypto',   maxLev: 3 },
    'OP':     { hlAsset: 'OP',    sector: 'crypto',   maxLev: 3 },
    'ATOM':   { hlAsset: 'ATOM',  sector: 'crypto',   maxLev: 3 },
    'HYPE':   { hlAsset: 'HYPE',  sector: 'crypto',   maxLev: 3 },
    'WIF':    { hlAsset: 'WIF',   sector: 'crypto',   maxLev: 3 },
    'PEPE':   { hlAsset: 'PEPE',  sector: 'crypto',   maxLev: 2 },
    'BONK':   { hlAsset: 'BONK',  sector: 'crypto',   maxLev: 2 },
    'TAO':    { hlAsset: 'TAO',   sector: 'crypto',   maxLev: 3 },
    'RENDER': { hlAsset: 'RENDER',sector: 'crypto',   maxLev: 3 },
    'FET':    { hlAsset: 'FET',   sector: 'crypto',   maxLev: 3 },
    'IMX':    { hlAsset: 'IMX',   sector: 'crypto',   maxLev: 3 },
    'HBAR':   { hlAsset: 'HBAR',  sector: 'crypto',   maxLev: 3 },
    'ICP':    { hlAsset: 'ICP',   sector: 'crypto',   maxLev: 3 },
    'ETC':    { hlAsset: 'ETC',   sector: 'crypto',   maxLev: 3 },
    'BCH':    { hlAsset: 'BCH',   sector: 'crypto',   maxLev: 3 },
    'SEI':    { hlAsset: 'SEI',   sector: 'crypto',   maxLev: 3 },
    'RUNE':   { hlAsset: 'RUNE',  sector: 'crypto',   maxLev: 3 },
    'ONDO':   { hlAsset: 'ONDO',  sector: 'crypto',   maxLev: 3 },
    'JUP':    { hlAsset: 'JUP',   sector: 'crypto',   maxLev: 3 },
    'MKR':    { hlAsset: 'MKR',   sector: 'crypto',   maxLev: 3 },
    'PAXG':   { hlAsset: 'PAXG',  sector: 'precious', maxLev: 2 },
    /* Extended HL crypto perps — synced from hl-feed.js HL_MAP (Mar 2026) */
    'ALGO':   { hlAsset: 'ALGO',  sector: 'crypto',   maxLev: 3 },
    'XLM':    { hlAsset: 'XLM',   sector: 'crypto',   maxLev: 3 },
    'FIL':    { hlAsset: 'FIL',   sector: 'crypto',   maxLev: 3 },
    'TRX':    { hlAsset: 'TRX',   sector: 'crypto',   maxLev: 3 },
    'PENDLE': { hlAsset: 'PENDLE',sector: 'crypto',   maxLev: 3 },
    'ZRO':    { hlAsset: 'ZRO',   sector: 'crypto',   maxLev: 3 },
    'BLUR':   { hlAsset: 'BLUR',  sector: 'crypto',   maxLev: 2 },
    'ENS':    { hlAsset: 'ENS',   sector: 'crypto',   maxLev: 3 },
    'LDO':    { hlAsset: 'LDO',   sector: 'crypto',   maxLev: 3 },
    'SAND':   { hlAsset: 'SAND',  sector: 'crypto',   maxLev: 3 },
    'FLOKI':  { hlAsset: 'FLOKI', sector: 'crypto',   maxLev: 2 },
    'SHIB':   { hlAsset: 'SHIB',  sector: 'crypto',   maxLev: 2 },
    'WLD':    { hlAsset: 'WLD',   sector: 'crypto',   maxLev: 3 },
    'TRUMP':  { hlAsset: 'TRUMP', sector: 'crypto',   maxLev: 2 },
    'ENA':    { hlAsset: 'ENA',   sector: 'crypto',   maxLev: 3 },
    'EIGEN':  { hlAsset: 'EIGEN', sector: 'crypto',   maxLev: 3 },
    'PYTH':   { hlAsset: 'PYTH',  sector: 'crypto',   maxLev: 3 },
    'CRV':    { hlAsset: 'CRV',   sector: 'crypto',   maxLev: 3 },
    'SNX':    { hlAsset: 'SNX',   sector: 'crypto',   maxLev: 3 },
    'GMX':    { hlAsset: 'GMX',   sector: 'crypto',   maxLev: 3 },
    /* FX pairs — routed via OANDA when connected */
    'EURUSD': { hlAsset: null, oandaInstrument: 'EUR_USD', sector: 'fx', maxLev: 10 },
    'GBPUSD': { hlAsset: null, oandaInstrument: 'GBP_USD', sector: 'fx', maxLev: 10 },
    'USDJPY': { hlAsset: null, oandaInstrument: 'USD_JPY', sector: 'fx', maxLev: 10 },
    'USDCHF': { hlAsset: null, oandaInstrument: 'USD_CHF', sector: 'fx', maxLev: 10 },
    'AUDUSD': { hlAsset: null, oandaInstrument: 'AUD_USD', sector: 'fx', maxLev: 10 },
    'USDCAD': { hlAsset: null, oandaInstrument: 'USD_CAD', sector: 'fx', maxLev: 10 }
  };

  /* ── Price freshness tiers ─────────────────────────────────────────────────
     FRESH_MS:  full HL routing + optimal leverage
     WARM_MS:   route to HL but 1× only — slightly stale is still better than
                Yahoo/backend (delayed, sometimes 15-min old)                 */
  var HL_FRESH_MS = 30000;    // < 30s — same as HLFeed's own definition
  var HL_WARM_MS  = 120000;   // 30s – 2min — tightened from 5min: stale prices cause inaccurate leverage/stop calc

  /* ── Fee structures ─────────────────────────────────────────────────────────
     HL: 0.05% taker. Traditional: CFD/stock estimates.                       */
  /* slippage = price impact of market order execution (in addition to spread).
     EE applies this as adjPrice = mid * (1 + spread/2 + slippage) per side.
     Including it here makes the routing EV model consistent with EE's actual costs.  */
  var HL_COSTS = {
    precious: { commission: 0.0005, spread: 0.0002, slippage: 0.0001, funding8h: 0.00005 },
    energy:   { commission: 0.0005, spread: 0.0003, slippage: 0.0002, funding8h: 0.00005 },
    crypto:   { commission: 0.0005, spread: 0.0002, slippage: 0.0001, funding8h: 0.0001  },
    equity:   { commission: 0.0005, spread: 0.0002, slippage: 0.0001, funding8h: 0       }
  };

  var TRAD_COSTS = {
    precious: { commission: 0.0007, spread: 0.0003, slippage: 0.0002, funding8h: 0       },
    energy:   { commission: 0.0007, spread: 0.0005, slippage: 0.0003, funding8h: 0       },
    crypto:   { commission: 0.0010, spread: 0.0008, slippage: 0.0004, funding8h: 0.0001  },
    equity:   { commission: 0.0005, spread: 0.0002, slippage: 0.0001, funding8h: 0       }
  };

  /* ── Sector-based expected TP move ──────────────────────────────────────────
     Typical price reaction to a significant geo/macro event.
     Used when signal doesn't carry an atrTarget. Scaled by impactMult.       */
  var SECTOR_TP_PCT = {
    precious: 1.8,   // gold: 1.5-2.5% on major conflict/sanctions events
    energy:   2.5,   // oil: 2-3% on OPEC/Hormuz/pipeline events
    crypto:   5.0,   // BTC/ETH: 4-6% on macro/regulatory shock events
    equity:   1.5    // index/stock: 1-2% on trade/geopolitical events
  };

  /* ── Minimum viable stop % by sector ───────────────────────────────────────
     Multiplied by GII volatilityBoost (1.0–2.0) during regime shifts.        */
  var MIN_SL_PCT = {
    precious: 0.50,
    energy:   0.80,
    crypto:   1.50,   // lowered from 2.0% → allows 3× on 5.5% stop assets (adjSL=1.83% > 1.5%)
    equity:   0.40
  };

  /* ── Max leverage by confidence band ────────────────────────────────────────
     GTI context still applies an override cap on top of these.                */
  var MAX_LEV_BY_CONF = [
    { minConf: 85, maxLev: 5 },
    { minConf: 72, maxLev: 3 },   // 3× from 72% (was 75%)
    { minConf: 65, maxLev: 2 },
    { minConf:  0, maxLev: 1 }    // below 65%: no leverage
  ];

  /* ── State ─────────────────────────────────────────────────────────────── */
  var _decisions      = [];
  var _stats          = { total: 0, hlRouted: 0, hlFresh: 0, hlWarm: 0, leveraged: 0, remapped: 0 };
  var _winRateCache   = { data: {}, ts: 0 };
  var WIN_RATE_TTL_MS = 300000;   // refresh win-rate cache every 5 min

  /* ════════════════════════════════════════════════════════════════════════════
     HELPERS
     ════════════════════════════════════════════════════════════════════════════ */

  function _norm(asset) {
    return String(asset || '').toUpperCase().replace(/[^A-Z0-9]/g, ' ').trim().split(' ')[0];
  }

  /* ── HL price freshness tier for a given HL asset name ─────────────────── */
  /* Returns 'fresh' | 'warm' | 'covered' | 'unavailable'
     fresh    → full routing + leverage
     warm     → route to HL but cap leverage at 1×
     covered  → HL knows this asset but no recent price (WS down) → TRAD
     unavailable → not on HL at all                                           */
  function _hlTier(hlAsset) {
    if (!window.HLFeed) return 'unavailable';
    try {
      // Fresh: price < 30s old
      if (typeof HLFeed.isAvailable === 'function' && HLFeed.isAvailable(hlAsset)) {
        return 'fresh';
      }
      // Warm: price exists and is < 2 min old
      if (typeof HLFeed.getPrice === 'function') {
        var p = HLFeed.getPrice(hlAsset);
        if (p && p.price > 0 && (Date.now() - p.ts) < HL_WARM_MS) return 'warm';
      }
      // Covered: asset is in HL but no usable price right now
      if (typeof HLFeed.covers === 'function' && HLFeed.covers(hlAsset)) return 'covered';
    } catch (e) {}
    return 'unavailable';
  }

  /* ── GTI / regime context ────────────────────────────────────────────────── */
  function _getGTIContext() {
    var gti = 50, level = 'MODERATE', volBoost = 1.0, regimeActive = false;
    try {
      if (window.GII && typeof GII.gti === 'function') {
        var g = GII.gti();
        if (g) { gti = g.value || 50; level = g.level || 'MODERATE'; }
      }
      if (window.GII && typeof GII.status === 'function') {
        var s = GII.status();
        if (s) { volBoost = Math.max(1.0, s.volatilityBoost || 1.0); regimeActive = volBoost > 1.2; }
      }
    } catch (e) {}
    return { gti: gti, level: level, volBoost: volBoost, regimeActive: regimeActive };
  }

  /* ── Empirical win-rate cache from EE closed trades ────────────────────── */
  function _buildWinRateCache() {
    var now = Date.now();
    if (now - _winRateCache.ts < WIN_RATE_TTL_MS) return _winRateCache.data;
    var data = {};
    try {
      if (window.EE && typeof EE.getAllTrades === 'function') {
        EE.getAllTrades().forEach(function (t) {
          if (t.status !== 'CLOSED' || !t.close_reason) return;
          var key = _norm(t.asset) + '_' + (t.direction || '').toUpperCase();
          if (!data[key]) data[key] = { wins: 0, total: 0, holdHoursSum: 0, holdCount: 0 };
          data[key].total++;
          if (t.close_reason === 'TAKE_PROFIT' || t.close_reason === 'TRAILING_STOP') {
            data[key].wins++;
          }
          /* v53 Fix F: accumulate actual hold duration for hold-time estimation */
          if (t.timestamp_open && t.timestamp_close) {
            var h = (new Date(t.timestamp_close) - new Date(t.timestamp_open)) / 3600000;
            if (h > 0 && h < 720) { // sanity: 0–30 days
              data[key].holdHoursSum += h;
              data[key].holdCount++;
            }
          }
        });
        Object.keys(data).forEach(function (k) {
          data[k].winRate      = data[k].total > 0 ? data[k].wins / data[k].total : null;
          data[k].avgHoldHours = data[k].holdCount >= 3
            ? data[k].holdHoursSum / data[k].holdCount : null; // need ≥3 samples
        });
      }
    } catch (e) {}
    _winRateCache = { data: data, ts: now };
    return data;
  }

  /* Effective win probability: blends empirical (60%) with confidence (40%)
     once ≥5 closed trades exist for this asset × direction.                */
  function _getEffectiveW(conf, asset, dir) {
    var W     = Math.max(0.25, Math.min(0.90, (conf || 50) / 100));
    var cache = _buildWinRateCache();
    var key   = _norm(asset) + '_' + (dir || '').toUpperCase();
    var entry = cache[key];
    if (entry && entry.winRate !== null && entry.total >= 5) {
      W = entry.winRate * 0.60 + W * 0.40;
    }
    return Math.max(0.20, Math.min(0.95, W));
  }

  /* ── Quadratic noise penalty on win probability ─────────────────────────── */
  /* At the sector noise floor, ~50% of stop-hits are random noise (not signal).
     Penalises over-tight stops progressively — creates a natural EV peak.    */
  function _noiseAdjustedW(W, adjSL_frac, minSL_frac) {
    var ratio     = Math.min(1.0, minSL_frac / adjSL_frac);
    var noiseRate = Math.min(0.50, ratio * ratio * 0.50);
    return W * (1 - noiseRate);
  }

  /* ── Estimate hold duration (hours) ────────────────────────────────────── */
  /* v53 Fix F: blends empirical avg hold time (60%) with heuristic (40%) once
     ≥3 closed trades exist for the asset × direction pair.                    */
  function _estimateHoldHours(sig, sector) {
    var conf   = sig.conf || 50;
    var impact = sig.impactMult || 1.0;
    var base   = conf >= 80 ? 4 : conf >= 70 ? 8 : conf >= 55 ? 16 : 24;
    if (impact >= 1.5) base = Math.max(2, Math.round(base * 0.6));
    if (sector === 'equity') {
      var utcHour = new Date().getUTCHours();
      if (utcHour < 13 || utcHour >= 20) base = Math.max(base, 16);
    }
    base = Math.min(48, base);
    /* Blend in empirical history if available */
    try {
      var cache = _buildWinRateCache();
      var dir   = (sig.dir || sig.bias || 'LONG').toUpperCase();
      var eKey  = _norm(sig.asset) + '_' + dir;
      var entry = cache[eKey];
      if (entry && entry.avgHoldHours !== null) {
        base = Math.min(48, entry.avgHoldHours * 0.60 + base * 0.40);
      }
    } catch (e) {}
    return base;
  }

  /* ── Fixed TP target as fraction of entry price ─────────────────────────── */
  function _estimateTpFixed(sig, sector, hlAsset, baseSL_frac) {
    if (sig.atrTarget && sig.atrTarget > 0) {
      var hlP = window.HLFeed && typeof HLFeed.getPrice === 'function'
                ? HLFeed.getPrice(hlAsset) : null;
      if (hlP && hlP.price > 0) return sig.atrTarget / hlP.price;
    }
    var sectorTP = (SECTOR_TP_PCT[sector] || 2.0) / 100;
    if (sig.impactMult) return sectorTP * Math.min(2.0, Math.max(0.5, sig.impactMult));
    return baseSL_frac * (sig.tpRatio || 2.0);
  }

  /* ── EV per dollar of capital at risk ───────────────────────────────────── */
  /* At leverage lev: notional = riskAmt × lev / baseSL
     Win:  units × price × tpFixed = riskAmt × lev × tpFixed / baseSL
     Loss: units × price × adjSL   = riskAmt  (constant — risk-based sizing!)
     Fees: notional × feeRate       = riskAmt × lev × feeRate / baseSL        */
  function _calcEvPerRisk(W_adj, tpFixed_frac, baseSL_frac, costs, holdHours, lev) {
    // Per-side cost = commission + spread/2 + slippage (matches EE's adjPrice model)
    // Round trip = 2 × per-side = 2*commission + spread + 2*slippage
    var roundTrip   = costs.commission * 2 + costs.spread + (costs.slippage || 0) * 2;
    var funding     = Math.ceil(holdHours / 8) * costs.funding8h;
    var feeMultiple = lev * (roundTrip + funding) / baseSL_frac;
    return W_adj * (lev * tpFixed_frac / baseSL_frac) - (1 - W_adj) - feeMultiple;
  }

  /* ── Maximum viable leverage ────────────────────────────────────────────── */
  /* v3 GTI caps: EXTREME→2× (was 1×; big events are when HL execution matters),
     HIGH→3× (was 2×), regime-active adds 1-step soft cap via regimeActive.   */
  function _maxViableLeverage(sector, baseSLPct, conf, mapEntry, gtiCtx, warmTier) {
    if (warmTier) return 1;   // warm price tier → 1× only regardless of everything
    var minStop    = (MIN_SL_PCT[sector] || 0.5) * Math.min(2.0, gtiCtx.volBoost);
    var maxByNoise = Math.max(1, Math.floor(baseSLPct / minStop));
    var maxBySect  = mapEntry.maxLev || 2;
    var maxByConf  = 1;
    for (var i = 0; i < MAX_LEV_BY_CONF.length; i++) {
      if (conf >= MAX_LEV_BY_CONF[i].minConf) { maxByConf = MAX_LEV_BY_CONF[i].maxLev; break; }
    }
    var maxByGTI = gtiCtx.level === 'EXTREME'                    ? 2   // v3: was 1
                 : gtiCtx.level === 'HIGH' || gtiCtx.regimeActive ? 3   // v3: was 2
                 :                                                   5;  // no extra cap
    return Math.min(maxByNoise, maxBySect, maxByConf, maxByGTI);
  }

  /* ── EV comparison table ────────────────────────────────────────────────── */
  function _buildEvTable(conf, baseSLPct, sector, maxLev, holdHours, sig, hlAsset, gtiCtx) {
    var baseSL_frac  = baseSLPct / 100;
    var W_base       = _getEffectiveW(conf, hlAsset, sig.dir);
    var tpFixed_frac = _estimateTpFixed(sig, sector, hlAsset, baseSL_frac);
    var hlCosts      = HL_COSTS[sector]   || HL_COSTS.equity;
    var tradCosts    = TRAD_COSTS[sector] || TRAD_COSTS.equity;
    var effectMinSL  = (MIN_SL_PCT[sector] || 0.5) / 100 * Math.min(2.0, gtiCtx.volBoost);
    var rows         = [];

    /* Traditional 1× */
    var W_trad = _noiseAdjustedW(W_base, baseSL_frac, effectMinSL);
    rows.push({
      route:     'TRAD 1×',
      lev:       1,
      slPct:     +baseSLPct.toFixed(2),
      adjW:      +W_trad.toFixed(3),
      evPerRisk: +_calcEvPerRisk(W_trad, tpFixed_frac, baseSL_frac, tradCosts, holdHours, 1).toFixed(3),
      note:      'Yahoo/backend price, CFD fees'
    });

    /* HL at each leverage level */
    [1, 2, 3, 5].forEach(function (lev) {
      if (lev > maxLev) return;
      var adjSL_frac = baseSL_frac / lev;
      if (adjSL_frac < effectMinSL) {
        rows.push({ route: 'HL ' + lev + '×', lev: lev,
          slPct: +(adjSL_frac * 100).toFixed(2), adjW: null, evPerRisk: null,
          note: 'stop < ' + +(effectMinSL * 100).toFixed(2) + '% noise floor' });
        return;
      }
      var W_adj = _noiseAdjustedW(W_base, adjSL_frac, effectMinSL);
      var ev    = _calcEvPerRisk(W_adj, tpFixed_frac, baseSL_frac, hlCosts, holdHours, lev);
      rows.push({
        route:     'HL ' + lev + '×',
        lev:       lev,
        slPct:     +(adjSL_frac * 100).toFixed(2),
        adjW:      +W_adj.toFixed(3),
        evPerRisk: +ev.toFixed(3),
        note:      lev > 1
          ? lev + '× notional | win target ' + (lev * tpFixed_frac * 100).toFixed(1) + '%'
          : 'HL fees only'
      });
    });

    return rows;
  }

  /* ════════════════════════════════════════════════════════════════════════════
     CORE ROUTING LOGIC
     ════════════════════════════════════════════════════════════════════════════ */

  function route(sig) {
    if (!sig || !sig.asset) return sig;

    var asset    = _norm(sig.asset);
    var mapEntry = INSTRUMENT_MAP[asset];
    if (!mapEntry) return sig;

    _stats.total++;

    var hlAsset   = mapEntry.hlAsset;
    var sector    = mapEntry.sector;
    var conf      = sig.conf    || 50;
    var baseSLPct = sig.stopPct || 2.0;
    var gtiCtx    = _getGTIContext();
    var holdHours = _estimateHoldHours(sig, sector);
    var tier      = _hlTier(hlAsset);

    /* ── HL routing decision ───────────────────────────────────────────────── */
    /* fresh → full EV-optimised routing with leverage
       warm  → always route to HL at 1× (stale price but still better than Yahoo)
       covered/unavailable → keep original asset (HL WS down or not on HL)    */
    var useHL   = tier === 'fresh' || tier === 'warm';
    var warmTier = tier === 'warm';

    /* ── Leverage and EV table ──────────────────────────────────────────────── */
    var maxLev  = _maxViableLeverage(sector, baseSLPct, conf, mapEntry, gtiCtx, warmTier);
    var evTable = _buildEvTable(conf, baseSLPct, sector, maxLev, holdHours, sig, hlAsset, gtiCtx);

    /* Pick best HL row by evPerRisk */
    var bestHLRow = null;
    evTable.forEach(function (row) {
      if (row.route === 'TRAD 1×' || row.evPerRisk === null) return;
      if (!bestHLRow || row.evPerRisk > bestHLRow.evPerRisk) bestHLRow = row;
    });

    /* On warm tier, force 1× regardless of what EV table says */
    if (warmTier && bestHLRow) {
      var hl1xRow = evTable.filter(function (r) { return r.route === 'HL 1×'; })[0];
      if (hl1xRow) bestHLRow = hl1xRow;
    }

    var tradRow    = evTable[0];
    var remapAsset = useHL && hlAsset !== asset;
    var finalLev   = useHL && bestHLRow ? bestHLRow.lev : 1;
    var finalSLPct = useHL && bestHLRow ? bestHLRow.slPct : baseSLPct;

    /* ── Record decision ───────────────────────────────────────────────────── */
    var decision = {
      ts:           Date.now(),
      original:     asset,
      routed_to:    useHL ? hlAsset : asset,
      leverage:     finalLev,
      hl_used:      useHL,
      hl_tier:      tier,
      asset_remap:  remapAsset,
      hold_est_h:   holdHours,
      gti:          gtiCtx.gti,
      gti_level:    gtiCtx.level,
      trad_ev:      tradRow  ? tradRow.evPerRisk  : null,
      hl_best_ev:   bestHLRow ? bestHLRow.evPerRisk : null,
      final_sl_pct: finalSLPct,
      ev_table:     evTable
    };
    _decisions.unshift(decision);
    if (_decisions.length > 50) _decisions.pop();
    if (useHL)        { _stats.hlRouted++;  warmTier ? _stats.hlWarm++ : _stats.hlFresh++; }
    if (finalLev > 1) _stats.leveraged++;
    if (remapAsset)   _stats.remapped++;

    var bestEV = bestHLRow ? bestHLRow.evPerRisk : (tradRow ? tradRow.evPerRisk : null);

    if (!useHL) {
      /* Attach best-available EV so EE can apply the EV gate even for TRAD path */
      if (bestEV !== null) {
        var sigWithEV = Object.assign({}, sig, { _ev: bestEV });
        return sigWithEV;
      }
      return sig;
    }

    /* ── Build routing note ─────────────────────────────────────────────────── */
    var parts = [];
    if (remapAsset) parts.push(asset + '→' + hlAsset);
    parts.push(warmTier ? '[WARM +1×]' : '[FRESH' + (finalLev > 1 ? ' +' + finalLev + '×' : '') + ']');
    if (finalLev > 1) parts.push('SL ' + baseSLPct + '%→' + finalSLPct + '%');
    if (bestHLRow && tradRow) {
      var delta = ((bestHLRow.evPerRisk - tradRow.evPerRisk) * 100).toFixed(0);
      parts.push('EV/risk ' + (bestHLRow.evPerRisk * 100).toFixed(0) + '%' +
                 (delta >= 0 ? ' (+' + delta + '% vs TRAD)' : ' (' + delta + '% vs TRAD)'));
    }
    if (gtiCtx.level === 'HIGH' || gtiCtx.level === 'EXTREME') {
      parts.push('GTI ' + gtiCtx.level + ' → max ' + maxLev + '×');
    }

    /* ── Return modified signal ─────────────────────────────────────────────── */
    var routed = Object.assign({}, sig);
    if (remapAsset)   { routed.asset = hlAsset; routed.original_asset = sig.asset; }
    if (finalLev > 1) { routed.stopPct = finalSLPct; routed.leverage = finalLev; }
    routed.reason = (sig.reason ? sig.reason + ' | ' : '') + 'GII-ROUTING: ' + parts.join(' | ');
    if (bestEV !== null) routed._ev = bestEV;
    return routed;
  }

  /* ════════════════════════════════════════════════════════════════════════════
     PUBLIC API
     ════════════════════════════════════════════════════════════════════════════ */
  window.GII_ROUTING = {

    route: route,

    /* Dry-run — shows what the router would do without recording a decision.
       Example: GII_ROUTING.preview('GLD', 80, { stopPct: 1.5, impactMult: 1.3 }) */
    preview: function (asset, conf, opts) {
      opts = opts || {};
      var fakeSig = {
        asset:      asset,
        conf:       conf || 70,
        stopPct:    opts.stopPct    || 2.0,
        tpRatio:    opts.tpRatio    || 2.0,
        impactMult: opts.impactMult || null,
        dir:        opts.dir        || 'LONG'
      };
      var preStats  = Object.assign({}, _stats);
      var preLen    = _decisions.length;
      route(fakeSig);
      // Save the preview decision BEFORE rolling it back
      var previewDec = _decisions[0] || null;
      _decisions.splice(0, _decisions.length - preLen);  // remove preview entry
      _stats = preStats;                                   // revert stats
      return {
        signal:    previewDec ? Object.assign({}, fakeSig, {
          asset:    previewDec.routed_to,
          stopPct:  previewDec.final_sl_pct,
          leverage: previewDec.leverage
        }) : fakeSig,
        evTable:   previewDec ? previewDec.ev_table : [],
        decision:  previewDec
      };
    },

    /* v54: force a cache rebuild on the next route() call so a freshly-closed
       trade is reflected immediately rather than waiting up to 5 min */
    invalidateWinRateCache: function () { _winRateCache.ts = 0; },

    decisions: function () { return _decisions.slice(); },

    status: function () {
      var gti = _getGTIContext();
      return {
        lastPoll:       _decisions.length ? _decisions[0].ts : 0,   // v5: health panel uses this; routing is on-demand not polled
        note:           'on-demand router — ' + _stats.total + ' decisions',
        totalDecisions: _stats.total,
        hlRouted:       _stats.hlRouted,
        hlFresh:        _stats.hlFresh,
        hlWarm:         _stats.hlWarm,
        leveraged:      _stats.leveraged,
        remapped:       _stats.remapped,
        instruments:    Object.keys(INSTRUMENT_MAP).length,
        hlFeedLive:     !!(window.HLFeed && HLFeed.status && HLFeed.status().connected),
        currentGTI:     gti.gti,
        gtiLevel:       gti.level,
        volBoost:       gti.volBoost,
        regimeActive:   gti.regimeActive,
        winRateCacheAge: _winRateCache.ts
          ? Math.round((Date.now() - _winRateCache.ts) / 1000) + 's'
          : 'never',
        lastDecision:   _decisions[0] || null
      };
    },

    // signals() stub — routing is infrastructure, not a signal emitter,
    // but health panels call this so return empty array rather than throw
    signals: function () { return []; }
  };

  if (typeof console !== 'undefined') {
    console.log('[GII-ROUTING v3] Loaded — ' + Object.keys(INSTRUMENT_MAP).length +
                ' instruments | HL-FIRST mode | WARM tier (30s-2min) routes at 1× | ' +
                'lev: ≥65%→2×, ≥75%→3×, ≥85%→5× | GII_ROUTING.preview("GLD",80) to test');

    // Boot-time sync check: warn about INSTRUMENT_MAP assets not covered by HL feed
    // Runs after load to give HLFeed time to register its coverage list.
    window.addEventListener('load', function () {
      setTimeout(function () {
        if (!window.HLFeed || typeof HLFeed.coverage !== 'function') return;
        var hlCovered  = HLFeed.coverage();                  // EE canonical names HL covers
        var mapAssets  = Object.keys(INSTRUMENT_MAP);
        var gaps = mapAssets.filter(function (a) {
          var hlAsset = INSTRUMENT_MAP[a].hlAsset;
          return hlCovered.indexOf(hlAsset) === -1 && hlCovered.indexOf(a) === -1;
        });
        if (gaps.length) {
          console.warn('[GII-ROUTING] HL coverage gaps (' + gaps.length + ' assets in INSTRUMENT_MAP ' +
                       'but not in HLFeed): ' + gaps.join(', '));
        } else {
          console.log('[GII-ROUTING] HL coverage check: all INSTRUMENT_MAP assets present in HLFeed ✓');
        }
      }, 5000);  // 5s after load — HLFeed WS needs a moment to populate coverage
    });
  }

}());
