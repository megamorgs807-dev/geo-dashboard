/* GII Conflict Agent — gii-conflict.js v2
 * Monitors armed-conflict and escalation signals
 * Reads: window.__IC.events, window.__IC.regionStates
 * Exposes: window.GII_AGENT_CONFLICT
 */
(function () {
  'use strict';

  var MAX_SIGNALS = 20;
  var POLL_INTERVAL = 67000;
  var MIN_SEVERITY = 65;

  var SEV_KEYWORDS = [
    'airstrike', 'missile', 'attack', 'invasion', 'offensive', 'combat', 'troops',
    'military', 'strike', 'shelling', 'bombing', 'artillery', 'forces', 'war',
    'conflict', 'assault', 'explosion', 'casualties', 'killed', 'hostilities',
    'ceasefire', 'escalation', 'threat', 'mobilisation', 'mobilization', 'deployment',
    'naval', 'drone', 'rocket', 'mortar', 'frontline', 'incursion', 'siege',
    'blockade', 'coup', 'uprising', 'insurgency', 'rebels', 'militant'
  ];

  // Asset map by region
  var REGION_ASSET_MAP = {
    'UKRAINE': 'GLD',
    'RUSSIA': 'GLD',
    'MIDDLE EAST': 'WTI',
    'IRAN': 'WTI',
    'ISRAEL': 'GLD',
    'TAIWAN': 'TSM',
    'CHINA': 'FXI',
    'NORTH KOREA': 'GLD',
    'STRAIT OF HORMUZ': 'WTI',
    'RED SEA': 'WTI',
    'SOUTH CHINA SEA': 'TSM',
    'PAKISTAN': 'GLD',
    'INDIA': 'GLD',
    'AFRICA': 'GLD',
    'VENEZUELA': 'WTI',
    'GLOBAL': 'GLD'
  };

  var _signals = [];
  var _status = {
    lastPoll: null,
    conflictEventCount: 0,
    activeRegions: [],
    highestSeverity: 0
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  // ── helpers ────────────────────────────────────────────────────────────────

  function _matchesSev(text) {
    if (!text) return false;
    var t = text.toLowerCase();
    for (var i = 0; i < SEV_KEYWORDS.length; i++) {
      if (t.indexOf(SEV_KEYWORDS[i]) !== -1) return true;
    }
    return false;
  }

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  function _getAssetForRegion(region) {
    for (var r in REGION_ASSET_MAP) {
      if (region && region.toUpperCase().indexOf(r) !== -1) return REGION_ASSET_MAP[r];
    }
    return 'GLD'; // default safe haven
  }

  // ── analysis ───────────────────────────────────────────────────────────────

  function _analyseEvents() {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now = Date.now();
    var cutoff = now - 24 * 60 * 60 * 1000;

    // Filter to high-severity conflict events
    var conflictEvents = IC.events.filter(function (e) {
      var sig = e.signal || e.severity || 0;
      var text = e.headline || e.text || e.title || '';
      return sig >= MIN_SEVERITY && e.ts > cutoff && _matchesSev(text);
    });

    _status.conflictEventCount = conflictEvents.length;
    _status.highestSeverity = conflictEvents.length
      ? Math.max.apply(null, conflictEvents.map(function (e) { return e.signal || e.severity || 0; }))
      : 0;

    if (!conflictEvents.length) return;

    // Group by region
    var byRegion = {};
    conflictEvents.forEach(function (e) {
      var r = (e.region || 'GLOBAL').toUpperCase();
      if (!byRegion[r]) byRegion[r] = [];
      byRegion[r].push(e);
    });

    _status.activeRegions = Object.keys(byRegion);

    // Emit highest-severity event per region
    Object.keys(byRegion).forEach(function (region) {
      var evts = byRegion[region];
      // Sort by severity desc
      evts.sort(function (a, b) {
        return (b.signal || b.severity || 0) - (a.signal || a.severity || 0);
      });
      var top = evts[0];
      var topSig = top.signal || top.severity || 50;
      var count = evts.length;

      // Check region state prior
      var prior = 0.20;
      if (IC.regionStates && IC.regionStates[region]) {
        var rs = IC.regionStates[region];
        prior = _clamp((rs.prob || 0) / 100, 0.05, 0.90);
      }

      // Elevated if region prob > 50 and multi-event
      var elevated = prior > 0.50 && count > 2;
      var baseConf = _clamp(topSig / 100 * 0.80, 0.25, 0.80);
      if (elevated) baseConf = _clamp(baseConf * 1.20, 0.25, 0.88);

      var asset = _getAssetForRegion(region);
      var headline = top.headline || top.text || top.title || '';

      _pushSignal({
        source: 'conflict',
        asset: asset,
        bias: 'long',
        confidence: _clamp(baseConf, 0.25, 0.88),
        reasoning: region + ': ' + count + ' conflict events (max sev ' + topSig + ')' +
          (elevated ? ' [ELEVATED]' : '') + ' — ' + headline.substring(0, 80),
        region: region,
        evidenceKeys: SEV_KEYWORDS.slice(0, 6)
      });
    });

    // Cross-region escalation check (3+ distinct regions active)
    if (_status.activeRegions.length >= 3) {
      _pushSignal({
        source: 'conflict',
        asset: 'GLD',
        bias: 'long',
        confidence: _clamp(0.60 + _status.activeRegions.length * 0.03, 0.60, 0.85),
        reasoning: 'Multi-theatre escalation: ' + _status.activeRegions.length + ' active conflict regions simultaneously',
        region: 'GLOBAL',
        evidenceKeys: ['escalation', 'conflict', 'military']
      });
    }
  }

  // ── public poll ────────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    _analyseEvents();
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII_AGENT_CONFLICT = {
    poll: poll,
    signals: function () { return _signals.slice(); },
    status: function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); }
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 6600);
  });

})();
