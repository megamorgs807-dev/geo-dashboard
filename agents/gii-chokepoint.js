/* GII Strategic Chokepoint Agent — gii-chokepoint.js v1
 * Dedicated per-strait monitoring for all 5 major global chokepoints.
 * Complements gii-maritime.js (which focuses on Hormuz pattern detection)
 * by giving equal depth to every major strait.
 *
 * Chokepoints monitored:
 *   - Strait of Hormuz      (21% global oil — WTI/BRENT)
 *   - Suez Canal / Red Sea  (12% global oil — BRENT)
 *   - Bab el-Mandeb Strait  (9%  global oil — BRENT)
 *   - Strait of Malacca     (16% global oil to Asia — WTI)
 *   - Taiwan Strait         (semiconductor supply chain — TSM/SMH)
 *
 * Reads: window.__IC.events
 * Exposes: window.GII_AGENT_CHOKEPOINT
 */
(function () {
  'use strict';

  var MAX_SIGNALS   = 20;
  var POLL_INTERVAL = 78000;

  // ── Chokepoint definitions ────────────────────────────────────────────────
  // Each chokepoint has 4 signal categories:
  //   routing   (weight 2) — rerouting, avoidance, transit closure
  //   insurance (weight 3) — war risk premium, insurance spike
  //   naval     (weight 2) — military deployments, exercises, incidents
  //   port      (weight 1) — congestion, closures, delays

  var CHOKEPOINTS = {
    HORMUZ: {
      label:        'Strait of Hormuz',
      region:       'STRAIT OF HORMUZ',
      assets:       ['WTI', 'BRENT'],
      primaryAsset: 'WTI',
      threshold:    3,
      keywords: {
        routing:   ['hormuz', 'persian gulf shipping', 'gulf tanker rerouting', 'iran strait closure',
                    'tanker avoidance hormuz', 'gulf shipping disruption'],
        insurance: ['war risk hormuz', 'hormuz insurance premium', 'gulf war risk', 'tanker insurance gulf',
                    'shipping insurance hormuz', 'gulf war risk surcharge'],
        naval:     ['5th fleet', 'irgc navy', 'iran mine', 'mine laying hormuz', 'iran naval hormuz',
                    'revolutionary guard navy', 'us carrier hormuz', 'naval confrontation gulf'],
        port:      ['bandar abbas', 'ras tanura congestion', 'gulf port closure', 'fujairah disruption',
                    'jebel ali closure', 'gulf terminal shutdown']
      }
    },

    SUEZ: {
      label:        'Suez Canal / Red Sea',
      region:       'RED SEA',
      assets:       ['BRENT', 'WTI'],
      primaryAsset: 'BRENT',
      threshold:    3,
      keywords: {
        routing:   ['suez canal', 'red sea shipping', 'cape of good hope rerouting', 'suez rerouting',
                    'houthi shipping attack', 'red sea avoidance', 'suez transit suspended'],
        insurance: ['red sea insurance', 'war risk red sea', 'suez insurance premium',
                    'red sea war risk surcharge', 'shipping insurance red sea', 'houthi insurance'],
        naval:     ['houthi attack ship', 'red sea drone strike', 'houthi missile ship',
                    'carrier red sea', 'us navy red sea', 'coalition red sea', 'operation prosperity guardian'],
        port:      ['suez blockage', 'port said', 'suez canal closure', 'suez delay',
                    'ismailia port', 'red sea port congestion', 'jeddah disruption']
      }
    },

    BAB_AL_MANDEB: {
      label:        'Bab el-Mandeb Strait',
      region:       'RED SEA',
      assets:       ['BRENT', 'WTI'],
      primaryAsset: 'BRENT',
      threshold:    3,
      keywords: {
        routing:   ['bab al-mandeb', 'bab el mandeb', 'bab el-mandeb', 'mandeb strait',
                    'gulf of aden shipping', 'gulf of aden rerouting', 'mandeb closure'],
        insurance: ['gulf of aden insurance', 'mandeb war risk', 'bab al mandeb insurance',
                    'gulf of aden war risk surcharge'],
        naval:     ['houthi djibouti', 'gulf of aden naval', 'combined maritime forces',
                    'us destroyer gulf aden', 'mandeb military', 'gulf of aden incident'],
        port:      ['djibouti port', 'aden port congestion', 'gulf of aden port', 'bab al mandeb port',
                    'hodeidah port', 'aden terminal']
      }
    },

    MALACCA: {
      label:        'Strait of Malacca',
      region:       'SOUTH CHINA SEA',
      assets:       ['WTI', 'TSM'],
      primaryAsset: 'WTI',
      threshold:    3,
      keywords: {
        routing:   ['malacca strait', 'strait of malacca', 'malacca rerouting', 'malacca closure',
                    'singapore shipping disruption', 'malacca tanker', 'southeast asia shipping diversion'],
        insurance: ['malacca insurance', 'piracy malacca', 'southeast asia shipping risk',
                    'malacca war risk', 'south china sea shipping insurance'],
        naval:     ['china navy malacca', 'us navy malacca', 'malacca naval deployment',
                    'pla navy malacca', 'south china sea military', 'indonesia navy malacca'],
        port:      ['singapore port congestion', 'port klang', 'malacca port closure',
                    'singapore terminal disruption', 'batam port', 'johor port']
      }
    },

    TAIWAN: {
      label:        'Taiwan Strait',
      region:       'TAIWAN',
      assets:       ['TSM', 'SMH'],
      primaryAsset: 'TSM',
      threshold:    3,
      keywords: {
        routing:   ['taiwan strait shipping', 'taiwan strait closure', 'taiwan blockade shipping',
                    'taiwan strait transit blocked', 'taiwan shipping diversion', 'china blockade taiwan'],
        insurance: ['taiwan war risk', 'taiwan strait insurance', 'taiwan shipping insurance',
                    'taiwan war risk premium', 'taiwan strait war risk surcharge'],
        naval:     ['pla taiwan strait', 'china navy taiwan', 'carrier taiwan', 'taiwan strait military',
                    'pla naval exercise taiwan', 'chinese warship taiwan', 'taiwan strait exercise',
                    'us carrier taiwan', 'taiwan strait confrontation'],
        port:      ['kaohsiung port', 'keelung port', 'taiwan port closure', 'taichung port',
                    'taiwan terminal disruption', 'hualien port']
      }
    }
  };

  var _signals     = [];
  var _chokepointStatus = {}; // per-chokepoint score for status()
  var _status = {
    lastPoll:         null,
    activeChokepoints: [],
    multiStraitAlert:  false,
    highestScoreKey:   null
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  // ── helpers ───────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  function _countMatches(text, keywords) {
    if (!text) return 0;
    var t = text.toLowerCase();
    var count = 0;
    for (var i = 0; i < keywords.length; i++) {
      if (t.indexOf(keywords[i]) !== -1) count++;
    }
    return count;
  }

  // ── per-chokepoint scoring ────────────────────────────────────────────────

  function _scoreChokepoint(cpKey, cp, events) {
    var WEIGHTS = { routing: 2, insurance: 3, naval: 2, port: 1 };
    var scores  = { routing: 0, insurance: 0, naval: 0, port: 0, total: 0 };
    var matchedEvents = [];

    events.forEach(function (e) {
      var text = (e.title || e.headline || e.text || '').toLowerCase();
      var hit  = false;
      Object.keys(WEIGHTS).forEach(function (cat) {
        if (_countMatches(text, cp.keywords[cat]) > 0) {
          scores[cat]++;
          scores.total += WEIGHTS[cat];
          hit = true;
        }
      });
      if (hit) matchedEvents.push(e);
    });

    _chokepointStatus[cpKey] = {
      label:   cp.label,
      region:  cp.region,
      scores:  scores,
      active:  scores.total >= cp.threshold
    };

    return { scores: scores, matched: matchedEvents };
  }

  // ── analysis ──────────────────────────────────────────────────────────────

  function _analyseEvents() {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now    = Date.now();
    var cutoff = now - 24 * 60 * 60 * 1000;
    var recent = IC.events.filter(function (e) { return e.ts > cutoff; });

    var activeKeys  = [];
    var highestKey  = null;
    var highestScore = 0;

    Object.keys(CHOKEPOINTS).forEach(function (cpKey) {
      var cp     = CHOKEPOINTS[cpKey];
      var result = _scoreChokepoint(cpKey, cp, recent);
      var score  = result.scores.total;

      if (score < cp.threshold) return;  // below threshold — no signal

      activeKeys.push(cpKey);
      if (score > highestScore) { highestScore = score; highestKey = cpKey; }

      // Get prior from IC regionStates
      var prior = 0.25;
      if (IC.regionStates && IC.regionStates[cp.region]) {
        prior = _clamp((IC.regionStates[cp.region].prob || 0) / 100, 0.05, 0.90);
      }

      // Confidence: scaled by score and prior
      var baseConf = _clamp(0.35 + score * 0.05, 0.35, 0.82);
      var conf     = _clamp(baseConf * (0.6 + prior * 0.4), 0.28, 0.85);

      // Build reasoning string with which categories fired
      var cats = [];
      var WEIGHTS = { routing: 2, insurance: 3, naval: 2, port: 1 };
      Object.keys(WEIGHTS).forEach(function (cat) {
        if (result.scores[cat] > 0) cats.push(cat + '(' + result.scores[cat] + ')');
      });

      // Primary asset signal
      _pushSignal({
        source:       'chokepoint',
        asset:        cp.primaryAsset,
        bias:         'long',
        confidence:   conf,
        reasoning:    cp.label + ' stress (score ' + score + ') — ' + cats.join(', '),
        region:       cp.region,
        evidenceKeys: [cpKey.toLowerCase(), 'chokepoint', 'shipping']
      });

      // Secondary asset if different
      if (cp.assets.length > 1) {
        _pushSignal({
          source:       'chokepoint',
          asset:        cp.assets[1],
          bias:         'long',
          confidence:   _clamp(conf * 0.85, 0.22, 0.78),
          reasoning:    cp.label + ' stress — secondary asset (score ' + score + ')',
          region:       cp.region,
          evidenceKeys: [cpKey.toLowerCase(), 'chokepoint', 'secondary']
        });
      }

      // Insurance-specific sub-signal (highest weight category)
      if (result.scores.insurance >= 2) {
        _pushSignal({
          source:       'chokepoint',
          asset:        'GLD',
          bias:         'long',
          confidence:   _clamp(conf * 0.80, 0.25, 0.75),
          reasoning:    cp.label + ' war-risk insurance spike — geopolitical risk premium rising',
          region:       cp.region,
          evidenceKeys: ['war risk insurance', cpKey.toLowerCase(), 'shipping insurance']
        });
      }
    });

    // ── Multi-strait alert: 2+ chokepoints active simultaneously ─────────

    if (activeKeys.length >= 2) {
      _status.multiStraitAlert = true;
      var globalConf = _clamp(0.55 + activeKeys.length * 0.06, 0.55, 0.88);
      _pushSignal({
        source:       'chokepoint',
        asset:        'GLD',
        bias:         'long',
        confidence:   globalConf,
        reasoning:    'MULTI-STRAIT ALERT: ' + activeKeys.length + ' chokepoints active (' +
                      activeKeys.map(function (k) { return CHOKEPOINTS[k].label; }).join(', ') + ')',
        region:       'GLOBAL',
        evidenceKeys: ['multi-strait', 'global shipping', 'chokepoint']
      });
      // Energy markets specifically threatened
      _pushSignal({
        source:       'chokepoint',
        asset:        'XLE',
        bias:         'long',
        confidence:   _clamp(globalConf * 0.90, 0.48, 0.82),
        reasoning:    'Multi-strait disruption — global energy supply chain under simultaneous pressure',
        region:       'GLOBAL',
        evidenceKeys: ['energy supply', 'multi-strait', 'oil disruption']
      });
    } else {
      _status.multiStraitAlert = false;
    }

    _status.activeChokepoints = activeKeys;
    _status.highestScoreKey   = highestKey;
  }

  // ── public poll ───────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    _analyseEvents();
  }

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_AGENT_CHOKEPOINT = {
    poll:             poll,
    signals:          function () { return _signals.slice(); },
    status:           function () { return Object.assign({}, _status); },
    accuracy:         function () { return Object.assign({}, _accuracy); },
    chokepointScores: function () { return Object.assign({}, _chokepointStatus); } // extra: per-strait scores for UI
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 9100);
  });

})();
