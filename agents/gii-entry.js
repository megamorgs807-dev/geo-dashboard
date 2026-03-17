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
  var MIN_SCORE_GEO    = 4.5;   // IC/GII geopolitical trades
  var MIN_SCORE_SCALPER = 2.0;  // Scalper trades (already pre-filtered by RSI/ATR)

  /* Minimum number of distinct agent categories that must agree */
  var MIN_CATEGORIES = 2;

  /* Defensive assets — allowed through even in RISK_OFF/CRISIS */
  var DEFENSIVE = ['GLD', 'XAU', 'SLV', 'JPY', 'CHF', 'VIX', 'TLT', 'GAS'];

  /* Risk assets — vetoed for LONG in extreme regimes */
  var RISK_ASSETS = ['BTC', 'SPY', 'QQQ', 'TSM', 'NVDA', 'TSLA', 'SMH', 'FXI'];

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
    'VIX':   { stopPct: 8.0, tpRatio: 2.0 },  /* VIX is extremely volatile */
    'VXX':   { stopPct: 6.0, tpRatio: 2.0 }   /* VXX ETF — same signal, lower raw vol than VIX index */
  };
  var VOL_STOP_DEFAULT = { stopPct: 3.0, tpRatio: 2.5 };

  /* ── STATE ──────────────────────────────────────────────────────────────── */
  var _queue      = [];   // pending signals awaiting scoring
  var _approved   = [];   // last 50 approved signals (audit log)
  var _rejected   = [];   // last 50 rejected signals (audit log)
  var _lastPoll   = 0;
  var _stats      = { submitted: 0, approved: 0, rejected: 0, vetoed: 0, rotated: 0 };

  /* ── QUEUE ──────────────────────────────────────────────────────────────── */
  function _submit(signals, sourceTag) {
    var now = Date.now();
    (Array.isArray(signals) ? signals : [signals]).forEach(function (s) {
      if (!s || !s.asset || !s.dir) return;
      _stats.submitted++;
      _queue.push({
        sig:       s,
        source:    sourceTag || s.source || 'ic',
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

    /* Find signals agreeing with this asset or region */
    var relevant = sigs.filter(function (s) {
      var assetMatch  = s.asset === asset;
      var regionMatch = region && s.region === region;
      return assetMatch || regionMatch;
    });
    if (!relevant.length) {
      /* Fall back: any signal with same bias (direction) */
      relevant = sigs.filter(function (s) { return s.bias === (dir === 'SHORT' ? 'short' : 'long'); });
    }
    if (!relevant.length) return null;

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
    if (window.GII_AGENT_POLYMARKET) {
      try {
        var pmSt = GII_AGENT_POLYMARKET.status();
        if (pmSt.avgEdge > 0.10) {
          score += 2.0 * Math.min(1, pmSt.avgEdge);
          categories.probabilistic = true;
          agentsFor.push('polymarket(' + Math.round(pmSt.avgEdge * 100) + '% edge)');
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

    /* Veto 4: asset already has open position */
    try {
      var trades = JSON.parse(localStorage.getItem('geodash_ee_trades_v1') || '[]');
      var hasOpen = trades.some(function (t) {
        return t.status === 'OPEN' && t.asset === asset;
      });
      if (hasOpen) return 'position-already-open';
    } catch (e) {}

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

    /* Deduplicate queue by asset only — prevents both a LONG and SHORT for the
       same asset firing in the same cycle (contradictory signals). Keeps the
       highest-confidence signal regardless of direction. */
    var byAsset = {};
    _queue.forEach(function (item) {
      var key = item.sig.asset;   // v53: asset-only key (was asset+dir)
      if (!byAsset[key] || (item.sig.conf || 0) > (byAsset[key].sig.conf || 0)) {
        byAsset[key] = item;
      }
    });
    _queue = [];   // consumed

    var toEmit = [];

    Object.keys(byAsset).forEach(function (key) {
      var item      = byAsset[key];
      var sig       = item.sig;
      var isScalper = item.source === 'scalper' || item.source === 'scalper-session';
      var minScore  = isScalper ? MIN_SCORE_SCALPER : MIN_SCORE_GEO;

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

          /* Region rotation */
          var regionTrades = eeOpen.filter(function (t) { return t.region === sig.region; });
          if (eeCfg.max_per_region && regionTrades.length >= eeCfg.max_per_region) {
            var weakestRegion = regionTrades.slice().sort(function (a, b) {
              return _tradeScore(a) - _tradeScore(b);
            })[0];
            if (weakestRegion && newScore > _tradeScore(weakestRegion)) {
              /* New signal beats weakest — rotate it out */
              try { EE.forceCloseTrade(weakestRegion.trade_id,
                'GII-ENTRY:rotated-by-' + sig.asset + '(score ' + newScore.toFixed(2) + '>' + _tradeScore(weakestRegion).toFixed(2) + ')'); } catch (e) {}
              _stats.rotated++;
            } else {
              /* All existing trades score higher — keep them */
              _stats.rejected++;
              _rejected.unshift({ asset: sig.asset, dir: sig.dir,
                reason: 'region cap: ' + sig.region + ' trades score higher (' +
                  (weakestRegion ? _tradeScore(weakestRegion).toFixed(2) : '?') + ' vs ' + newScore.toFixed(2) + ')', ts: now });
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
              if (weakestSector && newScore > _tradeScore(weakestSector)) {
                try { EE.forceCloseTrade(weakestSector.trade_id,
                  'GII-ENTRY:rotated-by-' + sig.asset + '(score ' + newScore.toFixed(2) + '>' + _tradeScore(weakestSector).toFixed(2) + ')'); } catch (e) {}
                _stats.rotated++;
              } else {
                _stats.rejected++;
                _rejected.unshift({ asset: sig.asset, dir: sig.dir,
                  reason: 'sector cap: ' + assetSector + ' trades score higher (' +
                    (weakestSector ? _tradeScore(weakestSector).toFixed(2) : '?') + ' vs ' + newScore.toFixed(2) + ')', ts: now });
                if (_rejected.length > 50) _rejected.pop();
                return;
              }
            }
          }
        } catch (e) {}
      }

      /* Approved — enrich signal with thesis fingerprint + volatility stops */
      var volStop  = VOL_STOPS[sig.asset] || VOL_STOP_DEFAULT;
      var enriched = Object.assign({}, sig, {
        thesis:          _buildThesis(item, result),
        confluenceScore: result.score,
        source:          item.source,
        stopPct:         sig.stopPct  || volStop.stopPct,   /* per-asset stop % — EE overrides flat 3% */
        tpRatio:         sig.tpRatio  || volStop.tpRatio    /* per-asset R:R  — EE overrides flat 2.0 */
      });

      /* Boost confidence by confluence (up to +8 points) */
      var confBoost = Math.min(8, Math.floor(result.score * 0.8));
      enriched.conf = Math.min(95, (sig.conf || 50) + confBoost);

      toEmit.push(enriched);
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
