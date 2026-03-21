/**
 * GII Entry Agent — central intelligence hub for trade entry decisions.
 *
 * Behaves like a head trader surrounded by analysts:
 *   • Receives pending signals from IC pipeline and GII core
 *   • Scores each signal against ALL other agents (confluence)
 *   • Only fires trades when multiple independent sources agree
 *   • Applies vetoes from macro, regime, and health agents
 *   • Stores a thesis fingerprint on every approved trade
 *
 * Signal flow:
 *   renderTrades()  ──┐
 *   gii-core        ──┼──► GII_AGENT_ENTRY.submit() ──► (score) ──► EE.onSignals()
 *   (any agent)     ──┘
 *
 * Exposes window.GII_AGENT_ENTRY
 */
(function () {
  'use strict';

  /* ── CONFIG ─────────────────────────────────────────────────────────────── */
  var POLL_MS       = 60 * 1000;   // process queue every 60s
  var INIT_DELAY_MS = 12 * 1000;   // wait for other agents to boot
  var QUEUE_TTL_MS  = 8 * 60 * 1000; // discard pending signals older than 8 min

  /* Minimum confluence score to approve entry */
  var MIN_SCORE_GEO    = 4.0;   // IC geopolitical trades — threshold for OSINT-driven signals
  var MIN_SCORE_GII    = 8.0;   // GII multi-agent trades — raised from 4.0 to 8.0.
                                 // Audit finding: GII confluence score has zero predictive power
                                 // across all score bands (4-5: 10.6% WR; 8+: 12.5% WR).
                                 // At 8.0 floor + asset restriction, GII acts as a high-bar
                                 // confirmation filter rather than an independent trade generator.
  var MIN_SCORE_SCALPER = 3.0;  // Scalper trades

  /* IC-adjacent assets: the only assets where geopolitical/OSINT catalysts
     produce moves large enough to reach 2.5R. Evidence from 315-trade audit:
     - TSLA: +$73.37 total (IC source), expectancy +$9.17, R:R 5.47
     - VXX:  +$11.90 total (IC source), expectancy +$1.98, R:R 27.3
     GII signals on XLE, BRENT, QQQ, TSM, FXI, GLD produced no positive expectancy
     — those assets absorb geopolitical catalysts too slowly for 2.5R targets.
     GII signals restricted to this list. IC signals have no asset restriction. */
  var GII_ALLOWED_ASSETS = {
    'TSLA': true, 'VXX': true, 'LMT': true, 'RTX': true,
    'NVDA': true, 'BTC': true, 'ETH': true, 'XAR': true, 'SMH': true
  };

  /* Minimum number of distinct agent categories that must agree */
  var MIN_CATEGORIES = 3;   /* raised from 2 → 3: requires genuine multi-source confluence */

  /* Minimum ms between approvals for the same asset (prevents runaway re-fire
     after a trade closes and the same escalation chain immediately re-queues) */
  var APPROVED_COOLDOWN_MS = 30 * 60 * 1000;  // 30 minutes

  /* Defensive / risk asset lists — canonical source is GII.defensiveAssets() /
     GII.riskAssets(). Static fallbacks used only if GII loads after this IIFE. */
  var DEFENSIVE   = (window.GII && typeof GII.defensiveAssets === 'function')
                    ? GII.defensiveAssets()
                    : ['GLD', 'XAU', 'SLV', 'JPY', 'CHF', 'VIX', 'TLT', 'GAS'];
  var RISK_ASSETS = (window.GII && typeof GII.riskAssets === 'function')
                    ? GII.riskAssets()
                    : ['BTC', 'SPY', 'QQQ', 'TSM', 'NVDA', 'TSLA', 'SMH', 'FXI'];

  /* ── PER-ASSET VOLATILITY STOPS ─────────────────────────────────────────
   * Flat 3% stops get hit by normal noise on high-vol assets (BTC moves 3%
   * in hours on a quiet day). These stopPct / tpRatio values are attached to
   * every approved signal — EE.buildTrade() reads them instead of the flat
   * config. tpRatio 2.5 on all assets (vs default 2.0) improves expectancy. */
  var VOL_STOPS = {
    'BTC':   { stopPct: 6.0, tpRatio: 2.5 },  /* Crypto — widest */
    'ETH':   { stopPct: 7.0, tpRatio: 2.5 },
    'TSLA':  { stopPct: 5.5, tpRatio: 2.5 },  /* High-vol equities */
    'NVDA':  { stopPct: 5.0, tpRatio: 2.5 },
    'SMH':   { stopPct: 4.0, tpRatio: 2.5 },
    'TSM':   { stopPct: 4.0, tpRatio: 2.5 },
    'FXI':   { stopPct: 4.0, tpRatio: 2.5 },
    'WTI':   { stopPct: 3.5, tpRatio: 2.5 },  /* Energy */
    'BRENT': { stopPct: 3.5, tpRatio: 2.5 },
    'XLE':   { stopPct: 3.0, tpRatio: 2.5 },
    'GAS':   { stopPct: 4.5, tpRatio: 2.5 },
    'SPY':   { stopPct: 2.5, tpRatio: 2.5 },  /* Broad market */
    'QQQ':   { stopPct: 2.5, tpRatio: 2.5 },
    'GLD':   { stopPct: 2.0, tpRatio: 2.5 },  /* Safe-haven / low-vol */
    'XAU':   { stopPct: 2.0, tpRatio: 2.5 },
    'SLV':   { stopPct: 2.5, tpRatio: 2.5 },
    'TLT':   { stopPct: 1.5, tpRatio: 2.5 },
    'JPY':   { stopPct: 1.5, tpRatio: 2.5 },
    'CHF':   { stopPct: 1.5, tpRatio: 2.5 },
    'VIX':    { stopPct: 8.0, tpRatio: 2.0 },  /* VIX is extremely volatile */
    'VXX':    { stopPct: 6.0, tpRatio: 2.0 },  /* VXX ETF — same signal, lower raw vol than VIX index */
    'SILVER': { stopPct: 2.5, tpRatio: 2.5 },  /* v54: was missing — fell through to 3% default */
    'CRUDE':  { stopPct: 3.5, tpRatio: 2.5 },  /* v54: alias for WTI */
    'OIL':    { stopPct: 3.5, tpRatio: 2.5 }   /* v54: alias for WTI */
  };
  var VOL_STOP_DEFAULT = { stopPct: 3.0, tpRatio: 2.5 };

  /* Max trades that can be opened from a single news event (signal.reason prefix).
     Prevents one "Iran Escalation" headline from opening 10+ correlated positions. */
  var MAX_TRADES_PER_EVENT = 3;

  /* ── STATE ──────────────────────────────────────────────────────────────── */
  var _queue        = [];   // pending signals awaiting scoring
  var _approved     = [];   // last 50 approved signals (audit log)
  var _rejected     = [];   // last 50 rejected signals (audit log)
  var _lastPoll     = 0;
  var _lastApproved = {};   // asset → timestamp of last approval (runaway-loop guard)
  var _stats        = { submitted: 0, approved: 0, rejected: 0, vetoed: 0, rotated: 0 };

  /* ── QUEUE ──────────────────────────────────────────────────────────────── */
  function _submit(signals, sourceTag) {
    var now = Date.now();
    (Array.isArray(signals) ? signals : [signals]).forEach(function (s) {
      if (!s || !s.asset || !s.dir) return;
      // Reject malformed confidence values (must be 0-100 or absent for default)
      if (s.conf !== undefined && s.conf !== null && (!isFinite(s.conf) || s.conf < 0 || s.conf > 100)) {
        _stats.rejected++;
        _rejected.unshift({ asset: s.asset, dir: s.dir,
          reason: 'invalid conf ' + s.conf + ' (must be 0-100)', ts: now });
        if (_rejected.length > 50) _rejected.pop();
        return;
      }
      var _src = sourceTag || s.source || 'ic';
      var _isScalperSrc = _src === 'scalper' || _src === 'scalper-session' ||
                          (s.reason && s.reason.indexOf('SCALPER') === 0);
      // Reject single-source signals early — don't waste scoring cycles on them
      if (!_isScalperSrc && s.srcCount !== undefined && s.srcCount < 2) {
        _stats.rejected++;
        _rejected.unshift({ asset: s.asset, dir: s.dir,
          reason: 'srcCount ' + s.srcCount + ' < 2 at queue — dropped before scoring', ts: now });
        if (_rejected.length > 50) _rejected.pop();
        return;
      }
      _stats.submitted++;
      _queue.push({
        sig:       s,
        source:    _src,
        queuedAt:  now
      });
    });
  }

  /* ── CONFLUENCE SCORING ─────────────────────────────────────────────────── */

  /* Returns the dominant bias ('long'/'short') and count from an agent's signals
     filtered to assets matching or related to the target asset/region */
  function _agentBias(agentName, asset, dir, region) {
    var agent = window[agentName];
    if (!agent) return null;
    var sigs = [];
    try { sigs = agent.signals ? agent.signals() : []; } catch (e) { return null; }
    if (!sigs.length) return null;

    /* Find signals agreeing with this asset or region.
       NO direction-only fallback — that was causing false confluence:
       unrelated agents (e.g. Energy agent bearish on WTI) were falsely
       "confirming" BTC shorts just because both happened to be bearish.
       If this agent has no signals for the specific asset or region,
       it abstains from the score (returns null). */
    var relevant = sigs.filter(function (s) {
      var assetMatch  = s.asset === asset;
      var regionMatch = region && s.region === region;
      return assetMatch || regionMatch;
    });
    if (!relevant.length) return null;  // agent abstains — no relevant view

    var biasDir = dir === 'SHORT' ? 'short' : 'long';
    var matching = relevant.filter(function (s) { return s.bias === biasDir; });
    var opposing = relevant.filter(function (s) { return s.bias && s.bias !== biasDir && s.bias !== 'neutral'; });

    return {
      agrees:   matching.length > opposing.length,
      opposes:  opposing.length > matching.length,
      strength: matching.length ? (matching[0].confidence || 0.5) : 0
    };
  }

  function _scoreSignal(item) {
    var sig    = item.sig;
    var dir    = sig.dir;   // 'LONG' or 'SHORT'
    var asset  = sig.asset;
    var region = sig.region || 'GLOBAL';
    var isScalper = item.source === 'scalper' || item.source === 'scalper-session';

    var score      = 0;
    var categories = {};   // track distinct categories for min-category check
    var agentsFor  = [];
    var agentsAgainst = [];

    /* ── CATEGORY: Technical ─────────────────────────────────── */
    // Scalper agents — strongest technical signal
    ['GII_AGENT_SCALPER', 'GII_AGENT_SCALPER_SESSION'].forEach(function (name) {
      var b = _agentBias(name, asset, dir, region);
      if (!b) return;
      if (b.agrees) {
        score += 2.5 * b.strength;
        categories.technical = true;
        agentsFor.push(name.replace('GII_AGENT_', '').toLowerCase());
      } else if (b.opposes) {
        score -= 1.5;
        agentsAgainst.push(name.replace('GII_AGENT_', '').toLowerCase());
      }
    });

    // Market structure / optimizer
    ['GII_AGENT_MARKETSTRUCTURE', 'GII_AGENT_OPTIMIZER', 'GII_AGENT_SMARTMONEY'].forEach(function (name) {
      var b = _agentBias(name, asset, dir, region);
      if (!b) return;
      if (b.agrees) {
        score += 1.5 * b.strength;
        categories.technical = true;
        agentsFor.push(name.replace('GII_AGENT_', '').toLowerCase());
      } else if (b.opposes) {
        score -= 1.0;
        agentsAgainst.push(name.replace('GII_AGENT_', '').toLowerCase());
      }
    });

    /* ── CATEGORY: Fundamental / Geopolitical ────────────────── */
    var fundamentalAgents = {
      GII_AGENT_ENERGY:   2.0,
      GII_AGENT_CONFLICT: 1.5,
      GII_AGENT_SANCTIONS:1.0,
      GII_AGENT_MARITIME: 1.0,
      GII_AGENT_SOCIAL:   0.5
    };
    Object.keys(fundamentalAgents).forEach(function (name) {
      var b = _agentBias(name, asset, dir, region);
      if (!b) return;
      var w = fundamentalAgents[name];
      if (b.agrees) {
        score += w * Math.max(0.5, b.strength);
        categories.fundamental = true;
        agentsFor.push(name.replace('GII_AGENT_', '').toLowerCase());
      } else if (b.opposes) {
        score -= w * 0.5;
        agentsAgainst.push(name.replace('GII_AGENT_', '').toLowerCase());
      }
    });

    /* ── CATEGORY: Macro / Regime ────────────────────────────── */
    if (window.GII_AGENT_MACRO) {
      try {
        var macroSt = GII_AGENT_MACRO.status();
        var riskMode = macroSt.riskMode;
        var isLong   = dir === 'LONG';
        var isDef    = DEFENSIVE.indexOf(asset) !== -1;

        if (riskMode === 'RISK_ON'  && isLong && !isDef) { score += 2.0; categories.macro = true; agentsFor.push('macro'); }
        if (riskMode === 'RISK_OFF' && !isLong)          { score += 1.5; categories.macro = true; agentsFor.push('macro'); }
        if (riskMode === 'RISK_OFF' && isLong && isDef)  { score += 1.5; categories.macro = true; agentsFor.push('macro-defensive'); }
        if (riskMode === 'RISK_OFF' && isLong && !isDef) { score -= 1.5; agentsAgainst.push('macro'); }
      } catch (e) {}
    }

    if (window.GII_AGENT_REGIME) {
      try {
        var regSt = GII_AGENT_REGIME.status();
        if (regSt.regimeShiftActive) {
          /* Active regime shift vetoes non-defensive entries for 1h */
          score -= 3.0;
          agentsAgainst.push('regime-shift');
        }
      } catch (e) {}
    }

    /* ── CATEGORY: Bayesian Probability ─────────────────────── */
    if (window.GII) {
      try {
        var post = GII.posterior(region);
        if (post && post.posterior) {
          var p = post.posterior;
          if (p > 0.65) {
            score += 2.0 * p;
            categories.probabilistic = true;
            agentsFor.push('bayesian(' + Math.round(p * 100) + '%)');
          } else if (p < 0.30 && dir === 'LONG') {
            score -= 1.5;
            agentsAgainst.push('bayesian-low');
          }
        }
        /* IC region state */
        var IC = window.__IC;
        if (IC && IC.regionStates && IC.regionStates[region]) {
          var regionProb = IC.regionStates[region].prob || 0;
          if (regionProb > 60) {
            score += 1.5 * (regionProb / 100);
            categories.probabilistic = true;
            agentsFor.push('ic-region(' + regionProb + '%)');
          }
        }
      } catch (e) {}
    }

    /* ── CATEGORY: Polymarket edge ───────────────────────────── */
    /* Audit fix: use per-asset/region signals from Polymarket rather than
       the global avgEdge. avgEdge is an average across ALL markets — a large
       edge on a US election market was falsely boosting oil and crypto entries.
       Now we look for a Polymarket signal that matches this specific asset or region. */
    if (window.GII_AGENT_POLYMARKET) {
      try {
        var pmSigs = GII_AGENT_POLYMARKET.signals ? GII_AGENT_POLYMARKET.signals() : [];
        var pmRelevant = pmSigs.filter(function (s) {
          return s.asset === asset || (region && s.region === region);
        });
        if (pmRelevant.length) {
          var pmBest = pmRelevant.reduce(function (best, s) {
            return (s.confidence || 0) > (best.confidence || 0) ? s : best;
          }, pmRelevant[0]);
          var pmEdge = pmBest.confidence || 0;
          if (pmEdge > 0.10) {
            score += 2.0 * Math.min(1, pmEdge);
            categories.probabilistic = true;
            agentsFor.push('polymarket(' + Math.round(pmEdge * 100) + '% edge)');
          }
        } else {
          /* No asset/region match — fall back to global avgEdge but at reduced weight */
          var pmSt = GII_AGENT_POLYMARKET.status();
          if (pmSt.avgEdge > 0.15) {  // raised threshold since it's a weak signal
            score += 0.8 * Math.min(1, pmSt.avgEdge);  // 0.8× instead of 2.0× weight
            categories.probabilistic = true;
            agentsFor.push('polymarket-global(' + Math.round(pmSt.avgEdge * 100) + '%)');
          }
        }
      } catch (e) {}
    }

    /* ── GTI context bonus/penalty ───────────────────────────── */
    if (window.GII) {
      try {
        var gtiData = GII.gti();
        var gtiVal  = gtiData ? gtiData.value : 0;
        /* High tension (40-75): good for oil, gold, defence longs */
        var oilGoldDef = ['WTI','BRENT','GLD','XAU','LMT','RTX','XAR','NOC'].indexOf(asset) !== -1;
        if (gtiVal >= 40 && gtiVal <= 75 && oilGoldDef && dir === 'LONG') { score += 1.0; }
        /* Extreme tension (>80): only defensive assets */
        if (gtiVal > 80 && dir === 'LONG' && RISK_ASSETS.indexOf(asset) !== -1) { score -= 2.0; }
      } catch (e) {}
    }

    /* ── CATEGORY: Technical trend alignment ─────────────────── */
    /* Geopolitical entries often trade against the established technical trend
       (a crisis shock can break a trend). Rather than a hard veto, apply a
       score penalty for clear counter-trend entries so only signals with strong
       multi-agent backing (score >6.0 net) can trade against the trend.
       Uses GII_AGENT_TECHNICALS signals with confidence threshold 0.50.          */
    if (window.GII_AGENT_TECHNICALS) {
      try {
        var _techSigs = GII_AGENT_TECHNICALS.signals();
        for (var _ti = 0; _ti < _techSigs.length; _ti++) {
          if (_techSigs[_ti].asset === asset && (_techSigs[_ti].confidence || 0) >= 0.50) {
            var _techDir = _techSigs[_ti].bias === 'long' ? 'LONG' : 'SHORT';
            if (_techDir === dir) {
              score += 1.0;
              categories.technical = true;
              agentsFor.push('technicals-aligned');
            } else {
              score -= 1.5;
              agentsAgainst.push('technicals-counter');
            }
            break;
          }
        }
      } catch (e) {}
    }

    var categoryCount = Object.keys(categories).length;
    return { score: score, categories: categoryCount, agentsFor: agentsFor, agentsAgainst: agentsAgainst };
  }

  /* ── VETO CHECKS ────────────────────────────────────────────────────────── */
  function _veto(item) {
    var sig   = item.sig;
    var asset = sig.asset;
    var dir   = sig.dir;
    var isDef = DEFENSIVE.indexOf(asset) !== -1;

    /* Veto 1: active regime shift — nothing enters for 60 min */
    if (window.GII_AGENT_REGIME) {
      try {
        var regSt = GII_AGENT_REGIME.status();
        if (regSt.regimeShiftActive && !isDef) return 'active-regime-shift';
      } catch (e) {}
    }

    /* Veto 2: extreme VIX + RISK_OFF → no risk-asset longs */
    if (window.GII_AGENT_MACRO) {
      try {
        var macroSt = GII_AGENT_MACRO.status();
        var vix = macroSt.vix || 0;
        if (vix > 45 && macroSt.riskMode === 'RISK_OFF' &&
            dir === 'LONG' && RISK_ASSETS.indexOf(asset) !== -1) {
          return 'vix-spike-' + vix;
        }
      } catch (e) {}
    }

    /* Veto 3: manager has multiple active errors (not just one agent loading slowly).
       Changed from errors > 0 to errors > 2: a single load-timing error (e.g. one
       agent not yet registered at startup) was blocking ALL signals permanently until
       the next 5-min manager poll cycle — far too aggressive.                       */
    if (window.GII_AGENT_MANAGER) {
      try {
        var mgr = GII_AGENT_MANAGER.status();
        if (mgr.errors > 2) return 'system-health-error';
      } catch (e) {}
    }

    /* Veto 4: asset already has open position.
       Use EE.getOpenTrades() — authoritative in-memory source.
       Previous impl read localStorage directly which can diverge from in-memory
       state after the SQLite backend loads and merges trades. */
    if (window.EE && typeof EE.getOpenTrades === 'function') {
      try {
        var hasOpen = EE.getOpenTrades().some(function (t) { return t.asset === asset; });
        if (hasOpen) return 'position-already-open';
      } catch (e) {}
    }

    /* Veto 5: GTI extreme (>85) blocks new risk-asset longs */
    if (window.GII) {
      try {
        var gtiData = GII.gti();
        if (gtiData && gtiData.value > 85 &&
            dir === 'LONG' && RISK_ASSETS.indexOf(asset) !== -1) {
          return 'gti-extreme-' + Math.round(gtiData.value);
        }
      } catch (e) {}
    }

    return null;
  }

  /* ── THESIS FINGERPRINT ─────────────────────────────────────────────────── */
  function _buildThesis(item, scoreResult) {
    var region = item.sig.region || 'GLOBAL';
    var thesis = {
      confluenceScore:   +scoreResult.score.toFixed(2),
      categoryCount:     scoreResult.categoryCount,
      agentsFor:         scoreResult.agentsFor,
      agentsAgainst:     scoreResult.agentsAgainst,
      source:            item.source,
      timestamp:         Date.now()
    };
    try {
      if (window.GII) {
        var post = GII.posterior(region);
        if (post) { thesis.posteriorAtEntry = +post.posterior.toFixed(3); }
        var gtiData = GII.gti();
        if (gtiData) { thesis.gtiAtEntry = +gtiData.value.toFixed(1); }
        var giiSt = GII.status();
        if (giiSt) { thesis.regimeAtEntry = giiSt.gtiLevel; }
      }
      if (window.GII_AGENT_MACRO) {
        var mSt = GII_AGENT_MACRO.status();
        thesis.riskModeAtEntry = mSt.riskMode;
        thesis.vixAtEntry      = mSt.vix;
      }
      if (window.__IC && __IC.regionStates && __IC.regionStates[region]) {
        thesis.regionProbAtEntry = __IC.regionStates[region].prob;
      }
    } catch (e) {}
    return thesis;
  }

  /* ── PROCESS QUEUE ──────────────────────────────────────────────────────── */
  function _processQueue() {
    var now = Date.now();

    /* Expire stale items — log each one so queue drops are visible in audit log */
    var _expiredItems = _queue.filter(function (item) { return (now - item.queuedAt) >= QUEUE_TTL_MS; });
    _expiredItems.forEach(function (item) {
      _stats.rejected++;
      _rejected.unshift({ asset: item.sig.asset, dir: item.sig.dir, reason: 'queue-ttl-expired', ts: now });
      if (_rejected.length > 50) _rejected.pop();
    });
    _queue = _queue.filter(function (item) { return (now - item.queuedAt) < QUEUE_TTL_MS; });

    if (!_queue.length) return;

    /* Deduplicate queue by asset: if both LONG and SHORT arrive for the same
       asset, score both and keep the one with higher confluence.
       Previous impl kept highest raw confidence regardless of direction —
       a LONG with conf=72 would beat a SHORT with conf=70 and better agent backing.
       Now we pre-score both and let the signals compete on confluence quality. */
    var byAsset = {};
    _queue.forEach(function (item) {
      var key = item.sig.asset;
      if (!byAsset[key]) {
        byAsset[key] = item;
      } else {
        /* Both directions queued — score both, keep better confluence */
        var existingScore = _scoreSignal(byAsset[key]).score;
        var newScore      = _scoreSignal(item).score;
        if (newScore > existingScore) byAsset[key] = item;
      }
    });
    _queue = [];   // consumed

    var toEmit = [];

    Object.keys(byAsset).forEach(function (key) {
      var item      = byAsset[key];
      var sig       = item.sig;
      var isScalper = item.source === 'scalper' || item.source === 'scalper-session';
      var isIC      = item.source === 'ic';
      var isGII     = !isScalper && !isIC;   // gii, gii-core, or untagged geo signals

      /* Per-asset approved cooldown — blocks re-approval of same asset within
         30 minutes of last approval. Prevents runaway escalation chains from
         opening a new trade immediately after a trade closes on same asset. */
      if ((now - (_lastApproved[sig.asset] || 0)) < APPROVED_COOLDOWN_MS) {
        var _coolMinsLeft = Math.ceil((APPROVED_COOLDOWN_MS - (now - (_lastApproved[sig.asset] || 0))) / 60000);
        _stats.rejected++;
        _rejected.unshift({ asset: sig.asset, dir: sig.dir,
          reason: 'approved-cooldown: ' + _coolMinsLeft + 'min remaining', ts: now });
        if (_rejected.length > 50) _rejected.pop();
        return;
      }

      /* Capital allocation gate: GII signals are restricted to IC-adjacent
         high-beta assets and require a much higher confluence score.
         Audit (315 trades): GII has -$2.31 expectancy, score has no predictive value.
         IC has +$2.63 expectancy, concentrated in TSLA/VXX.
         GII signals on XLE/BRENT/TSM/QQQ etc. have produced no demonstrated edge. */
      if (isGII) {
        if (!GII_ALLOWED_ASSETS[sig.asset]) {
          _stats.rejected++;
          _rejected.unshift({ asset: sig.asset, dir: sig.dir,
            reason: 'GII asset gate: ' + sig.asset + ' not in IC-adjacent list (no demonstrated edge)', ts: now });
          if (_rejected.length > 50) _rejected.pop();
          return;
        }
      }

      var minScore = isScalper ? MIN_SCORE_SCALPER
                   : isGII    ? MIN_SCORE_GII
                   :            MIN_SCORE_GEO;

      /* Veto check first (fast) */
      var vetoReason = _veto(item);
      if (vetoReason) {
        _stats.vetoed++;
        _stats.rejected++;
        _rejected.unshift({ asset: sig.asset, dir: sig.dir, reason: 'VETO: ' + vetoReason, ts: now });
        if (_rejected.length > 50) _rejected.pop();
        return;
      }

      /* Confluence score */
      var result = _scoreSignal(item);

      if (result.score < minScore || result.categories < MIN_CATEGORIES) {
        _stats.rejected++;
        _rejected.unshift({
          asset:      sig.asset,
          dir:        sig.dir,
          score:      +result.score.toFixed(2),
          categories: result.categories,
          needed:     minScore,
          reason:     'score ' + result.score.toFixed(2) + ' < ' + minScore +
                      ' | categories ' + result.categories + '/' + MIN_CATEGORIES,
          ts:         now
        });
        if (_rejected.length > 50) _rejected.pop();
        return;
      }

      /* Per-event trade cap: no more than MAX_TRADES_PER_EVENT open trades from the
         same news event. Uses first 40 chars of sig.reason as the event key.
         Scalper signals are exempt — they use technical setups, not news events. */
      if (!isScalper && sig.reason && window.EE && typeof EE.getOpenTrades === 'function') {
        try {
          var _eventKey = (sig.reason || '').substring(0, 40).toLowerCase();
          var _openFromEvent = EE.getOpenTrades().filter(function (t) {
            return (t.reason || '').substring(0, 40).toLowerCase() === _eventKey;
          }).length;
          if (_openFromEvent >= MAX_TRADES_PER_EVENT) {
            _stats.rejected++;
            _rejected.unshift({ asset: sig.asset, dir: sig.dir,
              reason: 'event cap: ' + _openFromEvent + '/' + MAX_TRADES_PER_EVENT +
                ' trades already open for "' + sig.reason.substring(0, 35) + '"', ts: now });
            if (_rejected.length > 50) _rejected.pop();
            return;
          }
        } catch (e) {}
      }

      /* Smart region/sector rotation — if cap is full, replace weakest trade when new signal scores higher.
         Always keep the highest-conviction opportunities open rather than blocking good signals. */
      var ENTRY_SECTOR_MAP = {
        'WTI':'energy','BRENT':'energy','XLE':'energy','GAS':'energy',
        'XAU':'precious','GLD':'precious','SLV':'precious',
        'BTC':'crypto','ETH':'crypto',
        'SPY':'equity','QQQ':'equity','NVDA':'equity',
        'TSLA':'equity','SMH':'equity','TSM':'equity','FXI':'equity'
      };
      if (window.EE && typeof EE.getOpenTrades === 'function' && typeof EE.getConfig === 'function') {
        try {
          var eeOpen  = EE.getOpenTrades();
          var eeCfg   = EE.getConfig();
          var newScore = result.score;

          /* Score proxy for comparing open trades:
             uses stored confluenceScore from thesis, falls back to conf/15
             (conf=65 → 4.3, conf=95 → 6.3 — comparable to confluence range 4.5–7) */
          function _tradeScore(t) {
            return (t.thesis && t.thesis.confluenceScore) ? t.thesis.confluenceScore : (t.conf || 50) / 15;
          }

          /* Minimum score advantage required to justify rotation.
             Raised 25%→60%: rotation is a high-cost action (closes a live trade).
             The bar must be high. A new signal scoring 6.0 vs incumbent 5.0 = 20% — block.
             A new signal scoring 8.0 vs incumbent 5.0 = 60% — rotate.
             Audit data showed ROTATION_MIN_DELTA=0.25 triggered ~50 XLE rotations alone,
             destroying $150+ in incumbents before they could reach their targets. */
          var ROTATION_MIN_DELTA = 0.60;

          /* P&L protection: check if an incumbent trade is currently profitable.
             A trade that is in profit must NEVER be force-closed by rotation — it is
             actively realizing edge. Block the new signal instead.
             Uses EE price cache which is the same source as trade monitoring. */
          function _incumbentInProfit(t) {
            try {
              if (window.EE && typeof EE.getLastPrice === 'function') {
                var _lp = EE.getLastPrice(t.asset);
                if (!_lp || !t.entry_price) return false;
                return t.direction === 'LONG' ? _lp > t.entry_price : _lp < t.entry_price;
              }
            } catch (e) {}
            return false;  // can't determine — treat as not in profit (safe default)
          }

          /* Minimum trade age before it can be rotated out.
             A trade opened 20 minutes ago has not yet had time to develop.
             Geopolitical trades typically need hours to manifest — 4h minimum
             ensures the incumbent gets a genuine opportunity before eviction. */
          var ROTATION_MIN_AGE_MS = 4 * 60 * 60 * 1000;

          /* Region rotation */
          var regionTrades = eeOpen.filter(function (t) { return t.region === sig.region; });
          if (eeCfg.max_per_region && regionTrades.length >= eeCfg.max_per_region) {
            var weakestRegion = regionTrades.slice().sort(function (a, b) {
              return _tradeScore(a) - _tradeScore(b);
            })[0];
            var weakestRegionScore = weakestRegion ? _tradeScore(weakestRegion) : 0;
            if (weakestRegion && newScore > weakestRegionScore * (1 + ROTATION_MIN_DELTA)) {
              /* Score clears the bar — but only rotate if incumbent is NOT in profit AND old enough */
              var _regionAge = Date.now() - new Date(weakestRegion.timestamp_open || 0).getTime();
              if (_incumbentInProfit(weakestRegion)) {
                /* Incumbent is in profit — protect it, block incoming signal instead */
                _stats.rejected++;
                _rejected.unshift({ asset: sig.asset, dir: sig.dir,
                  reason: 'rotation blocked: ' + weakestRegion.asset + ' incumbent in profit (score ' +
                    newScore.toFixed(2) + ' vs ' + weakestRegionScore.toFixed(2) + ')', ts: now });
                if (_rejected.length > 50) _rejected.pop();
                return;
              }
              if (_regionAge < ROTATION_MIN_AGE_MS) {
                /* Incumbent too young — protect it, block incoming signal */
                _stats.rejected++;
                _rejected.unshift({ asset: sig.asset, dir: sig.dir,
                  reason: 'rotation blocked: ' + weakestRegion.asset + ' too young (' +
                    Math.round(_regionAge / 60000) + 'min < ' + (ROTATION_MIN_AGE_MS / 60000) + 'min min)', ts: now });
                if (_rejected.length > 50) _rejected.pop();
                return;
              }
              /* Safe to rotate — losing trade, old enough, clearly outscored */
              try { EE.forceCloseTrade(weakestRegion.trade_id,
                'GII-ENTRY:rotated-by-' + sig.asset + '(score ' + newScore.toFixed(2) + '>' + weakestRegionScore.toFixed(2) + ')'); } catch (e) {}
              _stats.rotated++;
            } else {
              /* Score difference not significant enough — keep incumbents */
              _stats.rejected++;
              _rejected.unshift({ asset: sig.asset, dir: sig.dir,
                reason: 'region cap: ' + sig.region + ' score delta insufficient (' +
                  (weakestRegion ? weakestRegionScore.toFixed(2) : '?') + ' vs ' + newScore.toFixed(2) + ', need +60%)', ts: now });
              if (_rejected.length > 50) _rejected.pop();
              return;
            }
          }

          /* Sector rotation */
          var assetSector = ENTRY_SECTOR_MAP[sig.asset];
          if (assetSector && eeCfg.max_per_sector) {
            var sectorTrades = eeOpen.filter(function (t) {
              return ENTRY_SECTOR_MAP[t.asset] === assetSector;
            });
            if (sectorTrades.length >= eeCfg.max_per_sector) {
              var weakestSector = sectorTrades.slice().sort(function (a, b) {
                return _tradeScore(a) - _tradeScore(b);
              })[0];
              var weakestSectorScore = weakestSector ? _tradeScore(weakestSector) : 0;
              if (weakestSector && newScore > weakestSectorScore * (1 + ROTATION_MIN_DELTA)) {
                /* Score clears bar — apply same P&L + age protection as region rotation */
                var _sectorAge = Date.now() - new Date(weakestSector.timestamp_open || 0).getTime();
                if (_incumbentInProfit(weakestSector)) {
                  _stats.rejected++;
                  _rejected.unshift({ asset: sig.asset, dir: sig.dir,
                    reason: 'sector rotation blocked: ' + weakestSector.asset + ' incumbent in profit', ts: now });
                  if (_rejected.length > 50) _rejected.pop();
                  return;
                }
                if (_sectorAge < ROTATION_MIN_AGE_MS) {
                  _stats.rejected++;
                  _rejected.unshift({ asset: sig.asset, dir: sig.dir,
                    reason: 'sector rotation blocked: ' + weakestSector.asset + ' too young (' +
                      Math.round(_sectorAge / 60000) + 'min)', ts: now });
                  if (_rejected.length > 50) _rejected.pop();
                  return;
                }
                try { EE.forceCloseTrade(weakestSector.trade_id,
                  'GII-ENTRY:rotated-by-' + sig.asset + '(score ' + newScore.toFixed(2) + '>' + weakestSectorScore.toFixed(2) + ')'); } catch (e) {}
                _stats.rotated++;
              } else {
                _stats.rejected++;
                _rejected.unshift({ asset: sig.asset, dir: sig.dir,
                  reason: 'sector cap: ' + assetSector + ' score delta insufficient (' +
                    (weakestSector ? weakestSectorScore.toFixed(2) : '?') + ' vs ' + newScore.toFixed(2) + ', need +60%)', ts: now });
                if (_rejected.length > 50) _rejected.pop();
                return;
              }
            }
          }
        } catch (e) {}
      }

      /* Signal age decay: confidence decays within the 8-min TTL window.
         A signal queued 7 min ago has stale context vs. one queued 10 sec ago.
         Graduated decay preserves speed-of-signal advantage without hard TTL cliff.
         < 1 min: 100%, 1–2 min: 95%, 2–4 min: 85%, 4–8 min: 70% */
      var _sigAgeMin = (now - item.queuedAt) / 60000;
      var _ageMult   = _sigAgeMin < 1 ? 1.00
                     : _sigAgeMin < 2 ? 0.95
                     : _sigAgeMin < 4 ? 0.85
                     : 0.70;

      /* Approved — enrich signal with thesis fingerprint + volatility stops */
      var volStop  = VOL_STOPS[sig.asset] || VOL_STOP_DEFAULT;
      /* IV-adjusted stop: use UW IV rank as ATR proxy — high IV means wider daily
         ranges, so we need a wider stop to avoid noise-stop-outs.
         Adjustments: IV>80 → +50%, IV>60 → +20%, IV<20 → -15% (quiet market).
         Falls back to VOL_STOPS table value when UW data not available.           */
      var dynStopPct = volStop.stopPct;
      try {
        if (window.GII_AGENT_UW && typeof GII_AGENT_UW.getIVRanks === 'function') {
          var _ivMap  = GII_AGENT_UW.getIVRanks();
          var _ivRank = _ivMap[sig.asset];
          if (typeof _ivRank === 'number') {
            if      (_ivRank > 80) dynStopPct = Math.min(volStop.stopPct * 1.5, volStop.stopPct * 2.0);
            else if (_ivRank > 60) dynStopPct = volStop.stopPct * 1.2;
            else if (_ivRank < 20) dynStopPct = volStop.stopPct * 0.85;
          }
        }
      } catch (e) {}
      var enriched = Object.assign({}, sig, {
        thesis:          _buildThesis(item, result),
        confluenceScore: result.score,
        source:          item.source,
        stopPct:         sig.stopPct  || dynStopPct,   /* IV-adjusted stop % — EE overrides flat % */
        tpRatio:         sig.tpRatio  || volStop.tpRatio    /* per-asset R:R  — EE overrides flat 2.0 */
      });

      /* Boost confidence by confluence (up to +5 points), capped at 88.
         Multiplier reduced 0.6→0.4 so high-scoring signals receive proportionally
         more lift than borderline passes — preserves quality differentiation.
         Audit finding: with +8 boost and 95 cap, nearly all approved trades hit 95%
         making confidence indistinguishable between winners and losers.
         Smaller boost + lower cap preserves meaningful differentiation. */
      var confBoost = Math.min(5, Math.floor(result.score * 0.4));
      enriched.conf = Math.min(88, (sig.conf || 50) + confBoost);

      /* Apply signal age decay: older queued signals get a confidence haircut.
         Floor: never reduce below 40% (preserves signal even at max age). */
      if (_ageMult < 1.0) {
        var _preDecay = enriched.conf;
        enriched.conf = Math.max(40, Math.round(enriched.conf * _ageMult));
        console.log('[GII-ENTRY] Age-decay ×' + _ageMult + ' on ' + sig.asset +
          ' (' + _sigAgeMin.toFixed(1) + 'min old): conf ' + _preDecay + '→' + enriched.conf);
      }

      toEmit.push(enriched);
      _lastApproved[sig.asset] = now;   // stamp 30-min cooldown on this asset
      _stats.approved++;
      _approved.unshift({
        asset: sig.asset, dir: sig.dir,
        score: +result.score.toFixed(2),
        conf:  enriched.conf,
        agentsFor: result.agentsFor,
        ts:    now
      });
      if (_approved.length > 50) _approved.pop();
    });

    if (toEmit.length && window.EE && typeof EE.onSignals === 'function') {
      /* EV-based ranking: sort signals by expected value = (conf/100) × tpRatio
         before handing off to EE. EE processes signals in-order so highest-EV
         opportunities fill trade slots first when the portfolio is near capacity.
         Example: BTC conf=85, tpR=2.5 → EV=2.13 beats SPY conf=88, tpR=2.0 → EV=1.76 */
      if (toEmit.length > 1) {
        toEmit.sort(function (a, b) {
          var evA = (a.conf / 100) * (a.tpRatio || 2.5);
          var evB = (b.conf / 100) * (b.tpRatio || 2.5);
          return evB - evA;  // descending: highest EV first
        });
        console.log('[GII-ENTRY] EV-ranked ' + toEmit.length + ' signals: ' +
          toEmit.map(function (s) {
            return s.asset + '(' + ((s.conf / 100) * (s.tpRatio || 2.5)).toFixed(2) + ')';
          }).join(', '));
      }
      EE.onSignals(toEmit);
    }
  }

  /* ── PUBLIC API ─────────────────────────────────────────────────────────── */
  window.GII_AGENT_ENTRY = {

    /* Called by renderTrades() and gii-core instead of EE.onSignals() directly */
    submit: _submit,

    /* Force a poll/process cycle right now */
    poll: _processQueue,

    signals: function () { return _approved.slice(0, 20); },

    status: function () {
      return {
        lastPoll:      _lastPoll,
        queueDepth:    _queue.length,
        stats:         _stats,
        recentApproved: _approved.slice(0, 5),
        recentRejected: _rejected.slice(0, 5)
      };
    },

    accuracy: function () {
      return { total: _stats.approved, approved: _stats.approved, rejected: _stats.rejected };
    }
  };

  /* ── INIT ───────────────────────────────────────────────────────────────── */
  window.addEventListener('load', function () {
    setTimeout(function () {
      _processQueue();
      setInterval(function () {
        _lastPoll = Date.now();
        _processQueue();
      }, POLL_MS);
      console.log('[GII-ENTRY] Entry intelligence hub online');
    }, INIT_DELAY_MS);
  });

})();
