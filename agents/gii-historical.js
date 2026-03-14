/* GII Historical Pattern Agent — gii-historical.js v1
 * Detects recurring patterns, seasonal cycles, and escalation rhythms
 * Reads: window.__IC.events (full archive), window.__IC.regionStates
 * Stores: localStorage 'gii_historical_v1' — pattern baseline cache
 * Exposes: window.GII_AGENT_HISTORICAL
 */
(function () {
  'use strict';

  var MAX_SIGNALS   = 20;
  var POLL_INTERVAL = 120000;  // 2 min — slower, more expensive analysis
  var STORAGE_KEY   = 'gii_historical_v1';

  // ── Seasonal patterns ──────────────────────────────────────────────────────
  // Each pattern: { months: [1-12], regions, assets, bias, conf, label }
  // Active when current month is in the list

  var SEASONAL_PATTERNS = [
    {
      id:      'winter_gas',
      months:  [11, 12, 1, 2, 3],
      regions: ['RUSSIA', 'UKRAINE', 'EASTERN EUROPE'],
      assets:  ['GLD', 'XLE'],
      bias:    'long',
      conf:    0.55,
      label:   'Winter gas demand season — Europe energy stress historically peaks Q4-Q1'
    },
    {
      id:      'summer_oil',
      months:  [6, 7, 8],
      regions: ['MIDDLE EAST', 'IRAN', 'STRAIT OF HORMUZ'],
      assets:  ['WTI', 'BRENT'],
      bias:    'long',
      conf:    0.48,
      label:   'Summer driving season + Middle East heat — crude demand historically elevated'
    },
    {
      id:      'spring_escalation',
      months:  [3, 4, 5],
      regions: ['UKRAINE', 'RUSSIA', 'MIDDLE EAST'],
      assets:  ['GLD', 'WTI'],
      bias:    'long',
      conf:    0.52,
      label:   'Spring escalation window — military campaigns historically initiate Mar-May'
    },
    {
      id:      'opec_q4_cuts',
      months:  [10, 11],
      regions: ['MIDDLE EAST', 'GLOBAL'],
      assets:  ['WTI', 'BRENT', 'XLE'],
      bias:    'long',
      conf:    0.50,
      label:   'OPEC output review season — production cuts historically announced Q4'
    },
    {
      id:      'year_end_risk_off',
      months:  [12],
      regions: ['GLOBAL'],
      assets:  ['GLD'],
      bias:    'long',
      conf:    0.45,
      label:   'Year-end portfolio rebalancing — risk-off positioning historically elevated in December'
    },
    {
      id:      'taiwan_strait_spring',
      months:  [3, 4, 8, 9],
      regions: ['TAIWAN', 'SOUTH CHINA SEA'],
      assets:  ['TSM', 'GLD'],
      bias:    'long',
      conf:    0.45,
      label:   'Taiwan Strait tension seasonal peak — PLA exercises historically cluster Mar-Apr, Aug-Sep'
    }
  ];

  // ── Escalation velocity patterns ───────────────────────────────────────────
  // Detects when a region's signal density has been rising over 3 consecutive periods

  var ESCALATION_WINDOW_H = 6;  // hours per window
  var ESCALATION_WINDOWS  = 3;  // number of windows to compare

  var _signals  = [];
  var _baseline = {};  // { region: { windows: [count0, count1, count2], lastTs } }
  var _status = {
    lastPoll:        null,
    activePatterns:  [],
    escalatingRegions: []
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  // ── storage ────────────────────────────────────────────────────────────────

  function _loadBaseline() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      _baseline = raw ? JSON.parse(raw) : {};
    } catch (e) { _baseline = {}; }
  }

  function _saveBaseline() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_baseline)); } catch (e) {}
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  function _currentMonth() {
    return new Date().getMonth() + 1; // 1-12
  }

  // ── Seasonal pattern analysis ──────────────────────────────────────────────

  function _checkSeasonalPatterns() {
    var month = _currentMonth();
    var IC = window.__IC;
    var activePatterns = [];

    SEASONAL_PATTERNS.forEach(function (pat) {
      if (pat.months.indexOf(month) === -1) return;

      // Check if any of the pattern's regions are currently active in IC
      var regionActive = false;
      if (IC && IC.regionStates) {
        pat.regions.forEach(function (r) {
          if (IC.regionStates[r] && (IC.regionStates[r].prob || 0) > 20) regionActive = true;
        });
      }

      // Emit signal — confidence boosted if region is already active
      var conf = regionActive ? _clamp(pat.conf * 1.20, 0, 0.85) : pat.conf;
      activePatterns.push(pat.id);

      pat.assets.forEach(function (asset, idx) {
        _pushSignal({
          source:      'historical',
          asset:       asset,
          bias:        pat.bias,
          confidence:  _clamp(conf * (1.0 - idx * 0.05), 0.30, 0.85),
          reasoning:   '[SEASONAL] ' + pat.label + (regionActive ? ' [REGION ACTIVE +boost]' : ''),
          region:      pat.regions[0] || 'GLOBAL',
          evidenceKeys: ['seasonal', 'pattern', 'historical']
        });
      });
    });

    _status.activePatterns = activePatterns;
  }

  // ── Escalation velocity detection ─────────────────────────────────────────

  function _checkEscalationVelocity() {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now = Date.now();
    var windowMs = ESCALATION_WINDOW_H * 60 * 60 * 1000;

    // Build windowed event counts per region
    var byRegion = {};
    IC.events.forEach(function (e) {
      if (!e.ts || !e.region) return;
      var sig = e.signal || e.severity || 0;
      if (sig < 50) return; // ignore low-signal noise
      var r = e.region.toUpperCase();
      if (!byRegion[r]) byRegion[r] = [];
      byRegion[r].push(e.ts);
    });

    var escalating = [];

    Object.keys(byRegion).forEach(function (region) {
      var timestamps = byRegion[region].sort(function (a, b) { return b - a; }); // newest first

      // Count events in each window (w0=most recent, w1=previous, w2=oldest)
      var windows = [];
      for (var w = 0; w < ESCALATION_WINDOWS; w++) {
        var wStart = now - (w + 1) * windowMs;
        var wEnd   = now - w * windowMs;
        var count  = timestamps.filter(function (ts) { return ts >= wStart && ts < wEnd; }).length;
        windows.unshift(count); // oldest first → [w2, w1, w0]
      }

      // Detect rising pattern: each window must have more events than previous
      var isRising = windows[0] > 0 &&
                     windows[1] > windows[0] &&
                     windows[2] > windows[1];

      // Detect acceleration: rate of increase also rising
      var delta1 = windows[1] - windows[0];
      var delta2 = windows[2] - windows[1];
      var isAccelerating = isRising && delta2 > delta1;

      // Update baseline cache
      if (!_baseline[region]) _baseline[region] = { windows: [], lastTs: 0 };
      _baseline[region].windows = windows;
      _baseline[region].lastTs  = now;

      if (!isRising) return;

      escalating.push(region);

      // Determine asset for region
      var IC2 = window.__IC;
      var assets = [];
      if (IC2 && IC2.regionStates && IC2.regionStates[region]) {
        assets = (IC2.regionStates[region].assets || []).slice(0, 2);
      }
      if (!assets.length) assets = ['GLD'];

      var velocityConf = _clamp(
        0.40 + (windows[2] - windows[0]) * 0.03 + (isAccelerating ? 0.10 : 0),
        0.35, 0.80
      );

      assets.forEach(function (asset, idx) {
        _pushSignal({
          source:      'historical',
          asset:       asset,
          bias:        'long',
          confidence:  _clamp(velocityConf * (1.0 - idx * 0.08), 0.28, 0.80),
          reasoning:   '[ESCALATION VELOCITY] ' + region +
            ' — event density rising: ' + windows.join('→') +
            (isAccelerating ? ' [ACCELERATING]' : ''),
          region:      region,
          evidenceKeys: ['escalation velocity', 'pattern', 'trend']
        });
      });
    });

    _status.escalatingRegions = escalating;
    _saveBaseline();
  }

  // ── Repeated escalation cycle detection ───────────────────────────────────
  // If we've seen multiple escalation/de-escalation cycles in a region,
  // a re-escalation from a quiet period is meaningful

  function _checkCyclePattern() {
    var IC = window.__IC;
    if (!IC || !IC.regionStates) return;

    Object.keys(_baseline).forEach(function (region) {
      var bl = _baseline[region];
      if (!bl || !bl.windows || bl.windows.length < 3) return;

      var rs = IC && IC.regionStates && IC.regionStates[region];
      if (!rs) return;

      var currentProb  = (rs.prob || 0) / 100;
      var signalCount  = rs.signalCount || 0;

      // Pattern: region was quiet (low windows) then sudden signal spike
      var wasQuiet   = bl.windows[0] <= 1 && bl.windows[1] <= 1;
      var nowActive  = bl.windows[2] >= 3;
      if (!wasQuiet || !nowActive) return;

      // Determine assets
      var assets = (rs.assets || ['GLD']).slice(0, 2);

      var conf = _clamp(0.45 + signalCount * 0.02 + currentProb * 0.20, 0.40, 0.78);
      _pushSignal({
        source:      'historical',
        asset:       assets[0],
        bias:        'long',
        confidence:  conf,
        reasoning:   '[CYCLE PATTERN] ' + region + ' re-activating after quiet period' +
          ' (' + bl.windows.join('→') + ' events/window) — historical pattern of sudden escalation',
        region:      region,
        evidenceKeys: ['cycle pattern', 're-escalation', 'historical']
      });
    });
  }

  // ── public poll ────────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    _checkSeasonalPatterns();
    _checkEscalationVelocity();
    _checkCyclePattern();
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII_AGENT_HISTORICAL = {
    poll:     poll,
    signals:  function () { return _signals.slice(); },
    status:   function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); },
    baseline: function () { return Object.assign({}, _baseline); }
  };

  window.addEventListener('load', function () {
    _loadBaseline();
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 7400);
  });

})();
