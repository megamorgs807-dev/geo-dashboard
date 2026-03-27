/* GII Regime Agent — gii-regime.js v2
 * Detects structural regime shifts from IC events
 * Reads: window.__IC.events (last 2h, signal >= 70)
 * Exposes: window.GII_AGENT_REGIME
 */
(function () {
  'use strict';

  var MAX_SIGNALS = 20;
  var POLL_INTERVAL = 74000;
  var MIN_SIGNAL    = 78;  // raised from 70 — prevents analysis/commentary articles triggering shifts
  var LOOKBACK_MS   = 2 * 60 * 60 * 1000;  // 2 hours
  var COOLDOWN_MS   = 60 * 60 * 1000;       // 1 hour

  var REGIME_SHIFTS = {
    LEADER_DEATH: {
      kws: ['president killed', 'leader assassinated', 'assassination', 'head of state killed',
            'prime minister killed', 'president dead', 'supreme leader dead',
            'premier killed', 'chancellor killed'],
      volBoost: 2.0,
      priorReset: 0.70
    },
    COUP: {
      kws: ['coup', 'military takeover', 'junta', 'seized power', 'government overthrown',
            'military coup', 'takeover government'],
      volBoost: 2.5,
      priorReset: 0.75
    },
    MAJOR_STRIKE: {
      kws: ['massive airstrike', 'major strike', 'large-scale attack', 'strategic strike',
            'bombing campaign', 'precision strike', 'major offensive', 'ground invasion begins',
            'military offensive launched', 'escalation confirmed'],
      volBoost: 1.6,
      priorReset: 0.55
    },
    SANCTIONS_ESCAL: {
      kws: ['comprehensive sanctions', 'maximum pressure', 'full sanctions package',
            'sweeping sanctions', 'total embargo', 'nuclear sanctions', 'oil embargo declared',
            'cut off from swift'],
      volBoost: 1.8,
      priorReset: 0.60
    },
    TRADE_ROUTE_CLOSURE: {
      kws: ['hormuz closed', 'strait closed', 'suez closed', 'chokepoint closed',
            'trade route blocked', 'shipping lane closed', 'bab al-mandab closed',
            'malacca closed', 'canal closed', 'strait of hormuz blockade'],
      volBoost: 2.2,
      priorReset: 0.80
    }
  };

  var _signals = [];
  var _status = {
    lastPoll: null,
    eventCount: 0,
    regimeShiftActive: false,
    shiftType: null,
    lastShiftTs: 0,
    shiftDef: null
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

  // ── analysis ───────────────────────────────────────────────────────────────

  function _analyseEvents() {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now = Date.now();
    var cutoff = now - LOOKBACK_MS;

    /* Only consider events AFTER the last detected shift.
       Without this, the same triggering headline stays in the 2h lookback
       beyond the 1h cooldown, gets re-detected, and resets the cooldown —
       causing the force-close loop to repeat every hour indefinitely. */
    var eventCutoff = (_status.lastShiftTs > 0) ? Math.max(cutoff, _status.lastShiftTs) : cutoff;

    // High-signal events in window
    var highSigEvents = IC.events.filter(function (e) {
      var sig = e.signal || e.severity || 0;
      return e.ts > eventCutoff && sig >= MIN_SIGNAL;
    });

    _status.eventCount = highSigEvents.length;

    // Check if we're in cooldown
    var inCooldown = (now - _status.lastShiftTs) < COOLDOWN_MS;
    if (inCooldown && _status.regimeShiftActive) return;

    // Reset shift if cooldown expired
    if (!inCooldown && _status.regimeShiftActive) {
      _status.regimeShiftActive = false;
      _status.shiftType = null;
      _status.shiftDef = null;
    }

    // Scan for regime shift patterns
    var detectedType = null;
    var detectedDef = null;
    var detectedEvent = null;

    for (var shiftType in REGIME_SHIFTS) {
      var def = REGIME_SHIFTS[shiftType];
      for (var i = 0; i < highSigEvents.length; i++) {
        var e = highSigEvents[i];
        var text = e.headline || e.text || e.title || '';
        if (_matchesKeywords(text, def.kws)) {
          detectedType = shiftType;
          detectedDef = def;
          detectedEvent = e;
          break;
        }
      }
      if (detectedType) break;
    }

    if (!detectedType) return;

    // New regime shift detected
    _status.regimeShiftActive = true;
    _status.shiftType = detectedType;
    _status.lastShiftTs = now;
    _status.shiftDef = { volBoost: detectedDef.volBoost, priorReset: detectedDef.priorReset };

    var topSig = detectedEvent ? (detectedEvent.signal || detectedEvent.severity || 75) : 75;
    var region = detectedEvent ? (detectedEvent.region || 'GLOBAL') : 'GLOBAL';
    var headline = detectedEvent ? (detectedEvent.headline || detectedEvent.text || '') : '';

    var conf = _clamp(topSig / 100 * 0.90, 0.50, 0.92);

    _pushSignal({
      source: 'regime',
      asset: 'GLD',
      bias: 'long',
      confidence: conf,
      reasoning: 'REGIME SHIFT [' + detectedType + ']: vol boost ×' + detectedDef.volBoost +
        ' | prior reset to ' + (detectedDef.priorReset * 100).toFixed(0) + '%' +
        (headline ? ' — ' + headline.substring(0, 60) : ''),
      region: region,
      evidenceKeys: detectedDef.kws.slice(0, 4),
      regimeShift: detectedType,
      volBoost: detectedDef.volBoost,
      priorReset: detectedDef.priorReset
    });

    // Additional asset signals per shift type
    if (detectedType === 'TRADE_ROUTE_CLOSURE') {
      _pushSignal({
        source: 'regime',
        asset: 'WTI',
        bias: 'long',
        confidence: _clamp(conf * 0.95, 0.50, 0.92),
        reasoning: 'REGIME SHIFT: Trade route closure → energy supply shock | vol boost ×' + detectedDef.volBoost,
        region: region,
        evidenceKeys: ['trade route', 'closure', 'chokepoint']
      });
    } else if (detectedType === 'COUP') {
      _pushSignal({
        source: 'regime',
        asset: 'GLD',
        bias: 'long',
        confidence: _clamp(conf, 0.55, 0.92),
        reasoning: 'REGIME SHIFT: Coup detected → extreme uncertainty premium',
        region: region,
        evidenceKeys: ['coup', 'junta', 'military takeover']
      });
    }
  }

  // ── public poll ────────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    _analyseEvents();
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII_AGENT_REGIME = {
    poll: poll,
    signals: function () { return _signals.slice(); },
    status: function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); },
    getShiftStatus: function () {
      return {
        active: _status.regimeShiftActive,
        type: _status.shiftType,
        def: _status.shiftDef ? Object.assign({}, _status.shiftDef) : null,
        lastShiftTs: _status.lastShiftTs
      };
    }
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 7100);
  });

})();
