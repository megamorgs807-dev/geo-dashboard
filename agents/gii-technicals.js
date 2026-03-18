/* GII Technical Analysis Agent — gii-technicals.js v3
 *
 * Institutional-grade multi-timeframe TA across 11 assets.
 * Outputs regime-gated, SMC-confirmed, GII-integrated signals with A2A broadcast.
 *
 * Data source hierarchy (per asset):
 *   1. Hyperliquid    — primary (OHLCV, no key, no quota: BTC 15m/1h/4h/daily)
 *   2. Twelve Data    — secondary fallback for equities (800/day free)
 *   3. Alpha Vantage  — tertiary fallback for commodities (25/day free)
 *   4. CryptoCompare  — BTC final fallback (100k/month free)
 *   5. Cache          — stale-data fallback with confidence penalty
 *
 * HL advantage: native 15m + 4h candles, proper OHLCV, and unlimited quota.
 *
 * Setup (one-time): add before this script loads in the dashboard HTML:
 *   <script>
 *     window.GII_TA_KEYS = {
 *       twelvedata:    'YOUR_FREE_KEY',   // twelvedata.com  (free, 800/day)
 *       alphavantage:  'YOUR_FREE_KEY',   // alphavantage.co (free, 25/day)
 *       cryptocompare: 'YOUR_FREE_KEY'    // cryptocompare.com (optional, 100k/month free)
 *     };
 *   </script>
 *
 * Architecture:
 *   1. regimeDetect()          — TRENDING_UP/DOWN | RANGING | VOLATILE | TRANSITIONING
 *   2. computeIndicators()     — adaptive RSI, MACD histogram momentum, EMA slopes,
 *                                Bollinger squeeze, ADX+DI, OBV divergence,
 *                                volume spikes, pivot S/R, ROC-10, VWAP
 *   3. scoreAsset()            — regime-weighted composite score [-1,+1] per timeframe
 *   4. SMC detection           — FVG, Order Blocks, CHoCH, Liquidity Zones
 *   5. mtfComposite()          — daily(50%)+4h(30%)+1h(20%)+15m(confirm) → convictionTier
 *   6. integrateGII()          — GTI, escalation, VIX modifiers from sibling agents
 *   7. integrateOrderFlow()    — market microstructure + smart money positioning
 *   8. feedbackConfMult()      — dynamic confidence from per-asset win rate history
 *   9. buildSignal()           — A2A payload with stop_loss/take_profit/smc_context
 *  10. broadcast()             — window.dispatchEvent('GII_TA_SIGNAL') event bus
 *
 * Requires gii-core.js changes (see bottom of file).
 * Exposes: window.GII_AGENT_TECHNICALS
 */
(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────
  var HL_INFO        = 'https://api.hyperliquid.xyz/info';
  var POLL_MIN_MS    = 600000;    // 10 min — floor for adaptive polling
  var POLL_BASE_MS   = 1800000;   // 30 min — base interval
  var POLL_MAX_MS    = 3600000;   // 60 min — ceiling for adaptive polling
  var POLL_INTERVAL  = POLL_BASE_MS;   // legacy compat — overridden by adaptive logic
  var MAX_SIGNALS    = 50;
  var MIN_CONF       = 0.30;
  var MAX_CONF       = 0.85;
  var FETCH_GAP_MS   = 2500;      // ms between individual API requests (rate limiting)
  var CACHE_KEY      = 'gii_ta_candles_v1';
  var FEEDBACK_KEY   = 'gii_ta_feedback_v1';
  var QUOTA_KEY      = 'gii_ta_quota_v1';
  // Free tier daily limits — skip non-essential fetches when near ceiling
  var QUOTA_LIMITS   = { twelvedata: 750, alphavantage: 22 };   // leave 50/3 buffer

  // ── Asset definitions ──────────────────────────────────────────────────────
  // type:  'equity' | 'crypto' | 'commodity'
  // api:   primary data source
  // For commodity assets Alpha Vantage returns close-only (no true OHLC),
  // so ATR-based stops fall back to 1.5% for those assets.
  // hlCoin — Hyperliquid ticker for candleSnapshot (primary OHLCV source).
  // hl4h    — true when HL native 4h bars are available (skip build-from-1h).
  // NOTE: HL candleSnapshot only works for crypto assets. Equity/commodity perps
  // (SPY, TSM, XLE, SMH, CL, BRENTOIL) return empty arrays from candleSnapshot
  // even though they stream via HLFeed WebSocket. Only BTC confirmed working.
  var ASSETS = [
    { id:'SPY',   sym:'SPY',    api:'twelvedata',    type:'equity',    region:'US'           },
    { id:'GLD',   sym:'GLD',    api:'twelvedata',    type:'equity',    region:'GLOBAL'       },
    { id:'TLT',   sym:'TLT',    api:'twelvedata',    type:'equity',    region:'US'           },
    { id:'TSM',   sym:'TSM',    api:'twelvedata',    type:'equity',    region:'TAIWAN'       },
    { id:'XLE',   sym:'XLE',    api:'twelvedata',    type:'equity',    region:'US'           },
    { id:'SMH',   sym:'SMH',    api:'twelvedata',    type:'equity',    region:'US'           },
    { id:'SOXX',  sym:'SOXX',   api:'twelvedata',    type:'equity',    region:'US'           },
    { id:'BTC',   sym:'BTC',    api:'cryptocompare', type:'crypto',    region:'GLOBAL',      hlCoin:'BTC', hl4h:true },
    { id:'WTI',   sym:'WTI',    api:'alphavantage',  type:'commodity', region:'MIDDLE EAST'  },
    { id:'BRENT', sym:'BRENT',  api:'alphavantage',  type:'commodity', region:'MIDDLE EAST'  },
    { id:'WEAT',  sym:'WHEAT',  api:'alphavantage',  type:'commodity', region:'UKRAINE'      }
  ];

  // Alpha Vantage function names for each commodity
  var AV_FUNCS = { WTI: 'WTI', BRENT: 'BRENT', WHEAT: 'WHEAT' };

  // ── Regime-weighted indicator scores ──────────────────────────────────────
  // Each indicator returns a score in [-1, +1]; these weights determine the
  // contribution of each to the composite. Sums to 1.0 per regime.
  var W = {
    TRENDING_UP:   { ema:0.22, macd:0.20, rsi:0.05, rsiDiv:0.10, bb:0.04, obv:0.12, vol:0.10, pivot:0.08, roc:0.09 },
    TRENDING_DOWN: { ema:0.22, macd:0.20, rsi:0.05, rsiDiv:0.10, bb:0.04, obv:0.12, vol:0.10, pivot:0.08, roc:0.09 },
    RANGING:       { ema:0.05, macd:0.08, rsi:0.20, rsiDiv:0.17, bb:0.15, obv:0.10, vol:0.07, pivot:0.12, roc:0.04, stoch:0.02 },
    VOLATILE:      { ema:0.05, macd:0.05, rsi:0.08, rsiDiv:0.08, bb:0.14, obv:0.10, vol:0.16, pivot:0.10, roc:0.10 },
    TRANSITIONING: { ema:0.14, macd:0.13, rsi:0.11, rsiDiv:0.12, bb:0.10, obv:0.10, vol:0.09, pivot:0.10, roc:0.08, stoch:0.03 }
  };

  // ── State ──────────────────────────────────────────────────────────────────
  var _signals       = [];
  var _cache         = {};   // { 'SPY_daily': { candles:[], fetchedAt:ts, source:'' } }
  var _status        = { lastPoll:null, assetsAnalysed:0, activeSignals:[], dataStatus:{}, health:'UNKNOWN' };
  var _accuracy      = { total:0, correct:0, winRate:null };
  var _feedback      = {};
  var _fetchSeq      = Promise.resolve();   // serialised fetch queue
  var _hlFetchErrors  = 0;    // consecutive HL fetch failures — triggers health downgrade
  var _pollTimer      = null; // reference to current setTimeout for adaptive rescheduling
  var _lastBroadcast  = {};   // { assetId: { bias, conviction, ts } } — dedup broadcast
  // Daily API quota tracker: { date:'YYYY-MM-DD', twelvedata:N, alphavantage:N }
  var _quota          = { date: '', twelvedata: 0, alphavantage: 0 };

  // ── Persistence ────────────────────────────────────────────────────────────
  (function _boot() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        var now    = Date.now();
        Object.keys(parsed).forEach(function (k) {
          var e = parsed[k];
          if (e.fetchedAt && now - e.fetchedAt < 86400000) _cache[k] = e;
        });
      }
    } catch (e) {}
    try {
      var fb = localStorage.getItem(FEEDBACK_KEY);
      if (fb) _feedback = JSON.parse(fb);
    } catch (e) {}
  })();

  function _saveCache() {
    try {
      var out = {};
      Object.keys(_cache).forEach(function (k) {
        out[k] = { candles: _cache[k].candles.slice(-300), fetchedAt: _cache[k].fetchedAt, source: _cache[k].source };
      });
      localStorage.setItem(CACHE_KEY, JSON.stringify(out));
    } catch (e) {}
  }

  // ── API quota tracking ───────────────────────────────────────────────────────
  function _quotaToday() {
    var today = new Date().toISOString().slice(0, 10);
    if (_quota.date !== today) {
      // New day — reset counters
      _quota = { date: today, twelvedata: 0, alphavantage: 0 };
      try { localStorage.setItem(QUOTA_KEY, JSON.stringify(_quota)); } catch (e) {}
    }
    // Load persisted count for today
    try {
      var stored = JSON.parse(localStorage.getItem(QUOTA_KEY) || '{}');
      if (stored.date === today) { _quota.twelvedata = stored.twelvedata || 0; _quota.alphavantage = stored.alphavantage || 0; }
    } catch (e) {}
    return _quota;
  }

  function _quotaIncrement(api) {
    _quotaToday();
    if (_quota[api] !== undefined) {
      _quota[api]++;
      _status.apiQuota = Object.assign({}, _quota);
      try { localStorage.setItem(QUOTA_KEY, JSON.stringify(_quota)); } catch (e) {}
    }
  }

  function _quotaExceeded(api) {
    _quotaToday();
    var limit = QUOTA_LIMITS[api];
    if (!limit) return false;
    if (_quota[api] >= limit) {
      console.warn('[GII-TA] Daily quota reached for ' + api + ' (' + _quota[api] + '/' + limit + ') — using cached data only');
      return true;
    }
    return false;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ── PURE TA MATHS ───────────────────────────────────────────────────────────
  // All functions are pure (no side-effects). Input: plain arrays/objects.
  // ────────────────────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function _sign(v)  { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  function _mean(a)  { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : 0; }
  function _min(a)   { return Math.min.apply(null, a); }
  function _max(a)   { return Math.max.apply(null, a); }
  function _last(a)  { return a[a.length - 1]; }
  function _notNaN(v) { return typeof v === 'number' && isFinite(v) && !isNaN(v); }
  function _validSlice(a, from) {
    return a.slice(Math.max(0, from)).filter(_notNaN);
  }

  // Simple Moving Average
  function _sma(closes, period) {
    var result = [];
    for (var i = 0; i < closes.length; i++) {
      if (i < period - 1) { result.push(NaN); continue; }
      var sum = 0;
      for (var j = i - period + 1; j <= i; j++) sum += closes[j];
      result.push(sum / period);
    }
    return result;
  }

  // Exponential Moving Average
  function _ema(closes, period) {
    var k      = 2 / (period + 1);
    var result = [];
    var seed   = _mean(closes.slice(0, period));
    for (var i = 0; i < closes.length; i++) {
      if (i < period - 1) { result.push(NaN); continue; }
      if (i === period - 1) { result.push(seed); continue; }
      result.push(closes[i] * k + result[i - 1] * (1 - k));
    }
    return result;
  }

  // RSI (Wilder's smoothing)
  function _rsi(closes, period) {
    if (closes.length < period + 1) return [];
    var result = new Array(closes.length).fill(NaN);
    var gains  = 0, losses = 0;
    for (var i = 1; i <= period; i++) {
      var d = closes[i] - closes[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    gains  /= period;
    losses /= period;
    for (var i = period; i < closes.length; i++) {
      if (i > period) {
        var d  = closes[i] - closes[i - 1];
        gains  = (gains  * (period - 1) + (d > 0 ? d : 0)) / period;
        losses = (losses * (period - 1) + (d < 0 ? -d : 0)) / period;
      }
      result[i] = losses === 0 ? 100 : 100 - (100 / (1 + gains / losses));
    }
    return result;
  }

  // Average True Range
  function _atr(candles, period) {
    var tr     = [];
    var result = new Array(candles.length).fill(NaN);
    for (var i = 1; i < candles.length; i++) {
      var h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
      tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    if (tr.length < period) return result;
    var val = _mean(tr.slice(0, period));
    result[period] = val;
    for (var i = period + 1; i < candles.length; i++) {
      val = (val * (period - 1) + tr[i - 1]) / period;
      result[i] = val;
    }
    return result;
  }

  // MACD
  function _macd(closes, fast, slow, sig) {
    var eFast = _ema(closes, fast);
    var eSlow = _ema(closes, slow);
    var line  = closes.map(function (_, i) {
      return _notNaN(eFast[i]) && _notNaN(eSlow[i]) ? eFast[i] - eSlow[i] : NaN;
    });
    // Build signal line on valid MACD values only, then re-map back
    var valid    = line.filter(_notNaN);
    var sigSmooth = _ema(valid, sig);
    var sigFull  = new Array(closes.length).fill(NaN);
    var si = 0;
    for (var i = 0; i < closes.length; i++) {
      if (_notNaN(line[i]) && si < sigSmooth.length) sigFull[i] = sigSmooth[si++];
    }
    var hist = line.map(function (v, i) {
      return _notNaN(v) && _notNaN(sigFull[i]) ? v - sigFull[i] : NaN;
    });
    return { macdLine: line, signalLine: sigFull, histogram: hist };
  }

  // Bollinger Bands
  function _bollinger(closes, period, mult) {
    var mid   = _sma(closes, period);
    var upper = [], lower = [], bw = [], pctB = [];
    for (var i = 0; i < closes.length; i++) {
      if (i < period - 1) { upper.push(NaN); lower.push(NaN); bw.push(NaN); pctB.push(NaN); continue; }
      var sl  = closes.slice(i - period + 1, i + 1);
      var avg = mid[i];
      var sd  = Math.sqrt(sl.reduce(function (s, v) { return s + (v - avg) * (v - avg); }, 0) / period);
      var u   = avg + mult * sd;
      var l   = avg - mult * sd;
      upper.push(u); lower.push(l);
      bw.push(avg !== 0 ? (u - l) / avg : 0);
      pctB.push(u !== l ? (closes[i] - l) / (u - l) : 0.5);
    }
    return { upper: upper, lower: lower, middle: mid, bandwidth: bw, pctB: pctB };
  }

  // ADX with +DI / -DI (Wilder's smoothing)
  function _adx(candles, period) {
    var empty = { adx: [], plusDI: [], minusDI: [] };
    if (candles.length < period + 2) return empty;
    var plusDM = [], minusDM = [], tr = [];
    for (var i = 1; i < candles.length; i++) {
      var up   = candles[i].high  - candles[i - 1].high;
      var dn   = candles[i - 1].low - candles[i].low;
      plusDM.push (up   > dn  && up   > 0 ? up   : 0);
      minusDM.push(dn   > up  && dn   > 0 ? dn   : 0);
      var h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
      tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    function wilder(arr, p) {
      var r = new Array(arr.length).fill(NaN);
      r[p - 1] = arr.slice(0, p).reduce(function (s, v) { return s + v; }, 0);
      for (var i = p; i < arr.length; i++) r[i] = r[i - 1] - r[i - 1] / p + arr[i];
      return r;
    }
    var sTR = wilder(tr, period), sPDM = wilder(plusDM, period), sMDM = wilder(minusDM, period);
    var n   = candles.length;
    var pDI = new Array(n).fill(NaN), mDI = new Array(n).fill(NaN), dx = new Array(n).fill(NaN);
    for (var i = period; i < n; i++) {
      var idx = i - 1;
      if (!_notNaN(sTR[idx]) || sTR[idx] === 0) continue;
      pDI[i] = (sPDM[idx] / sTR[idx]) * 100;
      mDI[i] = (sMDM[idx] / sTR[idx]) * 100;
      dx[i]  = (pDI[i] + mDI[i]) !== 0 ? Math.abs(pDI[i] - mDI[i]) / (pDI[i] + mDI[i]) * 100 : 0;
    }
    var validDX  = dx.filter(_notNaN);
    var adxSmooth = wilder(validDX, period);
    var adxFull  = new Array(n).fill(NaN);
    var ai = 0;
    for (var i = 0; i < n; i++) { if (_notNaN(dx[i]) && ai < adxSmooth.length) adxFull[i] = adxSmooth[ai++]; }
    return { adx: adxFull, plusDI: pDI, minusDI: mDI };
  }

  // On-Balance Volume
  function _obv(closes, volumes) {
    var result = [0];
    for (var i = 1; i < closes.length; i++) {
      var prev = result[result.length - 1];
      if   (closes[i] > closes[i - 1]) result.push(prev + volumes[i]);
      else if (closes[i] < closes[i - 1]) result.push(prev - volumes[i]);
      else result.push(prev);
    }
    return result;
  }

  // Stochastic %K (raw, no smoothing)
  function _stochastic(candles, kPeriod) {
    var result = new Array(candles.length).fill(NaN);
    for (var i = kPeriod - 1; i < candles.length; i++) {
      var sl    = candles.slice(i - kPeriod + 1, i + 1);
      var lo    = _min(sl.map(function (c) { return c.low; }));
      var hi    = _max(sl.map(function (c) { return c.high; }));
      result[i] = hi !== lo ? ((candles[i].close - lo) / (hi - lo)) * 100 : 50;
    }
    return result;
  }

  // Pivot Points (standard floor pivots)
  function _pivots(pH, pL, pC) {
    var pp = (pH + pL + pC) / 3;
    return {
      pp: pp,
      r1: 2 * pp - pL,   r2: pp + (pH - pL),   r3: pH  + 2 * (pp - pL),
      s1: 2 * pp - pH,   s2: pp - (pH - pL),   s3: pL  - 2 * (pH - pp)
    };
  }

  // RSI Divergence — scans last `lookback` candles for swing pivots
  function _rsiDivergence(closes, rsiVals, lookback) {
    lookback = lookback || 50;
    var n = closes.length;
    if (n < lookback) return null;
    var sc = closes.slice(n - lookback);
    var sr = rsiVals.slice(n - lookback).map(function (v) { return _notNaN(v) ? v : 50; });
    var len = sc.length;

    var sHigh = [], sLow = [];
    // 5-bar lookback pivot detection — must have 5 bars on each side
    for (var i = 5; i < len - 5; i++) {
      var hi = true, lo = true;
      for (var j = i - 5; j <= i + 5; j++) {
        if (j === i) continue;
        if (sc[j] >= sc[i]) hi = false;
        if (sc[j] <= sc[i]) lo = false;
      }
      if (hi) sHigh.push(i);
      if (lo) sLow.push(i);
    }

    if (sHigh.length >= 2) {
      var h1 = sHigh[sHigh.length - 2], h2 = sHigh[sHigh.length - 1];
      if (sc[h2] > sc[h1] && sr[h2] < sr[h1])   // price HH, RSI LH
        return { type: 'bearish_regular', strength: Math.abs(sc[h2] - sc[h1]) / sc[h1] };
      if (sc[h2] < sc[h1] && sr[h2] > sr[h1])   // price LH, RSI HH
        return { type: 'bearish_hidden',  strength: Math.abs(sc[h2] - sc[h1]) / sc[h1] };
    }
    if (sLow.length >= 2) {
      var l1 = sLow[sLow.length - 2], l2 = sLow[sLow.length - 1];
      if (sc[l2] < sc[l1] && sr[l2] > sr[l1])   // price LL, RSI HL
        return { type: 'bullish_regular', strength: Math.abs(sc[l2] - sc[l1]) / sc[l1] };
      if (sc[l2] > sc[l1] && sr[l2] < sr[l1])   // price HL, RSI LL
        return { type: 'bullish_hidden',  strength: Math.abs(sc[l2] - sc[l1]) / sc[l1] };
    }
    return null;
  }

  // VWAP for a set of intraday candles
  function _vwap(candles) {
    var cumTPV = 0, cumV = 0;
    candles.forEach(function (c) {
      var tp = (c.high + c.low + c.close) / 3;
      cumTPV += tp * c.volume; cumV += c.volume;
    });
    return cumV > 0 ? cumTPV / cumV : null;
  }

  // Build 4h candles from 1h by aligning to UTC 4h boundaries (00,04,08,12,16,20)
  function _build4h(candles1h) {
    var bars = {};
    candles1h.forEach(function (c) {
      var b = Math.floor(c.timestamp / 14400) * 14400;
      if (!bars[b]) bars[b] = { timestamp: b, open: c.open, high: -Infinity, low: Infinity, close: c.close, volume: 0, count: 0 };
      var r = bars[b];
      if (c.high  > r.high)  r.high  = c.high;
      if (c.low   < r.low)   r.low   = c.low;
      r.close   = c.close;
      r.volume += c.volume;
      r.count++;
    });
    return Object.values(bars)
      .filter(function (b) { return b.count === 4; })   // complete 4h bars only
      .sort(function (a, b) { return a.timestamp - b.timestamp; });
  }

  // ── Smart Money Concepts (SMC) Detection ────────────────────────────────────
  // Pure functions — input: candles array. All return null on insufficient data.

  // Fair Value Gap: 3-bar imbalance where the impulse bar skips over the prior bar.
  // Bullish FVG: candles[i].low > candles[i-2].high
  // Bearish FVG: candles[i].high < candles[i-2].low
  function _detectFVG(candles) {
    if (!candles || candles.length < 5) return null;
    var result = { bullish: [], bearish: [], latest: null };
    for (var i = 2; i < candles.length; i++) {
      var prev2 = candles[i - 2];
      var curr  = candles[i];
      if (curr.low > prev2.high) {
        result.bullish.push({ index: i, gapHigh: curr.low, gapLow: prev2.high, size: curr.low - prev2.high });
      } else if (curr.high < prev2.low) {
        result.bearish.push({ index: i, gapHigh: prev2.low, gapLow: curr.high, size: prev2.low - curr.high });
      }
    }
    var recent = candles.length - 10;
    var rb = result.bullish.filter(function (g) { return g.index >= recent; });
    var rr = result.bearish.filter(function (g) { return g.index >= recent; });
    if (rb.length)      result.latest = { type: 'bullish', fvg: rb[rb.length - 1] };
    else if (rr.length) result.latest = { type: 'bearish', fvg: rr[rr.length - 1] };
    return result;
  }

  // Order Block: last counter-trend candle before a significant impulse (≥1.8× ATR).
  // Bullish OB: last bearish candle before an up move.
  // Bearish OB: last bullish candle before a down move.
  function _detectOrderBlocks(candles) {
    if (!candles || candles.length < 10) return null;
    var atrArr  = _atr(candles, 14);
    var atrSlice = _validSlice(atrArr, candles.length - 20);
    var atrBase = _mean(atrSlice) || 0;
    if (atrBase === 0) return null;
    var blocks = [];
    for (var i = 2; i < candles.length - 1; i++) {
      var move      = Math.abs(candles[i + 1].close - candles[i].open);
      if (move < atrBase * 1.8) continue;
      var impulseUp = candles[i + 1].close > candles[i].open;
      if (impulseUp && candles[i].close < candles[i].open) {
        blocks.push({ type: 'bullish', index: i, high: candles[i].high, low: candles[i].low,
                      price: (candles[i].high + candles[i].low) / 2 });
      } else if (!impulseUp && candles[i].close > candles[i].open) {
        blocks.push({ type: 'bearish', index: i, high: candles[i].high, low: candles[i].low,
                      price: (candles[i].high + candles[i].low) / 2 });
      }
    }
    var recent    = candles.length - 15;
    var latest    = blocks.filter(function (b) { return b.index >= recent; });
    var currentPx = candles[candles.length - 1].close;
    var near      = latest.filter(function (b) { return Math.abs(currentPx - b.price) < atrBase; });
    return { blocks: latest, nearPrice: near, atrBase: atrBase };
  }

  // Change of Character: swing structure break signals potential reversal.
  // Bullish CHoCH: bearish structure (lower-highs/lows) but price breaks above last swing high.
  // Bearish CHoCH: bullish structure (higher-highs/lows) but price breaks below last swing low.
  function _detectCHoCH(candles) {
    if (!candles || candles.length < 20) return null;
    var n = candles.length;
    var swingHighs = [], swingLows = [];
    for (var i = 5; i < n - 2; i++) {
      var isH = candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
                candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high;
      var isL = candles[i].low  < candles[i-1].low  && candles[i].low  < candles[i-2].low  &&
                candles[i].low  < candles[i+1].low  && candles[i].low  < candles[i+2].low;
      if (isH) swingHighs.push({ index: i, price: candles[i].high });
      if (isL) swingLows.push({ index: i, price: candles[i].low  });
    }
    if (swingHighs.length < 2 || swingLows.length < 2) return null;
    var lastHigh  = swingHighs[swingHighs.length - 1];
    var prevHigh  = swingHighs[swingHighs.length - 2];
    var lastLow   = swingLows[swingLows.length - 1];
    var prevLow   = swingLows[swingLows.length - 2];
    var currentPx = candles[n - 1].close;
    var choch = null;
    if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price && currentPx > lastHigh.price) {
      choch = { type: 'bullish', breakLevel: lastHigh.price, confirmed: true };
    } else if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price && currentPx < lastLow.price) {
      choch = { type: 'bearish', breakLevel: lastLow.price, confirmed: true };
    }
    return { choch: choch, lastSwingHigh: lastHigh, lastSwingLow: lastLow };
  }

  // Liquidity Zones: clusters of equal highs/lows (within 0.3%) where stop orders pool.
  // Also detects sweeps: price spikes through zone then closes back (reversal signal).
  function _detectLiquidityZones(candles) {
    if (!candles || candles.length < 15) return null;
    var n      = candles.length;
    var thresh = 0.003;
    var current = candles[n - 1].close;
    function cluster(vals, label) {
      var zones = [];
      for (var i = 0; i < vals.length; i++) {
        var found = false;
        for (var z = 0; z < zones.length; z++) {
          if (Math.abs(vals[i] - zones[z].price) / zones[z].price < thresh) {
            zones[z].price = (zones[z].price * zones[z].count + vals[i]) / (zones[z].count + 1);
            zones[z].count++;
            found = true;
            break;
          }
        }
        if (!found) zones.push({ price: vals[i], count: 1, type: label });
      }
      return zones.filter(function (z) { return z.count >= 2; });
    }
    var highZones = cluster(candles.map(function (c) { return c.high; }), 'resistance');
    var lowZones  = cluster(candles.map(function (c) { return c.low;  }), 'support');
    var recent3   = candles.slice(-3);
    var sweeps    = [];
    highZones.forEach(function (z) {
      if (recent3.some(function (c) { return c.high > z.price && c.close < z.price; }))
        sweeps.push({ type: 'high_sweep', price: z.price });
    });
    lowZones.forEach(function (z) {
      if (recent3.some(function (c) { return c.low < z.price && c.close > z.price; }))
        sweeps.push({ type: 'low_sweep', price: z.price });
    });
    var above = highZones.filter(function (z) { return z.price > current; }).sort(function (a, b) { return a.price - b.price; });
    var below = lowZones.filter(function (z)  { return z.price < current; }).sort(function (a, b) { return b.price - a.price; });
    return { highZones: highZones, lowZones: lowZones, sweeps: sweeps,
             nearestResistance: above[0] || null, nearestSupport: below[0] || null };
  }

  // ── Adaptive RSI Period ──────────────────────────────────────────────────────
  // Shorter period when volatility is high (market moving faster)
  function _adaptiveRsiPeriod(atrVal, atrBase) {
    if (!atrBase || atrBase === 0) return 14;
    var vr = atrVal / atrBase;
    return _clamp(Math.round(14 / vr), 7, 28);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ── REGIME DETECTION ────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────────

  function _regimeDetect(candlesDaily) {
    var n = candlesDaily.length;
    if (n < 60) return 'RANGING';

    var closes = candlesDaily.map(function (c) { return c.close; });

    // ATR ratio: current vs 20-period baseline
    var atrArr   = _atr(candlesDaily, 14);
    var atrSlice = _validSlice(atrArr, n - 21);
    var atrBase  = _mean(atrSlice.slice(0, -1)) || 1;
    var atrVal   = _last(atrArr) || 0;
    var atrRatio = atrBase > 0 ? atrVal / atrBase : 1;

    // EMA stack
    var ema9   = _last(_ema(closes, 9));
    var ema21  = _last(_ema(closes, 21));
    var ema50  = _last(_ema(closes, 50));
    var price  = closes[n - 1];
    var bull   = _notNaN(ema9) && _notNaN(ema21) && _notNaN(ema50) && ema9 > ema21 && ema21 > ema50 && price > ema50;
    var bear   = _notNaN(ema9) && _notNaN(ema21) && _notNaN(ema50) && ema9 < ema21 && ema21 < ema50 && price < ema50;

    // ADX
    var adxRes = _adx(candlesDaily, 14);
    var adxVal = _last(adxRes.adx.filter(_notNaN)) || 0;

    // Bollinger squeeze (bandwidth vs 6-month min)
    var bbRes    = _bollinger(closes, 20, 2);
    var bwValid  = _validSlice(bbRes.bandwidth, n - 130);
    var bwNow    = bbRes.bandwidth[n - 1] || 0;
    var bwMin    = bwValid.length > 20 ? _min(bwValid) : bwNow;
    var squeeze  = bwMin > 0 && bwNow < bwMin * 1.10;

    if (atrRatio > 1.5 || squeeze)       return 'VOLATILE';
    if (adxVal > 25 && bull)              return 'TRENDING_UP';
    if (adxVal > 25 && bear)              return 'TRENDING_DOWN';
    if (adxVal < 20)                      return 'RANGING';
    return 'TRANSITIONING';
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ── INDICATOR COMPUTATION ───────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────────

  function _computeIndicators(candles, timeframe, regime, assetId) {
    if (!candles || candles.length < 35) return null;

    var closes  = candles.map(function (c) { return c.close; });
    var highs   = candles.map(function (c) { return c.high; });
    var lows    = candles.map(function (c) { return c.low; });
    var volumes = candles.map(function (c) { return c.volume || 1; });
    var n = closes.length;

    // ATR
    var atrArr  = _atr(candles, 14);
    var atrVal  = atrArr[n - 1] || 0;
    var atrSlice = _validSlice(atrArr, n - 22);
    var atrBase = _mean(atrSlice.length > 1 ? atrSlice.slice(0, -1) : atrSlice) || atrVal || 1;

    // Adaptive RSI
    var rsiPeriod = regime === 'VOLATILE' ? _adaptiveRsiPeriod(atrVal, atrBase) : 14;
    var rsiArr    = n >= rsiPeriod + 20 ? _rsi(closes, rsiPeriod) : null;
    var rsiLast   = rsiArr && _notNaN(rsiArr[n - 1]) ? rsiArr[n - 1] : 50;
    var rsiDiv    = rsiArr && n >= 50 ? _rsiDivergence(closes, rsiArr, 50) : null;

    // MACD — shorter params on 1h to compensate for bar duration
    var mp        = timeframe === '1h' ? [6, 13, 4] : [12, 26, 9];
    var macdRes   = n >= mp[1] + mp[2] + 5 ? _macd(closes, mp[0], mp[1], mp[2]) : null;
    var hist      = macdRes ? macdRes.histogram : null;
    // Histogram momentum: 3-bar slope normalised by ATR
    var histMom   = 0;
    if (hist && _notNaN(hist[n - 1]) && _notNaN(hist[n - 4]) && atrVal > 0) {
      histMom = (hist[n - 1] - hist[n - 4]) / atrVal;
    }

    // EMA slopes (5-bar slope normalised by ATR)
    var ema9Arr   = n >= 12  ? _ema(closes, 9)   : null;
    var ema50Arr  = n >= 60  ? _ema(closes, 50)  : null;
    var ema200Arr = n >= 210 ? _ema(closes, 200) : null;
    function emaSlope(arr) {
      if (!arr || !_notNaN(arr[n - 1]) || !_notNaN(arr[n - 6]) || atrVal === 0) return 0;
      return (arr[n - 1] - arr[n - 6]) / atrVal;
    }
    var ema9slope  = emaSlope(ema9Arr);
    var ema50slope = emaSlope(ema50Arr);
    var ema50Last  = ema50Arr && _notNaN(ema50Arr[n - 1]) ? ema50Arr[n - 1] : NaN;

    // Bollinger
    var bbRes     = n >= 25 ? _bollinger(closes, 20, 2) : null;
    var pctB      = bbRes && _notNaN(bbRes.pctB[n - 1]) ? bbRes.pctB[n - 1] : 0.5;
    var bwSlice   = bbRes ? _validSlice(bbRes.bandwidth, n - 130) : [];
    var bwNow     = bbRes ? bbRes.bandwidth[n - 1] : 0;
    var bwMin6m   = bwSlice.length > 20 ? _min(bwSlice) : bwNow;
    var bwMax6m   = bwSlice.length > 20 ? _max(bwSlice) : bwNow;
    var sqzRatio  = (bwMax6m > bwMin6m) ? (bwNow - bwMin6m) / (bwMax6m - bwMin6m) : 0.5;

    // ADX + DI
    var adxRes  = n >= 30 ? _adx(candles, 14) : null;
    var adxVal2 = adxRes && _notNaN(adxRes.adx[n - 1])    ? adxRes.adx[n - 1]    : 0;
    var plusDI  = adxRes && _notNaN(adxRes.plusDI[n - 1])  ? adxRes.plusDI[n - 1]  : 0;
    var minusDI = adxRes && _notNaN(adxRes.minusDI[n - 1]) ? adxRes.minusDI[n - 1] : 0;

    // OBV divergence
    var obvArr     = _obv(closes, volumes);
    var obvEMA     = _last(_ema(obvArr, 20));
    var obvSlope   = n >= 11 && Math.abs(obvArr[n - 11]) > 0
                     ? (obvArr[n - 1] - obvArr[n - 11]) / Math.abs(obvArr[n - 11]) : 0;
    var priceSlope = closes[n - 11] > 0 ? (closes[n - 1] - closes[n - 11]) / closes[n - 11] : 0;
    var obvDiv     = _sign(obvSlope) !== _sign(priceSlope) && Math.abs(priceSlope) > 0.005
                     ? 'divergence' : 'aligned';
    var obvBias    = obvArr[n - 1] > obvEMA ? 'bullish' : 'bearish';

    // Volume spike
    var volSlice   = volumes.slice(Math.max(0, n - 21), n - 1);
    var volAvg     = _mean(volSlice) || 1;
    var volRatio   = volumes[n - 1] / volAvg;

    // Pivots (using previous candle H/L/C)
    var pivots = n >= 2 ? _pivots(highs[n - 2], lows[n - 2], closes[n - 2]) : null;

    // ROC-10
    var roc10 = closes[n - 11] > 0 ? (closes[n - 1] - closes[n - 11]) / closes[n - 11] : 0;

    // VWAP (1h only — current session)
    var vwapBias = null;
    if (timeframe === '1h') {
      var dayStart    = Math.floor(Date.now() / 86400000) * 86400;
      var todayC      = candles.filter(function (c) { return c.timestamp >= dayStart; });
      if (todayC.length >= 3) {
        var vwapVal   = _vwap(todayC);
        vwapBias      = vwapVal ? (closes[n - 1] > vwapVal ? 'ABOVE' : 'BELOW') : null;
      }
    }

    // Stochastic — commodity daily in ranging regime only
    var stochK = null;
    if (timeframe === 'daily' && (assetId === 'WTI' || assetId === 'BRENT' || assetId === 'WEAT') && regime === 'RANGING' && n >= 20) {
      var stochArr = _stochastic(candles, 14);
      stochK       = _notNaN(stochArr[n - 1]) ? stochArr[n - 1] : null;
    }

    return {
      price: closes[n - 1], atrVal: atrVal, atrBase: atrBase,
      rsiLast: rsiLast, rsiPeriod: rsiPeriod, rsiDiv: rsiDiv,
      histMom: histMom, ema9slope: ema9slope, ema50slope: ema50slope,
      ema50Last: ema50Last, pctB: pctB, sqzRatio: sqzRatio,
      adxVal: adxVal2, plusDI: plusDI, minusDI: minusDI,
      obvDiv: obvDiv, obvBias: obvBias, obvSlope: obvSlope, priceSlope: priceSlope,
      volRatio: volRatio, pivots: pivots, roc10: roc10,
      vwapBias: vwapBias, stochK: stochK,
      aboveEMA50: _notNaN(ema50Last) && closes[n - 1] > ema50Last
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ── SCORING ─────────────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────────

  function _scoreAsset(ind, regime) {
    if (!ind) return 0;
    var weights = W[regime] || W.TRANSITIONING;
    var sc = {};

    // EMA slope — positive in uptrend, negative in downtrend
    sc.ema = _clamp(ind.ema9slope * 2.5, -1, 1);

    // MACD histogram momentum — early trend change signal
    sc.macd = _clamp(ind.histMom * 7, -1, 1);

    // RSI — ONLY in ranging regime (avoid trending overbought false signals)
    if (regime === 'RANGING') {
      if      (ind.rsiLast < 35) sc.rsi = (35 - ind.rsiLast) / 35;
      else if (ind.rsiLast > 65) sc.rsi = -(ind.rsiLast - 65) / 35;
      else                       sc.rsi = 0;
    } else { sc.rsi = 0; }

    // RSI divergence — reliable in any regime, weight varies
    if (ind.rsiDiv) {
      var st   = _clamp(ind.rsiDiv.strength * 8, 0, 0.90);
      var type = ind.rsiDiv.type;
      sc.rsiDiv = (type === 'bullish_regular') ?  st
                : (type === 'bullish_hidden')  ?  st * 0.70
                : (type === 'bearish_regular') ? -st
                : (type === 'bearish_hidden')  ? -st * 0.70 : 0;
    } else { sc.rsiDiv = 0; }

    // Bollinger %B — ranging/volatile only for reversal signals
    if (regime === 'RANGING' || regime === 'VOLATILE') {
      if      (ind.pctB < 0.15) sc.bb = (0.15 - ind.pctB) * 3;
      else if (ind.pctB > 0.85) sc.bb = -(ind.pctB - 0.85) * 3;
      else                      sc.bb = 0;
    } else { sc.bb = 0; }

    // OBV — divergence gets high weight, trend alignment gets moderate weight
    if (ind.obvDiv === 'divergence') {
      sc.obv = ind.priceSlope > 0 ? -0.75 : 0.75;  // price up + OBV down = bearish
    } else {
      sc.obv = _clamp(ind.obvSlope * 3, -0.50, 0.50);
    }

    // Volume spike confirms direction of the current move
    if (ind.volRatio > 1.8) {
      var dir  = ind.ema9slope >= 0 ? 1 : -1;
      sc.vol   = dir * _clamp((ind.volRatio - 1.0) / 3, 0, 0.80);
    } else { sc.vol = 0; }

    // Pivot S/R proximity (distance from pivot point, ATR-normalised)
    if (ind.pivots && ind.atrVal > 0) {
      var distPP = (ind.price - ind.pivots.pp) / ind.atrVal;
      sc.pivot   = _clamp(distPP * 0.15, -0.50, 0.50);
    } else { sc.pivot = 0; }

    // ROC-10 normalised momentum
    var rocNorm = ind.atrBase > 0 ? ind.roc10 / (ind.atrBase / ind.price * Math.sqrt(10)) : 0;
    sc.roc      = _clamp(rocNorm * 0.4, -0.80, 0.80);

    // Stochastic (commodity daily ranging only)
    if (ind.stochK !== null && _notNaN(ind.stochK)) {
      if      (ind.stochK < 20) sc.stoch = (20 - ind.stochK) / 20;
      else if (ind.stochK > 80) sc.stoch = -(ind.stochK - 80) / 20;
      else                      sc.stoch = 0;
    }

    // Weighted composite
    var composite = 0;
    Object.keys(sc).forEach(function (k) {
      composite += (sc[k] || 0) * (weights[k] || 0);
    });

    // VWAP bias is a multiplier, not an additive score (1h only)
    var vwapMult = ind.vwapBias === 'ABOVE' ? 1.10 : ind.vwapBias === 'BELOW' ? 0.90 : 1.0;

    return _clamp(composite * vwapMult, -1.0, 1.0);
  }

  // ── Multi-Timeframe Composite ──────────────────────────────────────────────
  function _mtfComposite(s1h, s4h, sDaily, assetType, regime, s15m) {
    // Commodities have daily data only
    if (assetType === 'commodity') {
      var abs = Math.abs(sDaily);
      var grade = abs > 0.45 ? 'A' : abs > 0.30 ? 'B' : abs > 0.18 ? 'C' : 'D';
      var ct = grade === 'A' ? 'STRUCTURE' : grade === 'B' ? 'SETUP' : 'WEAK';
      return { composite: sDaily, grade: grade, allAligned: true, alignBonus: 1.0, regime: regime,
               convictionTier: ct, m15Aligned: false };
    }

    var daily = _notNaN(sDaily) ? sDaily : 0;
    var h4    = _notNaN(s4h)    ? s4h    : daily * 0.8;
    var h1    = _notNaN(s1h)    ? s1h    : h4    * 0.8;
    var m15   = _notNaN(s15m)   ? s15m   : null;

    var allAligned  = _sign(daily) !== 0 && _sign(daily) === _sign(h4) && _sign(h4) === _sign(h1);
    var m15Aligned  = m15 !== null && _sign(m15) !== 0 && _sign(m15) === _sign(daily);
    var alignBonus  = allAligned ? 1.15 : 1.0;

    // 1h or 4h fighting daily: reduce their contribution
    var h4w = (_sign(h4) !== _sign(daily) && daily !== 0) ? 0.12 : 0.30;
    var h1w = (_sign(h1) !== _sign(daily) && daily !== 0) ? 0.06 : 0.20;

    var comp = 0.50 * daily + h4w * h4 + h1w * h1;
    comp = _clamp(comp * alignBonus, -1.0, 1.0);

    // TRANSITIONING regime: cap composite
    if (regime === 'TRANSITIONING') comp = _clamp(comp, -0.50, 0.50);

    var absC  = Math.abs(comp);
    var grade = (absC > 0.45 && allAligned)                 ? 'A'
              : (absC > 0.30 && (allAligned || absC > 0.40)) ? 'B'
              : absC > 0.18                                   ? 'C' : 'D';

    // Three-tier conviction gate: 1D+4H+1H+15M all aligned = HIGH_CONVICTION
    var convictionTier = (allAligned && m15Aligned) ? 'HIGH_CONVICTION'
                       : allAligned                 ? 'STRUCTURE'
                       : absC > 0.18                ? 'SETUP'
                                                    : 'WEAK';

    return { composite: comp, grade: grade, allAligned: allAligned, alignBonus: alignBonus,
             regime: regime, convictionTier: convictionTier, m15Aligned: m15Aligned };
  }

  // ── GII Context Integration ────────────────────────────────────────────────
  function _integrateGII(taComp, assetId, regime) {
    var gtiVal = 30, escalMax = 0, vixVal = 18;
    try { var g = window.GII && window.GII.gti && window.GII.gti(); gtiVal = (g && typeof g.value === 'number') ? g.value : 30; } catch (e) {}
    try {
      var lad = window.GII_AGENT_ESCALATION && window.GII_AGENT_ESCALATION.ladderStatus && window.GII_AGENT_ESCALATION.ladderStatus();
      if (lad) Object.values(lad).forEach(function (r) { if (r.level > escalMax) escalMax = r.level; });
    } catch (e) {}
    try { var ms = window.GII_AGENT_MACRO && window.GII_AGENT_MACRO.status && window.GII_AGENT_MACRO.status(); if (ms && ms.vix) vixVal = ms.vix; } catch (e) {}

    var isRiskOff = (assetId === 'GLD' || assetId === 'TLT');
    var isEnergy  = (assetId === 'WTI' || assetId === 'BRENT' || assetId === 'XLE');
    var isCrypto  = (assetId === 'BTC');

    var gtiMod = gtiVal > 80 ? (isRiskOff ? 1.30 : isCrypto ? 0.65 : 0.85)
               : gtiVal > 60 ? (isRiskOff ? 1.15 : isCrypto ? 0.80 : 1.00) : 1.0;

    var vixMod = (vixVal > 30 && taComp > 0 && !isRiskOff) ? 0.75
               : (vixVal > 30 && isRiskOff && taComp > 0)  ? 1.20 : 1.0;

    var escalMod = 1.0;
    if (escalMax >= 6) {
      if (isEnergy || isRiskOff)              escalMod = 1.20;
      if (assetId === 'SPY' && taComp > 0)   escalMod = 0.80;
    }

    var finalComp = _clamp(taComp * gtiMod * vixMod * escalMod, -1.0, 1.0);
    if (regime === 'TRANSITIONING') finalComp = _clamp(finalComp, -0.50, 0.50);

    return {
      composite:  finalComp,
      confidence: _clamp(Math.abs(finalComp) * 0.82, MIN_CONF, MAX_CONF),
      gtiMod: gtiMod, vixMod: vixMod, escalMod: escalMod
    };
  }

  // ── Inter-Agent Order Flow Integration ────────────────────────────────────
  // Queries GII_AGENT_MARKETSTRUCTURE.books() and GII_AGENT_SMARTMONEY.snapshot().
  // Returns confidence adjustment in [-0.06, +0.06].
  function _integrateOrderFlow(assetId, bias) {
    var adj = 0;
    try {
      var books = window.GII_AGENT_MARKETSTRUCTURE && window.GII_AGENT_MARKETSTRUCTURE.books && window.GII_AGENT_MARKETSTRUCTURE.books();
      if (books && books[assetId]) {
        var imb = books[assetId].imbalance || 0;   // positive = bid pressure
        if ((bias === 'long'  && imb >  0.10) || (bias === 'short' && imb < -0.10)) adj += 0.04;
        if ((bias === 'long'  && imb < -0.10) || (bias === 'short' && imb >  0.10)) adj -= 0.04;
      }
    } catch (e) {}
    try {
      var snap = window.GII_AGENT_SMARTMONEY && window.GII_AGENT_SMARTMONEY.snapshot && window.GII_AGENT_SMARTMONEY.snapshot();
      if (snap && snap[assetId]) {
        var longRatio = snap[assetId].long || 0.5;
        if ((bias === 'long'  && longRatio > 0.60) || (bias === 'short' && longRatio < 0.40)) adj += 0.02;
        if ((bias === 'long'  && longRatio < 0.40) || (bias === 'short' && longRatio > 0.60)) adj -= 0.02;
      }
    } catch (e) {}
    return _clamp(adj, -0.06, 0.06);
  }

  // ── Dynamic Confidence from Trade Feedback ───────────────────────────────
  // Returns multiplier [0.70, 1.30] based on historical win rate per asset/bias.
  // Only activates after ≥10 trades — returns 1.0 before that.
  function _feedbackConfMult(assetId, bias) {
    var fb = _feedback[assetId + '_' + bias];
    if (!fb || fb.total < 10) return 1.0;
    // 0% WR → 0.70, 50% WR → 1.0, 100% WR → 1.30
    return _clamp(0.70 + (fb.winRate || 0.5) * 0.60, 0.70, 1.30);
  }

  // ── A2A Event Broadcasting ──────────────────────────────────────────────────
  // Dispatches standardised signal to window event bus for inter-agent consumption.
  // Deduplicates: only fires when bias or conviction changes, or every 4h as a refresh.
  function _broadcast(signal) {
    try {
      var prev = _lastBroadcast[signal.ticker];
      var now  = Date.now();
      var REFRESH_MS = 4 * 3600000;   // 4h max silence before forced re-broadcast
      if (prev && prev.bias === signal.bias && prev.conviction === signal.conviction
          && (now - prev.ts) < REFRESH_MS) return;
      _lastBroadcast[signal.ticker] = { bias: signal.bias, conviction: signal.conviction, ts: now };
      window.dispatchEvent(new CustomEvent('GII_TA_SIGNAL', { detail: signal, bubbles: false }));
    } catch (e) {}
  }

  // ── Signal Builder ─────────────────────────────────────────────────────────
  function _buildSignal(assetDef, mtf, gii, indDaily, smc, smc15m) {
    if (Math.abs(gii.composite) < 0.15) return null;
    if (mtf.grade === 'D')              return null;

    var gradeMult = { A: 1.0, B: 0.85, C: 0.65 };
    var conf      = gii.confidence * (gradeMult[mtf.grade] || 0.65);
    if (conf < MIN_CONF) return null;

    var bias  = gii.composite > 0 ? 'long' : 'short';
    var atr   = indDaily ? indDaily.atrVal : 0;
    var price = indDaily ? indDaily.price  : 0;

    // ATR-based stop (1.5× ATR) and target (pivot or 2.5× ATR fallback)
    var atrStop   = atr > 0 ? atr * 1.5 : price * 0.015;
    var atrTarget = atr > 0 ? atr * 2.5 : price * 0.025;
    var rr        = 2.5;

    if (indDaily && indDaily.pivots && atrStop > 0) {
      var cand  = bias === 'long' ? indDaily.pivots.r1 : indDaily.pivots.s1;
      var cand2 = bias === 'long' ? indDaily.pivots.r2 : indDaily.pivots.s2;
      if (cand && price > 0) {
        var dist  = Math.abs(cand  - price);
        var dist2 = cand2 ? Math.abs(cand2 - price) : 0;
        if (dist  / atrStop >= 1.5) { atrTarget = dist;  rr = dist  / atrStop; }
        else if (dist2 / atrStop >= 1.5) { atrTarget = dist2; rr = dist2 / atrStop; }
      }
    }

    if (rr < 1.5) return null;   // minimum R:R gate

    // ── SMC confluence ──────────────────────────────────────────────────────
    var smcSignals = 0;
    var smcContext = {};
    if (smc) {
      if (smc.fvg && smc.fvg.latest) {
        var fvgOk = (bias === 'long'  && smc.fvg.latest.type === 'bullish') ||
                    (bias === 'short' && smc.fvg.latest.type === 'bearish');
        if (fvgOk) { smcSignals++; smcContext.fvg = smc.fvg.latest.type; }
      }
      if (smc.ob && smc.ob.nearPrice && smc.ob.nearPrice.length > 0) {
        var obOk = smc.ob.nearPrice.some(function (b) {
          return (bias === 'long' && b.type === 'bullish') || (bias === 'short' && b.type === 'bearish');
        });
        if (obOk) { smcSignals++; smcContext.orderBlock = true; }
      }
      if (smc.choch && smc.choch.choch && smc.choch.choch.confirmed) {
        var chochOk = (bias === 'long'  && smc.choch.choch.type === 'bullish') ||
                      (bias === 'short' && smc.choch.choch.type === 'bearish');
        if (chochOk) { smcSignals++; smcContext.choch = smc.choch.choch.type; }
      }
      if (smc.liquidity && smc.liquidity.sweeps && smc.liquidity.sweeps.length > 0) {
        var sweepOk = smc.liquidity.sweeps.some(function (s) {
          return (bias === 'long' && s.type === 'low_sweep') || (bias === 'short' && s.type === 'high_sweep');
        });
        if (sweepOk) { smcSignals++; smcContext.liquiditySweep = true; }
      }
    }
    // 15m SMC — entry-level confirmation (each counts as +0.5 signal weight)
    if (smc15m) {
      if (smc15m.fvg && smc15m.fvg.latest) {
        var fvg15Ok = (bias === 'long'  && smc15m.fvg.latest.type === 'bullish') ||
                      (bias === 'short' && smc15m.fvg.latest.type === 'bearish');
        if (fvg15Ok) { smcSignals += 0.5; smcContext.fvg15m = smc15m.fvg.latest.type; }
      }
      if (smc15m.ob && smc15m.ob.nearPrice && smc15m.ob.nearPrice.length > 0) {
        var ob15Ok = smc15m.ob.nearPrice.some(function (b) {
          return (bias === 'long' && b.type === 'bullish') || (bias === 'short' && b.type === 'bearish');
        });
        if (ob15Ok) { smcSignals += 0.5; smcContext.ob15m = true; }
      }
      if (smc15m.liquidity && smc15m.liquidity.sweeps && smc15m.liquidity.sweeps.length > 0) {
        var sw15Ok = smc15m.liquidity.sweeps.some(function (s) {
          return (bias === 'long' && s.type === 'low_sweep') || (bias === 'short' && s.type === 'high_sweep');
        });
        if (sw15Ok) { smcSignals += 0.5; smcContext.sweep15m = true; }
      }
    }
    // Bonus: +0.05 per confirmed SMC signal when ≥2 align, capped at +0.10
    if (smcSignals >= 2) conf = _clamp(conf + Math.min(smcSignals * 0.05, 0.10), MIN_CONF, MAX_CONF);

    var id  = assetDef.id;
    var ind = indDaily;
    var parts = [
      'regime=' + mtf.regime,
      'score='  + gii.composite.toFixed(2),
      'grade='  + mtf.grade,
      'conviction=' + mtf.convictionTier,
      mtf.allAligned ? 'MTF✓' : 'MTF~',
      'GTI×' + gii.gtiMod.toFixed(2)
    ];
    if (ind && ind.rsiDiv)                parts.push('RSIdiv:' + ind.rsiDiv.type);
    if (ind && ind.obvDiv === 'divergence') parts.push('OBVdiv');
    if (ind && ind.volRatio > 1.8)        parts.push('vol×' + ind.volRatio.toFixed(1));
    if (ind && ind.sqzRatio < 0.10)       parts.push('BBsqueeze');
    if (smcSignals >= 2)                  parts.push('SMC×' + smcSignals.toFixed(1));

    var confFinal  = _clamp(conf, MIN_CONF, MAX_CONF);
    var stopLoss   = price > 0 ? (bias === 'long' ? price - atrStop   : price + atrStop)   : undefined;
    var takeProfit = price > 0 ? (bias === 'long' ? price + atrTarget : price - atrTarget) : undefined;
    var reason     = '[TA] ' + parts.join(' | ');

    var signal = {
      // ── A2A standardised payload ──────────────────────────────────────────
      ticker:              id,
      source:              'GII_AGENT_TECHNICALS',
      bias:                bias,
      confidence_score:    confFinal,
      conviction:          mtf.convictionTier,
      timeframe_alignment: mtf.allAligned,
      stop_loss:           stopLoss   !== undefined ? +stopLoss.toFixed(4)   : undefined,
      take_profit:         takeProfit !== undefined ? +takeProfit.toFixed(4) : undefined,
      reason:              reason,
      smc_context:         Object.keys(smcContext).length > 0 ? smcContext : undefined,
      // ── Legacy fields (backwards compat for gii-core + executionEngine) ──
      asset:               id,
      confidence:          confFinal,
      reasoning:           reason,
      region:              assetDef.region,
      evidenceKeys:        ['technical', mtf.regime.toLowerCase(), bias, 'grade-' + mtf.grade,
                            mtf.convictionTier.toLowerCase()],
      atrStop:             isFinite(atrStop)   ? +atrStop.toFixed(4)   : undefined,
      atrTarget:           isFinite(atrTarget) ? +atrTarget.toFixed(4) : undefined,
      taGrade:             mtf.grade,
      taRegime:            mtf.regime,
      _agentName:          'technicals'
    };

    _broadcast(signal);
    return signal;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ── DATA FETCHING ────────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────────

  // Cache TTLs
  var TTL = { '15m': 14 * 60000, '1h': 55 * 60000, '4h': 230 * 60000, daily: 23 * 3600000 };

  function _isFresh(key, tf) {
    var e = _cache[key];
    return e && e.fetchedAt && e.candles && e.candles.length >= 30
           && (Date.now() - e.fetchedAt) < TTL[tf];
  }

  function _staleMult(key) {
    var e = _cache[key]; if (!e || !e.fetchedAt) return 0.30;
    var age = Date.now() - e.fetchedAt;
    if (age < 7200000)  return 1.00;
    if (age < 21600000) return 0.90;
    if (age < 43200000) return 0.75;
    if (age < 86400000) return 0.55;
    return 0.30;
  }

  // ── Hyperliquid candleSnapshot (primary, no key, no quota) ─────────────────
  // interval: 'daily' | '4h' | '1h'   →   maps to HL's '1d' | '4h' | '1h'
  function _hl(coin, interval, numCandles) {
    var hlInterval = interval === 'daily' ? '1d' : interval;   // '4h' and '1h' pass through
    var msPerBar   = interval === 'daily' ? 86400000 : interval === '4h' ? 14400000 : interval === '15m' ? 900000 : 3600000;
    var now        = Date.now();
    var startTime  = now - numCandles * msPerBar * 2;   // 2× buffer for gaps
    return fetch(HL_INFO, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'candleSnapshot',
        req:  { coin: coin, interval: hlInterval, startTime: startTime, endTime: now }
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!Array.isArray(data) || data.length === 0) return null;
        var candles = data.map(function (d) {
          return {
            timestamp: Math.floor(d.t / 1000),   // ms → seconds
            open:      parseFloat(d.o),
            high:      parseFloat(d.h),
            low:       parseFloat(d.l),
            close:     parseFloat(d.c),
            volume:    parseFloat(d.v) || 0
          };
        }).filter(function (c) { return _notNaN(c.close) && c.close > 0; });
        if (candles.length >= 10) {
          _hlFetchErrors = 0;   // reset error counter on success
          return candles.slice(-numCandles);
        }
        return null;
      })
      .catch(function (e) {
        _hlFetchErrors++;
        console.warn('[GII-TA] HL fetch failed (' + coin + ' ' + interval + '): ' + e.message);
        return null;
      });
  }

  // Twelve Data
  function _td(symbol, interval, size) {
    var k = window.GII_TA_KEYS && window.GII_TA_KEYS.twelvedata;
    if (!k) return Promise.resolve(null);
    if (_quotaExceeded('twelvedata')) return Promise.resolve(null);
    _quotaIncrement('twelvedata');
    return fetch('https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(symbol) +
                 '&interval=' + interval + '&outputsize=' + (size || 200) + '&apikey=' + k)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.values) return null;
        return d.values.map(function (v) {
          return { timestamp: Math.floor(new Date(v.datetime).getTime() / 1000),
            open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +(v.volume || 0) };
        }).filter(function (c) { return _notNaN(c.close) && c.close > 0; }).reverse();
      }).catch(function () { return null; });
  }

  // Alpha Vantage commodities (close-only — high/low are synthesised)
  function _av(func) {
    var k = window.GII_TA_KEYS && window.GII_TA_KEYS.alphavantage;
    if (!k) return Promise.resolve(null);
    if (_quotaExceeded('alphavantage')) return Promise.resolve(null);
    _quotaIncrement('alphavantage');
    return fetch('https://www.alphavantage.co/query?function=' + func + '&interval=daily&apikey=' + k)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.data) return null;
        return d.data.map(function (v) {
          var val = +v.value;
          // Synthesise high/low from adjacent closes for ATR computation
          return { timestamp: Math.floor(new Date(v.date).getTime() / 1000),
            open: val, high: val, low: val, close: val, volume: 1000000 };
        }).filter(function (c) { return _notNaN(c.close) && c.close > 0; }).reverse();
      }).catch(function () { return null; });
  }

  // CryptoCompare
  function _cc(period) {
    var k    = window.GII_TA_KEYS && window.GII_TA_KEYS.cryptocompare;
    var base = period === '1h' ? 'https://min-api.cryptocompare.com/data/v2/histohour'
                               : 'https://min-api.cryptocompare.com/data/v2/histoday';
    var url  = base + '?fsym=BTC&tsym=USD&limit=200' + (k ? '&api_key=' + k : '');
    return fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.Data || !d.Data.Data) return null;
        return d.Data.Data.map(function (v) {
          return { timestamp: v.time, open: v.open, high: v.high, low: v.low, close: v.close, volume: v.volumefrom };
        }).filter(function (c) { return c.close > 0 && c.timestamp > 0; });
      }).catch(function () { return null; });
  }

  // Enqueue a single fetch (rate-limited via serial promise chain)
  function _enqueue(fn) {
    _fetchSeq = _fetchSeq.then(function () {
      return new Promise(function (resolve) {
        setTimeout(function () { fn().then(resolve).catch(function () { resolve(null); }); }, FETCH_GAP_MS);
      });
    });
    return _fetchSeq;
  }

  // Fetch candles for one asset/timeframe.
  // Priority: Hyperliquid (if hlCoin set) → original API → stale cache
  function _fetchCandles(assetDef, tf) {
    var key = assetDef.id + '_' + tf;
    if (_isFresh(key, tf)) return Promise.resolve(_cache[key].candles);

    // ── Step 1: Try Hyperliquid if asset is covered ─────────────────────────
    if (assetDef.hlCoin) {
      // HL always returns proper OHLCV — much better than AV's close-only for commodities
      var hlCoin = assetDef.hlCoin;
      var hlBars = (tf === 'daily') ? 250 : (tf === '4h') ? 200 : 200;
      return _hl(hlCoin, tf, hlBars).then(function (candles) {
        if (candles && candles.length >= 30) {
          _cache[key] = { candles: candles, fetchedAt: Date.now(), source: 'hyperliquid' };
          _saveCache();
          return candles;
        }
        // HL failed or returned too few bars — fall through to legacy API
        return _fetchLegacy(assetDef, tf, key);
      });
    }

    // ── Step 2: No HL coverage — use legacy API directly ────────────────────
    return _fetchLegacy(assetDef, tf, key);
  }

  // Legacy fetch (Twelve Data / Alpha Vantage / CryptoCompare) + stale cache fallback
  function _fetchLegacy(assetDef, tf, key) {
    var prom;
    if (assetDef.api === 'twelvedata') {
      // TD interval names: '15min' | '1h' | '1day'
      var tdInt = tf === '15m' ? '15min' : tf === '1h' ? '1h' : '1day';
      prom = _enqueue(function () { return _td(assetDef.sym, tdInt, 200); });
    } else if (assetDef.api === 'alphavantage') {
      if (tf !== 'daily') return Promise.resolve(null);   // AV is daily-only
      var avFunc = AV_FUNCS[assetDef.sym] || assetDef.sym;
      prom = _enqueue(function () { return _av(avFunc); });
    } else if (assetDef.api === 'cryptocompare') {
      if (tf === '15m') return Promise.resolve(null);     // no CC 15m fallback
      prom = _enqueue(function () { return _cc(tf); });
    } else {
      return Promise.resolve(null);
    }
    return prom.then(function (candles) {
      if (candles && candles.length >= 30) {
        _cache[key] = { candles: candles, fetchedAt: Date.now(), source: assetDef.api };
        _saveCache();
        return candles;
      }
      return (_cache[key] || {}).candles || null;   // stale cache as last resort
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ── MAIN ANALYSIS ────────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────────

  function _analyseAsset(assetDef) {
    var id   = assetDef.id;
    var type = assetDef.type;

    var dailyC = (_cache[id + '_daily'] || {}).candles;
    if (!dailyC || dailyC.length < 35) return null;

    var sm     = _staleMult(id + '_daily');
    var regime = _regimeDetect(dailyC);

    var indD   = _computeIndicators(dailyC, 'daily', regime, id);
    var ind1h  = null, ind4h = null, ind15m = null;

    // 4h candles: prefer native HL bars (better quality than built-from-1h)
    var h4C = assetDef.hl4h ? (_cache[id + '_4h'] || {}).candles : null;
    if (h4C && h4C.length >= 12) {
      ind4h = _computeIndicators(h4C, '4h', regime, id);
    }

    // 15m candles: all non-commodities (BTC via HL, equities via TD 15min)
    var m15C = type !== 'commodity' ? (_cache[id + '_15m'] || {}).candles : null;
    if (m15C && m15C.length >= 20) {
      ind15m = _computeIndicators(m15C, '1h', regime, id);
    }

    // 1h candles: for non-commodities that don't have native HL 4h
    var h1C = type !== 'commodity' ? (_cache[id + '_1h'] || {}).candles : null;
    if (h1C && h1C.length >= 35) {
      ind1h = _computeIndicators(h1C, '1h', regime, id);
      // Build 4h from 1h only when no native 4h available
      if (!ind4h) {
        var c4h = _build4h(h1C);
        if (c4h && c4h.length >= 12) ind4h = _computeIndicators(c4h, '4h', regime, id);
      }
    }

    var sD   = indD   ? _scoreAsset(indD,   regime) : 0;
    var s4h  = ind4h  ? _scoreAsset(ind4h,  regime) : NaN;
    var s1h  = ind1h  ? _scoreAsset(ind1h,  regime) : NaN;
    var s15m = ind15m ? _scoreAsset(ind15m, regime) : NaN;

    var mtf = _mtfComposite(s1h, s4h, sD, type, regime, s15m);
    var gii = _integrateGII(mtf.composite, id, regime);

    // Apply staleness discount
    gii.confidence *= sm;
    gii.composite  *= sm;

    // SMC — dual pass: 4h/daily for structure, 15m for entry precision
    var smcCandles = h4C || dailyC;
    var smc = {
      fvg:       _detectFVG(smcCandles),
      ob:        _detectOrderBlocks(smcCandles),
      choch:     _detectCHoCH(smcCandles),
      liquidity: _detectLiquidityZones(smcCandles)
    };
    // 15m SMC: entry-level FVG + OB + liquidity sweep (no CHoCH — too noisy on 15m)
    var smc15m = (m15C && m15C.length >= 20) ? {
      fvg:       _detectFVG(m15C),
      ob:        _detectOrderBlocks(m15C),
      liquidity: _detectLiquidityZones(m15C)
    } : null;

    // Dynamic confidence from feedback win rate
    var bias = gii.composite > 0 ? 'long' : 'short';
    gii.confidence = _clamp(gii.confidence * _feedbackConfMult(id, bias), MIN_CONF, MAX_CONF);

    // Order flow confirmation/opposition boost
    var ofAdj = _integrateOrderFlow(id, bias);
    gii.confidence = _clamp(gii.confidence + ofAdj, MIN_CONF, MAX_CONF);

    var dailySrc = (_cache[id + '_daily'] || {}).source || 'none';
    _status.dataStatus[id] = {
      daily: !!dailyC, h1: !!h1C, h4native: !!h4C, m15: !!m15C,
      source: dailySrc, regime: regime, staleMult: sm
    };

    return _buildSignal(assetDef, mtf, gii, indD, smc, smc15m);
  }

  // ── System health state ─────────────────────────────────────────────────────
  // HEALTHY: most assets have fresh data, HL working
  // DEGRADED: some data stale or HL having issues
  // FAILING: most data stale or no signals possible
  function _computeHealth() {
    var total     = ASSETS.length;
    var freshCount = 0;
    var staleCut  = Date.now() - 86400000;  // 24h
    ASSETS.forEach(function (a) {
      var e = _cache[a.id + '_daily'];
      if (e && e.fetchedAt && e.fetchedAt > staleCut && e.candles && e.candles.length >= 30) freshCount++;
    });
    var ratio = freshCount / total;
    if (ratio >= 0.75 && _hlFetchErrors < 3)  return 'HEALTHY';
    if (ratio >= 0.40 || freshCount >= 3)      return 'DEGRADED';
    return 'FAILING';
  }

  // ── Adaptive poll interval ─────────────────────────────────────────────────
  // Poll faster during volatile markets, slower during quiet periods.
  function _nextPollMs() {
    var hasVolatile = Object.values(_status.dataStatus || {}).some(function (s) {
      return s.regime === 'VOLATILE';
    });
    // If HL is having trouble, back off slightly to reduce pressure
    if (_hlFetchErrors >= 3)    return POLL_BASE_MS * 1.5;
    if (hasVolatile)             return POLL_MIN_MS;     // 10 min — market moving fast
    // Check if all daily caches are still fresh (no rush to refetch)
    var allFresh = ASSETS.every(function (a) { return _isFresh(a.id + '_daily', 'daily'); });
    if (allFresh)                return POLL_MAX_MS;     // 60 min — no stale data
    return POLL_BASE_MS;                                  // 30 min — default
  }

  // ── Poll ───────────────────────────────────────────────────────────────────
  function poll() {
    _status.lastPoll = Date.now();

    // Build fetch promises for all assets
    // HL assets (hlCoin set) get daily + 4h + 1h from HL with no quota cost.
    // Legacy-only assets get daily + 1h (4h built from 1h as before).
    // Commodities without hlCoin: only refetch daily when >22h stale (AV quota).
    var fetches = [];
    ASSETS.forEach(function (a) {
      if (a.hlCoin) {
        // HL covers this asset — fetch all four timeframes freely
        fetches.push(_fetchCandles(a, 'daily'));
        fetches.push(_fetchCandles(a, '4h'));
        fetches.push(_fetchCandles(a, '1h'));
        fetches.push(_fetchCandles(a, '15m'));
      } else if (a.type === 'commodity') {
        // AV credits are precious — only refetch when stale
        if (!_isFresh(a.id + '_daily', 'daily')) {
          fetches.push(_fetchCandles(a, 'daily'));
        }
      } else {
        // Standard equity/crypto with no HL — daily + 1h + 15m (4h built from 1h)
        fetches.push(_fetchCandles(a, 'daily'));
        fetches.push(_fetchCandles(a, '1h'));
        fetches.push(_fetchCandles(a, '15m'));
      }
    });

    // After all fetches complete, run analysis then reschedule adaptively
    Promise.all(fetches).then(function () {
      var newSigs = [];
      _status.assetsAnalysed = 0;
      _status.activeSignals  = [];

      ASSETS.forEach(function (a) {
        var sig = _analyseAsset(a);
        if (sig) {
          newSigs.unshift(sig);
          _status.assetsAnalysed++;
          _status.activeSignals.push({ asset: a.id, bias: sig.bias, confidence: sig.confidence, grade: sig.taGrade, regime: sig.taRegime });
        }
      });

      // Only replace signals array when new results are ready
      if (newSigs.length > 0) {
        _signals = newSigs.slice(0, MAX_SIGNALS);
      }

      // Update health state
      _status.health    = _computeHealth();
      _status.hlErrors  = _hlFetchErrors;
      _status.apiQuota  = Object.assign({}, _quota);

      // Adaptive reschedule — cancel previous timer if any
      if (_pollTimer) clearTimeout(_pollTimer);
      var nextMs = _nextPollMs();
      _status.nextPollMs = nextMs;
      _pollTimer = setTimeout(poll, nextMs);
    });
  }

  // ── trade result feedback ───────────────────────────────────────────────────

  function onTradeResult(trade) {
    var asset = (trade.asset || '').toUpperCase();
    var dir   = (trade.dir  || '').toLowerCase();
    if (!asset || !dir) return;
    var fbKey = asset + '_' + dir;
    if (!_feedback[fbKey]) _feedback[fbKey] = { total: 0, correct: 0, winRate: null, lastTs: null };
    _feedback[fbKey].total  += 1;
    if ((trade.pnl_usd || 0) > 0) _feedback[fbKey].correct += 1;
    _feedback[fbKey].winRate = _feedback[fbKey].correct / _feedback[fbKey].total;
    _feedback[fbKey].lastTs  = new Date().toISOString();
    _accuracy = Object.assign({}, _feedback);
    try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(_feedback)); } catch (e) {}
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.GII_AGENT_TECHNICALS = {
    poll:          poll,
    signals:       function () { return _signals.slice(); },
    status:        function () { return Object.assign({}, _status); },
    accuracy:      function () { return Object.assign({}, _accuracy); },
    onTradeResult: onTradeResult,

    // Health state: 'HEALTHY' | 'DEGRADED' | 'FAILING'
    health:    function () { return _computeHealth(); },

    // Diagnostic helpers
    regime:    function (assetId) {
      var c = (_cache[assetId + '_daily'] || {}).candles;
      return c ? _regimeDetect(c) : 'NO_DATA';
    },
    cacheInfo: function () {
      var info = {};
      Object.keys(_cache).forEach(function (k) {
        var e = _cache[k];
        info[k] = {
          count:   e.candles.length,
          ageMin:  Math.round((Date.now() - e.fetchedAt) / 60000),
          source:  e.source
        };
      });
      return info;
    },
    apiQuota:  function () { _quotaToday(); return Object.assign({}, _quota, { limits: QUOTA_LIMITS }); },
    hlStatus:  function () {
      return {
        errors:        _hlFetchErrors,
        healthy:       _hlFetchErrors < 3,
        hlAssets:      ASSETS.filter(function (a) { return !!a.hlCoin; }).map(function (a) { return a.id; }),
        legacyAssets:  ASSETS.filter(function (a) { return !a.hlCoin; }).map(function (a) { return a.id; })
      };
    },

    // A2A event bus subscription — handler called with each signal as it's emitted.
    // Usage: GII_AGENT_TECHNICALS.on(function(sig) { console.log(sig); })
    on: function (handler) {
      if (typeof handler !== 'function') return;
      window.addEventListener('GII_TA_SIGNAL', function (e) { handler(e.detail); });
    }
  };

  // ── Init ───────────────────────────────────────────────────────────────────
  // 11.5s delay — after all other agents (scenario loads at 10.2s)
  // poll() is self-rescheduling via adaptive setTimeout — no setInterval needed.
  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      // Note: poll() reschedules itself adaptively. No setInterval.
    }, 11500);
  });

  /*
   * ── WIRING NOTES (changes needed in other files) ──────────────────────────
   *
   * v3 changes: SMC detection, 15M timeframe, A2A event bus, order flow + feedback.
   * No new wiring required vs v2 — all changes are internal to this file.
   * Listen to signals: GII_AGENT_TECHNICALS.on(fn) or window 'GII_TA_SIGNAL' events.
   *
   * 1. gii-core.js AGENTS array — add after scenario:
   *      { name: 'technicals', global: 'GII_AGENT_TECHNICALS' }
   *
   * 2. gii-core.js SOURCE_CREDIBILITY map — add:
   *      'technicals': 0.80
   *
   * 3. executionEngine.js buildTrade() — replace fixed stop-loss line with:
   *      var slDist = (sig.atrStop && isFinite(sig.atrStop))
   *        ? sig.atrStop
   *        : entryPrice * (_cfg.stop_loss_pct / 100);
   *      var tpDist = (sig.atrTarget && isFinite(sig.atrTarget))
   *        ? sig.atrTarget
   *        : slDist * _cfg.take_profit_ratio;
   *
   * 4. gii-meta.js known[] array — add: 'GII_AGENT_TECHNICALS'
   *
   * 5. geopolitical-dashboard.html — update version tag:
   *      <script src="agents/gii-technicals.js?v=3"></script>
   *
   * Diagnostics (browser console):
   *   GII_AGENT_TECHNICALS.health()    → 'HEALTHY' | 'DEGRADED' | 'FAILING'
   *   GII_AGENT_TECHNICALS.hlStatus()  → HL error count + covered asset list
   *   GII_AGENT_TECHNICALS.cacheInfo() → per-asset cache age + data source
   *   GII_AGENT_TECHNICALS.apiQuota()  → TD + AV quota usage vs daily limits
   */

})();
