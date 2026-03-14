/* GII Sanctions Agent — gii-sanctions.js v2
 * Monitors sanctions, embargoes, and financial restrictions
 * Reads: window.__IC.events, window.__IC.regionStates
 * Exposes: window.GII_AGENT_SANCTIONS
 */
(function () {
  'use strict';

  var MAX_SIGNALS = 20;
  var POLL_INTERVAL = 72000;

  var SANCTION_KEYWORDS = [
    'sanction', 'embargo', 'swift', 'asset freeze', 'export ban', 'blacklist',
    'travel ban', 'arms embargo', 'trade restriction', 'financial restriction',
    'import ban', 'oil embargo', 'tech ban', 'chip ban', 'semiconductor ban',
    'trade war', 'tariff', 'counter-sanction', 'secondary sanction', 'ofac',
    'designation', 'restricted list', 'entity list', 'sdn list'
  ];

  // Classify sanctions into impact categories
  var ENERGY_TERMS = ['oil', 'gas', 'energy', 'petroleum', 'lng', 'pipeline', 'refinery'];
  var FINANCIAL_TERMS = ['swift', 'bank', 'finance', 'currency', 'capital', 'dollar', 'payment'];
  var TECH_TERMS = ['chip', 'semiconductor', 'tech', 'ai', 'military technology', 'dual use', 'tsmc', 'nvidia', 'amd'];

  // Typical assets affected by each sanction type
  var ENERGY_ASSETS = ['WTI', 'BRENT', 'XLE'];
  var FINANCIAL_ASSETS = ['BTC', 'GLD'];
  var TECH_ASSETS = ['TSM', 'SMH', 'SOXX'];

  var _signals = [];
  var _status = {
    lastPoll: null,
    sanctionEventCount: 0,
    energySanctions: 0,
    financialSanctions: 0,
    techSanctions: 0,
    affectedRegions: []
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

  function _matchesSanction(text) { return _matchesKeywords(text, SANCTION_KEYWORDS); }
  function _matchesEnergy(text)   { return _matchesKeywords(text, ENERGY_TERMS); }
  function _matchesFinancial(text){ return _matchesKeywords(text, FINANCIAL_TERMS); }
  function _matchesTech(text)     { return _matchesKeywords(text, TECH_TERMS); }

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  // ── analysis ───────────────────────────────────────────────────────────────

  function _analyseEvents() {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now = Date.now();
    var cutoff = now - 24 * 60 * 60 * 1000;

    // Filter to sanction events
    var sanctionEvents = IC.events.filter(function (e) {
      var text = e.headline || e.text || e.title || '';
      return e.ts > cutoff && _matchesSanction(text);
    });

    _status.sanctionEventCount = sanctionEvents.length;
    if (!sanctionEvents.length) return;

    // Classify and count
    var energyEvts = [];
    var finEvts = [];
    var techEvts = [];
    var regions = {};

    sanctionEvents.forEach(function (e) {
      var text = e.headline || e.text || e.title || '';
      var region = (e.region || 'GLOBAL').toUpperCase();
      regions[region] = true;

      if (_matchesEnergy(text)) energyEvts.push(e);
      if (_matchesFinancial(text)) finEvts.push(e);
      if (_matchesTech(text)) techEvts.push(e);
    });

    _status.energySanctions = energyEvts.length;
    _status.financialSanctions = finEvts.length;
    _status.techSanctions = techEvts.length;
    _status.affectedRegions = Object.keys(regions);

    // Get prior boosts from region states
    function _getPrior(region) {
      if (!IC.regionStates) return 0.20;
      var rs = IC.regionStates[region];
      return rs ? _clamp((rs.prob || 0) / 100, 0.05, 0.90) : 0.20;
    }

    // Energy sanctions → WTI/BRENT long
    if (energyEvts.length > 0) {
      energyEvts.sort(function (a, b) { return (b.signal || 0) - (a.signal || 0); });
      var topE = energyEvts[0];
      var topESig = topE.signal || topE.severity || 55;
      var priorE = Math.max.apply(null, _status.affectedRegions.map(_getPrior));
      var confE = _clamp(topESig / 100 * 0.75 * (0.5 + priorE), 0.30, 0.82);
      var headline = topE.headline || topE.text || '';

      ENERGY_ASSETS.forEach(function (asset, idx) {
        _pushSignal({
          source: 'sanctions',
          asset: asset,
          bias: 'long',
          confidence: _clamp(confE * (1.0 - idx * 0.10), 0.25, 0.82),
          reasoning: energyEvts.length + ' energy sanction events | top: ' + headline.substring(0, 70),
          region: topE.region || 'GLOBAL',
          evidenceKeys: ['sanction', 'embargo', 'oil']
        });
      });
    }

    // Financial sanctions → BTC/GLD
    if (finEvts.length > 0) {
      finEvts.sort(function (a, b) { return (b.signal || 0) - (a.signal || 0); });
      var topF = finEvts[0];
      var topFSig = topF.signal || topF.severity || 55;
      var confF = _clamp(topFSig / 100 * 0.70, 0.28, 0.78);

      // SWIFT ban → GLD long, BTC depends on direction
      var swiftBan = (topF.headline || topF.text || '').toLowerCase().indexOf('swift') !== -1;
      _pushSignal({
        source: 'sanctions',
        asset: 'GLD',
        bias: 'long',
        confidence: _clamp(confF, 0.28, 0.78),
        reasoning: 'Financial sanction/SWIFT event → GLD safe haven | ' + (topF.headline || '').substring(0, 60),
        region: topF.region || 'GLOBAL',
        evidenceKeys: ['swift', 'sanction', 'financial']
      });
      if (swiftBan) {
        _pushSignal({
          source: 'sanctions',
          asset: 'BTC',
          bias: 'long',
          confidence: _clamp(confF * 0.70, 0.20, 0.65),
          reasoning: 'SWIFT ban drives demand for censorship-resistant settlement',
          region: topF.region || 'GLOBAL',
          evidenceKeys: ['swift', 'sanctions', 'bitcoin']
        });
      }
    }

    // Tech sanctions → TSM/SMH short
    if (techEvts.length > 0) {
      techEvts.sort(function (a, b) { return (b.signal || 0) - (a.signal || 0); });
      var topT = techEvts[0];
      var topTSig = topT.signal || topT.severity || 55;
      var confT = _clamp(topTSig / 100 * 0.72, 0.28, 0.78);

      TECH_ASSETS.forEach(function (asset, idx) {
        _pushSignal({
          source: 'sanctions',
          asset: asset,
          bias: 'short',
          confidence: _clamp(confT * (1.0 - idx * 0.08), 0.22, 0.75),
          reasoning: techEvts.length + ' tech ban/chip sanction events | top: ' + (topT.headline || '').substring(0, 60),
          region: topT.region || 'GLOBAL',
          evidenceKeys: ['chip ban', 'semiconductor ban', 'tech']
        });
      });
    }
  }

  // ── public poll ────────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    _analyseEvents();
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII_AGENT_SANCTIONS = {
    poll: poll,
    signals: function () { return _signals.slice(); },
    status: function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); }
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 6800);
  });

})();
