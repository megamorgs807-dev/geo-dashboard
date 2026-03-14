/* GII Core — gii-core.js v4
 * Multi-agent orchestrator: Bayesian engine, GTI, convergence, portfolio manager
 * Depends on: all GII_AGENT_* globals, window.__IC, window.PM, window.EE
 * Exposes: window.GII
 */
(function () {
  'use strict';

  var CYCLE_DELAY_MS   = 6000;   // wait 6s after load before first cycle
  var CYCLE_INTERVAL   = 62000;  // 62s between cycles
  var GTI_HISTORY_MAX  = 60;     // 60 data points for chart
  var FEEDBACK_KEY     = 'gii_agent_feedback_v1';
  var MAX_VOL_BOOST    = 2.0;

  // Base prior rates by region type
  var BASE_RATES = {
    'STRAIT OF HORMUZ': 0.35,
    'HORMUZ': 0.35,
    'RED SEA': 0.30,
    'SOUTH CHINA SEA': 0.30,
    'UKRAINE': 0.40,
    'TAIWAN': 0.30,
    'IRAN': 0.35,
    'RUSSIA': 0.35,
    'US': 0.20,
    'CHINA': 0.25,
    'GLOBAL': 0.20
  };

  // Convergence thresholds
  var CONVERGENCE = [
    { min: 4, level: 'high',     boost: 1.35, confBonus: 0.15 },
    { min: 3, level: 'strong',   boost: 1.20, confBonus: 0.10 },
    { min: 2, level: 'moderate', boost: 1.10, confBonus: 0.05 }
  ];

  // Hormuz pre-event pattern weights
  var HORMUZ_PATTERN = {
    tankerInsurance: 3,
    aisRerouting:    3,
    irgcRhetoric:    2,
    navalMovement:   2,
    threshold:       3,
    assets:          ['WTI', 'BRENT', 'GLD', 'XLE'],
    probBoost:       0.25
  };

  // ── private state ──────────────────────────────────────────────────────────

  var _posteriors  = {};   // { region: { prior, posterior, ci, contributing } }
  var _convergence = {};   // { region: { level, boost, confBonus, agentCount } }
  var _gti         = 0;
  var _gtiLevel    = 'NORMAL';
  var _gtiHistory  = [];   // [{ ts, value }]
  var _gtiFloor    = 0;
  var _volatilityBoost = 1.0;
  var _feedback    = {};   // loaded from localStorage
  var _lastCycleTs = 0;
  var _hormuzActive = false;
  var _lastSignals = [];

  // ── helpers ────────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _loadFeedback() {
    try {
      var raw = localStorage.getItem(FEEDBACK_KEY);
      _feedback = raw ? JSON.parse(raw) : {};
    } catch (e) { _feedback = {}; }
  }

  function _saveFeedback() {
    try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(_feedback)); } catch (e) {}
  }

  // ── agent collection ───────────────────────────────────────────────────────

  var AGENTS = [
    { name: 'energy',     global: 'GII_AGENT_ENERGY'     },
    { name: 'conflict',   global: 'GII_AGENT_CONFLICT'   },
    { name: 'macro',      global: 'GII_AGENT_MACRO'      },
    { name: 'sanctions',  global: 'GII_AGENT_SANCTIONS'  },
    { name: 'maritime',   global: 'GII_AGENT_MARITIME'   },
    { name: 'social',     global: 'GII_AGENT_SOCIAL'     },
    { name: 'polymarket', global: 'GII_AGENT_POLYMARKET' },
    { name: 'regime',     global: 'GII_AGENT_REGIME'     },
    { name: 'satellite',  global: 'GII_AGENT_SATELLITE'  },
    { name: 'historical', global: 'GII_AGENT_HISTORICAL' },
    { name: 'liquidity',  global: 'GII_AGENT_LIQUIDITY'  },
    { name: 'calendar',   global: 'GII_AGENT_CALENDAR'   },
    { name: 'chokepoint', global: 'GII_AGENT_CHOKEPOINT' },
    { name: 'narrative',  global: 'GII_AGENT_NARRATIVE'  }
  ];

  function _getAgent(def) { return window[def.global] || null; }

  function _collectAllSignals() {
    var all = [];
    var staleThreshold = Date.now() - CYCLE_INTERVAL * 2; // signals older than 2 cycles are stale
    AGENTS.forEach(function (def) {
      var agent = _getAgent(def);
      if (!agent) return;
      // Warn if agent hasn't polled recently (stale data guard)
      try {
        var st = agent.status();
        if (st && st.lastPoll && st.lastPoll < staleThreshold) {
          console.warn('[GII] Agent ' + def.name + ' may have stale signals (last poll: ' +
            new Date(st.lastPoll).toLocaleTimeString() + ')');
        }
      } catch (e) {}
      var sigs = [];
      try { sigs = agent.signals() || []; } catch (e) {
        console.warn('[GII] Agent ' + def.name + ' signals() error: ' + (e.message || String(e)));
      }
      // Attach agent name for weighting
      sigs.forEach(function (s) {
        all.push(Object.assign({}, s, { _agentName: def.name }));
      });
    });
    _lastSignals = all;
    return all;
  }

  // ── agent weight (self-learning) ───────────────────────────────────────────

  function _agentWeight(agentName, asset, bias) {
    var key = agentName + '_' + (asset || '') + '_' + (bias || '');
    var fb = _feedback[key];
    if (!fb || fb.total < 5) return 1.0;
    var wr = fb.winRate || 0;
    if (wr >= 0.60) return 1.0;
    if (wr >= 0.50) return 0.8;
    if (wr >= 0.40) return 0.6;
    return 0.4;
  }

  // ── Bayesian engine ────────────────────────────────────────────────────────

  function _getPrior(region) {
    var IC = window.__IC;
    if (IC && IC.regionStates && IC.regionStates[region]) {
      var rs = IC.regionStates[region];
      if (rs.prob !== undefined) return _clamp(rs.prob / 100, 0.05, 0.95);
    }
    // Fuzzy match base rates
    var rUp = (region || '').toUpperCase();
    for (var k in BASE_RATES) {
      if (rUp.indexOf(k) !== -1) return BASE_RATES[k];
    }
    return 0.20;
  }

  function _likelihoodRatio(agentName, signals, region) {
    // Filter signals relevant to this region
    var relevant = signals.filter(function (s) {
      return s._agentName === agentName &&
        (s.region === region ||
         (s.region || '').indexOf(region) !== -1 ||
         region.indexOf(s.region || '') !== -1);
    });
    if (!relevant.length) return 1.0; // no update

    var avgConf = relevant.reduce(function (s, sig) { return s + (sig.confidence || 0.5); }, 0) / relevant.length;
    var w = _agentWeight(agentName, relevant[0].asset, relevant[0].bias);
    avgConf = avgConf * w;

    // Map [0,1] → [0.3, 3.5];  conf=0.5 → LR≈1.9
    return _clamp(0.3 + avgConf * 3.2, 0.3, 3.5);
  }

  function _bayesianUpdate(region, signals) {
    var prior = _getPrior(region);
    var contributing = [];

    var priorProduct = prior;
    var altProduct = 1 - prior;

    AGENTS.forEach(function (def) {
      var lr = _likelihoodRatio(def.name, signals, region);
      if (Math.abs(lr - 1.0) < 0.01) return; // skip neutral agents
      var prevPost = priorProduct;
      priorProduct *= lr;
      altProduct   *= (1 - _clamp(lr / (lr + 1), 0, 1)); // approximate complement
      contributing.push({ source: def.name, lr: lr, delta: priorProduct - prevPost });
    });

    // Normalise
    var denom = priorProduct + altProduct;
    var posterior = denom > 0 ? _clamp(priorProduct / denom, 0.02, 0.97) : prior;

    // Apply regime floor
    if (_gtiFloor > 0) posterior = Math.max(posterior, _gtiFloor / 100);

    // Confidence interval (±15% of posterior, clamped)
    var ci = [
      _clamp(posterior - 0.15, 0.02, 0.97),
      _clamp(posterior + 0.15, 0.02, 0.97)
    ];

    _posteriors[region] = {
      region: region,
      prior: prior,
      posterior: posterior,
      confidence_interval: ci,
      contributing_signals: contributing
    };

    return _posteriors[region];
  }

  // ── convergence check ──────────────────────────────────────────────────────

  function _convergenceCheck(region, signals) {
    // Count distinct agents with opinion on this region
    var agentBiases = {};
    signals.forEach(function (s) {
      if (!s._agentName) return;
      var r = s.region || '';
      if (r !== region && r.indexOf(region) === -1 && region.indexOf(r) === -1) return;
      if (!agentBiases[s._agentName]) agentBiases[s._agentName] = {};
      agentBiases[s._agentName][s.bias] = (agentBiases[s._agentName][s.bias] || 0) + 1;
    });

    // Count agents agreeing on dominant bias (long vs short)
    var biasVotes = { long: 0, short: 0, neutral: 0 };
    Object.keys(agentBiases).forEach(function (agent) {
      var biases = agentBiases[agent];
      var dom = Object.keys(biases).sort(function (a, b) { return biases[b] - biases[a]; })[0];
      if (dom) biasVotes[dom] = (biasVotes[dom] || 0) + 1;
    });

    var dominantBias = Object.keys(biasVotes).sort(function (a, b) { return biasVotes[b] - biasVotes[a]; })[0];
    var agentCount = dominantBias ? biasVotes[dominantBias] : 0;

    var result = { level: null, boost: 1.0, confBonus: 0, agentCount: agentCount, dominantBias: dominantBias };
    for (var i = 0; i < CONVERGENCE.length; i++) {
      if (agentCount >= CONVERGENCE[i].min) {
        result.level = CONVERGENCE[i].level;
        result.boost = CONVERGENCE[i].boost;
        result.confBonus = CONVERGENCE[i].confBonus;
        break;
      }
    }

    _convergence[region] = result;
    return result;
  }

  // ── Hormuz pre-event pattern ───────────────────────────────────────────────

  function _detectHormuzPattern() {
    var maritime = window.GII_AGENT_MARITIME;
    if (!maritime) { _hormuzActive = false; return; }

    var hp;
    try { hp = maritime.getHormuzPattern(); } catch (e) { _hormuzActive = false; return; }

    if (!hp) { _hormuzActive = false; return; }

    var score = hp.totalScore || 0;
    _hormuzActive = score >= HORMUZ_PATTERN.threshold;

    if (_hormuzActive) {
      // Boost IRAN / HORMUZ posterior
      ['IRAN', 'STRAIT OF HORMUZ'].forEach(function (region) {
        if (_posteriors[region]) {
          _posteriors[region].posterior = _clamp(
            _posteriors[region].posterior + HORMUZ_PATTERN.probBoost, 0.02, 0.97
          );
          _posteriors[region].hormuzPatternActive = true;
        } else {
          var prior = _getPrior(region);
          _posteriors[region] = {
            region: region,
            prior: prior,
            posterior: _clamp(prior + HORMUZ_PATTERN.probBoost, 0.02, 0.97),
            confidence_interval: [prior, _clamp(prior + 0.40, 0.02, 0.97)],
            contributing_signals: [{ source: 'maritime', lr: 2.5, delta: HORMUZ_PATTERN.probBoost }],
            hormuzPatternActive: true
          };
        }
      });
    }
  }

  // ── regime shift handling ──────────────────────────────────────────────────

  function _checkRegimeShift() {
    var regimeAgent = window.GII_AGENT_REGIME;
    if (!regimeAgent) return;

    var shift;
    try { shift = regimeAgent.getShiftStatus(); } catch (e) { return; }
    if (!shift || !shift.active || !shift.def) return;

    // Reset posteriors to >= priorReset floor
    var floor = shift.def.priorReset || 0.50;
    Object.keys(_posteriors).forEach(function (region) {
      if (_posteriors[region].posterior < floor) {
        _posteriors[region].posterior = floor;
      }
    });

    // Set volatility boost (capped at MAX_VOL_BOOST)
    _volatilityBoost = _clamp(shift.def.volBoost || 1.0, 1.0, MAX_VOL_BOOST);

    // Set GTI floor
    _gtiFloor = 60;
  }

  // ── Global Tension Index ───────────────────────────────────────────────────

  function _computeGTI() {
    var IC = window.__IC;
    var PM = window.PM;

    // Component 1 (25%): mean top-5 region posterior
    var regionProbs = Object.values ? Object.values(_posteriors) : Object.keys(_posteriors).map(function (k) { return _posteriors[k]; });
    regionProbs.sort(function (a, b) { return b.posterior - a.posterior; });
    var top5 = regionProbs.slice(0, 5);
    var meanRegionProb = top5.length
      ? top5.reduce(function (s, r) { return s + r.posterior; }, 0) / top5.length
      : 0.20;
    var c1 = meanRegionProb * 100;

    // Component 2 (20%): high-signal event intensity (last 24h)
    // Weighted by avg signal strength, not raw count — prevents noise inflation
    var c2 = 0;
    if (IC && IC.events) {
      var cutoff24 = Date.now() - 24 * 60 * 60 * 1000;
      var highEvts = IC.events.filter(function (e) {
        return e.ts > cutoff24 && (e.signal || e.severity || 0) >= 70;   // fixed: e.ts not e.timestamp
      });
      if (highEvts.length) {
        var avgSig = highEvts.reduce(function (s, e) { return s + (e.signal || e.severity || 70); }, 0) / highEvts.length;
        var countFactor = _clamp(highEvts.length / 10, 0.1, 1.0); // 10+ events = full weight; 1 event = 10%
        c2 = _clamp(avgSig * countFactor, 0, 100);
      }
    }

    // Component 3 (20%): agent convergence score
    var convValues = Object.keys(_convergence).map(function (r) { return _convergence[r].agentCount; });
    var avgConv = convValues.length ? convValues.reduce(function (s, v) { return s + v; }, 0) / convValues.length : 0;
    var c3 = _clamp(avgConv / 8 * 100, 0, 100);

    // Component 4 (15%): mean PM YES probability
    var c4 = 0;
    if (PM) {
      var pmEvts = [];
      try { pmEvts = (PM.events && PM.events()) || []; } catch (e) {}
      if (pmEvts.length) {
        var pmSum = pmEvts.reduce(function (s, e) {
          return s + (parseFloat(e.pmYesProb || e.probability || 0) || 0);
        }, 0);
        c4 = (pmSum / pmEvts.length) * 100;
      }
    }

    // Component 5 (10%): regime shift flag
    var c5 = 0;
    var regimeAgent = window.GII_AGENT_REGIME;
    if (regimeAgent) {
      try {
        var rs = regimeAgent.getShiftStatus();
        c5 = (rs && rs.active) ? 100 : 0;
      } catch (e) {}
    }

    // Component 6 (10%): VIX normalised (10–50 → 0–100)
    var c6 = 0;
    var macroAgent = window.GII_AGENT_MACRO;
    if (macroAgent) {
      try {
        var ms = macroAgent.status();
        if (ms.vix !== null && ms.vix !== undefined) {
          c6 = _clamp((ms.vix - 10) / 40 * 100, 0, 100);
        }
      } catch (e) {}
    }

    var rawGTI = c1 * 0.25 + c2 * 0.20 + c3 * 0.20 + c4 * 0.15 + c5 * 0.10 + c6 * 0.10;
    _gti = _clamp(Math.max(rawGTI, _gtiFloor), 0, 100);

    // Level
    if (_gti >= 80)      _gtiLevel = 'EXTREME';
    else if (_gti >= 60) _gtiLevel = 'HIGH';
    else if (_gti >= 30) _gtiLevel = 'MODERATE';
    else                 _gtiLevel = 'NORMAL';

    // Rolling history
    _gtiHistory.push({ ts: Date.now(), value: _gti });
    if (_gtiHistory.length > GTI_HISTORY_MAX) _gtiHistory.shift();

    // Decay GTI floor and volatilityBoost over time
    if (_gtiFloor > 0) _gtiFloor = Math.max(0, _gtiFloor - 2);
    if (_volatilityBoost > 1.0) _volatilityBoost = Math.max(1.0, _volatilityBoost - 0.05);
  }

  // ── portfolio decision ─────────────────────────────────────────────────────

  function _portfolioDecision(signals) {
    var EE = window.EE;
    if (!EE || typeof EE.onSignals !== 'function') return;

    // Dedup signals by asset — keep highest-confidence per asset
    var byAsset = {};
    signals.forEach(function (s) {
      if (!s.asset || !s.confidence) return;
      var key = s.asset + '_' + (s.bias || 'long');
      if (!byAsset[key] || s.confidence > byAsset[key].confidence) {
        byAsset[key] = s;
      }
    });

    var toEmit = [];
    Object.keys(byAsset).forEach(function (key) {
      var s = byAsset[key];
      var region = s.region || 'GLOBAL';
      var post = _posteriors[region] ? _posteriors[region].posterior : 0.30;
      var conv = _convergence[region] || { boost: 1.0, confBonus: 0 };

      var rawConf = (post * 100 + conv.confBonus * 100) * conv.boost;
      rawConf = _clamp(rawConf, 0, 95);

      var impactMult = _clamp(_volatilityBoost * conv.boost, 1.0, 3.0);

      var reasonParts = ['GII'];
      if (conv.level) reasonParts.push(conv.agentCount + '-agent ' + conv.level + ' convergence');
      if (s.pmEdge) reasonParts.push('PM edge ' + (s.pmEdge * 100).toFixed(0) + '%');
      if (_hormuzActive) reasonParts.push('Hormuz-pattern active');

      toEmit.push({
        asset:           s.asset,
        dir:             s.bias === 'short' ? -1 : 1,
        conf:            rawConf,
        reason:          reasonParts.join(' | '),
        region:          region,
        impactMult:      impactMult,
        matchedKeywords: s.evidenceKeys || []
      });
    });

    if (toEmit.length) {
      try { EE.onSignals(toEmit); } catch (e) {}
    }
  }

  // ── active regions ─────────────────────────────────────────────────────────

  function _getActiveRegions(signals) {
    var regions = {};
    signals.forEach(function (s) { if (s.region) regions[s.region.toUpperCase()] = true; });
    // Also include IC regionStates
    var IC = window.__IC;
    if (IC && IC.regionStates) {
      Object.keys(IC.regionStates).forEach(function (r) {
        if (IC.regionStates[r].prob > 15) regions[r] = true;   // lowered from 30 — catches new events faster
      });
    }
    return Object.keys(regions);
  }

  // ── main cycle ─────────────────────────────────────────────────────────────

  function _cycle() {
    _lastCycleTs = Date.now();

    // 1. Poll all agents — log errors but never crash the cycle
    AGENTS.forEach(function (def) {
      var agent = _getAgent(def);
      if (agent && typeof agent.poll === 'function') {
        try {
          agent.poll();
        } catch (e) {
          console.warn('[GII] Agent ' + def.name + ' poll() error: ' + (e.message || String(e)));
        }
      }
    });

    // 2. Collect all signals
    var allSignals = _collectAllSignals();

    // 3. Bayesian update per active region
    var regions = _getActiveRegions(allSignals);
    regions.forEach(function (region) {
      _bayesianUpdate(region, allSignals);
    });

    // 4. Convergence check
    regions.forEach(function (region) {
      _convergenceCheck(region, allSignals);
    });

    // 5. Pre-event pattern (Hormuz)
    _detectHormuzPattern();

    // 6. Regime shift
    _checkRegimeShift();

    // 7. GTI
    _computeGTI();

    // 8. Portfolio decision
    _portfolioDecision(allSignals);

    // 9. Update UI
    if (window.GII_UI && typeof window.GII_UI.render === 'function') {
      try { window.GII_UI.render(); } catch (e) {}
    }
  }

  // ── feedback / self-learning ───────────────────────────────────────────────

  function _onTradeResult(trade) {
    if (!trade || !trade.asset) return;
    var closed = _lastSignals.filter(function (s) {
      return s.asset === trade.asset &&
        ((s.bias === 'long' && trade.dir > 0) || (s.bias === 'short' && trade.dir < 0));
    });
    if (!closed.length) return;

    var winner = trade.pnl > 0;
    closed.forEach(function (s) {
      var key = s._agentName + '_' + s.asset + '_' + (s.bias || 'long');
      if (!_feedback[key]) _feedback[key] = { total: 0, correct: 0, winRate: null, lastTs: null };
      _feedback[key].total++;
      if (winner) _feedback[key].correct++;
      _feedback[key].winRate = _feedback[key].correct / _feedback[key].total;
      _feedback[key].lastTs = new Date().toISOString();
    });
    _saveFeedback();
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII = {
    gti: function () { return { value: _gti, level: _gtiLevel }; },
    posterior: function (region) {
      if (!region) return null;
      return _posteriors[region.toUpperCase()] || null;
    },
    signals: function () { return _lastSignals.slice(); },
    feedback: function () { return Object.assign({}, _feedback); },
    gtiHistory: function () { return _gtiHistory.slice(); },
    onTradeResult: _onTradeResult,
    status: function () {
      return {
        lastCycle: _lastCycleTs,
        gti: _gti,
        gtiLevel: _gtiLevel,
        hormuzActive: _hormuzActive,
        volatilityBoost: _volatilityBoost,
        agentCount: AGENTS.filter(function (d) { return !!_getAgent(d); }).length,
        signalCount: _lastSignals.length,
        posteriorRegions: Object.keys(_posteriors).length,
        convergence: Object.assign({}, _convergence)
      };
    },
    pollNow: function () { _cycle(); }
  };

  // ── init ───────────────────────────────────────────────────────────────────

  window.addEventListener('load', function () {
    _loadFeedback();
    setTimeout(function () {
      _cycle();
      setInterval(_cycle, CYCLE_INTERVAL);
    }, CYCLE_DELAY_MS);
  });

})();
