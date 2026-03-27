/* Momentum Agent — momentum-agent.js v1
 *
 * Identifies assets in strong, sustained trends across three timeframes
 * (1h / 4h / 24h) and forwards momentum-following signals to the Execution Engine.
 *
 * All three timeframes must agree on direction AND each must clear its class-specific
 * threshold before a signal is generated. An anti-chasing filter suppresses blow-off
 * spikes that exceed 3× the expected hourly rate.
 *
 * Data collection : HLFeed.getPrice() sampled every 5 minutes, up to 300 samples (≈25h)
 * Scan interval   : every 15 minutes (first scan 60s after load)
 * Cooldown        : 6 hours per asset + direction
 *
 * GII alignment check (optional +10 pts) pulls signals from any window.GII_AGENT_*
 * that exposes a signals() method.
 *
 * Exposes: window.GII_AGENT_MOMENTUM
 */
(function () {
  'use strict';

  // ── constants ─────────────────────────────────────────────────────────────

  var SAMPLE_MS      = 5  * 60 * 1000;   // collect price every 5 minutes
  var SCAN_MS        = 15 * 60 * 1000;   // scan every 15 minutes
  var INIT_DELAY_MS  = 60 * 1000;        // first scan after 60s (need price history)
  var MAX_SAMPLES    = 300;              // ≈25 hours of 5-min samples
  var MIN_SAMPLES    = 50;              // ≈4h — skip asset if fewer samples exist
  var COOLDOWN_MS    = 2 * 60 * 60 * 1000;  // 2h cooldown per asset+direction

  // Sample index lookbacks (based on 5-min samples)
  var IDX_1H  = 12;   // 12 × 5min = 1h
  var IDX_4H  = 48;   // 48 × 5min = 4h
  // 24h uses the oldest available sample (if >24h of data exists)

  // Anti-chasing: if 1h move > N × implied hourly rate from longer timeframes, skip
  var CHASE_MULTIPLIER = 3;

  // Asset-class map — which sector does each ticker belong to
  var ASSET_CLASS = {
    'BTC':'crypto',   'ETH':'crypto',    'SOL':'crypto',  'XRP':'crypto',
    'ADA':'crypto',   'BNB':'crypto',
    'SPY':'equity',   'QQQ':'equity',    'AAPL':'equity', 'MSFT':'equity',
    'GOOGL':'equity', 'AMZN':'equity',   'TSLA':'equity', 'META':'equity',
    'HOOD':'equity',  'CRCL':'equity',
    'GLD':'metals',   'SLV':'metals',    'SILVER':'metals','XAG':'metals',
    'BRENT':'energy', 'BRENTOIL':'energy','OIL':'energy', 'WTI':'energy',
    'NATGAS':'energy','GAS':'energy',
    'WEAT':'agri',    'CORN':'agri',     'WHT':'agri',
    'SOXX':'equity',  'XAR':'equity',    'GDX':'metals',  'XLE':'energy',
    'XME':'metals',   'INDA':'equity',   'LIT':'energy'
  };

  // Minimum % move per timeframe required to qualify as a momentum signal
  var MOMENTUM_THR = {
    crypto:  { h1: 2.0, h4: 4.0, h24: 8.0  },
    equity:  { h1: 0.6, h4: 1.2, h24: 2.5  },
    metals:  { h1: 0.8, h4: 1.5, h24: 3.0  },
    energy:  { h1: 1.0, h4: 2.0, h24: 4.0  },
    agri:    { h1: 0.8, h4: 1.5, h24: 3.0  },
    'default': { h1: 0.8, h4: 1.5, h24: 3.0  }
  };

  // GII agents that may carry matching signals for bonus scoring
  var GII_AGENTS = [
    'GII_AGENT_ENERGY',   'GII_AGENT_MACRO',      'GII_AGENT_SATINTEL',
    'GII_AGENT_CRISISRANK','GII_AGENT_FORECAST',   'GII_AGENT_MACROSTRESS',
    'GII_INTEL_MASTER',   'GII_AGENT_SCALPER',     'GII_AGENT_CONFLICT',
    'GII_AGENT_MARITIME', 'GII_AGENT_TECHNICALS',  'GII_AGENT_MARKET_OBSERVER'
  ];

  // ── private state ─────────────────────────────────────────────────────────

  var _priceHistory = {};   // { 'BTC': [{price, ts}, ...] }
  var _signals      = [];   // currently active signals (emitted this session)
  var _cooldowns    = {};   // { 'BTC_LONG': ts, 'ETH_SHORT': ts }
  var _sampleTimer  = null;
  var _scanTimer    = null;
  var _scanCount    = 0;
  var _signalCount  = 0;
  var _lastScanTs   = null;
  var _online       = false;

  // ── helpers ───────────────────────────────────────────────────────────────

  // Return asset class string
  function _cls(asset) {
    return ASSET_CLASS[asset] || 'default';
  }

  // Return threshold object for an asset
  function _thr(asset) {
    return MOMENTUM_THR[_cls(asset)] || MOMENTUM_THR['default'];
  }

  // Return sector label for EE signal
  function _sector(asset) {
    var c = _cls(asset);
    if (c === 'default') return 'equity';
    return c;
  }

  // Collect a single price sample for every available asset
  function _collectSamples() {
    if (!window.HLFeed) return;

    var assets = Object.keys(ASSET_CLASS);
    var now    = Date.now();

    assets.forEach(function (asset) {
      // Only sample if asset is tradeable on HLFeed
      if (!HLFeed.isAvailable(asset)) return;

      var price;
      try { price = HLFeed.getPrice(asset); } catch (e) { return; }
      if (!price || isNaN(price) || price <= 0) return;

      if (!_priceHistory[asset]) _priceHistory[asset] = [];
      _priceHistory[asset].push({ price: price, ts: now });

      // Cap history at MAX_SAMPLES — oldest first, so shift off the front
      if (_priceHistory[asset].length > MAX_SAMPLES) {
        _priceHistory[asset].shift();
      }
    });
  }

  // Calculate % return between two prices; returns null if denominator is 0
  function _pctChange(older, newer) {
    if (!older || older === 0) return null;
    return (newer - older) / older * 100;
  }

  // Check whether any GII agent has a signal matching this asset+direction
  function _hasGIIMatch(asset, bias) {
    var biasLower = bias.toLowerCase();
    for (var i = 0; i < GII_AGENTS.length; i++) {
      var ag = window[GII_AGENTS[i]];
      if (!ag || typeof ag.signals !== 'function') continue;
      var sigs;
      try { sigs = ag.signals(); } catch (e) { continue; }
      if (!Array.isArray(sigs)) continue;
      for (var j = 0; j < sigs.length; j++) {
        var s = sigs[j];
        if ((s.asset || '').toUpperCase() !== asset.toUpperCase()) continue;
        var sd = (s.bias || s.direction || '').toLowerCase();
        if (sd === biasLower || sd === bias) return true;
      }
    }
    return false;
  }

  // Compute confidence score (55–95) based on momentum magnitude + GII alignment
  function _score(h1, h4, h24, thr, giiMatch) {
    var base = 55;

    // +10 each if move exceeds 2× threshold
    if (Math.abs(h1)  > 2 * thr.h1)  base += 10;
    if (Math.abs(h4)  > 2 * thr.h4)  base += 10;
    if (Math.abs(h24) > 2 * thr.h24) base += 10;

    // +10 if a GII agent independently agrees
    if (giiMatch) base += 10;

    return Math.min(95, base);
  }

  // Map score to confidence float
  function _confidence(score) {
    if (score >= 85) return 85;   // 0-100 scale
    if (score >= 75) return 79;
    if (score >= 65) return 72;
    return 65;
  }

  // Cooldown key for an asset+bias pair
  function _cooldownKey(asset, bias) {
    return asset + '_' + bias;
  }

  // True if the asset+bias is still under cooldown
  function _isCoolingDown(asset, bias) {
    var key = _cooldownKey(asset, bias);
    var ts  = _cooldowns[key];
    if (!ts) return false;
    return (Date.now() - ts) < COOLDOWN_MS;
  }

  // Set cooldown for asset+bias now
  function _setCooldown(asset, bias) {
    _cooldowns[_cooldownKey(asset, bias)] = Date.now();
  }

  // Format a % value with sign and one decimal place
  function _fmt(v) {
    var sign = v >= 0 ? '+' : '';
    return sign + v.toFixed(1) + '%';
  }

  // ── core scan ─────────────────────────────────────────────────────────────

  function _scanAsset(asset) {
    var history = _priceHistory[asset];
    if (!history || history.length < MIN_SAMPLES) return null;  // not enough data yet

    var len  = history.length;
    var cur  = history[len - 1].price;

    // ── 1h return ─────────────────────────────────────────────────────────
    // Need at least IDX_1H samples behind current
    if (len < IDX_1H + 1) return null;
    var price1hAgo = history[len - 1 - IDX_1H].price;
    var h1 = _pctChange(price1hAgo, cur);
    if (h1 === null) return null;

    // ── 4h return ─────────────────────────────────────────────────────────
    if (len < IDX_4H + 1) return null;
    var price4hAgo = history[len - 1 - IDX_4H].price;
    var h4 = _pctChange(price4hAgo, cur);
    if (h4 === null) return null;

    // ── 24h return ────────────────────────────────────────────────────────
    // Use the oldest sample available; only qualify if it's at least 24h old
    var oldest     = history[0];
    var oldestAge  = (Date.now() - oldest.ts) / (60 * 60 * 1000);  // hours
    if (oldestAge < 24) return null;  // not enough history for 24h window
    var h24 = _pctChange(oldest.price, cur);
    if (h24 === null) return null;

    var thr = _thr(asset);

    // ── direction alignment ────────────────────────────────────────────────
    // All three timeframes must point the same way
    var allPositive = h1 > 0 && h4 > 0 && h24 > 0;
    var allNegative = h1 < 0 && h4 < 0 && h24 < 0;
    if (!allPositive && !allNegative) return null;

    var bias = allPositive ? 'LONG' : 'SHORT';

    // ── threshold check ───────────────────────────────────────────────────
    if (Math.abs(h1)  < thr.h1)  return null;
    if (Math.abs(h4)  < thr.h4)  return null;
    if (Math.abs(h24) < thr.h24) return null;

    // ── anti-chasing filter ───────────────────────────────────────────────
    // If the 1h move is more than 3× what the longer timeframes imply per hour,
    // the move is likely a blow-off spike rather than a sustained trend.
    // h4 hourly rate  = |h4| / 4
    // h24 hourly rate = |h24| / 24
    var h4HourlyRate  = Math.abs(h4)  / 4;
    var h24HourlyRate = Math.abs(h24) / 24;
    var impliedHourly = Math.max(h4HourlyRate, h24HourlyRate);
    if (impliedHourly > 0 && Math.abs(h1) > CHASE_MULTIPLIER * impliedHourly) {
      return null;  // blow-off spike — skip
    }

    // ── cooldown check ─────────────────────────────────────────────────────
    if (_isCoolingDown(asset, bias)) return null;

    // ── GII alignment (optional bonus) ────────────────────────────────────
    var giiMatch = _hasGIIMatch(asset, bias);

    // ── score & confidence ────────────────────────────────────────────────
    var sc   = _score(h1, h4, h24, thr, giiMatch);
    var conf = _confidence(sc);

    // ── reasoning string ─────────────────────────────────────────────────
    var reasoning = (
      'Strong ' + (bias === 'LONG' ? 'uptrend' : 'downtrend') + ': ' +
      _fmt(h1) + ' (1h) · ' +
      _fmt(h4) + ' (4h) · ' +
      _fmt(h24) + ' (24h) — all aligned' +
      (giiMatch ? ' · GII confirmed' : '')
    );

    return {
      source       : 'momentum',
      asset        : asset,
      bias         : bias,
      confidence   : conf,
      reasoning    : reasoning,
      region       : 'GLOBAL',
      sector       : _sector(asset),
      evidenceKeys : ['momentum', 'trend', _cls(asset)],
      timestamp    : Date.now(),
      _score       : sc   // internal — not part of the public signal spec
    };
  }

  function _scan() {
    _scanCount++;
    _lastScanTs = Date.now();
    _online     = true;

    var assets      = Object.keys(ASSET_CLASS);
    var newSignals  = [];

    assets.forEach(function (asset) {
      // Skip assets HLFeed doesn't currently have
      if (!window.HLFeed || !HLFeed.isAvailable(asset)) return;

      var sig = _scanAsset(asset);
      if (!sig) return;

      newSignals.push(sig);
      _setCooldown(asset, sig.bias);
    });

    if (newSignals.length) {
      _signalCount += newSignals.length;

      // Remove _score (internal field) before exposing or sending
      var publicSignals = newSignals.map(function (s) {
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

      // Append to active signals list (keep last 50 for status inspection)
      publicSignals.forEach(function (s) { _signals.push(s); });
      if (_signals.length > 50) _signals = _signals.slice(-50);

      // Forward to Execution Engine
      if (window.EE && typeof EE.onSignals === 'function') {
        try {
          EE.onSignals(publicSignals);
        } catch (e) {
          console.warn('[MOMENTUM] EE.onSignals error:', e);
        }
      }

      console.log(
        '[MOMENTUM] Scan #' + _scanCount + ': ' +
        newSignals.length + ' signal(s) fired — ' +
        newSignals.map(function (s) {
          return s.asset + ' ' + s.bias + ' (' + (s.confidence * 100).toFixed(0) + '%)';
        }).join(', ')
      );
    } else {
      console.log('[MOMENTUM] Scan #' + _scanCount + ': no qualifying momentum signals');
    }
  }

  // ── public API ────────────────────────────────────────────────────────────

  function _status() {
    var tracked = 0;
    var assets  = Object.keys(ASSET_CLASS);
    assets.forEach(function (asset) {
      var h = _priceHistory[asset];
      if (h && h.length >= MIN_SAMPLES) tracked++;
    });

    return {
      lastPoll     : _lastScanTs,
      online       : _online,
      assetsTracked: tracked,
      signalCount  : _signalCount,
      scanCount    : _scanCount,
      note         : 'Samples every 5min; scans every 15min; 6h cooldown per asset+direction'
    };
  }

  // ── init ──────────────────────────────────────────────────────────────────

  function _init() {
    console.log('[MOMENTUM] Initialising — collecting price samples every 5min, scanning every 15min');

    // Start continuous price sampling immediately
    _collectSamples();  // first sample now
    _sampleTimer = setInterval(_collectSamples, SAMPLE_MS);

    // First scan after INIT_DELAY_MS; then every SCAN_MS
    setTimeout(function () {
      _scan();
      _scanTimer = setInterval(_scan, SCAN_MS);
    }, INIT_DELAY_MS);
  }

  // ── expose public interface ───────────────────────────────────────────────

  window.GII_AGENT_MOMENTUM = {
    /**
     * Returns agent health and counters.
     * @returns {{ lastPoll:number|null, online:boolean, assetsTracked:number,
     *             signalCount:number, scanCount:number, note:string }}
     */
    status: function () { return _status(); },

    /**
     * Returns the current active signals array (last 50 emitted this session).
     * @returns {Array}
     */
    signals: function () { return _signals.slice(); },

    /**
     * Force an immediate scan, bypassing the regular 15-minute schedule.
     * Useful for testing or manual triggers from the dashboard.
     */
    scan: function () { _scan(); }
  };

  // Boot after page load so HLFeed and EE are available
  window.addEventListener('load', _init);

}());
