/* GII Short-Term Scalper Agent — gii-scalper.js v12
 *
 * BTC+ETH 5m/15m technical scalper with one-active-trade discipline.
 * Runs 24/7 — scans every 5 minutes around the clock.
 * Elite TA: RSI-7, EMA 9/21, MACD 3/8/3, Bollinger 20, ADX-14, EMA slope,
 * Stochastic RSI, RSI divergence — with ADX regime gating and BB-width quality
 * scoring. All outcomes feed GII_SCALPER_BRAIN for cross-agent learning.
 *
 * Data sources:
 *   CryptoCompare histominute (primary, no key needed, 100k/month free)
 *   Hyperliquid candleSnapshot (backup, no key needed, public API)
 *
 * Per-asset one-at-a-time discipline: no new signal per asset while that asset's slot is set.
 * Slot is cleared via onTradeResult() or 2h auto-timeout.
 *
 * See also: gii-scalper-session.js — session-hours variant (07:00–22:00 UTC)
 * running every 3 minutes with more relaxed thresholds for peak liquidity.
 *
 * Exposes: window.GII_AGENT_SCALPER
 */
(function () {
  'use strict';

  // ── constants ─────────────────────────────────────────────────────────────

  var POLL_INTERVAL_MS  = 5 * 60 * 1000;     // 5 minutes
  var INIT_DELAY_MS     = 16500;              // after gii-technicals (11.5s) + buffer
  var GTI_GATE          = 65;                 // skip scalping when GTI >= this
  var SCALPER_ASSETS   = [                // Assets scanned each poll cycle
    'BTC', 'ETH', 'SOL', 'XRP', 'DOGE',
    'AVAX', 'BNB', 'ADA', 'LINK', 'DOT',
    'LTC', 'ATOM', 'NEAR', 'ARB', 'OP'
  ];
  var SCALP_TIMEOUT_MS  = 2 * 60 * 60 * 1000; // auto-expire active scalp after 2h
  var MIN_CONF          = 0.60;               // minimum conf to emit (Grade B floor)
  var CC_BASE           = 'https://min-api.cryptocompare.com/data/v2/';
  var HL_INFO           = 'https://api.hyperliquid.xyz/info';
  var CACHE_KEY         = 'gii_scalper_candles_v1';
  var FEEDBACK_KEY      = 'gii_scalper_feedback_v1';

  // Minimum signal requirements per direction
  var LONG_ENTRY = {
    rsiMax:    35,    // RSI-7 on 5m must be below this for oversold
    rsiStrong: 25,    // extreme oversold bonus
    bbBand:    'lower' // price near lower BB
  };
  var SHORT_ENTRY = {
    rsiMin:    65,    // RSI-7 on 5m must be above this for overbought
    rsiStrong: 75,    // extreme overbought bonus
    bbBand:    'upper'
  };

  // ── private state ─────────────────────────────────────────────────────────

  var _signals      = [];      // max 1 — scalper emits at most one signal per cycle
  var _status       = {};
  var _accuracy     = {};      // per-direction accuracy tracking
  var _activeScalps = {};     // { 'BTC': { asset, bias, signalTs }, 'ETH': ... } — per-asset
  var _cache        = {};      // { '5m': [...], '15m': [...] }
  var _feedback     = {};      // { 'BTC_long': { total, correct, winRate, lastTs } }
  var _lastPollTs    = 0;
  var _usedHLBackup  = false;
  var _lastEntryType = 'pullback';  // stored so onTradeResult can pass it to brain

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

  function _loadCache() {
    try {
      var r = localStorage.getItem(CACHE_KEY);
      _cache = r ? JSON.parse(r) : {};
    } catch (e) { _cache = {}; }
  }

  function _saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(_cache)); } catch (e) {}
  }

  // ── math: indicators ──────────────────────────────────────────────────────

  // Wilder's RSI
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

  // Exponential moving average
  function _ema(vals, period) {
    if (!vals || vals.length < period) return null;
    var k = 2 / (period + 1);
    var ema = 0;
    // Seed with SMA of first 'period' values
    for (var i = 0; i < period; i++) ema += vals[i];
    ema /= period;
    for (i = period; i < vals.length; i++) ema = vals[i] * k + ema * (1 - k);
    return ema;
  }

  // Bollinger Bands
  function _bollinger(closes, period, numSd) {
    if (!closes || closes.length < period) return null;
    var slice = closes.slice(-period);
    var mean = 0;
    for (var i = 0; i < slice.length; i++) mean += slice[i];
    mean /= period;
    var variance = 0;
    for (i = 0; i < slice.length; i++) variance += Math.pow(slice[i] - mean, 2);
    var sd = Math.sqrt(variance / period);
    var upper = mean + numSd * sd;
    var lower = mean - numSd * sd;
    return {
      upper:  upper,
      middle: mean,
      lower:  lower,
      bw:     mean > 0 ? (upper - lower) / mean : 0
    };
  }

  // MACD histogram with crossover detection
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

    return {
      hist:      hist,
      prevHist:  prevHist,
      crossUp:   prevHist < 0 && hist >= 0,
      crossDown: prevHist > 0 && hist <= 0
    };
  }

  // ATR (simple average, not Wilder's)
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

  // Volume ratio: latest bar vs 20-bar average
  function _volRatio(volumes) {
    if (!volumes || volumes.length < 21) return 1.0;
    var last = volumes[volumes.length - 1];
    var avg20 = 0;
    for (var i = volumes.length - 21; i < volumes.length - 1; i++) avg20 += volumes[i];
    avg20 /= 20;
    return avg20 > 0 ? last / avg20 : 1.0;
  }

  // ADX — Average Directional Index (Wilder's smoothing)
  // Returns { adx, plusDI, minusDI, trending (>25), ranging (<20) } or null
  function _adx(candles, period) {
    if (!candles || candles.length < period * 2 + 1) return null;
    var dmP = [], dmM = [], trs = [];
    for (var i = 1; i < candles.length; i++) {
      var up   = candles[i].high - candles[i - 1].high;
      var down = candles[i - 1].low - candles[i].low;
      dmP.push((up > down && up > 0)     ? up   : 0);
      dmM.push((down > up && down > 0)   ? down : 0);
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
  // Returns { k, d, crossUp, crossDown } or null
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

  // ── data fetching ─────────────────────────────────────────────────────────

  // CryptoCompare histominute: fetch N*period minutes of 1-min data, aggregate manually
  function _ccFetch(sym, period, numCandles) {
    var limit = numCandles * period + 5;  // extra bars as buffer
    var url = CC_BASE + 'histominute?fsym=' + sym + '&tsym=USD&limit=' + limit;
    return fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || data.Response === 'Error' || !data.Data || !data.Data.Data) return null;
        var raw = data.Data.Data.filter(function (d) { return d.close > 0; });
        if (period === 1) return raw.map(function (d) {
          return { time: d.time * 1000, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volumefrom };
        });
        // Aggregate into period-minute bars
        var result = [];
        for (var i = 0; i + period <= raw.length; i += period) {
          var slice = raw.slice(i, i + period);
          var hi = slice[0].high, lo = slice[0].low, vol = 0;
          for (var j = 0; j < slice.length; j++) {
            if (slice[j].high > hi) hi = slice[j].high;
            if (slice[j].low  < lo) lo = slice[j].low;
            vol += slice[j].volumefrom;
          }
          result.push({
            time:   slice[0].time * 1000,
            open:   slice[0].open,
            high:   hi,
            low:    lo,
            close:  slice[slice.length - 1].close,
            volume: vol
          });
        }
        return result.slice(-numCandles);
      })
      .catch(function () { return null; });
  }

  // Hyperliquid candleSnapshot backup
  function _hlFetch(sym, interval, numCandles) {
    var now = Date.now();
    var msPerBar = (interval === '5m') ? 5 * 60000 : 15 * 60000;
    var startTime = now - numCandles * msPerBar * 2;  // fetch 2x for buffer
    return fetch(HL_INFO, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'candleSnapshot',
        req:  { coin: sym, interval: interval, startTime: startTime, endTime: now }
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

  // ── context filters ───────────────────────────────────────────────────────

  // Get 1h bias from the TA agent (trend filter)
  function _get1hTrend(asset) {
    var ta = window.GII_AGENT_TECHNICALS;
    if (!ta) return 'neutral';
    try {
      var sigs = ta.signals();
      for (var i = 0; i < sigs.length; i++) {
        if (sigs[i].asset === asset && sigs[i].confidence >= 0.45) {
          return sigs[i].bias;  // 'long' | 'short'
        }
      }
    } catch (e) {}
    return 'neutral';
  }

  // GTI gate: returns a size multiplier (0.0 = full stop, 1.0 = no change)
  // v61: graduated cap instead of binary on/off
  function _gtiSizeMult() {
    try {
      if (!window.GII || typeof GII.gti !== 'function') return 1.0;
      var g   = GII.gti();
      var val = (g && typeof g.value === 'number') ? g.value : (typeof g === 'number' ? g : 0);
      if (val >= 90) return 0.0;   // catastrophic — full stop
      if (val >= 80) return 0.45;  // extreme tension — 45% size
      if (val >= 70) return 0.65;  // high tension    — 65% size
      if (val >= 60) return 0.80;  // elevated        — 80% size
      return 1.0;
    } catch (e) { return 1.0; }
  }

  // Scalper slot: one trade at a time, per asset
  function _slotFreeFor(asset) {
    if (!_activeScalps[asset]) return true;
    if (Date.now() - _activeScalps[asset].signalTs > SCALP_TIMEOUT_MS) {
      _activeScalps[asset] = null;
      return true;
    }
    return false;
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
    var adxData   = _adx(c5m, 14);
    var emaSlp    = _emaSlope(cl15, 9, 3);   // EMA9 slope over last 3 × 15m bars
    var stochR    = _stochRsi(cl5, 14, 14, 3, 3);
    var divData   = _divergence(cl5, 7, 10);  // RSI-7 divergence, 10-bar lookback
    var regime    = adxData ? (adxData.trending ? 'trending' : adxData.ranging ? 'ranging' : 'mixed') : 'mixed';

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
      regime:      regime,
      dataQuality: c5m.length >= 80 ? 1.0 : c5m.length >= 60 ? 0.92 : 0.85  // v61: candle data quality
    };
  }

  // ── setup scoring ─────────────────────────────────────────────────────────

  function _scoreSetup(ind, dir) {
    var score = 0.0;
    var reasons = [];
    var entryType = 'pullback';
    var regime    = ind.regime || 'mixed';

    if (dir === 'long') {
      // ── Core indicators ──────────────────────────────────────────────────
      if (ind.rsi5m < LONG_ENTRY.rsiMax) {
        score += 0.18; reasons.push('RSI7 ' + ind.rsi5m.toFixed(0) + ' (OS)');
        if (ind.rsi5m < LONG_ENTRY.rsiStrong) { score += 0.10; reasons.push('extreme OS'); }
        entryType = 'mean_reversion';
      }
      if (ind.emaBullish)                                        { score += 0.12; reasons.push('EMA9>21'); }
      if (ind.bb15 && ind.price <= ind.bb15.lower * 1.006)      { score += 0.10; reasons.push('BB lower'); }
      if (ind.macd15) {
        if (ind.macd15.crossUp)       { score += 0.13; reasons.push('MACD xUp'); entryType = 'breakout'; }
        else if (ind.macd15.hist > 0) { score += 0.05; reasons.push('MACD +hist'); }
      }
      if      (ind.volRatio > 1.8)  { score += 0.09; reasons.push('Vol x' + ind.volRatio.toFixed(1)); }
      else if (ind.volRatio > 1.3)  { score += 0.05; reasons.push('Vol x' + ind.volRatio.toFixed(1)); }

      // ── Elite TA additions ───────────────────────────────────────────────
      // Stochastic RSI
      if (ind.stochRsi) {
        // Reduced 0.10→0.05: StochRSI is derivative of RSI (already scored above),
        // adding 0.10 was double-dipping rather than independent signal
        if (ind.stochRsi.k < 20 && ind.stochRsi.d < 20)            { score += 0.05; reasons.push('StochRSI-OS'); }
        else if (ind.stochRsi.crossUp && ind.stochRsi.k < 40)      { score += 0.04; reasons.push('StochRSI-xUp'); }
      }
      // Divergence
      if (ind.divergence) {
        if (ind.divergence.bullDiv)  { score += 0.12; reasons.push('bull-div'); }
        if (ind.divergence.bearDiv)  { score *= 0.75; reasons.push('bear-div-penalty'); }
      }
      // EMA slope
      if (ind.emaSlope !== null && ind.emaSlope !== undefined) {
        if (ind.emaSlope >  0.02) { score += 0.07; reasons.push('EMA↑'); }
        else if (ind.emaSlope < -0.05) { score -= 0.05; }
      }
      // BB width quality
      if (entryType === 'breakout'       && ind.bbWidth < 0.025) { score += 0.08; reasons.push('BB-squeeze'); }
      if (entryType === 'mean_reversion' && ind.bbWidth > 0.08)  { score += 0.06; reasons.push('BB-extended'); }

    } else {  // short
      // ── Core indicators ──────────────────────────────────────────────────
      if (ind.rsi5m > SHORT_ENTRY.rsiMin) {
        score += 0.18; reasons.push('RSI7 ' + ind.rsi5m.toFixed(0) + ' (OB)');
        if (ind.rsi5m > SHORT_ENTRY.rsiStrong) { score += 0.10; reasons.push('extreme OB'); }
        entryType = 'mean_reversion';
      }
      if (ind.emaBearish)                                        { score += 0.12; reasons.push('EMA9<21'); }
      if (ind.bb15 && ind.price >= ind.bb15.upper * 0.994)      { score += 0.10; reasons.push('BB upper'); }
      if (ind.macd15) {
        if (ind.macd15.crossDown)     { score += 0.13; reasons.push('MACD xDown'); entryType = 'breakdown'; }
        else if (ind.macd15.hist < 0) { score += 0.05; reasons.push('MACD -hist'); }
      }
      if      (ind.volRatio > 1.8)  { score += 0.09; reasons.push('Vol x' + ind.volRatio.toFixed(1)); }
      else if (ind.volRatio > 1.3)  { score += 0.05; reasons.push('Vol x' + ind.volRatio.toFixed(1)); }

      // ── Elite TA additions ───────────────────────────────────────────────
      if (ind.stochRsi) {
        // Reduced 0.10→0.05: same as LONG side — StochRSI is RSI derivative, not independent
        if (ind.stochRsi.k > 80 && ind.stochRsi.d > 80)            { score += 0.05; reasons.push('StochRSI-OB'); }
        else if (ind.stochRsi.crossDown && ind.stochRsi.k > 60)    { score += 0.04; reasons.push('StochRSI-xDn'); }
      }
      if (ind.divergence) {
        if (ind.divergence.bearDiv)  { score += 0.12; reasons.push('bear-div'); }
        if (ind.divergence.bullDiv)  { score *= 0.75; reasons.push('bull-div-penalty'); }
      }
      if (ind.emaSlope !== null && ind.emaSlope !== undefined) {
        if (ind.emaSlope < -0.02) { score += 0.07; reasons.push('EMA↓'); }
        else if (ind.emaSlope > 0.05) { score -= 0.05; }
      }
      if (entryType === 'breakdown'      && ind.bbWidth < 0.025) { score += 0.08; reasons.push('BB-squeeze'); }
      if (entryType === 'mean_reversion' && ind.bbWidth > 0.08)  { score += 0.06; reasons.push('BB-extended'); }
    }

    // ── ADX regime gating ────────────────────────────────────────────────────
    // In trending markets: mean-reversion against trend is dangerous
    // In ranging markets: breakout signals are likely false
    // ADX cusp (20–25): no directional energy — worst entry conditions, penalise all setups
    if (regime === 'trending' && entryType === 'mean_reversion') {
      var trendAligned = (dir === 'long' && ind.emaBullish) || (dir === 'short' && ind.emaBearish);
      if (!trendAligned) { score *= 0.55; reasons.push('trend-regime-penalty'); }
    }
    if (regime === 'ranging') {
      if (entryType === 'breakout' || entryType === 'breakdown') {
        score *= 0.50; reasons.push('range-regime-penalty');  // v61: was 0.70 — false breakouts in ranging are common
      } else {
        score += 0.06; reasons.push('ranging-boost');  // mean-reversion thrives here
      }
    }
    if (regime === 'mixed' && ind.adx && ind.adx.adx > 20 && ind.adx.adx < 25) {
      score *= 0.85; reasons.push('adx-cusp-penalty');  // ADX 20-25 = transitional, no conviction
    }

    // ── Brain shared-learning boost ──────────────────────────────────────────
    if (window.GII_SCALPER_BRAIN) {
      try {
        var gtiRegime = (window.GII && typeof GII.gti === 'function') ?
          (function () {
            var g = GII.gti(); var v = (g && g.value) || (typeof g === 'number' ? g : 0);
            return v >= 80 ? 'extreme' : v >= 60 ? 'high' : v >= 30 ? 'moderate' : 'normal';
          })() : 'normal';
        var boost = GII_SCALPER_BRAIN.getSetupBoost('crypto', entryType, gtiRegime);
        score = _clamp(score * boost, 0, 1);
        if (boost > 1.1) reasons.push('brain+' + Math.round((boost - 1) * 100) + '%');
        else if (boost < 0.9) reasons.push('brain-' + Math.round((1 - boost) * 100) + '%');
      } catch (e) {}
    }

    return { score: _clamp(score, 0, 1), reasons: reasons, entryType: entryType };
  }

  // ── signal construction ───────────────────────────────────────────────────

  function _leverage(conf) {
    if (conf >= 0.80) return 10;
    if (conf >= 0.70) return 7;
    return 5;
  }

  function _holdTime(entryType, conf) {
    if (entryType === 'mean_reversion') return conf >= 0.75 ? 25 : 40;
    if (entryType === 'breakout' || entryType === 'breakdown') return conf >= 0.75 ? 60 : 90;
    return 45;  // pullback
  }

  function _buildSignal(asset, dir, ind, setup) {
    // Base confidence from setup score (score 0.20 → conf 0.60; score 0.60+ → conf ~0.86)
    var conf = _clamp(0.52 + setup.score * 0.60, 0, 0.88);
    var reasons = setup.reasons.slice();

    // v61: discount confidence if candle data is sparse
    if (ind.dataQuality && ind.dataQuality < 1.0) {
      conf = _clamp(conf * ind.dataQuality, 0, 0.88);
      reasons.push('data-quality-' + ind.dataQuality);
    }

    // 1h trend filter boost/penalty
    var trend1h = _get1hTrend(asset);
    if (trend1h === dir) {
      conf = _clamp(conf + 0.05, 0, 0.88);
      reasons.push('1h ' + dir + ' aligned');
    } else if (trend1h !== 'neutral') {
      conf = _clamp(conf - 0.08, 0, 0.88);
      reasons.push('counter-trend');
    }

    // Feedback self-learning adjustment
    var fbKey = asset + '_' + dir;
    var fb = _feedback[fbKey];
    if (fb && fb.total >= 5) {
      var wr = fb.winRate || 0;
      if (wr < 0.35) { conf = _clamp(conf * 0.70, 0, 0.88); }
      else if (wr < 0.45) { conf = _clamp(conf * 0.85, 0, 0.88); }
      else if (wr >= 0.65) { conf = _clamp(conf * 1.06, 0, 0.88); }
    }

    // Brain sector alignment boost (other crypto assets agreeing = real signal)
    if (window.GII_SCALPER_BRAIN) {
      try {
        var align = GII_SCALPER_BRAIN.getSectorAlignment(asset, 'crypto', dir);
        if (align > 0) { conf = _clamp(conf + align * 0.08, 0, 0.88); reasons.push('sector-aligned'); }
      } catch (e) {}
    }

    conf = _round2(conf);
    _lastEntryType = setup.entryType;

    var stopDist   = ind.atr5 * 2.0;
    var targetDist = ind.atr5 * 3.5;  // ~1.75:1 R:R minimum

    return {
      source:        'scalper',
      asset:         asset,
      bias:          dir,
      confidence:    conf,
      reasoning:     reasons.join(' | '),
      timestamp:     Date.now(),
      region:        'GLOBAL',
      evidenceKeys:  [asset.toLowerCase() + '_5m', asset.toLowerCase() + '_15m', setup.entryType],
      // Scalper-specific fields
      scalper:       true,
      leverage:      _leverage(conf),
      hold_time_est: _holdTime(setup.entryType, conf),
      entry_type:    setup.entryType,
      tight_stop:    true,
      atrStop:       stopDist,
      atrTarget:     targetDist
    };
  }

  // ── main poll ─────────────────────────────────────────────────────────────

  function _pollAsset(sym, gtiM) {
    /* Block new scalp signals during an active geopolitical regime shift.
       The exit agent force-closes all non-defensive positions within 90s of a
       shift, so opening new trades just burns spread for a guaranteed loss. */
    if (window.GII_AGENT_REGIME) {
      try {
        var _regSt = GII_AGENT_REGIME.status();
        if (_regSt.regimeShiftActive) {
          _status['note_' + sym] = 'Blocked: regime shift active (' + (_regSt.shiftType || '?') + ')';
          return;
        }
      } catch (e) {}
    }

    if (!_slotFreeFor(sym)) {
      _status['note_' + sym] = 'Active scalp: ' + JSON.stringify(_activeScalps[sym]);
      return;
    }

    // Fetch 5m candles (100 bars ≈ 8.3h) and 15m candles (48 bars ≈ 12h)
    var p5m  = _ccFetch(sym, 5, 100);
    var p15m = _ccFetch(sym, 15, 48);

    Promise.all([p5m, p15m])
      .then(function (results) {
        var c5m = results[0], c15m = results[1];
        _usedHLBackup = false;

        // Fallback to Hyperliquid if CC fails
        var fallbacks = [];
        if (!c5m)  fallbacks.push(_hlFetch(sym, '5m',  100).then(function (d) { c5m  = d; _usedHLBackup = true; }));
        if (!c15m) fallbacks.push(_hlFetch(sym, '15m', 48).then(function (d) { c15m = d; _usedHLBackup = true; }));

        return Promise.all(fallbacks).then(function () { return [c5m, c15m]; });
      })
      .then(function (data) {
        var c5m = data[0], c15m = data[1];

        if (!c5m || c5m.length < 30) {
          _status['error_' + sym] = 'Insufficient 5m data (' + (c5m ? c5m.length : 0) + ' bars)';
          return;
        }
        if (!c15m || c15m.length < 25) {
          _status['error_' + sym] = 'Insufficient 15m data (' + (c15m ? c15m.length : 0) + ' bars)';
          return;
        }

        _status['error_' + sym] = null;

        // Cache for UI display
        _cache[sym + '_5m']  = c5m.slice(-100);
        _cache[sym + '_15m'] = c15m.slice(-48);
        _saveCache();

        var ind = _computeIndicators(c5m, c15m);
        if (!ind) {
          _status['error_' + sym] = 'Indicator computation failed';
          return;
        }

        _status['price_' + sym]    = ind.price;
        _status['rsi5m_' + sym]    = Math.round(ind.rsi5m * 10) / 10;
        _status['emaTrend_' + sym] = ind.emaBullish ? 'bullish' : 'bearish';
        _status['volRatio_' + sym] = _round2(ind.volRatio);
        _status['atr5m_' + sym]    = _round2(ind.atr5);
        _status['trend1h_' + sym]  = _get1hTrend(sym);
        _status.dataSource = _usedHLBackup ? 'Hyperliquid' : 'CryptoCompare';

        // Backwards-compat: mirror BTC status into top-level keys for dashboard
        if (sym === 'BTC') {
          _status.price    = ind.price;
          _status.rsi5m    = Math.round(ind.rsi5m * 10) / 10;
          _status.emaTrend = ind.emaBullish ? 'bullish' : 'bearish';
          _status.volRatio = _round2(ind.volRatio);
          _status.atr5m    = _round2(ind.atr5);
          _status.trend1h  = _status['trend1h_' + sym];
        }

        var longSetup  = _scoreSetup(ind, 'long');
        var shortSetup = _scoreSetup(ind, 'short');

        // Apply trend filter: penalise counter-trend setups
        var trend1h = _status['trend1h_' + sym];
        if (trend1h === 'short' && longSetup.score  > 0) longSetup.score  *= 0.50;
        if (trend1h === 'long'  && shortSetup.score > 0) shortSetup.score *= 0.50;

        // Pick best direction; must meet minimum score
        var bestDir, bestSetup;
        if (longSetup.score >= shortSetup.score && longSetup.score >= 0.18) {
          bestDir = 'long';  bestSetup = longSetup;
        } else if (shortSetup.score >= 0.18) {
          bestDir = 'short'; bestSetup = shortSetup;
        } else {
          _signals = _signals.filter(function (s) { return s.asset !== sym; });
          _status['note_' + sym] = 'No setup (L=' + longSetup.score.toFixed(2) + ' S=' + shortSetup.score.toFixed(2) + ')';
          return;
        }

        // Correlation guard: allow up to 2 concurrent same-direction scalps.
        // One active scalp no longer blocks all others — crypto assets diverge
        // enough on short timeframes to run 2 positions simultaneously.
        // A 3rd same-direction scalp is still blocked to prevent over-concentration.
        var _sameDirCount = SCALPER_ASSETS.filter(function (otherSym) {
          return otherSym !== sym && _activeScalps[otherSym] && _activeScalps[otherSym].bias === bestDir;
        }).length;
        if (_sameDirCount >= 2) {
          _status['note_' + sym] = 'Corr-blocked: ' + _sameDirCount + ' same-direction scalps already active';
          console.info('[GII SCALPER] ' + sym + ' ' + bestDir.toUpperCase() + ' suppressed — ' + _sameDirCount + ' correlated positions already open');
          return;
        }

        var sig = _buildSignal(sym, bestDir, ind, bestSetup);

        if (sig.confidence < MIN_CONF) {
          _signals = _signals.filter(function (s) { return s.asset !== sym; });
          _status['note_' + sym] = 'Below grade threshold (conf=' + sig.confidence + ')';
          return;
        }

        /* Brain history validation: if asset+direction has ≥5 completed trades and
           a win rate below 45%, reduce confidence by 25% to make the signal harder
           to pass EE's min_confidence gate. */
        if (window.GII_SCALPER_BRAIN && typeof GII_SCALPER_BRAIN.inheritFeedback === 'function') {
          try {
            var _brainHistory = GII_SCALPER_BRAIN.inheritFeedback(sym);
            if (_brainHistory && _brainHistory[bestDir]) {
              var _bh = _brainHistory[bestDir];
              if (_bh.total >= 5 && _bh.winRate < 0.45) {
                var _bfConf = sig.confidence;
                sig.confidence = Math.max(MIN_CONF, sig.confidence * 0.75);
                console.info('[GII SCALPER] Brain penalty: ' + sym + ' ' + bestDir + ' WR=' +
                  Math.round(_bh.winRate * 100) + '% (' + _bh.total + ' trades) → conf ' +
                  _bfConf.toFixed(2) + ' → ' + sig.confidence.toFixed(2));
              }
            }
          } catch (e) {}
        }

        // Add signal (replace any existing signal for this asset)
        _signals = _signals.filter(function (s) { return s.asset !== sym; });
        _signals.push(sig);
        _activeScalps[sym] = { asset: sym, bias: bestDir, signalTs: Date.now() };
        _status['note_' + sym] = 'Signal emitted: ' + bestDir.toUpperCase() + ' ' + sym + ' conf=' + sig.confidence;
        if (window.GII_SCALPER_BRAIN) {
          try { GII_SCALPER_BRAIN.noteSignal(sym, 'crypto', bestDir); } catch (e) {}
        }
        console.info('[GII SCALPER] Signal: ' + bestDir.toUpperCase() +
          ' ' + sym + ' conf=' + sig.confidence + ' lev=' + sig.leverage + 'x | ' + sig.reasoning);

        // ── EE portfolio integration ────────────────────────────────────────
        if (window.EE && typeof EE.onSignals === 'function') {
          try {
            EE.onSignals([{
              asset:           sig.asset,
              dir:             sig.bias === 'short' ? 'SHORT' : 'LONG',
              conf:            Math.round(sig.confidence * 100),
              reason:          'SCALPER: ' + sig.reasoning,
              region:          sig.region || 'GLOBAL',
              impactMult:      gtiM,
              atrStop:         sig.atrStop,
              atrTarget:       sig.atrTarget,
              matchedKeywords: sig.evidenceKeys || [],
              source:          'scalper',
              scalper:         true
            }]);
          } catch (eInner) {
            console.warn('[GII SCALPER] EE.onSignals() error: ' + (eInner.message || String(eInner)));
          }
        }
      })
      .catch(function (e) {
        _status['error_' + sym] = 'Poll error: ' + (e.message || String(e));
      });
  }

  function poll() {
    _lastPollTs = Date.now();
    _status.lastPoll = _lastPollTs;

    var gtiM    = _gtiSizeMult();
    var _gtiRaw = (window.GII && typeof GII.gti === 'function') ? GII.gti() : null;
    _status.gtiGated  = (gtiM === 0.0);
    _status.slotBusy  = SCALPER_ASSETS.some(function (s) { return !!_activeScalps[s]; });
    _status.gtiLevel  = (_gtiRaw && typeof _gtiRaw.value === 'number') ? +_gtiRaw.value.toFixed(1) : 0;

    if (gtiM === 0.0) {
      _signals  = [];
      _status.note = 'GTI=' + _status.gtiLevel + ' >= 90 — scalping stopped';
      return;
    }

    SCALPER_ASSETS.forEach(function (sym) { _pollAsset(sym, gtiM); });
  }

  // ── trade result feedback ─────────────────────────────────────────────────

  function onTradeResult(trade) {
    if (!trade) return;
    var asset = (trade.asset || trade.ticker || '').toUpperCase().replace('/USD', '').replace('-USD', '');
    if (SCALPER_ASSETS.indexOf(asset) === -1) return;

    // Clear active scalp for this asset
    _activeScalps[asset] = null;
    _signals = _signals.filter(function (s) { return s.asset !== asset; });

    var correct = (trade.pnl !== undefined ? trade.pnl : trade.profit || 0) > 0;
    var dir = (trade.dir || trade.direction || 'long').toLowerCase();
    var fbKey = asset + '_' + dir;

    if (!_feedback[fbKey]) _feedback[fbKey] = { total: 0, correct: 0, winRate: 0 };
    _feedback[fbKey].total++;
    if (correct) _feedback[fbKey].correct++;
    _feedback[fbKey].winRate = _feedback[fbKey].correct / _feedback[fbKey].total;
    _feedback[fbKey].lastTs  = new Date().toISOString();
    _saveFeedback();

    _accuracy = Object.assign({}, _feedback);
    console.info('[GII SCALPER] Trade result: ' + dir + ' ' + asset + ' ' + (correct ? 'WIN' : 'LOSS') +
      ' | winRate=' + (_feedback[fbKey].winRate * 100).toFixed(0) + '%');

    // Feed brain with cross-agent shared learning
    if (window.GII_SCALPER_BRAIN) {
      try {
        GII_SCALPER_BRAIN.recordOutcome(trade, { sector: 'crypto', setupType: _lastEntryType, gtiRegime: null });
        GII_SCALPER_BRAIN.clearSignal(asset);
      } catch (e) {}
    }
  }

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_AGENT_SCALPER = {
    poll:          poll,
    signals:       function () { return _signals.slice(); },
    status:        function () { return Object.assign({ lastPoll: _lastPollTs, activeScalps: _activeScalps }, _status); },
    accuracy:      function () { return Object.assign({}, _accuracy); },
    onTradeResult: onTradeResult,
    cache:         function () { return Object.assign({}, _cache); }
  };

  // ── init ──────────────────────────────────────────────────────────────────

  window.addEventListener('load', function () {
    _loadFeedback();
    _loadCache();
    // v61: re-sync slot with EE on load to prevent 2h blackout after page refresh
    setTimeout(function () {
      try {
        if (window.EE && typeof EE.getOpenTrades === 'function') {
          var _open = EE.getOpenTrades();
          SCALPER_ASSETS.forEach(function (sym) {
            var _existing = _open.find(function (t) {
              return (t.asset || '').toUpperCase() === sym;
            });
            if (_existing) {
              _activeScalps[sym] = { asset: sym, bias: _existing.direction.toLowerCase(), signalTs: Date.now(), entryType: 'unknown' };
              console.info('[SCALPER] _activeScalps[' + sym + '] restored from open trade');
            }
          });
        }
      } catch (e) {}
    }, 5000);
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL_MS);
    }, INIT_DELAY_MS);
  });

})();
