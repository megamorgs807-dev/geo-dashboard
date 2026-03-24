/* GII Macro Agent — gii-macro.js v3
 * Monitors macro-financial signals (VIX, DXY, US10Y, regime)
 * + World Bank country macro indicators (GDP, inflation, debt)
 * + IMF WEO forecasts (GDP growth, inflation projections)
 * Reads: /api/market, /api/regime, /api/worldbank, /api/imf
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
    online: false,
    wbLastFetch: null,
    imfLastFetch: null,
    wbCountries: 0,
    imfCountries: 0
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  // Cached macro data
  var _wbData  = null;
  var _imfData = null;

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
    if (!market && !regime) return;  // only skip when both are null
    market = market || {};           // treat missing market as empty — regime still processed

    // Extract VIX — try all known field name variants
    var vix = null;
    var vixSource = null;
    var _vixTry = ['VIX', 'VIX.Close', 'VIX.close', 'vix', 'VIX_close', 'volatility', 'vol'];
    for (var _vi = 0; _vi < _vixTry.length; _vi++) {
      var _v = parseFloat(market[_vixTry[_vi]]);
      if (_v > 0) { vix = _v; vixSource = _vixTry[_vi]; break; }
    }
    // Fallback: estimate VIX from GII GTI (available locally, no API needed)
    if (vix === null && window.GII && typeof GII.gti === 'function') {
      try {
        var _gti = GII.gti();
        if (_gti && _gti.value != null) {
          // GTI 80+ ≈ VIX 35+, GTI 60 ≈ VIX 25, GTI 40 ≈ VIX 18
          vix = Math.round(10 + _gti.value * 0.35);
          vixSource = 'gti-estimate';
        }
      } catch (e) {}
    }
    _status.vixSource = vixSource || 'unavailable';

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

    // Determine risk mode — check all high-stress regime names, not just 'RISK_OFF'
    var riskOff = false;
    var _riskOffNames = ['RISK_OFF', 'RISK OFF', 'CRISIS', 'EXTREME', 'HIGH_RISK',
                         'HIGH RISK', 'STRESS', 'SEVERE', 'DANGER', 'DEFCON'];
    if (regimeName) {
      var _rn = regimeName.toUpperCase();
      for (var _ri = 0; _ri < _riskOffNames.length; _ri++) {
        if (_rn.indexOf(_riskOffNames[_ri]) !== -1) { riskOff = true; break; }
      }
    }
    if (regimeScore >= 70) riskOff = true;        // high regime stress score → risk-off
    if (vix !== null && vix > 25) riskOff = true; // elevated VIX → risk-off
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

  // ── World Bank macro analysis ──────────────────────────────────────────────

  function _analyseWorldBank(data) {
    if (!data || typeof data !== 'object') return;
    var countries = Object.keys(data);
    _status.wbCountries  = countries.length;
    _status.wbLastFetch  = Date.now();

    // Iran: deep recession + hyperinflation → energy / supply disruption risk
    var irn = data['IRN'] || {};
    if (irn.gdp_growth != null && irn.inflation != null) {
      if (irn.gdp_growth < -3 && irn.inflation > 30) {
        _pushSignal({
          source: 'worldbank',
          asset: 'WTI',
          bias: 'long',
          confidence: _clamp(0.45 + Math.min(0.20, irn.inflation / 200), 0.40, 0.68),
          reasoning: 'Iran GDP ' + irn.gdp_growth.toFixed(1) + '% + inflation ' +
            irn.inflation.toFixed(0) + '% → economic stress, oil supply risk',
          region: 'MENA',
          evidenceKeys: ['iran', 'oil', 'inflation', 'gdp', 'worldbank']
        });
        _pushSignal({
          source: 'worldbank',
          asset: 'GLD',
          bias: 'long',
          confidence: 0.42,
          reasoning: 'Iran macro stress → regional instability → gold safe-haven bid',
          region: 'MENA',
          evidenceKeys: ['iran', 'gold', 'macro stress', 'worldbank']
        });
      }
    }

    // China: GDP slowdown → tech/semiconductor caution
    var chn = data['CHN'] || {};
    if (chn.gdp_growth != null && chn.gdp_growth < 4.5) {
      _pushSignal({
        source: 'worldbank',
        asset: 'TSM',
        bias: 'short',
        confidence: _clamp(0.30 + (4.5 - chn.gdp_growth) * 0.05, 0.25, 0.62),
        reasoning: 'China GDP ' + chn.gdp_growth.toFixed(1) + '% (slowing) → semi demand headwind',
        region: 'ASIA',
        evidenceKeys: ['china', 'gdp', 'semiconductors', 'worldbank']
      });
    }

    // Russia: GDP contraction confirms energy/defense premium
    var rus = data['RUS'] || {};
    if (rus.gdp_growth != null && rus.gdp_growth < -1) {
      _pushSignal({
        source: 'worldbank',
        asset: 'LMT',
        bias: 'long',
        confidence: 0.45,
        reasoning: 'Russia GDP ' + rus.gdp_growth.toFixed(1) + '% → conflict cost drag, defense long',
        region: 'EUROPE',
        evidenceKeys: ['russia', 'gdp', 'defense', 'worldbank']
      });
    }

    // Ukraine: GDP collapse + war economy → energy supply chain risk
    var ukr = data['UKR'] || {};
    if (ukr.gdp_growth != null && ukr.gdp_growth < -5) {
      _pushSignal({
        source: 'worldbank',
        asset: 'WTI',
        bias: 'long',
        confidence: 0.40,
        reasoning: 'Ukraine GDP ' + ukr.gdp_growth.toFixed(1) + '% → war severity, Europe energy risk',
        region: 'EUROPE',
        evidenceKeys: ['ukraine', 'gdp', 'energy', 'worldbank']
      });
    }

    // Sudan/Ethiopia: severe crises → humanitarian risk index
    ['SDN', 'ETH'].forEach(function(iso) {
      var c = data[iso] || {};
      if (c.inflation != null && c.inflation > 50) {
        _pushSignal({
          source: 'worldbank',
          asset: 'GLD',
          bias: 'long',
          confidence: 0.35,
          reasoning: iso + ' inflation ' + c.inflation.toFixed(0) + '% → humanitarian crisis, GLD bid',
          region: 'AFRICA',
          evidenceKeys: [iso.toLowerCase(), 'inflation', 'crisis', 'worldbank']
        });
      }
    });
  }


  // ── IMF WEO forecast analysis ──────────────────────────────────────────────

  function _analyseIMF(data) {
    if (!data || typeof data !== 'object') return;
    _status.imfCountries = Object.keys(data).length;
    _status.imfLastFetch = Date.now();

    // Iran IMF forecast: persistently negative GDP outlook
    var irn = data['IRN'] || {};
    if (irn.gdp_growth != null && irn.gdp_growth < 0) {
      _pushSignal({
        source: 'imf',
        asset: 'WTI',
        bias: 'long',
        confidence: 0.40,
        reasoning: 'IMF WEO: Iran GDP forecast ' + irn.gdp_growth.toFixed(1) +
          '% → sustained economic stress, oil supply risk',
        region: 'MENA',
        evidenceKeys: ['iran', 'imf', 'forecast', 'oil']
      });
    }

    // China IMF forecast: sub-4% growth → sustained tech sector headwind
    var chn = data['CHN'] || {};
    if (chn.gdp_growth != null && chn.gdp_growth < 4.0) {
      _pushSignal({
        source: 'imf',
        asset: 'TSM',
        bias: 'short',
        confidence: _clamp(0.30 + (4.0 - chn.gdp_growth) * 0.06, 0.25, 0.58),
        reasoning: 'IMF WEO: China GDP forecast ' + chn.gdp_growth.toFixed(1) +
          '% → semi demand cycle headwind',
        region: 'ASIA',
        evidenceKeys: ['china', 'imf', 'forecast', 'semiconductors']
      });
    }

    // High global inflation forecasts → gold hedge
    var highInflCount = 0;
    Object.keys(data).forEach(function(iso) {
      var c = data[iso];
      if (c && c.inflation != null && c.inflation > 15) highInflCount++;
    });
    if (highInflCount >= 3) {
      _pushSignal({
        source: 'imf',
        asset: 'GLD',
        bias: 'long',
        confidence: _clamp(0.35 + highInflCount * 0.04, 0.35, 0.60),
        reasoning: highInflCount + ' monitored countries with IMF inflation forecast >15% → gold hedge',
        region: 'GLOBAL',
        evidenceKeys: ['imf', 'inflation', 'gold', 'forecast', 'macro']
      });
    }
  }


  // ── public poll ────────────────────────────────────────────────────────────

  var _API = (typeof window !== 'undefined' && window.GEO_API_BASE) || 'http://localhost:8765';

  function poll() {
    _status.lastPoll = Date.now();
    // Always fetch all endpoints independently — don't abandon on any one error.
    // _analyseMarket handles null market; GTI fallback runs regardless of backend.
    _fetchJSON(_API + '/api/market', function (err, market) {
      _status.online = !err;
      _fetchJSON(_API + '/api/regime', function (err2, regime) {
        _analyseMarket(market || null, err2 ? null : regime);
        // GTI-based VIX estimate — runs even when backend is fully offline
        if (!_status.vix && window.GII && typeof GII.gti === 'function') {
          try {
            var _gti = GII.gti();
            if (_gti && _gti.value != null) {
              _status.vix       = Math.round(10 + _gti.value * 0.35);
              _status.vixSource = 'gti-estimate';
            }
          } catch (e) {}
        }
      });
    });

    // World Bank + IMF macro data (updated 6h on backend — fetch every poll cycle,
    // but the backend cache means these are effectively free after first load)
    _fetchJSON(_API + '/api/worldbank', function (err, wb) {
      if (!err && wb && typeof wb === 'object') {
        _wbData = wb;
        _analyseWorldBank(wb);
      }
    });
    _fetchJSON(_API + '/api/imf', function (err, imf) {
      if (!err && imf && typeof imf === 'object') {
        _imfData = imf;
        _analyseIMF(imf);
      }
    });
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII_AGENT_MACRO = {
    poll: poll,
    signals:   function () { return _signals.slice(); },
    status:    function () { return Object.assign({}, _status); },
    accuracy:  function () { return Object.assign({}, _accuracy); },
    worldbank: function () { return _wbData  ? Object.assign({}, _wbData)  : null; },
    imf:       function () { return _imfData ? Object.assign({}, _imfData) : null; }
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 6700);
  });

})();
