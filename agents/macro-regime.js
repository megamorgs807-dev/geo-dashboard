/* ═══════════════════════════════════════════════════════════════════════════
   MACRO REGIME CLASSIFIER v1
   ═══════════════════════════════════════════════════════════════════════════
   Classifies the current market environment into one of three regimes:

     RISK_ON       — equities bid, VIX low, DXY flat/weak, bonds selling off
     RISK_OFF      — flight to safety: VIX elevated, DXY surging, bonds bid
     TRANSITIONING — mixed signals, regime unclear

   How it works:
   - Polls /api/market every 5 minutes for VIX, DXY, US10Y
   - Keeps a 12-point rolling history (~1 hour) to detect TRENDS, not just levels
   - Scores regime 0-100 (higher = more risk-off) from multiple factors
   - Fires a 'regime-change' CustomEvent when regime shifts
   - Integrates with EE.canExecute() via window.MacroRegime.current()

   Signal gating (applied in executionEngine.js):
     RISK_OFF      → block new LONG on risk assets; allow SHORT + safe-havens
     TRANSITIONING → require +10% confidence above normal threshold
     RISK_ON       → normal rules, no additional gates

   Safe-haven assets (always allowed even in RISK_OFF):
     Gold (XAU/GLD), Bonds (TLT), Defense (LMT/RTX/NOC/BA/XAR),
     USD pairs, Short positions on any asset

   Exposed as window.MacroRegime
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var STORE_KEY    = 'geodash_macro_regime_v1';
  var POLL_MS      = 5 * 60 * 1000;   // 5 minutes
  var HISTORY_MAX  = 12;              // 1 hour of 5-min snapshots
  var BACKEND_URL  = 'http://localhost:8765';

  /* ── Safe-haven assets — allowed in ANY regime ───────────────────────── */
  var SAFE_HAVEN = new Set([
    'XAU','GLD','GOLD','SLV','SILVER',          // precious metals
    'TLT','US10Y','BONDS',                       // bonds
    'LMT','RTX','NOC','BA','GE','HII','LDOS','XAR', // defense
    'DXY','USD',                                 // dollar
    'VXX',                                       // volatility long
  ]);

  /* ── Risk assets — blocked for new LONGs in RISK_OFF ─────────────────── */
  var RISK_ASSETS = new Set([
    'BTC','ETH','SOL','AVAX','DOGE','LINK','ARB','OP','MATIC',
    'NVDA','AMD','COIN','MSTR','PLTR','ARM','TSLA','META',
    'SPY','QQQ','IWM','DIA','FXI','EEM','INDA',
    'WTI','BRENT','GAS',                         // energy: cyclical risk
  ]);

  /* ── State ───────────────────────────────────────────────────────────── */
  var _history  = [];   // [{ ts, vix, dxy, us10y }]
  var _regime   = 'UNKNOWN';
  var _score    = 50;
  var _details  = {};
  var _lastPoll = 0;

  /* ── Persist/restore history so it survives page reloads ─────────────── */
  function _loadHistory() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) _history = JSON.parse(raw);
    } catch (e) { _history = []; }
  }

  function _saveHistory() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(_history)); } catch (e) {}
  }

  /* ── Trend helper: % change from N periods ago ─────────────────────── */
  function _trend(field, periods) {
    if (_history.length < 2) return 0;
    var n     = Math.min(periods, _history.length - 1);
    var older = _history[_history.length - 1 - n][field];
    var newer = _history[_history.length - 1][field];
    if (!older || older === 0) return 0;
    return (newer - older) / older * 100;
  }

  /* ── Regime scoring ──────────────────────────────────────────────────
     Score 0-100. Higher = more risk-off.
     Threshold: >= 70 → RISK_OFF (raised from 60 — less hair-trigger),
                40-69 → TRANSITIONING, < 40 → RISK_ON                    */
  function _score_regime(vix, dxy, us10y) {
    var s = 0;
    var notes = [];

    /* ─ VIX sanity cap — clamp at 60 to prevent data glitches triggering false RISK_OFF.
       Real VIX all-time high is ~89.53 (March 2020); anything above 65 in normal markets
       is almost certainly a stale or erroneous feed value. ─ */
    if (vix > 60) {
      console.warn('[MacroRegime] VIX ' + vix.toFixed(1) + ' clamped to 60 — likely data error (real ATH ~89.5)');
      notes.push('VIX data-clamped: raw=' + vix.toFixed(1) + ' → 60');
      vix = 60;
    }

    /* ─ VIX level — high VIX alone forces RISK_OFF immediately ─ */
    if (vix >= 60)      { s += 80; notes.push('VIX crisis level (' + vix.toFixed(1) + ')'); }
    else if (vix >= 40) { s += 65; notes.push('VIX extreme (' + vix.toFixed(1) + ')'); }
    else if (vix >= 30) { s += 45; notes.push('VIX very high (' + vix.toFixed(1) + ')'); }
    else if (vix >= 22) { s += 25; notes.push('VIX elevated (' + vix.toFixed(1) + ')'); }
    else if (vix >= 17) { s +=  8; notes.push('VIX slightly elevated (' + vix.toFixed(1) + ')'); }
    else if (vix < 13)  { s -= 10; notes.push('VIX very low (' + vix.toFixed(1) + ')'); }

    /* ─ VIX spike (recent trend) ─ */
    var vixSpike = _trend('vix', 3);
    if (vixSpike > 25)      { s += 20; notes.push('VIX spiking +' + vixSpike.toFixed(0) + '% (3 periods)'); }
    else if (vixSpike > 12) { s += 10; notes.push('VIX rising +' + vixSpike.toFixed(0) + '%'); }
    else if (vixSpike < -15){ s -=  8; notes.push('VIX falling ' + vixSpike.toFixed(0) + '%'); }

    /* ─ DXY trend (rising DXY = flight to dollar = risk-off) ─ */
    var dxyTrend = _trend('dxy', 6);
    if (dxyTrend > 1.5)      { s += 20; notes.push('DXY surging +' + dxyTrend.toFixed(2) + '% (6 periods)'); }
    else if (dxyTrend > 0.7) { s += 12; notes.push('DXY rising +' + dxyTrend.toFixed(2) + '%'); }
    else if (dxyTrend < -0.7){ s -=  8; notes.push('DXY weakening ' + dxyTrend.toFixed(2) + '%'); }

    /* ─ US10Y trend (falling yields = flight to bonds = risk-off) ─ */
    var yieldTrend = _trend('us10y', 6);
    if (yieldTrend < -5)      { s += 15; notes.push('Yields falling fast ' + yieldTrend.toFixed(1) + 'bp'); }
    else if (yieldTrend < -2) { s +=  8; notes.push('Yields falling ' + yieldTrend.toFixed(1) + 'bp'); }
    else if (yieldTrend > 5)  { s -=  5; notes.push('Yields rising ' + yieldTrend.toFixed(1) + 'bp'); }

    /* ─ Options market overlay (VIX term structure + PCR) ─ */
    if (window.OptionsMarket) {
      var optScore = OptionsMarket.riskScore();   // -20 to +20
      if (optScore !== 0) {
        s += optScore;
        var om = OptionsMarket.current();
        if (optScore > 0) {
          notes.push('Options stress: ' + om.tsSignal + ' TS, PCR ' + (om.pcr !== null ? om.pcr.toFixed(2) : '?') + ' (+' + optScore + ')');
        } else {
          notes.push('Options calm: ' + om.tsSignal + ' TS (' + optScore + ')');
        }
      }
    }

    /* ─ Cap score ─ */
    s = Math.max(0, Math.min(100, s));

    return { score: s, notes: notes };
  }

  /* ── Main poll ──────────────────────────────────────────────────────── */
  function _poll() {
    var ctrl = new AbortController();
    var tid  = setTimeout(function () { ctrl.abort(); }, 120000);
    fetch(BACKEND_URL + '/api/market', { signal: ctrl.signal })
      .then(function (res) { clearTimeout(tid); return res.json(); })
      .then(function (data) {
        var vix   = data.VIX   && data.VIX.price   ? parseFloat(data.VIX.price)   : null;
        var dxy   = data.DXY   && data.DXY.price   ? parseFloat(data.DXY.price)   : null;
        var us10y = data.US10Y && data.US10Y.price ? parseFloat(data.US10Y.price) : null;

        if (!vix || !dxy) return;  // no data yet — skip this cycle

        /* Add snapshot to history */
        _history.push({ ts: Date.now(), vix: vix, dxy: dxy, us10y: us10y || 4.0 });
        if (_history.length > HISTORY_MAX) _history.shift();
        _saveHistory();
        _lastPoll = Date.now();

        /* Score regime */
        var result    = _score_regime(vix, dxy, us10y || 4.0);
        var prevScore  = _score;
        var prevRegime = _regime;
        _score   = result.score;
        _details = { vix: vix, dxy: dxy, us10y: us10y, notes: result.notes };

        if      (_score >= 70) _regime = 'RISK_OFF';      // raised 60→70
        else if (_score >= 40) _regime = 'TRANSITIONING'; // raised 35→40
        else                   _regime = 'RISK_ON';

        /* Fire event if regime changed */
        if (_regime !== prevRegime && prevRegime !== 'UNKNOWN') {
          var arrow = _score > prevScore ? '↑' : '↓';
          console.log('[MacroRegime] Regime shift: ' + prevRegime + ' → ' + _regime +
            ' (score ' + prevScore + ' → ' + _score + arrow + ')');
          try {
            window.dispatchEvent(new CustomEvent('regime-change', {
              detail: { from: prevRegime, to: _regime, score: _score }
            }));
          } catch (e) {}
        }

        _renderBadge();
      })
      .catch(function () { clearTimeout(tid); /* backend offline — keep last known regime */ });
  }

  /* ── Dashboard badge ─────────────────────────────────────────────────
     Injects a small regime pill into the EE panel header if it exists.  */
  function _renderBadge() {
    var badge = document.getElementById('macroRegimeBadge');
    if (!badge) return;
    var colours = { RISK_ON: '#00ff88', TRANSITIONING: '#ffaa00', RISK_OFF: '#ff4444', UNKNOWN: '#555' };
    var labels  = { RISK_ON: 'RISK ON', TRANSITIONING: 'TRANSITIONING', RISK_OFF: 'RISK OFF', UNKNOWN: '–' };
    badge.textContent = labels[_regime] || _regime;
    badge.style.color = colours[_regime] || '#aaa';
    badge.title = 'Score: ' + _score + '/100\n' + (_details.notes || []).join('\n') +
                  '\nVIX: ' + (_details.vix || '–') +
                  ' | DXY: ' + (_details.dxy || '–') +
                  ' | US10Y: ' + (_details.us10y || '–') + '%';
  }

  /* ── Public API ─────────────────────────────────────────────────────── */
  var MacroRegime = {

    /* Current regime state — called by EE.canExecute() */
    current: function () {
      return {
        regime:  _regime,
        score:   _score,
        vix:     _details.vix   || null,
        dxy:     _details.dxy   || null,
        us10y:   _details.us10y || null,
        notes:   _details.notes || [],
        lastPoll: _lastPoll
      };
    },

    /* Should a signal be allowed given the current regime?
       Returns { ok: true } or { ok: false, reason: '...' }            */
    checkSignal: function (sig) {
      if (_regime === 'UNKNOWN') return { ok: true }; // no data yet — don't block

      var asset = (sig.asset || '').toUpperCase();
      var dir   = (sig.dir   || '').toUpperCase();

      // Scalper and short-timeframe signals are exempt from regime gating.
      // They have tight stops, <5min hold times, and profit from volatility —
      // RISK_OFF conditions are exactly when scalp setups appear.
      var _isScalper = sig.reason && (
        sig.reason.indexOf('SCALPER') === 0 ||
        sig.reason.indexOf('GII:') === 0
      );
      if (_isScalper) return { ok: true };

      if (_regime === 'RISK_OFF') {
        // Only block risk-asset LONGs in genuine crisis (score >= 70).
        // Extreme Fear (low F&G) is a contrarian buy signal — don't block everything.
        if (dir === 'LONG' && RISK_ASSETS.has(asset)) {
          return { ok: false, reason: 'RISK_OFF regime (score ' + _score + ') — LONG on ' + asset + ' blocked; only safe-havens or shorts allowed' };
        }
      }

      if (_regime === 'TRANSITIONING') {
        // Reduced premium 10%→5%: less friction during uncertain conditions
        var cfgMin = (window.EE && EE.getConfig) ? EE.getConfig().min_confidence : 55;
        var required = cfgMin + 5;
        if ((sig.conf || 0) < required) {
          return { ok: false, reason: 'TRANSITIONING regime — conf ' + sig.conf + '% < ' + required + '% (normal ' + cfgMin + '% + 5% premium)' };
        }
      }

      return { ok: true };
    },

    isSafeHaven: function (asset) { return SAFE_HAVEN.has((asset || '').toUpperCase()); },
    isRiskAsset: function (asset) { return RISK_ASSETS.has((asset || '').toUpperCase()); },

    /* Force an immediate poll (useful after reconnect) */
    refresh: function () { _poll(); },

    /* Human-readable status for console inspection */
    status: function () {
      var r = MacroRegime.current();
      return '[MacroRegime] ' + r.regime + ' (score ' + r.score + '/100)' +
        (r.vix ? ' | VIX ' + r.vix.toFixed(1) : '') +
        (r.dxy ? ' | DXY ' + r.dxy.toFixed(2) : '') +
        (r.us10y ? ' | US10Y ' + r.us10y.toFixed(2) + '%' : '') +
        (r.notes.length ? '\n  ' + r.notes.join('\n  ') : '');
    }
  };

  /* ── Boot ────────────────────────────────────────────────────────────── */
  _loadHistory();
  window.MacroRegime = MacroRegime;

  /* First poll after 3s (let backend warm up), then every 5 min */
  setTimeout(_poll, 3000);
  setInterval(_poll, POLL_MS);

  /* Re-render badge whenever the EE UI updates */
  window.addEventListener('regime-change', _renderBadge);

  console.log('[MacroRegime] Loaded — regime classifier active');

})();
