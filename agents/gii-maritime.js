/* GII Maritime Agent — gii-maritime.js v2
 * Monitors maritime chokepoints, naval movements, Hormuz pattern
 * Reads: window.__IC.events (sbFeed: 'maritime'/'aircraft')
 * Exposes: window.GII_AGENT_MARITIME
 */
(function () {
  'use strict';

  var MAX_SIGNALS = 20;
  var POLL_INTERVAL = 68000;

  var MARITIME_KEYWORDS = [
    'tanker', 'vessel', 'ship', 'maritime', 'naval', 'fleet', 'warship',
    'chokepoint', 'strait', 'hormuz', 'suez', 'bab al-mandab', 'malacca',
    'red sea', 'persian gulf', 'gulf of oman', 'arabian sea'
  ];

  var REROUTING_KEYWORDS = [
    'rerouting', 'ais', 'tanker avoidance', 'diversion', 'rerouted', 'ais gap',
    'dark ship', 'ais off', 'transponder off', 'ais manipulation', 'avoiding'
  ];

  var NAVAL_CONCENTRATION_KEYWORDS = [
    'aircraft carrier', 'destroyer', 'frigate', 'carrier strike group',
    'naval exercise', 'naval deployment', 'warship deployment', 'fleet movement',
    'carrier group', 'naval buildup', 'amphibious', 'submarine'
  ];

  var INSURANCE_KEYWORDS = [
    'war risk insurance', 'tanker insurance', 'lloyd\'s', 'marine insurance premium',
    'hull insurance', 'p&i club', 'shipping insurance', 'war risk surcharge'
  ];

  var IRGC_KEYWORDS = [
    'irgc', 'revolutionary guard', 'iran navy', 'iranian vessel', 'iran seized',
    'iran threat', 'iran strait', 'iran hormuz', 'iran naval', 'iranian naval'
  ];

  var _signals = [];
  var _status = {
    lastPoll: null,
    maritimeEventCount: 0,
    hormuzPatternScore: {
      tankerInsurance: false,
      aisRerouting: false,
      navalMovement: false,
      irgcRhetoric: false,
      totalScore: 0
    }
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

  // ── sub-detectors ──────────────────────────────────────────────────────────

  function _detectAISRerouting(events) {
    return events.some(function (e) {
      return _matchesKeywords(e.headline || e.text || '', REROUTING_KEYWORDS);
    });
  }

  function _detectNavalConcentration(events) {
    // Naval concentration in MIDDLE EAST / HORMUZ
    return events.some(function (e) {
      var text = e.headline || e.text || e.title || '';
      var region = (e.region || '').toUpperCase();
      return _matchesKeywords(text, NAVAL_CONCENTRATION_KEYWORDS) &&
        (region.indexOf('MIDDLE EAST') !== -1 ||
         region.indexOf('HORMUZ') !== -1 ||
         region.indexOf('GULF') !== -1 ||
         region.indexOf('IRAN') !== -1 ||
         text.toLowerCase().indexOf('hormuz') !== -1 ||
         text.toLowerCase().indexOf('persian gulf') !== -1);
    });
  }

  function _detectInsurancePremiums(events) {
    return events.some(function (e) {
      return _matchesKeywords(e.headline || e.text || '', INSURANCE_KEYWORDS);
    });
  }

  function _detectIRGCRhetoric(events) {
    return events.some(function (e) {
      return _matchesKeywords(e.headline || e.text || '', IRGC_KEYWORDS);
    });
  }

  function _getHormuzPatternScore(events) {
    var tankerInsurance = _detectInsurancePremiums(events);
    var aisRerouting    = _detectAISRerouting(events);
    var navalMovement   = _detectNavalConcentration(events);
    var irgcRhetoric    = _detectIRGCRhetoric(events);

    var score = 0;
    if (tankerInsurance) score += 3;
    if (aisRerouting)    score += 3;
    if (navalMovement)   score += 2;
    if (irgcRhetoric)    score += 2;

    return {
      tankerInsurance: tankerInsurance,
      aisRerouting: aisRerouting,
      navalMovement: navalMovement,
      irgcRhetoric: irgcRhetoric,
      totalScore: score
    };
  }

  // ── analysis ───────────────────────────────────────────────────────────────

  function _analyseEvents() {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now = Date.now();
    var cutoff = now - 24 * 60 * 60 * 1000;

    // Get maritime/aircraft events — either sbFeed tagged or keyword match
    var maritimeEvents = IC.events.filter(function (e) {
      if (e.ts <= cutoff) return false;
      if (e.sbFeed === 'maritime' || e.sbFeed === 'aircraft') return true;
      var text = e.headline || e.text || e.title || '';
      return _matchesKeywords(text, MARITIME_KEYWORDS);
    });

    _status.maritimeEventCount = maritimeEvents.length;

    // Compute Hormuz pattern
    var hPattern = _getHormuzPatternScore(maritimeEvents);
    _status.hormuzPatternScore = hPattern;

    // AIS rerouting signal
    if (hPattern.aisRerouting) {
      var reroutCount = maritimeEvents.filter(function (e) {
        return _matchesKeywords(e.headline || e.text || '', REROUTING_KEYWORDS);
      }).length;
      _pushSignal({
        source: 'maritime',
        asset: 'WTI',
        bias: 'long',
        confidence: _clamp(0.45 + reroutCount * 0.04, 0.40, 0.78),
        reasoning: 'AIS rerouting/avoidance detected (' + reroutCount + ' events) → Hormuz supply risk',
        region: 'STRAIT OF HORMUZ',
        evidenceKeys: ['ais', 'rerouting', 'tanker avoidance']
      });
    }

    // Naval concentration signal
    if (hPattern.navalMovement) {
      var navalCount = maritimeEvents.filter(function (e) {
        return _matchesKeywords(e.headline || e.text || '', NAVAL_CONCENTRATION_KEYWORDS);
      }).length;
      _pushSignal({
        source: 'maritime',
        asset: 'WTI',
        bias: 'long',
        confidence: _clamp(0.40 + navalCount * 0.05, 0.35, 0.75),
        reasoning: 'Naval concentration in Gulf region (' + navalCount + ' vessel events)',
        region: 'MIDDLE EAST',
        evidenceKeys: ['aircraft carrier', 'destroyer', 'naval deployment']
      });
    }

    // War risk insurance spike
    if (hPattern.tankerInsurance) {
      _pushSignal({
        source: 'maritime',
        asset: 'BRENT',
        bias: 'long',
        confidence: 0.65,
        reasoning: 'War risk insurance premiums elevated → tanker route disruption priced in',
        region: 'STRAIT OF HORMUZ',
        evidenceKeys: ['war risk insurance', 'lloyd\'s', 'tanker insurance']
      });
    }

    // IRGC rhetoric
    if (hPattern.irgcRhetoric) {
      _pushSignal({
        source: 'maritime',
        asset: 'WTI',
        bias: 'long',
        confidence: 0.55,
        reasoning: 'IRGC/Iranian naval rhetoric detected → Hormuz closure threat',
        region: 'IRAN',
        evidenceKeys: ['irgc', 'iranian naval', 'hormuz']
      });
    }

    // Full Hormuz pattern triggered
    if (hPattern.totalScore >= 3) {
      _pushSignal({
        source: 'maritime',
        asset: 'XLE',
        bias: 'long',
        confidence: _clamp(0.55 + hPattern.totalScore * 0.04, 0.55, 0.88),
        reasoning: 'HORMUZ PATTERN ACTIVE (score ' + hPattern.totalScore + '/10): ' +
          [hPattern.tankerInsurance ? 'insurance↑' : '',
           hPattern.aisRerouting ? 'AIS-rerouting' : '',
           hPattern.navalMovement ? 'naval-conc' : '',
           hPattern.irgcRhetoric ? 'IRGC-rhetoric' : ''].filter(Boolean).join(', '),
        region: 'STRAIT OF HORMUZ',
        evidenceKeys: ['hormuz', 'tanker', 'irgc', 'war risk insurance']
      });
    }

    // Red Sea general signal
    var redSeaEvents = maritimeEvents.filter(function (e) {
      var text = (e.headline || e.text || e.region || '').toLowerCase();
      return text.indexOf('red sea') !== -1 || text.indexOf('bab al') !== -1 || text.indexOf('houthi') !== -1;
    });
    if (redSeaEvents.length >= 2) {
      _pushSignal({
        source: 'maritime',
        asset: 'WTI',
        bias: 'long',
        confidence: _clamp(0.35 + redSeaEvents.length * 0.05, 0.35, 0.72),
        reasoning: 'Red Sea/Bab-al-Mandab disruption (' + redSeaEvents.length + ' events) → energy route risk',
        region: 'RED SEA',
        evidenceKeys: ['red sea', 'houthi', 'suez']
      });
    }
  }

  // ── public poll ────────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    _analyseEvents();
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII_AGENT_MARITIME = {
    poll: poll,
    signals: function () { return _signals.slice(); },
    status: function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); },
    getHormuzPattern: function () { return Object.assign({}, _status.hormuzPatternScore); }
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 6900);
  });

})();
