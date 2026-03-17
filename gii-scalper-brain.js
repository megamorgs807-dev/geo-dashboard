/* GII Scalper Brain — gii-scalper-brain.js v1
 *
 * Shared intelligence hub for all scalping agents.
 * Aggregates cross-agent feedback, provides inherited knowledge to new instances,
 * detects cross-asset sector alignment, and adapts setup weights based on what's
 * actually been working across ALL scalpers (not just one).
 *
 * Load order: before gii-scalper.js, gii-scalper-session.js, gii-scraper-manager.js
 * Exposes: window.GII_SCALPER_BRAIN
 */
(function () {
  'use strict';

  var BRAIN_KEY        = 'gii_brain_v1';
  var MIN_RECORDS      = 5;      // records needed before adjusting weights
  var SIGNAL_TTL_MS    = 4 * 60 * 60 * 1000;  // 4h — clear stale live signals
  var MAX_SETUP_BOOST  = 1.30;
  var MIN_SETUP_BOOST  = 0.65;

  // ── state ─────────────────────────────────────────────────────────────────

  // setupStats: keyed by "sector_setupType_gtiRegime"
  // e.g. 'precious_mean_reversion_moderate' → { total, correct, wr }
  var _setupStats = {};

  // assetStats: keyed by "ASSET_dir"
  // e.g. 'XAU_long' → { total, correct, wr }
  // This is the cross-instance aggregate — retired scraper instances feed into here
  var _assetStats = {};

  // Live signals from scalpers this cycle (for sector alignment detection)
  // keyed by asset: { asset, sector, dir, ts }
  var _liveSignals = {};

  var _analytics = { totalRecorded: 0, lastUpdate: 0, topSetups: [] };

  // ── persistence ───────────────────────────────────────────────────────────

  function _load() {
    try {
      var raw = localStorage.getItem(BRAIN_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      _setupStats = d.setupStats || {};
      _assetStats = d.assetStats || {};
    } catch (e) { _setupStats = {}; _assetStats = {}; }
  }

  function _save() {
    try {
      localStorage.setItem(BRAIN_KEY, JSON.stringify({
        setupStats: _setupStats,
        assetStats: _assetStats
      }));
    } catch (e) {}
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  function _setupKey(sector, setupType, gtiRegime) {
    return (sector || 'unknown') + '_' + (setupType || 'unknown') + '_' + (gtiRegime || 'normal');
  }

  function _assetKey(asset, dir) {
    return (asset || '').toUpperCase() + '_' + (dir || 'long').toLowerCase();
  }

  function _getGtiRegime() {
    try {
      if (!window.GII || typeof GII.gti !== 'function') return 'normal';
      var g = GII.gti();
      var v = (g && typeof g.value === 'number') ? g.value : (typeof g === 'number' ? g : 0);
      if (v >= 80) return 'extreme';
      if (v >= 60) return 'high';
      if (v >= 30) return 'moderate';
      return 'normal';
    } catch (e) { return 'normal'; }
  }

  function _wrBoost(wr, total) {
    if (total < MIN_RECORDS) return 1.0;
    if (wr >= 0.72) return MAX_SETUP_BOOST;
    if (wr >= 0.62) return 1.15;
    if (wr >= 0.52) return 1.06;
    if (wr < 0.33)  return MIN_SETUP_BOOST;
    if (wr < 0.43)  return 0.82;
    return 1.0;
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * recordOutcome — called by every scalper's onTradeResult.
   * trade: { asset, dir, pnl_usd (or pnl/profit) }
   * meta:  { sector, setupType, gtiRegime }
   */
  function recordOutcome(trade, meta) {
    if (!trade) return;
    var asset  = (trade.asset || trade.ticker || '').toUpperCase();
    var dir    = (trade.dir || trade.direction || 'long').toLowerCase();
    if (dir !== 'long' && dir !== 'short') dir = 'long';
    var pnl    = trade.pnl_usd !== undefined ? trade.pnl_usd : (trade.pnl || trade.profit || 0);
    var won    = pnl > 0;

    // Setup-level stats
    var sector    = (meta && meta.sector)    || 'unknown';
    var setupType = (meta && meta.setupType) || 'unknown';
    var regime    = (meta && meta.gtiRegime) || _getGtiRegime();
    var sKey      = _setupKey(sector, setupType, regime);
    if (!_setupStats[sKey]) _setupStats[sKey] = { total: 0, correct: 0, wr: 0 };
    _setupStats[sKey].total++;
    if (won) _setupStats[sKey].correct++;
    _setupStats[sKey].wr = _setupStats[sKey].correct / _setupStats[sKey].total;

    // Asset-level stats (cross-instance aggregate)
    var aKey = _assetKey(asset, dir);
    if (!_assetStats[aKey]) _assetStats[aKey] = { total: 0, correct: 0, wr: 0, lastTs: null };
    _assetStats[aKey].total++;
    if (won) _assetStats[aKey].correct++;
    _assetStats[aKey].wr     = _assetStats[aKey].correct / _assetStats[aKey].total;
    _assetStats[aKey].lastTs = new Date().toISOString();

    _analytics.totalRecorded++;
    _analytics.lastUpdate = Date.now();
    _save();
    _rebuildTopSetups();
  }

  /**
   * getSetupBoost — multiplier applied to raw indicator score before confidence.
   * Returns 0.65–1.30 based on how well this setup type has been performing.
   */
  function getSetupBoost(sector, setupType, gtiRegime) {
    var key = _setupKey(sector, setupType, gtiRegime || _getGtiRegime());
    var s   = _setupStats[key];
    if (!s || s.total < MIN_RECORDS) return 1.0;
    return _wrBoost(s.wr, s.total);
  }

  /**
   * inheritFeedback — called when scraper manager spawns a new instance.
   * Returns historical asset win rates from ALL past instances, not just current session.
   */
  function inheritFeedback(asset) {
    var asset = (asset || '').toUpperCase();
    var result = {};
    ['long', 'short'].forEach(function (dir) {
      var aKey = _assetKey(asset, dir);
      var s    = _assetStats[aKey];
      if (s && s.total >= 3) {
        result[dir] = { total: s.total, correct: s.correct, winRate: s.wr, lastTs: s.lastTs };
      }
    });
    return (result.long || result.short) ? result : null;
  }

  /**
   * noteSignal — called when a scalper fires a signal.
   * Records it so getSectorAlignment can detect cross-asset confirmation.
   */
  function noteSignal(asset, sector, dir) {
    _liveSignals[(asset || '').toUpperCase()] = {
      asset:  (asset || '').toUpperCase(),
      sector: sector || 'unknown',
      dir:    dir || 'neutral',
      ts:     Date.now()
    };
  }

  /**
   * clearSignal — called when a trade closes or a slot expires.
   */
  function clearSignal(asset) {
    delete _liveSignals[(asset || '').toUpperCase()];
  }

  /**
   * getSectorAlignment — checks whether other assets in the same sector are
   * signalling the same direction. Returns 0.0–0.8 strength value.
   * A non-zero return means: boost confidence by (strength × 0.08).
   */
  function getSectorAlignment(asset, sector, dir) {
    if (!asset || !sector || !dir) return 0;
    var thisAsset = (asset || '').toUpperCase();
    var now       = Date.now();
    var sameDir   = 0;
    var total     = 0;

    Object.keys(_liveSignals).forEach(function (k) {
      var sig = _liveSignals[k];
      // Prune stale signals
      if (now - sig.ts > SIGNAL_TTL_MS) { delete _liveSignals[k]; return; }
      if (sig.asset === thisAsset) return; // skip self
      if (sig.sector !== sector)   return; // different sector
      total++;
      if (sig.dir === dir) sameDir++;
    });

    if (total === 0 || sameDir === 0) return 0;
    // Strength = fraction of same-sector signals that agree, capped at 0.80
    return Math.min(0.80, (sameDir / Math.max(1, total)) * 0.80);
  }

  // ── analytics helpers ─────────────────────────────────────────────────────

  function _rebuildTopSetups() {
    var entries = Object.keys(_setupStats).map(function (k) {
      var s    = _setupStats[k];
      var parts = k.split('_');
      return { key: k, sector: parts[0], setupType: parts[1], regime: parts[2],
               total: s.total, wr: s.wr, boost: _wrBoost(s.wr, s.total) };
    }).filter(function (e) { return e.total >= MIN_RECORDS; });

    entries.sort(function (a, b) { return b.wr - a.wr; });
    _analytics.topSetups = entries.slice(0, 8);
  }

  // ── status / analytics ────────────────────────────────────────────────────

  function status() {
    var setupKeys  = Object.keys(_setupStats).filter(function (k) { return _setupStats[k].total >= MIN_RECORDS; });
    var assetKeys  = Object.keys(_assetStats).filter(function (k) { return _assetStats[k].total >= 3; });
    var liveCount  = Object.keys(_liveSignals).length;
    return {
      totalRecorded:  _analytics.totalRecorded,
      lastUpdate:     _analytics.lastUpdate,
      setupsTracked:  Object.keys(_setupStats).length,
      setupsQualified:setupKeys.length,
      assetsTracked:  assetKeys.length,
      liveSignals:    liveCount
    };
  }

  function analytics() {
    return {
      topSetups:   _analytics.topSetups.slice(),
      setupStats:  Object.assign({}, _setupStats),
      assetStats:  Object.assign({}, _assetStats),
      liveSignals: Object.assign({}, _liveSignals)
    };
  }

  // ── expose ────────────────────────────────────────────────────────────────

  window.GII_SCALPER_BRAIN = {
    recordOutcome:       recordOutcome,
    getSetupBoost:       getSetupBoost,
    inheritFeedback:     inheritFeedback,
    noteSignal:          noteSignal,
    clearSignal:         clearSignal,
    getSectorAlignment:  getSectorAlignment,
    status:              status,
    analytics:           analytics
  };

  // ── init ──────────────────────────────────────────────────────────────────

  _load();
  _rebuildTopSetups();
  console.info('[SCALPER BRAIN] Initialised — ' +
    Object.keys(_setupStats).length + ' setup keys, ' +
    Object.keys(_assetStats).length + ' asset keys loaded from storage');

}());
