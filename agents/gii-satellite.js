/* GII Satellite Agent — gii-satellite.js v1
 * Monitors satellite-sourced intelligence signals:
 *   - AIS vessel traffic anomalies and dark-ship detection
 *   - Military fleet concentrations and naval movements
 *   - Infrastructure status (refineries, ports, pipelines)
 *   - Orbital / reconnaissance activity signals from news
 * Reads: window.__IC.events (sbFeed: 'maritime'/'aircraft', satellite/AIS keywords)
 * Exposes: window.GII_AGENT_SATELLITE
 */
(function () {
  'use strict';

  var MAX_SIGNALS  = 20;
  var POLL_INTERVAL = 76000;

  // AIS and vessel traffic anomaly keywords
  var AIS_KEYWORDS = [
    'ais', 'ais gap', 'dark ship', 'transponder off', 'ais manipulation', 'ais spoofing',
    'vessel traffic', 'tanker traffic', 'shipping traffic', 'port congestion',
    'vessel rerouting', 'maritime surveillance', 'satellite imagery', 'sar satellite',
    'ship tracking', 'vessel detection'
  ];

  // Military fleet movement keywords
  var FLEET_KEYWORDS = [
    'carrier strike group', 'aircraft carrier', 'uss ', 'hms ', 'fleet deployment',
    'naval buildup', 'warship deployment', 'amphibious assault', 'submarine detected',
    'destroyer deployment', 'carrier group', 'naval exercise', 'military satellite',
    'reconnaissance satellite', 'spy satellite', 'surveillance drone', 'military drone',
    'uav detected', 'orbital intelligence', 'isr', 'satellite surveillance'
  ];

  // Infrastructure damage/disruption keywords
  var INFRA_KEYWORDS = [
    'refinery fire', 'pipeline damage', 'port closure', 'terminal shutdown', 'facility damage',
    'infrastructure attack', 'oil facility', 'gas facility', 'power grid', 'pipeline explosion',
    'storage tank', 'refinery offline', 'platform evacuated', 'production halt',
    'critical infrastructure'
  ];

  // Chokepoint-specific intel
  var CHOKEPOINT_REGIONS = {
    'HORMUZ':       { asset: 'WTI',   region: 'STRAIT OF HORMUZ', priorBoost: 0.25 },
    'SUEZ':         { asset: 'BRENT', region: 'RED SEA',           priorBoost: 0.20 },
    'BAB AL':       { asset: 'BRENT', region: 'RED SEA',           priorBoost: 0.18 },
    'MALACCA':      { asset: 'WTI',   region: 'SOUTH CHINA SEA',   priorBoost: 0.15 },
    'SOUTH CHINA':  { asset: 'TSM',   region: 'SOUTH CHINA SEA',   priorBoost: 0.15 },
    'TAIWAN':       { asset: 'TSM',   region: 'TAIWAN',             priorBoost: 0.20 },
    'BLACK SEA':    { asset: 'GLD',   region: 'UKRAINE',           priorBoost: 0.12 },
    'PERSIAN GULF': { asset: 'WTI',   region: 'MIDDLE EAST',       priorBoost: 0.18 }
  };

  var _signals = [];
  var _status = {
    lastPoll:           null,
    aisAnomalyCount:    0,
    fleetMovements:     0,
    infraEvents:        0,
    activeChokepoints:  []
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  // ── helpers ────────────────────────────────────────────────────────────────

  function _matchesKeywords(text, keywords) {
    if (!text) return false;
    var t = text.toLowerCase();
    for (var i = 0; i < keywords.length; i++) {
      if (t.indexOf(keywords[i]) !== -1) return true;
    }
    return false;
  }

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  function _getChokepointMatch(text) {
    var t = (text || '').toUpperCase();
    for (var key in CHOKEPOINT_REGIONS) {
      if (t.indexOf(key) !== -1) return CHOKEPOINT_REGIONS[key];
    }
    return null;
  }

  // ── analysis ───────────────────────────────────────────────────────────────

  function _analyseEvents() {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now = Date.now();
    var cutoff = now - 24 * 60 * 60 * 1000;

    // Filter to satellite-relevant events:
    // - sbFeed tagged as maritime/aircraft
    // - OR keyword match on AIS/fleet/infra
    var satEvents = IC.events.filter(function (e) {
      if (e.ts <= cutoff) return false;
      if (e.sbFeed === 'maritime' || e.sbFeed === 'aircraft') return true;
      var text = e.title || e.headline || e.text || '';
      return _matchesKeywords(text, AIS_KEYWORDS) ||
             _matchesKeywords(text, FLEET_KEYWORDS) ||
             _matchesKeywords(text, INFRA_KEYWORDS);
    });

    // Classify
    var aisEvts   = satEvents.filter(function (e) { return _matchesKeywords(e.title || e.headline || e.text || '', AIS_KEYWORDS); });
    var fleetEvts = satEvents.filter(function (e) { return _matchesKeywords(e.title || e.headline || e.text || '', FLEET_KEYWORDS); });
    var infraEvts = satEvents.filter(function (e) { return _matchesKeywords(e.title || e.headline || e.text || '', INFRA_KEYWORDS); });

    _status.aisAnomalyCount = aisEvts.length;
    _status.fleetMovements  = fleetEvts.length;
    _status.infraEvents     = infraEvts.length;

    // ── AIS anomaly signals ────────────────────────────────────────────────

    if (aisEvts.length >= 2) {
      // Find which chokepoint they're near
      var chokepointHits = {};
      aisEvts.forEach(function (e) {
        var text = e.title || e.headline || e.region || '';
        var cp = _getChokepointMatch(text);
        if (cp) {
          var key = cp.region;
          if (!chokepointHits[key]) chokepointHits[key] = { cp: cp, count: 0 };
          chokepointHits[key].count++;
        }
      });

      Object.keys(chokepointHits).forEach(function (region) {
        var hit = chokepointHits[region];
        var conf = _clamp(0.40 + hit.count * 0.08, 0.40, 0.82);
        // Prior from IC
        if (IC.regionStates && IC.regionStates[region]) {
          conf = conf * (0.5 + (IC.regionStates[region].prob || 0) / 200);
        }
        _pushSignal({
          source:      'satellite',
          asset:       hit.cp.asset,
          bias:        'long',
          confidence:  _clamp(conf, 0.30, 0.82),
          reasoning:   'AIS anomaly/dark-ship: ' + hit.count + ' incidents near ' + region,
          region:      region,
          evidenceKeys: ['ais', 'dark ship', 'transponder off', 'vessel traffic']
        });
      });

      // If no specific chokepoint but multiple AIS events — general supply route signal
      if (Object.keys(chokepointHits).length === 0) {
        var avgSig = aisEvts.reduce(function (s, e) { return s + (e.signal || 50); }, 0) / aisEvts.length;
        _pushSignal({
          source:      'satellite',
          asset:       'WTI',
          bias:        'long',
          confidence:  _clamp(avgSig / 100 * 0.70, 0.25, 0.70),
          reasoning:   aisEvts.length + ' AIS/vessel anomaly events — supply route uncertainty',
          region:      'GLOBAL',
          evidenceKeys: ['ais', 'vessel traffic', 'maritime surveillance']
        });
      }
    }

    // ── Fleet movement signals ─────────────────────────────────────────────

    if (fleetEvts.length >= 1) {
      fleetEvts.forEach(function (e) {
        var text = e.title || e.headline || '';
        var cp = _getChokepointMatch(text + ' ' + (e.region || ''));
        var region = cp ? cp.region : (e.region || 'GLOBAL');
        var asset  = cp ? cp.asset  : 'GLD';
        var sig    = e.signal || e.severity || 55;
        var conf   = _clamp(sig / 100 * 0.80, 0.30, 0.82);
        _pushSignal({
          source:      'satellite',
          asset:       asset,
          bias:        'long',
          confidence:  conf,
          reasoning:   'Fleet movement detected: ' + text.substring(0, 70),
          region:      region,
          evidenceKeys: ['carrier strike group', 'naval buildup', 'fleet deployment']
        });
      });

      // If 3+ distinct fleet events — heightened multi-theatre signal
      if (fleetEvts.length >= 3) {
        _pushSignal({
          source:      'satellite',
          asset:       'GLD',
          bias:        'long',
          confidence:  _clamp(0.55 + fleetEvts.length * 0.04, 0.55, 0.85),
          reasoning:   fleetEvts.length + ' fleet movements — multi-theatre naval escalation signal',
          region:      'GLOBAL',
          evidenceKeys: ['fleet deployment', 'aircraft carrier', 'naval exercise']
        });
      }
    }

    // ── Infrastructure damage signals ──────────────────────────────────────

    if (infraEvts.length >= 1) {
      infraEvts.forEach(function (e) {
        var text = e.title || e.headline || '';
        var region = e.region || 'GLOBAL';
        var sig    = e.signal || e.severity || 55;

        // Determine asset: energy infra → WTI/BRENT; general → GLD
        var isEnergy = /refiner|pipeline|oil|gas|lng|terminal|platform/i.test(text);
        var asset = isEnergy ? 'WTI' : 'GLD';
        var conf  = _clamp(sig / 100 * 0.75, 0.28, 0.78);

        _pushSignal({
          source:      'satellite',
          asset:       asset,
          bias:        'long',
          confidence:  conf,
          reasoning:   'Infrastructure damage/disruption: ' + text.substring(0, 70),
          region:      region,
          evidenceKeys: ['refinery', 'pipeline damage', 'infrastructure attack']
        });
      });
    }

    // Update active chokepoints
    var active = [];
    satEvents.forEach(function (e) {
      var text = e.title || e.headline || e.region || '';
      var cp = _getChokepointMatch(text);
      if (cp && active.indexOf(cp.region) === -1) active.push(cp.region);
    });
    _status.activeChokepoints = active;
  }

  // ── public poll ────────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    _analyseEvents();
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII_AGENT_SATELLITE = {
    poll:     poll,
    signals:  function () { return _signals.slice(); },
    status:   function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); }
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 7300);
  });

})();
