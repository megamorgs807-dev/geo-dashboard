/* GII Meta-Agent (Chief Intelligence Agent) — gii-meta.js v1
 * Supervisory coordination layer that monitors all GII agents.
 * Called by gii-core.js after signal collection each cycle.
 *
 * Responsibilities:
 *   - Detect consensus clusters (3+ agents agreeing on same region/bias)
 *   - Detect signal conflicts (agents disagree on direction for same region/asset)
 *   - Detect agent anomalies (silent agents, signal spikes, pattern breaks)
 *   - Produce overall coordination score and human-readable analysis
 *   - Feed conflict resolution metrics into analytics
 *
 * Does NOT emit trading signals — coordination and quality control only.
 * Exposes: window.GII_META
 */
(function () {
  'use strict';

  var CONSENSUS_THRESHOLD  = 3;  // agents needed for 'consensus'
  var CONFLICT_MIN_AGENTS  = 2;  // minimum agents on each side to flag conflict
  var ANOMALY_SILENCE_MS   = 300000; // 5 min — agent with no signals for 5 min is flagged

  var _lastReport = null;
  var _history    = [];  // rolling window of coordination scores
  var HISTORY_MAX = 20;

  // ── helpers ───────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── consensus detection ───────────────────────────────────────────────────

  function _findConsensusClusters(signals) {
    // Group by region + bias, count distinct agents
    var groups = {};
    signals.forEach(function (sig) {
      var region = (sig.region || 'GLOBAL').toUpperCase();
      var bias   = sig.bias || 'long';
      var key    = region + '::' + bias;
      if (!groups[key]) groups[key] = { region: region, bias: bias, agents: [], avgConf: 0 };
      var agentName = sig._agentName || sig.source || 'unknown';
      if (groups[key].agents.indexOf(agentName) === -1) {
        groups[key].agents.push(agentName);
      }
      groups[key].avgConf += (sig.confidence || 0);
    });

    // Normalise avgConf and filter to groups with enough agents
    var clusters = [];
    Object.keys(groups).forEach(function (key) {
      var g = groups[key];
      g.avgConf = g.agents.length > 0 ? _clamp(g.avgConf / g.agents.length, 0, 1) : 0;
      if (g.agents.length >= CONSENSUS_THRESHOLD) {
        clusters.push({
          region:    g.region,
          bias:      g.bias,
          agents:    g.agents,
          agentCount:g.agents.length,
          avgConf:   g.avgConf,
          strength:  g.agents.length >= 5 ? 'very strong' :
                     g.agents.length >= 4 ? 'strong' : 'moderate'
        });
      }
    });

    return clusters.sort(function (a, b) { return b.agentCount - a.agentCount; });
  }

  // ── conflict detection ────────────────────────────────────────────────────

  function _findConflicts(signals) {
    // Group by region + asset, split by bias
    var groups = {};
    signals.forEach(function (sig) {
      var region = (sig.region || 'GLOBAL').toUpperCase();
      var asset  = sig.asset || 'UNKNOWN';
      var key    = region + '::' + asset;
      if (!groups[key]) groups[key] = { region: region, asset: asset, long: [], short: [] };
      var agentName = sig._agentName || sig.source || 'unknown';
      if (sig.bias === 'short') {
        if (groups[key].short.indexOf(agentName) === -1) groups[key].short.push(agentName);
      } else {
        if (groups[key].long.indexOf(agentName) === -1) groups[key].long.push(agentName);
      }
    });

    var conflicts = [];
    Object.keys(groups).forEach(function (key) {
      var g = groups[key];
      if (g.long.length > 0 && g.short.length > 0) {
        var severity = (g.long.length >= CONFLICT_MIN_AGENTS && g.short.length >= CONFLICT_MIN_AGENTS)
          ? 'high' : 'low';
        conflicts.push({
          region:      g.region,
          asset:       g.asset,
          longAgents:  g.long,
          shortAgents: g.short,
          severity:    severity,
          msg:         g.long.length + ' agents LONG vs ' + g.short.length + ' agents SHORT on ' +
                       g.asset + ' [' + g.region + ']'
        });
      }
    });

    return conflicts.sort(function (a, b) {
      var sev = { high: 2, low: 1 };
      return (sev[b.severity] || 0) - (sev[a.severity] || 0);
    });
  }

  // ── anomaly detection ─────────────────────────────────────────────────────

  function _findAnomalies(signals) {
    var anomalies = [];
    var agentNames = [];

    // Determine list of known agents
    if (window.GII && typeof window.GII.status === 'function') {
      try {
        // We can't easily enumerate AGENTS from here, so check known globals
        var known = [
          'GII_AGENT_ENERGY','GII_AGENT_CONFLICT','GII_AGENT_MACRO','GII_AGENT_SANCTIONS',
          'GII_AGENT_MARITIME','GII_AGENT_SOCIAL','GII_AGENT_POLYMARKET','GII_AGENT_REGIME',
          'GII_AGENT_SATELLITE','GII_AGENT_HISTORICAL','GII_AGENT_LIQUIDITY','GII_AGENT_CALENDAR',
          'GII_AGENT_CHOKEPOINT','GII_AGENT_NARRATIVE','GII_AGENT_ESCALATION',
          'GII_AGENT_SCENARIO','GII_AGENT_TECHNICALS'
        ];
        var now = Date.now();
        known.forEach(function (globalName) {
          var agent = window[globalName];
          if (!agent) return;
          var name = globalName.replace('GII_AGENT_', '').toLowerCase();
          agentNames.push(name);

          try {
            var st = agent.status();
            // Check for silence
            if (st && st.lastPoll && (now - st.lastPoll) > ANOMALY_SILENCE_MS) {
              anomalies.push({
                agent: name,
                type:  'stale',
                msg:   name + ' last polled ' + Math.round((now - st.lastPoll) / 60000) + 'min ago'
              });
            }
            // Check for zero signals from this agent in current batch
            var agentSigs = signals.filter(function (s) {
              return (s._agentName || s.source) === name;
            });
            if (agentSigs.length === 0 && st.lastPoll && (now - st.lastPoll) < 120000) {
              // Polled recently but produced nothing — may be normal, note as info
              anomalies.push({
                agent: name,
                type:  'silent',
                msg:   name + ' produced 0 signals this cycle (normal if no matching events)'
              });
            }
          } catch (e) {}
        });
      } catch (e) {}
    }

    return anomalies;
  }

  // ── coordination score ────────────────────────────────────────────────────

  function _computeCoordinationScore(signals, clusters, conflicts, anomalies) {
    if (!signals.length) return 0;

    // Base: ratio of signals in consensus clusters
    var clusterSignalCount = clusters.reduce(function (n, c) { return n + c.agentCount; }, 0);
    var agentsWithSignals  = [];
    signals.forEach(function (s) {
      var a = s._agentName || s.source;
      if (a && agentsWithSignals.indexOf(a) === -1) agentsWithSignals.push(a);
    });
    var totalAgents = agentsWithSignals.length || 1;

    var consensusRatio = _clamp(clusterSignalCount / (totalAgents * 2), 0, 1);

    // Penalty for high-severity conflicts
    var highConflicts = conflicts.filter(function (c) { return c.severity === 'high'; }).length;
    var conflictPenalty = _clamp(highConflicts * 0.08, 0, 0.30);

    // Penalty for stale agents
    var staleCount = anomalies.filter(function (a) { return a.type === 'stale'; }).length;
    var stalePenalty = _clamp(staleCount * 0.05, 0, 0.20);

    var score = _clamp(0.50 + consensusRatio * 0.40 - conflictPenalty - stalePenalty, 0, 1.0);
    return Math.round(score * 100) / 100;
  }

  // ── narrative summary ─────────────────────────────────────────────────────

  function _buildNarrative(clusters, conflicts, coordinationScore) {
    var parts = [];

    if (clusters.length) {
      var top = clusters[0];
      parts.push(top.agentCount + ' agents converge on ' + top.region + ' ' + top.bias.toUpperCase() +
                 ' (avg conf ' + (top.avgConf * 100).toFixed(0) + '%)');
    }

    var highConflicts = conflicts.filter(function (c) { return c.severity === 'high'; });
    if (highConflicts.length) {
      parts.push(highConflicts.length + ' high-severity conflict(s) detected: ' +
                 highConflicts.map(function (c) { return c.asset + '[' + c.region + ']'; }).join(', '));
    }

    if (coordinationScore >= 0.80) parts.push('System coordination: EXCELLENT');
    else if (coordinationScore >= 0.65) parts.push('System coordination: GOOD');
    else if (coordinationScore >= 0.50) parts.push('System coordination: MODERATE');
    else parts.push('System coordination: LOW — review agent outputs');

    return parts.join(' | ') || 'Insufficient signals for coordination analysis.';
  }

  // ── public coordinate() ───────────────────────────────────────────────────

  function coordinate(allSignals) {
    var signals = allSignals || [];

    var clusters          = _findConsensusClusters(signals);
    var conflicts         = _findConflicts(signals);
    var anomalies         = _findAnomalies(signals);
    var coordinationScore = _computeCoordinationScore(signals, clusters, conflicts, anomalies);
    var narrative         = _buildNarrative(clusters, conflicts, coordinationScore);

    _lastReport = {
      source:            'chief_intelligence_agent',
      timestamp:         Date.now(),
      totalSignals:      signals.length,
      activeAgents:      (function () {
        var a = [];
        signals.forEach(function (s) {
          var n = s._agentName || s.source;
          if (n && a.indexOf(n) === -1) a.push(n);
        });
        return a.length;
      })(),
      consensusClusters: clusters,
      conflicts:         conflicts,
      anomalies:         anomalies,
      coordinationScore: coordinationScore,
      analysis:          narrative,
      recommendation:    clusters.length
        ? 'Increase probability weight for consensus signals in: ' +
          clusters.slice(0, 3).map(function (c) { return c.region; }).join(', ')
        : 'No consensus detected — apply standard Bayesian weighting.'
    };

    // Log high-severity conflicts to console for visibility
    conflicts.forEach(function (c) {
      if (c.severity === 'high') {
        console.warn('[GII META] Signal conflict on ' + c.asset + ' [' + c.region + ']: ' + c.msg);
      }
    });

    // Track history
    _history.push({ ts: _lastReport.timestamp, score: coordinationScore, clusters: clusters.length });
    if (_history.length > HISTORY_MAX) _history.shift();

    return _lastReport;
  }

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_META = {
    coordinate:  coordinate,
    status:      function () { return _lastReport ? Object.assign({}, _lastReport) : null; },
    conflicts:   function () { return _lastReport ? _lastReport.conflicts.slice() : []; },
    consensus:   function () { return _lastReport ? _lastReport.consensusClusters.slice() : []; },
    history:     function () { return _history.slice(); }
  };

})();
