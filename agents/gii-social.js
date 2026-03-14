/* GII Social Agent — gii-social.js v3
 * Monitors social velocity / GDELT sentiment signals
 * Reads: window.__IC.events (source: REDDIT / GDELT)
 * Exposes: window.GII_AGENT_SOCIAL
 */
(function () {
  'use strict';

  var MAX_SIGNALS = 20;
  var POLL_INTERVAL = 75000;
  var VELOCITY_THRESHOLD = 3.0;   // sum of socialV per region to emit signal
  var MAX_CONF = 0.80;

  // Asset map by region (fallback to GLD)
  var REGION_ASSET = {
    'UKRAINE':           'GLD',
    'RUSSIA':            'GLD',
    'MIDDLE EAST':       'WTI',
    'IRAN':              'WTI',
    'ISRAEL':            'GLD',
    'TAIWAN':            'TSM',
    'CHINA':             'FXI',
    'US':                'SPY',
    'NORTH KOREA':       'GLD',
    'STRAIT OF HORMUZ':  'WTI',
    'RED SEA':           'WTI',
    'SOUTH CHINA SEA':   'TSM',
    'GLOBAL':            'GLD'
  };

  var _signals = [];
  var _status = {
    lastPoll: null,
    socialEventCount: 0,
    topRegions: [],
    maxVelocity: 0
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  // ── helpers ────────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  function _getAsset(region) {
    var r = (region || 'GLOBAL').toUpperCase();
    for (var key in REGION_ASSET) {
      if (r.indexOf(key) !== -1) return REGION_ASSET[key];
    }
    return 'GLD';
  }

  // ── analysis ───────────────────────────────────────────────────────────────

  function _analyseEvents() {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now = Date.now();
    var cutoff = now - 12 * 60 * 60 * 1000; // 12h for social velocity

    // Filter to REDDIT/GDELT sourced events, OR events with meaningful social velocity (>0.3)
    // Bug fix: ALL IC events have e.socialV defined (default 0), so checking !== undefined
    // would match every single event. Use a threshold of >0.3 instead.
    var socialEvents = IC.events.filter(function (e) {
      if (e.ts <= cutoff) return false;
      var src = (e.source || e.feed || '').toUpperCase();
      var isSocialSource = src.indexOf('REDDIT') !== -1 || src.indexOf('GDELT') !== -1 ||
                           src.indexOf('SOCIAL') !== -1;
      var hasSignificantVelocity = typeof e.socialV === 'number' && e.socialV > 0.3;
      return isSocialSource || hasSignificantVelocity;
    });

    _status.socialEventCount = socialEvents.length;

    if (!socialEvents.length) {
      _status.topRegions = [];
      _status.maxVelocity = 0;
      return;
    }

    // Group by region, sum socialV
    var byRegion = {};
    socialEvents.forEach(function (e) {
      var r = (e.region || 'GLOBAL').toUpperCase();
      if (!byRegion[r]) byRegion[r] = { events: [], totalV: 0 };
      byRegion[r].events.push(e);
      // Use socialV if present, else use signal/severity as proxy
      var v = (e.socialV !== undefined) ? parseFloat(e.socialV) : ((e.signal || e.severity || 50) / 50);
      byRegion[r].totalV += v;
    });

    // Sort regions by velocity
    var regions = Object.keys(byRegion).sort(function (a, b) {
      return byRegion[b].totalV - byRegion[a].totalV;
    });

    _status.topRegions = regions.slice(0, 5);
    _status.maxVelocity = regions.length ? byRegion[regions[0]].totalV : 0;

    // Emit signals for regions above threshold
    regions.forEach(function (region) {
      var totalV = byRegion[region].totalV;
      if (totalV < VELOCITY_THRESHOLD) return;

      var conf = _clamp(totalV / 5, 0.25, MAX_CONF);
      var evtCount = byRegion[region].events.length;
      var asset = _getAsset(region);

      // Get prior from regionStates
      var prior = 0.20;
      if (IC.regionStates && IC.regionStates[region]) {
        prior = _clamp((IC.regionStates[region].prob || 0) / 100, 0.05, 0.90);
      }
      conf = conf * (0.6 + prior * 0.4);

      _pushSignal({
        source: 'social',
        asset: asset,
        bias: 'long', // social velocity → risk attention → safe-haven or commodity bias
        confidence: _clamp(conf, 0.20, MAX_CONF),
        reasoning: 'Social velocity ' + totalV.toFixed(1) + ' in ' + region +
          ' (' + evtCount + ' GDELT/Reddit events, 12h window)',
        region: region,
        evidenceKeys: ['social', 'gdelt', 'reddit', 'velocity']
      });
    });

    // Sudden viral spike (single region >> others)
    if (regions.length >= 2) {
      var topV = byRegion[regions[0]].totalV;
      var secondV = byRegion[regions[1]].totalV;
      if (topV > 6 && topV > secondV * 2.5) {
        var virRegion = regions[0];
        _pushSignal({
          source: 'social',
          asset: _getAsset(virRegion),
          bias: 'long',
          confidence: _clamp(topV / 10, 0.50, MAX_CONF),
          reasoning: 'VIRAL SPIKE: ' + virRegion + ' social velocity ' + topV.toFixed(1) +
            ' — ' + topV.toFixed(1) + 'x above secondary region (' + secondV.toFixed(1) + ')',
          region: virRegion,
          evidenceKeys: ['social', 'viral', 'gdelt']
        });
      }
    }
  }

  // ── public poll ────────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    _analyseEvents();
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII_AGENT_SOCIAL = {
    poll: poll,
    signals: function () { return _signals.slice(); },
    status: function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); }
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 7000);
  });

})();
