/* GII Trade Optimizer Agent — gii-optimizer.js v1
 *
 * Meta-layer that enhances signal quality using three modules:
 *
 *   1. Enhanced PM Edge Detection
 *      Compares full GII Bayesian posterior vs Polymarket YES price.
 *      Uses all 17+ agents' posteriors rather than raw IC.regionStates.
 *
 *   2. Hyperliquid Funding Rate Alpha
 *      Reads live BTC (and other perp) funding rates from the Hyperliquid
 *      public API (no key, CORS-accessible).
 *      High positive funding → crowd is overly long → SHORT signal.
 *      Deeply negative funding → short squeeze risk → LONG signal.
 *
 *   3. Triple-Confirm Amplification
 *      When technical analysis + polymarket + macro agents all agree
 *      on the same asset/direction, emit a high-confidence amplified signal.
 *
 * Poll interval: 90s (funding rates update every 8h but we check often)
 * Exposes: window.GII_AGENT_OPTIMIZER
 */
(function () {
  'use strict';

  // ── constants ─────────────────────────────────────────────────────────────

  var POLL_INTERVAL_MS = 90 * 1000;    // 90 seconds
  var INIT_DELAY_MS    = 17500;        // after gii-scalper (16.5s) + buffer
  var HL_INFO          = 'https://api.hyperliquid.xyz/info';
  var PM_EDGE_FLOOR    = 0.08;         // minimum |edge| to act on
  var PM_EDGE_STRONG   = 0.18;         // strong edge threshold
  var FUNDING_LONG_TRIG  = -0.0001;   // < -0.01%/8h → short squeeze risk
  var FUNDING_SHORT_TRIG =  0.0003;   // > +0.03%/8h → crowd overly long
  var FEEDBACK_KEY       = 'gii_optimizer_feedback_v1';

  // Region → Polymarket keyword matching
  var REGION_PM_MAP = {
    'IRAN':              ['iran', 'persian', 'hormuz', 'irgc'],
    'STRAIT OF HORMUZ':  ['hormuz', 'strait', 'iran'],
    'RUSSIA':            ['russia', 'ukraine', 'putin', 'nato'],
    'UKRAINE':           ['ukraine', 'russia', 'zelensky', 'nato'],
    'TAIWAN':            ['taiwan', 'china', 'invasion', 'pla'],
    'CHINA':             ['china', 'taiwan', 'xi', 'trade war'],
    'NORTH KOREA':       ['north korea', 'dprk', 'kim', 'missile'],
    'MIDDLE EAST':       ['middle east', 'israel', 'gaza', 'iran', 'hamas'],
    'RED SEA':           ['red sea', 'houthi', 'yemen', 'bab-el-mandeb']
  };

  // Region escalation → affected assets
  var REGION_ASSETS = {
    'IRAN':             [{ asset: 'WTI',   bias: 'long' }, { asset: 'GLD', bias: 'long' }],
    'STRAIT OF HORMUZ': [{ asset: 'WTI',   bias: 'long' }, { asset: 'BRENT', bias: 'long' }],
    'RUSSIA':           [{ asset: 'GLD',   bias: 'long' }, { asset: 'SPY', bias: 'short' }],
    'UKRAINE':          [{ asset: 'WTI',   bias: 'long' }, { asset: 'GLD', bias: 'long' }],
    'TAIWAN':           [{ asset: 'TSM',   bias: 'short' }, { asset: 'SMH', bias: 'short' }],
    'CHINA':            [{ asset: 'TSM',   bias: 'short' }, { asset: 'SPY', bias: 'short' }],
    'NORTH KOREA':      [{ asset: 'GLD',   bias: 'long' }, { asset: 'TLT', bias: 'long' }],
    'MIDDLE EAST':      [{ asset: 'WTI',   bias: 'long' }, { asset: 'GLD', bias: 'long' }],
    'RED SEA':          [{ asset: 'BRENT', bias: 'long' }, { asset: 'WTI', bias: 'long' }]
  };

  // Agents counted as "macro-level" for triple-confirm
  var MACRO_SOURCES = ['macro', 'energy', 'conflict', 'sanctions', 'maritime', 'regime'];

  // ── private state ─────────────────────────────────────────────────────────

  var _signals    = [];
  var _status     = {};
  var _funding    = {};    // { 'BTC': { rate8h, annualized, markPx }, ... }
  var _pmEdges    = [];    // latest detected edges (for UI)
  var _lastPollTs = 0;
  var _feedback   = {};    // { 'BTC_long': { total, correct, winRate, lastTs } }
  var _accuracy   = {};    // mirror of _feedback for public API

  // ── helpers ───────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function _round2(v) { return Math.round(v * 100) / 100; }

  function _objValues(obj) {
    return Object.keys(obj).map(function (k) { return obj[k]; });
  }

  function _loadFeedback() {
    try { var r = localStorage.getItem(FEEDBACK_KEY); _feedback = r ? JSON.parse(r) : {}; } catch (e) {}
    _accuracy = Object.assign({}, _feedback);
  }

  function _saveFeedback() {
    try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(_feedback)); } catch (e) {}
  }

  function onTradeResult(trade) {
    var asset = (trade.asset || '').toUpperCase();
    var dir   = (trade.dir  || '').toLowerCase();
    if (!asset || !dir) return;
    var fbKey = asset + '_' + dir;
    if (!_feedback[fbKey]) _feedback[fbKey] = { total: 0, correct: 0, winRate: null, lastTs: null };
    _feedback[fbKey].total  += 1;
    if ((trade.pnl_usd || 0) > 0) _feedback[fbKey].correct += 1;
    _feedback[fbKey].winRate = _feedback[fbKey].correct / _feedback[fbKey].total;
    _feedback[fbKey].lastTs  = new Date().toISOString();
    _accuracy = Object.assign({}, _feedback);
    _saveFeedback();
  }

  // ── Module 1: Hyperliquid funding rates ───────────────────────────────────

  function _fetchFunding() {
    return fetch(HL_INFO, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'metaAndAssetCtxs' })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // Response: [meta, assetCtxs]
        // meta.universe[i].name  corresponds to  assetCtxs[i].funding
        if (!Array.isArray(data) || data.length < 2) return null;
        var universe = (data[0] && Array.isArray(data[0].universe)) ? data[0].universe : [];
        var ctxs     = Array.isArray(data[1]) ? data[1] : [];
        var result   = {};
        universe.forEach(function (u, i) {
          var name = (u.name || '').toUpperCase();
          if (!name) return;
          var ctx = ctxs[i] || {};
          if (ctx.funding !== undefined) {
            var rate8h = parseFloat(ctx.funding) || 0;
            result[name] = {
              rate8h:     rate8h,
              annualized: rate8h * 3 * 365,
              markPx:     parseFloat(ctx.markPx) || 0,
              openInterest: parseFloat(ctx.openInterest) || 0
            };
          }
        });
        return result;
      })
      .catch(function () { return null; });
  }

  function _fundingSignals(fundingMap) {
    if (!fundingMap) return [];
    var sigs = [];

    // Focus on BTC; could extend to ETH etc. later
    var targets = ['BTC', 'ETH'];
    targets.forEach(function (coin) {
      var f = fundingMap[coin];
      if (!f) return;
      var rate = f.rate8h;

      if (rate > FUNDING_SHORT_TRIG) {
        // Crowd too long → reversion risk → short
        var conf = _clamp(0.48 + (rate - FUNDING_SHORT_TRIG) * 600, 0, 0.78);
        sigs.push({
          source:       'optimizer',
          asset:        coin,
          bias:         'short',
          confidence:   _round2(conf),
          reasoning:    'HL funding +' + (rate * 100).toFixed(4) + '%/8h — perma-longs paying premium',
          timestamp:    Date.now(),
          region:       'GLOBAL',
          evidenceKeys: ['funding_rate', 'crowd_long', 'hl_perp'],
          optimizer:    true,
          fundingRate:  rate
        });
      } else if (rate < FUNDING_LONG_TRIG) {
        // Crowd too short → squeeze risk → long
        var conf2 = _clamp(0.42 + (-rate - (-FUNDING_LONG_TRIG)) * 800, 0, 0.72);
        sigs.push({
          source:       'optimizer',
          asset:        coin,
          bias:         'long',
          confidence:   _round2(conf2),
          reasoning:    'HL funding ' + (rate * 100).toFixed(4) + '%/8h — shorts paying, squeeze risk',
          timestamp:    Date.now(),
          region:       'GLOBAL',
          evidenceKeys: ['funding_rate', 'short_squeeze', 'hl_perp'],
          optimizer:    true,
          fundingRate:  rate
        });
      }
    });

    return sigs;
  }

  // ── Module 2: Enhanced PM edge detection ─────────────────────────────────
  // Uses full GII Bayesian posterior (all 17+ agents) vs Polymarket YES price.

  function _pmEdgeDetection() {
    if (!window.PM || typeof PM.events !== 'function') return [];
    var pmEvents = [];
    try { pmEvents = PM.events() || []; } catch (e) { return []; }
    if (!pmEvents.length) return [];

    var newSigs = [];
    _pmEdges = [];

    pmEvents.forEach(function (ev) {
      var evText = [ev.title || '', ev.desc || '', ev.region || ''].join(' ').toLowerCase();

      // Match to a GII region
      var matchRegion = null;
      var maxMatches = 0;
      Object.keys(REGION_PM_MAP).forEach(function (region) {
        if (matchRegion && maxMatches >= 2) return;
        var kws = REGION_PM_MAP[region];
        var hits = kws.filter(function (kw) { return evText.indexOf(kw) !== -1; }).length;
        if (hits > maxMatches) { maxMatches = hits; matchRegion = region; }
      });
      if (!matchRegion) return;

      // Get the best available GII posterior for this region
      var giiProb = 0.25;  // conservative base rate
      try {
        if (window.GII && typeof GII.posterior === 'function') {
          var post = GII.posterior(matchRegion);
          if (post && typeof post.posterior === 'number') giiProb = post.posterior;
        } else if (window.__IC && window.__IC.regionStates && window.__IC.regionStates[matchRegion]) {
          giiProb = _clamp((window.__IC.regionStates[matchRegion].prob || 25) / 100, 0, 1);
        }
      } catch (e) {}

      // Get PM YES probability (normalise from 0-100 or 0-1)
      var pmProb = ev.yesPrice || ev.yesProb || ev.prob || 0.5;
      if (pmProb > 1) pmProb = pmProb / 100;
      pmProb = _clamp(pmProb, 0.01, 0.99);

      var edge    = giiProb - pmProb;
      var absEdge = Math.abs(edge);

      _pmEdges.push({
        region:  matchRegion,
        title:   ev.title || '(no title)',
        giiProb: _round2(giiProb),
        pmProb:  _round2(pmProb),
        edge:    _round2(edge)
      });

      if (absEdge < PM_EDGE_FLOOR) return;

      // Assets affected by escalation in this region
      var assets = REGION_ASSETS[matchRegion];
      if (!assets || !assets.length) assets = [{ asset: 'GLD', bias: 'long' }];
      var primary = assets[0];

      // If GII says higher probability than PM → escalation underpriced → long risk assets
      // If GII says lower → PM is pricing in too much risk → short signal
      var assetBias = edge > 0 ? primary.bias : (primary.bias === 'long' ? 'short' : 'long');

      var conf = _clamp(absEdge * 4.2 * (absEdge >= PM_EDGE_STRONG ? 1.20 : 1.0), 0, 0.87);

      newSigs.push({
        source:       'optimizer',
        asset:        primary.asset,
        bias:         assetBias,
        confidence:   _round2(conf),
        reasoning:    'PM edge: GII ' + (giiProb * 100).toFixed(0) + '% vs PM ' +
                      (pmProb * 100).toFixed(0) + '% on ' + matchRegion +
                      ' (edge ' + (edge >= 0 ? '+' : '') + (edge * 100).toFixed(0) + '%)',
        timestamp:    Date.now(),
        region:       matchRegion,
        evidenceKeys: ['pm_edge', matchRegion.toLowerCase().replace(/\s+/g, '_')],
        optimizer:    true,
        pmEdge:       _round2(edge),
        giiProb:      giiProb,
        pmProb:       pmProb
      });
    });

    return newSigs;
  }

  // ── Module 3: Triple-confirm amplification ────────────────────────────────
  // When TA + PM + at least one macro-level agent agree → amplified signal.

  function _tripleConfirm() {
    var ampSigs = [];
    try {
      var gii = window.GII;
      if (!gii || typeof gii.signals !== 'function') return [];

      var allGiiSigs  = gii.signals() || [];
      var taSigs  = (window.GII_AGENT_TECHNICALS  && typeof GII_AGENT_TECHNICALS.signals  === 'function')
                    ? GII_AGENT_TECHNICALS.signals()  : [];
      var pmSigs  = (window.GII_AGENT_POLYMARKET  && typeof GII_AGENT_POLYMARKET.signals  === 'function')
                    ? GII_AGENT_POLYMARKET.signals()  : [];

      if (!taSigs.length) return [];

      taSigs.forEach(function (taSig) {
        if ((taSig.confidence || 0) < 0.52) return;

        var asset  = taSig.asset;
        var bias   = taSig.bias;
        var region = taSig.region || 'GLOBAL';

        // Check PM agent agrees
        var pmAgree = pmSigs.some(function (s) {
          return s.asset === asset && s.bias === bias && (s.confidence || 0) >= 0.48;
        });

        // Check at least one macro-level agent agrees on same asset+bias
        var macroAgree = allGiiSigs.some(function (s) {
          return s.asset === asset &&
                 s.bias  === bias  &&
                 MACRO_SOURCES.indexOf(s.source || s._agentName) !== -1 &&
                 (s.confidence || 0) >= 0.52;
        });

        // Get GII posterior as quality gate
        var posterior = 0;
        try {
          var post = gii.posterior(region);
          if (post && typeof post.posterior === 'number') posterior = post.posterior;
        } catch (e) {}

        if (pmAgree && macroAgree && posterior >= 0.52) {
          var ampConf = _clamp(taSig.confidence * 1.12 + 0.06, 0, 0.90);
          ampSigs.push({
            source:       'optimizer',
            asset:        asset,
            bias:         bias,
            confidence:   _round2(ampConf),
            reasoning:    'Triple-confirm: TA(' + (taSig.confidence * 100).toFixed(0) +
                          '%) + PM + macro agree | posterior=' + (posterior * 100).toFixed(0) + '%',
            timestamp:    Date.now(),
            region:       region,
            evidenceKeys: ['triple_confirm', asset.toLowerCase(), bias],
            optimizer:    true,
            amplified:    true,
            baseTaConf:   taSig.confidence
          });
        }
      });
    } catch (e) {}

    return ampSigs;
  }

  // ── main poll ─────────────────────────────────────────────────────────────

  function poll() {
    _lastPollTs = Date.now();
    _status.lastPoll = _lastPollTs;

    _fetchFunding()
      .then(function (fundingMap) {
        if (fundingMap) _funding = fundingMap;

        var fundingSigs = _fundingSignals(_funding);
        var pmSigs      = _pmEdgeDetection();
        var ampSigs     = _tripleConfirm();

        var all = [].concat(fundingSigs, pmSigs, ampSigs);

        // Deduplicate: per asset+bias keep highest confidence
        var best = {};
        all.forEach(function (s) {
          var key = (s.asset || '') + '_' + (s.bias || '');
          if (!best[key] || (s.confidence || 0) > (best[key].confidence || 0)) {
            best[key] = s;
          }
        });

        _signals = _objValues(best).slice(0, 12);

        var btcF = _funding['BTC'];
        _status.fundingBTC      = btcF
          ? (btcF.rate8h * 100).toFixed(4) + '%/8h (ann ' + (btcF.annualized * 100).toFixed(1) + '%)'
          : 'N/A';
        _status.pmEdgesScanned  = _pmEdges.length;
        _status.pmEdgesActioned = pmSigs.length;
        _status.amplified       = ampSigs.length;
        _status.fundingSignals  = fundingSigs.length;
        _status.totalSignals    = _signals.length;
        _status.error           = null;
      })
      .catch(function (e) {
        _status.error = 'Optimizer poll error: ' + (e.message || String(e));
      });
  }

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_AGENT_OPTIMIZER = {
    poll:          poll,
    signals:       function () { return _signals.slice(); },
    status:        function () { return Object.assign({ lastPoll: _lastPollTs }, _status); },
    accuracy:      function () { return Object.assign({}, _accuracy); },
    onTradeResult: onTradeResult,
    pmEdges:       function () { return _pmEdges.slice(); },
    funding:       function () { return Object.assign({}, _funding); }
  };

  // ── init ──────────────────────────────────────────────────────────────────

  window.addEventListener('load', function () {
    _loadFeedback();
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL_MS);
    }, INIT_DELAY_MS);
  });

})();
