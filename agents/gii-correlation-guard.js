/**
 * GII Correlation Guard Agent
 *
 * Prevents the portfolio from building up hidden correlated exposure.
 * The EE already has a basic "one asset per static group" check — this agent
 * extends it with:
 *   1. A richer, wider correlation group map (more assets)
 *   2. A portfolio notional concentration limit per group (max 40%)
 *   3. A dynamic decorrelation matrix updated from live price returns
 *   4. A public API so the dashboard can display current concentration
 *
 * Public API:
 *   GII_CORRELATION_GUARD.check(sig, openTrades)   → { ok, reason }
 *   GII_CORRELATION_GUARD.concentration()          → per-group notional %
 *   GII_CORRELATION_GUARD.updateMatrix(matrix)     → called by correlation-agent
 *   GII_CORRELATION_GUARD.groups()                 → current group map
 */
(function () {
  'use strict';

  /* ── Correlation groups ─────────────────────────────────────────────────── */
  /* Assets within a group are treated as highly correlated.
     Rules:
       - Max 2 same-direction trades from the same group at once
       - Max 40% of total open notional from one group
     Exception: scalper signals are exempt (tight stops, short hold) */
  var GROUPS = {
    'crypto-major': ['BTC','ETH','SOL','BNB','AVAX','ATOM','DOT','MATIC','LINK'],
    'crypto-meme':  ['DOGE','PEPE','BONK','SHIB'],
    'crypto-mid':   ['XRP','ADA','LTC','BCH'],
    'energy':       ['WTI','BRENT','XLE','OIL','CRUDE','UNG','XOM'],
    'safe-haven':   ['GLD','XAU','PAXG','GDX','SLV','TLT'],
    'us-equity':    ['SPY','QQQ','NVDA','TSLA','AAPL','META','GOOGL','MSFT','AMD'],
    'defense':      ['LMT','RTX','NOC','GD','BA'],
    'tech-semi':    ['TSM','NVDA','AMD','INTC','QCOM'],
    'volatility':   ['VXX','UVXY'],
    'forex-usd':    ['DXY','EURUSD','GBPUSD','USDJPY'],
  };

  var MAX_SAME_DIR     = 2;     // max same-direction trades per group
  var MAX_NOTIONAL_PCT = 40;    // max % of total notional in one group

  /* ── Dynamic decorrelation matrix ──────────────────────────────────────── */
  /* Format: { BTC: { ETH: true } } → BTC/ETH are currently decorrelated (Pearson < 0.3) */
  var _decorrMatrix = {};

  /* ── Asset → group lookup ────────────────────────────────────────────────  */
  var _assetGroup = {};
  Object.keys(GROUPS).forEach(function (gname) {
    GROUPS[gname].forEach(function (a) { _assetGroup[a] = gname; });
  });

  function _normalise(a) { return (a || '').toUpperCase().trim(); }

  /* Returns the peers in the same group as `asset`, minus any that are
     dynamically decorrelated from it. Returns null if not in any group. */
  function _peers(asset) {
    var a = _normalise(asset);
    var gname = _assetGroup[a];
    if (!gname) return null;
    var members = GROUPS[gname];
    var decorrForA = _decorrMatrix[a] || {};
    return members.filter(function (m) { return m !== a && !decorrForA[m]; });
  }

  /* ── Main check ─────────────────────────────────────────────────────────── */
  /**
   * Returns { ok: bool, reason: string }
   * Called from EE canExecute() before opening a trade.
   */
  function check(sig, openTrades) {
    if (!sig || !openTrades) return { ok: true, reason: '' };

    var asset     = _normalise(sig.asset);
    var dir       = (sig.dir || sig.bias || '').toUpperCase();
    var normDir   = (dir === 'BUY' || dir === 'LONG') ? 'LONG' : 'SHORT';
    var isScalper = !!(sig.reason && (sig.reason.indexOf('SCALPER') === 0 || sig.reason.indexOf('GII:') === 0));

    /* Scalpers exempt from group limit (tight stops, short hold times) */
    var peers = _peers(asset);
    if (peers && !isScalper) {
      /* Rule 1: max 2 same-direction trades per group */
      var sameDirPeers = openTrades.filter(function (t) {
        return peers.indexOf(_normalise(t.asset)) !== -1 && t.direction === normDir;
      });
      if (sameDirPeers.length >= MAX_SAME_DIR) {
        return { ok: false, reason: 'Corr-group ' + _assetGroup[asset] + ': already ' +
                 sameDirPeers.length + '× ' + normDir + ' (' +
                 sameDirPeers.map(function(t){ return t.asset; }).join(', ') + ')' };
      }
    }

    /* Rule 2: max notional concentration (applies regardless of scalper) */
    var totalNotional = openTrades.reduce(function (s, t) { return s + (t.size_usd || 0); }, 0);
    if (totalNotional > 0 && peers) {
      var groupNotional = openTrades.reduce(function (s, t) {
        return peers.indexOf(_normalise(t.asset)) !== -1 ? s + (t.size_usd || 0) : s;
      }, 0);
      var pct = (groupNotional / totalNotional) * 100;
      if (pct >= MAX_NOTIONAL_PCT) {
        return { ok: false, reason: 'Corr-group ' + _assetGroup[asset] + ': ' +
                 pct.toFixed(0) + '% of portfolio notional (max ' + MAX_NOTIONAL_PCT + '%)' };
      }
    }

    return { ok: true, reason: '' };
  }

  /* ── Concentration report ────────────────────────────────────────────────  */
  /** Returns per-group notional percentages given current open trades. */
  function concentration(openTrades) {
    if (!openTrades || !openTrades.length) return {};
    var total = openTrades.reduce(function (s, t) { return s + (t.size_usd || 0); }, 0);
    if (!total) return {};
    var result = {};
    Object.keys(GROUPS).forEach(function (gname) {
      var members = GROUPS[gname];
      var gNotional = openTrades.reduce(function (s, t) {
        return members.indexOf(_normalise(t.asset)) !== -1 ? s + (t.size_usd || 0) : s;
      }, 0);
      if (gNotional > 0) result[gname] = +(gNotional / total * 100).toFixed(1);
    });
    return result;
  }

  /* ── Dynamic matrix update ───────────────────────────────────────────────  */
  /* Called by the correlation-agent with its Pearson matrix.
     Any pair with Pearson < 0.30 is marked as decorrelated. */
  function updateMatrix(matrix) {
    if (!matrix) return;
    _decorrMatrix = {};
    Object.keys(matrix).forEach(function (a) {
      Object.keys(matrix[a] || {}).forEach(function (b) {
        var r = matrix[a][b];
        if (typeof r === 'number' && r < 0.30) {
          if (!_decorrMatrix[a]) _decorrMatrix[a] = {};
          _decorrMatrix[a][b] = true;
        }
      });
    });
    /* Also expose for EE's _getCorrGroup dynamic filter */
    window._dynamicDecorrMatrix = _decorrMatrix;
  }

  /* Expose the extended group map so EE can use it */
  function groups() { return GROUPS; }

  window.GII_CORRELATION_GUARD = {
    check:         check,
    concentration: concentration,
    updateMatrix:  updateMatrix,
    groups:        groups,
  };

  /* Sync extended groups into EE's CORR_GROUPS on load
     (EE initialises CORR_GROUPS at parse time before this file loads,
      so we extend it after the fact via the existing _assetGroup map) */
  setTimeout(function () {
    if (window._dynamicDecorrMatrix === undefined) {
      window._dynamicDecorrMatrix = _decorrMatrix;
    }
  }, 500);

  console.log('[GII-CORRELATION-GUARD] Correlation guard agent loaded');
})();
