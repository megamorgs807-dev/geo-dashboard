/* GII Narrative Warfare Agent — gii-narrative.js v1
 * Detects coordinated narrative shifts that historically precede geopolitical actions.
 * Governments prepare the information environment BEFORE military, sanctions, or coup events.
 *
 * Narrative clusters monitored:
 *   PRE_MILITARY   — self-defence framing, territorial claims, existential threat rhetoric
 *   PRE_SANCTIONS  — human rights framing, economic aggression, accountability rhetoric
 *   PRE_COUP       — corruption narratives, national emergency, legitimacy attacks
 *   STATE_MEDIA    — coordinated state media amplification across multiple outlets
 *   ESCALATION     — synchronized diplomatic rhetoric, ultimatum language
 *
 * Detection logic:
 *   - Groups IC events by narrative cluster (12h window)
 *   - Scores by event count + source diversity + velocity (acceleration vs prior 12h)
 *   - Cross-cluster correlation bonus (e.g. PRE_MILITARY + STATE_MEDIA = stronger signal)
 *
 * Reads: window.__IC.events
 * Exposes: window.GII_AGENT_NARRATIVE
 */
(function () {
  'use strict';

  var MAX_SIGNALS      = 20;
  var POLL_INTERVAL    = 80000;
  var WINDOW_MS        = 12 * 60 * 60 * 1000; // 12h primary window
  var VELOCITY_WINDOW  =  6 * 60 * 60 * 1000; // 6h for velocity comparison
  var MIN_CONF         = 0.25;
  var MAX_CONF         = 0.82;

  // ── Narrative cluster definitions ─────────────────────────────────────────
  // threshold: minimum weighted score to emit a signal
  // asset: default asset if no region match found
  // keywords: phrases that indicate this narrative frame is being deployed

  var NARRATIVE_CLUSTERS = {

    PRE_MILITARY: {
      label:     'Pre-Military Escalation Narrative',
      threshold: 3,
      asset:     'GLD',
      leadTime:  '3–14 days before military action',
      keywords: [
        'self-defence', 'self-defense', 'right to defend', 'protect our citizens',
        'protecting nationals abroad', 'historic claim', 'historic territory',
        'territorial integrity violation', 'sovereign territory', 'our rightful territory',
        'existential threat', 'security threat cannot be ignored', 'forced to act',
        'unprovoked aggression', 'provocation will not stand', 'right to respond',
        'military readiness elevated', 'troops on high alert', 'forces mobilized',
        'defensive posture', 'cannot tolerate', 'red line crossed',
        'protecting ethnic', 'protecting compatriots', 'russophone', 'diaspora under threat',
        'security guarantees failed', 'peace impossible', 'diplomacy exhausted'
      ]
    },

    PRE_SANCTIONS: {
      label:     'Pre-Sanctions Justification Narrative',
      threshold: 3,
      asset:     'WTI',
      leadTime:  '2–10 days before sanctions announcement',
      keywords: [
        'human rights violations', 'human rights abuses', 'crimes against humanity',
        'war crimes committed', 'atrocities documented', 'civilian casualties confirmed',
        'economic aggression', 'economic coercion', 'predatory economics',
        'unfair trade practices', 'economic bullying', 'market manipulation',
        'destabilizing the region', 'regional destabilization', 'rogue state',
        'state sponsor of terrorism', 'sponsor of terror',
        'accountability demanded', 'consequences will follow', 'must be held accountable',
        'international law violated', 'international norms violated',
        'responsibility to protect', 'global community must act',
        'targeted measures', 'targeted sanctions', 'calibrated response',
        'comprehensive review', 'all options on the table'
      ]
    },

    PRE_COUP: {
      label:     'Pre-Coup Legitimacy Narrative',
      threshold: 3,
      asset:     'GLD',
      leadTime:  '1–5 days before coup attempt',
      keywords: [
        'government corruption', 'corrupt regime', 'kleptocracy', 'systemic corruption',
        'looting the state', 'state capture', 'oligarchy',
        'national emergency', 'constitutional crisis', 'institutional failure',
        'illegitimate government', 'illegitimate leader', 'stolen election',
        'protecting the people', 'restoring order', 'restoring democracy',
        'people demand change', 'popular uprising', 'the people have spoken',
        'military duty to protect', 'patriotic duty', 'saving the nation',
        'economic mismanagement', 'economic collapse imminent', 'failed state',
        'political vacuum', 'leadership vacuum', 'transition necessary'
      ]
    },

    STATE_MEDIA: {
      label:     'State Media Coordination Signal',
      threshold: 2,
      asset:     'GLD',
      leadTime:  '1–7 days before state action',
      keywords: [
        'russian state media', 'kremlin statement', 'tass reports', 'rt news',
        'xinhua official', 'cctv official', 'chinese state media', 'beijing statement',
        'iranian state media', 'press tv', 'official government statement',
        'foreign ministry statement', 'ministry of foreign affairs says',
        'government spokesman', 'official spokesman', 'official narrative',
        'state broadcaster', 'synchronized statement', 'coordinated messaging',
        'multiple officials', 'senior officials confirm', 'government sources',
        'narrative shift', 'messaging campaign', 'information campaign'
      ]
    },

    ESCALATION_RHETORIC: {
      label:     'Synchronized Escalation Rhetoric',
      threshold: 3,
      asset:     'GLD',
      leadTime:  '1–7 days before action',
      keywords: [
        'ultimatum issued', 'final ultimatum', 'deadline issued', 'deadline expires',
        'last chance for diplomacy', 'talks have failed', 'diplomatic options exhausted',
        'military option not off table', 'all options being considered',
        'catastrophic consequences', 'severe consequences', 'grave consequences',
        'point of no return', 'irreversible action', 'no turning back',
        'mobilization ordered', 'state of emergency declared', 'national mobilization',
        'war footing', 'preparing for conflict', 'full alert',
        'unacceptable situation', 'cannot be tolerated any longer'
      ]
    }
  };

  // Region-to-asset override (same as other agents)
  var REGION_ASSET = {
    'UKRAINE': 'GLD', 'RUSSIA': 'GLD', 'MIDDLE EAST': 'WTI',
    'IRAN': 'WTI', 'ISRAEL': 'GLD', 'TAIWAN': 'TSM',
    'CHINA': 'FXI', 'US': 'SPY', 'NORTH KOREA': 'GLD',
    'STRAIT OF HORMUZ': 'WTI', 'RED SEA': 'WTI', 'SOUTH CHINA SEA': 'TSM'
  };

  var _signals = [];
  var _status = {
    lastPoll:        null,
    clusterCounts:   {},  // { PRE_MILITARY: 3, ... }
    activeNarratives: [],
    coordinationScore: 0
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  // ── helpers ───────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  function _matchCount(text, keywords) {
    if (!text) return 0;
    var t = text.toLowerCase();
    var n = 0;
    for (var i = 0; i < keywords.length; i++) {
      if (t.indexOf(keywords[i]) !== -1) n++;
    }
    return n;
  }

  function _getAsset(region, defaultAsset) {
    var r = (region || '').toUpperCase();
    for (var key in REGION_ASSET) {
      if (r.indexOf(key) !== -1) return REGION_ASSET[key];
    }
    return defaultAsset || 'GLD';
  }

  // ── analysis ──────────────────────────────────────────────────────────────

  function _analyseEvents() {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now         = Date.now();
    var windowStart = now - WINDOW_MS;
    var velStart    = now - VELOCITY_WINDOW;
    var prevStart   = windowStart;           // 12h–6h ago (for velocity comparison)

    var windowEvents = IC.events.filter(function (e) { return e.ts > windowStart; });
    var recentEvents = IC.events.filter(function (e) { return e.ts > velStart; });
    var prevEvents   = IC.events.filter(function (e) { return e.ts > prevStart && e.ts <= velStart; });

    var clusterCounts  = {};
    var activeClusters = [];
    var coordinationScore = 0;

    Object.keys(NARRATIVE_CLUSTERS).forEach(function (clusterKey) {
      var cluster = NARRATIVE_CLUSTERS[clusterKey];

      // Classify window events against this cluster
      var matchedAll    = windowEvents.filter(function (e) {
        var text = (e.title || e.headline || e.text || '');
        return _matchCount(text, cluster.keywords) > 0;
      });
      var matchedRecent = recentEvents.filter(function (e) {
        var text = (e.title || e.headline || e.text || '');
        return _matchCount(text, cluster.keywords) > 0;
      });
      var matchedPrev = prevEvents.filter(function (e) {
        var text = (e.title || e.headline || e.text || '');
        return _matchCount(text, cluster.keywords) > 0;
      });

      clusterCounts[clusterKey] = matchedAll.length;

      if (matchedAll.length < cluster.threshold) return;

      activeClusters.push(clusterKey);
      coordinationScore += matchedAll.length;

      // ── Source diversity ─────────────────────────────────────────────────
      // More unique sources using same narrative = stronger coordination signal
      var sourceMap = {};
      matchedAll.forEach(function (e) {
        var src = (e.source || e.feed || 'unknown').toLowerCase();
        sourceMap[src] = true;
      });
      var sourceDiversity = Object.keys(sourceMap).length;

      // ── Velocity (acceleration) ──────────────────────────────────────────
      // Recent 6h vs prior 6h. velocity > 1 means accelerating.
      var velocity = matchedPrev.length > 0
        ? matchedRecent.length / matchedPrev.length
        : matchedRecent.length > 0 ? 2.0 : 1.0;

      // ── Region grouping ──────────────────────────────────────────────────
      var regionMap = {};
      matchedAll.forEach(function (e) {
        var r = (e.region || 'GLOBAL').toUpperCase();
        if (!regionMap[r]) regionMap[r] = 0;
        regionMap[r]++;
      });
      var topRegion = Object.keys(regionMap).sort(function (a, b) {
        return regionMap[b] - regionMap[a];
      })[0] || 'GLOBAL';

      // ── Confidence calculation ───────────────────────────────────────────
      var countFactor    = _clamp(matchedAll.length / 8, 0.30, 1.0);
      var diversityBonus = _clamp((sourceDiversity - 1) * 0.05, 0, 0.15);
      var velocityBonus  = velocity > 1.5 ? 0.08 : velocity > 1.0 ? 0.04 : 0;
      var conf           = _clamp(
        0.32 + countFactor * 0.45 + diversityBonus + velocityBonus,
        MIN_CONF, MAX_CONF
      );

      // Get IC region prior
      if (IC.regionStates && IC.regionStates[topRegion]) {
        var prior = _clamp((IC.regionStates[topRegion].prob || 0) / 100, 0.05, 0.90);
        conf = _clamp(conf * (0.7 + prior * 0.3), MIN_CONF, MAX_CONF);
      }

      var asset = _getAsset(topRegion, cluster.asset);

      var velLabel = velocity > 2.0 ? ' ⚡ACCELERATING' : velocity > 1.2 ? ' ↑rising' : '';
      var reasoning = '[' + cluster.label.toUpperCase() + '] ' +
                      matchedAll.length + ' events, ' + sourceDiversity + ' sources' + velLabel +
                      ' | ' + topRegion + ' | ' + cluster.leadTime;

      _pushSignal({
        source:       'narrative',
        asset:        asset,
        bias:         'long',
        confidence:   conf,
        reasoning:    reasoning,
        region:       topRegion,
        evidenceKeys: cluster.keywords.slice(0, 3)
      });
    });

    // ── Cross-cluster correlation: multiple narratives firing = stronger signal

    // PRE_MILITARY + STATE_MEDIA = war imminent composite
    if (activeClusters.indexOf('PRE_MILITARY') !== -1 &&
        activeClusters.indexOf('STATE_MEDIA') !== -1) {
      var warConf = _clamp(
        0.55 + (clusterCounts['PRE_MILITARY'] + clusterCounts['STATE_MEDIA']) * 0.025,
        0.55, 0.85
      );
      _pushSignal({
        source:       'narrative',
        asset:        'GLD',
        bias:         'long',
        confidence:   warConf,
        reasoning:    'NARRATIVE CONVERGENCE: Pre-military framing + state media coordination — war risk premium',
        region:       'GLOBAL',
        evidenceKeys: ['self-defence', 'state media', 'coordinated narrative']
      });
      _pushSignal({
        source:       'narrative',
        asset:        'WTI',
        bias:         'long',
        confidence:   _clamp(warConf * 0.88, 0.45, 0.80),
        reasoning:    'Pre-war narrative campaign — energy supply disruption risk',
        region:       'GLOBAL',
        evidenceKeys: ['military escalation', 'narrative shift', 'energy risk']
      });
    }

    // PRE_SANCTIONS + ESCALATION_RHETORIC = sanctions imminent composite
    if (activeClusters.indexOf('PRE_SANCTIONS') !== -1 &&
        activeClusters.indexOf('ESCALATION_RHETORIC') !== -1) {
      _pushSignal({
        source:       'narrative',
        asset:        'WTI',
        bias:         'long',
        confidence:   _clamp(0.52 + clusterCounts['PRE_SANCTIONS'] * 0.02, 0.52, 0.78),
        reasoning:    'NARRATIVE CONVERGENCE: Human-rights framing + escalation rhetoric — sanctions imminent',
        region:       'GLOBAL',
        evidenceKeys: ['human rights', 'consequences', 'accountability']
      });
    }

    // 3+ clusters active simultaneously = broad geopolitical instability signal
    if (activeClusters.length >= 3) {
      _pushSignal({
        source:       'narrative',
        asset:        'GLD',
        bias:         'long',
        confidence:   _clamp(0.60 + activeClusters.length * 0.04, 0.60, 0.88),
        reasoning:    'MULTI-NARRATIVE SURGE: ' + activeClusters.length + ' narrative campaigns active — broad instability signal',
        region:       'GLOBAL',
        evidenceKeys: ['narrative warfare', 'information campaign', 'coordinated messaging']
      });
    }

    _status.clusterCounts    = clusterCounts;
    _status.activeNarratives = activeClusters;
    _status.coordinationScore = coordinationScore;
  }

  // ── public poll ───────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    _analyseEvents();
  }

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_AGENT_NARRATIVE = {
    poll:     poll,
    signals:  function () { return _signals.slice(); },
    status:   function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); }
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 9400);
  });

})();
