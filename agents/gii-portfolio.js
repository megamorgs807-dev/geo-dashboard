/**
 * GII Portfolio Agent — gii-portfolio.js
 *
 * The "head of trading" agent. Every 3 minutes it proactively scans ALL GII
 * agents to find the highest-conviction opportunities available RIGHT NOW,
 * then ensures the open portfolio always holds the best possible set of trades.
 *
 * KEY DIFFERENCE from gii-entry (reactive):
 *   gii-entry waits for new signals to arrive, then decides if they're worth trading.
 *   gii-portfolio proactively polls every agent every 3 min, ranks ALL possible
 *   trades regardless of signal flow, and rotates out weak positions for stronger ones.
 *
 * Flow each cycle:
 *   1. Collect all current signals from every GII agent
 *   2. Group by asset + direction → calculate multi-agent conviction score
 *   3. Apply regime/macro filters (don't fight CRISIS/RISK_OFF)
 *   4. Build ranked watchlist of top candidates (max 20)
 *   5. Compare open portfolio vs watchlist
 *   6. If weakest open trade scores significantly lower than top watchlist candidate → rotate
 *   7. Expose watchlist + decisions for dashboard display
 *
 * Exposes: window.GII_AGENT_PORTFOLIO
 */
(function () {
  'use strict';

  /* ── CONFIG ──────────────────────────────────────────────────────────────── */
  var POLL_MS        = 3 * 60 * 1000;   // scan every 3 minutes
  var INIT_DELAY_MS  = 25 * 1000;       // wait for all agents to boot
  var ROTATION_DELTA = 0.35;            // candidate must beat weakest open by 35% to rotate
  var MIN_AGENTS     = 2;               // minimum agents agreeing to consider a candidate
  var MIN_SCORE      = 1.5;             // minimum raw score to appear on watchlist
  var MAX_WATCHLIST  = 20;             // top N candidates to track
  var MAX_LOG        = 50;             // rotation decisions log size

  /* All GII agents that produce signals with asset+bias */
  var SIGNAL_AGENTS = [
    'GII_AGENT_ENERGY',
    'GII_AGENT_CONFLICT',
    'GII_AGENT_MACRO',
    'GII_AGENT_SANCTIONS',
    'GII_AGENT_MARITIME',
    'GII_AGENT_SOCIAL',
    'GII_AGENT_POLYMARKET',
    'GII_AGENT_REGIME',
    'GII_AGENT_DEESCALATION',
    'GII_AGENT_RISK',
    'GII_AGENT_OPTIMIZER',
    'GII_AGENT_LIQUIDITY',
    'GII_AGENT_SMARTMONEY',
    'GII_AGENT_MARKETSTRUCTURE'
  ];

  /* Agent category weights — higher weight = stronger signal when they agree */
  var AGENT_WEIGHTS = {
    'GII_AGENT_ENERGY':        1.2,   // direct commodity expertise
    'GII_AGENT_CONFLICT':      1.2,   // direct geopolitical expertise
    'GII_AGENT_MACRO':         1.3,   // macro regime — highest weight
    'GII_AGENT_SANCTIONS':     1.0,
    'GII_AGENT_MARITIME':      0.9,
    'GII_AGENT_SOCIAL':        0.8,   // sentiment — lower weight
    'GII_AGENT_POLYMARKET':    1.2,   // real money probability signal
    'GII_AGENT_REGIME':        1.1,
    'GII_AGENT_DEESCALATION':  1.0,
    'GII_AGENT_RISK':          1.1,
    'GII_AGENT_OPTIMIZER':     1.3,   // triple-confirm amplification
    'GII_AGENT_LIQUIDITY':     0.9,
    'GII_AGENT_SMARTMONEY':    1.2,   // institutional flow
    'GII_AGENT_MARKETSTRUCTURE': 1.1
  };

  /* Assets currently tradeable on Hyperliquid — the universe we consider */
  var HL_UNIVERSE = [
    /* Crypto perps */
    'BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA',
    /* Commodities */
    'WTI', 'BRENT', 'GAS',
    /* Precious */
    'GLD', 'SLV', 'XAU',
    /* Equities & ETFs */
    'TSLA', 'SPY', 'QQQ', 'AAPL', 'AMZN', 'META', 'MSFT', 'GOOGL',
    'NVDA', 'HOOD', 'CRCL',
    /* Volatility */
    'VXX',
    /* Safe haven / macro */
    'TLT', 'JPY', 'CHF'
  ];

  /* ── STATE ───────────────────────────────────────────────────────────────── */
  var _watchlist   = [];   // ranked candidate list [{asset, dir, score, agents, reason}]
  var _rotations   = [];   // log of rotation decisions
  var _lastPoll    = 0;
  var _pollCount   = 0;
  var _stats       = { scanned: 0, rotated: 0, skipped: 0, candidates: 0 };

  /* ── HELPERS ─────────────────────────────────────────────────────────────── */
  function _log(msg) { console.log('[GII-PORTFOLIO] ' + msg); }

  /* Get current regime from macro agent — used to veto risky longs in crisis */
  function _getRegime() {
    try {
      if (window.GII_AGENT_MACRO) {
        var st = GII_AGENT_MACRO.status();
        return { regime: st.regime || 'NORMAL', riskMode: st.riskMode || 'RISK_ON', vix: st.vix || 0 };
      }
    } catch (e) {}
    return { regime: 'NORMAL', riskMode: 'RISK_ON', vix: 0 };
  }

  /* Score proxy for an open trade — same as gii-entry for consistency */
  function _openTradeScore(trade) {
    return (trade.thesis && trade.thesis.confluenceScore)
      ? trade.thesis.confluenceScore
      : (trade.confidence || 50) / 15;
  }

  /* ── STEP 1: COLLECT ALL AGENT SIGNALS ──────────────────────────────────── */
  function _collectSignals() {
    var collected = {};  // { 'BTC_long': { asset, dir, totalScore, agentCount, agentNames, reasons } }

    SIGNAL_AGENTS.forEach(function (agentName) {
      var agent = window[agentName];
      if (!agent || typeof agent.signals !== 'function') return;

      var weight = AGENT_WEIGHTS[agentName] || 1.0;
      var sigs = [];
      try { sigs = agent.signals() || []; } catch (e) { return; }

      sigs.forEach(function (sig) {
        if (!sig || !sig.asset || !sig.bias) return;

        /* Only consider HL-universe assets */
        var asset = (sig.asset || '').toUpperCase();
        if (HL_UNIVERSE.indexOf(asset) === -1) return;

        var dir = sig.bias === 'short' ? 'SHORT' : 'LONG';
        var key = asset + '_' + dir;

        if (!collected[key]) {
          collected[key] = {
            asset:      asset,
            dir:        dir,
            totalScore: 0,
            agentCount: 0,
            agentNames: [],
            reasons:    [],
            maxConf:    0
          };
        }

        var conf = isFinite(sig.confidence) ? +sig.confidence : 0.5;
        collected[key].totalScore  += conf * weight;
        collected[key].agentCount  += 1;
        collected[key].agentNames.push(agentName.replace('GII_AGENT_', '').toLowerCase());
        if (sig.reasoning) collected[key].reasons.push(sig.reasoning.substring(0, 60));
        if (conf > collected[key].maxConf) collected[key].maxConf = conf;
      });
    });

    return collected;
  }

  /* ── STEP 2: SCORE + FILTER CANDIDATES ──────────────────────────────────── */
  function _buildCandidates(collected, regime) {
    var candidates = [];

    Object.keys(collected).forEach(function (key) {
      var c = collected[key];

      /* Need at least MIN_AGENTS agreeing */
      if (c.agentCount < MIN_AGENTS) return;

      /* Final score: weighted sum * agent count bonus */
      var score = c.totalScore * (1 + (c.agentCount - MIN_AGENTS) * 0.15);
      if (score < MIN_SCORE) return;

      /* Regime veto: CRISIS/RISK_OFF → no risk-asset longs */
      var riskAssets = ['BTC', 'ETH', 'SOL', 'TSLA', 'NVDA', 'SPY', 'QQQ'];
      if (c.dir === 'LONG' &&
          (regime.regime === 'CRISIS' || regime.riskMode === 'RISK_OFF') &&
          riskAssets.indexOf(c.asset) !== -1) {
        return;
      }

      /* VIX veto: don't go short volatility if VIX > 30 */
      if (c.asset === 'VXX' && c.dir === 'SHORT' && regime.vix > 30) return;

      candidates.push({
        asset:      c.asset,
        dir:        c.dir,
        score:      +score.toFixed(2),
        agentCount: c.agentCount,
        agents:     c.agentNames.slice(0, 5),
        reason:     c.reasons[0] || (c.agentCount + ' agents agree'),
        maxConf:    +(c.maxConf * 100).toFixed(0)
      });
    });

    /* Sort by score descending */
    return candidates.sort(function (a, b) { return b.score - a.score; }).slice(0, MAX_WATCHLIST);
  }

  /* ── STEP 3: COMPARE PORTFOLIO vs WATCHLIST ──────────────────────────────── */
  function _rebalance(candidates) {
    if (!window.EE || typeof EE.getOpenTrades !== 'function') return;

    var open   = EE.getOpenTrades();
    var cfg    = EE.getConfig ? EE.getConfig() : {};
    var maxSlots = cfg.max_open_trades || 8;

    if (!open.length || !candidates.length) return;

    /* Score every open trade */
    var scoredOpen = open.map(function (t) {
      return { trade: t, score: _openTradeScore(t) };
    }).sort(function (a, b) { return a.score - b.score });   // weakest first

    var weakest = scoredOpen[0];
    if (!weakest) return;

    /* Best candidate not already in portfolio */
    var openAssets = open.map(function (t) { return t.asset; });
    var topCandidate = null;
    for (var i = 0; i < candidates.length; i++) {
      if (openAssets.indexOf(candidates[i].asset) === -1) {
        topCandidate = candidates[i];
        break;
      }
    }
    if (!topCandidate) return;

    /* Only rotate if slots are at least 75% full AND candidate beats weakest by ROTATION_DELTA */
    var slotUsage = open.length / maxSlots;
    if (slotUsage < 0.75) return;

    var weakScore = weakest.score;
    var candScore = topCandidate.score;
    var relDelta  = weakScore > 0 ? (candScore - weakScore) / weakScore : 1;

    if (relDelta >= ROTATION_DELTA) {
      var reason = 'PORTFOLIO: ' + topCandidate.asset + '(score ' + candScore.toFixed(2) +
                   ') beats ' + weakest.trade.asset + '(score ' + weakScore.toFixed(2) +
                   ') by ' + Math.round(relDelta * 100) + '%';

      _log('Rotating: close ' + weakest.trade.asset + ' → open slot for ' + topCandidate.asset);

      try {
        EE.forceCloseTrade(weakest.trade.trade_id, reason);
        _stats.rotated++;
        _rotations.unshift({
          ts:        Date.now(),
          closed:    weakest.trade.asset + ' ' + weakest.trade.direction,
          closedScore: +weakScore.toFixed(2),
          opened:    topCandidate.asset + ' ' + topCandidate.dir,
          openScore: +candScore.toFixed(2),
          delta:     Math.round(relDelta * 100) + '%',
          reason:    topCandidate.reason
        });
        if (_rotations.length > MAX_LOG) _rotations.pop();
      } catch (e) {}
    } else {
      _stats.skipped++;
    }
  }

  /* ── MAIN POLL ───────────────────────────────────────────────────────────── */
  function _poll() {
    _lastPoll  = Date.now();
    _pollCount++;

    var regime     = _getRegime();
    var collected  = _collectSignals();
    var candidates = _buildCandidates(collected, regime);

    _watchlist = candidates;
    _stats.scanned    = Object.keys(collected).length;
    _stats.candidates = candidates.length;

    _log('Cycle ' + _pollCount + ': ' + _stats.scanned + ' combos scanned → ' +
         candidates.length + ' candidates | top: ' +
         (candidates[0] ? candidates[0].asset + ' ' + candidates[0].dir + ' (' + candidates[0].score + ')' : 'none'));

    _rebalance(candidates);
  }

  /* ── BOOT ────────────────────────────────────────────────────────────────── */
  setTimeout(function () {
    _poll();
    setInterval(_poll, POLL_MS);
    _log('Portfolio selection agent online — ranking ' + HL_UNIVERSE.length + ' assets every 3min');
  }, INIT_DELAY_MS);

  /* ── PUBLIC API ──────────────────────────────────────────────────────────── */
  window.GII_AGENT_PORTFOLIO = {

    poll: _poll,

    /* Top-ranked candidates right now */
    watchlist: function () { return _watchlist.slice(); },

    /* Recent rotation decisions */
    rotations: function () { return _rotations.slice(0, 20); },

    status: function () {
      return {
        lastPoll:   _lastPoll,
        pollCount:  _pollCount,
        stats:      _stats,
        topTrades:  _watchlist.slice(0, 5),
        recentRotations: _rotations.slice(0, 5)
      };
    },

    signals: function () {
      /* Expose top candidates as signals so gii-entry can also consider them */
      return _watchlist.map(function (c) {
        return {
          asset:      c.asset,
          bias:       c.dir.toLowerCase(),
          confidence: Math.min(0.95, c.score / 10),
          source:     'portfolio',
          reasoning:  'Portfolio rank #' + (_watchlist.indexOf(c) + 1) + ': ' + c.reason
        };
      });
    }
  };

})();
