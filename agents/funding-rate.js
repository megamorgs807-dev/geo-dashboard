/* Funding Rate Agent — funding-rate.js v1
 * Tracks crypto perpetual funding rates as a crowd-sentiment / crowding indicator.
 *
 * How it works:
 *   Funding rate is what longs pay shorts (positive) or shorts pay longs (negative)
 *   every 8 hours on perp exchanges. When it's extreme, one side is overcrowded.
 *
 *   High positive funding (>+0.05%/8h) → longs overcrowded → contrarian SHORT
 *   High negative funding (<-0.05%/8h) → shorts overcrowded → contrarian LONG
 *
 * Data: Binance Futures /fapi/v1/premiumIndex (free, no key, CORS-open)
 *       Updates every 30 min (funding settles every 8h)
 *
 * Feeds into gii-entry.js as a new 'funding' confluence category.
 * Exposes: window.FUNDING_RATES
 */
(function () {
  'use strict';

  var POLL_MS     = 30 * 60 * 1000;  // 30 min
  var BINANCE_URL = 'https://fapi.binance.com/fapi/v1/premiumIndex';

  /* Map Binance perp symbol → our EE asset name */
  var SYMBOL_MAP = {
    'BTCUSDT':  'BTC',  'ETHUSDT':  'ETH',  'SOLUSDT':  'SOL',
    'XRPUSDT':  'XRP',  'BNBUSDT':  'BNB',  'ADAUSDT':  'ADA',
    'LINKUSDT': 'LINK', 'AVAXUSDT': 'AVAX', 'DOGEUSDT': 'DOGE',
    'LTCUSDT':  'LTC',  'DOTUSDT':  'DOT',  'MATICUSDT':'MATIC',
    'HYPEUSDT': 'HYPE'
  };

  /* Thresholds (absolute, per 8h period) */
  var THR_EXTREME  = 0.001;    // 0.10%/8h  — extreme crowding
  var THR_HIGH     = 0.0005;   // 0.05%/8h  — high crowding
  var THR_MODERATE = 0.0002;   // 0.02%/8h  — moderate crowding

  var _rates      = {};   // asset → {rate, ratePct, nextFunding, ts}
  var _signals    = [];
  var _lastUpdate = 0;

  /* ── Confidence from extremity ─────────────────────────────────────────── */
  function _toConf(rate) {
    var abs = Math.abs(rate);
    if (abs >= THR_EXTREME)  return 80;   // 0-100 scale
    if (abs >= THR_HIGH)     return 65;
    if (abs >= THR_MODERATE) return 50;
    return 0;
  }

  /* ── Main poll ─────────────────────────────────────────────────────────── */
  function _poll() {
    fetch(BINANCE_URL)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!Array.isArray(data)) return;

        var rates = {};
        data.forEach(function (item) {
          var asset = SYMBOL_MAP[item.symbol];
          if (!asset) return;
          var rate = parseFloat(item.lastFundingRate);
          if (!isFinite(rate)) return;
          rates[asset] = {
            rate:        rate,
            ratePct:     +(rate * 100).toFixed(4),
            nextFunding: item.nextFundingTime,
            ts:          Date.now()
          };
        });

        _rates      = rates;
        _lastUpdate = Date.now();
        _buildSignals();
        _renderBadge();
        console.log('[FR] Updated ' + Object.keys(_rates).length + ' assets, ' +
                    _signals.length + ' signals');
      })
      .catch(function (e) { console.warn('[FR] Poll error:', e.message || e); });
  }

  /* ── Build contrarian signals ──────────────────────────────────────────── */
  function _buildSignals() {
    var sigs = [];

    Object.keys(_rates).forEach(function (asset) {
      var r    = _rates[asset];
      var conf = _toConf(r.rate);
      if (!conf) return;

      /* Contrarian: positive funding → longs overcrowded → SHORT;
         negative funding → shorts overcrowded → LONG */
      var bias = r.rate > 0 ? 'short' : 'long';

      sigs.push({
        asset:       asset,
        bias:        bias,
        confidence:  conf,
        reason:      'Funding ' + (r.rate > 0 ? '+' : '') + r.ratePct + '%/8h — ' +
                     (r.rate > 0 ? 'longs overcrowded, squeeze risk' : 'shorts overcrowded, squeeze risk'),
        source:      'funding',
        region:      'GLOBAL',
        fundingRate: r.rate,
        /* cotData shape reused so gii-entry can display positioning label */
        cotData: { positioning: r.rate > 0 ? 'FR_LONG_EXTREME' : 'FR_SHORT_EXTREME' }
      });
    });

    _signals = sigs;

    var extremes = _signals.filter(function (s) { return s.confidence >= 65; });
    if (extremes.length) {
      console.log('[FR] Extreme funding: ' +
        extremes.map(function (s) {
          return s.asset + '(' + (s.fundingRate > 0 ? '+' : '') +
                 _rates[s.asset].ratePct + '%)';
        }).join(', '));
    }
  }

  /* ── Badge ─────────────────────────────────────────────────────────────── */
  function _renderBadge() {
    var el = document.getElementById('fundingRateBadge');
    if (!el) return;

    var extremes = _signals.filter(function (s) { return s.confidence >= 65; });

    /* Top 3 assets by absolute rate for tooltip */
    var topRates = Object.keys(_rates)
      .filter(function (a) { return Math.abs(_rates[a].rate) >= THR_MODERATE; })
      .sort(function (a, b) { return Math.abs(_rates[b].rate) - Math.abs(_rates[a].rate); })
      .slice(0, 4);

    if (!extremes.length) {
      el.textContent = 'FR ✓';
      el.style.color = '#555';
    } else {
      el.textContent = 'FR ' + extremes.length + '⚠';
      el.style.color = '#ffaa00';
    }

    var lines = topRates.map(function (a) {
      var r = _rates[a];
      return a + ': ' + (r.rate > 0 ? '+' : '') + r.ratePct + '%/8h';
    });
    el.title = 'Perpetual funding rates (per 8h):\n' +
               (lines.join('\n') || 'All near zero') +
               '\n\nExtreme crowding signals: ' + (extremes.length || 'none');
  }

  /* ── Public API ─────────────────────────────────────────────────────────── */
  window.FUNDING_RATES = {
    signals:    function () { return _signals.slice(); },
    rates:      function () { return Object.assign({}, _rates); },
    getRate:    function (asset) { return _rates[(asset || '').toUpperCase()] || null; },
    refresh:    function () { _poll(); },
    lastUpdate: function () { return _lastUpdate; },

    status: function () {
      var notable = Object.keys(_rates)
        .filter(function (a) { return Math.abs(_rates[a].rate) >= THR_MODERATE; })
        .map(function (a) {
          var r = _rates[a];
          return '  ' + a + ': ' + (r.rate > 0 ? '+' : '') + r.ratePct + '%/8h';
        });
      return '[FUNDING]\n' + (notable.length ? notable.join('\n') : '  All rates neutral');
    }
  };

  /* ── Boot ───────────────────────────────────────────────────────────────── */
  setTimeout(_poll, 5000);
  setInterval(_poll, POLL_MS);
  console.log('[FR] Funding rate agent loaded — tracks crypto perp crowding');

})();
