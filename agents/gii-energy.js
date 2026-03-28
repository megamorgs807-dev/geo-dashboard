/* GII Energy Agent — gii-energy.js v2
 * Monitors oil/gas/energy geopolitical signals
 * Reads: window.__IC.events, window.__IC.regionStates, window.SB, /api/market
 * Exposes: window.GII_AGENT_ENERGY
 */
(function () {
  'use strict';

  var MAX_SIGNALS = 20;
  var POLL_INTERVAL = 65000; // ms
  var ENERGY_KEYWORDS = ['oil', 'crude', 'hormuz', 'opec', 'pipeline', 'gas', 'brent', 'wti',
    'refinery', 'petroleum', 'lng', 'tanker', 'energy supply', 'oil field', 'oil price',
    'production cut', 'spare capacity', 'straits', 'strait'];

  var _signals = [];
  var _status = {
    lastPoll: null,
    marketData: null,
    energyEventCount: 0,
    rerouting: 0,
    online: false
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  // ── helpers ────────────────────────────────────────────────────────────────

  function _matchesEnergy(text) {
    if (!text) return false;
    var t = text.toLowerCase();
    for (var i = 0; i < ENERGY_KEYWORDS.length; i++) {
      if (t.indexOf(ENERGY_KEYWORDS[i]) !== -1) return true;
    }
    return false;
  }

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  // ── market data fetch ──────────────────────────────────────────────────────

  var _API = (typeof window !== 'undefined' && window.GEO_API_BASE) || 'http://localhost:8765';

  function _fetchMarket(cb) {
    var ctrl = new AbortController();
    var tid  = setTimeout(function () { ctrl.abort(); }, 120000);
    fetch(_API + '/api/market', { method: 'GET', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal })
      .then(function (r) { clearTimeout(tid); return r.ok ? r.json() : null; })
      .then(function (d) { cb(null, d); })
      .catch(function (e) { clearTimeout(tid); cb(e, null); });
  }

  // ── analysis ───────────────────────────────────────────────────────────────

  function _analyseEvents(marketData) {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now = Date.now();
    var cutoff = now - 24 * 60 * 60 * 1000; // 24h
    var energyEvents = IC.events.filter(function (e) {
      return e.ts > cutoff && _matchesEnergy(e.headline || e.text || e.title || '');
    });

    _status.energyEventCount = energyEvents.length;

    // SB maritime rerouting proxy
    var SB = window.SB;
    _status.rerouting = 0;
    if (SB && typeof SB.status === 'function') {
      var sb = SB.status();
      _status.rerouting = (sb && sb.maritime) ? sb.maritime : 0;
    }

    // Get prior from regionStates
    var iranProb = 0.25;
    var hormuzProb = 0.30;
    if (IC.regionStates) {
      if (IC.regionStates['IRAN'] && IC.regionStates['IRAN'].prob !== undefined) {
        iranProb = _clamp(IC.regionStates['IRAN'].prob / 100, 0.05, 0.95);
      }
      if (IC.regionStates['STRAIT OF HORMUZ'] && IC.regionStates['STRAIT OF HORMUZ'].prob !== undefined) {
        hormuzProb = _clamp(IC.regionStates['STRAIT OF HORMUZ'].prob / 100, 0.05, 0.95);
      }
    }
    var prior = Math.max(iranProb, hormuzProb);

    // Market data signals
    if (marketData) {
      _status.marketData = marketData;
      var wtiChg = 0;
      if (marketData.WTI && marketData.WTI.chg24h !== undefined) {
        wtiChg = parseFloat(marketData.WTI.chg24h) || 0;
      } else if (marketData.wti_usd !== undefined) {
        wtiChg = parseFloat(marketData.wti_change_24h) || 0;
      }

      if (Math.abs(wtiChg) > 2) {
        var conf = _clamp(0.40 + Math.abs(wtiChg) * 0.04, 0.40, 0.85);
        conf = conf * (0.5 + prior * 0.5); // scale by prior
        _pushSignal({
          source: 'energy',
          asset: 'WTI',
          bias: wtiChg > 0 ? 'long' : 'short',
          confidence: _clamp(conf, 0.30, 0.85),
          reasoning: 'WTI 24h move ' + (wtiChg > 0 ? '+' : '') + wtiChg.toFixed(1) + '% | energy event density ' + energyEvents.length,
          region: 'MIDDLE EAST',
          evidenceKeys: ['oil', 'wti', 'crude']
        });
      }

      // BRENT signal from energy events
      var brentEvents = energyEvents.filter(function (e) {
        var t = (e.headline || e.text || '').toLowerCase();
        return t.indexOf('brent') !== -1 || t.indexOf('opec') !== -1;
      });
      if (brentEvents.length >= 2) {
        var bConf = _clamp(0.35 + brentEvents.length * 0.04, 0.35, 0.75);
        var topSev = Math.max.apply(null, brentEvents.map(function (e) { return e.signal || e.severity || 50; }));
        bConf = bConf * (topSev / 100);
        _pushSignal({
          source: 'energy',
          asset: 'BRENT',
          bias: 'long',
          confidence: _clamp(bConf, 0.25, 0.75),
          reasoning: brentEvents.length + ' BRENT/OPEC events in 24h | top signal ' + topSev,
          region: 'MIDDLE EAST',
          evidenceKeys: ['brent', 'opec', 'oil']
        });
      }
    }

    // XLE signal from energy event cluster
    if (energyEvents.length >= 4) {
      var avgSig = energyEvents.reduce(function (s, e) { return s + (e.signal || e.severity || 50); }, 0) / energyEvents.length;
      var xleConf = _clamp(avgSig / 100 * 0.70, 0.25, 0.70);
      _pushSignal({
        source: 'energy',
        asset: 'XLE',
        bias: 'long',
        confidence: xleConf,
        reasoning: energyEvents.length + ' energy events (avg severity ' + avgSig.toFixed(0) + ') | rerouting incidents: ' + _status.rerouting,
        region: 'GLOBAL',
        evidenceKeys: ['energy supply', 'pipeline', 'oil field']
      });
    }

    // Rerouting signal
    if (_status.rerouting >= 3) {
      _pushSignal({
        source: 'energy',
        asset: 'WTI',
        bias: 'long',
        confidence: _clamp(0.40 + _status.rerouting * 0.05, 0.40, 0.78),
        reasoning: _status.rerouting + ' maritime rerouting incidents → supply route disruption',
        region: 'STRAIT OF HORMUZ',
        evidenceKeys: ['tanker', 'hormuz', 'rerouting']
      });
    }
  }

  // ── public poll ────────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    _fetchMarket(function (err, data) {
      _status.online = !err;
      _analyseEvents(data);
    });
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII_AGENT_ENERGY = {
    poll: poll,
    signals: function () { return _signals.slice(); },
    status: function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); }
  };

  // Init
  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 6500);
  });

})();
