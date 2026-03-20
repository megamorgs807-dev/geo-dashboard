/**
 * ic-risk-engine.js  v2
 * IC Edge Monitor & Dynamic Capital Allocator — Safety-Hardened Edition
 *
 * v2 changes vs v1:
 *   ASYMMETRIC THRESHOLDS  — scale-up needs 30 trades; scale-down reacts at 10.
 *                            Prevents noise-driven upward drift on small samples.
 *   PROBATION MODE         — hard 1.5x ceiling until 40 total IC trades are on record.
 *                            After probation: ceiling rises to 2.5x (not 3.0x — that
 *                            was too aggressive on a 24-trade audit sample).
 *   SCALE-UP NOISE FLOOR   — expectancy must clear +$0.50, not just > $0.00.
 *   DUAL-WINDOW CONFIRM    — both primary AND secondary windows must show E>0 for
 *                            scale-up; secondary negative blocks upward moves.
 *   CONSECUTIVE-LOSS GUARD — 3 consecutive losses → instant 50% multiplier cut;
 *                            5 consecutive losses → force to 0.25x floor + 10-trade
 *                            cooling period where scale-up is blocked entirely.
 *   SMOKE ALARM            — 5 most-recent IC trades all losses → immediate scale-down
 *                            regardless of primary window (catches a losing streak
 *                            before it fully shows up in the rolling 20-trade window).
 *   REGIME DEGRADATION     — SL hit rate > 85% in last 10 trades, OR avg trade
 *                            duration < 45 min in last 10 → OSINT not moving price →
 *                            accelerated scale-down even if short-term metrics look ok.
 *   SCALE-UP RATE LIMIT    — maximum 2 scale-ups per rolling 24-hour window; prevents
 *                            a lucky streak from inflating size in one session.
 *   COLD-START PROTECTION  — on init, if fewer than SCALE_DOWN_MIN_TRADES trades are
 *                            in history, persisted multiplier is ignored and reset to 1.0.
 *
 * Failure-mode summary (v1 weaknesses addressed):
 *   1. n=10 insufficient (σ_WR ≈ ±14.5%) → asymmetric 30/10 thresholds
 *   2. E>$0 noise-floor → SCALE_UP_MIN_EXPECTANCY = $0.50
 *   3. Reactive loss detection → consecutive-loss guard + smoke alarm
 *   4. Lucky-streak inflation → daily rate limit + probation ceiling
 *   5. 3.0x ceiling too aggressive for 24-trade sample → 2.5x, 1.5x during probation
 *   6. Cold-start from stale saved multiplier → reset if insufficient history
 *   7. No regime detection → SL-rate + duration degradation check
 *
 * Exposes window.ICRiskEngine
 * Console:  ICRiskEngine.getStatus()  |  ICRiskEngine._cfg  |  ICRiskEngine.recalculate()
 */
(function (window) {
  'use strict';

  /* ── CONFIG ─────────────────────────────────────────────────────────────── */
  var CFG = {

    /* Rolling windows */
    WINDOW_PRIMARY:   20,    // fast signal — last N IC trades
    WINDOW_SECONDARY: 60,    // trend context
    WINDOW_RECENT:     5,    // smoke-alarm window — last N trades

    /* Asymmetric minimum trades before action is permitted:
       Scale-up needs strong statistical basis; scale-down must react fast. */
    SCALE_UP_MIN_TRADES:   30,   // 30 trades in primary window before ANY scale-up
    SCALE_DOWN_MIN_TRADES: 10,   // only 10 trades needed to trigger scale-down

    /* Scale-UP criteria — ALL four must hold simultaneously */
    SCALE_UP_MIN_EXPECTANCY: 0.50,   // expectancy ≥ $0.50 (not just > $0 — noise floor)
    SCALE_UP_TP_RATE:        0.15,   // TP hit rate ≥ 15%
    SCALE_UP_SECONDARY_POS:  true,   // secondary window must also show E > 0
    SCALE_UP_STEP:           0.10,   // +10% per confirmed window

    /* Scale-DOWN criteria — either condition triggers */
    SCALE_DOWN_EXPECTANCY: 0,        // expectancy < $0
    SCALE_DOWN_TP_RATE:    0.10,     // TP hit rate < 10%
    SCALE_DOWN_STEP:       0.15,     // −15% per deteriorated window (faster retreat than advance)

    /* Hard limits */
    MULT_MAX:           2.50,   // ceiling (reduced from 3.0 — aggressive on small sample)
    MULT_MIN:           0.25,   // floor
    MULT_INIT:          1.00,   // starting value

    /* Probation mode — full ceiling locked until 40 IC trades are on record */
    PROBATION_TRADES:    40,    // total IC trades needed to exit probation
    MULT_MAX_PROBATION:  1.50,  // hard cap while in probation

    /* Portfolio exposure cap */
    MAX_IC_EXPOSURE_PCT: 0.15,  // max 15% of virtual_balance in open IC positions

    /* Per-asset bonus — applied only when that asset has independently demonstrated
       positive expectancy over at least ASSET_MIN_TRADES of its own closed trades */
    ASSET_BONUS: {
      'TSLA': 1.50,   // audit: +$9.17 expectancy, all 3 wins hit TP
      'VXX':  1.20,   // audit: +$1.98 expectancy, 27:1 R:R
    },
    ASSET_MIN_TRADES: 3,

    /* Consecutive-loss protection */
    CONSEC_LOSS_CUT_AT:   3,    // 3 in a row → instant 50% multiplier cut
    CONSEC_LOSS_FLOOR_AT: 5,    // 5 in a row → force to floor + cooling period
    CONSEC_LOSS_COOLING:  10,   // trades where scale-up is blocked after floor-out

    /* Regime degradation detection */
    REGIME_WINDOW:              10,             // look-back for regime checks
    REGIME_SL_RATE_THRESHOLD:   0.85,           // SL rate > 85% → catalysts not working
    REGIME_MIN_DURATION_MS:     45 * 60 * 1000, // avg duration < 45 min → price not developing

    /* Scale-up rate limiting */
    SCALE_UP_MAX_PER_DAY: 2,    // max N upward steps per rolling 24-hour window

    /* Recalc timing */
    RECALC_INTERVAL_MS: 5 * 60 * 1000,

    /* Keys */
    TRADES_KEY: 'geodash_ee_trades_v1',
    MULT_KEY:   'ic_risk_mult',
  };

  /* ── STATE ──────────────────────────────────────────────────────────────── */
  var _mult             = CFG.MULT_INIT;
  var _consecutiveLosses = 0;
  var _coolingDown      = false;
  var _coolingTradesLeft = 0;
  var _recentScaleUps   = [];   // timestamps of scale-up events (24h rate limit)
  var _metrics          = {
    primary:    null,
    secondary:  null,
    byAsset:    {},
    drawdown:   0,
    tradeCount: 0,
    lastCalc:   0,
    /* Safety-state snapshot (for getStatus) */
    safety: {
      inProbation:        true,
      consecutiveLosses:  0,
      coolingDown:        false,
      coolingTradesLeft:  0,
      regimeDegraded:     false,
      smokeAlarm:         false,
    },
  };
  var _scalingLog = [];  // capped at 200

  /* ── TRADE LOADING ───────────────────────────────────────────────────────── */
  function _loadICTrades() {
    try {
      var raw = localStorage.getItem(CFG.TRADES_KEY);
      if (!raw) return [];
      return (JSON.parse(raw) || []).filter(function (t) {
        return t.source === 'ic' && t.status === 'CLOSED';
      });
    } catch (e) { return []; }
  }

  /* ── METRICS ─────────────────────────────────────────────────────────────── */
  function _computeMetrics(trades) {
    var empty = { count: 0, wr: 0, avgWin: 0, avgLoss: 0, expectancy: 0,
                  tpHitRate: 0, totalPnL: 0, slHitRate: 0, rotations: 0 };
    if (!trades || !trades.length) return empty;

    var wins = [], losses = [], tpHits = 0, slHits = 0, rotations = 0;
    trades.forEach(function (t) {
      var pnl = parseFloat(t.pnl_usd || 0);
      var reason = (t.close_reason || '').toUpperCase();
      if (pnl > 0) {
        wins.push(pnl);
        if (reason.indexOf('TAKE_PROFIT') !== -1) tpHits++;
      } else {
        losses.push(pnl);
        if (reason.indexOf('STOP_LOSS') !== -1) slHits++;
      }
      if (reason.toLowerCase().indexOf('rotat') !== -1) rotations++;
    });

    var n    = trades.length;
    var wr   = wins.length / n;
    var sumW = wins.reduce(function (a, b) { return a + b; }, 0);
    var sumL = losses.reduce(function (a, b) { return a + b; }, 0);

    return {
      count:      n,
      wr:         wr,
      avgWin:     wins.length   ? sumW / wins.length   : 0,
      avgLoss:    losses.length ? sumL / losses.length : 0,
      expectancy: (wr * (wins.length ? sumW / wins.length : 0)) +
                  ((1 - wr) * (losses.length ? sumL / losses.length : 0)),
      tpHitRate:  tpHits / n,
      slHitRate:  slHits / n,
      totalPnL:   sumW + sumL,
      rotations:  rotations,
    };
  }

  function _computeByAsset(trades) {
    var byAsset = {};
    trades.forEach(function (t) {
      var a = t.asset || 'UNKNOWN';
      if (!byAsset[a]) byAsset[a] = [];
      byAsset[a].push(t);
    });
    var result = {};
    Object.keys(byAsset).forEach(function (a) { result[a] = _computeMetrics(byAsset[a]); });
    return result;
  }

  function _computeDrawdown(trades) {
    var peak = 0, maxDD = 0, running = 0;
    trades.forEach(function (t) {
      running += parseFloat(t.pnl_usd || 0);
      if (running > peak) peak = running;
      var dd = peak - running;
      if (dd > maxDD) maxDD = dd;
    });
    return maxDD;
  }

  /* ── SAFETY CHECKS ───────────────────────────────────────────────────────── */

  /**
   * Count the current consecutive-loss streak from the most recent trades backward.
   * Stops counting at the first winning trade.
   */
  function _countConsecutiveLosses(allTrades) {
    var n = 0;
    for (var i = allTrades.length - 1; i >= 0; i--) {
      if (parseFloat(allTrades[i].pnl_usd || 0) < 0) n++;
      else break;
    }
    return n;
  }

  /**
   * Smoke alarm: true if every one of the last WINDOW_RECENT IC trades is a loss.
   * Fires before the rolling-window average has time to reflect a deterioration.
   */
  function _smokeAlarm(allTrades) {
    if (allTrades.length < CFG.WINDOW_RECENT) return false;
    var recent = allTrades.slice(-CFG.WINDOW_RECENT);
    return recent.every(function (t) { return parseFloat(t.pnl_usd || 0) <= 0; });
  }

  /**
   * Regime degradation: two independent signals that OSINT catalysts are not
   * moving price reliably.
   *   (a) SL hit rate > 85 % in last REGIME_WINDOW IC trades — price is decisively
   *       moving against entries immediately after open.
   *   (b) Avg trade duration < 45 min in last REGIME_WINDOW — catalysts not
   *       developing; market processing news too fast for OSINT edge to work.
   * Either signal alone triggers the flag.
   */
  function _detectRegimeDegradation(allTrades) {
    var recent = allTrades.slice(-CFG.REGIME_WINDOW);
    if (recent.length < Math.ceil(CFG.REGIME_WINDOW / 2)) return false;  // need at least half the window

    /* (a) SL rate */
    var slCount = recent.filter(function (t) {
      return (t.close_reason || '').indexOf('STOP_LOSS') !== -1;
    }).length;
    if (slCount / recent.length > CFG.REGIME_SL_RATE_THRESHOLD) return true;

    /* (b) Average trade duration */
    var durations = recent
      .filter(function (t) { return t.timestamp_open && t.timestamp_close; })
      .map(function (t) {
        return new Date(t.timestamp_close).getTime() - new Date(t.timestamp_open).getTime();
      });
    if (durations.length >= 5) {
      var avgDur = durations.reduce(function (a, b) { return a + b; }, 0) / durations.length;
      if (avgDur < CFG.REGIME_MIN_DURATION_MS) return true;
    }

    return false;
  }

  /* ── SCALING LOGIC ───────────────────────────────────────────────────────── */

  /**
   * Central scaling decision.  Priority order (highest → lowest):
   *   1. Consecutive-loss emergency (floor + cooling)
   *   2. Consecutive-loss cut (50%)
   *   3. Regime degradation (accelerated step-down)
   *   4. Smoke alarm (recent-window step-down)
   *   5. Standard scale-down (asymmetric minimum threshold)
   *   6. Standard scale-up (stricter criteria + probation cap + rate limit)
   *   7. Hold
   */
  function _applyScalingRules(primary, secondary, allTrades) {
    var oldMult = _mult;
    var reason;

    /* ── 0. Refresh safety state ── */
    _consecutiveLosses = _countConsecutiveLosses(allTrades);
    if (_coolingTradesLeft > 0) {
      _coolingTradesLeft--;
      if (_coolingTradesLeft === 0) {
        _coolingDown = false;
        console.log('[IC-RISK] Cooling period ended — scale-up re-enabled');
      }
    }

    var inProbation    = (allTrades.length < CFG.PROBATION_TRADES);
    var maxMult        = inProbation ? CFG.MULT_MAX_PROBATION : CFG.MULT_MAX;
    var regimeDegraded = _detectRegimeDegradation(allTrades);
    var smokeAlarm     = _smokeAlarm(allTrades);

    /* Store for getStatus() */
    _metrics.safety = {
      inProbation:       inProbation,
      consecutiveLosses: _consecutiveLosses,
      coolingDown:       _coolingDown,
      coolingTradesLeft: _coolingTradesLeft,
      regimeDegraded:    regimeDegraded,
      smokeAlarm:        smokeAlarm,
    };

    /* ── 1. Consecutive-loss floor (5+) ── */
    if (_consecutiveLosses >= CFG.CONSEC_LOSS_FLOOR_AT) {
      if (_mult > CFG.MULT_MIN || !_coolingDown) {
        _mult  = CFG.MULT_MIN;
        _coolingDown      = true;
        _coolingTradesLeft = CFG.CONSEC_LOSS_COOLING;
        reason = 'EMERGENCY FLOOR: ' + _consecutiveLosses + ' consecutive losses → 0.25x floor + ' +
                 CFG.CONSEC_LOSS_COOLING + '-trade scale-up lockout';
      } else {
        reason = 'HOLD (floor, cooling: ' + _coolingTradesLeft + ' trades remain)';
      }
      _appendLog(oldMult, _mult, reason, primary);
      return;
    }

    /* ── 2. Consecutive-loss 50% cut (3–4) ── */
    if (_consecutiveLosses >= CFG.CONSEC_LOSS_CUT_AT) {
      var cut = Math.max(CFG.MULT_MIN, +(_mult * 0.50).toFixed(3));
      if (cut < _mult) {
        _mult  = cut;
        reason = 'CONSEC-LOSS 50% CUT: ' + _consecutiveLosses + ' consecutive losses → ' + _mult.toFixed(2) + 'x';
      } else {
        reason = 'HOLD (already at floor — ' + _consecutiveLosses + ' consec losses)';
      }
      _appendLog(oldMult, _mult, reason, primary);
      return;
    }

    /* ── 3. Regime degradation — double-step scale-down ── */
    if (regimeDegraded) {
      _mult  = Math.max(CFG.MULT_MIN, +(_mult - CFG.SCALE_DOWN_STEP * 2).toFixed(3));
      reason = 'REGIME DEGRADATION: SL-rate or duration anomaly → 2× step-down → ' + _mult.toFixed(2) + 'x';
      _appendLog(oldMult, _mult, reason, primary);
      return;
    }

    /* ── 4. Smoke alarm — standard step-down ── */
    if (smokeAlarm) {
      _mult  = Math.max(CFG.MULT_MIN, +(_mult - CFG.SCALE_DOWN_STEP).toFixed(3));
      reason = 'SMOKE ALARM: last ' + CFG.WINDOW_RECENT + ' IC trades all losses → ' + _mult.toFixed(2) + 'x';
      _appendLog(oldMult, _mult, reason, primary);
      return;
    }

    /* ── 5. Standard scale-down (asymmetric: needs only SCALE_DOWN_MIN_TRADES) ── */
    if (primary.count >= CFG.SCALE_DOWN_MIN_TRADES) {
      var edgeDown = primary.expectancy < CFG.SCALE_DOWN_EXPECTANCY ||
                     primary.tpHitRate  < CFG.SCALE_DOWN_TP_RATE;
      if (edgeDown) {
        _mult  = Math.max(CFG.MULT_MIN, +(_mult - CFG.SCALE_DOWN_STEP).toFixed(3));
        reason = 'SCALE DOWN (E=' + primary.expectancy.toFixed(2) +
                 ', TP=' + (primary.tpHitRate * 100).toFixed(1) + '%) → ' + _mult.toFixed(2) + 'x';
        _appendLog(oldMult, _mult, reason, primary);
        return;
      }
    }

    /* ── 6. Scale-up — stricter: needs 30 trades, E≥$0.50, dual-window, rate limit ── */

    /* 6a. Minimum trades for scale-up */
    if (primary.count < CFG.SCALE_UP_MIN_TRADES) {
      reason = 'HOLD (scale-up locked: ' + primary.count + '/' + CFG.SCALE_UP_MIN_TRADES +
               ' trades in window — accumulating evidence)';
      _appendLog(oldMult, _mult, reason, primary);
      return;
    }

    /* 6b. Expectancy noise floor */
    if (primary.expectancy < CFG.SCALE_UP_MIN_EXPECTANCY) {
      reason = 'HOLD (expectancy $' + primary.expectancy.toFixed(2) +
               ' < $' + CFG.SCALE_UP_MIN_EXPECTANCY + ' noise floor)';
      _appendLog(oldMult, _mult, reason, primary);
      return;
    }

    /* 6c. TP rate threshold */
    if (primary.tpHitRate < CFG.SCALE_UP_TP_RATE) {
      reason = 'HOLD (TP rate ' + (primary.tpHitRate * 100).toFixed(1) + '% < ' +
               (CFG.SCALE_UP_TP_RATE * 100) + '% required)';
      _appendLog(oldMult, _mult, reason, primary);
      return;
    }

    /* 6d. Secondary window must also be positive (dual-window confirmation) */
    if (secondary.count >= 10 && secondary.expectancy <= 0) {
      reason = 'HOLD (secondary window negative: E=' + secondary.expectancy.toFixed(2) +
               ' — primary positive but trend not confirmed)';
      _appendLog(oldMult, _mult, reason, primary);
      return;
    }

    /* 6e. Cooling period after floor-out */
    if (_coolingDown) {
      reason = 'HOLD (post-floor cooling: ' + _coolingTradesLeft + ' trades remain)';
      _appendLog(oldMult, _mult, reason, primary);
      return;
    }

    /* 6f. Already at ceiling */
    if (_mult >= maxMult) {
      reason = 'HOLD (at ' + (inProbation ? 'probation ' : '') + 'ceiling ' + maxMult + 'x' +
               (inProbation ? ' — ' + (CFG.PROBATION_TRADES - allTrades.length) + ' more trades to exit probation' : '') + ')';
      _appendLog(oldMult, _mult, reason, primary);
      return;
    }

    /* 6g. Daily rate limit on scale-ups */
    var _now  = Date.now();
    var _24hAgo = _now - 24 * 60 * 60 * 1000;
    _recentScaleUps = _recentScaleUps.filter(function (ts) { return ts > _24hAgo; });
    if (_recentScaleUps.length >= CFG.SCALE_UP_MAX_PER_DAY) {
      reason = 'HOLD (daily rate limit: ' + _recentScaleUps.length + '/' +
               CFG.SCALE_UP_MAX_PER_DAY + ' scale-ups used in last 24h)';
      _appendLog(oldMult, _mult, reason, primary);
      return;
    }

    /* ── All gates cleared: scale up ── */
    _mult = Math.min(maxMult, +(_mult + CFG.SCALE_UP_STEP).toFixed(3));
    _recentScaleUps.push(_now);
    reason = 'SCALE UP' + (inProbation ? ' [PROBATION cap=' + maxMult + 'x]' : '') +
             ' (E=$' + primary.expectancy.toFixed(2) +
             ', TP=' + (primary.tpHitRate * 100).toFixed(1) + '%' +
             (secondary.count >= 10 ? ', 2°E=$' + secondary.expectancy.toFixed(2) : '') +
             ') → ' + _mult.toFixed(2) + 'x';
    _appendLog(oldMult, _mult, reason, primary);
  }

  /* ── LOG ─────────────────────────────────────────────────────────────────── */
  function _appendLog(oldMult, newMult, reason, m) {
    _scalingLog.unshift({
      ts:      new Date().toISOString(),
      oldMult: +oldMult.toFixed(3),
      newMult: +newMult.toFixed(3),
      reason:  reason,
      snap: {
        count:     m.count,
        wr:        Math.round(m.wr * 1000) / 10,
        expectancy: Math.round(m.expectancy * 100) / 100,
        tpHitRate:  Math.round(m.tpHitRate  * 1000) / 10,
        avgWin:     Math.round(m.avgWin  * 100) / 100,
        avgLoss:    Math.round(m.avgLoss * 100) / 100,
      },
    });
    if (_scalingLog.length > 200) _scalingLog.pop();

    var changed = (oldMult !== newMult);
    if (changed) {
      var msg = '[IC-RISK] ' + reason;
      console.log(msg);
      if (window.GIILog) try { window.GIILog('IC-RISK', msg); } catch (e) {}
    }

    /* Persist */
    try { localStorage.setItem(CFG.MULT_KEY, JSON.stringify(_mult)); } catch (e) {}
  }

  /* ── RECALCULATE ─────────────────────────────────────────────────────────── */
  function recalculate() {
    var all       = _loadICTrades();
    var primary   = all.slice(-CFG.WINDOW_PRIMARY);
    var secondary = all.slice(-CFG.WINDOW_SECONDARY);

    _metrics.primary    = _computeMetrics(primary);
    _metrics.secondary  = _computeMetrics(secondary);
    _metrics.byAsset    = _computeByAsset(secondary);
    _metrics.drawdown   = _computeDrawdown(all);
    _metrics.tradeCount = all.length;
    _metrics.lastCalc   = Date.now();

    /* Pass all three to _applyScalingRules so safety checks have access to raw trade list */
    _applyScalingRules(_metrics.primary, _metrics.secondary, all);
  }

  /* ── PUBLIC API ──────────────────────────────────────────────────────────── */

  /**
   * getICRiskMultiplier(asset)
   * Per-asset bonus applied only when that asset has independently proven edge.
   * Clamped to the current effective ceiling (probation-aware).
   */
  function getICRiskMultiplier(asset) {
    var inProbation = (_metrics.tradeCount < CFG.PROBATION_TRADES);
    var cap = inProbation ? CFG.MULT_MAX_PROBATION : CFG.MULT_MAX;

    var base  = _mult;
    var bonus = asset && CFG.ASSET_BONUS[asset];
    if (bonus) {
      var am = _metrics.byAsset && _metrics.byAsset[asset];
      if (am && am.count >= CFG.ASSET_MIN_TRADES && am.expectancy > 0) {
        base = base * bonus;
      }
    }
    return +Math.min(cap, base).toFixed(4);
  }

  /** isAtMaxICExposure — true if open IC notional ≥ 15% of account */
  function isAtMaxICExposure(accountSize, openICExposureUSD) {
    if (!accountSize || accountSize <= 0) return false;
    return (openICExposureUSD / accountSize) >= CFG.MAX_IC_EXPOSURE_PCT;
  }

  /** Called by gii-exit.js and onTradeClose after every IC close */
  function onICTradeClosed() { recalculate(); }

  /**
   * getStatus() — full snapshot
   * Usage: console.table(ICRiskEngine.getStatus())
   */
  function getStatus() {
    var p = _metrics.primary   || {};
    var s = _metrics.secondary || {};
    var safe = _metrics.safety || {};

    var fmt = function (v, prefix) {
      return (v !== undefined && v !== null && isFinite(v))
        ? (prefix || '') + v.toFixed(2) : '—';
    };
    var pct = function (v) { return isFinite(v) ? Math.round(v * 1000) / 10 + '%' : '—'; };

    var inProbation = (_metrics.tradeCount < CFG.PROBATION_TRADES);
    var maxMult = inProbation ? CFG.MULT_MAX_PROBATION : CFG.MULT_MAX;

    return {
      /* ── Multiplier ───── */
      multiplier:         +_mult.toFixed(3),
      effectiveCeiling:   maxMult + 'x (' + (inProbation
        ? 'PROBATION — ' + (CFG.PROBATION_TRADES - _metrics.tradeCount) + ' more trades needed'
        : 'FULL SCALING') + ')',

      /* ── Safety state ─── */
      safety: {
        inProbation:       safe.inProbation,
        consecutiveLosses: safe.consecutiveLosses,
        coolingDown:       safe.coolingDown,
        coolingTradesLeft: safe.coolingTradesLeft,
        regimeDegraded:    safe.regimeDegraded,
        smokeAlarm:        safe.smokeAlarm,
        recentScaleUps24h: _recentScaleUps.length,
        scaleUpRateLimit:  _recentScaleUps.length + '/' + CFG.SCALE_UP_MAX_PER_DAY + ' per 24h',
      },

      /* ── Rules ──────────── */
      rules: {
        scaleUpRequires:  'Primary≥' + CFG.SCALE_UP_MIN_TRADES + ' trades, E≥$' + CFG.SCALE_UP_MIN_EXPECTANCY +
                          ', TP≥' + (CFG.SCALE_UP_TP_RATE*100) + '%, secondary E>0, max ' +
                          CFG.SCALE_UP_MAX_PER_DAY + ' per 24h',
        scaleDownAt:      'Primary≥' + CFG.SCALE_DOWN_MIN_TRADES + ' trades AND (E<$0 OR TP<' + (CFG.SCALE_DOWN_TP_RATE*100) + '%)',
        smokeAlarm:       'Last ' + CFG.WINDOW_RECENT + ' IC trades all losses → step-down',
        consecLossCut:    CFG.CONSEC_LOSS_CUT_AT + '+ consecutive → 50% cut',
        consecLossFloor:  CFG.CONSEC_LOSS_FLOOR_AT + '+ consecutive → floor (' + CFG.MULT_MIN + 'x) + ' + CFG.CONSEC_LOSS_COOLING + '-trade lockout',
        regimeDegradation:'SL rate >' + (CFG.REGIME_SL_RATE_THRESHOLD*100) + '% OR avg duration <' + (CFG.REGIME_MIN_DURATION_MS/60000) + 'min → double step-down',
        exposureCap:      (CFG.MAX_IC_EXPOSURE_PCT * 100) + '% of account max in open IC',
        multRange:        CFG.MULT_MIN + 'x – ' + maxMult + 'x (current)',
      },

      /* ── Primary window (last 20) ── */
      primary: {
        trades:      p.count      || 0,
        winRate:     pct(p.wr),
        avgWin:      fmt(p.avgWin,  '$'),
        avgLoss:     fmt(p.avgLoss, '$'),
        expectancy:  fmt(p.expectancy, '$'),
        tpHitRate:   pct(p.tpHitRate),
        slHitRate:   pct(p.slHitRate),
        totalPnL:    fmt(p.totalPnL, '$'),
        rotations:   p.rotations || 0,
      },

      /* ── Secondary window (last 60) ── */
      secondary: {
        trades:      s.count       || 0,
        winRate:     pct(s.wr),
        expectancy:  fmt(s.expectancy, '$'),
        tpHitRate:   pct(s.tpHitRate),
        totalPnL:    fmt(s.totalPnL, '$'),
      },

      /* ── Per-asset ───────────── */
      byAsset: (function () {
        var out = {};
        Object.keys(_metrics.byAsset || {}).forEach(function (a) {
          var m = _metrics.byAsset[a];
          out[a] = {
            trades:     m.count,
            wr:         pct(m.wr),
            expectancy: fmt(m.expectancy, '$'),
            tpHitRate:  pct(m.tpHitRate),
            bonus: CFG.ASSET_BONUS[a]
              ? (m.count >= CFG.ASSET_MIN_TRADES && m.expectancy > 0
                ? CFG.ASSET_BONUS[a] + 'x ACTIVE'
                : CFG.ASSET_BONUS[a] + 'x (waiting for ' + CFG.ASSET_MIN_TRADES + ' trades + E>0)')
              : 'none',
          };
        });
        return out;
      })(),

      /* ── Portfolio ── */
      icDrawdown:    fmt(_metrics.drawdown, '$'),
      totalICTrades: _metrics.tradeCount,
      lastCalc:      _metrics.lastCalc ? new Date(_metrics.lastCalc).toISOString() : 'never',
      recentLog:     _scalingLog.slice(0, 15),
    };
  }

  /* ── INIT ───────────────────────────────────────────────────────────────── */
  function init() {
    /* Restore persisted multiplier */
    try {
      var saved = localStorage.getItem(CFG.MULT_KEY);
      if (saved !== null) {
        var v = parseFloat(saved);
        if (isFinite(v) && v >= CFG.MULT_MIN && v <= CFG.MULT_MAX) {
          _mult = v;
        }
      }
    } catch (e) {}

    recalculate();

    /* Cold-start protection: if fewer trades than SCALE_DOWN_MIN_TRADES exist,
       a saved multiplier has no statistical support — reset it.
       Prevents a cleared trade history from leaving a stale high multiplier. */
    if (_metrics.tradeCount < CFG.SCALE_DOWN_MIN_TRADES && _mult !== CFG.MULT_INIT) {
      console.log('[IC-RISK-ENGINE] Cold-start reset: ' + _metrics.tradeCount +
                  ' trades < ' + CFG.SCALE_DOWN_MIN_TRADES + ' min, resetting multiplier ' +
                  _mult.toFixed(2) + 'x → 1.00x');
      _mult = CFG.MULT_INIT;
      try { localStorage.setItem(CFG.MULT_KEY, JSON.stringify(_mult)); } catch (e) {}
    }

    setInterval(recalculate, CFG.RECALC_INTERVAL_MS);

    var inProb = (_metrics.tradeCount < CFG.PROBATION_TRADES);
    console.log(
      '[IC-RISK-ENGINE] v2 ready' +
      ' | mult=' + _mult.toFixed(2) + 'x' +
      ' | ceiling=' + (inProb ? CFG.MULT_MAX_PROBATION : CFG.MULT_MAX) + 'x' +
      (inProb ? ' [PROBATION: ' + _metrics.tradeCount + '/' + CFG.PROBATION_TRADES + ' trades]' : ' [FULL SCALING]') +
      ' | primary E=' + ((_metrics.primary && _metrics.primary.expectancy) || 0).toFixed(2)
    );
  }

  /* ── EXPORT ─────────────────────────────────────────────────────────────── */
  window.ICRiskEngine = {
    VERSION:             2,
    init:                init,
    recalculate:         recalculate,
    getICRiskMultiplier: getICRiskMultiplier,
    isAtMaxICExposure:   isAtMaxICExposure,
    onICTradeClosed:     onICTradeClosed,
    getStatus:           getStatus,
    _cfg:                CFG,       /* live-tune without reload */
    _log:                _scalingLog,
  };

})(window);
