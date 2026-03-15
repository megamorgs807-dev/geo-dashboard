/* GII Macro Agent — gii-macro.js v2
 * Monitors macro-financial signals (VIX, DXY, US10Y, regime)
 * Reads: /api/market, /api/regime
 * Exposes: window.GII_AGENT_MACRO
 */
(function () {
  'use strict';

  var MAX_SIGNALS = 20;
  var POLL_INTERVAL = 70000;

  var _signals = [];
  var _status = {
    lastPoll: null,
    vix: null,
    dxy: null,
    us10y: null,
    regime: null,
    regimeScore: null,
    riskMode: 'NEUTRAL',
    online: false
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  // ── helpers ────────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  // ── fetch helpers ──────────────────────────────────────────────────────────

  function _fetchJSON(url, cb) {
    fetch(url, { method: 'GET' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { cb(null, d); })
      .catch(function (e) { cb(e, null); });
  }

  // ── analysis ───────────────────────────────────────────────────────────────

  function _analyseMarket(market, regime) {
    if (!market) return;

    // Extract VIX
    var vix = null;
    if (market.VIX !== undefined) vix = parseFloat(market.VIX) || null;
    else if (market['VIX.Close'] !== undefined) vix = parseFloat(market['VIX.Close']) || null;

    // Extract DXY
    var dxy = null;
    if (market.DXY !== undefined) dxy = parseFloat(market.DXY) || null;

    // Extract US10Y
    var us10y = null;
    if (market.US10Y !== undefined) us10y = parseFloat(market.US10Y) || null;

    _status.vix = vix;
    _status.dxy = dxy;
    _status.us10y = us10y;

    // Regime
    var regimeScore = 50;
    var regimeName = 'NEUTRAL';
    if (regime) {
      regimeScore = parseFloat(regime.regime_score || regime.score || 50);
      regimeName = regime.regime || regime.name || 'NEUTRAL';
    }
    _status.regime = regimeName;
    _status.regimeScore = regimeScore;

    // Determine risk mode
    var riskOff = false;
    if (regimeName && regimeName.toUpperCase().indexOf('RISK_OFF') !== -1) riskOff = true;
    if (regimeName && regimeName.toUpperCase().indexOf('RISK OFF') !== -1) riskOff = true;
    if (vix !== null && vix > 25) riskOff = true;
    _status.riskMode = riskOff ? 'RISK_OFF' : 'RISK_ON';

    var prior = _clamp(regimeScore / 100, 0.10, 0.90);

    // VIX signals
    if (vix !== null) {
      if (vix > 30) {
        var vixConf = _clamp(Math.min(0.9, vix / 40), 0.45, 0.88);
        _pushSignal({
          source: 'macro',
          asset: 'GLD',
          bias: 'long',
          confidence: vixConf,
          reasoning: 'VIX at ' + vix.toFixed(1) + ' (extreme fear) → safe haven demand',
          region: 'GLOBAL',
          evidenceKeys: ['vix', 'fear', 'risk off']
        });
        _pushSignal({
          source: 'macro',
          asset: 'SPY',
          bias: 'short',
          confidence: _clamp(vixConf * 0.90, 0.40, 0.82),
          reasoning: 'VIX > 30 → equity risk premium elevated, SPY short',
          region: 'GLOBAL',
          evidenceKeys: ['vix', 'equities', 'risk off']
        });
      } else if (vix > 20) {
        _pushSignal({
          source: 'macro',
          asset: 'GLD',
          bias: 'long',
          confidence: _clamp(vix / 50, 0.30, 0.60),
          reasoning: 'VIX at ' + vix.toFixed(1) + ' (elevated anxiety) → mild safe haven bias',
          region: 'GLOBAL',
          evidenceKeys: ['vix', 'volatility']
        });
      }
    }

    // Regime RISK_OFF signals
    if (riskOff && regimeScore > 60) {
      var rConf = _clamp(regimeScore / 100 * 0.85, 0.40, 0.85);
      _pushSignal({
        source: 'macro',
        asset: 'GLD',
        bias: 'long',
        confidence: rConf,
        reasoning: 'Regime: ' + regimeName + ' (score ' + regimeScore + ') → GLD long',
        region: 'GLOBAL',
        evidenceKeys: ['regime', 'risk off', 'macro']
      });
      _pushSignal({
        source: 'macro',
        asset: 'BTC',
        bias: 'short',
        confidence: _clamp(rConf * 0.80, 0.35, 0.75),
        reasoning: 'RISK_OFF regime → BTC short (risk asset de-risking)',
        region: 'GLOBAL',
        evidenceKeys: ['regime', 'crypto', 'risk off']
      });
    }

    // Rising rates signal
    if (us10y !== null && us10y > 4.5) {
      _pushSignal({
        source: 'macro',
        asset: 'TLT',
        bias: 'short',
        confidence: _clamp((us10y - 4.5) * 0.30, 0.25, 0.65),
        reasoning: 'US 10Y at ' + us10y.toFixed(2) + '% → bond pressure, TLT short',
        region: 'US',
        evidenceKeys: ['rates', 'bonds', 'us10y']
      });
    }

    // DXY strength → EM headwind
    if (dxy !== null && dxy > 104) {
      _pushSignal({
        source: 'macro',
        asset: 'EEM',
        bias: 'short',
        confidence: _clamp((dxy - 104) * 0.05, 0.25, 0.60),
        reasoning: 'DXY at ' + dxy.toFixed(1) + ' → dollar strength weighing on EM',
        region: 'GLOBAL',
        evidenceKeys: ['dxy', 'dollar', 'emerging markets']
      });
    }

    // GTI cross-reference: geopolitical tension confirms macro risk signals
    try {
      var gtiData = window.GII && typeof window.GII.gti === 'function' ? window.GII.gti() : null;
      if (gtiData && typeof gtiData.value === 'number') {
        var gtiVal = gtiData.value;
        _status.gti = gtiVal;

        // HIGH geopolitical risk (GTI ≥ 60) + RISK_OFF regime = double-confirmed safe haven
        if (gtiVal >= 60 && riskOff) {
          var gtiConf = _clamp((gtiVal - 60) / 40 * 0.30 + 0.40, 0.40, 0.78);
          _pushSignal({
            source: 'macro',
            asset: 'XAR',
            bias: 'long',
            confidence: gtiConf,
            reasoning: 'GTI ' + Math.round(gtiVal) + ' (HIGH) + RISK_OFF regime → defense ETF long',
            region: 'GLOBAL',
            evidenceKeys: ['gti', 'defense', 'geopolitical risk', 'risk off']
          });
        }

        // EXTREME geopolitical risk (GTI ≥ 75): energy and gold amplification
        if (gtiVal >= 75) {
          var extConf = _clamp((gtiVal - 75) / 25 * 0.25 + 0.45, 0.45, 0.72);
          _pushSignal({
            source: 'macro',
            asset: 'WTI',
            bias: 'long',
            confidence: extConf,
            reasoning: 'GTI ' + Math.round(gtiVal) + ' (EXTREME) → supply disruption risk, WTI long',
            region: 'GLOBAL',
            evidenceKeys: ['gti', 'oil', 'geopolitical risk', 'extreme']
          });
        }
      }
    } catch (e) {}
  }

  // ── public poll ────────────────────────────────────────────────────────────

  var _API = (typeof window !== 'undefined' && window.GEO_API_BASE) || 'http://localhost:8765';

  function poll() {
    _status.lastPoll = Date.now();
    _fetchJSON(_API + '/api/market', function (err, market) {
      if (err) { _status.online = false; return; }
      _status.online = true;
      _fetchJSON(_API + '/api/regime', function (err2, regime) {
        _analyseMarket(market, err2 ? null : regime);
      });
    });
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII_AGENT_MACRO = {
    poll: poll,
    signals: function () { return _signals.slice(); },
    status: function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); }
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 6700);
  });

})();
