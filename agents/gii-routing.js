/* ══════════════════════════════════════════════════════════════════════════════
   GII-ROUTING v2 — Instrument Router & Leverage Optimiser
   ══════════════════════════════════════════════════════════════════════════════
   Called by EE.onSignals() before every signal is processed. For each signal:

   1. ROUTE: checks if the asset has a better HL perpetual equivalent.
      e.g.  GLD (SPDR ETF, Yahoo price) → XAU (HL GOLD perp, real-time price)

   2. LEVERAGE: finds the leverage level where net EV (per dollar at risk) is
      highest, given the event-driven expected move, noise constraints, current
      market regime, and the asset's empirical win rate.

   ── v2 fixes & improvements vs v1 ──────────────────────────────────────────
   ✓ EV formula fixed: TP is now a FIXED event-driven target, not scaled by
     stop distance. At 2× leverage you have twice as many units, so wins
     DOUBLE while losses stay constant (risk-based sizing). v1 incorrectly
     halved the win payout, making leverage always appear worse than 1×.
   ✓ Noise-adjusted win probability: quadratic model. As stop approaches the
     sector noise floor, an increasing fraction of stop-hits are random noise
     (not real adverse moves). At exactly the noise floor, ~50% are noise.
     This creates a natural EV peak at an optimal leverage, not at max.
   ✓ GTI / regime awareness: reads GII.gti() and GII.status().volatilityBoost.
     EXTREME GTI (≥80) disables leverage entirely. HIGH GTI (≥60) caps at 2×.
     Active regime shifts widen noise floors via the volatilityBoost multiplier.
   ✓ Self-learning win rates: reads EE.getAllTrades() (cached 5 min). After
     ≥5 closed trades per asset×direction, blends empirical rate (60%) with
     signal confidence (40%) for a more accurate win probability.
   ✓ Better TP estimation: uses signal atrTarget (ATR-based absolute target)
     when available, else sector-based event magnitudes × impactMult, else
     the traditional baseSL × tpRatio as a last resort.
   ✓ Fixed HLFeed.isAvailable() vs covers(): only routes when price is fresh.
   ✓ Added XRP, BNB, ADA, ASML; added OIL/CRUDE/XAG as HL asset aliases.
   ✓ Better hold time: uses impactMult as an event speed proxy, extends holds
     for equity signals arriving outside US market hours.

   EV model (per dollar of capital at risk):
     evPerRisk = W_adj × (lev × tpFixed / baseSL) − (1−W_adj) − lev × fees / baseSL
     where W_adj = W × (1 − min(0.50, (minSL/adjSL)² × 0.50))  ← quadratic noise
     A value of 1.0 means you expect to profit 100% of capital at risk per trade.

   Public API: window.GII_ROUTING
     .route(signal)              → modified signal (or original if no improvement)
     .preview(asset, conf, opts) → dry-run EV table (does not record a decision)
     .decisions()                → last 50 routing decisions with full EV tables
     .status()                   → summary stats
   ══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Instrument map: traditional asset → HL perpetual equivalent ────────────
     Only assets where HL is available or meaningfully better.
     GLD → XAU is the key remap: GLD is the SPDR ETF (~$275 = 1/10 oz gold).
     HL trades spot GOLD (~$3000). Routing to XAU fixes the price and sizing.  */
  var INSTRUMENT_MAP = {
    /* Precious metals */
    'GLD':    { hlAsset: 'XAU',    sector: 'precious', maxLev: 5 },
    'SLV':    { hlAsset: 'SILVER', sector: 'precious', maxLev: 5 },
    'XAU':    { hlAsset: 'XAU',    sector: 'precious', maxLev: 5 },
    'GOLD':   { hlAsset: 'GOLD',   sector: 'precious', maxLev: 5 },
    'SILVER': { hlAsset: 'SILVER', sector: 'precious', maxLev: 5 },
    'XAG':    { hlAsset: 'SILVER', sector: 'precious', maxLev: 5 },
    /* Energy */
    'WTI':    { hlAsset: 'WTI',    sector: 'energy',   maxLev: 5 },
    'OIL':    { hlAsset: 'WTI',    sector: 'energy',   maxLev: 5 },
    'CRUDE':  { hlAsset: 'WTI',    sector: 'energy',   maxLev: 5 },
    'BRENT':  { hlAsset: 'BRENT',  sector: 'energy',   maxLev: 5 },
    /* Crypto */
    'BTC':    { hlAsset: 'BTC',    sector: 'crypto',   maxLev: 3 },
    'ETH':    { hlAsset: 'ETH',    sector: 'crypto',   maxLev: 3 },
    'SOL':    { hlAsset: 'SOL',    sector: 'crypto',   maxLev: 2 },
    'XRP':    { hlAsset: 'XRP',    sector: 'crypto',   maxLev: 2 },
    'BNB':    { hlAsset: 'BNB',    sector: 'crypto',   maxLev: 2 },
    'ADA':    { hlAsset: 'ADA',    sector: 'crypto',   maxLev: 2 },
    /* US equities */
    'SPY':    { hlAsset: 'SPY',    sector: 'equity',   maxLev: 3 },
    'QQQ':    { hlAsset: 'QQQ',    sector: 'equity',   maxLev: 3 },
    'NVDA':   { hlAsset: 'NVDA',   sector: 'equity',   maxLev: 3 },
    'TSM':    { hlAsset: 'TSM',    sector: 'equity',   maxLev: 3 },
    'ASML':   { hlAsset: 'ASML',   sector: 'equity',   maxLev: 2 },
    'AAPL':   { hlAsset: 'AAPL',   sector: 'equity',   maxLev: 2 },
    'TSLA':   { hlAsset: 'TSLA',   sector: 'equity',   maxLev: 2 },
    'LMT':    { hlAsset: 'LMT',    sector: 'equity',   maxLev: 3 },
    'RTX':    { hlAsset: 'RTX',    sector: 'equity',   maxLev: 3 },
    'NOC':    { hlAsset: 'NOC',    sector: 'equity',   maxLev: 3 },
    'XLE':    { hlAsset: 'XLE',    sector: 'equity',   maxLev: 3 },
    'GDX':    { hlAsset: 'GDX',    sector: 'equity',   maxLev: 2 },
    'SMH':    { hlAsset: 'SMH',    sector: 'equity',   maxLev: 3 },
    'FXI':    { hlAsset: 'FXI',    sector: 'equity',   maxLev: 2 },
    'XOM':    { hlAsset: 'XOM',    sector: 'equity',   maxLev: 2 }
  };

  /* ── Fee structures ─────────────────────────────────────────────────────────
     HL: 0.05% taker commission. Traditional: CFD/stock estimates.
     roundTrip = commission × 2 + spread × 2 (in/out at taker rate + spread). */
  var HL_COSTS = {
    precious: { commission: 0.0005, spread: 0.0002, funding8h: 0.00005 },
    energy:   { commission: 0.0005, spread: 0.0003, funding8h: 0.00005 },
    crypto:   { commission: 0.0005, spread: 0.0002, funding8h: 0.0001  },
    equity:   { commission: 0.0005, spread: 0.0002, funding8h: 0       }
  };

  var TRAD_COSTS = {
    precious: { commission: 0.0007, spread: 0.0003, funding8h: 0       },
    energy:   { commission: 0.0007, spread: 0.0005, funding8h: 0       },
    crypto:   { commission: 0.0010, spread: 0.0008, funding8h: 0.0001  },
    equity:   { commission: 0.0005, spread: 0.0002, funding8h: 0       }
  };

  /* ── Sector-based expected TP moves ─────────────────────────────────────────
     Typical price reaction to a significant geopolitical/macro event.
     These are the "fixed" targets the signal is aiming for — independent of
     where the stop is placed. Used when signal doesn't carry an atrTarget.
     Scaled by impactMult (0.5–2.0) from gii-core's convergence/regime logic. */
  var SECTOR_TP_PCT = {
    precious: 1.8,   // gold: ~1.5–2.5% on major events (FOMC, conflict, sanctions)
    energy:   2.5,   // oil: ~2–3% on OPEC/Hormuz/pipeline events
    crypto:   5.0,   // BTC/ETH: ~4–6% on regulatory, macro, large-liquidation events
    equity:   1.5    // index/stock: ~1–2% on trade, tariff, earnings-miss events
  };

  /* ── Minimum viable stop % by sector ───────────────────────────────────────
     Stops tighter than this will be hit by normal intraday noise, not signal.
     Multiplied by GII volatilityBoost (1.0–2.0) during regime shifts.        */
  var MIN_SL_PCT = {
    precious: 0.50,   // gold intraday noise: ~0.3–0.7%
    energy:   0.80,   // oil intraday noise: ~0.5–1.2%
    crypto:   2.00,   // BTC/ETH intraday noise: 1.5–3%
    equity:   0.40    // large-cap stocks: ~0.3–0.6%
  };

  /* ── Max leverage by confidence band ───────────────────────────────────────
     Overridden downward by GTI context. Real HL supports up to 50× but that
     would be reckless for a news-driven signal bot.                           */
  var MAX_LEV_BY_CONF = [
    { minConf: 85, maxLev: 5 },
    { minConf: 80, maxLev: 3 },
    { minConf: 70, maxLev: 2 },
    { minConf:  0, maxLev: 1 }   // below 70% confidence: never leverage
  ];

  /* ── State ─────────────────────────────────────────────────────────────── */
  var _decisions       = [];                // last 50 routing decisions
  var _stats           = { total: 0, hlRouted: 0, leveraged: 0, remapped: 0 };
  var _winRateCache    = { data: {}, ts: 0 };  // refreshed every 5 min
  var WIN_RATE_TTL_MS  = 300000;

  /* ════════════════════════════════════════════════════════════════════════════
     HELPERS
     ════════════════════════════════════════════════════════════════════════════ */

  function _norm(asset) {
    return String(asset || '').toUpperCase().replace(/[^A-Z0-9]/g, ' ').trim().split(' ')[0];
  }

  /* ── Read GTI and regime context from gii-core.js ──────────────────────── */
  function _getGTIContext() {
    var gti = 50, level = 'MODERATE', volBoost = 1.0, regimeActive = false;
    try {
      if (window.GII && typeof GII.gti === 'function') {
        var g = GII.gti();
        if (g) { gti = g.value || 50; level = g.level || 'MODERATE'; }
      }
      if (window.GII && typeof GII.status === 'function') {
        var s = GII.status();
        if (s) {
          volBoost     = Math.max(1.0, s.volatilityBoost || 1.0);
          regimeActive = volBoost > 1.2;
        }
      }
    } catch (e) { /* GII not ready yet */ }
    return { gti: gti, level: level, volBoost: volBoost, regimeActive: regimeActive };
  }

  /* ── Build empirical win-rate cache from EE trade history ───────────────── */
  function _buildWinRateCache() {
    var now = Date.now();
    if (now - _winRateCache.ts < WIN_RATE_TTL_MS) return _winRateCache.data;

    var data = {};
    try {
      if (window.EE && typeof EE.getAllTrades === 'function') {
        var trades = EE.getAllTrades();
        trades.forEach(function (t) {
          if (t.status !== 'CLOSED' || !t.close_reason) return;
          var key = _norm(t.asset) + '_' + (t.direction || '').toUpperCase();
          if (!data[key]) data[key] = { wins: 0, total: 0 };
          data[key].total++;
          if (t.close_reason === 'TAKE_PROFIT' || t.close_reason === 'TRAILING_STOP') {
            data[key].wins++;
          }
        });
        Object.keys(data).forEach(function (k) {
          data[k].winRate = data[k].total > 0 ? data[k].wins / data[k].total : null;
        });
      }
    } catch (e) { /* EE not ready */ }

    _winRateCache = { data: data, ts: now };
    return data;
  }

  /* Returns effective win probability W, blending empirical rate (60%) with
     signal confidence (40%) once ≥5 closed trades exist for this key.       */
  function _getEffectiveW(conf, asset, dir) {
    var W       = Math.max(0.25, Math.min(0.90, (conf || 50) / 100));
    var cache   = _buildWinRateCache();
    var key     = _norm(asset) + '_' + (dir || '').toUpperCase();
    var entry   = cache[key];
    if (entry && entry.winRate !== null && entry.total >= 5) {
      W = entry.winRate * 0.60 + W * 0.40;
    }
    return Math.max(0.20, Math.min(0.95, W));
  }

  /* ── Quadratic noise-adjustment to win probability ──────────────────────── */
  /* When the stop is close to the noise floor, a fraction of stop-hits are
     random noise rather than real adverse moves. At exactly the noise floor,
     we model ~50% of stop-hits as noise (false exits). The quadratic scaling
     penalises progressively as the stop tightens.                            */
  function _noiseAdjustedW(W, adjSL_frac, minSL_frac) {
    var ratio     = Math.min(1.0, minSL_frac / adjSL_frac);   // 1.0 at noise floor
    var noiseRate = Math.min(0.50, ratio * ratio * 0.50);      // 0–50%, quadratic
    return W * (1 - noiseRate);
  }

  /* ── Estimate hold duration (hours) ────────────────────────────────────── */
  function _estimateHoldHours(sig, sector) {
    var conf       = sig.conf || 50;
    var impact     = sig.impactMult || 1.0;
    // Base hold by confidence: high conf → sharp, fast-moving event
    var base = conf >= 80 ? 4 : conf >= 70 ? 8 : conf >= 55 ? 16 : 24;
    // impactMult > 1.5 means fast-moving situation → shorter hold
    if (impact >= 1.5) base = Math.max(2, base * 0.6);
    // Equity signals during market close need extended hold (overnight)
    if (sector === 'equity') {
      var utcHour = new Date().getUTCHours();
      // US market: 13:30–20:00 UTC (09:30–16:00 EST)
      var isMarketOpen = utcHour >= 13 && utcHour < 20;
      if (!isMarketOpen) base = Math.max(base, 16);   // hold until market opens
    }
    return Math.min(48, Math.round(base));
  }

  /* ── Estimate fixed TP target as fraction of entry price ────────────────── */
  /* Priority: (1) atrTarget in signal + current HL price, (2) sector default
     × impactMult, (3) baseSL × tpRatio fallback.                             */
  function _estimateTpFixed(sig, sector, hlAsset, baseSL_frac) {
    // Option 1: ATR-based absolute TP from gii-technicals, converted via HL price
    if (sig.atrTarget && sig.atrTarget > 0) {
      var hlP = window.HLFeed && typeof HLFeed.getPrice === 'function'
                ? HLFeed.getPrice(hlAsset) : null;
      if (hlP && hlP.price > 0) return sig.atrTarget / hlP.price;
    }
    // Option 2: sector event magnitude × impactMult
    var sectorTP  = (SECTOR_TP_PCT[sector] || 2.0) / 100;
    if (sig.impactMult) {
      return sectorTP * Math.min(2.0, Math.max(0.5, sig.impactMult));
    }
    // Option 3: fallback — traditional stop × ratio (same % regardless of lev)
    var tpRatio = sig.tpRatio || 2.0;
    return baseSL_frac * tpRatio;
  }

  /* ── Core EV formula (per dollar of capital at risk) ───────────────────── */
  /* At leverage lev, notional = riskAmt × lev / baseSL.
     Win: units × price × tpFixed = riskAmt × lev × tpFixed / baseSL
     Loss: units × price × adjSL  = riskAmt  (constant — risk-based sizing!)
     Fees: notional × (roundTrip + funding) = riskAmt × lev × fees / baseSL
     Result > 0 means profitable per dollar at risk.                         */
  function _calcEvPerRisk(W_adj, tpFixed_frac, baseSL_frac, costs, holdHours, lev) {
    var roundTrip   = costs.commission * 2 + costs.spread * 2;
    var funding     = Math.ceil(holdHours / 8) * costs.funding8h;
    var feeMultiple = lev * (roundTrip + funding) / baseSL_frac;
    var winMultiple = lev * tpFixed_frac / baseSL_frac;
    return W_adj * winMultiple - (1 - W_adj) - feeMultiple;
  }

  /* ── Maximum viable leverage: min of noise, sector, confidence, GTI caps ── */
  function _maxViableLeverage(sector, baseSLPct, conf, mapEntry, gtiCtx) {
    var minStop    = (MIN_SL_PCT[sector] || 0.5) * Math.min(2.0, gtiCtx.volBoost);
    var maxByNoise = Math.max(1, Math.floor(baseSLPct / minStop));
    var maxBySect  = mapEntry.maxLev || 2;
    var maxByConf  = 1;
    for (var i = 0; i < MAX_LEV_BY_CONF.length; i++) {
      if (conf >= MAX_LEV_BY_CONF[i].minConf) { maxByConf = MAX_LEV_BY_CONF[i].maxLev; break; }
    }
    // GTI override: high tension → cap leverage to avoid blowouts
    var maxByGTI = gtiCtx.level === 'EXTREME'                   ? 1
                 : gtiCtx.level === 'HIGH' || gtiCtx.regimeActive ? 2
                 :                                                  5;
    return Math.min(maxByNoise, maxBySect, maxByConf, maxByGTI);
  }

  /* ── Build EV comparison table (TRAD 1× vs HL 1×/2×/3×/5×) ────────────── */
  function _buildEvTable(conf, baseSLPct, sector, maxLev, holdHours, sig, hlAsset, gtiCtx) {
    var baseSL_frac  = baseSLPct / 100;
    var W_base       = _getEffectiveW(conf, hlAsset, sig.dir);
    var tpFixed_frac = _estimateTpFixed(sig, sector, hlAsset, baseSL_frac);
    var hlCosts      = HL_COSTS[sector]   || HL_COSTS.equity;
    var tradCosts    = TRAD_COSTS[sector] || TRAD_COSTS.equity;
    var effectMinSL  = (MIN_SL_PCT[sector] || 0.5) / 100 * Math.min(2.0, gtiCtx.volBoost);
    var rows         = [];

    /* Traditional route (1×, non-HL, original stop, higher fees) */
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
        rows.push({
          route: 'HL ' + lev + '×', lev: lev,
          slPct: +(adjSL_frac * 100).toFixed(2),
          adjW: null, evPerRisk: null,
          note: 'stop < ' + +(effectMinSL * 100).toFixed(2) + '% noise floor'
        });
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
        note:      lev > 1 ? lev + '× notional, ' + (lev * tpFixed_frac * 100).toFixed(1) + '% win target'
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
    if (!mapEntry) return sig;   // not a remappable/HL asset

    _stats.total++;

    var hlAsset    = mapEntry.hlAsset;
    var sector     = mapEntry.sector;
    var conf       = sig.conf    || 50;
    var baseSLPct  = sig.stopPct || 2.0;    // % (e.g. 2.0 = 2%)
    var gtiCtx     = _getGTIContext();
    var holdHours  = _estimateHoldHours(sig, sector);

    /* ── HL availability check (fresh price required) ─────────────────────── */
    /* Use isAvailable() not covers(): only route to HL when the WS is live
       and price is < 30s old. covers() returns true even during outages.     */
    var hlAvailable = window.HLFeed &&
                      typeof HLFeed.isAvailable === 'function' &&
                      HLFeed.isAvailable(hlAsset);

    /* ── Leverage and EV table ──────────────────────────────────────────────
       Still compute the table even if HL is down — useful for decisions log  */
    var maxLev  = _maxViableLeverage(sector, baseSLPct, conf, mapEntry, gtiCtx);
    var evTable = _buildEvTable(conf, baseSLPct, sector, maxLev, holdHours, sig, hlAsset, gtiCtx);

    /* ── Pick best HL row by evPerRisk ─────────────────────────────────────── */
    var bestHLRow = null;
    evTable.forEach(function (row) {
      if (row.route === 'TRAD 1×' || row.evPerRisk === null) return;
      if (!bestHLRow || row.evPerRisk > bestHLRow.evPerRisk) bestHLRow = row;
    });

    var tradRow = evTable[0];

    /* ── Decision ──────────────────────────────────────────────────────────── */
    var useHL      = hlAvailable && bestHLRow !== null;
    var remapAsset = useHL && (hlAsset !== asset);   // GLD→XAU is a remap; WTI→WTI is not
    var finalLev   = useHL ? bestHLRow.lev : 1;
    var finalSLPct = useHL ? bestHLRow.slPct : baseSLPct;

    var decision = {
      ts:          Date.now(),
      original:    asset,
      routed_to:   useHL ? hlAsset : asset,
      leverage:    finalLev,
      hl_used:     useHL,
      hl_available:hlAvailable,
      asset_remap: remapAsset,
      hold_est_h:  holdHours,
      gti:         gtiCtx.gti,
      gti_level:   gtiCtx.level,
      trad_ev:     tradRow ? tradRow.evPerRisk : null,
      hl_best_ev:  bestHLRow ? bestHLRow.evPerRisk : null,
      final_sl_pct: finalSLPct,
      ev_table:    evTable
    };
    _decisions.unshift(decision);
    if (_decisions.length > 50) _decisions.pop();
    if (useHL)        _stats.hlRouted++;
    if (finalLev > 1) _stats.leveraged++;
    if (remapAsset)   _stats.remapped++;

    if (!useHL) return sig;   // HL down or no improvement — pass through

    /* ── Build routing note for EE activity log ─────────────────────────────── */
    var parts = [];
    if (remapAsset) parts.push(asset + '→' + hlAsset + ' (HL perp)');
    if (finalLev > 1) {
      parts.push(finalLev + '× lev (SL ' + baseSLPct + '% → ' + finalSLPct + '%)');
    }
    if (bestHLRow && tradRow) {
      var evDelta = ((bestHLRow.evPerRisk - tradRow.evPerRisk) * 100).toFixed(0);
      parts.push('EV/risk: ' + (bestHLRow.evPerRisk * 100).toFixed(0) + '% ' +
                 (evDelta >= 0 ? '(+' + evDelta + '% vs TRAD)' : '(' + evDelta + '% vs TRAD)'));
    }
    if (gtiCtx.level !== 'NORMAL' && gtiCtx.level !== 'MODERATE') {
      parts.push('GTI ' + gtiCtx.level + ' — lev capped at ' + maxLev + '×');
    }
    var routingNote = 'GII-ROUTING: ' + parts.join(' | ');

    /* ── Return modified signal ─────────────────────────────────────────────── */
    var routed = Object.assign({}, sig);
    if (remapAsset)   { routed.asset = hlAsset; routed.original_asset = sig.asset; }
    if (finalLev > 1) { routed.stopPct = finalSLPct; routed.leverage = finalLev; }
    routed.reason = (sig.reason ? sig.reason + ' | ' : '') + routingNote;
    return routed;
  }

  /* ════════════════════════════════════════════════════════════════════════════
     PUBLIC API
     ════════════════════════════════════════════════════════════════════════════ */
  window.GII_ROUTING = {

    route: route,

    /* Dry-run: see what the router would do for a hypothetical signal.
       Options: { stopPct, tpRatio, impactMult, dir }
       Example: GII_ROUTING.preview('GLD', 80, { stopPct: 1.5 })              */
    preview: function (asset, conf, opts) {
      opts = opts || {};
      var fakeSig = {
        asset:      asset,
        conf:       conf || 70,
        stopPct:    opts.stopPct   || 2.0,
        tpRatio:    opts.tpRatio   || 2.0,
        impactMult: opts.impactMult|| null,
        dir:        opts.dir       || 'LONG'
      };
      var preStats = Object.assign({}, _stats);
      var preLen   = _decisions.length;
      var result   = route(fakeSig);
      // Roll back stats and decision (this is a preview, not a real decision)
      _decisions.splice(0, _decisions.length - preLen);
      _stats = preStats;
      // Return the EV table from the just-rolled-back decision (still in slice)
      var dec = _decisions[0];
      return { signal: result, evTable: dec ? dec.ev_table : [], decision: dec || null };
    },

    /* Last N routing decisions — each includes full EV table */
    decisions: function () { return _decisions.slice(); },

    status: function () {
      var gti = _getGTIContext();
      return {
        totalDecisions:  _stats.total,
        hlRouted:        _stats.hlRouted,
        leveraged:       _stats.leveraged,
        remapped:        _stats.remapped,
        instruments:     Object.keys(INSTRUMENT_MAP).length,
        hlFeedLive:      !!(window.HLFeed && HLFeed.status && HLFeed.status().connected),
        currentGTI:      gti.gti,
        gtiLevel:        gti.level,
        volBoost:        gti.volBoost,
        regimeActive:    gti.regimeActive,
        winRateCacheAge: _winRateCache.ts
          ? Math.round((Date.now() - _winRateCache.ts) / 1000) + 's'
          : 'never',
        lastDecision:    _decisions[0] || null
      };
    }
  };

  if (typeof console !== 'undefined') {
    console.log('[GII-ROUTING v2] Loaded — ' + Object.keys(INSTRUMENT_MAP).length +
                ' instruments. GII_ROUTING.preview("GLD", 80) to test. ' +
                'Fixes: EV formula (fixed TP), noise-adjusted W, GTI awareness, empirical win rates.');
  }

}());
