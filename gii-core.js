/* GII Core — gii-core.js v20
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
  var TRADE_MAP_KEY    = 'gii_trade_map_v1';   // persists attribution across page reloads
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

  var _posteriors        = {};   // { region: { prior, posterior, ci, contributing } }
  var _posteriorHistory  = {};   // { region: [{ ts, prior, posterior, trigger }] } — capped at 50 per region
  var _convergence = {};   // { region: { level, boost, confBonus, agentCount } }
  var _gti         = 0;
  var _gtiLevel    = 'NORMAL';
  var _gtiHistory  = [];   // [{ ts, value }]
  var _gtiFloor    = 0;
  var _volatilityBoost = 1.0;
  var _feedback    = {};   // loaded from localStorage
  var _lastCycleTs = 0;
  var _hormuzActive = false;
  var _lastSignals     = [];
  var _giiTradeMap     = {};   // { "ASSET_bias": [agentName, ...] } — attribution for feedback
  var _prevGTI         = null;  // Module 4: market lag detection

  // ── Canonical asset classification (single source of truth) ───────────────
  // gii-entry.js and gii-exit.js reference these via GII.defensiveAssets() /
  // GII.riskAssets() so any change here propagates automatically.
  var _DEFENSIVE  = ['GLD', 'XAU', 'SLV', 'JPY', 'CHF', 'VIX', 'TLT', 'GAS'];
  var _RISK_ASSETS = ['BTC', 'SPY', 'QQQ', 'TSM', 'NVDA', 'TSLA', 'SMH', 'FXI'];
  var _lagBoost        = 1.0;   // Module 4: applied in portfolioDecision
  var _marketLagActive = false; // Module 4: exposed in status()

  // ── helpers ────────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _loadFeedback() {
    try {
      var raw = localStorage.getItem(FEEDBACK_KEY);
      _feedback = raw ? JSON.parse(raw) : {};
    } catch (e) { _feedback = {}; }
    /* Also restore trade attribution map so feedback works across page reloads.
       Without this, any trade that opens in one session and closes after a reload
       finds an empty _giiTradeMap and records no feedback. */
    try {
      var rawMap = localStorage.getItem(TRADE_MAP_KEY);
      if (rawMap) {
        var parsed = JSON.parse(rawMap);
        /* Merge with in-memory map (don't overwrite entries written this session) */
        Object.keys(parsed).forEach(function (k) {
          if (!_giiTradeMap[k]) _giiTradeMap[k] = parsed[k];
        });
      }
    } catch (e) {}
  }

  function _saveFeedback() {
    try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(_feedback)); } catch (e) {}
    /* Save trade map alongside feedback so attribution survives reloads */
    try { localStorage.setItem(TRADE_MAP_KEY, JSON.stringify(_giiTradeMap)); } catch (e) {}
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
    { name: 'narrative',  global: 'GII_AGENT_NARRATIVE'  },
    { name: 'escalation', global: 'GII_AGENT_ESCALATION' },
    { name: 'scenario',   global: 'GII_AGENT_SCENARIO'   },
    { name: 'technicals', global: 'GII_AGENT_TECHNICALS' },
    { name: 'scalper',         global: 'GII_AGENT_SCALPER'         },
    { name: 'scalper-session', global: 'GII_AGENT_SCALPER_SESSION' },
    { name: 'optimizer',       global: 'GII_AGENT_OPTIMIZER'       },
    { name: 'smartmoney',      global: 'GII_AGENT_SMARTMONEY'      },
    { name: 'marketstructure', global: 'GII_AGENT_MARKETSTRUCTURE' },
    { name: 'deescalation',   global: 'GII_AGENT_DEESCALATION'   },  // opposition: diplomatic resolution
    { name: 'risk',           global: 'GII_AGENT_RISK'           }   // opposition: systemic/portfolio stress
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
    // Module 5: tag correlated signals with discount before Bayesian update
    _deduplicateSignals(all);
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

  // ── Module 2: Signal reliability scoring ──────────────────────────────────
  // Blends LR toward neutral based on source credibility × recency

  var SOURCE_CREDIBILITY = {
    'macro': 0.88, 'regime': 0.85, 'escalation': 0.83, 'conflict': 0.82,
    'sanctions': 0.80, 'polymarket': 0.82, 'maritime': 0.78, 'chokepoint': 0.78,
    'satellite': 0.78, 'energy': 0.75, 'liquidity': 0.75, 'historical': 0.72,
    'technicals': 0.80, 'optimizer': 0.83, 'scalper': 0.70, 'scalper-session': 0.70,
    'smartmoney': 0.75, 'marketstructure': 0.72,
    'calendar': 0.70, 'narrative': 0.65, 'social': 0.60
  };

  function _reliabilityScore(signal) {
    var cred = SOURCE_CREDIBILITY[signal.source] || 0.70;
    var ageMs = Date.now() - (signal.timestamp || Date.now());
    var recency = ageMs < 3600000  ? 1.00 :
                  ageMs < 21600000 ? 0.90 :
                  ageMs < 43200000 ? 0.78 : 0.62;
    return _clamp(cred * recency, 0.20, 1.0);
  }

  // ── Module 5: Signal deduplication / correlation discounting ──────────────
  // Tags correlated signals (same region+asset+bias+overlapping evidenceKeys)
  // with a _correlationDiscount so Bayesian LR isn't multiplied naively.

  function _deduplicateSignals(signals) {
    // Group by region+asset+bias
    var groups = {};
    signals.forEach(function (sig) {
      var gk = (sig.region || 'GLOBAL') + '|' + (sig.asset || '') + '|' + (sig.bias || 'long');
      if (!groups[gk]) groups[gk] = [];
      groups[gk].push(sig);
    });

    Object.keys(groups).forEach(function (gk) {
      var grp = groups[gk];
      // First signal in group = primary (no discount)
      grp.forEach(function (sig, i) {
        if (i === 0) { sig._correlationDiscount = 0; return; }
        // Measure evidenceKey overlap with all earlier signals in this group
        var prevKeys = [];
        grp.slice(0, i).forEach(function (prev) {
          (prev.evidenceKeys || []).forEach(function (k) {
            if (prevKeys.indexOf(k) === -1) prevKeys.push(k);
          });
        });
        var myKeys  = sig.evidenceKeys || [];
        var overlap = myKeys.filter(function (k) { return prevKeys.indexOf(k) !== -1; });
        // Discount proportional to overlap; max 50% reduction
        sig._correlationDiscount = _clamp(overlap.length * 0.15, 0, 0.50);
      });
    });

    return signals; // modified in-place; all agents' signals preserved for convergence
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

    // Module 2: apply reliability score (blends LR toward neutral)
    var reliability = relevant.reduce(function (s, sig) { return s + _reliabilityScore(sig); }, 0) / relevant.length;

    // Module 5: apply correlation discount (reduces LR if signals are correlated)
    var avgDiscount = relevant.reduce(function (s, sig) { return s + (sig._correlationDiscount || 0); }, 0) / relevant.length;

    // Map [0,1] → [0.3, 3.5];  conf=0.5 → LR≈1.9
    var lr = _clamp(0.3 + avgConf * 3.2, 0.3, 3.5);
    // Reliability blends LR toward 1.0; discount further reduces deviation from neutral
    var adjustedLR = 1.0 + (lr - 1.0) * reliability * (1.0 - avgDiscount);
    return _clamp(adjustedLR, 0.3, 3.5);
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

    var prev = _posteriors[region] ? _posteriors[region].posterior : null;
    _posteriors[region] = {
      region:               region,
      prior:                prior,
      posterior:            posterior,
      confidence_interval:  ci,
      contributing_signals: contributing,
      contributing:         contributing,   // alias used by pruner
      lastUpdated:          new Date().toISOString()
    };

    // Audit trail: record significant changes (>0.03 delta or first entry)
    if (prev === null || Math.abs(posterior - prev) > 0.03) {
      if (!_posteriorHistory[region]) _posteriorHistory[region] = [];
      _posteriorHistory[region].unshift({
        ts:        new Date().toISOString(),
        prior:     prior,
        posterior: posterior,
        prev:      prev,
        delta:     prev !== null ? parseFloat((posterior - prev).toFixed(3)) : null,
        trigger:   contributing.length ? contributing[0].source : 'cycle'
      });
      if (_posteriorHistory[region].length > 50) _posteriorHistory[region].length = 50;
    }

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
    _prevGTI = _gti; // Module 4: save previous GTI before computing new one
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
    // v62: fast-track decay when real GTI is already well below the floor (false alarm / resolved event)
    if (_gtiFloor > 0) {
      var _floorDecay = (_gti < _gtiFloor - 15) ? 4 : 2;
      _gtiFloor = Math.max(0, _gtiFloor - _floorDecay);
    }
    if (_volatilityBoost > 1.0) _volatilityBoost = Math.max(1.0, _volatilityBoost - 0.05);
  }

  // ── Module 4: Market reaction lag detection ───────────────────────────────
  // Detects when GTI rises faster than prediction markets price in the risk.
  // Returns a confidence boost multiplier (1.0 = no lag, 1.25 = strong lag).

  function _detectMarketLag() {
    _marketLagActive = false;
    if (_prevGTI === null || _gti === null) return 1.0;
    var gtiDelta = _gti - _prevGTI;
    if (gtiDelta < 8) return 1.0; // GTI not rising fast enough to flag lag

    // Check if Polymarket is pricing in the move (low avg edge = PM has caught up)
    var pmAgent = window.GII_AGENT_POLYMARKET;
    if (!pmAgent) {
      _marketLagActive = true;
      return 1.15; // no PM data available — moderate lag assumption
    }
    try {
      var pmSt = pmAgent.status();
      var avgEdge = pmSt.avgAbsEdge || pmSt.avgEdge || 0;
      if (avgEdge < 0.05) {
        // GTI spiked but PM prices haven't moved — strong lag
        _marketLagActive = true;
        return 1.25;
      } else if (avgEdge < 0.10) {
        // Mild lag
        _marketLagActive = true;
        return 1.12;
      }
    } catch (e) {}
    return 1.0;
  }

  // ── portfolio decision ─────────────────────────────────────────────────────

  function _portfolioDecision(signals) {
    var EE = window.EE;
    if (!EE || typeof EE.onSignals !== 'function') {
      if (!window.GII_AGENT_ENTRY) return;
    }

    // Dedup signals by asset — keep highest-confidence per asset
    var byAsset = {};
    signals.forEach(function (s) {
      if (!s.asset || !s.confidence) return;
      var key = s.asset + '_' + (s.bias || 'long');
      if (!byAsset[key] || s.confidence > byAsset[key].confidence) {
        byAsset[key] = s;
      }
    });

    // Build agent attribution map so feedback works even when _lastSignals has rotated
    var agentContrib = {};
    signals.forEach(function (s) {
      if (!s.asset || !s._agentName) return;
      var ak = s.asset + '_' + (s.bias || 'long');
      if (!agentContrib[ak]) agentContrib[ak] = [];
      if (agentContrib[ak].indexOf(s._agentName) === -1) agentContrib[ak].push(s._agentName);
    });

    var toEmit = [];
    Object.keys(byAsset).forEach(function (key) {
      var s = byAsset[key];
      var region = s.region || 'GLOBAL';
      var post = _posteriors[region] ? _posteriors[region].posterior : 0.30;
      var conv = _convergence[region] || { boost: 1.0, confBonus: 0 };

      var rawConf = (post * 100 + conv.confBonus * 100) * conv.boost;
      rawConf = _clamp(rawConf, 0, 95);

      // v61: bonus when multiple agents independently agree on same asset+direction
      // Cap effective agreeCount at 3 — beyond that, agents are likely reacting to the
      // same headline (false independence), so excess agreement inflates confidence.
      var agreeCount = (agentContrib[key] || []).length;
      if (agreeCount > 1) rawConf = _clamp(rawConf + (Math.min(agreeCount, 3) - 1) * 3, 0, 95);

      // Module 4: apply market lag boost if detected
      if (_lagBoost > 1.0) rawConf = _clamp(rawConf * _lagBoost, 0, 95);

      // Skip signals whose rawConf is too low to survive EE's 65% threshold
      // after the entry agent's max +8 boost (57 + 8 = 65). Avoids dead-end signals.
      if (rawConf < 57) return;

      // Cap at 2.0× (was 3.0×) — at 3× a normal 2% risk trade silently became 6% risk
      // during high-volatility + convergence spikes. 2× is the safe ceiling.
      var impactMult = _clamp(_volatilityBoost * conv.boost, 1.0, 2.0);

      var reasonParts = ['GII'];
      if (conv.level) reasonParts.push(conv.agentCount + '-agent ' + conv.level + ' convergence');
      if (s.pmEdge) reasonParts.push('PM edge ' + (s.pmEdge * 100).toFixed(0) + '%');
      if (_hormuzActive) reasonParts.push('Hormuz-pattern active');
      if (_lagBoost > 1.0) reasonParts.push('mkt-lag ×' + _lagBoost.toFixed(2));

      toEmit.push({
        asset:           s.asset,
        dir:             s.bias === 'short' ? 'SHORT' : 'LONG',
        conf:            rawConf,
        reason:          reasonParts.join(' | '),
        region:          region,
        impactMult:      impactMult,
        matchedKeywords: s.evidenceKeys || []
      });
    });

    if (toEmit.length) {
      // Record attribution before emitting — so feedback works when trade closes later
      toEmit.forEach(function (sig) {
        var ak = sig.asset + '_' + (sig.dir === 'SHORT' ? 'short' : 'long');
        if (agentContrib[ak] && agentContrib[ak].length) _giiTradeMap[ak] = agentContrib[ak].slice();
      });
      // Persist immediately so attribution survives any page reload before the trade closes
      try { localStorage.setItem(TRADE_MAP_KEY, JSON.stringify(_giiTradeMap)); } catch (e) {}

      try {
        /* Route through entry agent (confluence check) if available */
        if (window.GII_AGENT_ENTRY && typeof GII_AGENT_ENTRY.submit === 'function') {
          GII_AGENT_ENTRY.submit(toEmit, 'gii');
        } else if (window.EE && typeof EE.onSignals === 'function') {
          EE.onSignals(toEmit);
        }
      } catch (e) {}
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
        if (IC.regionStates[r].prob > 20) regions[r] = true;   // raised from 15→20: filters noise regions while still catching early-stage events
      });
    }
    return Object.keys(regions);
  }

  // ── main cycle ─────────────────────────────────────────────────────────────

  /* Prune posteriors for regions that have received no signals for an extended
     period AND whose posterior has drifted back near their base-rate prior.
     This prevents _posteriors from accumulating hundreds of one-off entries
     (e.g. event regions that fired once and were never mentioned again).
     Threshold: posterior within 5% of base-rate AND last update > 14 days ago. */
  var _POSTERIOR_STALE_MS = 14 * 24 * 60 * 60 * 1000;  // 14 days
  function _pruneInactivePosteriors() {
    var now = Date.now();
    Object.keys(_posteriors).forEach(function (region) {
      var p = _posteriors[region];
      if (!p) return;
      // Skip regions that are still contributing active signals
      if (p.contributing && p.contributing.length > 0) return;
      // Calculate staleness
      var lastTs = p.lastUpdated ? new Date(p.lastUpdated).getTime() : 0;
      var stale  = (now - lastTs) > _POSTERIOR_STALE_MS;
      if (!stale) return;
      // Only prune if posterior has returned near base-rate (±5%)
      var base = BASE_RATES[region] || 0.20;
      var nearBase = Math.abs(p.posterior - base) <= 0.05;
      if (nearBase) {
        delete _posteriors[region];
        delete _posteriorHistory[region];
        delete _convergence[region];
        console.log('[GII] Pruned inactive posterior for region: ' + region +
                    ' (posterior ' + (p.posterior * 100).toFixed(0) + '% ≈ base-rate, stale > 14d)');
      }
    });
  }

  function _cycle() {
    _lastCycleTs = Date.now();

    // 0. Apply feedback decay (4-week half-life) — runs once per cycle
    _applyFeedbackDecay();

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

    // 6b. Prune orphaned Bayesian posteriors for long-inactive regions
    _pruneInactivePosteriors();

    // 7. GTI
    _computeGTI();

    // 7b. Module 4: market lag detection (uses new _gti vs _prevGTI)
    _lagBoost = _detectMarketLag();

    // 7c. Module 6: meta-agent coordination analysis
    if (window.GII_META && typeof window.GII_META.coordinate === 'function') {
      try { window.GII_META.coordinate(allSignals); } catch (e) {
        console.warn('[GII] GII_META.coordinate() error: ' + (e.message || String(e)));
      }
    }

    // 8. Portfolio decision
    _portfolioDecision(allSignals);

    // 9. Update UI — mark dirty first so the render knows new data is ready
    if (window.GII_UI) {
      try {
        if (typeof window.GII_UI.markDirty === 'function') window.GII_UI.markDirty();
        if (typeof window.GII_UI.render    === 'function') window.GII_UI.render();
      } catch (e) {}
    }
  }

  // ── feedback decay (4-week half-life) ─────────────────────────────────────

  /* Exponential decay applied to stored correct/total counts so that old trades
     have diminishing influence over time.  Half-life = 4 weeks.
     Called once per orchestration cycle (not per trade) to keep it cheap.        */
  function _applyFeedbackDecay() {
    var HALF_LIFE_MS = 4 * 7 * 24 * 60 * 60 * 1000;   // 4 weeks in ms
    var now = Date.now();
    var changed = false;
    Object.keys(_feedback).forEach(function (key) {
      var fb = _feedback[key];
      if (!fb || !fb.lastTs) return;
      var elapsed = now - new Date(fb.lastTs).getTime();
      var decayFactor = Math.pow(0.5, elapsed / HALF_LIFE_MS);
      if (decayFactor > 0.99) return;   // negligible decay — skips entries updated < ~10h ago
      fb.correct = (fb.correct || 0) * decayFactor;
      fb.fp      = (fb.fp      || 0) * decayFactor;
      fb.total   = (fb.total   || 0) * decayFactor;
      if (fb.total < 0.5) {
        // so few effective samples left — reset to neutral
        delete _feedback[key];
        changed = true;
        return;
      }
      fb.winRate   = fb.correct / fb.total;
      fb.fpr       = fb.fp / fb.total;
      fb.reputation = _clamp(fb.winRate * (1 - fb.fpr * 0.5), 0.10, 1.0);
      changed = true;
    });
    // v60: hard cap — keep only top-400 entries by total to prevent unbounded growth
    var fbKeys = Object.keys(_feedback);
    if (fbKeys.length > 400) {
      fbKeys.sort(function (a, b) { return (_feedback[b].total || 0) - (_feedback[a].total || 0); });
      fbKeys.slice(400).forEach(function (k) { delete _feedback[k]; });
      changed = true;
    }

    if (changed) _saveFeedback();
  }

  // ── feedback / self-learning ───────────────────────────────────────────────

  function _onTradeResult(trade) {
    if (!trade || !trade.asset) return;

    // Normalise dir — EE uses 'LONG'/'SHORT' strings; legacy callers may use +1/-1
    var tradeDir = (trade.dir || trade.direction || '');
    var isLong  = (tradeDir === 'LONG'  || tradeDir === 'long'  || (typeof tradeDir === 'number' && tradeDir > 0));
    var isShort = (tradeDir === 'SHORT' || tradeDir === 'short' || (typeof tradeDir === 'number' && tradeDir < 0));
    if (!isLong && !isShort) return;

    var bias   = isLong ? 'long' : 'short';
    var mapKey = trade.asset + '_' + bias;

    // Primary lookup: agents stored when the trade signal was emitted (persists across cycles)
    var agentNames = _giiTradeMap[mapKey] ? _giiTradeMap[mapKey].slice() : [];

    // Fallback: scan current _lastSignals (works when trade closes in same cycle it opened)
    if (!agentNames.length) {
      _lastSignals.forEach(function (s) {
        if (s.asset === trade.asset && s.bias === bias && s._agentName &&
            agentNames.indexOf(s._agentName) === -1) {
          agentNames.push(s._agentName);
        }
      });
    }

    // Fallback 3: infer attribution from trade.reason string.
    // Scalper signals bypass _portfolioDecision() so _giiTradeMap is never populated for them.
    // Without this fallback, ALL scalper-sourced trades silently skip feedback, leaving
    // gii_agent_feedback_v1 permanently empty despite hundreds of qualifying TP/SL closes.
    if (!agentNames.length) {
      var reason = (trade.reason || '').toLowerCase();
      if (reason.indexOf('scalper') !== -1) {
        agentNames = ['scalper'];
        if (reason.indexOf('session') !== -1) agentNames.push('scalper-session');
      } else if (reason.indexOf('gii') !== -1) {
        // Generic GII-attributed trade: attribute to all agents that currently have a signal
        // for this asset/bias so at least some feedback flows through the system
        _lastSignals.forEach(function (s) {
          if (s.asset === trade.asset && s._agentName &&
              agentNames.indexOf(s._agentName) === -1) {
            agentNames.push(s._agentName);
          }
        });
        // If _lastSignals also empty (page reload etc.), use core agents as default attribution
        if (!agentNames.length) agentNames = ['energy', 'conflict', 'macro'];
      }
    }

    if (!agentNames.length) return; // not a GII-originated trade

    // Normalise P&L — EE stores as pnl_usd; accept either field
    var pnl     = (trade.pnl_usd !== undefined) ? trade.pnl_usd : (trade.pnl || 0);
    var winner  = pnl > 0;
    var stopped = trade.close_reason === 'STOP_LOSS' || trade.exitReason === 'stop_loss' ||
                  (!winner && pnl < 0);

    var notifiedAgents = [];
    agentNames.forEach(function (agentName) {
      var fbKey = agentName + '_' + trade.asset + '_' + bias;
      if (!_feedback[fbKey]) _feedback[fbKey] = { total: 0, correct: 0, fp: 0, winRate: null, fpr: null, reputation: null, lastTs: null };
      _feedback[fbKey].total++;
      if (winner)  _feedback[fbKey].correct++;
      if (stopped) _feedback[fbKey].fp = (_feedback[fbKey].fp || 0) + 1;
      _feedback[fbKey].winRate    = _feedback[fbKey].correct / _feedback[fbKey].total;
      _feedback[fbKey].fpr        = (_feedback[fbKey].fp || 0) / _feedback[fbKey].total;
      // Module 3: composite reputation = winRate penalised by false positive rate
      _feedback[fbKey].reputation = _clamp(_feedback[fbKey].winRate * (1 - (_feedback[fbKey].fpr || 0) * 0.5), 0.10, 1.0);
      _feedback[fbKey].lastTs     = new Date().toISOString();

      // Dispatch to individual agent so it can update its own per-asset feedback
      var agentGlobal = 'GII_AGENT_' + agentName.toUpperCase().replace(/-/g, '_');
      if (notifiedAgents.indexOf(agentGlobal) === -1) {
        try {
          var agent = window[agentGlobal];
          if (agent && typeof agent.onTradeResult === 'function') {
            agent.onTradeResult(trade);
            notifiedAgents.push(agentGlobal);
          }
        } catch (e) {}
      }
    });

    // Clear map entry now that feedback is recorded
    delete _giiTradeMap[mapKey];
    _saveFeedback();

    // v54: invalidate routing win-rate cache so the closed trade is reflected
    // immediately on the next route() call instead of waiting up to 5 min
    try {
      if (window.GII_ROUTING && typeof GII_ROUTING.invalidateWinRateCache === 'function') {
        GII_ROUTING.invalidateWinRateCache();
      }
    } catch (e) {}
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII = {
    gti: function () { return { value: _gti, level: _gtiLevel }; },
    posterior: function (region) {
      if (!region) return null;
      return _posteriors[region.toUpperCase()] || null;
    },
    signals:          function () { return _lastSignals.slice(); },
    feedback:         function () { return Object.assign({}, _feedback); },
    gtiHistory:       function () { return _gtiHistory.slice(); },
    posteriorHistory: function (region) {
      if (region) return (_posteriorHistory[region.toUpperCase()] || []).slice();
      return Object.assign({}, _posteriorHistory);
    },
    onTradeResult: _onTradeResult,
    // Module 3: agent reputation scores
    agentReputations: function () {
      var out = {};
      Object.keys(_feedback).forEach(function (key) {
        var fb = _feedback[key];
        out[key] = {
          winRate:    fb.winRate,
          fpr:        fb.fpr || 0,
          reputation: fb.reputation || fb.winRate,
          total:      fb.total
        };
      });
      return out;
    },
    status: function () {
      return {
        lastCycle:        _lastCycleTs,
        gti:              _gti,
        gtiLevel:         _gtiLevel,
        hormuzActive:     _hormuzActive,
        volatilityBoost:  _volatilityBoost,
        marketLagActive:  _marketLagActive,   // Module 4
        lagBoost:         _lagBoost,           // Module 4
        agentCount:       AGENTS.filter(function (d) { return !!_getAgent(d); }).length +
                          // coordination + infrastructure agents not in Bayesian AGENTS array
                          ['GII_AGENT_ENTRY','GII_AGENT_EXIT','GII_AGENT_MANAGER',
                           'GII_ROUTING','GII_SCRAPER_MANAGER']
                            .filter(function (k) { return !!window[k]; }).length,
        signalCount:      _lastSignals.length,
        posteriorRegions: Object.keys(_posteriors).length,
        convergence:      Object.assign({}, _convergence)
      };
    },
    defensiveAssets: function () { return _DEFENSIVE.slice(); },
    riskAssets:      function () { return _RISK_ASSETS.slice(); },
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
