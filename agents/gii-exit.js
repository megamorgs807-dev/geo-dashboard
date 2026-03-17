/**
 * GII Exit Agent — thesis-based exit management for all open trades.
 *
 * Philosophy: "Stay in winning trades as long as the original thesis is valid.
 *               Cut losers when the reason for entry no longer exists."
 *
 * Every open EE trade is monitored every 90s. Exits are triggered by:
 *   1. Thesis invalidation — the geopolitical/macro reason for the trade has reversed
 *   2. Emergency conditions — extreme VIX, GTI spike, regime shift
 *   3. Momentum decay — multiple agents now oppose the direction
 *   4. Scale-out — partial exit (tighten stop) when profit materialises + conditions weaken
 *
 * Exit types:
 *   FORCE_CLOSE   → calls EE.forceCloseTrade() — full close at market
 *   TIGHTEN_STOP  → calls EE.updateOpenTrade({stop_loss}) — trail stop to lock profit
 *   RAISE_TP      → calls EE.updateOpenTrade({take_profit}) — extend TP if momentum strong
 *
 * Exposes window.GII_AGENT_EXIT
 */
(function () {
  'use strict';

  /* ── CONFIG ─────────────────────────────────────────────────────────────── */
  var POLL_MS       = 90 * 1000;    // scan open trades every 90s
  var INIT_DELAY_MS = 18 * 1000;    // wait for EE + other agents to fully boot

  /* Thesis invalidation thresholds */
  var IC_PROB_DROP_THRESHOLD  = 25;   // IC region prob below this → close IC/GII trades
  var POSTERIOR_REVERSAL_DELTA = 0.30; // Bayesian posterior dropped this much from entry → close
  var PM_EDGE_DEAD_THRESHOLD  = 0.03; // Polymarket edge < 3% → thesis gone
  var OPPOSITION_AGENTS_CLOSE      = 4;  // This many agents opposing → force close
  var OPPOSITION_AGENTS_TRAIL      = 2;  // This many agents opposing → tighten stop
  var OPPOSITION_CATEGORIES_CLOSE  = 3;  // Must span 3+ distinct categories for force close
  var OPPOSITION_CATEGORIES_TRAIL  = 2;  // Must span 2+ distinct categories for trail

  /* Agent → category map: prevents 4 correlated agents (e.g. all social/sentiment)
     from triggering a close — opposition must span multiple independent viewpoints */
  var AGENT_CATEGORIES = {
    'GII_AGENT_ENERGY':       'commodity',
    'GII_AGENT_CONFLICT':     'conflict',
    'GII_AGENT_MACRO':        'macro',
    'GII_AGENT_SANCTIONS':    'geopolitical',
    'GII_AGENT_MARITIME':     'logistics',
    'GII_AGENT_SOCIAL':       'sentiment',
    'GII_AGENT_POLYMARKET':   'probabilistic',
    'GII_AGENT_REGIME':       'regime',
    'GII_AGENT_DEESCALATION': 'resolution',   // dedicated: diplomatic/ceasefire signals
    'GII_AGENT_RISK':         'systemic'       // dedicated: portfolio stress + crisis keywords
  };

  /* Emergency thresholds */
  var VIX_EMERGENCY    = 42;   // Force close risk-asset longs above this
  var GTI_EMERGENCY    = 82;   // Force close risk-asset longs above this
  var MIN_HOLD_MS      = 8 * 60 * 1000;  // Never exit within 8 min of entry (noise filter)

  /* Trailing stop: tighten to this fraction of current profit */
  var TRAIL_LOCK_FRACTION = 0.75;   // lock in 75% of paper profit when tightening

  /* Defensive assets exempt from VIX/GTI emergency closes */
  var DEFENSIVE = ['GLD', 'XAU', 'SLV', 'JPY', 'CHF', 'VIX', 'TLT', 'GAS'];

  /* Risk assets that get force-closed in emergencies */
  var RISK_ASSETS = ['BTC', 'SPY', 'QQQ', 'TSM', 'NVDA', 'TSLA', 'SMH', 'FXI'];

  /* ── STATE ──────────────────────────────────────────────────────────────── */
  var _lastPoll    = 0;
  var _pollCount   = 0;
  var _exitLog     = [];   // last 60 exit decisions
  var _trailLog    = [];   // last 30 stop-tighten actions
  var _stats       = { checked: 0, closed: 0, tightened: 0, extended: 0, skipped: 0 };
  var _beApplied   = {};   // { tradeId: 'be'|'half' } — tracks progressive trail milestones

  /* ── HELPERS ────────────────────────────────────────────────────────────── */
  function _log(type, tradeId, asset, reason, details) {
    var entry = { type: type, tradeId: tradeId, asset: asset, reason: reason,
                  ts: Date.now(), details: details || {} };
    if (type === 'FORCE_CLOSE' || type === 'THESIS_INVALID') {
      _exitLog.unshift(entry);
      if (_exitLog.length > 60) _exitLog.pop();
    } else {
      _trailLog.unshift(entry);
      if (_trailLog.length > 30) _trailLog.pop();
    }
    console.log('[GII-EXIT] ' + type + ' · ' + asset + ' · ' + reason);
  }

  /* Count agents opposing this trade's direction.
     Returns { count, categories } — categories is the number of distinct AGENT_CATEGORIES
     represented, preventing correlated agents (e.g. 4 social agents) from falsely triggering. */
  function _countOpposition(asset, dir, region) {
    var opposing     = 0;
    var oppCats      = {};   // { category: true }
    var biasDir      = dir === 'LONG' ? 'long' : 'short';
    var oppDir       = dir === 'LONG' ? 'short' : 'long';

    var agentNames = [
      'GII_AGENT_ENERGY', 'GII_AGENT_CONFLICT', 'GII_AGENT_SANCTIONS',
      'GII_AGENT_MARITIME', 'GII_AGENT_SOCIAL', 'GII_AGENT_MACRO',
      'GII_AGENT_REGIME', 'GII_AGENT_SCALPER', 'GII_AGENT_POLYMARKET',
      'GII_AGENT_DEESCALATION', 'GII_AGENT_RISK'   // dedicated opposition agents
    ];

    agentNames.forEach(function (name) {
      var agent = window[name];
      if (!agent) return;
      var cat = AGENT_CATEGORIES[name] || 'other';
      try {
        /* For macro: check riskMode directly */
        if (name === 'GII_AGENT_MACRO') {
          var mSt = agent.status();
          if (mSt.riskMode === 'RISK_OFF' && dir === 'LONG' && DEFENSIVE.indexOf(asset) === -1) {
            opposing++; oppCats[cat] = true;
          }
          if (mSt.riskMode === 'RISK_ON'  && dir === 'SHORT') {
            opposing++; oppCats[cat] = true;
          }
          return;
        }
        /* For regime: active shift counts as opposition to longs */
        if (name === 'GII_AGENT_REGIME') {
          var rSt = agent.status();
          if (rSt.regimeShiftActive && dir === 'LONG' && DEFENSIVE.indexOf(asset) === -1) {
            opposing++; oppCats[cat] = true;
          }
          return;
        }
        var sigs = agent.signals ? agent.signals() : [];
        var relevant = sigs.filter(function (s) {
          return s.asset === asset || (region && s.region === region);
        });
        if (!relevant.length) relevant = sigs;
        var hasOpp = relevant.some(function (s) { return s.bias === oppDir; });
        var hasAgr = relevant.some(function (s) { return s.bias === biasDir; });
        if (hasOpp && !hasAgr) { opposing++; oppCats[cat] = true; }
      } catch (e) {}
    });

    return { count: opposing, categories: Object.keys(oppCats).length };
  }

  /* Get current market price for an asset (from EE's lastPrice cache if available) */
  function _getPrice(asset) {
    try {
      if (window.EE && typeof EE.getLastPrice === 'function') return EE.getLastPrice(asset);
    } catch (e) {}
    return null;
  }

  /* Calculate current unrealised P&L% for a trade */
  function _pnlPct(trade) {
    var price = _getPrice(trade.asset);
    if (!price) return null;
    var entry = trade.entry_price;
    if (!entry) return null;
    return trade.direction === 'LONG'
      ? ((price - entry) / entry) * 100
      : ((entry - price) / entry) * 100;
  }

  /* ── EXIT LOGIC: per-source checks ─────────────────────────────────────── */

  /* IC / GII geopolitical trade — thesis = "region crisis will escalate" */
  function _checkIcGiiThesis(trade) {
    var thesis = trade.thesis;
    var region = trade.region || (thesis && thesis.region) || 'GLOBAL';
    var dir    = trade.direction;

    /* Check region probability has not collapsed */
    if (window.__IC && __IC.regionStates && __IC.regionStates[region]) {
      var regionProb = __IC.regionStates[region].prob || 0;
      if (regionProb < IC_PROB_DROP_THRESHOLD) {
        return { action: 'FORCE_CLOSE', reason: 'ic-region-collapsed', detail:
          'Region ' + region + ' prob=' + regionProb + '% < ' + IC_PROB_DROP_THRESHOLD + '% threshold' };
      }
      /* If we stored entry prob, check for significant drop */
      if (thesis && thesis.regionProbAtEntry && dir === 'LONG') {
        var probDrop = thesis.regionProbAtEntry - regionProb;
        if (probDrop > 35) {
          return { action: 'FORCE_CLOSE', reason: 'ic-region-dropped', detail:
            'Region prob dropped ' + probDrop.toFixed(0) + 'pts from entry (' +
            thesis.regionProbAtEntry + '% → ' + regionProb + '%)' };
        }
      }
    }

    /* Check Bayesian posterior — if it has reversed significantly */
    if (window.GII) {
      try {
        var post = GII.posterior(region);
        if (post && post.posterior !== undefined && thesis && thesis.posteriorAtEntry !== undefined) {
          var delta = thesis.posteriorAtEntry - post.posterior;
          /* Long thesis invalidated if posterior dropped >30pts from entry */
          if (dir === 'LONG' && delta > POSTERIOR_REVERSAL_DELTA) {
            return { action: 'FORCE_CLOSE', reason: 'bayesian-reversal', detail:
              'Posterior dropped ' + (delta * 100).toFixed(0) + 'pts (' +
              (thesis.posteriorAtEntry * 100).toFixed(0) + '% → ' +
              (post.posterior * 100).toFixed(0) + '%)' };
          }
          /* Short thesis invalidated if posterior rose >30pts */
          if (dir === 'SHORT' && (-delta) > POSTERIOR_REVERSAL_DELTA) {
            return { action: 'FORCE_CLOSE', reason: 'bayesian-reversal-short', detail:
              'Posterior rose ' + ((-delta) * 100).toFixed(0) + 'pts from short entry' };
          }
          /* Tighten stop if posterior is weakening but not fully reversed */
          if (dir === 'LONG' && delta > 0.15) {
            return { action: 'TIGHTEN_STOP', reason: 'bayesian-weakening', detail:
              'Posterior softened ' + (delta * 100).toFixed(0) + 'pts — trailing stop tightened' };
          }
        }
      } catch (e) {}
    }

    return null;
  }

  /* Scalper trade — thesis = "short-term momentum + technical setup" */
  function _checkScalperThesis(trade) {
    /* Close scalper if macro regime flips heavily against it */
    if (window.GII_AGENT_MACRO) {
      try {
        var mSt = GII_AGENT_MACRO.status();
        var dir = trade.direction;
        /* Scalper long in RISK_OFF with high VIX — momentum will fade fast */
        if (dir === 'LONG' && mSt.riskMode === 'RISK_OFF' && (mSt.vix || 0) > 32
            && DEFENSIVE.indexOf(trade.asset) === -1) {
          return { action: 'FORCE_CLOSE', reason: 'scalper-macro-flip', detail:
            'Macro flipped RISK_OFF + VIX ' + mSt.vix + ' — scalp momentum likely exhausted' };
        }
        /* Scalper short in strong RISK_ON rally */
        if (dir === 'SHORT' && mSt.riskMode === 'RISK_ON' && (mSt.vix || 99) < 18) {
          return { action: 'FORCE_CLOSE', reason: 'scalper-macro-rally', detail:
            'Strong RISK_ON + low VIX — short scalp momentum likely stalled' };
        }
      } catch (e) {}
    }

    /* Close if GTI spikes into extreme territory for risk-asset longs */
    if (window.GII) {
      try {
        var gtiData = GII.gti();
        if (gtiData && gtiData.value > GTI_EMERGENCY &&
            trade.direction === 'LONG' && RISK_ASSETS.indexOf(trade.asset) !== -1) {
          return { action: 'FORCE_CLOSE', reason: 'scalper-gti-extreme', detail:
            'GTI ' + gtiData.value.toFixed(0) + ' is extreme — scalp risk too high' };
        }
      } catch (e) {}
    }

    return null;
  }

  /* Polymarket trade — thesis = "AI probability edge vs PM implied probability" */
  function _checkPolymarketThesis(trade) {
    if (!window.GII_AGENT_POLYMARKET) return null;
    try {
      var pmSt = GII_AGENT_POLYMARKET.status();
      /* If the edge that generated this trade has collapsed, exit */
      if (pmSt.avgEdge < PM_EDGE_DEAD_THRESHOLD) {
        return { action: 'FORCE_CLOSE', reason: 'pm-edge-dead', detail:
          'Polymarket edge ' + (pmSt.avgEdge * 100).toFixed(1) + '% — below ' +
          (PM_EDGE_DEAD_THRESHOLD * 100) + '% threshold, thesis exhausted' };
      }
      /* Edge narrowing but not dead → tighten stop */
      if (pmSt.avgEdge < 0.07) {
        return { action: 'TIGHTEN_STOP', reason: 'pm-edge-narrowing', detail:
          'PM edge narrowing to ' + (pmSt.avgEdge * 100).toFixed(1) + '%' };
      }
    } catch (e) {}
    return null;
  }

  /* ── EMERGENCY CLOSES (applies to all trade types) ──────────────────────── */
  function _emergencyCheck(trade) {
    var asset = trade.asset;
    var dir   = trade.direction;
    var isDef = DEFENSIVE.indexOf(asset) !== -1;
    var isRisk = RISK_ASSETS.indexOf(asset) !== -1;

    /* VIX spike emergency */
    if (window.GII_AGENT_MACRO) {
      try {
        var mSt = GII_AGENT_MACRO.status();
        if ((mSt.vix || 0) > VIX_EMERGENCY && dir === 'LONG' && !isDef) {
          return { action: 'FORCE_CLOSE', reason: 'emergency-vix', detail:
            'VIX=' + mSt.vix + ' (threshold ' + VIX_EMERGENCY + ') — emergency exit risk assets' };
        }
      } catch (e) {}
    }

    /* GTI extreme emergency — all risk longs out */
    if (window.GII) {
      try {
        var gtiData = GII.gti();
        if (gtiData && gtiData.value > GTI_EMERGENCY && dir === 'LONG' && isRisk) {
          return { action: 'FORCE_CLOSE', reason: 'emergency-gti', detail:
            'GTI=' + gtiData.value.toFixed(0) + ' — extreme tension, closing risk longs' };
        }
      } catch (e) {}
    }

    /* Active regime shift — close all risk-asset positions */
    if (window.GII_AGENT_REGIME) {
      try {
        var regSt = GII_AGENT_REGIME.status();
        if (regSt.regimeShiftActive && !isDef) {
          return { action: 'FORCE_CLOSE', reason: 'regime-shift-' + (regSt.shiftType || 'unknown'),
            detail: 'Regime shift (' + (regSt.shiftType || '?') + ') — exiting non-defensive position' };
        }
      } catch (e) {}
    }

    return null;
  }

  /* ── MOMENTUM OPPOSITION CHECK ───────────────────────────────────────────── */
  function _oppositionCheck(trade) {
    var region = trade.region || (trade.thesis && trade.thesis.region) || null;
    var opp    = _countOpposition(trade.asset, trade.direction, region);
    var n      = opp.count;
    var cats   = opp.categories;

    /* Force close: requires N agents AND they must span M distinct categories.
       Prevents 4 correlated agents (e.g. all social/sentiment) from closing a good trade. */
    if (n >= OPPOSITION_AGENTS_CLOSE && cats >= OPPOSITION_CATEGORIES_CLOSE) {
      return { action: 'FORCE_CLOSE', reason: 'multi-agent-opposition', detail:
        n + ' agents (' + cats + ' categories) opposing — thesis consensus has reversed' };
    }

    /* Trail: requires N agents spanning M distinct categories */
    if (n >= OPPOSITION_AGENTS_TRAIL && cats >= OPPOSITION_CATEGORIES_TRAIL) {
      return { action: 'TIGHTEN_STOP', reason: 'agents-opposing-' + n, detail:
        n + ' agents (' + cats + ' categories) opposing — trailing stop tightened' };
    }

    return null;
  }

  /* ── POSITIVE MOMENTUM: extend TP if things are going very well ─────────── */
  function _momentumExtend(trade) {
    var thesis = trade.thesis;
    if (!thesis) return null;
    var region = trade.region || thesis.region || null;

    /* Need current P&L to judge if TP extension is worthwhile */
    var pnl = _pnlPct(trade);
    if (pnl === null || pnl < 3.0) return null;   // not yet in meaningful profit

    /* Bayesian posterior STRENGTHENING from entry is positive momentum */
    if (window.GII && region) {
      try {
        var post = GII.posterior(region);
        if (post && post.posterior && thesis.posteriorAtEntry) {
          var delta = post.posterior - thesis.posteriorAtEntry;
          /* Posterior increased >15pts AND in profit → extend TP by 1.5×current TP */
          if (delta > 0.15 && pnl > 4.0) {
            return { action: 'RAISE_TP', reason: 'bayesian-strengthening', detail:
              'Posterior up ' + (delta * 100).toFixed(0) + 'pts + P&L ' + pnl.toFixed(1) + '% — extending TP' };
          }
        }
      } catch (e) {}
    }

    /* GTI rising and trade is aligned with tension (oil, gold, defensive) */
    if (window.GII && trade.direction === 'LONG') {
      try {
        var gtiData = GII.gti();
        var alignedWithTension = ['WTI','BRENT','GLD','XAU','SLV','GAS','LMT','RTX'].indexOf(trade.asset) !== -1;
        if (gtiData && gtiData.value > 65 && alignedWithTension && pnl > 5.0) {
          return { action: 'RAISE_TP', reason: 'gti-rising-aligned', detail:
            'GTI ' + gtiData.value.toFixed(0) + '% + ' + trade.asset + ' aligned — TP extended' };
        }
      } catch (e) {}
    }

    return null;
  }

  /* ── PROGRESSIVE PROFIT TRAIL ────────────────────────────────────────────
     Simulates partial profit taking by locking in profits at each R milestone:
       1:1 R:R reached → move stop to breakeven  (trade becomes risk-free)
       1.5:1 R:R reached → trail stop to +0.5R   (half the move locked in)
     Uses actual stop distance (entry vs stop_loss) — not estimated percentages.
     State tracked in _beApplied to avoid re-applying same level. */
  function _progressiveTrailCheck(trade) {
    var price = _getPrice(trade.asset);
    if (!price) return null;
    var entry = trade.entry_price;
    var stop  = trade.stop_loss;
    var dir   = trade.direction;
    var id    = trade.trade_id;
    if (!entry || !stop) return null;

    var stopDist = Math.abs(entry - stop);
    if (stopDist <= 0) return null;

    var moveDist = dir === 'LONG' ? (price - entry) : (entry - price);
    if (moveDist <= 0) return null;   // not in profit

    var rr    = moveDist / stopDist;  // current R:R multiple
    var level = _beApplied[id] || 'none';

    /* 1.5:1 → lock in +0.5R profit (only after BE has been applied) */
    if (rr >= 1.5 && level === 'be') {
      var halfR     = stopDist * 0.5;
      var newStop15 = dir === 'LONG'
        ? +(entry + halfR).toFixed(4)
        : +(entry - halfR).toFixed(4);
      /* TP clamp: stop must never overshoot the take-profit level (matches EE logic) */
      if (dir === 'LONG'  && trade.take_profit && newStop15 > trade.take_profit) newStop15 = +trade.take_profit.toFixed(4);
      if (dir === 'SHORT' && trade.take_profit && newStop15 < trade.take_profit) newStop15 = +trade.take_profit.toFixed(4);
      /* Only tighten — don't loosen if current stop is already better */
      if (dir === 'LONG'  && trade.stop_loss && newStop15 <= trade.stop_loss) return null;
      if (dir === 'SHORT' && trade.stop_loss && newStop15 >= trade.stop_loss) return null;
      _beApplied[id] = 'half';
      return { action: 'TIGHTEN_STOP', newStop: newStop15,
               reason: 'progressive-trail-half-r',
               detail: 'At 1.5:1 R:R — stop locked at +0.5R (partial profit secured)' };
    }

    /* 1:1 → move stop to breakeven */
    if (rr >= 1.0 && level === 'none') {
      var beBuf  = stopDist * 0.02;  // 2% of stop distance as buffer
      var newBE  = dir === 'LONG'
        ? +(entry + beBuf).toFixed(4)
        : +(entry - beBuf).toFixed(4);
      if (dir === 'LONG'  && trade.stop_loss && newBE <= trade.stop_loss) return null;
      if (dir === 'SHORT' && trade.stop_loss && newBE >= trade.stop_loss) return null;
      _beApplied[id] = 'be';
      return { action: 'TIGHTEN_STOP', newStop: newBE,
               reason: 'progressive-trail-be',
               detail: 'At 1:1 R:R — stop moved to breakeven (trade now risk-free)' };
    }

    return null;
  }

  /* ── COMPUTE NEW STOP / TP LEVELS ───────────────────────────────────────── */
  function _computeTightStop(trade) {
    var price = _getPrice(trade.asset);
    if (!price) return null;

    var entry = trade.entry_price;
    var dir   = trade.direction;

    if (dir === 'LONG') {
      /* Tighten: new stop = entry + (current_profit * TRAIL_LOCK_FRACTION) */
      var profitPts = price - entry;
      if (profitPts <= 0) return null;  // not in profit, can't tighten
      var newStop = +(entry + profitPts * TRAIL_LOCK_FRACTION).toFixed(4);
      /* Don't tighten to below current stop */
      if (trade.stop_loss && newStop <= trade.stop_loss) return null;
      return { stop_loss: newStop };
    } else {
      /* Short trade: stop is above entry */
      var profitPtsShort = entry - price;
      if (profitPtsShort <= 0) return null;
      var newStopShort = +(entry - profitPtsShort * TRAIL_LOCK_FRACTION).toFixed(4);
      if (trade.stop_loss && newStopShort >= trade.stop_loss) return null;
      return { stop_loss: newStopShort };
    }
  }

  function _computeRaisedTP(trade) {
    var price = _getPrice(trade.asset);
    if (!price) return null;

    var entry = trade.entry_price;
    var dir   = trade.direction;
    var currentTP = trade.take_profit;
    if (!currentTP) return null;

    if (dir === 'LONG') {
      /* Extend TP by 50% of the gap from entry to current TP */
      var gap  = currentTP - entry;
      var newTP = +(currentTP + gap * 0.50).toFixed(4);
      return { take_profit: newTP };
    } else {
      var gapShort = entry - currentTP;
      var newTPShort = +(currentTP - gapShort * 0.50).toFixed(4);
      return { take_profit: newTPShort };
    }
  }

  /* ── MAIN: evaluate one trade ───────────────────────────────────────────── */
  function _evaluateTrade(trade) {
    _stats.checked++;
    var tradeId = trade.trade_id;
    var asset   = trade.asset;
    var source  = trade.source || (trade.thesis && trade.thesis.source) || 'ic';

    /* Noise filter: never exit within MIN_HOLD_MS of opening.
       EE stores the open timestamp as trade.timestamp_open (ISO string). */
    var ageMs = Date.now() - new Date(trade.timestamp_open || 0).getTime();
    if (ageMs < MIN_HOLD_MS) { _stats.skipped++; return; }

    /* 1. Emergency checks (highest priority, all trade types) */
    var emergency = _emergencyCheck(trade);
    if (emergency && emergency.action === 'FORCE_CLOSE') {
      _log('FORCE_CLOSE', tradeId, asset, emergency.reason, { detail: emergency.detail });
      try { EE.forceCloseTrade(tradeId, 'GII-EXIT:' + emergency.reason); } catch (e) {}
      _stats.closed++;
      return;
    }

    /* 2. Thesis-based exits (per source) */
    var thesisResult = null;
    var srcLow = source.toLowerCase();

    if (srcLow === 'scalper' || srcLow === 'scalper-session') {
      thesisResult = _checkScalperThesis(trade);
    } else if (srcLow === 'polymarket') {
      thesisResult = _checkPolymarketThesis(trade);
    } else {
      /* ic, gii, or any geopolitical source */
      thesisResult = _checkIcGiiThesis(trade);
    }

    if (thesisResult) {
      if (thesisResult.action === 'FORCE_CLOSE') {
        _log('FORCE_CLOSE', tradeId, asset, thesisResult.reason, { detail: thesisResult.detail });
        try { EE.forceCloseTrade(tradeId, 'GII-EXIT:' + thesisResult.reason); } catch (e) {}
        _stats.closed++;
        return;
      }
      if (thesisResult.action === 'TIGHTEN_STOP') {
        var changes = _computeTightStop(trade);
        if (changes) {
          _log('TIGHTEN_STOP', tradeId, asset, thesisResult.reason, { detail: thesisResult.detail, changes: changes });
          try { EE.updateOpenTrade(tradeId, changes); } catch (e) {}
          _stats.tightened++;
          return;  // Don't apply more actions same cycle
        }
      }
    }

    /* 3. Multi-agent opposition check */
    var oppResult = _oppositionCheck(trade);
    if (oppResult) {
      if (oppResult.action === 'FORCE_CLOSE') {
        _log('FORCE_CLOSE', tradeId, asset, oppResult.reason, { detail: oppResult.detail });
        try { EE.forceCloseTrade(tradeId, 'GII-EXIT:' + oppResult.reason); } catch (e) {}
        _stats.closed++;
        return;
      }
      if (oppResult.action === 'TIGHTEN_STOP') {
        var oppChanges = _computeTightStop(trade);
        if (oppChanges) {
          _log('TIGHTEN_STOP', tradeId, asset, oppResult.reason, { detail: oppResult.detail, changes: oppChanges });
          try { EE.updateOpenTrade(tradeId, oppChanges); } catch (e) {}
          _stats.tightened++;
          return;
        }
      }
    }

    /* 4. Progressive profit trail — locks in profits at 1:1 and 1.5:1 R:R milestones */
    var trailResult = _progressiveTrailCheck(trade);
    if (trailResult) {
      var trailChanges = { stop_loss: trailResult.newStop };
      _log('TIGHTEN_STOP', tradeId, asset, trailResult.reason, { detail: trailResult.detail, changes: trailChanges });
      try { EE.updateOpenTrade(tradeId, trailChanges); } catch (e) {}
      _stats.tightened++;
      /* Don't return — still allow TP extension below if momentum is strong */
    }

    /* 5. Positive momentum: try to extend TP */
    var extResult = _momentumExtend(trade);
    if (extResult && extResult.action === 'RAISE_TP') {
      var tpChanges = _computeRaisedTP(trade);
      if (tpChanges) {
        _log('RAISE_TP', tradeId, asset, extResult.reason, { detail: extResult.detail, changes: tpChanges });
        try { EE.updateOpenTrade(tradeId, tpChanges); } catch (e) {}
        _stats.extended++;
      }
    }
  }

  /* ── MAIN POLL ──────────────────────────────────────────────────────────── */
  function _poll() {
    _lastPoll  = Date.now();
    _pollCount++;

    if (!window.EE) return;   // EE not loaded yet

    /* Use EE.openTrades() directly — more authoritative than localStorage which
       can lag behind EE's in-memory state (especially after forceCloseTrade). */
    var openTrades = [];
    try {
      if (typeof EE.openTrades === 'function') {
        openTrades = EE.openTrades();
      } else {
        var raw = JSON.parse(localStorage.getItem('geodash_ee_trades_v1') || '[]');
        openTrades = raw.filter(function (t) { return t.status === 'OPEN'; });
      }
    } catch (e) { return; }

    if (!openTrades.length) {
      // All trades closed — prune any stale _beApplied entries to prevent memory leak
      _beApplied = {};
      return;
    }

    /* Prune _beApplied entries for trades that are no longer open.
       Without this, entries accumulate indefinitely as trades close. */
    var openIds = {};
    openTrades.forEach(function (t) { openIds[t.trade_id] = true; });
    Object.keys(_beApplied).forEach(function (id) {
      if (!openIds[id]) delete _beApplied[id];
    });

    openTrades.forEach(function (trade) {
      try { _evaluateTrade(trade); } catch (e) {}
    });
  }

  /* ── PUBLIC API ─────────────────────────────────────────────────────────── */
  window.GII_AGENT_EXIT = {

    poll: _poll,

    /* Exit agent doesn't emit trade signals — it only manages open positions */
    signals: function () { return []; },

    exitLog: function () { return _exitLog.slice(); },
    trailLog: function () { return _trailLog.slice(); },

    status: function () {
      return {
        lastPoll:    _lastPoll,
        pollCount:   _pollCount,
        stats:       Object.assign({}, _stats),
        recentExits: _exitLog.slice(0, 5),
        recentTrails: _trailLog.slice(0, 5)
      };
    },

    accuracy: function () {
      return { total: _stats.closed, closed: _stats.closed, tightened: _stats.tightened };
    }
  };

  /* ── INIT ───────────────────────────────────────────────────────────────── */
  window.addEventListener('load', function () {
    setTimeout(function () {
      _poll();
      setInterval(_poll, POLL_MS);
      console.log('[GII-EXIT] Exit thesis monitor online — scanning every ' +
                  (POLL_MS / 1000) + 's');
    }, INIT_DELAY_MS);
  });

})();
