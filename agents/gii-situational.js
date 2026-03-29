/**
 * GII Situational Awareness Agent
 *
 * Maintains a live "world-state" context object updated every 5 minutes.
 * Used by the execution pipeline to gate/penalise automated signals that
 * contradict the current macro/geopolitical environment.
 *
 * Public API:
 *   GII_SITUATIONAL.checkAlignment(sig)  → { ok, penaltyPct, reason }
 *   GII_SITUATIONAL.getContext()         → snapshot of current world state
 *   GII_SITUATIONAL.refresh()            → force immediate update
 */
(function () {
  'use strict';

  /* ── Sector map (asset → sector) ───────────────────────────────────────── */
  var SECTOR_MAP = {
    BTC:'crypto', ETH:'crypto', SOL:'crypto', BNB:'crypto', AVAX:'crypto',
    XRP:'crypto', ADA:'crypto', DOGE:'crypto', ATOM:'crypto', DOT:'crypto',
    MATIC:'crypto', LINK:'crypto', PEPE:'crypto', BONK:'crypto', SHIB:'crypto',
    WTI:'energy', BRENT:'energy', XLE:'energy', OIL:'energy', CRUDE:'energy',
    NATGAS:'energy', UNG:'energy',
    GLD:'precious', XAU:'precious', GDX:'precious', SLV:'precious',
    SPY:'equity', QQQ:'equity', NVDA:'equity', TSLA:'equity', AAPL:'equity',
    META:'equity', GOOGL:'equity', MSFT:'equity', AMD:'equity',
    LMT:'defense', RTX:'defense', NOC:'defense', GD:'defense', BA:'defense',
    TSM:'tech-semi',
    EURUSD:'forex', GBPUSD:'forex', USDJPY:'forex', DXY:'forex',
    TLT:'bonds', VXX:'volatility',
  };

  var RISK_ASSETS = [
    'BTC','ETH','SOL','BNB','AVAX','XRP','ADA','DOGE','ATOM','DOT','MATIC','LINK',
    'SPY','QQQ','NVDA','TSLA','AAPL','META','GOOGL','MSFT','AMD','TSM'
  ];

  /* Agents that publish sector-level directional signals */
  var SECTOR_FEEDS = [
    { global: 'GII_AGENT_ENERGY',        sector: 'energy'   },
    { global: 'GII_AGENT_MACRO',         sector: ['equity','forex','precious','bonds'] },
    { global: 'GII_AGENT_CRYPTO_SIGNALS',sector: 'crypto'   },
    { global: 'GII_AGENT_ONCHAIN',       sector: 'crypto'   },
    { global: 'GII_AGENT_SMARTMONEY',    sector: ['equity','crypto'] },
  ];

  /* ── Live context ───────────────────────────────────────────────────────── */
  var _ctx = {
    gti:             0,
    gtiLevel:        'NORMAL',
    dominantBias:    {},   // sector → { dir, strength, longScore, shortScore }
    nextEvent:       null, // { name, country, minutesAway }
    regimeWarnings:  [],   // string tags
    activeConflicts: [],   // region names
    vix:             0,
    lastUpdate:      0,
  };

  /* ── Update routine ─────────────────────────────────────────────────────── */
  function _update() {
    try {
      /* GTI */
      if (window.GII && typeof GII.gti === 'function') {
        _ctx.gti = GII.gti() || 0;
        try { _ctx.gtiLevel = (GII.status() || {}).gtiLevel || 'NORMAL'; } catch(e) {}
      }

      /* VIX */
      _ctx.vix = 0;
      try {
        if (window.VIXFeed && typeof VIXFeed.current === 'function')
          _ctx.vix = VIXFeed.current() || 0;
      } catch(e) {}

      /* Regime warnings */
      _ctx.regimeWarnings = [];
      if (_ctx.vix > 35)      _ctx.regimeWarnings.push('VIX_EXTREME');
      else if (_ctx.vix > 25) _ctx.regimeWarnings.push('VIX_ELEVATED');
      if (_ctx.gti > 75)      _ctx.regimeWarnings.push('GTI_HIGH');
      if (_ctx.gti > 85)      _ctx.regimeWarnings.push('GTI_EXTREME');
      try {
        if (window.MacroRegime) {
          var mr = (MacroRegime.current() || {}).regime || '';
          if (mr === 'CRISIS' || mr === 'RISK_OFF') _ctx.regimeWarnings.push('MACRO_' + mr);
        }
      } catch(e) {}

      /* Active conflict regions */
      _ctx.activeConflicts = [];
      try {
        if (window.GII_AGENT_CONFLICT && typeof GII_AGENT_CONFLICT.signals === 'function') {
          (GII_AGENT_CONFLICT.signals() || []).forEach(function (s) {
            if (s.region && _ctx.activeConflicts.indexOf(s.region) === -1)
              _ctx.activeConflicts.push(s.region);
          });
        }
      } catch(e) {}

      /* Dominant bias per sector */
      var raw = {};
      SECTOR_FEEDS.forEach(function (feed) {
        var ag = window[feed.global];
        if (!ag || typeof ag.signals !== 'function') return;
        var sigs = [];
        try { sigs = ag.signals() || []; } catch(e) { return; }
        var sectors = Array.isArray(feed.sector) ? feed.sector : [feed.sector];
        sectors.forEach(function (sec) {
          if (!raw[sec]) raw[sec] = { long: 0, short: 0, n: 0 };
          sigs.forEach(function (s) {
            var d = (s.dir || s.bias || '').toUpperCase();
            var c = s.conf || s.confidence || 0;
            if (c > 1) c /= 100;
            if (d === 'LONG'  || d === 'BUY')  { raw[sec].long  += c; raw[sec].n++; }
            if (d === 'SHORT' || d === 'SELL') { raw[sec].short += c; raw[sec].n++; }
          });
        });
      });
      _ctx.dominantBias = {};
      Object.keys(raw).forEach(function (sec) {
        var b = raw[sec];
        if (b.n === 0) return;
        var diff = b.long - b.short;
        var strength = Math.min(1, Math.abs(diff) / Math.max(1, b.n * 0.5));
        _ctx.dominantBias[sec] = {
          dir:        Math.abs(diff) < 0.08 ? 'NEUTRAL' : (diff > 0 ? 'LONG' : 'SHORT'),
          strength:   +strength.toFixed(2),
          longScore:  +b.long.toFixed(2),
          shortScore: +b.short.toFixed(2),
        };
      });

      /* Next major economic event */
      _ctx.nextEvent = null;
      try {
        if (window.ECON_CALENDAR && typeof ECON_CALENDAR.imminent === 'function') {
          var ev = ECON_CALENDAR.imminent();
          if (ev) {
            var mins = ev.minutesAway != null ? ev.minutesAway
                       : Math.round((ev.ts - Date.now()) / 60000);
            _ctx.nextEvent = { name: ev.title || ev.name, country: ev.country, minutesAway: mins };
          }
        }
      } catch(e) {}
      if (!_ctx.nextEvent) {
        try {
          if (window.GII_AGENT_CALENDAR && typeof GII_AGENT_CALENDAR.upcoming === 'function') {
            var up = (GII_AGENT_CALENDAR.upcoming() || [])[0];
            if (up) {
              var m2 = up.minutesAway != null ? up.minutesAway
                       : Math.round((up.ts - Date.now()) / 60000);
              if (m2 > 0 && m2 < 120)
                _ctx.nextEvent = { name: up.title || up.name, country: up.country, minutesAway: m2 };
            }
          }
        } catch(e) {}
      }

      _ctx.lastUpdate = Date.now();
    } catch(e) {
      console.warn('[GII-SITUATIONAL] update error:', e);
    }
  }

  /* ── Signal alignment check ─────────────────────────────────────────────── */
  /**
   * Returns { ok: bool, penaltyPct: number, reason: string }
   * ok=false   → caller should skip the signal entirely
   * penaltyPct → caller should deduct this from sig.conf
   */
  function checkAlignment(sig) {
    if (!sig) return { ok: true, penaltyPct: 0, reason: '' };

    var asset  = (sig.asset  || '').toUpperCase();
    var dir    = (sig.dir    || sig.bias || '').toUpperCase();
    var source = (sig.source || '').toLowerCase();

    var isScalper    = !!(sig.reason && (sig.reason.indexOf('SCALPER') === 0 || sig.reason.indexOf('GII:') === 0));
    var isRiskAsset  = RISK_ASSETS.indexOf(asset) !== -1;
    var sector       = SECTOR_MAP[asset];

    /* ── Hard blocks ──────────────────────────────────────────────────────── */

    /* Major event within 45 min — hold automated signals only.
       GII/IC signals may still fire (they may be event-driven). */
    if (!isScalper && _ctx.nextEvent &&
        _ctx.nextEvent.minutesAway >= 0 && _ctx.nextEvent.minutesAway <= 45) {
      return { ok: false, penaltyPct: 0,
        reason: 'Event gate: ' + _ctx.nextEvent.name +
                ' in ' + _ctx.nextEvent.minutesAway + 'min — holding automated signals' };
    }

    /* GTI extreme + risk-asset long */
    if (_ctx.gti > 78 && isRiskAsset && dir === 'LONG') {
      return { ok: false, penaltyPct: 0,
        reason: 'GTI ' + _ctx.gti.toFixed(0) + ' EXTREME — blocking risk-asset longs' };
    }

    /* VIX extreme + risk-asset long (scalpers not exempt — market too dangerous) */
    if (_ctx.vix > 40 && isRiskAsset && dir === 'LONG') {
      return { ok: false, penaltyPct: 0,
        reason: 'VIX ' + _ctx.vix.toFixed(1) + ' (extreme) — blocking risk-asset longs' };
    }

    /* ── Confidence penalties ─────────────────────────────────────────────── */
    var penalty = 0;
    var reasons = [];

    if (_ctx.gti > 65 && _ctx.gti <= 78 && isRiskAsset && dir === 'LONG') {
      penalty += 8;
      reasons.push('GTI ' + _ctx.gti.toFixed(0) + ' elevated');
    }

    if (_ctx.vix > 35 && isRiskAsset && dir === 'LONG') {
      penalty += 10;
      reasons.push('VIX_EXTREME');
    } else if (_ctx.vix > 25 && isRiskAsset && dir === 'LONG') {
      penalty += 5;
      reasons.push('VIX_ELEVATED');
    }

    /* Sector dominant bias opposes signal — penalise (not scalper, not GII) */
    if (!isScalper && sector && _ctx.dominantBias[sector]) {
      var bias = _ctx.dominantBias[sector];
      if (bias.dir !== 'NEUTRAL' && bias.dir !== dir && bias.strength > 0.4) {
        penalty += 7;
        reasons.push(sector + ' bias ' + bias.dir +
                     ' (' + (bias.strength * 100).toFixed(0) + '% strength)');
      }
    }

    return { ok: true, penaltyPct: penalty, reason: reasons.join('; ') };
  }

  /* ── Public API ─────────────────────────────────────────────────────────── */
  function getContext() {
    return {
      gti:             _ctx.gti,
      gtiLevel:        _ctx.gtiLevel,
      vix:             _ctx.vix,
      dominantBias:    Object.assign({}, _ctx.dominantBias),
      nextEvent:       _ctx.nextEvent ? Object.assign({}, _ctx.nextEvent) : null,
      regimeWarnings:  _ctx.regimeWarnings.slice(),
      activeConflicts: _ctx.activeConflicts.slice(),
      lastUpdate:      _ctx.lastUpdate,
    };
  }

  /* Run immediately then every 5 minutes */
  _update();
  setInterval(_update, 5 * 60 * 1000);

  window.GII_SITUATIONAL = {
    checkAlignment: checkAlignment,
    getContext:     getContext,
    refresh:        _update,
  };

  console.log('[GII-SITUATIONAL] Situational awareness agent loaded');
})();
