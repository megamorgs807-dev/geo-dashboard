/* ═══════════════════════════════════════════════════════════════════════════
   COT SIGNALS AGENT v1  (CFTC Commitments of Traders)
   ═══════════════════════════════════════════════════════════════════════════
   Reads weekly CFTC COT data from /api/cot and derives contrarian signals.

   What COT data tells us:
   - Non-commercial (speculative) net positions = what hedge funds / CTAs own
   - EXTREME long positioning → reversal risk (crowded long → squeeze risk)
   - EXTREME short positioning → short squeeze risk (bears overcrowded)
   - Net position as % of open interest: -100% (max short) to +100% (max long)

   Signal logic:
   - Sentiment > +30% OI → NET_LONG_EXTREME → flag contrarian SHORT risk
   - Sentiment < -30% OI → NET_SHORT_EXTREME → flag contrarian LONG opportunity
   - Weekly change > ±10pp → momentum shift — flag trend

   Signals emitted to EE via GII_AGENT_ENTRY with source='cot'

   Exposed as window.COT_SIGNALS
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS       = 60 * 60 * 1000;  // 1 hour — data updates weekly on Fridays
  var BACKEND_URL   = 'http://localhost:8765';
  var _PREV_POS_KEY = 'cot_prev_positions_v1';

  /* ── State ───────────────────────────────────────────────────────────── */
  var _positions      = {};    // {ticker: {sentiment, positioning, net, ...}}
  var _prevPositions  = {};    // previous week — persisted in localStorage so trend survives reloads
  var _signals        = [];    // current COT-derived signals (for gii-entry)
  var _lastUpdate     = 0;
  var _cotBackoffUntil = 0;   // timestamp: don't fetch until this time (set on 429 rate-limit)

  /* Restore previous positions from localStorage on load */
  try {
    var _saved = JSON.parse(localStorage.getItem(_PREV_POS_KEY) || '{}');
    if (_saved && typeof _saved === 'object') _prevPositions = _saved;
  } catch (e) {}

  /* ── Interpret positioning as a bias signal ──────────────────────────── */
  function _toBias(positioning) {
    /* Contrarian: extreme longs → bearish, extreme shorts → bullish */
    if (positioning === 'NET_SHORT_EXTREME') return 'long';   // shorts overcrowded
    if (positioning === 'NET_SHORT')         return 'long';
    if (positioning === 'NET_LONG_EXTREME')  return 'short';  // longs overcrowded
    if (positioning === 'NET_LONG')          return 'short';
    return 'neutral';
  }

  /* ── Confidence from extremity of positioning ────────────────────────── */
  function _toConfidence(sentiment) {
    var abs = Math.abs(sentiment);
    if (abs >= 40) return 85;   // 0-100 scale
    if (abs >= 30) return 70;
    if (abs >= 20) return 55;
    if (abs >= 15) return 45;
    return 30;
  }

  /* ── Map COT ticker to EE-compatible asset ───────────────────────────── */
  var _ASSET_MAP = {
    'SPY': 'SPY', 'QQQ': 'QQQ', 'TLT': 'TLT',
    'GLD': 'GLD', 'WTI': 'WTI', 'DXY': 'DXY',
    'BTC': 'BTC', 'EUR': 'EURUSD'
  };

  /* ── Main poll ────────────────────────────────────────────────────────── */
  function _poll() {
    if (Date.now() < _cotBackoffUntil) {
      console.log('[COT] Rate-limit backoff active — skipping poll (' +
        Math.ceil((_cotBackoffUntil - Date.now()) / 1000) + 's remaining)');
      return;
    }
    var ctrl = new AbortController();
    var tid  = setTimeout(function () { ctrl.abort(); }, 120000);
    fetch(BACKEND_URL + '/api/cot', { signal: ctrl.signal })
      .then(function (res) {
        clearTimeout(tid);
        if (res.status === 429) {
          _cotBackoffUntil = Date.now() + 5 * 60 * 1000; // back off 5 minutes on rate limit
          console.warn('[COT] 429 rate limit — backing off for 5 minutes');
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        if (!data || !Object.keys(data).length) return;

        /* Only advance _prevPositions when the report_date changes — i.e. a new
           weekly CFTC report has dropped.  Avoids overwriting prev with identical data. */
        var firstKey = Object.keys(data)[0];
        var newDate  = firstKey ? (data[firstKey].report_date || '') : '';
        var curDate  = Object.keys(_positions)[0]
                         ? (_positions[Object.keys(_positions)[0]].report_date || '') : '';
        if (newDate && newDate !== curDate && Object.keys(_positions).length) {
          _prevPositions = Object.assign({}, _positions);
          try { localStorage.setItem(_PREV_POS_KEY, JSON.stringify(_prevPositions)); } catch(e) {}
        }
        _positions = data;
        _lastUpdate = Date.now();
        _buildSignals();
        _renderBadge();
        console.log('[COT] Updated: ' + Object.keys(_positions).length + ' markets');
      })
      .catch(function (e) {
        clearTimeout(tid);
        if (e && e.name === 'AbortError') {
          console.warn('[COT] Fetch timeout after 120s');
        }
        /* backend offline or network error — will retry on next poll interval */
      });
  }

  /* ── Build signals from positioning ─────────────────────────────────── */
  function _buildSignals() {
    var sigs = [];

    Object.keys(_positions).forEach(function (ticker) {
      var pos    = _positions[ticker];
      var asset  = _ASSET_MAP[ticker];
      if (!asset) return;

      var bias  = _toBias(pos.positioning);
      if (bias === 'neutral') return;   // no signal for neutral positioning

      var conf  = _toConfidence(pos.sentiment);

      /* Week-over-week change adds/subtracts confidence */
      if (_prevPositions[ticker]) {
        var delta = pos.sentiment - _prevPositions[ticker].sentiment;
        if (Math.abs(delta) >= 5) {
          /* Accelerating in same direction as contrarian signal → higher conf */
          var isAccelerating = (bias === 'short' && delta > 0) ||
                               (bias === 'long'  && delta < 0);
          conf = isAccelerating ? Math.min(95, conf + 10) : Math.max(25, conf - 10);
        }
      }

      sigs.push({
        asset:      asset,
        bias:       bias,
        confidence: conf,
        reason:     'COT ' + pos.positioning + ' (' + pos.sentiment + '% OI)',
        source:     'cot',
        region:     'GLOBAL',
        cotData:    pos
      });
    });

    _signals = sigs;

    /* Log notable extremes */
    var extremes = _signals.filter(function (s) { return s.confidence >= 70; });
    if (extremes.length) {
      console.log('[COT] ' + extremes.length + ' extreme positioning signal(s): ' +
        extremes.map(function (s) { return s.asset + '(' + s.bias + ')'; }).join(', '));
    }
  }

  /* ── Dashboard badge ─────────────────────────────────────────────────── */
  function _renderBadge() {
    var el = document.getElementById('cotBadge');
    if (!el) return;

    /* Work out data age from the first available report_date */
    var firstKey    = Object.keys(_positions)[0];
    var reportDate  = firstKey ? (_positions[firstKey].report_date || '') : '';
    var daysOld     = 0;
    if (reportDate) {
      var d;
      // CFTC file uses YYMMDD (e.g. 260317); ISO uses YYYY-MM-DD
      if (/^\d{6}$/.test(reportDate)) {
        var yy = parseInt(reportDate.slice(0,2), 10);
        var mm = parseInt(reportDate.slice(2,4), 10) - 1;
        var dd = parseInt(reportDate.slice(4,6), 10);
        d = new Date(2000 + yy, mm, dd);
      } else {
        d = new Date(reportDate);
      }
      if (!isNaN(d.getTime())) daysOld = Math.floor((Date.now() - d.getTime()) / 86400000);
    }
    var ageLabel  = daysOld > 0 ? ' · ' + daysOld + 'd' : '';
    var isStale   = daysOld > 8;   // COT is weekly; >8d means a report was missed

    var extremes = _signals.filter(function (s) { return s.confidence >= 70; });

    if (isStale) {
      el.textContent = 'COT stale' + ageLabel;
      el.style.color = '#f87171';
    } else if (!extremes.length) {
      el.textContent = 'COT ✓' + ageLabel;
      el.style.color = '#555';
    } else {
      el.textContent = 'COT ' + extremes.length + '⚠' + ageLabel;
      el.style.color = '#ffaa00';
    }

    var lines = Object.keys(_positions).map(function (t) {
      var p = _positions[t];
      return t + ': ' + p.sentiment + '% (' + p.positioning + ')';
    });
    el.title = lines.join('\n') + (reportDate ? '\nReport date: ' + reportDate + ' (' + daysOld + 'd ago)' : '');
  }

  /* ── Public API ──────────────────────────────────────────────────────── */
  window.COT_SIGNALS = {
    signals:    function () { return _signals.slice(); },
    positions:  function () { return Object.assign({}, _positions); },
    refresh:    function () { _poll(); },
    lastUpdate: function () { return _lastUpdate; },

    status: function () {
      var lines = Object.keys(_positions).map(function (t) {
        var p = _positions[t];
        return '  ' + t + ': sentiment=' + p.sentiment + '%, ' + p.positioning +
          ' (net ' + (p.net > 0 ? '+' : '') + p.net + ')';
      });
      return '[COT]\n' + (lines.length ? lines.join('\n') : '  No data yet');
    }
  };

  /* ── Boot ────────────────────────────────────────────────────────────── */
  setTimeout(_poll, 8000);          // initial poll after 8s
  setInterval(_poll, POLL_MS);

  console.log('[COT] Loaded — CFTC positioning tracker active');

})();
