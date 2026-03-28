/* Economic Calendar Agent — econ-calendar.js v2
 * Tracks high-impact macroeconomic events (FOMC, NFP, CPI, etc.).
 *
 * Risk windows (before event):
 *   < 30 min  → BLOCK new trades (whipsaw risk too high)
 *   < 2 hours → WARN  (reduce confidence on new signals)
 *
 * Signal window (after event fires):
 *   0–60 min  → Generate directional signals from actual vs forecast surprise
 *               Strong beat/miss → directional trade on mapped assets
 *
 * Data: Forex Factory public JSON calendar (free, no key, CORS-open)
 *       Re-polled every hour; badge + signals refresh every minute.
 *
 * Exposes: window.ECON_CALENDAR
 */
(function () {
  'use strict';

  var POLL_MS      = 60 * 60 * 1000;  // re-poll hourly
  var CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

  var BLOCK_MS     = 30  * 60 * 1000;   // 30 min pre-event block
  var WARN_MS      = 2   * 60 * 60 * 1000; // 2 hour pre-event warn
  var CLEAR_AFTER  = 60  * 60 * 1000;   // 60 min post-event signal window

  var MIN_SURPRISE = 0.04;  // 4% surprise vs forecast needed to generate a signal

  var _events     = [];   // all HIGH-impact events this week, sorted by date
  var _signals    = [];   // post-event directional signals currently active
  var _lastUpdate = 0;

  /* ── Event → asset signal map ──────────────────────────────────────────────
   * beat_dir: direction if actual BEATS forecast (actual > forecast numerically)
   * invert:   true for inventory/supply events where a bigger draw = more negative
   *           actual but is BULLISH (e.g. EIA crude draws)
   * -------------------------------------------------------------------------- */
  var _ASSET_SIGNALS = [
    /* US Labour */
    { match: /non.?farm|nfp/i,
      beat: { GLD: 'short', WTI: 'long', BTC: 'long', ETH: 'long', SOL: 'long' } },
    { match: /unemployment|jobless.?claim/i,
      invert: true,   // lower unemployment = beat = risk-on (actual < forecast is good)
      beat: { GLD: 'short', BTC: 'long', ETH: 'long' } },
    /* US Inflation */
    { match: /\bcpi\b|consumer.?price/i,
      beat: { GLD: 'long', WTI: 'long', BRENT: 'long', BTC: 'short' } },
    { match: /\bpce\b|personal.?consumption/i,
      beat: { GLD: 'long', BTC: 'short' } },
    { match: /\bppi\b|producer.?price/i,
      beat: { GLD: 'long', WTI: 'long' } },
    /* US Growth */
    { match: /\bgdp\b/i,
      beat: { BTC: 'long', ETH: 'long', GLD: 'short', WTI: 'long' } },
    { match: /ism.?mfg|manufacturing.?pmi|markit.?mfg/i,
      beat: { BTC: 'long', WTI: 'long', GLD: 'short' } },
    /* FOMC / Fed */
    { match: /fomc|rate.?decision|interest.?rate|fed.?fund/i,
      beat: { GLD: 'short', BTC: 'short', ETH: 'short', WTI: 'short' } },
    /* Energy inventory */
    { match: /crude.?oil|eia.*(invent|stock)|oil.*(invent|stock)/i,
      invert: true,
      beat: { WTI: 'long', BRENT: 'long' } },
    { match: /natural.?gas.*(invent|storage)/i,
      invert: true,
      beat: { GAS: 'long' } },
    /* Global PMI / China */
    { match: /caixin|china.*pmi/i,
      beat: { BTC: 'long', ETH: 'long', WTI: 'long' } },
    /* Canadian / AUD — commodity proxies */
    { match: /boc|bank of canada|canada.*rate/i,
      beat: { WTI: 'long' } },
    { match: /rba|reserve bank of australia/i,
      beat: { BTC: 'long' } },
  ];

  /* ── Value parser ──────────────────────────────────────────────────────────
   * Handles: "235K", "-2.3M", "1.2B", "3.5%", "-0.1", "$42.3B"
   * Returns a float (with K/M/B expanded) or null if unparseable. */
  function _parseValue(str) {
    if (str === null || str === undefined || str === '') return null;
    var s = String(str).trim().replace(/[$£€¥%]/g, '');
    var mult = 1;
    if (/K$/i.test(s)) { mult = 1e3;  s = s.slice(0, -1); }
    else if (/M$/i.test(s)) { mult = 1e6;  s = s.slice(0, -1); }
    else if (/B$/i.test(s)) { mult = 1e9;  s = s.slice(0, -1); }
    var n = parseFloat(s);
    return isFinite(n) ? n * mult : null;
  }

  /* ── Build post-event signals ──────────────────────────────────────────────
   * For each event that has fired within the last CLEAR_AFTER ms, compare
   * actual vs forecast and generate directional asset signals. */
  function _buildSignals() {
    var now  = Date.now();
    var sigs = [];

    _events.forEach(function (e) {
      var ts = e.date.getTime();
      if (ts > now)              return;   // hasn't fired yet
      if (ts < now - CLEAR_AFTER) return;  // too long ago

      var actual   = _parseValue(e.actual);
      var forecast = _parseValue(e.forecast);
      if (actual === null || forecast === null) return;
      if (Math.abs(forecast) < 1e-12)           return;  // avoid divide-by-zero

      var surprise = (actual - forecast) / Math.abs(forecast);
      if (Math.abs(surprise) < MIN_SURPRISE) return;  // noise — skip

      /* How long ago did it fire? Scale confidence down over time. */
      var minsAgo  = (now - ts) / 60000;
      var timeFade = Math.max(0.5, 1.0 - minsAgo / 60);   // 1.0 → 0.5 over 30 min

      /* Base confidence from magnitude of surprise — 0-100 scale to match EE threshold */
      var baseConf = Math.min(80, 45 + Math.abs(surprise) * 60);
      var conf     = +(baseConf * timeFade).toFixed(1);
      if (conf < 30) return;

      _ASSET_SIGNALS.forEach(function (rule) {
        if (!rule.match.test(e.title)) return;

        /* Is this a positive surprise from the market's perspective? */
        var isPositive = rule.invert ? (surprise < 0) : (surprise > 0);

        Object.keys(rule.beat).forEach(function (asset) {
          var beatDir  = rule.beat[asset];
          var tradeDir = isPositive ? beatDir : (beatDir === 'long' ? 'short' : 'long');

          var surprisePct = (surprise * 100).toFixed(1);
          sigs.push({
            asset:       asset,
            bias:        tradeDir,
            confidence:  conf,
            reason:      e.country + ' ' + e.title + ' — actual ' + e.actual +
                         ' vs forecast ' + e.forecast +
                         ' (' + (surprise > 0 ? '+' : '') + surprisePct + '% surprise)',
            source:      'econ_event',
            region:      'GLOBAL',
            eventTitle:  e.title,
            eventCountry: e.country,
            surprise:    surprise,
            firedAt:     ts
          });
        });
      });
    });

    /* Deduplicate: keep highest-confidence signal per asset */
    var best = {};
    sigs.forEach(function (s) {
      if (!best[s.asset] || s.confidence > best[s.asset].confidence) {
        best[s.asset] = s;
      }
    });
    _signals = Object.keys(best).map(function (a) { return best[a]; });

    if (_signals.length) {
      console.log('[ECON] ' + _signals.length + ' post-event trade signal(s): ' +
        _signals.map(function (s) {
          return s.asset + ' ' + s.bias.toUpperCase() + ' (' + s.eventTitle.split(' ').slice(0,2).join(' ') + ')';
        }).join(', '));
    }
  }

  /* ── Poll calendar ─────────────────────────────────────────────────────── */
  function _poll() {
    var ctrl = new AbortController();
    var tid  = setTimeout(function () { ctrl.abort(); }, 120000);
    fetch(CALENDAR_URL + '?_=' + Date.now(), { signal: ctrl.signal })
      .then(function (r) { clearTimeout(tid); return r.json(); })
      .then(function (data) {
        if (!Array.isArray(data)) return;

        _events = data
          .filter(function (e) { return (e.impact || '').toLowerCase() === 'high'; })
          .map(function (e) {
            return {
              title:    e.title    || '?',
              country:  e.country  || '?',
              date:     new Date(e.date),
              forecast: e.forecast !== undefined ? e.forecast : null,
              previous: e.previous !== undefined ? e.previous : null,
              actual:   e.actual   !== undefined ? e.actual   : null,
            };
          })
          .filter(function (e) { return !isNaN(e.date.getTime()); })
          .sort(function (a, b) { return a.date - b.date; });

        _lastUpdate = Date.now();
        _buildSignals();
        _renderBadge();
        console.log('[ECON] ' + _events.length + ' high-impact events this week');
      })
      .catch(function (e) { clearTimeout(tid); console.warn('[ECON] Poll error:', e.message || e); });
  }

  /* ── Helpers ───────────────────────────────────────────────────────────── */
  function _upcoming(withinMs) {
    var now    = Date.now();
    var cutoff = now + withinMs;
    return _events.filter(function (e) {
      var ts = e.date.getTime();
      return ts >= now - 5 * 60 * 1000 && ts <= cutoff;
    });
  }

  function _nextEvent() {
    var now = Date.now();
    for (var i = 0; i < _events.length; i++) {
      if (_events[i].date.getTime() > now) return _events[i];
    }
    return null;
  }

  function _minsUntil(evt) {
    return Math.round((evt.date.getTime() - Date.now()) / 60000);
  }

  function _recentlyFired() {
    var now = Date.now();
    return _events.filter(function (e) {
      var ts = e.date.getTime();
      return ts <= now && ts >= now - CLEAR_AFTER;
    });
  }

  /* ── Badge ─────────────────────────────────────────────────────────────── */
  function _renderBadge() {
    var el = document.getElementById('econCalBadge');
    if (!el) return;

    var blocking = _upcoming(BLOCK_MS);
    var warning  = _upcoming(WARN_MS);
    var next     = _nextEvent();
    var fired    = _recentlyFired();

    if (blocking.length) {
      var ev    = blocking[0];
      var mins  = _minsUntil(ev);
      var label = mins <= 0 ? 'NOW' : mins + 'm';
      el.textContent = '⛔ ' + ev.country + ' ' + ev.title.split(' ').slice(0, 3).join(' ') + ' ' + label;
      el.style.color = '#f87171';
    } else if (_signals.length) {
      /* Post-event signals active — show as opportunity */
      el.textContent = 'CAL ' + _signals.length + ' sig';
      el.style.color = '#4ade80';
    } else if (fired.length) {
      el.textContent = 'CAL: ' + fired[0].country + ' fired';
      el.style.color = '#ffaa00';
    } else if (warning.length) {
      var wev   = warning[0];
      var wmins = _minsUntil(wev);
      el.textContent = 'CAL: ' + wev.country + ' in ' + wmins + 'm';
      el.style.color = '#ffaa00';
    } else if (next) {
      var nmins  = _minsUntil(next);
      var nlabel = nmins < 60 ? nmins + 'm' :
                   nmins < 1440 ? Math.round(nmins / 60) + 'h' :
                   Math.round(nmins / 1440) + 'd';
      el.textContent = 'CAL ' + nlabel;
      el.style.color = '#555';
    } else {
      el.textContent = 'CAL ✓';
      el.style.color = '#555';
    }

    /* Tooltip: next 8 events + any active signals */
    var lines = _events.slice(0, 8).map(function (e) {
      var m = _minsUntil(e);
      var when = m < 0 ? 'just fired' : m < 60 ? m + 'min' : Math.round(m / 60) + 'h';
      return e.country + ' — ' + e.title + ' (' + when + ')' +
             (e.actual ? ' actual:' + e.actual : '');
    });
    var sigLines = _signals.map(function (s) {
      return '→ ' + s.asset + ' ' + s.bias.toUpperCase() + ': ' + s.reason;
    });
    el.title = 'High-impact events this week:\n' + (lines.join('\n') || 'None found') +
               (sigLines.length ? '\n\nActive trade signals:\n' + sigLines.join('\n') : '');
  }

  /* Refresh badge + signals every minute */
  setInterval(function () {
    _buildSignals();
    _renderBadge();
  }, 60000);

  /* ── Public API ─────────────────────────────────────────────────────────── */
  window.ECON_CALENDAR = {
    /* True if a high-impact event fires in the next 30 min — EE should block trades */
    shouldBlock: function () { return _upcoming(BLOCK_MS).length > 0; },

    /* True if a high-impact event fires in the next 2h — confidence penalty applies */
    shouldWarn:  function () { return _upcoming(WARN_MS).length > 0; },

    /* Confidence multiplier: 1.0 (clear) → 0.85 (warning) → blocked (block) */
    confMultiplier: function () {
      if (_upcoming(BLOCK_MS).length) return 0;
      if (_upcoming(WARN_MS).length)  return 0.85;
      return 1.0;
    },

    /* Post-event directional signals — consumed by gii-entry.js */
    signals:    function () { return _signals.slice(); },

    imminent:   function () { return _upcoming(BLOCK_MS)[0] || null; },
    upcoming:   function (h) { return _upcoming((h || 2) * 3600000); },
    events:     function () { return _events.slice(); },
    nextEvent:  function () { return _nextEvent(); },
    refresh:    function () { _poll(); },
    lastUpdate: function () { return _lastUpdate; },

    status: function () {
      var blocking = _upcoming(BLOCK_MS).length > 0;
      var warning  = _upcoming(WARN_MS).length  > 0;
      var state    = blocking ? '⛔ BLOCKING new trades' : warning ? '⚠ WARNING — conf penalty' : '✓ CLEAR';
      var next     = _nextEvent();
      var sigStr   = _signals.length
        ? '\n  Signals: ' + _signals.map(function (s) { return s.asset + ' ' + s.bias; }).join(', ')
        : '';
      return '[ECON] ' + state +
             (next ? '\n  Next: ' + next.country + ' ' + next.title +
                     ' in ' + _minsUntil(next) + 'min' : '\n  No upcoming events') +
             sigStr;
    }
  };

  /* ── Boot ───────────────────────────────────────────────────────────────── */
  setTimeout(_poll, 3000);
  setInterval(_poll, POLL_MS);
  console.log('[ECON] Economic calendar agent v2 loaded — pre-event gate + post-event signals');

})();
