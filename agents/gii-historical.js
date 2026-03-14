/* GII Historical Pattern Agent — gii-historical.js v2
 * Detects pre-event precursor patterns: leading indicators that historically
 * appear BEFORE wars, sanctions campaigns, and coup attempts.
 *
 * Pattern logic:
 *   • Scans IC events from last 72h for weighted indicator keywords
 *   • When cumulative indicator weight >= threshold → precursor pattern active
 *   • Emits signal with confidence proportional to how many indicators fired
 *   • Cross-references region to pick correct asset mapping
 *   • Seasonal/velocity patterns retained as secondary background signal
 *
 * Reads: window.__IC.events, window.__IC.regionStates
 * Stores: localStorage 'gii_historical_v2'
 * Exposes: window.GII_AGENT_HISTORICAL
 */
(function () {
  'use strict';

  var MAX_SIGNALS   = 30;
  var POLL_INTERVAL = 90000;    // 90s — precursor scanning is heavier
  var STORAGE_KEY   = 'gii_historical_v2';
  var PRECURSOR_WINDOW_MS = 72 * 60 * 60 * 1000;  // 72h lookback for precursors

  // ════════════════════════════════════════════════════════════════════════════
  // PRECURSOR PATTERN DEFINITIONS
  // Each indicator has:
  //   id        — unique name shown in reasoning
  //   weight    — how diagnostic this signal is (1=weak, 2=moderate, 3=strong)
  //   keywords  — text matches in IC event titles/descriptions
  // Pattern fires when sum(weight of matched indicators) >= threshold
  // ════════════════════════════════════════════════════════════════════════════

  var PRECURSOR_PATTERNS = {

    // ── PRE-WAR ─────────────────────────────────────────────────────────────
    // Indicators that historically appear 7–30 days before military conflict
    WAR: {
      threshold:   5,
      leadTime:    '7–30 days before conflict',
      confBase:    0.52,
      confPerPoint: 0.04,
      maxConf:     0.88,
      indicators: [
        {
          id: 'troop_logistics',
          weight: 2,
          keywords: [
            'logistics convoy', 'ammunition depot', 'military supply', 'fuel reserves military',
            'forward operating base', 'staging area', 'troop surge', 'troop buildup',
            'mobilization order', 'reserves called up', 'national guard activated',
            'military logistics', 'supply line', 'field ration', 'military convoy'
          ]
        },
        {
          id: 'hospital_preparation',
          weight: 2,
          keywords: [
            'field hospital', 'military hospital', 'medical reserves', 'blood supply military',
            'trauma unit deployed', 'emergency medical preparedness', 'hospital beds military',
            'medical evacuation', 'medevac', 'military medic', 'combat casualty care',
            'hospital ship deployed', 'medical corps'
          ]
        },
        {
          id: 'leadership_evacuation',
          weight: 3,
          keywords: [
            'bunker', 'undisclosed location', 'leadership evacuation', 'presidential bunker',
            'command center relocated', 'government evacuation', 'continuity of government',
            'secure undisclosed', 'leader relocated', 'government moved', 'cabinet evacuated',
            'emergency session', 'war cabinet', 'national security council emergency'
          ]
        },
        {
          id: 'military_buildup',
          weight: 2,
          keywords: [
            'tank column', 'armored vehicle', 'artillery deployed', 'troop concentration',
            'missile battery', 'military exercises near border', 'carrier strike group',
            'warplane scrambled', 'military aircraft', 'troops amassed', 'tanks massing',
            'military encirclement', 'battle group', 'ground forces positioned'
          ]
        },
        {
          id: 'civilian_evacuation',
          weight: 2,
          keywords: [
            'civilian evacuation', 'border crossing surge', 'residents flee',
            'evacuation order', 'population displacement', 'families evacuating',
            'embassy evacuation', 'non-essential personnel', 'western nationals leave',
            'expat evacuation', 'departure advisory'
          ]
        },
        {
          id: 'air_defense_activation',
          weight: 2,
          keywords: [
            'air defense deployed', 'air defense system activated', 's-400 activated',
            'patriot deployed', 'anti-aircraft', 'air defense alert', 'airspace closed',
            'no-fly zone', 'air defense missile', 'intercept scramble'
          ]
        },
        {
          id: 'cyberattack_prelude',
          weight: 1,
          keywords: [
            'cyberattack government', 'critical infrastructure hack', 'ddos government',
            'power grid cyberattack', 'military network breach', 'ransomware government',
            'telecommunications attack', 'state-sponsored hack'
          ]
        }
      ]
    },

    // ── PRE-SANCTIONS ────────────────────────────────────────────────────────
    // Indicators that historically appear 2–14 days before sanctions announcement
    SANCTIONS: {
      threshold:   3,
      leadTime:    '2–14 days before sanctions',
      confBase:    0.48,
      confPerPoint: 0.06,
      maxConf:     0.84,
      indicators: [
        {
          id: 'diplomatic_expulsions',
          weight: 3,
          keywords: [
            'expelled diplomat', 'persona non grata', 'ambassador recalled',
            'diplomatic expulsion', 'diplomats ordered to leave', 'consul expelled',
            'embassy staff expelled', 'reduce diplomatic staff', 'diplomatic mission closed',
            'chargé d\'affaires', 'bilateral talks suspended', 'diplomatic freeze'
          ]
        },
        {
          id: 'treasury_warnings',
          weight: 3,
          keywords: [
            'treasury warning', 'ofac', 'sdn list', 'sanctions review', 'sanctions preparation',
            'secondary sanctions warning', 'sanctions compliance', 'financial restrictions',
            'asset freeze warning', 'sanctions designation', 'blocked entity',
            'treasury department alert', 'financial intelligence unit'
          ]
        },
        {
          id: 'export_controls',
          weight: 2,
          keywords: [
            'export control', 'technology ban', 'export license denied', 'entity list',
            'dual-use technology restriction', 'commerce department warning',
            'trade restriction draft', 'export control draft', 'technology transfer ban',
            'chip export', 'semiconductor ban', 'military technology transfer'
          ]
        },
        {
          id: 'diplomatic_isolation',
          weight: 2,
          keywords: [
            'diplomatic boycott', 'multilateral pressure', 'coalition pressure',
            'international isolation', 'excluded from summit', 'uninvited g7',
            'trade mission cancelled', 'bilateral talks collapse', 'allied coordination',
            'g7 statement', 'g20 condemnation', 'un security council resolution draft'
          ]
        },
        {
          id: 'financial_preparation',
          weight: 2,
          keywords: [
            'alternative payment system', 'de-dollarization', 'currency swap agreement',
            'gold reserves increase', 'forex reserves buildup', 'swift alternative',
            'cbdc alternative', 'financial decoupling', 'brics payment', 'reserve currency'
          ]
        }
      ]
    },

    // ── PRE-COUP ─────────────────────────────────────────────────────────────
    // Indicators that historically appear 1–7 days before a coup attempt
    COUP: {
      threshold:   3,
      leadTime:    '1–7 days before coup',
      confBase:    0.45,
      confPerPoint: 0.07,
      maxConf:     0.85,
      indicators: [
        {
          id: 'elite_travel_cancellations',
          weight: 2,
          keywords: [
            'summit cancelled', 'minister cancelled trip', 'delegation cancelled',
            'state visit postponed', 'president absent', 'minister absent',
            'official travel cancelled', 'cancelled state visit', 'foreign trip cancelled',
            'diplomatic trip cancelled suddenly', 'leader returned early'
          ]
        },
        {
          id: 'media_censorship',
          weight: 3,
          keywords: [
            'internet shutdown', 'media blackout', 'social media blocked', 'censorship spike',
            'journalist detained', 'press freedom warning', 'tv station closed',
            'broadcast suspended', 'news blackout', 'website blocked', 'vpn banned',
            'state media takeover', 'independent media closed', 'media crackdown'
          ]
        },
        {
          id: 'military_redeployment',
          weight: 3,
          keywords: [
            'presidential guard', 'security forces capital', 'special forces capital',
            'troop redeployment capital', 'garrison reinforced', 'military checkpoint',
            'armored vehicles capital', 'tanks capital city', 'troops surrounding',
            'military encirclement government', 'palace guard reinforced'
          ]
        },
        {
          id: 'political_purges',
          weight: 3,
          keywords: [
            'general arrested', 'military officer detained', 'political purge',
            'political arrest', 'minister arrested', 'senior official detained',
            'corruption charges military', 'treason charges', 'opposition arrested',
            'security chief fired', 'cabinet reshuffle sudden', 'military shake-up'
          ]
        },
        {
          id: 'comms_disruption',
          weight: 2,
          keywords: [
            'communications blackout', 'telecom disruption', 'power outage capital',
            'grid shutdown city', 'mobile network down', 'internet disruption',
            'phone lines cut', 'communication interference', 'signal jamming',
            'gps disruption', 'radio silence'
          ]
        }
      ]
    }

  };

  // ── Asset mapping by event type + region ──────────────────────────────────

  var PATTERN_ASSETS = {
    WAR: {
      default:   ['GLD', 'XLE'],
      'MIDDLE EAST':     ['WTI', 'GLD', 'XLE'],
      'STRAIT OF HORMUZ': ['WTI', 'BRENT', 'GLD'],
      'TAIWAN':          ['TSM', 'GLD', 'SMH'],
      'SOUTH CHINA SEA': ['TSM', 'GLD', 'FXI'],
      'UKRAINE':         ['GLD', 'XLE', 'WHT'],
      'RUSSIA':          ['GLD', 'XLE', 'BTC'],
      'IRAN':            ['WTI', 'BRENT', 'GLD'],
      'NORTH KOREA':     ['GLD', 'TSM']
    },
    SANCTIONS: {
      default:   ['GLD', 'BTC'],
      'RUSSIA':          ['GLD', 'BTC', 'XLE'],
      'IRAN':            ['WTI', 'GLD', 'BTC'],
      'CHINA':           ['FXI', 'TSM', 'GLD'],
      'NORTH KOREA':     ['GLD'],
      'VENEZUELA':       ['WTI', 'GLD']
    },
    COUP: {
      default:   ['GLD'],
      'MIDDLE EAST':     ['WTI', 'GLD'],
      'AFRICA':          ['GLD'],
      'VENEZUELA':       ['WTI', 'GLD']
    }
  };

  // ── Seasonal patterns (secondary background bias) ─────────────────────────

  var SEASONAL_PATTERNS = [
    { id: 'winter_gas',      months: [11,12,1,2,3],  regions: ['RUSSIA','UKRAINE'],     assets: ['GLD','XLE'],        bias: 'long', conf: 0.42, label: 'Winter gas season — Europe energy stress peaks Q4-Q1' },
    { id: 'summer_oil',      months: [6,7,8],         regions: ['MIDDLE EAST','IRAN'],   assets: ['WTI','BRENT'],       bias: 'long', conf: 0.38, label: 'Summer driving season — crude demand elevated' },
    { id: 'spring_escalation', months: [3,4,5],       regions: ['UKRAINE','RUSSIA'],     assets: ['GLD','WTI'],        bias: 'long', conf: 0.40, label: 'Spring escalation window — campaigns historically initiate Mar-May' },
    { id: 'opec_q4',         months: [10,11],         regions: ['MIDDLE EAST'],          assets: ['WTI','BRENT','XLE'], bias: 'long', conf: 0.38, label: 'OPEC output review season — cuts historically announced Q4' },
    { id: 'taiwan_strait',   months: [3,4,8,9],       regions: ['TAIWAN','SOUTH CHINA SEA'], assets: ['TSM','GLD'],    bias: 'long', conf: 0.36, label: 'Taiwan Strait tension peak — PLA exercises cluster Mar-Apr, Aug-Sep' }
  ];

  var _signals  = [];
  var _baseline = {};
  var _status = {
    lastPoll:           null,
    activePatterns:     {},    // { WAR: {score, indicators[]}, SANCTIONS: {...}, COUP: {...} }
    activeSeasonal:     [],
    escalatingRegions:  []
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  // ── storage ────────────────────────────────────────────────────────────────

  function _loadBaseline() {
    try { var r = localStorage.getItem(STORAGE_KEY); _baseline = r ? JSON.parse(r) : {}; }
    catch (e) { _baseline = {}; }
  }

  function _saveBaseline() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_baseline)); } catch (e) {}
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _matchesKeywords(text, keywords) {
    if (!text) return false;
    var t = text.toLowerCase();
    for (var i = 0; i < keywords.length; i++) {
      if (t.indexOf(keywords[i]) !== -1) return true;
    }
    return false;
  }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  function _currentMonth() { return new Date().getMonth() + 1; }

  function _getAssetsForPattern(patternType, region) {
    var map = PATTERN_ASSETS[patternType] || {};
    var rUp = (region || '').toUpperCase();
    for (var key in map) {
      if (key !== 'default' && rUp.indexOf(key) !== -1) return map[key];
    }
    return map.default || ['GLD'];
  }

  // ── PRECURSOR PATTERN SCANNER ─────────────────────────────────────────────

  function _scanPrecursors() {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now = Date.now();
    var cutoff = now - PRECURSOR_WINDOW_MS;

    // Get all recent events (wider 72h window for precursor detection)
    var recentEvents = IC.events.filter(function (e) {
      return e.ts > cutoff;
    });

    var activePatterns = {};

    Object.keys(PRECURSOR_PATTERNS).forEach(function (patternType) {
      var pattern = PRECURSOR_PATTERNS[patternType];

      // For each indicator, scan all recent events for keyword matches
      var firedIndicators = [];
      var totalScore = 0;
      var matchedTexts = [];
      var matchedRegions = {};

      pattern.indicators.forEach(function (indicator) {
        // Find events matching this indicator's keywords
        var matchingEvts = recentEvents.filter(function (e) {
          var text = (e.title || '') + ' ' + (e.desc || e.description || '');
          return _matchesKeywords(text, indicator.keywords);
        });

        if (matchingEvts.length > 0) {
          // Time-weight: events in last 12h count more than 48-72h ago
          var recencyBoost = matchingEvts.some(function (e) {
            return e.ts > now - 12 * 60 * 60 * 1000;
          }) ? 1.3 : 1.0;

          var effectiveWeight = indicator.weight * recencyBoost;
          totalScore += effectiveWeight;
          firedIndicators.push({
            id:     indicator.id,
            weight: indicator.weight,
            count:  matchingEvts.length,
            recent: recencyBoost > 1.0
          });

          // Track which regions these events came from
          matchingEvts.forEach(function (e) {
            if (e.region) matchedRegions[e.region.toUpperCase()] = (matchedRegions[e.region.toUpperCase()] || 0) + 1;
          });

          // Capture a snippet of the most relevant headline
          var topEvt = matchingEvts.sort(function (a, b) { return (b.signal || 0) - (a.signal || 0); })[0];
          if (topEvt) matchedTexts.push((topEvt.title || '').substring(0, 60));
        }
      });

      activePatterns[patternType] = {
        score:      totalScore,
        indicators: firedIndicators,
        regions:    matchedRegions,
        active:     totalScore >= pattern.threshold
      };

      if (totalScore < pattern.threshold) return;

      // Pattern fired — determine dominant region and assets
      var topRegion = Object.keys(matchedRegions).sort(function (a, b) {
        return (matchedRegions[b] || 0) - (matchedRegions[a] || 0);
      })[0] || 'GLOBAL';

      // Also check IC regionStates for confirmation
      var icPriorBoost = 0;
      if (IC.regionStates && IC.regionStates[topRegion]) {
        icPriorBoost = _clamp((IC.regionStates[topRegion].prob || 0) / 200, 0, 0.15);
      }

      var conf = _clamp(
        pattern.confBase + (totalScore - pattern.threshold) * pattern.confPerPoint + icPriorBoost,
        pattern.confBase,
        pattern.maxConf
      );

      var assets = _getAssetsForPattern(patternType, topRegion);
      var firedNames = firedIndicators.map(function (ind) {
        return ind.id.replace(/_/g, '-') + (ind.recent ? '⚡' : '') + '(×' + ind.weight + ')';
      }).join(', ');

      var preview = matchedTexts.slice(0, 2).join(' | ');

      assets.forEach(function (asset, idx) {
        _pushSignal({
          source:      'historical',
          asset:       asset,
          bias:        'long',
          confidence:  _clamp(conf * (1.0 - idx * 0.06), 0.30, pattern.maxConf),
          reasoning:   '[PRE-' + patternType + ' ' + Math.round(totalScore) + '/' + pattern.threshold + '] ' +
            topRegion + ' — ' + firedNames +
            (preview ? ' | ' + preview : '') +
            ' [lead: ' + pattern.leadTime + ']',
          region:      topRegion,
          evidenceKeys: firedIndicators.map(function (i) { return i.id; })
        });
      });
    });

    _status.activePatterns = activePatterns;
    _baseline.lastScan = now;
    _saveBaseline();
  }

  // ── SEASONAL PATTERNS (background bias) ───────────────────────────────────

  function _checkSeasonalPatterns() {
    var month = _currentMonth();
    var IC = window.__IC;
    var activeSeasonal = [];

    SEASONAL_PATTERNS.forEach(function (pat) {
      if (pat.months.indexOf(month) === -1) return;

      // Only emit if at least one of the pattern's regions is active in IC
      var regionActive = false;
      if (IC && IC.regionStates) {
        pat.regions.forEach(function (r) {
          if (IC.regionStates[r] && (IC.regionStates[r].prob || 0) > 25) regionActive = true;
        });
      }
      if (!regionActive) return; // don't spam seasonal signals when region is quiet

      activeSeasonal.push(pat.id);
      var conf = _clamp(pat.conf * 1.15, 0, 0.75); // small boost because region is active

      pat.assets.forEach(function (asset, idx) {
        _pushSignal({
          source:      'historical',
          asset:       asset,
          bias:        pat.bias,
          confidence:  _clamp(conf * (1.0 - idx * 0.06), 0.28, 0.75),
          reasoning:   '[SEASONAL] ' + pat.label,
          region:      pat.regions[0] || 'GLOBAL',
          evidenceKeys: ['seasonal', 'historical pattern']
        });
      });
    });

    _status.activeSeasonal = activeSeasonal;
  }

  // ── ESCALATION VELOCITY (rising event density) ────────────────────────────

  function _checkEscalationVelocity() {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now = Date.now();
    var windowMs = 8 * 60 * 60 * 1000; // 8h windows
    var numWindows = 3;
    var escalating = [];

    // Group by region
    var byRegion = {};
    IC.events.forEach(function (e) {
      if (!e.ts || !e.region || (e.signal || 0) < 50) return;
      var r = e.region.toUpperCase();
      if (!byRegion[r]) byRegion[r] = [];
      byRegion[r].push(e.ts);
    });

    Object.keys(byRegion).forEach(function (region) {
      var timestamps = byRegion[region];
      var windows = [];
      for (var w = 0; w < numWindows; w++) {
        var wEnd   = now - w * windowMs;
        var wStart = wEnd - windowMs;
        windows.unshift(timestamps.filter(function (ts) { return ts >= wStart && ts < wEnd; }).length);
      }
      // Rising: each window more than previous
      var isRising = windows[0] >= 1 && windows[1] > windows[0] && windows[2] > windows[1];
      var isAccel  = isRising && (windows[2] - windows[1]) > (windows[1] - windows[0]);
      if (!isRising) return;

      escalating.push(region);

      var rs = IC.regionStates && IC.regionStates[region];
      var assets = (rs && rs.assets) ? rs.assets.slice(0, 2) : ['GLD'];
      var conf = _clamp(0.38 + (windows[2] - windows[0]) * 0.03 + (isAccel ? 0.08 : 0), 0.30, 0.72);

      assets.forEach(function (asset, idx) {
        _pushSignal({
          source:      'historical',
          asset:       asset,
          bias:        'long',
          confidence:  _clamp(conf * (1.0 - idx * 0.08), 0.25, 0.72),
          reasoning:   '[VELOCITY] ' + region + ' event density rising: ' + windows.join('→') +
            ' per 8h window' + (isAccel ? ' [ACCELERATING]' : ''),
          region:      region,
          evidenceKeys: ['escalation velocity', 'rising trend']
        });
      });
    });

    _status.escalatingRegions = escalating;
  }

  // ── public poll ────────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    _signals = [];                    // clear each cycle — rebuild from fresh scan
    _scanPrecursors();
    _checkSeasonalPatterns();
    _checkEscalationVelocity();
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII_AGENT_HISTORICAL = {
    poll:     poll,
    signals:  function () { return _signals.slice(); },
    status:   function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); },
    // Exposes active pattern scores for UI display
    patterns: function () {
      return Object.keys(_status.activePatterns).map(function (type) {
        var p = _status.activePatterns[type];
        return {
          type:       type,
          score:      Math.round(p.score * 10) / 10,
          threshold:  PRECURSOR_PATTERNS[type].threshold,
          active:     p.active,
          indicators: p.indicators || []
        };
      });
    }
  };

  window.addEventListener('load', function () {
    _loadBaseline();
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 7400);
  });

})();
