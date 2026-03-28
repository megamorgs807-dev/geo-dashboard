/* GII Liquidity Risk Agent — gii-liquidity.js v1
 * Monitors financial liquidity and credit-stress signals:
 *   - Credit spread stress (HY, IG, CDS, sovereign spreads)
 *   - Funding market stress (repo, overnight, dollar shortage)
 *   - FX liquidity (dollar squeeze, EM capital flight, carry unwind)
 *   - Banking sector stress (bank runs, contagion, systemic risk)
 * Reads: /api/market (VIX, DXY), window.__IC.events
 * Exposes: window.GII_AGENT_LIQUIDITY
 */
(function () {
  'use strict';

  var MAX_SIGNALS   = 20;
  var POLL_INTERVAL = 74000;

  var _API = (typeof window !== 'undefined' && window.GEO_API_BASE) || 'http://localhost:8765';

  // ── keyword categories ────────────────────────────────────────────────────

  var CREDIT_KEYWORDS = [
    'credit spread', 'credit crunch', 'junk bond spread', 'high yield spread',
    'investment grade spread', 'cds spread', 'default risk', 'sovereign spread',
    'bond spread', 'credit default swap', 'debt crisis', 'yield spread widening',
    'corporate bond stress', 'credit market'
  ];

  var FUNDING_KEYWORDS = [
    'repo rate', 'overnight rate', 'fed repo', 'reverse repo', 'dollar shortage',
    'dollar squeeze', 'funding pressure', 'money market stress', 'interbank rate',
    'libor spike', 'funding crunch', 'collateral shortage', 'margin call',
    'funding freeze', 'overnight lending'
  ];

  var FX_KEYWORDS = [
    'fx swap', 'dollar swap line', 'currency swap', 'dollar demand',
    'emerging market selloff', 'capital flight', 'fx reserves depleted',
    'currency crisis', 'dollar liquidity', 'carry trade unwind', 'em outflow',
    'dollar shortage global', 'reserve currency pressure'
  ];

  var BANKING_KEYWORDS = [
    'bank run', 'deposit flight', 'bank failure', 'banking crisis',
    'financial contagion', 'systemic risk', 'bank bailout', 'lender of last resort',
    'bank liquidity', 'bank stress', 'banking sector stress', 'financial stability',
    'deposit guarantee', 'bank rescue'
  ];

  var BROAD_STRESS_KEYWORDS = [
    'liquidity crisis', 'market freeze', 'financial stress', 'market dislocation',
    'forced selling', 'market dysfunction', 'deleveraging', 'risk assets selloff',
    'flight to safety', 'flight to quality', 'financial contagion', 'market panic'
  ];

  var _signals = [];
  var _status = {
    lastPoll:      null,
    creditEvents:  0,
    fundingEvents: 0,
    fxEvents:      0,
    bankingEvents: 0,
    stressLevel:   'LOW',   // LOW / MODERATE / HIGH / CRITICAL
    online:        false
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  // ── helpers ───────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  function _matches(text, keywords) {
    if (!text) return false;
    var t = text.toLowerCase();
    for (var i = 0; i < keywords.length; i++) {
      if (t.indexOf(keywords[i]) !== -1) return true;
    }
    return false;
  }

  function _fetchJSON(url, cb) {
    var ctrl = new AbortController();
    var tid  = setTimeout(function () { ctrl.abort(); }, 120000);
    fetch(url, { method: 'GET', signal: ctrl.signal })
      .then(function (r) { clearTimeout(tid); return r.ok ? r.json() : null; })
      .then(function (d) { cb(null, d); })
      .catch(function (e) { clearTimeout(tid); cb(e, null); });
  }

  // ── analysis ──────────────────────────────────────────────────────────────

  function _analyseEvents(market) {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now    = Date.now();
    var cutoff = now - 24 * 60 * 60 * 1000;

    var recent = IC.events.filter(function (e) { return e.ts > cutoff; });

    var creditEvts  = recent.filter(function (e) { return _matches(e.title || e.headline || e.text || '', CREDIT_KEYWORDS);  });
    var fundingEvts = recent.filter(function (e) { return _matches(e.title || e.headline || e.text || '', FUNDING_KEYWORDS); });
    var fxEvts      = recent.filter(function (e) { return _matches(e.title || e.headline || e.text || '', FX_KEYWORDS);      });
    var bankingEvts = recent.filter(function (e) { return _matches(e.title || e.headline || e.text || '', BANKING_KEYWORDS); });
    var broadEvts   = recent.filter(function (e) { return _matches(e.title || e.headline || e.text || '', BROAD_STRESS_KEYWORDS); });

    _status.creditEvents  = creditEvts.length;
    _status.fundingEvents = fundingEvts.length;
    _status.fxEvents      = fxEvts.length;
    _status.bankingEvents = bankingEvts.length;

    var totalStress = creditEvts.length + fundingEvts.length + bankingEvts.length + broadEvts.length;

    if      (totalStress >= 8) _status.stressLevel = 'CRITICAL';
    else if (totalStress >= 4) _status.stressLevel = 'HIGH';
    else if (totalStress >= 2) _status.stressLevel = 'MODERATE';
    else                       _status.stressLevel = 'LOW';

    var vix   = market ? (parseFloat(market.VIX)   || null) : null;
    var dxy   = market ? (parseFloat(market.DXY)   || null) : null;

    // ── Credit stress signals ──────────────────────────────────────────────

    if (creditEvts.length >= 2) {
      var cConf = _clamp(0.35 + creditEvts.length * 0.06, 0.35, 0.78);
      _pushSignal({
        source:       'liquidity',
        asset:        'GLD',
        bias:         'long',
        confidence:   cConf,
        reasoning:    creditEvts.length + ' credit-spread/stress events — flight-to-quality demand',
        region:       'GLOBAL',
        evidenceKeys: ['credit spread', 'credit stress', 'default risk']
      });
      _pushSignal({
        source:       'liquidity',
        asset:        'SPY',
        bias:         'short',
        confidence:   _clamp(cConf * 0.88, 0.30, 0.72),
        reasoning:    'Credit stress (' + creditEvts.length + ' events) → elevated equity risk premium',
        region:       'GLOBAL',
        evidenceKeys: ['credit spread', 'risk premium', 'equities']
      });
    }

    // ── Funding market stress ──────────────────────────────────────────────

    if (fundingEvts.length >= 1) {
      var fConf = _clamp(0.38 + fundingEvts.length * 0.08, 0.38, 0.80);
      _pushSignal({
        source:       'liquidity',
        asset:        'GLD',
        bias:         'long',
        confidence:   fConf,
        reasoning:    fundingEvts.length + ' funding-market events (repo/overnight/dollar) → safe haven',
        region:       'GLOBAL',
        evidenceKeys: ['repo rate', 'funding pressure', 'dollar shortage']
      });
      // Repo/overnight spike → short-end rate pressure → TLT short
      _pushSignal({
        source:       'liquidity',
        asset:        'TLT',
        bias:         'short',
        confidence:   _clamp(fConf * 0.75, 0.25, 0.65),
        reasoning:    'Funding market stress — repo/overnight rate spike pressures long-duration bonds',
        region:       'US',
        evidenceKeys: ['repo rate', 'overnight rate', 'funding crunch']
      });
    }

    // ── FX / Dollar squeeze ────────────────────────────────────────────────

    var dxyStress = (dxy !== null && dxy > 106) ? (dxy - 106) * 0.025 : 0;
    if (fxEvts.length >= 1 || dxyStress > 0) {
      var fxConf = _clamp(0.32 + fxEvts.length * 0.07 + dxyStress, 0.30, 0.75);
      _pushSignal({
        source:       'liquidity',
        asset:        'EEM',
        bias:         'short',
        confidence:   fxConf,
        reasoning:    'Dollar liquidity squeeze — EM capital flight/carry unwind. DXY: ' + (dxy ? dxy.toFixed(1) : 'n/a'),
        region:       'GLOBAL',
        evidenceKeys: ['dollar squeeze', 'capital flight', 'em outflow']
      });
    }

    // ── Banking sector stress ──────────────────────────────────────────────

    if (bankingEvts.length >= 1) {
      var bConf = _clamp(0.45 + bankingEvts.length * 0.10, 0.45, 0.85);
      _pushSignal({
        source:       'liquidity',
        asset:        'GLD',
        bias:         'long',
        confidence:   bConf,
        reasoning:    bankingEvts.length + ' banking-stress events — systemic risk / safe haven demand',
        region:       'GLOBAL',
        evidenceKeys: ['bank run', 'banking crisis', 'systemic risk']
      });
      _pushSignal({
        source:       'liquidity',
        asset:        'SPY',
        bias:         'short',
        confidence:   _clamp(bConf * 0.90, 0.40, 0.82),
        reasoning:    'Banking sector stress — financial contagion risk to equities',
        region:       'US',
        evidenceKeys: ['bank failure', 'financial contagion', 'banking crisis']
      });
    }

    // ── Multi-category high-stress composite ──────────────────────────────

    if (totalStress >= 5) {
      _pushSignal({
        source:       'liquidity',
        asset:        'BTC',
        bias:         'short',
        confidence:   _clamp(totalStress / 12, 0.40, 0.80),
        reasoning:    'Multi-category liquidity stress (' + totalStress + ' events) — risk asset de-risking',
        region:       'GLOBAL',
        evidenceKeys: ['liquidity crisis', 'deleveraging', 'risk off']
      });
    }

    // ── VIX-amplified liquidity stress ────────────────────────────────────

    if (vix !== null && vix > 28 && totalStress >= 2) {
      _pushSignal({
        source:       'liquidity',
        asset:        'GLD',
        bias:         'long',
        confidence:   _clamp(vix / 45 + totalStress * 0.03, 0.50, 0.88),
        reasoning:    'VIX ' + vix.toFixed(1) + ' + liquidity stress combo — extreme safe-haven signal',
        region:       'GLOBAL',
        evidenceKeys: ['vix', 'liquidity crisis', 'flight to safety']
      });
    }
  }

  // ── public poll ───────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    _fetchJSON(_API + '/api/market', function (err, market) {
      _status.online = !err;
      _analyseEvents(err ? null : market);
    });
  }

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_AGENT_LIQUIDITY = {
    poll:     poll,
    signals:  function () { return _signals.slice(); },
    status:   function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); }
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 8500);
  });

})();
