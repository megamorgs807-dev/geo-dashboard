/* GII Scraper Manager — gii-scraper-manager.js v3
 *
 * Watches all HL-covered non-BTC assets for volatility spikes and dynamically
 * spawns a technical scraper instance for whichever asset is moving.
 * Each instance runs the same RSI/EMA/Bollinger/MACD logic as gii-scalper.js
 * but parameterised for its asset and fed by HL candleSnapshot (works for any
 * HL-listed instrument: Gold as GOLD, Oil as CL, ETH, SOL, equities, etc.).
 *
 * Lifecycle:
 *   Volatility spike detected → spawn scraper instance
 *   Instance polls candles every 5 min, emits signals via GII_AGENT_ENTRY
 *   Poor win rate or no signal after 2h → retire instance
 *
 * Exposes: window.GII_SCRAPER_MANAGER
 */
(function () {
  'use strict';

  // ── constants ──────────────────────────────────────────────────────────────

  var POLL_INTERVAL_MS     = 2  * 60 * 1000;  // volatility scan frequency
  var INSTANCE_POLL_MS     = 5  * 60 * 1000;  // each instance fetches candles every 5 min
  var INIT_DELAY_MS        = 28 * 1000;        // after gii-scalper-session (20s) + buffer
  var MAX_ACTIVE           = 5;                // max concurrent dynamic scrapers
  var GTI_GATE             = 70;               // stricter than scalpers' 65 — more speculative
  var SCALP_TIMEOUT_MS     = 2  * 60 * 60 * 1000; // auto-expire active slot
  var NO_SIGNAL_RETIRE_MS  = 2  * 60 * 60 * 1000; // retire if spawned but never fired
  var STAGGER_MS           = 30 * 1000;            // 30s between instance candle polls
  var MIN_CONF             = 0.58;                 // same floor as session scalper
  var RETIRE_WR_HARD       = 0.30;  // retire immediately if WR < 30% after ≥5 trades
  var RETIRE_WR_SOFT       = 0.40;  // retire after ≥10 trades if WR < 40%
  var MIN_TRADES_SCORE     = 3;     // need this many trades before scoring
  var EQUITY_SESSION_START = 7;     // 07:00 UTC (London open)
  var EQUITY_SESSION_END   = 21;    // 21:00 UTC (NY close)
  var RESPAWN_COOLDOWN_MS  = 30 * 60 * 1000; // 30 min per-asset cooldown after retirement
  var HL_INFO              = 'https://api.hyperliquid.xyz/info';
  var FEEDBACK_KEY         = 'gii_scraper_mgr_feedback_v1';

  // ── watchlist ─────────────────────────────────────────────────────────────
  // All HL-covered assets except BTC (already has dedicated scalpers).
  // spikePct = % price move in 15 min that triggers a spawn.

  var WATCHLIST = [
    { hlTicker: 'GOLD',   eeAsset: 'XAU',    sector: 'precious', spikePct: 0.4 },
    { hlTicker: 'CL',     eeAsset: 'WTI',    sector: 'energy',   spikePct: 0.5 },
    { hlTicker: 'SILVER', eeAsset: 'SILVER', sector: 'precious', spikePct: 0.5 },
    { hlTicker: 'ETH',    eeAsset: 'ETH',    sector: 'crypto',   spikePct: 1.0 },
    { hlTicker: 'SOL',    eeAsset: 'SOL',    sector: 'crypto',   spikePct: 1.2 },
    { hlTicker: 'XRP',    eeAsset: 'XRP',    sector: 'crypto',   spikePct: 1.2 },
    { hlTicker: 'NVDA',   eeAsset: 'NVDA',   sector: 'equity',   spikePct: 0.6 },
    { hlTicker: 'TSLA',   eeAsset: 'TSLA',   sector: 'equity',   spikePct: 0.8 },
    { hlTicker: 'SPY',    eeAsset: 'SPY',    sector: 'equity',   spikePct: 0.3 }
  ];

  // RSI thresholds per sector (slightly looser than BTC scalper's 35/65)
  var SECTOR_THRESH = {
    precious: { rsiLong: 35, rsiShort: 65, rsiStrongL: 25, rsiStrongS: 75 },
    energy:   { rsiLong: 38, rsiShort: 62, rsiStrongL: 28, rsiStrongS: 72 },
    crypto:   { rsiLong: 35, rsiShort: 65, rsiStrongL: 25, rsiStrongS: 75 },
    equity:   { rsiLong: 40, rsiShort: 60, rsiStrongL: 30, rsiStrongS: 70 }
  };

  // ── state ─────────────────────────────────────────────────────────────────

  var _instances       = {};   // { 'XAU': scraperInstance, ... } — active only
  var _retired         = [];   // last 20 retired instances (summaries)
  var _priceHist       = {};   // { 'XAU': [{ price, ts }, ...] } — 12 samples = 24 min window
  var _voltScores      = {};   // { 'XAU': 0.61, 'WTI': 0.08, ... }
  var _feedback        = {};   // { 'XAU_long': { total, correct, winRate, lastTs } }
  var _recentlyRetired = {};   // { 'XAU': retiredAtTs } — 30 min re-spawn cooldown
  var _lastPollTs      = 0;
  var _scanTimer       = null;
  var _stats           = { spawned: 0, retired: 0, signals: 0, cycles: 0 };

  // ── helpers ───────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function _round2(v) { return Math.round(v * 100) / 100; }

  function _loadFeedback() {
    try {
      var r = localStorage.getItem(FEEDBACK_KEY);
      _feedback = r ? JSON.parse(r) : {};
    } catch (e) { _feedback = {}; }
  }

  function _saveFeedback() {
    try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(_feedback)); } catch (e) {}
  }

  // ── math: indicators (copied verbatim from gii-scalper.js) ────────────────

  function _rsi(closes, period) {
    if (!closes || closes.length < period + 1) return null;
    var gains = 0, losses = 0, chg, i;
    for (i = 1; i <= period; i++) {
      chg = closes[i] - closes[i - 1];
      if (chg > 0) gains += chg; else losses -= chg;
    }
    gains /= period; losses /= period;
    for (i = period + 1; i < closes.length; i++) {
      chg = closes[i] - closes[i - 1];
      gains  = (gains  * (period - 1) + (chg > 0 ? chg : 0)) / period;
      losses = (losses * (period - 1) + (chg < 0 ? -chg : 0)) / period;
    }
    if (losses === 0) return 100;
    return _clamp(100 - (100 / (1 + gains / losses)), 0, 100);
  }

  function _ema(vals, period) {
    if (!vals || vals.length < period) return null;
    var k = 2 / (period + 1);
    var ema = 0;
    for (var i = 0; i < period; i++) ema += vals[i];
    ema /= period;
    for (i = period; i < vals.length; i++) ema = vals[i] * k + ema * (1 - k);
    return ema;
  }

  function _bollinger(closes, period, numSd) {
    if (!closes || closes.length < period) return null;
    var slice = closes.slice(-period);
    var mean = 0;
    for (var i = 0; i < slice.length; i++) mean += slice[i];
    mean /= period;
    var variance = 0;
    for (i = 0; i < slice.length; i++) variance += Math.pow(slice[i] - mean, 2);
    var sd = Math.sqrt(variance / period);
    return {
      upper:  mean + numSd * sd,
      middle: mean,
      lower:  mean - numSd * sd,
      bw:     mean > 0 ? ((mean + numSd * sd) - (mean - numSd * sd)) / mean : 0
    };
  }

  function _macdHist(closes, fast, slow, sigPeriod) {
    if (!closes || closes.length < slow + sigPeriod) return null;
    var k_f = 2 / (fast + 1), k_s = 2 / (slow + 1), k_sig = 2 / (sigPeriod + 1);
    var ef = closes[0], es = closes[0];
    var esig = NaN;
    var prevHist = 0, hist = 0;
    for (var i = 0; i < closes.length; i++) {
      ef = closes[i] * k_f + ef * (1 - k_f);
      es = closes[i] * k_s + es * (1 - k_s);
      var line = ef - es;
      if (isNaN(esig)) { esig = line; }
      else { esig = line * k_sig + esig * (1 - k_sig); }
      prevHist = hist;
      hist = line - esig;
    }
    return { hist: hist, prevHist: prevHist, crossUp: prevHist < 0 && hist >= 0, crossDown: prevHist > 0 && hist <= 0 };
  }

  function _atr(candles, period) {
    if (!candles || candles.length < period + 1) return null;
    var trs = [];
    for (var i = 1; i < candles.length; i++) {
      var tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low  - candles[i - 1].close)
      );
      trs.push(tr);
    }
    var sum = 0;
    for (var j = Math.max(0, trs.length - period); j < trs.length; j++) sum += trs[j];
    return sum / Math.min(period, trs.length);
  }

  function _volRatio(volumes) {
    if (!volumes || volumes.length < 21) return 1.0;
    var last = volumes[volumes.length - 1];
    var avg20 = 0;
    for (var i = volumes.length - 21; i < volumes.length - 1; i++) avg20 += volumes[i];
    avg20 /= 20;
    return avg20 > 0 ? last / avg20 : 1.0;
  }

  // ADX — Average Directional Index (Wilder's smoothing)
  function _adx(candles, period) {
    if (!candles || candles.length < period * 2 + 1) return null;
    var dmP = [], dmM = [], trs = [];
    for (var i = 1; i < candles.length; i++) {
      var up   = candles[i].high - candles[i - 1].high;
      var down = candles[i - 1].low - candles[i].low;
      dmP.push((up > down && up > 0)   ? up   : 0);
      dmM.push((down > up && down > 0) ? down : 0);
      trs.push(Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low  - candles[i - 1].close)
      ));
    }
    var smTr = 0, smP = 0, smM = 0;
    for (var j = 0; j < period; j++) { smTr += trs[j]; smP += dmP[j]; smM += dmM[j]; }
    var dxSum = 0, dxCount = 0, diP = 0, diM = 0;
    for (var k = period; k < trs.length; k++) {
      smTr = smTr - smTr / period + trs[k];
      smP  = smP  - smP  / period + dmP[k];
      smM  = smM  - smM  / period + dmM[k];
      diP  = smTr > 0 ? smP / smTr * 100 : 0;
      diM  = smTr > 0 ? smM / smTr * 100 : 0;
      var diSum = diP + diM;
      dxSum += diSum > 0 ? Math.abs(diP - diM) / diSum * 100 : 0;
      dxCount++;
    }
    var adx = dxCount > 0 ? dxSum / dxCount : 0;
    return { adx: adx, plusDI: diP, minusDI: diM, trending: adx > 25, ranging: adx < 20 };
  }

  // EMA slope — rate of change of EMA over last `lookback` bars (as %)
  function _emaSlope(closes, period, lookback) {
    if (!closes || closes.length < period + lookback) return null;
    var emaFull = _ema(closes, period);
    var emaOld  = _ema(closes.slice(0, closes.length - lookback), period);
    if (!emaFull || !emaOld || emaOld === 0) return null;
    return (emaFull - emaOld) / emaOld * 100;
  }

  // Stochastic RSI — more sensitive momentum, catches turns before plain RSI
  function _stochRsi(closes, rsiLen, stochLen, kSmooth, dSmooth) {
    var needed = rsiLen + stochLen + Math.max(kSmooth, dSmooth) + 2;
    if (!closes || closes.length < needed) return null;
    var rsiArr = [];
    for (var i = stochLen; i >= 0; i--) {
      rsiArr.unshift(_rsi(closes.slice(0, closes.length - i), rsiLen));
    }
    if (rsiArr.some(function (v) { return v === null; })) return null;
    var stochArr = [];
    for (var s = 0; s < rsiArr.length; s++) {
      var win = rsiArr.slice(Math.max(0, s - stochLen + 1), s + 1);
      var lo = Math.min.apply(null, win), hi = Math.max.apply(null, win);
      stochArr.push(hi > lo ? (rsiArr[s] - lo) / (hi - lo) * 100 : 50);
    }
    function _sma(arr, len) {
      if (arr.length < len) return null;
      var sum = 0;
      for (var si = arr.length - len; si < arr.length; si++) sum += arr[si];
      return sum / len;
    }
    var kArr = [];
    for (var ki = kSmooth - 1; ki < stochArr.length; ki++) {
      kArr.push(_sma(stochArr.slice(0, ki + 1), kSmooth));
    }
    var kNow = kArr[kArr.length - 1], kPrev = kArr[kArr.length - 2];
    var dNow = _sma(kArr, dSmooth);
    var dPrev = kArr.length > dSmooth ? _sma(kArr.slice(0, kArr.length - 1), dSmooth) : null;
    if (kNow === null || dNow === null) return null;
    return {
      k:         kNow,
      d:         dNow,
      crossUp:   kPrev != null && dPrev != null && kPrev < dPrev && kNow >= dNow,
      crossDown: kPrev != null && dPrev != null && kPrev > dPrev && kNow <= dNow
    };
  }

  // RSI Divergence — bullish: price LL but RSI HL; bearish: price HH but RSI LH
  function _divergence(closes, rsiPeriod, lookback) {
    if (!closes || closes.length < rsiPeriod + lookback + 3) return { bullDiv: false, bearDiv: false };
    var rsiNow   = _rsi(closes, rsiPeriod);
    var rsiOld   = _rsi(closes.slice(0, closes.length - lookback), rsiPeriod);
    if (rsiNow === null || rsiOld === null) return { bullDiv: false, bearDiv: false };
    var priceNow = closes[closes.length - 1];
    var priceOld = closes[closes.length - 1 - lookback];
    var pd = (priceNow - priceOld) / priceOld;
    var rd = rsiNow - rsiOld;
    return {
      bullDiv: pd < -0.005 && rd >  4 && rsiNow < 52,
      bearDiv: pd >  0.005 && rd < -4 && rsiNow > 48
    };
  }

  // ── HL candle fetch ────────────────────────────────────────────────────────
  // Parameterised version of gii-scalper.js _hlFetch — takes any HL coin name

  function _fetchCandles(hlTicker, interval, numCandles) {
    var now = Date.now();
    var msPerBar = interval === '5m' ? 5 * 60000 : 15 * 60000;
    var startTime = now - numCandles * msPerBar * 2;
    return fetch(HL_INFO, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'candleSnapshot',
        req:  { coin: hlTicker, interval: interval, startTime: startTime, endTime: now }
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!Array.isArray(data)) return null;
        return data.map(function (d) {
          return {
            time:   d.t,
            open:   parseFloat(d.o),
            high:   parseFloat(d.h),
            low:    parseFloat(d.l),
            close:  parseFloat(d.c),
            volume: parseFloat(d.v) || 0
          };
        }).filter(function (c) { return c.close > 0; }).slice(-numCandles);
      })
      .catch(function () { return null; });
  }

  // ── indicator computation ─────────────────────────────────────────────────

  function _computeIndicators(c5m, c15m) {
    if (!c5m || c5m.length < 30 || !c15m || c15m.length < 25) return null;
    var cl5  = c5m.map(function (c) { return c.close; });
    var cl15 = c15m.map(function (c) { return c.close; });
    var vl5  = c5m.map(function (c) { return c.volume; });
    var rsi5m    = _rsi(cl5, 7);
    var ema9_15  = _ema(cl15, 9);
    var ema21_15 = _ema(cl15, 21);
    var bb15     = _bollinger(cl15, 20, 2.0);
    var macd15   = _macdHist(cl15, 3, 8, 3);
    var atr5     = _atr(c5m, 14);
    var volR     = _volRatio(vl5);
    var price    = cl5[cl5.length - 1];
    if (rsi5m === null || ema9_15 === null || ema21_15 === null || !bb15) return null;

    // Elite TA additions
    var adxData = _adx(c5m, 14);
    var emaSlp  = _emaSlope(cl15, 9, 3);
    var stochR  = _stochRsi(cl5, 14, 14, 3, 3);
    var divData = _divergence(cl5, 7, 10);
    var regime  = adxData ? (adxData.trending ? 'trending' : adxData.ranging ? 'ranging' : 'mixed') : 'mixed';

    return {
      rsi5m:      rsi5m,
      ema9_15:    ema9_15,
      ema21_15:   ema21_15,
      bb15:       bb15,
      bbWidth:    bb15.bw || 0,
      macd15:     macd15,
      atr5:       atr5 || price * 0.002,
      volRatio:   volR,
      price:      price,
      emaBullish: ema9_15 > ema21_15,
      emaBearish: ema9_15 < ema21_15,
      adx:        adxData,
      emaSlope:   emaSlp,
      stochRsi:   stochR,
      divergence: divData,
      regime:     regime
    };
  }

  // ── setup scoring (adapted from gii-scalper.js with per-sector thresholds) ─

  function _scoreSetup(ind, dir, thresh, sector) {
    var score = 0.0;
    var reasons = [];
    var entryType = 'pullback';
    var regime    = ind.regime || 'mixed';

    if (dir === 'long') {
      // ── Core indicators ──────────────────────────────────────────────────
      if (ind.rsi5m < thresh.rsiLong) {
        score += 0.18; reasons.push('RSI7 ' + ind.rsi5m.toFixed(0) + ' (OS)');
        if (ind.rsi5m < thresh.rsiStrongL) { score += 0.10; reasons.push('extreme OS'); }
        entryType = 'mean_reversion';
      }
      if (ind.emaBullish)                                         { score += 0.12; reasons.push('EMA9>21'); }
      if (ind.bb15 && ind.price <= ind.bb15.lower * 1.006)       { score += 0.10; reasons.push('BB lower'); }
      if (ind.macd15) {
        if (ind.macd15.crossUp)       { score += 0.13; reasons.push('MACD xUp'); entryType = 'breakout'; }
        else if (ind.macd15.hist > 0) { score += 0.05; reasons.push('MACD +hist'); }
      }
      if      (ind.volRatio > 1.8) { score += 0.09; reasons.push('Vol x' + ind.volRatio.toFixed(1)); }
      else if (ind.volRatio > 1.3) { score += 0.05; reasons.push('Vol x' + ind.volRatio.toFixed(1)); }

      // ── Elite TA additions ───────────────────────────────────────────────
      if (ind.stochRsi) {
        if (ind.stochRsi.k < 20 && ind.stochRsi.d < 20)       { score += 0.10; reasons.push('StochRSI-OS'); }
        else if (ind.stochRsi.crossUp && ind.stochRsi.k < 40) { score += 0.07; reasons.push('StochRSI-xUp'); }
      }
      if (ind.divergence) {
        if (ind.divergence.bullDiv) { score += 0.12; reasons.push('bull-div'); }
        if (ind.divergence.bearDiv) { score *= 0.75; reasons.push('bear-div-penalty'); }
      }
      if (ind.emaSlope !== null && ind.emaSlope !== undefined) {
        if (ind.emaSlope >  0.02) { score += 0.07; reasons.push('EMA↑'); }
        else if (ind.emaSlope < -0.05) { score -= 0.05; }
      }
      if (entryType === 'breakout'       && ind.bbWidth < 0.025) { score += 0.08; reasons.push('BB-squeeze'); }
      if (entryType === 'mean_reversion' && ind.bbWidth > 0.08)  { score += 0.06; reasons.push('BB-extended'); }

    } else {
      // ── Core indicators ──────────────────────────────────────────────────
      if (ind.rsi5m > thresh.rsiShort) {
        score += 0.18; reasons.push('RSI7 ' + ind.rsi5m.toFixed(0) + ' (OB)');
        if (ind.rsi5m > thresh.rsiStrongS) { score += 0.10; reasons.push('extreme OB'); }
        entryType = 'mean_reversion';
      }
      if (ind.emaBearish)                                         { score += 0.12; reasons.push('EMA9<21'); }
      if (ind.bb15 && ind.price >= ind.bb15.upper * 0.994)       { score += 0.10; reasons.push('BB upper'); }
      if (ind.macd15) {
        if (ind.macd15.crossDown)     { score += 0.13; reasons.push('MACD xDown'); entryType = 'breakdown'; }
        else if (ind.macd15.hist < 0) { score += 0.05; reasons.push('MACD -hist'); }
      }
      if      (ind.volRatio > 1.8) { score += 0.09; reasons.push('Vol x' + ind.volRatio.toFixed(1)); }
      else if (ind.volRatio > 1.3) { score += 0.05; reasons.push('Vol x' + ind.volRatio.toFixed(1)); }

      // ── Elite TA additions ───────────────────────────────────────────────
      if (ind.stochRsi) {
        if (ind.stochRsi.k > 80 && ind.stochRsi.d > 80)           { score += 0.10; reasons.push('StochRSI-OB'); }
        else if (ind.stochRsi.crossDown && ind.stochRsi.k > 60)   { score += 0.07; reasons.push('StochRSI-xDn'); }
      }
      if (ind.divergence) {
        if (ind.divergence.bearDiv) { score += 0.12; reasons.push('bear-div'); }
        if (ind.divergence.bullDiv) { score *= 0.75; reasons.push('bull-div-penalty'); }
      }
      if (ind.emaSlope !== null && ind.emaSlope !== undefined) {
        if (ind.emaSlope < -0.02) { score += 0.07; reasons.push('EMA↓'); }
        else if (ind.emaSlope > 0.05) { score -= 0.05; }
      }
      if (entryType === 'breakdown'      && ind.bbWidth < 0.025) { score += 0.08; reasons.push('BB-squeeze'); }
      if (entryType === 'mean_reversion' && ind.bbWidth > 0.08)  { score += 0.06; reasons.push('BB-extended'); }
    }

    // ── ADX regime gating ────────────────────────────────────────────────────
    if (regime === 'trending' && entryType === 'mean_reversion') {
      var trendAligned = (dir === 'long' && ind.emaBullish) || (dir === 'short' && ind.emaBearish);
      if (!trendAligned) { score *= 0.55; reasons.push('trend-regime-penalty'); }
    }
    if (regime === 'ranging') {
      if (entryType === 'breakout' || entryType === 'breakdown') {
        score *= 0.70; reasons.push('range-regime-penalty');
      } else {
        score += 0.06; reasons.push('ranging-boost');
      }
    }

    // ── Brain shared-learning boost ──────────────────────────────────────────
    if (window.GII_SCALPER_BRAIN) {
      try {
        var gtiRegime = (window.GII && typeof GII.gti === 'function') ?
          (function () {
            var g = GII.gti(); var v = (g && g.value) || (typeof g === 'number' ? g : 0);
            return v >= 80 ? 'extreme' : v >= 60 ? 'high' : v >= 30 ? 'moderate' : 'normal';
          })() : 'normal';
        var boost = GII_SCALPER_BRAIN.getSetupBoost(sector || 'unknown', entryType, gtiRegime);
        score = _clamp(score * boost, 0, 1);
        if (boost > 1.1) reasons.push('brain+' + Math.round((boost - 1) * 100) + '%');
        else if (boost < 0.9) reasons.push('brain-' + Math.round((1 - boost) * 100) + '%');
      } catch (e) {}
    }

    return { score: _clamp(score, 0, 1), reasons: reasons, entryType: entryType };
  }

  // ── trend filter ──────────────────────────────────────────────────────────
  // Reads GII_AGENT_TECHNICALS for the asset; falls back to EMA alignment.

  function _getTrend(asset, ind) {
    try {
      var ta = window.GII_AGENT_TECHNICALS;
      if (ta) {
        var sigs = ta.signals ? ta.signals() : [];
        for (var i = 0; i < sigs.length; i++) {
          if ((sigs[i].asset || '').toUpperCase() === asset.toUpperCase() &&
              (sigs[i].confidence || 0) >= 0.40) {
            return sigs[i].bias;
          }
        }
      }
    } catch (e) {}
    // Fallback: derive trend from EMA alignment in our own candles
    if (!ind) return 'neutral';
    return ind.emaBullish ? 'long' : ind.emaBearish ? 'short' : 'neutral';
  }

  // ── GTI gate ──────────────────────────────────────────────────────────────

  function _gtiOk() {
    try {
      if (!window.GII || typeof GII.gti !== 'function') return true;
      var g = GII.gti();
      var v = (g && typeof g.value === 'number') ? g.value : (typeof g === 'number' ? g : 0);
      return v < GTI_GATE;
    } catch (e) { return true; }
  }

  // ── instance lifecycle ────────────────────────────────────────────────────

  function _spawnInstance(watchItem, voltPct) {
    var asset      = watchItem.eeAsset;
    var thresh     = SECTOR_THRESH[watchItem.sector] || SECTOR_THRESH.crypto;
    // Assign a stable stagger index at spawn time so retirements don't reshuffle offsets
    var staggerIdx = Object.keys(_instances).length;
    _instances[asset] = {
      asset:         asset,
      hlTicker:      watchItem.hlTicker,
      sector:        watchItem.sector,
      thresh:        thresh,
      staggerIdx:    staggerIdx,
      spawnedAt:     Date.now(),
      spawnReason:   'vol-spike:' + voltPct.toFixed(2) + '%',
      lastPollAt:    0,
      lastSignalAt:  0,
      _candles5m:    [],
      _candles15m:   [],
      _activeScalp:  null,  // { bias, signalTs }
      _signals:      [],
      _signalCount:  0,     // cumulative signals emitted this session
      score:         null,
      retired:       false,
      retiredAt:     null,
      retiredReason: null
    };
    // Pre-seed feedback from brain's cross-instance historical data
    if (window.GII_SCALPER_BRAIN) {
      try {
        var inherited = GII_SCALPER_BRAIN.inheritFeedback(asset);
        if (inherited) {
          if (inherited.long  && inherited.long.total  >= 3) _feedback[asset + '_long']  = inherited.long;
          if (inherited.short && inherited.short.total >= 3) _feedback[asset + '_short'] = inherited.short;
        }
      } catch (e) {}
    }

    _stats.spawned++;
    console.info('[SCRAPER MGR] Spawned scraper for ' + asset +
      ' (' + watchItem.hlTicker + ')  spike=' + voltPct.toFixed(2) + '% stagger=' + staggerIdx);
  }

  function _retireInstance(inst, reason) {
    inst.retired       = true;
    inst.retiredAt     = Date.now();
    inst.retiredReason = reason;
    _retired.unshift({
      asset:          inst.asset,
      hlTicker:       inst.hlTicker,
      spawnedAt:      inst.spawnedAt,
      retiredAt:      inst.retiredAt,
      retiredReason:  reason,
      signalsEmitted: inst._signalCount || 0,  // cumulative count, not just last batch
      score:          inst.score
    });
    if (_retired.length > 20) _retired.pop();
    // Record cooldown so this asset can't immediately re-spawn
    _recentlyRetired[inst.asset] = Date.now();
    delete _instances[inst.asset];
    _stats.retired++;
    console.info('[SCRAPER MGR] Retired scraper for ' + inst.asset + ' — ' + reason +
      ' (' + (inst._signalCount || 0) + ' signals)');
  }

  function _checkRetire(inst) {
    var now = Date.now();

    // No signal emitted and 2h have passed since spawn → false alarm
    if (inst.lastSignalAt === 0 && (now - inst.spawnedAt) > NO_SIGNAL_RETIRE_MS) {
      _retireInstance(inst, 'no-signal-in-2h');
      return;
    }

    // Score-based retirement (needs MIN_TRADES_SCORE closed trades to activate)
    var trades = _getInstanceTrades(inst);
    if (trades.length >= 5) {
      var wins   = trades.filter(function (t) { return (t.pnl_usd || 0) > 0; }).length;
      var wr     = wins / trades.length;
      if (wr < RETIRE_WR_HARD) {
        _retireInstance(inst, 'win-rate-' + Math.round(wr * 100) + '%-hard-floor');
        return;
      }
      if (trades.length >= 10 && wr < RETIRE_WR_SOFT) {
        _retireInstance(inst, 'win-rate-' + Math.round(wr * 100) + '%-soft-floor');
        return;
      }
      // Update score for eviction logic
      var avgPnl = trades.reduce(function (s, t) { return s + (t.pnl_usd || 0); }, 0) / trades.length;
      var ageHours = (now - inst.spawnedAt) / 3600000;
      var freq     = trades.length / Math.max(1, ageHours);
      inst.score   = _round2(wr * Math.max(0, avgPnl) * Math.sqrt(freq));
    }

    // Evict lowest-score instance if at cap and a better asset is waiting
    var active = Object.keys(_instances).length;
    if (active >= MAX_ACTIVE) {
      var candidates = WATCHLIST.filter(function (w) {
        return !_instances[w.eeAsset] &&
               (_voltScores[w.eeAsset] || 0) >= w.spikePct;
      });
      if (candidates.length > 0) {
        // Find lowest-scored active instance
        var worst = null;
        Object.keys(_instances).forEach(function (k) {
          var s = _instances[k].score;
          if (s !== null && (worst === null || s < (_instances[worst].score || 0))) worst = k;
        });
        if (worst && worst === inst.asset) {
          _retireInstance(inst, 'evicted-for-higher-volt-asset');
        }
      }
    }
  }

  // ── closed trades for an instance (since spawn) ───────────────────────────

  function _getInstanceTrades(inst) {
    try {
      if (!window.EE || typeof EE.getAllTrades !== 'function') return [];
      return EE.getAllTrades().filter(function (t) {
        return t.status === 'CLOSED' &&
               (t.asset === inst.asset || t.original_asset === inst.asset) &&
               new Date(t.timestamp_open).getTime() > inst.spawnedAt;
      });
    } catch (e) { return []; }
  }

  // ── poll an individual instance ───────────────────────────────────────────

  function _pollInstance(inst) {
    // Equity session gate — HL equity candles are illiquid outside US/London hours
    if (inst.sector === 'equity') {
      var utcH = new Date().getUTCHours();
      if (utcH < EQUITY_SESSION_START || utcH >= EQUITY_SESSION_END) return;
    }

    // GTI gate
    if (!_gtiOk()) return;

    // One-at-a-time per instance
    if (inst._activeScalp) {
      if (Date.now() - inst._activeScalp.signalTs > SCALP_TIMEOUT_MS) {
        inst._activeScalp = null;  // expired
      } else {
        return;
      }
    }

    inst.lastPollAt = Date.now();

    Promise.all([
      _fetchCandles(inst.hlTicker, '5m',  40),
      _fetchCandles(inst.hlTicker, '15m', 20)
    ]).then(function (results) {
      var c5m = results[0], c15m = results[1];

      if (!c5m || c5m.length < 30) return;
      if (!c15m || c15m.length < 25) return;

      inst._candles5m  = c5m;
      inst._candles15m = c15m;

      var ind = _computeIndicators(c5m, c15m);
      if (!ind) return;

      var longSetup  = _scoreSetup(ind, 'long',  inst.thresh, inst.sector);
      var shortSetup = _scoreSetup(ind, 'short', inst.thresh, inst.sector);

      // Trend filter — penalise counter-trend setups × 0.50
      var trend = _getTrend(inst.asset, ind);
      if (trend === 'short' && longSetup.score  > 0) longSetup.score  *= 0.50;
      if (trend === 'long'  && shortSetup.score > 0) shortSetup.score *= 0.50;

      // Pick best direction
      var bestDir, bestSetup;
      if (longSetup.score >= shortSetup.score && longSetup.score >= 0.18) {
        bestDir = 'long';  bestSetup = longSetup;
      } else if (shortSetup.score >= 0.18) {
        bestDir = 'short'; bestSetup = shortSetup;
      } else {
        return; // no setup
      }

      // Build confidence
      var conf = _clamp(0.52 + bestSetup.score * 0.60, 0, 0.88);

      // Trend alignment boost/penalty
      if (trend === bestDir)       conf = _clamp(conf + 0.05, 0, 0.88);
      else if (trend !== 'neutral') conf = _clamp(conf - 0.08, 0, 0.88);

      // Feedback self-learning
      var fbKey = inst.asset + '_' + bestDir;
      var fb    = _feedback[fbKey];
      if (fb && fb.total >= 5) {
        var wr = fb.winRate || 0;
        if (wr < 0.35)       conf = _clamp(conf * 0.70, 0, 0.88);
        else if (wr < 0.45)  conf = _clamp(conf * 0.85, 0, 0.88);
        else if (wr >= 0.65) conf = _clamp(conf * 1.06, 0, 0.88);
      }

      // Brain sector alignment boost
      if (window.GII_SCALPER_BRAIN) {
        try {
          var align = GII_SCALPER_BRAIN.getSectorAlignment(inst.asset, inst.sector, bestDir);
          if (align > 0) { conf = _clamp(conf + align * 0.08, 0, 0.88); bestSetup.reasons.push('sector-aligned'); }
        } catch (e) {}
      }

      conf = _round2(conf);

      if (conf < MIN_CONF) return;

      var stopDist   = ind.atr5 * 2.0;
      var targetDist = ind.atr5 * 3.5;

      var reasons  = bestSetup.reasons.slice();
      if (trend !== 'neutral') reasons.push('trend:' + trend);
      reasons.push('spike:' + (inst.spawnReason || ''));

      var sig = {
        asset:        inst.asset,
        dir:          bestDir === 'short' ? 'SHORT' : 'LONG',
        conf:         Math.round(conf * 100),
        reason:       'SCRAPER[' + inst.asset + ']: ' + reasons.join(' | '),
        region:       'GLOBAL',
        impactMult:   1.0,
        atrStop:      stopDist,
        atrTarget:    targetDist,
        matchedKeywords: [inst.asset.toLowerCase(), inst.sector, bestSetup.entryType],
        source:       'scraper-manager',
        scalper:      true
      };

      inst._signals     = [sig];
      inst._signalCount = (inst._signalCount || 0) + 1;  // cumulative — survives signal overwrites
      inst._activeScalp = { bias: bestDir, signalTs: Date.now(), entryType: bestSetup.entryType };
      inst.lastSignalAt = Date.now();
      _stats.signals++;

      if (window.GII_SCALPER_BRAIN) {
        try { GII_SCALPER_BRAIN.noteSignal(inst.asset, inst.sector, bestDir); } catch (e) {}
      }

      console.info('[SCRAPER MGR] Signal: ' + bestDir.toUpperCase() + ' ' +
        inst.asset + '  conf=' + conf + '  ' + reasons.join(' | '));

      // Submit through gii-entry confluence scoring if available, else direct to EE
      if (window.GII_AGENT_ENTRY && typeof GII_AGENT_ENTRY.submit === 'function') {
        try { GII_AGENT_ENTRY.submit([{
          asset:           sig.asset,
          dir:             sig.dir,
          conf:            sig.conf,
          reason:          sig.reason,
          region:          sig.region,
          impactMult:      sig.impactMult,
          atrStop:         sig.atrStop,
          atrTarget:       sig.atrTarget,
          matchedKeywords: sig.matchedKeywords,
          source:          'scraper-manager',
          scalper:         true
        }], 'scraper-manager'); } catch (e) {}
      } else if (window.EE && typeof EE.onSignals === 'function') {
        try { EE.onSignals([sig]); } catch (e) {}
      }

    }).catch(function () {});
  }

  // ── main scan loop ────────────────────────────────────────────────────────

  function _scan() {
    _lastPollTs = Date.now();
    _stats.cycles++;

    // Step 1 — update price history for every watchlist asset
    WATCHLIST.forEach(function (w) {
      if (!window.HLFeed || typeof HLFeed.getPrice !== 'function') return;
      try {
        var p = HLFeed.getPrice(w.eeAsset);
        if (!p || !p.price) return;
        if (!_priceHist[w.eeAsset]) _priceHist[w.eeAsset] = [];
        _priceHist[w.eeAsset].push({ price: p.price, ts: Date.now() });
        if (_priceHist[w.eeAsset].length > 12) _priceHist[w.eeAsset].shift();
      } catch (e) {}
    });

    // Step 2 — compute volatility scores
    WATCHLIST.forEach(function (w) {
      var hist = _priceHist[w.eeAsset];
      if (!hist || hist.length < 2) { _voltScores[w.eeAsset] = 0; return; }
      var now15ago = Date.now() - 15 * 60 * 1000;
      var ref = hist[0];
      for (var i = 0; i < hist.length; i++) {
        if (Math.abs(hist[i].ts - now15ago) < Math.abs(ref.ts - now15ago)) ref = hist[i];
      }
      var current = hist[hist.length - 1].price;
      _voltScores[w.eeAsset] = ref.price > 0
        ? _round2(Math.abs(current - ref.price) / ref.price * 100)
        : 0;
    });

    // Step 3 — spawn checks
    var activeCount = Object.keys(_instances).length;
    WATCHLIST.forEach(function (w) {
      if (_instances[w.eeAsset]) return;          // already active
      if (activeCount >= MAX_ACTIVE) return;      // at cap
      // Re-spawn cooldown — don't immediately re-spawn after retirement
      var cooledAt = _recentlyRetired[w.eeAsset] || 0;
      if (cooledAt && (Date.now() - cooledAt) < RESPAWN_COOLDOWN_MS) return;
      var volt = _voltScores[w.eeAsset] || 0;
      if (volt >= w.spikePct) {
        _spawnInstance(w, volt);
        activeCount++;
      }
    });

    // Step 4 — retirement checks
    Object.keys(_instances).forEach(function (k) {
      _checkRetire(_instances[k]);
    });

    // Step 5 — staggered candle polls (staggerIdx is fixed at spawn, not the live array index)
    Object.keys(_instances).forEach(function (k) {
      var inst = _instances[k];
      if (!inst) return;
      var due = inst.lastPollAt + INSTANCE_POLL_MS + (inst.staggerIdx || 0) * STAGGER_MS;
      if (Date.now() >= due) _pollInstance(inst);
    });
  }

  // ── trade result feedback ─────────────────────────────────────────────────

  function onTradeResult(trade) {
    if (!trade) return;
    var asset = (trade.asset || trade.ticker || '').toUpperCase();

    // Check if this trade matches an active or recently-retired instance
    var inst = _instances[asset];
    if (!inst) {
      // Check retired list for recently retired instances
      for (var i = 0; i < _retired.length; i++) {
        if (_retired[i].asset === asset) { inst = _retired[i]; break; }
      }
    }
    if (!inst) return;

    // Clear active slot on live instance
    if (_instances[asset]) _instances[asset]._activeScalp = null;

    // Update feedback
    var pnl    = trade.pnl_usd !== undefined ? trade.pnl_usd : (trade.pnl || trade.profit || 0);
    var winner = pnl > 0;
    var dir    = (trade.dir || trade.direction || 'long').toLowerCase().replace('short','short').replace('long','long');
    if (dir !== 'long' && dir !== 'short') dir = 'long';
    var fbKey  = asset + '_' + dir;

    if (!_feedback[fbKey]) _feedback[fbKey] = { total: 0, correct: 0, winRate: 0, lastTs: null };
    _feedback[fbKey].total++;
    if (winner) _feedback[fbKey].correct++;
    _feedback[fbKey].winRate = _feedback[fbKey].correct / _feedback[fbKey].total;
    _feedback[fbKey].lastTs  = new Date().toISOString();
    _saveFeedback();

    // Feed brain with cross-agent shared learning
    if (window.GII_SCALPER_BRAIN) {
      try {
        var activeInst = _instances[asset];
        var entryType  = (activeInst && activeInst._activeScalp && activeInst._activeScalp.entryType)
                         || 'unknown';
        var sectorName = (activeInst && activeInst.sector) || 'unknown';
        GII_SCALPER_BRAIN.recordOutcome(trade, { sector: sectorName, setupType: entryType, gtiRegime: null });
        GII_SCALPER_BRAIN.clearSignal(asset);
      } catch (e) {}
    }
  }

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_SCRAPER_MANAGER = {

    poll: function () { _scan(); },

    signals: function () {
      var all = [];
      Object.keys(_instances).forEach(function (k) {
        if (_instances[k]._signals) all = all.concat(_instances[k]._signals);
      });
      return all;
    },

    status: function () {
      return {
        active:        Object.keys(_instances).length,
        retired:       _retired.length,
        totalSpawned:  _stats.spawned,
        totalRetired:  _stats.retired,
        totalSignals:  _stats.signals,
        cycles:        _stats.cycles,
        lastPoll:      _lastPollTs,
        watchlist:     WATCHLIST.length,
        maxActive:     MAX_ACTIVE
      };
    },

    volatility: function () { return Object.assign({}, _voltScores); },

    scrapers: function () {
      var active = Object.keys(_instances).map(function (k) {
        var inst = _instances[k];
        return {
          asset:         inst.asset,
          hlTicker:      inst.hlTicker,
          sector:        inst.sector,
          spawnReason:   inst.spawnReason,
          spawnedAt:     inst.spawnedAt,
          lastPollAt:    inst.lastPollAt,
          lastSignalAt:  inst.lastSignalAt,
          signalCount:   inst._signalCount || 0,      // FIX: cumulative count
          score:         inst.score,
          // FIX: rich object so UI can show bias; null when no active trade
          activeSlot:    inst._activeScalp ? { bias: inst._activeScalp.bias } : null,
          retired:       false
        };
      });
      return active.concat(_retired.slice(0, 10));
    },

    spawnFor: function (asset) {
      var w = null;
      for (var i = 0; i < WATCHLIST.length; i++) {
        if (WATCHLIST[i].eeAsset === asset || WATCHLIST[i].hlTicker === asset) {
          w = WATCHLIST[i]; break;
        }
      }
      if (!w) { console.warn('[SCRAPER MGR] spawnFor: asset not in watchlist: ' + asset); return; }
      if (_instances[w.eeAsset]) { console.warn('[SCRAPER MGR] Already active: ' + asset); return; }
      _spawnInstance(w, 99); // manual spawn — use 99% as dummy volt score
    },

    onTradeResult: onTradeResult
  };

  // ── init ──────────────────────────────────────────────────────────────────

  window.addEventListener('load', function () {
    _loadFeedback();
    setTimeout(function () {
      _scan();
      _scanTimer = setInterval(_scan, POLL_INTERVAL_MS);
      console.info('[SCRAPER MGR] Initialised — watching ' + WATCHLIST.length +
        ' assets, max ' + MAX_ACTIVE + ' concurrent scrapers');
    }, INIT_DELAY_MS);
  });

}());
