/**
 * GII Sentiment & News Agent
 *
 * Aggregates headline sentiment across all IC/social signal sources,
 * tracks velocity (rate of change per asset), detects sentiment surges,
 * and emits EE signals when strong directional news flow emerges.
 *
 * Also provides checkTrade(sig) for the execution pipeline to
 * boost confidence on news-corroborated signals or block trades
 * into strongly negative news flow.
 *
 * Public API:
 *   GII_SENTIMENT_NEWS.getSentiment(asset)  → { score, velocity, label, count }
 *   GII_SENTIMENT_NEWS.checkTrade(sig)      → { ok, boostPct, penaltyPct, reason }
 *   GII_SENTIMENT_NEWS.headlines()          → recent headline array
 */
(function () {
  'use strict';

  /* ── Asset aliases for normalisation ────────────────────────────────────── */
  var ASSET_ALIASES = {
    BITCOIN: 'BTC', ETHEREUM: 'ETH', SOLANA: 'SOL', RIPPLE: 'XRP',
    GOLD: 'GLD', OIL: 'WTI', 'CRUDE OIL': 'WTI', 'S&P': 'SPY',
    NVIDIA: 'NVDA', TESLA: 'TSLA',
  };

  /* Sector → assets mapping for "macro sentiment" that isn't asset-specific */
  var SECTOR_ASSETS = {
    crypto:  ['BTC','ETH','SOL'],
    energy:  ['WTI','BRENT'],
    equity:  ['SPY','QQQ'],
    precious:['GLD','XAU'],
  };

  var SENTIMENT_SOURCES = [
    'GII_AGENT_SOCIAL',
    'GII_AGENT_NARRATIVE',
    'GII_AGENT_POLYMARKET',
    'GII_AGENT_ESCALATION',
    'GII_AGENT_DEESCALATION',
  ];

  /* Rolling window: keep headlines for 30 minutes */
  var WINDOW_MS = 30 * 60 * 1000;
  /* Surge: 3+ same-direction events for an asset within 10 minutes */
  var SURGE_WINDOW_MS = 10 * 60 * 1000;
  var SURGE_MIN_COUNT = 3;

  /* ── State ──────────────────────────────────────────────────────────────── */
  var _headlines = [];   // [{ ts, asset, dir, score, source, text }]
  var _lastPoll  = 0;
  var _surgeLog  = {};   // asset → last surge ts (cooldown 15 min per asset)

  /* ── Helpers ────────────────────────────────────────────────────────────── */
  function _normaliseAsset(a) {
    if (!a) return '';
    var u = a.toUpperCase().trim();
    return ASSET_ALIASES[u] || u;
  }

  function _prune() {
    var cutoff = Date.now() - WINDOW_MS;
    _headlines = _headlines.filter(function (h) { return h.ts >= cutoff; });
  }

  /* Convert a raw signal from a sentiment/social agent into a headline entry */
  function _sigToHeadline(sig, sourceName) {
    if (!sig) return null;
    var asset = _normaliseAsset(sig.asset || sig.coin || '');
    if (!asset) return null;
    var dir = (sig.dir || sig.bias || '').toUpperCase();
    if (dir !== 'LONG' && dir !== 'SHORT' && dir !== 'BUY' && dir !== 'SELL') return null;
    var normDir = (dir === 'BUY' || dir === 'LONG') ? 'LONG' : 'SHORT';
    var conf = sig.conf || sig.confidence || 0;
    if (conf > 1) conf /= 100;
    return {
      ts:     sig.ts || Date.now(),
      asset:  asset,
      dir:    normDir,
      score:  conf,
      source: sourceName,
      text:   sig.reason || sig.text || sig.note || '',
    };
  }

  /* ── Poll all sentiment sources ─────────────────────────────────────────── */
  function _poll() {
    _prune();
    var added = 0;
    SENTIMENT_SOURCES.forEach(function (name) {
      var ag = window[name];
      if (!ag || typeof ag.signals !== 'function') return;
      var sigs = [];
      try { sigs = ag.signals() || []; } catch(e) { return; }
      sigs.forEach(function (s) {
        /* Skip if we already have this signal (same asset+ts+source) */
        var h = _sigToHeadline(s, name);
        if (!h) return;
        var dup = _headlines.some(function (x) {
          return x.source === h.source && x.asset === h.asset &&
                 Math.abs(x.ts - h.ts) < 5000;
        });
        if (!dup) { _headlines.push(h); added++; }
      });
    });

    /* Also read GII_AGENT_CONFLICT as news (geopolitical = relevant sentiment) */
    try {
      if (window.GII_AGENT_CONFLICT && typeof GII_AGENT_CONFLICT.signals === 'function') {
        (GII_AGENT_CONFLICT.signals() || []).forEach(function (s) {
          var h = _sigToHeadline(s, 'GII_AGENT_CONFLICT');
          if (!h) return;
          var dup = _headlines.some(function (x) {
            return x.source === h.source && x.asset === h.asset && Math.abs(x.ts - h.ts) < 5000;
          });
          if (!dup) { _headlines.push(h); added++; }
        });
      }
    } catch(e) {}

    if (added > 0) _detectSurges();

    _lastPoll = Date.now();
  }

  /* ── Surge detection → emit EE signals ─────────────────────────────────── */
  function _detectSurges() {
    var now = Date.now();
    var surgeWindow = now - SURGE_WINDOW_MS;
    var surgeCooldown = 15 * 60 * 1000;

    /* Group recent headlines by asset+dir */
    var groups = {};
    _headlines.filter(function (h) { return h.ts >= surgeWindow; }).forEach(function (h) {
      var key = h.asset + '|' + h.dir;
      if (!groups[key]) groups[key] = [];
      groups[key].push(h);
    });

    Object.keys(groups).forEach(function (key) {
      var parts = key.split('|');
      var asset = parts[0], dir = parts[1];
      var items = groups[key];
      if (items.length < SURGE_MIN_COUNT) return;

      /* Check cooldown */
      var coolKey = asset + '_' + dir;
      if (_surgeLog[coolKey] && (now - _surgeLog[coolKey]) < surgeCooldown) return;
      _surgeLog[coolKey] = now;

      /* Average confidence of surge items */
      var avgConf = items.reduce(function (s, h) { return s + h.score; }, 0) / items.length;
      var confPct = Math.min(95, Math.round(avgConf * 100) + 5); // small boost for consensus

      /* Emit to EE */
      if (window.EE && typeof EE.onSignals === 'function') {
        EE.onSignals([{
          asset:    asset,
          dir:      dir,
          conf:     confPct,
          source:   'sentiment-news',
          srcCount: items.length,
          reason:   'SENTIMENT SURGE: ' + items.length + ' ' + dir.toLowerCase() +
                    ' signals in 10min (' + items.map(function(h){ return h.source.replace('GII_AGENT_',''); }).join(', ') + ')',
          region:   'GLOBAL',
        }]);
      }
    });
  }

  /* ── Public API ─────────────────────────────────────────────────────────── */

  /**
   * Returns sentiment summary for an asset over the last 30 minutes.
   * { score: -1…1, velocity: number, label: string, count: number }
   */
  function getSentiment(asset) {
    _prune();
    var a = _normaliseAsset(asset);
    var relevant = _headlines.filter(function (h) { return h.asset === a; });
    if (!relevant.length) return { score: 0, velocity: 0, label: 'NEUTRAL', count: 0 };

    var longScore = 0, shortScore = 0;
    relevant.forEach(function (h) {
      if (h.dir === 'LONG')  longScore  += h.score;
      if (h.dir === 'SHORT') shortScore += h.score;
    });
    var total = longScore + shortScore;
    var score = total > 0 ? (longScore - shortScore) / total : 0; // -1…1

    /* Velocity: compare last 5 min vs prior 25 min */
    var now = Date.now();
    var recent = relevant.filter(function (h) { return h.ts >= now - 5 * 60 * 1000; });
    var older  = relevant.filter(function (h) { return h.ts <  now - 5 * 60 * 1000; });
    var recentRate = recent.length / 5;
    var olderRate  = older.length > 0 ? older.length / 25 : 0;
    var velocity   = +(recentRate - olderRate).toFixed(2);

    var label = score > 0.3 ? 'BULLISH' : score < -0.3 ? 'BEARISH' : 'NEUTRAL';
    if (Math.abs(score) > 0.6) label = 'STRONG_' + label.split('_').pop();

    return { score: +score.toFixed(2), velocity: velocity, label: label, count: relevant.length };
  }

  /**
   * Returns { ok, boostPct, penaltyPct, reason } for use in EE signal pipeline.
   * boostPct   → add to sig.conf when news confirms signal direction
   * penaltyPct → subtract from sig.conf when news contradicts
   * ok=false   → signal should be skipped (strong opposing news surge)
   */
  function checkTrade(sig) {
    if (!sig) return { ok: true, boostPct: 0, penaltyPct: 0, reason: '' };

    var asset   = _normaliseAsset(sig.asset || '');
    var dir     = (sig.dir || sig.bias || '').toUpperCase();
    var normDir = (dir === 'BUY' || dir === 'LONG') ? 'LONG' : 'SHORT';
    var oppDir  = normDir === 'LONG' ? 'SHORT' : 'LONG';
    var sent    = getSentiment(asset);

    /* Strong opposing surge in last 10 min → block */
    var now = Date.now();
    var recentOpposing = _headlines.filter(function (h) {
      return h.asset === asset && h.dir === oppDir && h.ts >= now - SURGE_WINDOW_MS;
    });
    if (recentOpposing.length >= SURGE_MIN_COUNT) {
      return { ok: false, boostPct: 0, penaltyPct: 0,
        reason: 'News surge against trade: ' + recentOpposing.length +
                ' ' + oppDir.toLowerCase() + ' headlines in 10min' };
    }

    var boost   = 0;
    var penalty = 0;
    var reasons = [];

    /* Sentiment confirms direction */
    if (sent.label === 'BULLISH' && normDir === 'LONG') {
      boost += Math.min(6, Math.round(Math.abs(sent.score) * 8));
      reasons.push('news BULLISH (' + sent.count + ' signals)');
    } else if (sent.label === 'BEARISH' && normDir === 'SHORT') {
      boost += Math.min(6, Math.round(Math.abs(sent.score) * 8));
      reasons.push('news BEARISH (' + sent.count + ' signals)');
    }

    /* Sentiment contradicts direction */
    if (sent.label === 'BEARISH' && normDir === 'LONG') {
      penalty += Math.min(8, Math.round(Math.abs(sent.score) * 10));
      reasons.push('news BEARISH vs LONG');
    } else if (sent.label === 'BULLISH' && normDir === 'SHORT') {
      penalty += Math.min(8, Math.round(Math.abs(sent.score) * 10));
      reasons.push('news BULLISH vs SHORT');
    }

    /* Velocity boost — news accelerating in trade direction */
    if (sent.velocity > 0.5 &&
        ((sent.score > 0 && normDir === 'LONG') || (sent.score < 0 && normDir === 'SHORT'))) {
      boost += 3;
      reasons.push('sentiment accelerating');
    }

    return {
      ok:         true,
      boostPct:   boost,
      penaltyPct: penalty,
      reason:     reasons.join(', '),
    };
  }

  function headlines() { _prune(); return _headlines.slice(); }

  /* Poll every 3 minutes */
  _poll();
  setInterval(_poll, 3 * 60 * 1000);

  window.GII_SENTIMENT_NEWS = {
    getSentiment: getSentiment,
    checkTrade:   checkTrade,
    headlines:    headlines,
    refresh:      _poll,
  };

  console.log('[GII-SENTIMENT-NEWS] Sentiment & news agent loaded');
})();
