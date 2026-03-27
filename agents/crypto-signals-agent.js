/* Crypto Signals Agent — crypto-signals-agent.js v1
 *
 * Generates crypto-specific trading signals from three sources:
 *   1. Funding Rate    — Hyperliquid REST API (POST /info, type:"metaAndAssetCtxs")
 *                        Extreme funding → contrarian squeeze signal
 *   2. BTC Dominance   — Derived from HLFeed prices; shift >3% in 1h fires signal
 *   3. Volatility Spike — 5-min price range vs. rolling 12-period average from HLFeed
 *
 * Signal format: EE.onSignals([{ source, asset, bias, confidence, reasoning,
 *                                region, sector, evidenceKeys, timestamp }])
 *
 * Exposes: window.GII_AGENT_CRYPTO_SIGNALS
 *   .status()   — { lastPoll, online, fundingFetched, signalCount, note }
 *   .signals()  — current active signals array
 *   .scan()     — force an immediate scan
 *
 * Scan interval : 10 minutes (first scan after 30s)
 * Cooldown      : 3 hours per asset+direction
 * Data collected: price samples every 60s; funding fetched every 10min
 */
(function () {
  'use strict';

  // ── constants ─────────────────────────────────────────────────────────────

  var SCAN_MS            = 600000;          // 10-minute main scan cycle
  var INIT_DELAY_MS      = 30000;           // first scan after 30s (let HL warm up)
  var PRICE_SAMPLE_MS    = 60000;           // collect a price sample every 60s
  var FUNDING_REFRESH_MS = 600000;          // re-fetch funding every 10 minutes
  var FNG_REFRESH_MS     = 1800000;         // re-fetch Fear & Greed every 30 minutes
  var MAX_PRICE_SAMPLES  = 30;             // rolling window depth per asset
  var COOLDOWN_MS        = 90 * 60 * 1000;      // 1.5-hour cooldown per asset+direction
  var HL_INFO_URL        = 'https://api.hyperliquid.xyz/info';
  var FNG_URL            = 'https://api.alternative.me/fng/?limit=1';

  // Assets eligible for each signal type
  var FUNDING_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'BNB'];
  var VOLUME_ASSETS  = ['BTC', 'ETH', 'SOL', 'XRP'];
  var DOM_ASSETS     = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'];  // used for dominance calc

  // Rough market-cap multipliers used in dominance estimate
  // BTC_dom = BTC / (BTC + ETH*15 + SOL*100 + BNB*3 + XRP*50000)
  var DOM_WEIGHTS = { BTC: 1, ETH: 15, SOL: 100, BNB: 3, XRP: 50000 };

  // Funding signal thresholds
  var FUNDING_THR_LOW  = 0.0004;   // |rate| > 0.04%  → conf 0.68
  var FUNDING_THR_HIGH = 0.0008;   // |rate| > 0.08%  → conf 0.75

  // BTC dominance thresholds
  var DOM_RISK_OFF  = 0.65;   // BTC dominant → risk-off
  var DOM_ALT_SEASON = 0.50;  // alts dominant → alt season
  var DOM_SHIFT_THR = 0.03;   // must shift >3% vs. 1h-ago snapshot to fire

  // Volatility spike: current 5-min range must exceed 3× rolling average
  var VOL_SPIKE_MULTI = 3.0;

  // ── private state ─────────────────────────────────────────────────────────

  var _signals      = [];    // currently active/emitted signals this session
  var _cooldowns    = {};    // 'ASSET:BIAS' → timestamp of last signal
  var _priceHistory = {};    // asset → [{price, ts}]  (60s samples)
  var _fundingCache = {};    // asset → {rate, ts}
  var _domHistory   = [];    // [{dominance, ts}]  (one entry per scan)
  var _lastFundingFetch = 0;
  var _lastPoll     = 0;
  var _fundingFetched = false;
  var _signalCount  = 0;
  var _online       = false;
  var _fngValue          = null;   // latest Fear & Greed numeric value (0–100)
  var _fngClassification = null;   // latest classification string

  // ── cooldown helpers ──────────────────────────────────────────────────────

  function _onCooldown(asset, bias) {
    var key = asset + ':' + bias;
    var last = _cooldowns[key];
    return last && (Date.now() - last) < COOLDOWN_MS;
  }

  function _setCooldown(asset, bias) {
    _cooldowns[asset + ':' + bias] = Date.now();
  }

  // ── price sample collection ───────────────────────────────────────────────

  function _recordPrice(asset) {
    if (!window.HLFeed) return;
    var pd = HLFeed.getPrice(asset);
    if (!pd || !pd.price) return;

    if (!_priceHistory[asset]) _priceHistory[asset] = [];
    _priceHistory[asset].push({ price: pd.price, ts: Date.now() });

    // Cap at MAX_PRICE_SAMPLES (oldest first)
    if (_priceHistory[asset].length > MAX_PRICE_SAMPLES) {
      _priceHistory[asset].shift();
    }
  }

  function _collectAllPrices() {
    // Collect for all unique assets we care about
    var all = FUNDING_ASSETS.concat(VOLUME_ASSETS).concat(DOM_ASSETS);
    var seen = {};
    for (var i = 0; i < all.length; i++) {
      if (!seen[all[i]]) {
        seen[all[i]] = true;
        _recordPrice(all[i]);
      }
    }
  }

  // Return current price for an asset from HLFeed
  function _price(asset) {
    if (!window.HLFeed) return null;
    var pd = HLFeed.getPrice(asset);
    return (pd && pd.price) ? pd.price : null;
  }

  // ── funding rate fetch ────────────────────────────────────────────────────

  function _fetchFunding(callback) {
    fetch(HL_INFO_URL, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ type: 'metaAndAssetCtxs' })
    })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      // Response is an array: [metaInfo, assetCtxsArray]
      // metaInfo.universe is an array of {name, ...}
      // assetCtxsArray[i] corresponds to metaInfo.universe[i]
      if (!Array.isArray(data) || data.length < 2) {
        throw new Error('Unexpected response shape');
      }
      var meta   = data[0];          // { universe: [{name, ...}] }
      var ctxs   = data[1];          // [{fundingRate, openInterest, ...}]
      var names  = (meta && meta.universe) ? meta.universe : [];

      var now = Date.now();
      for (var i = 0; i < names.length; i++) {
        var name = names[i] && names[i].name ? names[i].name.toUpperCase() : null;
        if (!name) continue;
        var ctx = ctxs[i];
        if (!ctx) continue;
        var rate = parseFloat(ctx.fundingRate);
        if (isNaN(rate)) continue;
        _fundingCache[name] = { rate: rate, ts: now };
      }

      _lastFundingFetch = now;
      _fundingFetched   = true;
      console.log('[CryptoSig] Funding cache updated for ' + Object.keys(_fundingCache).length + ' assets');
      if (callback) callback(null);
    })
    .catch(function (err) {
      console.warn('[CryptoSig] Funding fetch failed — skipping funding signals:', err.message);
      if (callback) callback(err);
    });
  }

  // ── Fear & Greed fetch ────────────────────────────────────────────────────

  function _fetchFearAndGreed() {
    fetch(FNG_URL)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.data) || !data.data[0]) {
          throw new Error('Unexpected F&G response shape');
        }
        var entry = data.data[0];
        var val   = parseInt(entry.value, 10);
        if (isNaN(val)) throw new Error('F&G value is not a number');
        _fngValue          = val;
        _fngClassification = entry.value_classification || '';
        console.log('[CryptoSig] Fear & Greed updated: ' + _fngValue + ' (' + _fngClassification + ')');
      })
      .catch(function (err) {
        console.warn('[CryptoSig] Fear & Greed fetch failed:', err.message);
      });
  }

  // ── Signal 4: Fear & Greed Index ──────────────────────────────────────────

  function _fearAndGreedSignals() {
    var out = [];
    if (_fngValue === null) return out;

    var val    = _fngValue;
    var cls    = _fngClassification;
    var assets, bias, conf, dirNote;

    if (val <= 20) {
      // Extreme Fear → contrarian LONG
      assets  = ['BTC', 'ETH', 'SOL'];
      bias    = 'LONG';
      conf    = 72;
      dirNote = 'Extreme Fear implies capitulation — long bias';
    } else if (val <= 35) {
      // Fear → LONG
      assets  = ['BTC', 'ETH'];
      bias    = 'LONG';
      conf    = 67;
      dirNote = 'Fear implies oversold conditions — long bias';
    } else if (val <= 64) {
      // Neutral — no signal
      return out;
    } else if (val <= 80) {
      // Greed → SHORT
      assets  = ['BTC', 'ETH'];
      bias    = 'SHORT';
      conf    = 67;
      dirNote = 'Greed implies overextension — short bias';
    } else {
      // Extreme Greed → SHORT
      assets  = ['BTC', 'ETH', 'SOL'];
      bias    = 'SHORT';
      conf    = 73;
      dirNote = 'Extreme Greed implies euphoria — short bias';
    }

    var reasoning = 'Fear & Greed: ' + val + ' (' + cls + ') \u2014 ' + dirNote;

    for (var i = 0; i < assets.length; i++) {
      var asset = assets[i];
      if (_onCooldown(asset, bias)) continue;
      if (window.HLFeed && !HLFeed.isAvailable(asset)) continue;

      out.push({
        source       : 'crypto-signals',
        asset        : asset,
        bias         : bias,
        confidence   : conf,
        reasoning    : reasoning,
        region       : 'GLOBAL',
        sector       : 'crypto',
        evidenceKeys : ['fear-greed', 'sentiment', 'crypto'],
        _signalType  : 'FEAR_GREED',
        timestamp    : Date.now()
      });
    }
    return out;
  }

  // ── Signal 1: Funding Rate ────────────────────────────────────────────────

  function _fundingSignals() {
    var out = [];
    if (!_fundingFetched) return out;

    for (var i = 0; i < FUNDING_ASSETS.length; i++) {
      var asset = FUNDING_ASSETS[i];
      var fd    = _fundingCache[asset];
      if (!fd) continue;

      var rate = fd.rate;
      var abs  = Math.abs(rate);

      // Only trigger if rate is above threshold
      if (abs < FUNDING_THR_LOW) continue;

      // Contrarian logic:
      //   HIGH positive funding → market heavily long → squeeze DOWN → SHORT signal
      //   HIGH negative funding → market heavily short → squeeze UP  → LONG signal
      var bias = rate > 0 ? 'SHORT' : 'LONG';

      if (_onCooldown(asset, bias)) continue;

      // Tradeable check
      if (window.HLFeed && !HLFeed.isAvailable(asset)) continue;

      var conf = abs >= FUNDING_THR_HIGH ? 75 : 68;
      var ratePct = (rate * 100).toFixed(4);
      var reasoning;

      if (bias === 'SHORT') {
        reasoning = 'Funding rate extreme: +' + ratePct + '% (longs paying) \u2192 long squeeze likely \u2192 short bias';
      } else {
        reasoning = 'Funding rate extreme: ' + ratePct + '% (shorts paying) \u2192 short squeeze likely \u2192 long bias';
      }

      out.push({
        source       : 'crypto-signals',
        asset        : asset,
        bias         : bias,
        confidence   : conf,
        reasoning    : reasoning,
        region       : 'GLOBAL',
        sector       : 'crypto',
        evidenceKeys : ['funding', 'crypto'],
        _signalType  : 'FUNDING',
        timestamp    : Date.now()
      });
    }
    return out;
  }

  // ── Signal 2: BTC Dominance ───────────────────────────────────────────────

  function _calcDominance() {
    // Requires prices for all DOM_ASSETS
    var prices = {};
    for (var i = 0; i < DOM_ASSETS.length; i++) {
      var p = _price(DOM_ASSETS[i]);
      if (!p) return null;
      prices[DOM_ASSETS[i]] = p;
    }

    // Rough market-cap proxy: each asset × its multiplier
    var total = 0;
    for (var asset in DOM_WEIGHTS) {
      if (DOM_WEIGHTS.hasOwnProperty(asset)) {
        total += (prices[asset] || 0) * DOM_WEIGHTS[asset];
      }
    }
    if (!total) return null;
    return (prices['BTC'] * DOM_WEIGHTS['BTC']) / total;
  }

  function _dominanceSignals() {
    var out = [];
    var dom = _calcDominance();
    if (dom === null) return out;

    var now = Date.now();

    // Record dominance for drift tracking (max 60 entries = ~10h at 10min intervals)
    _domHistory.push({ dominance: dom, ts: now });
    if (_domHistory.length > 60) _domHistory.shift();

    // Need at least 2 entries, and the oldest within the 1-hour window
    if (_domHistory.length < 2) return out;
    var oneHourAgo = now - 3600000;
    var prev = null;
    for (var i = 0; i < _domHistory.length - 1; i++) {
      if (_domHistory[i].ts >= oneHourAgo) {
        prev = _domHistory[i];
        break;
      }
    }
    if (!prev) return out;  // no sample within 1h window yet

    var shift = Math.abs(dom - prev.dominance);
    if (shift < DOM_SHIFT_THR) return out;  // shift not large enough

    var conf = 65;

    if (dom > DOM_RISK_OFF) {
      // BTC dominance very high — risk-off, prefer BTC long over alts
      if (!_onCooldown('BTC', 'LONG') && (!window.HLFeed || HLFeed.isAvailable('BTC'))) {
        out.push({
          source       : 'crypto-signals',
          asset        : 'BTC',
          bias         : 'LONG',
          confidence   : conf,
          reasoning    : 'BTC dominance high (' + (dom * 100).toFixed(1) + '%) \u2192 risk-off rotation into BTC; shifted ' + (shift * 100).toFixed(1) + '% in 1h',
          region       : 'GLOBAL',
          sector       : 'crypto',
          evidenceKeys : ['dominance', 'crypto'],
          _signalType  : 'DOMINANCE',
          timestamp    : now
        });
      }
    } else if (dom < DOM_ALT_SEASON) {
      // Alt season: ETH and SOL get long signals
      var altTargets = ['ETH', 'SOL'];
      for (var j = 0; j < altTargets.length; j++) {
        var alt = altTargets[j];
        if (_onCooldown(alt, 'LONG')) continue;
        if (window.HLFeed && !HLFeed.isAvailable(alt)) continue;
        out.push({
          source       : 'crypto-signals',
          asset        : alt,
          bias         : 'LONG',
          confidence   : conf,
          reasoning    : 'BTC dominance low (' + (dom * 100).toFixed(1) + '%) \u2192 alt season; ' + alt + ' LONG favoured; shifted ' + (shift * 100).toFixed(1) + '% in 1h',
          region       : 'GLOBAL',
          sector       : 'crypto',
          evidenceKeys : ['dominance', 'crypto'],
          _signalType  : 'DOMINANCE',
          timestamp    : now
        });
      }
    }

    return out;
  }

  // ── Signal 3: Volatility Spike ────────────────────────────────────────────

  // Compute the 5-min range (as % of price) for a given price history slice
  function _range5m(samples) {
    if (!samples || samples.length < 2) return null;
    var prices = [];
    for (var i = 0; i < samples.length; i++) { prices.push(samples[i].price); }
    var hi = Math.max.apply(null, prices);
    var lo = Math.min.apply(null, prices);
    return lo ? (hi - lo) / lo : null;
  }

  // Split history into 5-min buckets (5 samples at 60s intervals)
  function _buckets5m(asset) {
    var h = _priceHistory[asset];
    if (!h || h.length < 10) return [];  // need at least 2 full buckets
    var buckets = [];
    var bucketSize = 5;  // 5 samples × 60s = 5min
    // Walk backwards from the most recent sample in fixed-size windows
    for (var i = h.length; i >= bucketSize; i -= bucketSize) {
      buckets.unshift(h.slice(i - bucketSize, i));
    }
    return buckets;
  }

  function _volatilitySignals() {
    var out = [];
    var now = Date.now();

    for (var i = 0; i < VOLUME_ASSETS.length; i++) {
      var asset  = VOLUME_ASSETS[i];
      var bkts   = _buckets5m(asset);
      if (bkts.length < 2) continue;  // need current + at least 1 historical bucket

      // Current bucket = the last one; historical = all previous
      var curBucket  = bkts[bkts.length - 1];
      var histBuckets = bkts.slice(0, bkts.length - 1);
      // Limit history to last 12 periods as specified
      if (histBuckets.length > 12) histBuckets = histBuckets.slice(histBuckets.length - 12);

      var curRange  = _range5m(curBucket);
      if (curRange === null) continue;

      // Average range across historical buckets
      var totalRange = 0;
      var validCount = 0;
      for (var j = 0; j < histBuckets.length; j++) {
        var r = _range5m(histBuckets[j]);
        if (r !== null) { totalRange += r; validCount++; }
      }
      if (!validCount) continue;
      var avgRange = totalRange / validCount;
      if (!avgRange) continue;

      var ratio = curRange / avgRange;
      if (ratio < VOL_SPIKE_MULTI) continue;  // not a spike

      // Direction: compare first and last price in the current bucket
      var firstPx = curBucket[0].price;
      var lastPx  = curBucket[curBucket.length - 1].price;
      var bias    = lastPx >= firstPx ? 'LONG' : 'SHORT';

      if (_onCooldown(asset, bias)) continue;
      if (window.HLFeed && !HLFeed.isAvailable(asset)) continue;

      var spikeRatio = ratio.toFixed(1);
      var rangePct   = (curRange * 100).toFixed(3);

      out.push({
        source       : 'crypto-signals',
        asset        : asset,
        bias         : bias,
        confidence   : 67,
        reasoning    : 'Volatility spike: 5-min range ' + rangePct + '% is ' + spikeRatio + '\u00d7 avg \u2192 trade direction of spike (' + bias + ')',
        region       : 'GLOBAL',
        sector       : 'crypto',
        evidenceKeys : ['volatility', 'crypto'],
        _signalType  : 'VOLATILITY',
        timestamp    : now
      });
    }
    return out;
  }

  // ── main scan ─────────────────────────────────────────────────────────────

  function _runScan() {
    _lastPoll = Date.now();
    _online   = true;

    var allSignals = [];

    // 1. Funding rate signals (from cache; refresh is handled by polling timer)
    var fundingSigs = _fundingSignals();
    allSignals = allSignals.concat(fundingSigs);

    // 2. BTC dominance signals
    var domSigs = _dominanceSignals();
    allSignals = allSignals.concat(domSigs);

    // 3. Volatility spike signals
    var volSigs = _volatilitySignals();
    allSignals = allSignals.concat(volSigs);

    // 4. Fear & Greed Index signals
    var fngSigs = _fearAndGreedSignals();
    allSignals = allSignals.concat(fngSigs);

    if (!allSignals.length) {
      console.log('[CryptoSig] Scan complete — no signals triggered');
      return;
    }

    // Apply cooldowns and set them for any signals we're emitting
    var toEmit = [];
    for (var i = 0; i < allSignals.length; i++) {
      var sig = allSignals[i];
      // _onCooldown was already checked inside each generator, but double-check here
      // in case two signal types produce the same asset+bias in one cycle
      if (_onCooldown(sig.asset, sig.bias)) continue;
      _setCooldown(sig.asset, sig.bias);
      toEmit.push(sig);
    }

    if (!toEmit.length) {
      console.log('[CryptoSig] All candidates on cooldown — nothing emitted');
      return;
    }

    // Store in _signals (append; cap to last 50 for session memory)
    for (var j = 0; j < toEmit.length; j++) {
      _signals.push(toEmit[j]);
    }
    if (_signals.length > 50) _signals = _signals.slice(_signals.length - 50);

    _signalCount += toEmit.length;

    // Strip internal _signalType before handing to EE
    var eePayload = toEmit.map(function (s) {
      return {
        source       : s.source,
        asset        : s.asset,
        bias         : s.bias,
        confidence   : s.confidence,
        reasoning    : s.reasoning,
        region       : s.region,
        sector       : s.sector,
        evidenceKeys : s.evidenceKeys,
        timestamp    : s.timestamp
      };
    });

    if (window.EE && typeof EE.onSignals === 'function') {
      try {
        EE.onSignals(eePayload);
      } catch (e) {
        console.warn('[CryptoSig] EE.onSignals error:', e);
      }
    }

    var types = toEmit.map(function (s) { return s._signalType + ':' + s.asset; }).join(', ');
    console.log('[CryptoSig] Emitted ' + toEmit.length + ' signal(s): ' + types);
  }

  // Outer scan: refresh funding if needed, then run analysis
  function _scan() {
    var now = Date.now();

    // Collect fresh price samples before analysis
    _collectAllPrices();

    // Refresh funding cache if stale (first scan or every 10min)
    if (!_fundingFetched || (now - _lastFundingFetch) >= FUNDING_REFRESH_MS) {
      _fetchFunding(function (err) {
        // Whether fetch succeeded or failed, continue with scan
        // (funding signals will be skipped if _fundingFetched is false)
        _runScan();
      });
    } else {
      _runScan();
    }
  }

  // ── init ──────────────────────────────────────────────────────────────────

  function _init() {
    // Start the 60-second price sample collector immediately
    setInterval(_collectAllPrices, PRICE_SAMPLE_MS);

    // Fetch Fear & Greed immediately and every 30 minutes
    _fetchFearAndGreed();
    setInterval(_fetchFearAndGreed, FNG_REFRESH_MS);

    // First scan after 30s (allow HLFeed WebSocket to warm up)
    setTimeout(function () {
      _scan();
      setInterval(_scan, SCAN_MS);
    }, INIT_DELAY_MS);

    console.log('[CryptoSig] Agent initialised — first scan in 30s');
  }

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_AGENT_CRYPTO_SIGNALS = {

    status: function () {
      var activeCooldowns = 0;
      var now = Date.now();
      for (var key in _cooldowns) {
        if (_cooldowns.hasOwnProperty(key)) {
          if ((now - _cooldowns[key]) < COOLDOWN_MS) activeCooldowns++;
        }
      }
      var fngNote = (_fngValue !== null)
        ? 'F&G: ' + _fngValue + ' (' + _fngClassification + ')'
        : null;
      var onlineNote = _signalCount + ' signal(s) emitted · ' + activeCooldowns + ' cooldown(s) active';
      var note = _online
        ? (fngNote ? fngNote + ' · ' + onlineNote : onlineNote)
        : 'warming up — first scan in ~30s';

      return {
        lastPoll          : _lastPoll,
        online            : _online,
        fundingFetched    : _fundingFetched,
        fngValue          : _fngValue,
        fngClassification : _fngClassification,
        signalCount       : _signalCount,
        note              : note
      };
    },

    signals: function () {
      return _signals.slice();
    },

    scan: function () {
      console.log('[CryptoSig] Manual scan triggered');
      _scan();
    }

  };

  window.addEventListener('load', _init);

})();
