/* GII Polymarket Agent — gii-polymarket.js v1
 * Detects prediction market mispricing + position sizing
 * Reads: window.PM.events(), .markets(), .stEvents()
 * Exposes: window.GII_AGENT_POLYMARKET
 */
(function () {
  'use strict';

  var MAX_SIGNALS = 20;
  var POLL_INTERVAL = 73000;

  var EDGE_LOG_ONLY    = 0.05;   // 5% edge — log only, no signal
  var EDGE_TRADE       = 0.12;   // 12%+ edge — emit tradeable signal
  var CONF_MULTIPLIER  = 3.5;    // maps edge to confidence
  var MAX_CONF         = 0.90;
  var BASE_RATE        = 0.30;   // default AI probability if no IC data
  var BANKROLL_FRAC    = 0.10;   // fraction of bankroll per trade

  var _signals = [];
  var _mispricings = []; // full log including sub-threshold
  var _status = {
    lastPoll: null,
    marketsChecked: 0,
    tradeableEdges: 0,
    logOnlyEdges: 0,
    avgEdge: null
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  // ── helpers ────────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  // ── get AI probability ─────────────────────────────────────────────────────

  function _getAIProb(region, asset) {
    // Priority: GII posterior → IC regionState → base rate
    if (window.GII && typeof window.GII.posterior === 'function') {
      try {
        var p = window.GII.posterior(region);
        if (p && typeof p.posterior === 'number') return _clamp(p.posterior, 0.05, 0.95);
      } catch (e) {}
    }
    var IC = window.__IC;
    if (IC && IC.regionStates) {
      // Try direct match
      if (IC.regionStates[region] && IC.regionStates[region].prob !== undefined) {
        return _clamp(IC.regionStates[region].prob / 100, 0.05, 0.95);
      }
      // Fuzzy match
      var rUp = (region || '').toUpperCase();
      for (var r in IC.regionStates) {
        if (r.indexOf(rUp) !== -1 || rUp.indexOf(r) !== -1) {
          return _clamp((IC.regionStates[r].prob || 0) / 100, 0.05, 0.95);
        }
      }
    }
    return BASE_RATE;
  }

  // ── analysis ───────────────────────────────────────────────────────────────

  function _analyseMarkets() {
    var PM = window.PM;
    if (!PM) return;

    var allMarkets = [];
    try {
      if (typeof PM.events === 'function') allMarkets = allMarkets.concat(PM.events() || []);
    } catch (e) {}
    try {
      if (typeof PM.markets === 'function') allMarkets = allMarkets.concat(PM.markets() || []);
    } catch (e) {}
    try {
      if (typeof PM.stEvents === 'function') allMarkets = allMarkets.concat(PM.stEvents() || []);
    } catch (e) {}

    _status.marketsChecked = allMarkets.length;
    if (!allMarkets.length) return;

    _mispricings = [];
    var tradeableCount = 0;
    var logCount = 0;
    var edgeSum = 0;
    var edgeCount = 0;

    allMarkets.forEach(function (mkt) {
      // Extract PM YES probability
      var pmYesProb = null;
      if (mkt.pmYesProb !== undefined) pmYesProb = parseFloat(mkt.pmYesProb);
      else if (mkt.yes_prob !== undefined) pmYesProb = parseFloat(mkt.yes_prob);
      else if (mkt.probability !== undefined) pmYesProb = parseFloat(mkt.probability);
      else if (mkt.price !== undefined) pmYesProb = parseFloat(mkt.price);

      if (pmYesProb === null || isNaN(pmYesProb)) return;
      if (pmYesProb <= 0 || pmYesProb >= 1) return;

      var region = mkt.region || mkt.geoRegion || 'GLOBAL';
      var asset  = mkt.asset || mkt.ticker || 'GLD';
      var label  = mkt.question || mkt.label || mkt.title || mkt.event || '';

      // Model confidence — use IC event signal as proxy
      var modelConf = 0.65; // base
      var IC = window.__IC;
      if (IC && IC.regionStates && IC.regionStates[region]) {
        var rs = IC.regionStates[region];
        modelConf = _clamp(0.50 + (rs.signalCount || 0) * 0.03, 0.50, 0.90);
      }

      var aiProb = _getAIProb(region, asset);
      var edge = aiProb - pmYesProb;
      var absEdge = Math.abs(edge);

      edgeSum += absEdge;
      edgeCount++;

      var mispricing = {
        region: region,
        asset: asset,
        label: label.substring(0, 80),
        aiProb: aiProb,
        pmYesProb: pmYesProb,
        edge: edge,
        absEdge: absEdge,
        modelConf: modelConf,
        tradeable: false,
        suggestedSizeFraction: 0
      };

      if (absEdge < EDGE_LOG_ONLY) {
        // No action
      } else if (absEdge < EDGE_TRADE) {
        // Log only
        logCount++;
        mispricing.logOnly = true;
      } else {
        // Tradeable
        tradeableCount++;
        mispricing.tradeable = true;
        var conf = _clamp(absEdge * CONF_MULTIPLIER * modelConf, 0.30, MAX_CONF);
        mispricing.conf = conf;
        mispricing.suggestedSizeFraction = edge * modelConf * BANKROLL_FRAC;

        _pushSignal({
          source: 'polymarket',
          asset: asset,
          bias: edge > 0 ? 'long' : 'short',
          confidence: conf,
          reasoning: 'PM mispricing: AI ' + (aiProb * 100).toFixed(0) + '% vs PM ' +
            (pmYesProb * 100).toFixed(0) + '% | edge ' + (edge > 0 ? '+' : '') + (edge * 100).toFixed(1) + '% | ' +
            label.substring(0, 50),
          region: region,
          evidenceKeys: ['polymarket', 'mispricing', 'prediction market'],
          pmEdge: edge,
          modelConf: modelConf,
          suggestedSizeFraction: mispricing.suggestedSizeFraction
        });
      }

      _mispricings.push(mispricing);
    });

    _status.tradeableEdges = tradeableCount;
    _status.logOnlyEdges = logCount;
    _status.avgEdge = edgeCount > 0 ? edgeSum / edgeCount : null;
  }

  // ── public poll ────────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    if (!window.PM) {
      _status.pmWarning = 'window.PM unavailable — polymarket.js not yet loaded';
      console.warn('[GII-PM] window.PM not found. Ensure polymarket.js is loaded before gii-polymarket.js.');
      return;
    }
    _status.pmWarning = null;
    _analyseMarkets();
  }

  // ── trade result feedback ───────────────────────────────────────────────────

  function onTradeResult(trade) {
    var asset = (trade.asset || '').toUpperCase();
    var dir   = (trade.dir  || '').toLowerCase();
    if (!asset || !dir) return;
    _accuracy.total += 1;
    if ((trade.pnl_usd || 0) > 0) _accuracy.correct += 1;
    _accuracy.winRate = _accuracy.total > 0 ? _accuracy.correct / _accuracy.total : null;
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII_AGENT_POLYMARKET = {
    poll:          poll,
    signals:       function () { return _signals.slice(); },
    status:        function () { return Object.assign({}, _status); },
    accuracy:      function () { return Object.assign({}, _accuracy); },
    onTradeResult: onTradeResult,
    mispricings:   function () { return _mispricings.slice(); }
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 7200);
  });

})();
