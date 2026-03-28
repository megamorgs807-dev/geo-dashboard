/* ══════════════════════════════════════════════════════════════════════════════
   TRADE GATEKEEPER (GK) — Pre-execution signal validation layer
   ══════════════════════════════════════════════════════════════════════════════
   Sits between GII Core and the Execution Engine.
   Wraps EE.onSignals() — the single choke-point all signals pass through —
   and applies 8 independent checks before any signal reaches buildTrade().

   Load order: AFTER executionEngine.js AND gii-core.js (installs at +7.5 s).

   Public API: window.GK
     .status()        → { enabled, installed, stats, config }
     .log()           → last 50 verdicts (newest first)
     .enable()        → re-enable gating
     .disable()       → bypass mode (all signals pass through)
     .getConfig()     → copy of active config
     .setConfig(k,v)  → update a config key at runtime
   ══════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Config ─────────────────────────────────────────────────────────────────
     All thresholds are conservative and tunable at runtime via GK.setConfig().  */
  var GK_CONFIG = {
    maxSignalsPerRegionPerBatch: 4,   // thundering-herd cap: max signals per region per cycle
    maxSignalAgeMins:            2,   // hard-reject stale signals older than this (tightened 5→2 min)
    maxScalperAgeSecs:          45,   // scalper signals must be < 45s old (5m/15m timeframes)
    elevatedGTIThreshold:       70,   // intermediate GTI tier: elevated tension floor
    elevatedGTIMinConf:         72,   // min conf% required when GTI is elevated (70-79)
    extremeGTIThreshold:        80,   // GTI level that tightens the confidence floor further
    extremeGTIMinConf:          78,   // min conf% required when GTI is extreme (≥80)
    rapidReentryMs:        300000,   // 5 min: block re-entry after same-asset close
    regimeWarnGTI:              65,   // elevated GTI: apply soft confidence penalty
    regimeWarnPenalty:           5,   // conf% deducted when regime is elevated
    minWinRateBlock:          0.30,   // block agent if win rate falls below this
    minTradesForBlock:           5    // minimum trade history before win-rate block applies
  };

  /* ── State ─────────────────────────────────────────────────────────────────── */
  var _enabled   = true;
  var _installed = false;
  var _log       = [];   // ring buffer, newest first
  var _stats     = { total: 0, passed: 0, rejected: 0, adjusted: 0 };
  var _originalOnSignals = null;

  /* ── Helpers ────────────────────────────────────────────────────────────────── */
  function _normAsset(asset) {
    return (asset || '').toString().toUpperCase()
      .replace(/\s+(crude|oil|gold|silver|futures?)\s*/gi, '')
      .trim().split(/[\s\/]+/)[0];
  }

  function _pushVerdict(sig, verdict, reason) {
    _log.unshift({
      ts:      new Date().toISOString(),
      asset:   sig.asset,
      dir:     sig.dir,
      conf:    sig.conf,
      source:  sig.source || '?',
      verdict: verdict,
      reason:  reason
    });
    if (_log.length > 50) _log.pop();
    _stats.total++;
    if      (verdict === 'PASS')   _stats.passed++;
    else if (verdict === 'ADJ')  { _stats.passed++; _stats.adjusted++; }
    else                           _stats.rejected++;
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     CHECK 1 — Conflict detection (batch-level)
     If a batch contains LONG and SHORT for the same asset, agents disagree.
     No edge exists — reject both to avoid random-direction trading.
     ══════════════════════════════════════════════════════════════════════════════ */
  function _conflictedAssets(batch) {
    var seen = {}, conflicts = {};
    batch.forEach(function (s) {
      var a = _normAsset(s.asset);
      if (seen[a] !== undefined && seen[a] !== s.dir) conflicts[a] = true;
      else if (seen[a] === undefined) seen[a] = s.dir;
    });
    return conflicts;
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     CHECK 2 — Staleness
     Agents buffer up to 20 signals; old signals can linger for hours.
     Reject any signal whose timestamp is beyond maxSignalAgeMins.
     ══════════════════════════════════════════════════════════════════════════════ */
  function _checkStaleness(sig) {
    if (!sig.timestamp || typeof sig.timestamp !== 'number') return null;
    var ageMs = Date.now() - sig.timestamp;
    // Scalper signals use 5m/15m candles — tighter age limit (Smart Improvement 4)
    var isScalper = (sig.source || '').toLowerCase().indexOf('scalp') !== -1;
    if (isScalper && ageMs > GK_CONFIG.maxScalperAgeSecs * 1000) {
      return 'Scalper signal stale — ' + Math.round(ageMs / 1000) + 's old (max ' + GK_CONFIG.maxScalperAgeSecs + 's)';
    }
    if (ageMs > GK_CONFIG.maxSignalAgeMins * 60000) {
      return 'Stale — ' + Math.round(ageMs / 60000) + 'min old (max ' + GK_CONFIG.maxSignalAgeMins + 'min)';
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     CHECK 3 — Stop plausibility
     Catches broken ATR / stopPct overrides before they corrupt position sizing.
     EE has its own 20% sanity check, but this catches problems one stage earlier.
     ══════════════════════════════════════════════════════════════════════════════ */
  function _checkStopPlausibility(sig) {
    if (sig.stopPct && sig.stopPct > 15) {
      return 'stopPct ' + sig.stopPct.toFixed(1) + '% > 15% — likely price source error';
    }
    if (sig.atrStop && sig.atrTarget) {
      var ratio = sig.atrTarget / sig.atrStop;
      if (!isFinite(ratio) || ratio > 20 || ratio < 0.3) {
        return 'atrTarget/atrStop ratio ' + ratio.toFixed(1) + ' implausible (expect 0.5–10×)';
      }
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     CHECK 4 — Rapid re-entry
     Prevents opening a new trade within rapidReentryMs of the same asset closing.
     Catches stop-loss → immediate re-entry loops that inflate trade count and fees.
     EE's cooldown starts at open, not close — this fills that gap.
     ══════════════════════════════════════════════════════════════════════════════ */
  function _checkRapidReentry(sig) {
    try {
      var raw = localStorage.getItem('geodash_ee_trades_v1');
      if (!raw) return null;
      var trades  = JSON.parse(raw);
      var key     = _normAsset(sig.asset);
      var cutoff  = Date.now() - GK_CONFIG.rapidReentryMs;
      var recent  = trades.find(function (t) {
        return t.status === 'CLOSED' &&
               _normAsset(t.asset) === key &&
               t.timestamp_close &&
               new Date(t.timestamp_close).getTime() > cutoff;
      });
      if (recent) {
        var ago = Math.round((Date.now() - new Date(recent.timestamp_close).getTime()) / 60000);
        return 'Re-entry: ' + sig.asset + ' closed ' + ago + 'min ago (' + (recent.close_reason || '?') + ')';
      }
    } catch (e) {}
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     CHECK 5 — GTI gate (two-tier: elevated 70-79, extreme ≥80)
     Smooths the previous hard cliff at 80 into a graduated scale:
       GTI 70-79 → conf must be ≥ 72% (elevated floor)
       GTI  ≥80  → conf must be ≥ 78% (extreme floor)
     ══════════════════════════════════════════════════════════════════════════════ */
  function _checkGTIGate(sig) {
    if (!window.GII || typeof GII.gti !== 'function') return null;
    var gtiObj = GII.gti();
    var gti = (gtiObj && typeof gtiObj === 'object') ? gtiObj.value : gtiObj;  // GII.gti() returns { value, level }
    if (!isFinite(gti)) return null;
    if (gti >= GK_CONFIG.extremeGTIThreshold && sig.conf < GK_CONFIG.extremeGTIMinConf) {
      return 'GTI ' + gti.toFixed(0) + '/100 (EXTREME) — conf ' + sig.conf + '% below ' + GK_CONFIG.extremeGTIMinConf + '% floor';
    }
    if (gti >= GK_CONFIG.elevatedGTIThreshold && sig.conf < GK_CONFIG.elevatedGTIMinConf) {
      return 'GTI ' + gti.toFixed(0) + '/100 (ELEVATED) — conf ' + sig.conf + '% below ' + GK_CONFIG.elevatedGTIMinConf + '% floor';
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     CHECK 6 — Source credibility
     Block signals from agents with consistently poor performance on this
     asset+direction. Requires minTradesForBlock trades before penalising.
     ══════════════════════════════════════════════════════════════════════════════ */
  function _checkSourceCredibility(sig) {
    if (!window.GII || typeof GII.agentReputations !== 'function') return null;
    try {
      var reps   = GII.agentReputations();
      var src    = (sig.source || '').toLowerCase();
      var asset  = _normAsset(sig.asset).toLowerCase();
      var dir    = (sig.dir || 'LONG').toLowerCase();
      var rep    = reps[src + '_' + asset + '_' + dir];
      if (rep && rep.total >= GK_CONFIG.minTradesForBlock && rep.winRate < GK_CONFIG.minWinRateBlock) {
        return 'Agent "' + sig.source + '" win rate ' +
               (rep.winRate * 100).toFixed(0) + '% on ' + sig.asset + ' ' + sig.dir +
               ' (' + rep.total + ' trades) — below ' + (GK_CONFIG.minWinRateBlock * 100) + '% floor';
      }
    } catch (e) {}
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     CHECK 7 — Batch region cap  (soft — keeps top-N by confidence)
     Prevents a single region flooding the batch with 10+ signals in one cycle.
     Keeps only the top-N highest-confidence signals per region.
     ══════════════════════════════════════════════════════════════════════════════ */
  function _applyBatchCap(batch) {
    var byRegion = {};
    batch.forEach(function (s) {
      var r = s.region || 'GLOBAL';
      if (!byRegion[r]) byRegion[r] = [];
      byRegion[r].push(s);
    });
    var result = [];
    Object.keys(byRegion).forEach(function (region) {
      var sigs = byRegion[region];
      if (sigs.length > GK_CONFIG.maxSignalsPerRegionPerBatch) {
        sigs.sort(function (a, b) { return b.conf - a.conf; });
        // Log dropped signals
        sigs.slice(GK_CONFIG.maxSignalsPerRegionPerBatch).forEach(function (s) {
          _pushVerdict(s, 'REJECT',
            'Batch cap: region "' + region + '" limited to ' +
            GK_CONFIG.maxSignalsPerRegionPerBatch + ' signals/cycle');
        });
        result = result.concat(sigs.slice(0, GK_CONFIG.maxSignalsPerRegionPerBatch));
      } else {
        result = result.concat(sigs);
      }
    });
    return result;
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     CHECK 8 — Regime confidence penalty  (soft — adjusts conf, does not reject)
     When GTI is elevated but not extreme, quietly reduce conf by a small amount.
     Signals still pass, but weaker ones may fall below EE's 65% threshold.
     ══════════════════════════════════════════════════════════════════════════════ */
  function _regimePenalty(sig) {
    if (!window.GII || typeof GII.gti !== 'function') return 0;
    var gtiObj = GII.gti();
    var gti = (gtiObj && typeof gtiObj === 'object') ? gtiObj.value : gtiObj;  // GII.gti() returns { value, level }
    if (!isFinite(gti)) return 0;
    // Only penalise signals that are already close to the threshold
    if (gti > GK_CONFIG.regimeWarnGTI && sig.conf < 75) {
      return GK_CONFIG.regimeWarnPenalty;
    }
    return 0;
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     MAIN FILTER  — runs all checks in order, returns only passing signals
     ══════════════════════════════════════════════════════════════════════════════ */
  function filter(sigs) {
    if (!sigs || !sigs.length) return [];

    // Batch-level: detect conflicts, apply region cap
    var conflicts = _conflictedAssets(sigs);
    var capped    = _applyBatchCap(sigs);

    var passing = [];
    capped.forEach(function (sig) {

      // Check 1: conflict
      if (conflicts[_normAsset(sig.asset)]) {
        _pushVerdict(sig, 'REJECT',
          'Conflict: batch contains both LONG and SHORT for ' + sig.asset);
        return;
      }

      // Checks 2–6: ordered hard rejects (first failure wins)
      var hard =
        _checkStaleness(sig)          ||
        _checkStopPlausibility(sig)   ||
        _checkRapidReentry(sig)       ||
        _checkGTIGate(sig)            ||
        _checkSourceCredibility(sig);

      if (hard) {
        _pushVerdict(sig, 'REJECT', hard);
        return;
      }

      // Check 8: regime soft penalty
      var penalty = _regimePenalty(sig);
      if (penalty > 0) {
        var adjusted = JSON.parse(JSON.stringify(sig));
        adjusted.conf = Math.max(0, adjusted.conf - penalty);
        adjusted._gkPenalty = penalty;
        _pushVerdict(adjusted, 'ADJ',
          'Regime penalty: conf ' + sig.conf + '→' + adjusted.conf + '% (GTI ' + (function(){ var g=GII.gti(); return ((g&&typeof g==='object')?g.value:g).toFixed(0); })() + ')');
        passing.push(adjusted);
        return;
      }

      _pushVerdict(sig, 'PASS', 'All checks passed');
      passing.push(sig);
    });

    _renderStatus();
    return passing;
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     STATUS UI — small bar injected at the top of the EE panel
     ══════════════════════════════════════════════════════════════════════════════ */
  function _renderStatus() {
    var el = document.getElementById('gkStatusBar');
    if (!el) return;
    var last = _log[0];
    var icon = !last                                    ? '—'
             : last.verdict === 'REJECT'                ? '<span style="color:#ff1744">✗</span>'
             : last.verdict === 'ADJ'                   ? '<span style="color:#ffab40">~</span>'
             :                                            '<span style="color:#00e676">✓</span>';
    var lastMsg = last
      ? icon + ' ' + (last.asset || '?') + ' ' + (last.dir || '') +
        '  <span style="color:var(--dim)">' + (last.reason || '').substring(0, 70) + '</span>'
      : '—';

    el.innerHTML =
      '<span style="color:#e040fb;font-size:10px;font-weight:700;letter-spacing:.04em;margin-right:12px">GATEKEEPER</span>' +
      '<span style="font-size:9px;color:var(--dim);margin-right:10px">passed <b style="color:#00e676">' + _stats.passed + '</b></span>' +
      '<span style="font-size:9px;color:var(--dim);margin-right:10px">rejected <b style="color:#ff1744">' + _stats.rejected + '</b></span>' +
      '<span style="font-size:9px;color:var(--dim);margin-right:14px">adjusted <b style="color:#ffab40">' + _stats.adjusted + '</b></span>' +
      '<span style="font-size:9px">' + lastMsg + '</span>';
  }

  function _injectUI() {
    if (document.getElementById('gkStatusBar')) return;
    var eeWrap = document.getElementById('eeWrap');
    if (!eeWrap) return;
    var bar       = document.createElement('div');
    bar.id        = 'gkStatusBar';
    bar.style.cssText =
      'padding:5px 12px;background:rgba(224,64,251,0.05);border:1px solid rgba(224,64,251,0.18);' +
      'border-radius:6px;margin-bottom:8px;display:flex;align-items:center;flex-wrap:wrap;gap:4px;';
    eeWrap.insertBefore(bar, eeWrap.firstChild);
    _renderStatus();
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     INSTALL — wraps EE.onSignals at the single entry point all signals use
     ══════════════════════════════════════════════════════════════════════════════ */
  function install() {
    if (_installed) return;
    if (!window.EE || typeof EE.onSignals !== 'function') {
      setTimeout(install, 2000);   // EE not ready yet — retry
      return;
    }

    // Wrap the single EE signal intake. All paths (GII core, scalper, IC direct)
    // call EE.onSignals(), so this one wrap covers the entire pipeline.
    _originalOnSignals = EE.onSignals.bind(EE);
    EE.onSignals = function (sigs) {
      if (!_enabled) {
        _originalOnSignals(sigs);
        return;
      }
      var filtered = filter(sigs);
      if (filtered.length) _originalOnSignals(filtered);
    };

    _installed = true;

    // Inject the status bar and keep it alive across EE re-renders
    _injectUI();
    setInterval(function () {
      if (!document.getElementById('gkStatusBar')) _injectUI();
    }, 3000);

    console.log('[GK] Trade Gatekeeper installed — ' +
      Object.keys(GK_CONFIG).length + ' checks active');
  }

  window.addEventListener('load', function () {
    setTimeout(install, 7500);   // after EE (4 s) + GII (6 s) fully init
  });

  /* ══════════════════════════════════════════════════════════════════════════════
     PUBLIC API
     ══════════════════════════════════════════════════════════════════════════════ */
  window.GK = {
    filter:    filter,
    install:   install,

    status: function () {
      return {
        enabled:   _enabled,
        installed: _installed,
        stats:     JSON.parse(JSON.stringify(_stats)),
        config:    JSON.parse(JSON.stringify(GK_CONFIG))
      };
    },

    log: function () { return _log.slice(); },

    enable:  function () { _enabled = true;  console.log('[GK] enabled'); },
    disable: function () { _enabled = false; console.log('[GK] disabled — bypass mode'); },

    getConfig: function () { return JSON.parse(JSON.stringify(GK_CONFIG)); },
    setConfig: function (k, v) {
      if (Object.prototype.hasOwnProperty.call(GK_CONFIG, k)) {
        GK_CONFIG[k] = v;
        console.log('[GK] config: ' + k + ' = ' + v);
      }
    }
  };

})();
