/* Event Momentum Agent — event-momentum-agent.js v1
 *
 * Monitors GII geopolitical events (window.__IC.events) and, when a
 * high-signal event fires and affected assets begin moving, generates a
 * momentum-follow signal intended to ride the move for 2–4 hours.
 *
 * The geopolitical system explains WHY an asset is moving.  This agent
 * detects THAT it has started moving and hands a follow signal to the
 * Execution Engine so traders who missed the initial catalyst can still
 * participate.
 *
 * Data source   : window.__IC.events (field: signal, assets, region, title, ts)
 * Price data    : HLFeed.getPrice(asset) — sampled every 5 min
 * Scan interval : every 5 minutes (first scan 15 s after load)
 * Cooldown      : 3 hours per asset+direction
 *
 * Exposes: window.GII_AGENT_EVENT_MOMENTUM
 */
(function () {
  'use strict';

  // ── constants ─────────────────────────────────────────────────────────────

  var SCAN_MS        = 5  * 60 * 1000;   // scan every 5 minutes
  var SAMPLE_MS      = 5  * 60 * 1000;   // price snapshot every 5 minutes
  var INIT_DELAY_MS  = 15 * 1000;        // first scan after 15 s
  var COOLDOWN_MS    = 3  * 60 * 60 * 1000;  // 3-hour cooldown per asset+direction
  var EVENT_WINDOW   = 4  * 60 * 60 * 1000;  // look back 4 hours of events
  var MIN_SIGNAL     = 60;               // minimum event signal score to consider
  var MAX_SIGNALS    = 50;               // keep last 50 signals in memory

  // Snapshot age band to use as the "20 minutes ago" baseline.
  // We look for the snapshot closest to TARGET_AGE, within the tolerance band.
  var SNAPSHOT_TARGET_MS  = 20 * 60 * 1000;  // ideal 20 min
  var SNAPSHOT_MIN_MS     = 15 * 60 * 1000;  // at least 15 min old
  var SNAPSHOT_MAX_MS     = 25 * 60 * 1000;  // at most 25 min old

  // Per-asset-class movement thresholds (%)
  var THRESHOLD = {
    crypto:  1.5,
    equity:  0.6,
    metals:  0.8,
    energy:  1.0,
    agri:    0.8,
    'default': 0.8
  };

  // Asset-class map
  var ASSET_CLASS = {
    'BTC':'crypto',   'ETH':'crypto',    'SOL':'crypto',   'XRP':'crypto',
    'ADA':'crypto',   'BNB':'crypto',
    'SPY':'equity',   'QQQ':'equity',    'AAPL':'equity',  'MSFT':'equity',
    'GOOGL':'equity', 'AMZN':'equity',   'TSLA':'equity',  'META':'equity',
    'HOOD':'equity',  'TSM':'equity',    'FXI':'equity',
    'GLD':'metals',   'SLV':'metals',    'SILVER':'metals', 'XAG':'metals',
    'GDX':'metals',   'XME':'metals',
    'BRENT':'energy', 'BRENTOIL':'energy','OIL':'energy',  'WTI':'energy',
    'NATGAS':'energy','GAS':'energy',     'XLE':'energy',
    'WEAT':'agri',    'CORN':'agri',     'WHT':'agri'
  };

  // Region → default asset list when event.assets is empty
  var REGION_ASSETS = {
    'MIDDLE_EAST': ['GLD', 'BRENTOIL', 'GAS'],
    'IRAN':        ['GLD', 'BRENTOIL', 'GAS'],
    'RUSSIA':      ['GLD', 'WEAT',     'GAS'],
    'UKRAINE':     ['GLD', 'WEAT',     'GAS'],
    'CHINA':       ['BTC', 'TSLA', 'AAPL', 'QQQ'],
    'TAIWAN':      ['BTC', 'TSLA', 'AAPL', 'QQQ'],
    'DEFAULT':     ['GLD', 'SPY']
  };

  // Safe-haven / supply-shock assets → LONG on conflict
  var SAFE_HAVEN = {
    'GLD':1, 'SLV':1, 'SILVER':1, 'XAG':1, 'GDX':1, 'XME':1,
    'BRENTOIL':1, 'BRENT':1, 'OIL':1, 'WTI':1, 'NATGAS':1, 'GAS':1,
    'XLE':1
  };

  // Risk assets → SHORT on conflict (risk-off)
  var RISK_OFF = {
    'SPY':1, 'QQQ':1, 'TSLA':1, 'AAPL':1, 'META':1,
    'MSFT':1, 'GOOGL':1, 'AMZN':1, 'HOOD':1, 'SOXX':1, 'FXI':1
  };

  // Agricultural → LONG on supply disruption
  var AGRI = { 'WEAT':1, 'CORN':1, 'WHT':1 };

  // Keywords that suggest a cyber/sanctions context (BTC LONG)
  var CYBER_KEYWORDS = [
    'cyber', 'hack', 'sanction', 'swift', 'freeze', 'asset',
    'cryptocurrency', 'digital', 'ransomware'
  ];

  // Keywords that suggest genuine risk-off pressure (BTC SHORT)
  var RISKOFF_KEYWORDS = [
    'invasion', 'war', 'airstrike', 'missile', 'attack', 'offensive',
    'combat', 'conflict', 'explosion', 'nuclear', 'casualties'
  ];

  // ── private state ─────────────────────────────────────────────────────────

  // { 'GLD': [ {price, ts}, ... ] } — rolling 30 snapshots per asset
  var _priceSnapshot = {};

  // Active signals emitted this session
  var _signals = [];

  // Cooldowns: { 'GLD_LONG': ts }
  var _cooldowns = {};

  // Dedup: { 'eventId_GLD_LONG': true }
  var _emittedForEvent = {};

  var _lastScanTs  = null;
  var _online      = false;
  var _signalCount = 0;
  var _eventsMonitored = 0;

  // ── helpers ───────────────────────────────────────────────────────────────

  function _cls(asset) {
    return ASSET_CLASS[asset] || 'default';
  }

  function _threshold(asset) {
    return THRESHOLD[_cls(asset)] || THRESHOLD['default'];
  }

  function _sector(asset) {
    var c = _cls(asset);
    if (c === 'agri')    return 'agriculture';
    if (c === 'default') return 'equity';
    return c;
  }

  // Build a stable event ID from its properties (events may lack an id field)
  function _eventId(evt) {
    return (evt.id) ? String(evt.id) :
      (String(evt.ts || 0) + '_' + String(evt.signal || 0) + '_' + String(evt.title || '').slice(0, 20));
  }

  // True if text contains any of the supplied keywords
  function _hasKeyword(text, keywords) {
    if (!text) return false;
    var t = text.toLowerCase();
    for (var i = 0; i < keywords.length; i++) {
      if (t.indexOf(keywords[i]) !== -1) return true;
    }
    return false;
  }

  // Return the correct bias for this asset given the event title
  function _biasForAsset(asset, eventTitle) {
    var up   = asset.toUpperCase();
    var text = (eventTitle || '').toLowerCase();

    if (AGRI[up]) return 'LONG';

    if (SAFE_HAVEN[up]) return 'LONG';

    if (RISK_OFF[up]) return 'SHORT';

    if (up === 'BTC' || up === 'ETH' || up === 'SOL') {
      // cyber/sanctions → capital flight → LONG
      if (_hasKeyword(text, CYBER_KEYWORDS)) return 'LONG';
      // hard conflict → risk-off → SHORT
      if (_hasKeyword(text, RISKOFF_KEYWORDS)) return 'SHORT';
      // default for crypto in geopolitical context: treat as risk-off
      return 'SHORT';
    }

    // Unknown asset: default LONG (most geopolitical events lift commodities)
    return 'LONG';
  }

  // Resolve asset list from event
  function _assetsForEvent(evt) {
    if (evt.assets && Array.isArray(evt.assets) && evt.assets.length > 0) {
      return evt.assets;
    }
    // Infer from region
    var region = (evt.region || '').toUpperCase();
    for (var key in REGION_ASSETS) {
      if (region.indexOf(key) !== -1) return REGION_ASSETS[key];
    }
    return REGION_ASSETS['DEFAULT'];
  }

  // Cooldown key
  function _cooldownKey(asset, bias) {
    return asset.toUpperCase() + '_' + bias;
  }

  function _isCoolingDown(asset, bias) {
    var key = _cooldownKey(asset, bias);
    var ts  = _cooldowns[key];
    if (!ts) return false;
    return (Date.now() - ts) < COOLDOWN_MS;
  }

  function _setCooldown(asset, bias) {
    _cooldowns[_cooldownKey(asset, bias)] = Date.now();
  }

  // Dedup key for event+asset+bias combo
  function _dedupKey(eventId, asset, bias) {
    return eventId + '_' + asset.toUpperCase() + '_' + bias;
  }

  // Check GII agents for a matching signal on this asset+bias
  var GII_AGENTS = [
    'GII_AGENT_CONFLICT', 'GII_AGENT_ENERGY',  'GII_AGENT_MACRO',
    'GII_AGENT_CRISISRANK','GII_AGENT_FORECAST','GII_AGENT_ESCALATION',
    'GII_AGENT_MARITIME',  'GII_AGENT_SANCTIONS','GII_INTEL_MASTER'
  ];

  function _hasGIIMatch(asset, bias) {
    var bLower = bias.toLowerCase();
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
        if (sd === bLower || sd === bias) return true;
      }
    }
    return false;
  }

  // Format % with sign + 1 dp
  function _fmt(v) {
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  // ── price snapshots ────────────────────────────────────────────────────────

  // List of all assets we may need to track
  var _watchedAssets = (function () {
    var all = [];
    for (var a in ASSET_CLASS) { all.push(a); }
    return all;
  }());

  function _takePriceSnapshot() {
    if (!window.HLFeed) return;
    var now = Date.now();
    _watchedAssets.forEach(function (asset) {
      if (!HLFeed.isAvailable(asset)) return;
      var price;
      try { price = HLFeed.getPrice(asset); } catch (e) { return; }
      if (!price || isNaN(price) || price <= 0) return;
      if (!_priceSnapshot[asset]) _priceSnapshot[asset] = [];
      _priceSnapshot[asset].push({ price: price, ts: now });
      // Keep at most 30 snapshots (~2.5 h)
      if (_priceSnapshot[asset].length > 30) _priceSnapshot[asset].shift();
    });
  }

  // Find the snapshot closest to TARGET_AGE old, within [MIN, MAX] age band
  function _getBaselineSnapshot(asset) {
    var snaps = _priceSnapshot[asset];
    if (!snaps || snaps.length === 0) return null;
    var now = Date.now();
    var best = null;
    var bestDiff = Infinity;
    for (var i = 0; i < snaps.length; i++) {
      var age = now - snaps[i].ts;
      if (age < SNAPSHOT_MIN_MS || age > SNAPSHOT_MAX_MS) continue;
      var diff = Math.abs(age - SNAPSHOT_TARGET_MS);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = snaps[i];
      }
    }
    return best;   // null if no snapshot falls in the band yet
  }

  // ── core scan ─────────────────────────────────────────────────────────────

  function _scan() {
    _lastScanTs = Date.now();
    _online     = true;

    // Guard: need __IC
    if (!window.__IC || !window.__IC.events || !Array.isArray(window.__IC.events)) {
      console.log('[EVENT-MOMENTUM] window.__IC not available — skipping scan');
      return;
    }

    // Guard: need HLFeed
    if (!window.HLFeed) {
      console.log('[EVENT-MOMENTUM] HLFeed not available — skipping scan');
      return;
    }

    var now     = Date.now();
    var cutoff  = now - EVENT_WINDOW;

    // Filter to qualifying events
    var events = window.__IC.events.filter(function (e) {
      var sig = e.signal || e.severity || 0;
      return e.ts > cutoff && sig >= MIN_SIGNAL;
    });

    _eventsMonitored = events.length;

    var newSignals = [];

    events.forEach(function (evt) {
      var evtId     = _eventId(evt);
      var evtSignal = evt.signal || evt.severity || 0;
      var evtTitle  = evt.title || evt.headline || evt.text || '';
      var evtRegion = (evt.region || 'GLOBAL').toUpperCase();
      var assets    = _assetsForEvent(evt);

      assets.forEach(function (asset) {
        var assetUp = asset.toUpperCase();

        // Tradeable check
        if (!HLFeed.isAvailable(assetUp)) return;

        // Determine expected bias
        var bias = _biasForAsset(assetUp, evtTitle);

        // Dedup check
        var dkey = _dedupKey(evtId, assetUp, bias);
        if (_emittedForEvent[dkey]) return;

        // Cooldown check
        if (_isCoolingDown(assetUp, bias)) return;

        // Get current price
        var currentPrice;
        try { currentPrice = HLFeed.getPrice(assetUp); } catch (e) { return; }
        if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) return;

        // Get baseline snapshot (~20 min ago)
        var baseline = _getBaselineSnapshot(assetUp);
        if (!baseline) return;  // not enough history yet

        // Calculate % move
        var pctMove = (currentPrice - baseline.price) / baseline.price * 100;
        var thr     = _threshold(assetUp);

        // Check if move exceeds threshold AND is in the right direction
        var movingLong  = pctMove > 0;
        var movingShort = pctMove < 0;
        var inDirection = (bias === 'LONG' && movingLong) ||
                          (bias === 'SHORT' && movingShort);
        if (!inDirection) return;
        if (Math.abs(pctMove) < thr) return;

        // ── confidence calculation ────────────────────────────────────────
        var conf = 65;   // 0-100 scale
        if (evtSignal > 75)                    conf += 5;
        if (Math.abs(pctMove) > 2 * thr)      conf += 5;
        if (_hasGIIMatch(assetUp, bias))       conf += 3;
        if (conf > 85) conf = 85;
        conf = Math.round(conf);

        // ── age of baseline snapshot ──────────────────────────────────────
        var ageMin = Math.round((now - baseline.ts) / 60000);

        // ── reasoning string ─────────────────────────────────────────────
        var reasoning = (
          evtRegion + ' event \'' + evtTitle.slice(0, 50) +
          '\' (signal:' + evtSignal + ') → ' +
          assetUp + ' moving ' + _fmt(pctMove) +
          ' in ' + ageMin + 'min — momentum follow'
        );

        var sig = {
          source       : 'event-momentum',
          asset        : assetUp,
          bias         : bias,
          confidence   : conf,
          reasoning    : reasoning,
          region       : evtRegion,
          sector       : _sector(assetUp),
          evidenceKeys : ['event-momentum', 'geopolitical', _sector(assetUp)],
          timestamp    : now
        };

        newSignals.push(sig);
        _emittedForEvent[dkey] = true;
        _setCooldown(assetUp, bias);
      });
    });

    if (newSignals.length) {
      _signalCount += newSignals.length;

      // Store in session signal list
      newSignals.forEach(function (s) { _signals.push(s); });
      if (_signals.length > MAX_SIGNALS) _signals = _signals.slice(-MAX_SIGNALS);

      // Forward to Execution Engine
      if (window.EE && typeof EE.onSignals === 'function') {
        try {
          EE.onSignals(newSignals);
        } catch (e) {
          console.warn('[EVENT-MOMENTUM] EE.onSignals error:', e);
        }
      }

      console.log(
        '[EVENT-MOMENTUM] ' + newSignals.length + ' momentum signal(s): ' +
        newSignals.map(function (s) {
          return s.asset + ' ' + s.bias + ' (' + (s.confidence * 100).toFixed(0) + '%)';
        }).join(', ')
      );
    } else {
      console.log(
        '[EVENT-MOMENTUM] Scan complete — ' +
        _eventsMonitored + ' qualifying event(s), no momentum signals triggered'
      );
    }
  }

  // ── public API ────────────────────────────────────────────────────────────

  function _status() {
    return {
      lastPoll        : _lastScanTs,
      online          : _online,
      eventsMonitored : _eventsMonitored,
      signalCount     : _signalCount,
      note            : 'Scans every 5min; 3h cooldown per asset+direction; 4h event window; min signal ' + MIN_SIGNAL
    };
  }

  // ── init ──────────────────────────────────────────────────────────────────

  function _init() {
    console.log('[EVENT-MOMENTUM] Initialising — price snapshots every 5min, first scan in 15s');

    // Start snapshotting immediately so we have ~15–25 min of history by first scan
    _takePriceSnapshot();
    setInterval(_takePriceSnapshot, SAMPLE_MS);

    // First scan after INIT_DELAY_MS; then every SCAN_MS
    setTimeout(function () {
      _scan();
      setInterval(_scan, SCAN_MS);
    }, INIT_DELAY_MS);
  }

  // ── expose public interface ───────────────────────────────────────────────

  window.GII_AGENT_EVENT_MOMENTUM = {
    /**
     * Returns agent health and counters.
     * @returns {{ lastPoll:number|null, online:boolean, eventsMonitored:number,
     *             signalCount:number, note:string }}
     */
    status: function () { return _status(); },

    /**
     * Returns the current active signals array (last 50 emitted this session).
     * @returns {Array}
     */
    signals: function () { return _signals.slice(); },

    /**
     * Force an immediate scan, bypassing the regular schedule.
     */
    scan: function () { _scan(); }
  };

  window.addEventListener('load', _init);

}());
