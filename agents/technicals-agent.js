/* HL Technicals Scanner — technicals-agent.js v2
 *
 * Runs RSI(14), MACD(12,26,9), and MA20 technical analysis on HL+Alpaca
 * assets using live HL price feed data and forwards signals to the EE.
 *
 * NOTE: This agent uses window.GII_AGENT_TA_SCANNER (not GII_AGENT_TECHNICALS)
 * to avoid colliding with gii-technicals.js which uses the same global name.
 *
 * Price data  : window.HLFeed (primary) + window.AlpacaBroker (secondary)
 * Output      : window.GII_AGENT_TA_SCANNER + feeds EE.onSignals()
 *
 * Timing:
 *   - Price samples collected every 60s into _priceHistory (max 60 = 1hr)
 *   - Analysis scan every 5 minutes, first run after 20s
 *
 * Scoring:
 *   1 indicator fires  → 45 pts
 *   2 indicators agree → 70 pts
 *   3 indicators agree → 88 pts
 *   GII alignment bonus → +10 pts
 *   Minimum score to emit → 60
 *
 * Cooldown: same asset+direction not re-emitted within 1.5 hours.
 *
 * Exposes: window.GII_AGENT_TA_SCANNER { status, signals, scan }
 */
(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var SCAN_MS          = 300000;   // 5-minute scan interval
  var FIRST_SCAN_MS    = 20000;    // first scan after 20s (let history build)
  var COLLECT_MS       = 60000;    // price sample every 60s
  var HISTORY_MAX      = 60;       // max samples per asset (60 × 1min = 1hr)
  var COOLDOWN_MS      = 5400000;  // 1.5 hours — no re-emit of same asset+direction
  var MIN_SCORE        = 60;       // minimum score to send to EE
  var MIN_RSI_SAMPLES  = 14;       // RSI requires at least 14 prices
  var MIN_MACD_SAMPLES = 26;       // MACD EMA-26 requires at least 26 prices
  var MIN_MA_SAMPLES   = 20;       // MA20 requires at least 20 prices

  // Static Alpaca asset list (these may not be in HLFeed coverage)
  var ALPACA_LIST = ['SOXX','XAR','GDX','XLE','XME','WEAT','CORN','INDA','LIT'];

  // OANDA instruments — forex, metals, energy, indices
  var OANDA_LIST = [
    'EUR_USD','GBP_USD','USD_JPY','USD_CHF','AUD_USD','USD_CAD','NZD_USD',
    'GBP_JPY','EUR_JPY','EUR_GBP',
    'XAU_USD','XAG_USD',
    'BCO_USD','WTICO_USD','NATGAS_USD',
    'SPX500_USD','NAS100_USD','UK100_GBP','GER40_EUR','JP225_USD'
  ];

  // Asset-class map — determines sector tag and RSI thresholds
  var ASSET_CLASS = {
    'BTC':'crypto',    'ETH':'crypto',    'SOL':'crypto',   'XRP':'crypto',
    'ADA':'crypto',    'BNB':'crypto',
    'SPY':'equity',    'QQQ':'equity',    'AAPL':'equity',  'MSFT':'equity',
    'GOOGL':'equity',  'AMZN':'equity',   'TSLA':'equity',  'META':'equity',
    'HOOD':'equity',   'CRCL':'equity',   'SOXX':'equity',  'XAR':'equity',
    'GDX':'metals',    'XLE':'energy',    'XME':'metals',
    'GLD':'metals',    'SLV':'metals',    'SILVER':'metals','XAG':'metals',
    'BRENT':'energy',  'BRENTOIL':'energy','OIL':'energy',  'CRUDE':'energy',
    'WTI':'energy',    'NATGAS':'energy', 'GAS':'energy',
    'WEAT':'agri',     'CORN':'agri',     'WHT':'agri',
    'INDA':'equity',   'LIT':'energy',
    // OANDA forex
    'EUR_USD':'fx',    'GBP_USD':'fx',    'USD_JPY':'fx',   'USD_CHF':'fx',
    'AUD_USD':'fx',    'USD_CAD':'fx',    'NZD_USD':'fx',
    'GBP_JPY':'fx',    'EUR_JPY':'fx',    'EUR_GBP':'fx',
    // OANDA metals
    'XAU_USD':'metals','XAG_USD':'metals',
    // OANDA energy
    'BCO_USD':'energy','WTICO_USD':'energy','NATGAS_USD':'energy',
    // OANDA indices
    'SPX500_USD':'equity','NAS100_USD':'equity','UK100_GBP':'equity',
    'GER40_EUR':'equity', 'JP225_USD':'equity'
  };

  // RSI overbought / oversold levels by sector group
  var RSI_THRESH = {
    crypto    : { os: 32, ob: 68 },
    equity    : { os: 35, ob: 65 },
    commodity : { os: 33, ob: 67 },  // covers energy / metals
    fx        : { os: 36, ob: 64 },  // forex — tighter range
    default   : { os: 35, ob: 65 }
  };

  // ── State ─────────────────────────────────────────────────────────────────

  var _priceHistory  = {};   // asset → [{price, ts}]
  var _signals       = [];   // active signals emitted this session
  var _cooldowns     = {};   // 'ASSET:LONG' or 'ASSET:SHORT' → expiry timestamp
  var _prevMA20Above = {};   // asset → bool: was price above MA20 last scan?

  var _status = {
    online        : false,
    lastScan      : null,
    scanCount     : 0,
    assetsScanned : 0,
    signalCount   : 0,
    note          : 'waiting — first scan in ~20s'
  };

  // ── Helpers ───────────────────────────────────────────────────────────────

  // Return the sector string for an asset
  function _sector(asset) {
    return ASSET_CLASS[asset] || 'equity';
  }

  // Return the RSI thresholds object for an asset
  function _rsiThresh(asset) {
    var sec = _sector(asset);
    if (sec === 'crypto')  return RSI_THRESH.crypto;
    if (sec === 'equity')  return RSI_THRESH.equity;
    if (sec === 'fx')      return RSI_THRESH.fx;
    if (sec === 'energy' || sec === 'metals' || sec === 'commodity') {
      return RSI_THRESH.commodity;
    }
    return RSI_THRESH.default;
  }

  // Collect a price sample for an asset (called every 60s)
  function _recordPrice(asset, price) {
    if (!_priceHistory[asset]) _priceHistory[asset] = [];
    _priceHistory[asset].push({ price: price, ts: Date.now() });
    if (_priceHistory[asset].length > HISTORY_MAX) {
      _priceHistory[asset].shift();
    }
  }

  // Extract a plain array of closing prices from history (oldest → newest)
  function _prices(asset) {
    var h = _priceHistory[asset];
    if (!h) return [];
    var out = [];
    for (var i = 0; i < h.length; i++) out.push(h[i].price);
    return out;
  }

  // Is this asset+direction on cooldown?
  function _onCooldown(asset, direction) {
    var key = asset + ':' + direction;
    var exp = _cooldowns[key];
    return exp && Date.now() < exp;
  }

  // Stamp a cooldown for this asset+direction
  function _stampCooldown(asset, direction) {
    _cooldowns[asset + ':' + direction] = Date.now() + COOLDOWN_MS;
  }

  // ── Indicator Calculations ────────────────────────────────────────────────

  /*
   * Wilder's RSI(14)
   * Returns a float 0–100, or null if not enough data.
   * Uses Wilder's smoothing: avgGain/Loss = (prevAvg * 13 + current) / 14
   */
  function _calcRSI(prices, period) {
    period = period || 14;
    if (prices.length < period + 1) return null;

    // Seed with simple average of first `period` changes
    var gains = 0, losses = 0;
    for (var i = 1; i <= period; i++) {
      var chg = prices[i] - prices[i - 1];
      if (chg >= 0) gains  += chg;
      else          losses += Math.abs(chg);
    }
    var avgGain = gains  / period;
    var avgLoss = losses / period;

    // Wilder smooth over remaining prices
    for (var j = period + 1; j < prices.length; j++) {
      var d = prices[j] - prices[j - 1];
      if (d >= 0) {
        avgGain = (avgGain * (period - 1) + d)    / period;
        avgLoss = (avgLoss * (period - 1) + 0)    / period;
      } else {
        avgGain = (avgGain * (period - 1) + 0)    / period;
        avgLoss = (avgLoss * (period - 1) + Math.abs(d)) / period;
      }
    }

    if (avgLoss === 0) return 100;
    var rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /*
   * Exponential Moving Average
   * Returns final EMA value for a price array and period.
   */
  function _ema(prices, period) {
    if (prices.length < period) return null;
    var k = 2 / (period + 1);
    // Seed with SMA of first `period` bars
    var seed = 0;
    for (var i = 0; i < period; i++) seed += prices[i];
    var ema = seed / period;
    for (var j = period; j < prices.length; j++) {
      ema = prices[j] * k + ema * (1 - k);
    }
    return ema;
  }

  /*
   * Returns an array of EMA values (one per price from index `period-1` onward).
   * Needed so we can track the signal line (EMA of MACD line).
   */
  function _emaArray(prices, period) {
    if (prices.length < period) return [];
    var k = 2 / (period + 1);
    var seed = 0;
    for (var i = 0; i < period; i++) seed += prices[i];
    var ema = seed / period;
    var out = [ema];
    for (var j = period; j < prices.length; j++) {
      ema = prices[j] * k + ema * (1 - k);
      out.push(ema);
    }
    return out;
  }

  /*
   * MACD(12, 26, 9)
   * Returns { macd, signal, histogram, crossBullish, crossBearish } or null.
   *
   * crossBullish = MACD line just crossed ABOVE signal line (between last two bars)
   * crossBearish = MACD line just crossed BELOW signal line
   */
  function _calcMACD(prices) {
    if (prices.length < MIN_MACD_SAMPLES) return null;

    // EMA-12 and EMA-26 arrays (aligned from index 25 onward)
    var ema12 = _emaArray(prices, 12);  // starts at prices[11]
    var ema26 = _emaArray(prices, 26);  // starts at prices[25]

    // MACD line = EMA12 − EMA26, aligned to ema26 length
    // ema12 is longer; trim its start to align with ema26
    var offset = ema12.length - ema26.length;
    var macdLine = [];
    for (var i = 0; i < ema26.length; i++) {
      macdLine.push(ema12[i + offset] - ema26[i]);
    }

    // Signal line = EMA9 of MACD line
    if (macdLine.length < 9) return null;
    var sigLine = _emaArray(macdLine, 9);

    if (sigLine.length < 2) return null;

    var macdNow  = macdLine[macdLine.length - 1];
    var macdPrev = macdLine[macdLine.length - 2];
    var sigNow   = sigLine[sigLine.length - 1];
    var sigPrev  = sigLine[sigLine.length - 2];

    return {
      macd         : macdNow,
      signal       : sigNow,
      histogram    : macdNow - sigNow,
      crossBullish : (macdPrev <= sigPrev) && (macdNow > sigNow),
      crossBearish : (macdPrev >= sigPrev) && (macdNow < sigNow)
    };
  }

  /*
   * Simple Moving Average of last `period` prices.
   */
  function _sma(prices, period) {
    if (prices.length < period) return null;
    var slice = prices.slice(prices.length - period);
    var sum = 0;
    for (var i = 0; i < slice.length; i++) sum += slice[i];
    return sum / period;
  }

  // ── Scoring ───────────────────────────────────────────────────────────────

  /*
   * Confidence mapping from composite score.
   */
  function _confidence(score) {
    if (score >= 90) return 0.88;
    if (score >= 80) return 0.80;
    if (score >= 70) return 0.72;
    return 0.65;
  }

  /*
   * Check if GII has a matching signal for asset+direction.
   * Returns true if found.
   */
  function _giiAligned(asset, direction) {
    if (!window.GII || typeof GII.signals !== 'function') return false;
    var sigs = GII.signals();
    if (!Array.isArray(sigs)) return false;
    for (var i = 0; i < sigs.length; i++) {
      var s = sigs[i];
      if (s.asset === asset && s.bias === direction) return true;
    }
    return false;
  }

  // ── Asset list ────────────────────────────────────────────────────────────

  /*
   * Build the full list of assets to scan this cycle.
   * Combines HLFeed.coverage() + Alpaca list (if connected).
   * Deduplicates by asset name.
   */
  function _buildAssetList() {
    var seen = {};
    var list = [];

    // HLFeed assets
    if (window.HLFeed && typeof HLFeed.coverage === 'function') {
      var hlAssets = HLFeed.coverage();
      for (var i = 0; i < hlAssets.length; i++) {
        var a = hlAssets[i];
        if (!seen[a] && HLFeed.isAvailable(a)) {
          seen[a] = true;
          list.push(a);
        }
      }
    }

    // Alpaca assets (if broker connected)
    if (window.AlpacaBroker &&
        typeof AlpacaBroker.status === 'function' &&
        typeof AlpacaBroker.covers === 'function') {
      var st = AlpacaBroker.status();
      if (st && st.connected) {
        for (var j = 0; j < ALPACA_LIST.length; j++) {
          var asset = ALPACA_LIST[j];
          if (!seen[asset] && AlpacaBroker.covers(asset)) {
            seen[asset] = true;
            list.push(asset);
          }
        }
      }
    }

    // OANDA assets — forex, metals, energy, indices (if connected)
    if (window.OANDA_RATES && typeof OANDA_RATES.isConnected === 'function' &&
        OANDA_RATES.isConnected()) {
      for (var k = 0; k < OANDA_LIST.length; k++) {
        var oa = OANDA_LIST[k];
        if (!seen[oa]) {
          seen[oa] = true;
          list.push(oa);
        }
      }
    }

    return list;
  }

  // ── Price Collector (every 60s) ───────────────────────────────────────────

  /*
   * Runs every 60 seconds. Grabs the current price for every asset
   * in the tradeable universe and appends it to _priceHistory.
   */
  function _collectPrices() {
    var list = _buildAssetList();
    for (var i = 0; i < list.length; i++) {
      var asset = list[i];
      var price = null;

      // Try HLFeed first
      if (window.HLFeed && typeof HLFeed.getPrice === 'function') {
        var pd = HLFeed.getPrice(asset);
        if (pd && pd.price) price = pd.price;
      }

      // Fallback: AlpacaBroker.getPrice if available
      if (!price && window.AlpacaBroker && typeof AlpacaBroker.getPrice === 'function') {
        var ap = AlpacaBroker.getPrice(asset);
        if (ap) price = ap;
      }

      // Fallback: OANDA_RATES for forex, metals, energy, indices
      if (!price && window.OANDA_RATES && OANDA_RATES.isConnected()) {
        var or = OANDA_RATES.getRate(asset);
        if (or && or.mid) price = or.mid;
      }

      if (price) _recordPrice(asset, price);
    }
  }

  // ── Scan ──────────────────────────────────────────────────────────────────

  /*
   * Main analysis scan. Runs every 5 minutes.
   * For each asset with enough price history:
   *   1. Compute RSI(14), MACD(12,26,9), MA20 cross
   *   2. Count how many indicators agree on a direction
   *   3. Score, apply GII bonus, check cooldown, emit to EE
   */
  function _scan() {
    _status.scanCount++;
    _status.lastScan = Date.now();
    _status.online   = true;

    var list = _buildAssetList();
    _status.assetsScanned = list.length;

    var newSignals = [];

    for (var i = 0; i < list.length; i++) {
      var asset  = list[i];
      var prices = _prices(asset);

      // Need at least enough data for MACD (26) to run any useful analysis
      // Individual indicators still gate themselves below
      if (prices.length < MIN_RSI_SAMPLES) continue;

      var longVotes  = 0;
      var shortVotes = 0;
      var reasons    = [];

      // ── RSI(14) ─────────────────────────────────────────────────────────
      if (prices.length >= MIN_RSI_SAMPLES) {
        var rsi    = _calcRSI(prices, 14);
        var thresh = _rsiThresh(asset);

        if (rsi !== null) {
          if (rsi < thresh.os) {
            longVotes++;
            reasons.push('RSI(14) oversold at ' + Math.round(rsi));
          } else if (rsi > thresh.ob) {
            shortVotes++;
            reasons.push('RSI(14) overbought at ' + Math.round(rsi));
          }
        }
      }

      // ── MACD(12,26,9) ───────────────────────────────────────────────────
      if (prices.length >= MIN_MACD_SAMPLES) {
        var macd = _calcMACD(prices);
        if (macd) {
          if (macd.crossBullish) {
            longVotes++;
            reasons.push('MACD bullish cross');
          } else if (macd.crossBearish) {
            shortVotes++;
            reasons.push('MACD bearish cross');
          }
        }
      }

      // ── MA20 crossover ──────────────────────────────────────────────────
      // Signal only on the crossover itself, not if already above/below
      if (prices.length >= MIN_MA_SAMPLES) {
        var ma20    = _sma(prices, 20);
        var curPx   = prices[prices.length - 1];
        var aboveNow = curPx > ma20;
        var prevAbove = _prevMA20Above[asset]; // undefined on first scan → skip

        if (prevAbove !== undefined) {
          if (!prevAbove && aboveNow) {
            // Price just crossed above MA20
            longVotes++;
            reasons.push('price crossed above 20MA at ' + (ma20 ? ma20.toFixed(2) : '?'));
          } else if (prevAbove && !aboveNow) {
            // Price just crossed below MA20
            shortVotes++;
            reasons.push('price crossed below 20MA at ' + (ma20 ? ma20.toFixed(2) : '?'));
          }
        }

        // Record state for next scan
        _prevMA20Above[asset] = aboveNow;
      }

      // ── Determine direction ──────────────────────────────────────────────
      var direction = null;
      var agreeCount = 0;

      if (longVotes > shortVotes && longVotes > 0) {
        direction  = 'LONG';
        agreeCount = longVotes;
      } else if (shortVotes > longVotes && shortVotes > 0) {
        direction  = 'SHORT';
        agreeCount = shortVotes;
      }

      if (!direction) continue; // no agreement

      // ── Score ────────────────────────────────────────────────────────────
      var score = 0;
      if (agreeCount === 1) score = 45;
      else if (agreeCount === 2) score = 70;
      else if (agreeCount >= 3) score = 88;

      // GII bonus
      if (_giiAligned(asset, direction)) {
        score += 10;
        reasons.push('GII aligned');
      }

      if (score < MIN_SCORE) continue;

      // ── Cooldown check ────────────────────────────────────────────────────
      if (_onCooldown(asset, direction)) continue;

      // ── Build and emit signal ─────────────────────────────────────────────
      var signal = {
        source       : 'technicals',
        asset        : asset,
        bias         : direction,
        confidence   : _confidence(score),
        reasoning    : reasons.join(' · '),
        region       : 'GLOBAL',
        sector       : _sector(asset),
        evidenceKeys : ['rsi', _sector(asset)],
        timestamp    : Date.now()
      };

      newSignals.push(signal);
      _stampCooldown(asset, direction);

      console.log('[TA] Signal: ' + asset + ' ' + direction +
        ' score=' + score + ' conf=' + signal.confidence +
        ' · ' + signal.reasoning);
    }

    // ── Send to Execution Engine ──────────────────────────────────────────
    if (newSignals.length && window.EE && typeof EE.onSignals === 'function') {
      try {
        EE.onSignals(newSignals);
      } catch (e) {
        console.warn('[TA] EE.onSignals error:', e);
      }
    }

    // Prepend new signals to the running list (most recent first)
    for (var k = 0; k < newSignals.length; k++) {
      _signals.unshift(newSignals[k]);
    }
    // Keep a reasonable cap on stored signals (session memory)
    if (_signals.length > 200) _signals = _signals.slice(0, 200);

    _status.signalCount += newSignals.length;
    _status.note = _status.scanCount + ' scans · ' +
                   _status.signalCount + ' signals sent';

    console.log('[TA] Scan #' + _status.scanCount + ': ' + list.length +
      ' assets · ' + newSignals.length + ' new signals');
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function _init() {
    console.log('[TA] Technicals Agent starting up');

    // Price collector — every 60s, starts immediately so history builds fast
    _collectPrices();
    setInterval(_collectPrices, COLLECT_MS);

    // First scan after 20s, then every 5 minutes
    setTimeout(function () {
      _scan();
      setInterval(_scan, SCAN_MS);
    }, FIRST_SCAN_MS);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.GII_AGENT_TA_SCANNER = {

    /*
     * Returns a status summary object.
     * lastPoll is an alias for lastScan (used by the agent status table).
     */
    status: function () {
      return {
        online        : _status.online,
        lastScan      : _status.lastScan,
        lastPoll      : _status.lastScan,
        scanCount     : _status.scanCount,
        assetsScanned : _status.assetsScanned,
        signalCount   : _status.signalCount,
        note          : _status.note
      };
    },

    /*
     * Returns a copy of all signals emitted this session (most recent first).
     */
    signals: function () {
      return _signals.slice();
    },

    /*
     * Force a scan immediately (bypasses the 5-min timer).
     */
    scan: function () {
      _scan();
    }
  };

  window.addEventListener('load', _init);

})();
