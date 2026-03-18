/**
 * GII Manager Agent — system health monitor for all GII agents + EE pipeline
 * Runs every 5 min, catches contradictions, stale agents, runaway chains, bad win rates.
 * Exposes window.GII_AGENT_MANAGER
 */
(function () {
  'use strict';

  /* ── CONFIG ─────────────────────────────────────────────────────────────── */
  var POLL_INTERVAL_MS = 5 * 60 * 1000;   // check every 5 min
  var INIT_DELAY_MS    = 30 * 1000;        // wait 30s for all agents to boot first
  var MAX_ALERTS       = 60;

  /* How long before a lastPoll is flagged as stale (2× expected interval) */
  var STALE_MS = {
    GII_AGENT_ENERGY:          8  * 60 * 1000,
    GII_AGENT_CONFLICT:        8  * 60 * 1000,
    GII_AGENT_MACRO:           8  * 60 * 1000,
    GII_AGENT_SANCTIONS:       8  * 60 * 1000,
    GII_AGENT_MARITIME:        8  * 60 * 1000,
    GII_AGENT_SOCIAL:          8  * 60 * 1000,
    GII_AGENT_POLYMARKET:      8  * 60 * 1000,
    GII_AGENT_REGIME:          8  * 60 * 1000,
    GII_AGENT_SCALPER:         12 * 60 * 1000,
    GII_AGENT_SCALPER_SESSION: 12 * 60 * 1000,
    GII_SCRAPER_MANAGER:        4 * 60 * 1000,  // scans every 2 min; 4 min = stale
    GII_AGENT_ENTRY:           4  * 60 * 1000,
    GII_AGENT_EXIT:            4  * 60 * 1000,
    GII_AGENT_DEESCALATION:    3  * 60 * 1000,
    GII_AGENT_RISK:            3  * 60 * 1000
  };

  /* Agents that should always have signals when the backend is online */
  var WARN_ON_ZERO = [
    'GII_AGENT_ENERGY', 'GII_AGENT_CONFLICT',
    'GII_AGENT_SANCTIONS'
    // Maritime removed: legitimately returns 0 when no maritime events in IC feed
  ];

  var AGENT_NAMES = Object.keys(STALE_MS);

  /* ── STATE ──────────────────────────────────────────────────────────────── */
  var _alerts     = [];
  var _health     = {};
  var _lastCheck  = 0;
  var _checkCount = 0;
  var _nudgeLog   = {};

  /* ── HELPERS ────────────────────────────────────────────────────────────── */
  function _ts() { return Date.now(); }
  function _hhmm() {
    var d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(function (n) { return String(n).padStart(2, '0'); }).join(':');
  }

  function _addAlert(id, severity, agent, message) {
    /* Mark any existing same-id alert resolved first */
    _alerts.forEach(function (a) { if (a.id === id && !a.resolved) a.resolved = true; });
    if (severity === 'ok') return;
    _alerts.unshift({ id: id, severity: severity, agent: agent,
                      message: message, ts: _ts(), time: _hhmm(), resolved: false });
    if (_alerts.length > MAX_ALERTS) _alerts = _alerts.slice(0, MAX_ALERTS);
    console.warn('[GII-MANAGER] ' + severity.toUpperCase() + ' · ' + agent + ' · ' + message);
  }

  function _resolve(id) {
    _alerts.forEach(function (a) { if (a.id === id) a.resolved = true; });
  }

  /* ── CHECK: all registered agents ──────────────────────────────────────── */
  function _checkAgents() {
    var now = _ts();
    AGENT_NAMES.forEach(function (name) {
      var agent = window[name];
      var h = { name: name, loaded: !!agent, status: 'ok', message: '', signalCount: 0 };

      if (!agent) {
        h.status  = 'error';
        h.message = 'Not loaded';
        _addAlert(name + '_load', 'error', name, 'Agent not loaded');
        _health[name] = h;
        return;
      }
      _resolve(name + '_load');

      /* Poll freshness */
      var st = {};
      try { st = agent.status ? agent.status() : {}; } catch (e) { st = {}; }
      var lastPoll = st.lastPoll || 0;
      var staleMs  = STALE_MS[name] || 10 * 60 * 1000;

      if (lastPoll && (now - lastPoll) > staleMs) {
        var ageMin = Math.round((now - lastPoll) / 60000);
        h.status  = 'warn';
        h.message = 'Stale — last poll ' + ageMin + 'min ago';
        _addAlert(name + '_stale', 'warn', name, 'No poll for ' + ageMin + ' min');
        /* Auto-nudge once per stale window */
        if (!_nudgeLog[name] || (now - _nudgeLog[name]) > staleMs) {
          try {
            if (typeof agent.poll === 'function') {
              agent.poll();
              _nudgeLog[name] = now;
              h.message += ' → nudged';
            }
          } catch (e) {}
        }
      } else {
        _resolve(name + '_stale');
      }

      /* Signal count sanity */
      var sigs = [];
      try { sigs = agent.signals ? agent.signals() : []; } catch (e) {}
      h.signalCount = sigs.length;

      var backendOnline = !!(window.__IC && window.__IC.events && window.__IC.events.length > 0);
      if (backendOnline && sigs.length === 0 && lastPoll && (now - lastPoll) < staleMs) {
        if (WARN_ON_ZERO.indexOf(name) !== -1) {
          if (h.status !== 'error') h.status = 'warn';
          h.message = h.message || '0 signals despite data online';
          _addAlert(name + '_nosig', 'warn', name, '0 signals after polling');
        }
      } else {
        _resolve(name + '_nosig');
      }

      /* Explicit error field in status */
      if (st.error) {
        h.status  = 'error';
        h.message = 'Error: ' + String(st.error).slice(0, 80);
        _addAlert(name + '_err', 'error', name, h.message);
      } else {
        _resolve(name + '_err');
      }

      if (h.status === 'ok') h.message = sigs.length + ' signals · last poll OK';
      _health[name] = h;
    });
  }

  /* ── CHECK: macro agent contradiction ──────────────────────────────────── */
  function _checkMacro() {
    var macro = window.GII_AGENT_MACRO;
    if (!macro) return;
    try {
      var st = macro.status();
      /* CRISIS regime should be RISK_OFF, not RISK_ON */
      if (st.regime === 'CRISIS' && st.riskMode === 'RISK_ON') {
        _addAlert('macro_contradiction', 'warn', 'GII_AGENT_MACRO',
          'Contradiction: regime=CRISIS but riskMode=RISK_ON — macro posture signals may be inverted');
      } else {
        _resolve('macro_contradiction');
      }
      /* Missing VIX means vol-based sizing is blind */
      if (st.vix === null || st.vix === undefined) {
        _addAlert('macro_vix_null', 'warn', 'GII_AGENT_MACRO',
          'VIX data unavailable — volatility-based risk sizing inactive');
      } else {
        _resolve('macro_vix_null');
      }
    } catch (e) {}
  }

  /* ── CHECK: EE pipeline health ──────────────────────────────────────────── */
  function _checkEE() {
    try {
      var trades = JSON.parse(localStorage.getItem('geodash_ee_trades_v1') || '[]');

      /* Duplicate open positions on same asset */
      var openCount = {};
      trades.forEach(function (t) {
        if (t.status === 'OPEN') openCount[t.asset] = (openCount[t.asset] || 0) + 1;
      });
      var dupes = Object.keys(openCount).filter(function (a) { return openCount[a] > 1; });
      if (dupes.length) {
        _addAlert('ee_dupes', 'warn', 'EE',
          'Duplicate open positions: ' + dupes.join(', ') + ' — may indicate cooldown bypass');
      } else {
        _resolve('ee_dupes');
      }

      /* Win rate on last 20 closed trades */
      var closed = trades.filter(function (t) { return t.status === 'CLOSED'; }).slice(-20);
      if (closed.length >= 10) {
        var wins = closed.filter(function (t) { return (t.pnl_pct || 0) > 0; }).length;
        var wr   = wins / closed.length;
        // At 2.5 R:R breakeven = 28.6% — warn at 33% (buffer above breakeven)
        if (wr < 0.28) {
          _addAlert('ee_winrate', 'error', 'EE',
            'Win rate critically low: ' + Math.round(wr * 100) + '% on last ' + closed.length + ' trades');
        } else if (wr < 0.33) {
          _addAlert('ee_winrate', 'warn', 'EE',
            'Win rate below target: ' + Math.round(wr * 100) + '% on last ' + closed.length + ' trades');
        } else {
          _resolve('ee_winrate');
        }
      }

      /* Escalation chain spam — check signal log for repeated reasons */
      var sigLog = JSON.parse(localStorage.getItem('geodash_ee_siglog_v1') || '[]');
      var reasonCounts = {};
      sigLog.slice(-200).forEach(function (s) {
        var r = s.reason || 'unknown';
        reasonCounts[r] = (reasonCounts[r] || 0) + 1;
      });
      var topReason = Object.keys(reasonCounts).sort(function (a, b) {
        return reasonCounts[b] - reasonCounts[a];
      })[0];
      if (topReason && reasonCounts[topReason] > 60) {
        _addAlert('ee_chain_spam', 'warn', 'EE',
          'Escalation chain "' + topReason.slice(0, 40) + '" fired ' + reasonCounts[topReason] + '× — possible runaway loop');
      } else {
        _resolve('ee_chain_spam');
      }

    } catch (e) {}
  }

  /* ── CHECK: GII core feedback loop ─────────────────────────────────────── */
  function _checkGIICore() {
    if (!window.GII) return;
    try {
      /* Feedback accumulates only from GII-originated trades (reason contains 'GII').
         IC-pipeline trades are not attributed to GII agents and never populate feedback. */
      var fb = GII.feedback ? GII.feedback() : {};
      var trades     = JSON.parse(localStorage.getItem('geodash_ee_trades_v1') || '[]');
      var closedTP_SL = trades.filter(function (t) {
        return t.status === 'CLOSED' &&
               (t.close_reason === 'TAKE_PROFIT' || t.close_reason === 'STOP_LOSS') &&
               (t.reason || '').indexOf('GII') !== -1;
      }).length;

      if (closedTP_SL >= 5 && Object.keys(fb).length === 0) {
        _addAlert('gii_fb_empty', 'warn', 'GII_CORE',
          'Self-learning has no feedback despite ' + closedTP_SL + ' closed TP/SL trades');
      } else {
        _resolve('gii_fb_empty');
      }

      /* GII cycle freshness */
      var st = GII.status ? GII.status() : {};
      if (st.lastCycle && (_ts() - st.lastCycle) > 10 * 60 * 1000) {
        _addAlert('gii_cycle_stale', 'warn', 'GII_CORE',
          'Orchestration cycle stale — last ran ' + Math.round((_ts() - st.lastCycle) / 60000) + 'min ago');
      } else {
        _resolve('gii_cycle_stale');
      }

      /* Too many signals in queue — threshold scales with agent count (15 signals/agent avg) */
      var _sigFloodLimit = Math.max(200, (st.agentCount || AGENT_NAMES.length) * 15);
      if (st.signalCount && st.signalCount > _sigFloodLimit) {
        _addAlert('gii_sig_flood', 'warn', 'GII_CORE',
          'Signal queue oversized: ' + st.signalCount + ' signals (limit ' + _sigFloodLimit + ') — possible agent loop or data flood');
      } else {
        _resolve('gii_sig_flood');
      }

    } catch (e) {}
  }

  /* ── CHECK: scalper-specific ────────────────────────────────────────────── */
  function _checkScalper() {
    var scalper = window.GII_AGENT_SCALPER;
    if (!scalper) return;
    try {
      var st = scalper.status();
      /* Scalp slot stuck open for >2 hours means trade never opened in EE */
      if (st.activeScalp && st.activeScalp.signalTs) {
        var ageH = (_ts() - st.activeScalp.signalTs) / 3600000;
        if (ageH > 2) {
          _addAlert('scalper_slot_stuck', 'warn', 'GII_AGENT_SCALPER',
            'Scalp slot locked for ' + ageH.toFixed(1) + 'h — trade may not have opened in EE (slot will clear)');
        } else {
          _resolve('scalper_slot_stuck');
        }
      } else {
        _resolve('scalper_slot_stuck');
      }
    } catch (e) {}
  }

  /* ── CHECK: portfolio quality — are the open slots filled with the BEST trades? ──
     Runs every poll cycle. Scores each open trade by current conviction and:
       1. Flags trades that have fallen below minimum quality
       2. Detects region/event over-concentration (>2 trades from same source)
       3. Closes the weakest trade if slots are full AND it's significantly below threshold
     This ensures the 8 open slots are always occupied by the strongest opportunities. */
  function _checkPortfolioQuality() {
    if (!window.EE || typeof EE.getOpenTrades !== 'function') return;
    try {
      var open = EE.getOpenTrades();
      if (!open.length) return;

      var cfg = EE.getConfig ? EE.getConfig() : {};
      var maxSlots = cfg.max_open_trades || 8;
      var slotsFull = open.length >= maxSlots;

      /* Score proxy: same logic as gii-entry rotation */
      function _tradeScore(t) {
        return (t.thesis && t.thesis.confluenceScore) ? t.thesis.confluenceScore : (t.confidence || 50) / 15;
      }

      /* Minimum quality score to hold a slot — below this, trade is a candidate for closure */
      var MIN_HOLD_SCORE = 3.5;

      /* 1. Find weak trades (below threshold) */
      var weakTrades = open.filter(function(t) {
        var ageMs = _ts() - new Date(t.timestamp_open || 0).getTime();
        return ageMs > 30 * 60 * 1000 && _tradeScore(t) < MIN_HOLD_SCORE;
      });

      if (weakTrades.length) {
        _addAlert('portfolio_weak', 'warn', 'PORTFOLIO',
          weakTrades.length + ' open trade(s) below quality threshold: ' +
          weakTrades.map(function(t) {
            return t.asset + '(score ' + _tradeScore(t).toFixed(1) + ')';
          }).join(', '));
        /* If slots are full, auto-close the weakest to free room for better signals */
        if (slotsFull) {
          var weakest = weakTrades.slice().sort(function(a, b) { return _tradeScore(a) - _tradeScore(b); })[0];
          if (weakest && _tradeScore(weakest) < MIN_HOLD_SCORE * 0.7) {
            try {
              EE.forceCloseTrade(weakest.trade_id, 'MANAGER:quality-below-threshold(score ' + _tradeScore(weakest).toFixed(1) + ')');
              _addAlert('portfolio_purge', 'warn', 'PORTFOLIO',
                'Auto-closed ' + weakest.asset + ' (score=' + _tradeScore(weakest).toFixed(1) + ') — slots full, freeing room for stronger signal');
            } catch (e) {}
          }
        }
      } else {
        _resolve('portfolio_weak');
        _resolve('portfolio_purge');
      }

      /* 2. Event/region concentration — flag if >2 slots from same event keyword */
      var eventCounts = {};
      open.forEach(function(t) {
        var key = (t.reason || '').substring(0, 40).toLowerCase();
        if (key) eventCounts[key] = (eventCounts[key] || 0) + 1;
      });
      var concentrated = Object.keys(eventCounts).filter(function(k) { return eventCounts[k] > 2; });
      if (concentrated.length) {
        _addAlert('portfolio_concentration', 'warn', 'PORTFOLIO',
          'Event concentration: ' + concentrated.map(function(k) {
            return '"' + k.substring(0, 30) + '" ×' + eventCounts[k];
          }).join(', ') + ' — single event dominating portfolio');
      } else {
        _resolve('portfolio_concentration');
      }

      /* 3. Zombie positions — $0 size open for >10 min (belt-and-suspenders over EE cleanup) */
      var zombies = open.filter(function(t) {
        var ageMs = _ts() - new Date(t.timestamp_open || 0).getTime();
        return (!t.size_usd || t.size_usd === 0) && ageMs > 10 * 60 * 1000;
      });
      if (zombies.length) {
        _addAlert('portfolio_zombie', 'error', 'PORTFOLIO',
          zombies.length + ' zombie position(s) with $0 size: ' + zombies.map(function(t) { return t.asset; }).join(', '));
        zombies.forEach(function(t) {
          try { EE.forceCloseTrade(t.trade_id, 'MANAGER:zombie-$0-size'); } catch(e) {}
        });
      } else {
        _resolve('portfolio_zombie');
      }

    } catch (e) {}
  }

  /* ── MAIN POLL ──────────────────────────────────────────────────────────── */
  function _poll() {
    _lastCheck = _ts();
    _checkCount++;
    _checkAgents();
    _checkMacro();
    _checkEE();
    _checkGIICore();
    _checkScalper();
    _checkPortfolioQuality();
  }

  /* ── PUBLIC API ─────────────────────────────────────────────────────────── */
  window.GII_AGENT_MANAGER = {

    poll: _poll,

    /* Manager never emits trade signals — it's oversight only */
    signals: function () { return []; },

    healthReport: function () {
      return { agents: _health, lastCheck: _lastCheck, checkCount: _checkCount };
    },

    alerts: function () {
      return _alerts.filter(function (a) { return !a.resolved; });
    },

    alertLog: function () { return _alerts.slice(); },

    status: function () {
      var active = _alerts.filter(function (a) { return !a.resolved; });
      var errors = active.filter(function (a) { return a.severity === 'error'; }).length;
      var warns  = active.filter(function (a) { return a.severity === 'warn'; }).length;
      var agentSt = {};
      AGENT_NAMES.forEach(function (n) {
        agentSt[n] = (_health[n] || {}).status || 'unknown';
      });
      return {
        lastCheck:     _lastCheck,
        lastPoll:      _lastCheck,   // alias — gii-ui status panel reads lastPoll
        checkCount:    _checkCount,
        activeAlerts:  active.length,
        errors:        errors,
        warnings:      warns,
        agentStatuses: agentSt,
        overallHealth: errors > 0 ? 'error' : warns > 0 ? 'warn' : _checkCount > 0 ? 'ok' : 'pending'
      };
    }
  };

  /* ── INIT ───────────────────────────────────────────────────────────────── */
  window.addEventListener('load', function () {
    setTimeout(function () {
      _poll();
      setInterval(_poll, POLL_INTERVAL_MS);
      console.log('[GII-MANAGER] Health monitor online — checking every ' +
                  (POLL_INTERVAL_MS / 60000) + ' min');
    }, INIT_DELAY_MS);
  });

})();
