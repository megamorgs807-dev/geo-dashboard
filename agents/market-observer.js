/* Market Observer Agent — market-observer.js v1
 * Observation-first parallel scanner. Watches price action across all tradeable
 * assets and surfaces setups that do NOT require a geopolitical trigger.
 *
 * Scan cycle  : every 5 minutes
 * Data source : HLFeed (primary), AlpacaBroker (secondary if connected)
 * Output      : window.GII_AGENT_MARKET_OBSERVER + feeds signals to EE.onSignals()
 * Tag         : all trades sourced here are tagged source:'market-obs' in EE
 *
 * Three scanners run each cycle:
 *   1. Momentum   — price moved > threshold in the last 30min
 *   2. Expansion  — current 30min range > N× the 20-candle average range
 *   3. Lag        — lead asset moved, correlated asset hasn't caught up yet
 *
 * Scoring (0–100):
 *   Move magnitude  0–40 pts  (how far above threshold; 2×=20, 3×=40)
 *   Confirmation   0–30 pts  (same signal fired in previous scan too)
 *   GII alignment  −15–30 pts (matching GII signal = +30, conflicting = −15)
 *
 * Tiers: Watch ≥40 | Active ≥66 | Strong ≥86
 * Only Active + Strong observations are forwarded to the EE.
 */
(function () {
  'use strict';

  // ── constants ────────────────────────────────────────────────────────────────

  var SCAN_MS        = 300000;   // 5-minute scan cycle
  var HISTORY_MAX    = 30;       // price samples per asset (30 × 5min = 2.5hr)
  var MIN_SCORE      = 40;       // below this: silent discard
  var EE_MIN_SCORE   = 66;       // Active+ threshold to forward to EE
  var MAX_OBS_PANEL  = 30;       // max rows shown in panel
  var MAX_EE_PER_SCAN= 2;        // max new EE signals injected per scan cycle
  var OBS_KEY        = 'mo_obs_v1';
  var VERSION        = 1;

  // Asset-class move & range thresholds
  var THRESHOLDS = {
    crypto  : { movePct: 2.5, rangeMulti: 2.5 },
    precious: { movePct: 0.8, rangeMulti: 2.0 },
    energy  : { movePct: 1.0, rangeMulti: 2.0 },
    equity  : { movePct: 0.8, rangeMulti: 2.0 },
    etf     : { movePct: 1.0, rangeMulti: 2.0 },
    fx      : { movePct: 0.3, rangeMulti: 2.0 },
    index   : { movePct: 0.5, rangeMulti: 2.0 },
    agri    : { movePct: 1.5, rangeMulti: 2.0 }
  };

  // Static asset-class map (covers all HL + Alpaca + OANDA assets)
  var ASSET_CLASS = {
    // Crypto
    BTC:'crypto', BITCOIN:'crypto', ETH:'crypto', ETHEREUM:'crypto',
    SOL:'crypto', XRP:'crypto', BNB:'crypto', ADA:'crypto',
    // Metals — ETFs + OANDA spot
    GLD:'precious', SLV:'precious', XAG:'precious', SILVER:'precious', GOLD:'precious',
    XAU_USD:'precious', XAG_USD:'precious', XAUUSD:'precious', XAGUSD:'precious',
    // Energy — ETFs + OANDA CFDs
    BRENT:'energy', BRENTOIL:'energy', WTI:'energy', OIL:'energy', CRUDE:'energy',
    GAS:'energy', NATGAS:'energy',
    BCO_USD:'energy', WTICO_USD:'energy', NATGAS_USD:'energy',
    // US equities
    SPY:'equity', QQQ:'equity', AAPL:'equity', TSLA:'equity',
    GOOGL:'equity', META:'equity', AMZN:'equity', MSFT:'equity',
    HOOD:'equity', CRCL:'equity',
    // ETFs
    XAR:'etf', GDX:'etf', XLE:'etf', SOXX:'etf',
    LIT:'etf', XME:'etf', INDA:'etf', SMH:'etf',
    // Agriculture
    WEAT:'agri', CORN:'agri',
    // Forex — both formats (plain + OANDA underscore)
    EURUSD:'fx', EUR_USD:'fx', USDJPY:'fx', USD_JPY:'fx',
    GBPUSD:'fx', GBP_USD:'fx', USDCHF:'fx', USD_CHF:'fx',
    AUDUSD:'fx', AUD_USD:'fx', USDCAD:'fx', USD_CAD:'fx',
    NZDUSD:'fx', NZD_USD:'fx', GBPJPY:'fx', GBP_JPY:'fx',
    EURJPY:'fx', EUR_JPY:'fx', EURGBP:'fx', EUR_GBP:'fx',
    // Indices (OANDA CFDs)
    SPX500_USD:'index', NAS100_USD:'index', UK100_GBP:'index',
    GER40_EUR:'index', JP225_USD:'index'
  };

  // Cross-asset correlation pairs
  // If lead moves > threshold and lag hasn't followed, flag lag as LAG opportunity
  var CORR_PAIRS = [
    { lead:'BTC',       lag:'ETH',       leadThr:2.0 },
    { lead:'BTC',       lag:'SOL',       leadThr:2.5 },
    { lead:'GLD',       lag:'SLV',       leadThr:0.8 },
    { lead:'SPY',       lag:'QQQ',       leadThr:0.6 },
    // OANDA pairs
    { lead:'XAU_USD',   lag:'XAG_USD',   leadThr:0.7 },  // gold leads silver
    { lead:'BCO_USD',   lag:'WTICO_USD', leadThr:0.8 },  // Brent leads WTI
    { lead:'SPX500_USD',lag:'NAS100_USD',leadThr:0.5 },  // S&P leads Nasdaq
    { lead:'EUR_USD',   lag:'GBP_USD',   leadThr:0.3 }   // EUR often leads GBP
  ];

  // GII agents to check for alignment
  var GII_AGENTS = [
    'GII_AGENT_ENERGY','GII_AGENT_MACRO','GII_AGENT_SATINTEL',
    'GII_AGENT_CRISISRANK','GII_AGENT_FORECAST','GII_AGENT_MACROSTRESS',
    'GII_INTEL_MASTER','GII_AGENT_SCALPER','GII_AGENT_CONFLICT',
    'GII_AGENT_MARITIME','GII_AGENT_TECHNICALS'
  ];

  // ── state ────────────────────────────────────────────────────────────────────

  var _priceHistory  = {};   // asset → [{price,ts}]
  var _prevFired     = {};   // 'asset:dir' → true  (previous scan)
  var _observations  = [];   // current scan results (sorted by score)
  var _allObs        = [];   // running history shown in panel
  var _eeInjected    = [];   // obs IDs forwarded to EE this session
  var _tradeableList = [];   // {asset, venue} — refreshed every hour
  var _lastListBuild = 0;

  var _status = {
    lastScan       : null,
    assetsScanned  : 0,
    scanCount      : 0,
    obsThisScan    : 0,
    eeSignalsTotal : 0,
    online         : false,
    version        : VERSION
  };

  // ── helpers ──────────────────────────────────────────────────────────────────

  function _cls(asset) {
    return ASSET_CLASS[asset] || 'equity';
  }

  function _thr(asset) {
    return THRESHOLDS[_cls(asset)] || THRESHOLDS.equity;
  }

  // True if we're within 90min of London open (08:00 UTC), NY open (13:30 UTC),
  // or inside the London/NY overlap (13:30–17:00 UTC)
  function _activeSession() {
    var m = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    return (m >= 480 && m <= 570) || (m >= 810 && m <= 1020);
  }

  // Build / refresh the list of tradeable assets
  function _buildTradeableList() {
    var now = Date.now();
    if (now - _lastListBuild < 3600000 && _tradeableList.length) return _tradeableList;
    _lastListBuild = now;
    var list = [];
    // HL assets — available = covered + fresh price
    if (window.HLFeed) {
      HLFeed.coverage().forEach(function (a) {
        if (HLFeed.isAvailable(a)) list.push({ asset:a, venue:'HL' });
      });
    }
    // Alpaca — only if connected
    if (window.AlpacaBroker) {
      var st = typeof AlpacaBroker.status === 'function' ? AlpacaBroker.status() : {};
      if (st.connected) {
        var alpacaPool = ['SOXX','XAR','GDX','XLE','LIT','XME','INDA','WEAT','CORN','SMH'];
        alpacaPool.forEach(function (a) {
          if (AlpacaBroker.covers(a) && !list.find(function(x){ return x.asset===a; })) {
            list.push({ asset:a, venue:'Alpaca' });
          }
        });
      }
    }
    // OANDA — forex, metals, energy, indices
    if (window.OANDA_RATES && OANDA_RATES.isConnected()) {
      var oRates = OANDA_RATES.getAllRates();
      Object.keys(oRates).forEach(function (key) {
        if (!list.find(function(x){ return x.asset === key; })) {
          list.push({ asset:key, venue:'OANDA' });
        }
      });
    }
    _tradeableList = list;
    return list;
  }

  // Record a price sample; cap history
  function _record(asset, price) {
    var p = parseFloat(price);
    if (!isFinite(p) || p <= 0) return;
    if (!_priceHistory[asset]) _priceHistory[asset] = [];
    _priceHistory[asset].push({ price:p, ts:Date.now() });
    if (_priceHistory[asset].length > HISTORY_MAX) _priceHistory[asset].shift();
  }

  // % change over windowMs using oldest sample in that window
  function _movePct(asset, windowMs) {
    var h = _priceHistory[asset];
    if (!h || h.length < 2) return null;
    var cutoff = Date.now() - windowMs;
    var oldest = h[0];
    for (var i = 0; i < h.length; i++) {
      if (h[i].ts >= cutoff) { oldest = h[i]; break; }
    }
    var cur = h[h.length - 1];
    if (!oldest.price || !isFinite(oldest.price)) return null;
    var pct = (cur.price - oldest.price) / oldest.price * 100;
    return isFinite(pct) ? pct : null;
  }

  // Average range of completed 30-min buckets (6 samples × 5min)
  function _avgRange(asset) {
    var h = _priceHistory[asset];
    if (!h || h.length < 12) return null;
    var buckets = [];
    for (var i = 0; i + 6 <= h.length; i += 6) {
      var sl = h.slice(i, i+6);
      var px = sl.map(function(s){ return s.price; });
      var lo = Math.min.apply(null, px);
      buckets.push(lo ? (Math.max.apply(null, px) - lo) / lo * 100 : 0);
    }
    if (!buckets.length) return null;
    return buckets.reduce(function(a,b){ return a+b; },0) / buckets.length;
  }

  // Current 30-min range (last 6 samples)
  function _curRange(asset) {
    var h = _priceHistory[asset];
    if (!h || h.length < 2) return null;
    var sl = h.slice(-Math.min(6, h.length));
    var px = sl.map(function(s){ return s.price; });
    var lo = Math.min.apply(null, px);
    return lo ? (Math.max.apply(null, px) - lo) / lo * 100 : null;
  }

  // Is current price within 1.5% of the in-memory high or low?
  function _nearLevel(asset) {
    var h = _priceHistory[asset];
    if (!h || h.length < 4) return false;
    var px = h.map(function(s){ return s.price; });
    var hi = Math.max.apply(null, px);
    var lo = Math.min.apply(null, px);
    var cur = h[h.length-1].price;
    return (Math.abs(cur - hi)/hi < 0.015) || (Math.abs(cur - lo)/lo < 0.015);
  }

  // Is direction aligned with recent short-term trend?
  function _trendLabel(asset, dir) {
    var h = _priceHistory[asset];
    if (!h || h.length < 3) return null;
    var lb = Math.min(6, h.length);
    var avg = h.slice(-lb).reduce(function(s,x){ return s+x.price; },0) / lb;
    var up = h[h.length-1].price > avg;
    if (dir==='long')  return up ? 'with trend' : 'counter-trend';
    return up ? 'counter-trend' : 'with trend';
  }

  // Check GII agents for matching or conflicting signal on same asset
  function _giiAlign(asset, dir) {
    var result = 'neutral';
    for (var i = 0; i < GII_AGENTS.length; i++) {
      var ag = window[GII_AGENTS[i]];
      if (!ag || typeof ag.signals !== 'function') continue;
      var sigs = ag.signals();
      for (var j = 0; j < sigs.length; j++) {
        var s = sigs[j];
        if ((s.asset || '').toUpperCase() !== asset.toUpperCase()) continue;
        var sd = (s.bias || s.direction || '').toLowerCase();
        if (sd === dir) { result = 'confirmed'; break; }
        if (sd && sd !== dir) result = 'conflicting';
      }
      if (result === 'confirmed') break;
    }
    return result;
  }

  // Composite score
  function _score(movePct, threshold, confirmed, giiAlign) {
    var ratio   = Math.abs(movePct) / threshold;
    var movePts = Math.min(40, Math.max(0, Math.round((ratio - 1) * 20)));
    var confPts = confirmed ? 30 : 0;
    var giiPts  = giiAlign === 'confirmed' ? 30 : giiAlign === 'conflicting' ? -15 : 0;
    return movePts + confPts + giiPts;
  }

  function _tier(sc) {
    if (sc >= 86) return 'Strong';
    if (sc >= 66) return 'Active';
    return 'Watch';
  }

  function _tierCol(t) {
    return t==='Strong' ? '#f87171' : t==='Active' ? '#fb923c' : '#facc15';
  }

  function _typeIcon(t) {
    return t==='MOMENTUM' ? '⚡' : t==='EXPANSION' ? '📈' : t==='LAG' ? '🔗' : '●';
  }

  // ── scan ─────────────────────────────────────────────────────────────────────

  function _scan() {
    _status.scanCount++;
    _status.lastScan = Date.now();
    _status.online   = true;

    var list = _buildTradeableList();
    _status.assetsScanned = list.length;

    var newObs      = [];
    var currentFired = {};

    // ── Scanner 1 + 2: Momentum & Expansion ──────────────────────────────────
    list.forEach(function (item) {
      var asset = item.asset;

      // Get current price
      var price = null;
      if (window.HLFeed) {
        var pd = HLFeed.getPrice(asset);
        if (pd && pd.price) price = pd.price;
      }
      if (!price && window.AlpacaBroker && typeof AlpacaBroker.getPrice === 'function') {
        var ap = AlpacaBroker.getPrice(asset);
        if (ap) price = ap;
      }
      if (!price && window.OANDA_RATES && OANDA_RATES.isConnected()) {
        var or = OANDA_RATES.getRate(asset);
        if (or && or.mid) price = or.mid;
      }
      if (!price) return;

      _record(asset, price);

      var h = _priceHistory[asset];
      if (!h || h.length < 4) return; // need at least 4 samples before firing

      var thr     = _thr(asset);
      var movePct = _movePct(asset, 30 * 60 * 1000);
      if (movePct === null || !isFinite(movePct)) return;
      var absMov  = Math.abs(movePct);

      if (absMov < thr.movePct) return; // below threshold

      var dir  = movePct > 0 ? 'long' : 'short';
      var key  = asset + ':' + dir;
      currentFired[key] = true;
      var confirmed = !!_prevFired[key];

      // Decide MOMENTUM vs EXPANSION
      var avg  = _avgRange(asset);
      var cur  = _curRange(asset);
      var type = (avg && cur && cur >= avg * thr.rangeMulti) ? 'EXPANSION' : 'MOMENTUM';

      var align = _giiAlign(asset, dir);
      var sc    = _score(absMov, thr.movePct, confirmed, align);
      if (!isFinite(sc) || sc < MIN_SCORE) return;

      var hints = [];
      if (_nearLevel(asset))   hints.push('near key level');
      var tl = _trendLabel(asset, dir);
      if (tl) hints.push(tl);
      if (_activeSession())    hints.push('active session');

      newObs.push({
        id          : asset + ':' + dir + ':' + _status.scanCount,
        asset       : asset,
        direction   : dir,
        type        : type,
        movePct     : absMov.toFixed(2),
        description : asset + ' ' + (dir==='long'?'▲':'▼') + ' ' + absMov.toFixed(1) + '% / 30min',
        hints       : hints,
        giiAlign    : align,
        score       : sc,
        tier        : _tier(sc),
        venue       : item.venue,
        assetClass  : _cls(asset),
        price       : price,
        ts          : Date.now()
      });
    });

    // ── Scanner 3: Cross-asset Lag ────────────────────────────────────────────
    CORR_PAIRS.forEach(function (pair) {
      function _getAnyPrice(sym) {
        if (window.HLFeed) { var p = HLFeed.getPrice(sym); if (p && p.price) return { price: p.price }; }
        if (window.OANDA_RATES && OANDA_RATES.isConnected()) { var r = OANDA_RATES.getRate(sym); if (r && r.mid) return { price: r.mid }; }
        return null;
      }
      var ld   = _getAnyPrice(pair.lead);
      var lagD = _getAnyPrice(pair.lag);
      if (!ld || !lagD) return;

      _record(pair.lead, ld.price);
      _record(pair.lag,  lagD.price);

      var lmov = _movePct(pair.lead, 30*60*1000);
      var lagm = _movePct(pair.lag,  30*60*1000);
      if (lmov === null || lagm === null || !isFinite(lmov) || !isFinite(lagm)) return;
      if (Math.abs(lmov) < pair.leadThr) return;

      var lagThr = _thr(pair.lag);
      if (Math.abs(lagm) >= lagThr.movePct * 0.6) return; // lag has already moved

      var dir  = lmov > 0 ? 'long' : 'short';
      var key  = pair.lag + ':lag:' + dir;
      currentFired[key] = true;
      var confirmed = !!_prevFired[key];

      // Lag asset must be tradeable
      if (!_tradeableList.find(function(x){ return x.asset===pair.lag; })) return;

      var align = _giiAlign(pair.lag, dir);
      var sc    = _score(Math.abs(lmov), pair.leadThr, confirmed, align);
      if (sc < MIN_SCORE) return;

      var hints = ['lagging ' + pair.lead];
      if (_activeSession()) hints.push('active session');

      newObs.push({
        id          : pair.lag + ':lag:' + _status.scanCount,
        asset       : pair.lag,
        direction   : dir,
        type        : 'LAG',
        movePct     : Math.abs(lmov).toFixed(2),
        description : pair.lag + ' lagging ' + pair.lead + ' (' + Math.abs(lmov).toFixed(1) + '% lead move)',
        hints       : hints,
        giiAlign    : align,
        score       : sc,
        tier        : _tier(sc),
        venue       : 'HL',
        assetClass  : _cls(pair.lag),
        price       : lagD.price,
        ts          : Date.now()
      });
    });

    // ── Sort & deduplicate ────────────────────────────────────────────────────
    newObs.sort(function(a,b){ return b.score - a.score; });

    // Dedup: only one entry per asset per scan
    var seenAssets = {};
    newObs = newObs.filter(function(o){
      if (seenAssets[o.asset]) return false;
      seenAssets[o.asset] = true;
      return true;
    });

    _prevFired   = currentFired;
    _observations = newObs;
    _status.obsThisScan = newObs.length;

    // Prepend to history panel
    newObs.forEach(function(o){ _allObs.unshift(o); });
    if (_allObs.length > MAX_OBS_PANEL) _allObs = _allObs.slice(0, MAX_OBS_PANEL);
    _status.observationsTotal = _allObs.length;

    // Persist latest 15 to localStorage
    try { localStorage.setItem(OBS_KEY, JSON.stringify(_allObs.slice(0,15))); } catch(e){}

    // ── Forward Active/Strong to EE ───────────────────────────────────────────
    _forwardToEE(newObs);

    // ── Render panel ─────────────────────────────────────────────────────────
    _render();

    console.log('[MO] Scan #'+_status.scanCount+': '+list.length+' assets scanned, '+newObs.length+' obs, '+_status.eeSignalsTotal+' EE signals total');
  }

  // ── EE forwarding ────────────────────────────────────────────────────────────

  function _forwardToEE(obs) {
    if (!window.EE || typeof EE.onSignals !== 'function') return;

    var eligible = obs.filter(function(o){
      return o.score >= EE_MIN_SCORE && !_eeInjected.includes(o.id);
    });

    // Cap per scan to avoid flooding
    eligible = eligible.slice(0, MAX_EE_PER_SCAN);

    if (!eligible.length) return;

    var signals = eligible.map(function(o){
      return {
        source       : 'market-obs',
        asset        : o.asset,
        bias         : o.direction,
        confidence   : Math.min(0.92, 0.50 + o.score / 200), // score 66→0.83, 86→0.93
        reasoning    : o.description + (o.hints.length ? ' · ' + o.hints.join(', ') : ''),
        region       : 'GLOBAL',
        sector       : o.assetClass,
        evidenceKeys : [o.type.toLowerCase(), o.assetClass],
        obsType      : o.type,
        giiConfirmed : o.giiAlign === 'confirmed',
        moScore      : o.score,
        moTier       : o.tier,
        timestamp    : o.ts
      };
    });

    eligible.forEach(function(o){ _eeInjected.push(o.id); });
    _status.eeSignalsTotal += signals.length;

    try { EE.onSignals(signals); } catch(e){
      console.warn('[MO] EE.onSignals error:', e);
    }
  }

  // ── render ───────────────────────────────────────────────────────────────────

  function _render() {
    var el = document.getElementById('mo-content');
    if (!el) return;

    if (!_allObs.length) {
      var _msg;
      if (_status.scanCount > 0 && _status.assetsScanned === 0) {
        _msg = 'No price feed — check HLFeed connection';
      } else if (_status.scanCount > 1) {
        _msg = 'No setups yet — ' + _status.assetsScanned + ' assets scanned, thresholds not met';
      } else {
        _msg = 'Scanning — first observations appear after 2 cycles (~10 min)';
      }
      el.innerHTML = '<div class="ee-placeholder">' + _msg + '</div>';
      return;
    }

    var h = [];
    h.push('<div class="mo-meta">');
    h.push('<span>Scan #'+_status.scanCount+' &nbsp;·&nbsp; '+_status.assetsScanned+' assets &nbsp;·&nbsp; '+_status.eeSignalsTotal+' EE signals sent</span>');
    if (_status.lastScan) {
      var ago = Math.round((Date.now()-_status.lastScan)/1000);
      h.push('<span style="color:var(--dim)">Last scan '+ago+'s ago</span>');
    }
    h.push('</div>');

    h.push('<div class="mo-table-header">');
    h.push('<span>Asset</span><span>Signal</span><span>Type</span><span>Hints</span><span>GII</span><span>Score</span>');
    h.push('</div>');

    _allObs.slice(0, MAX_OBS_PANEL).forEach(function(o){
      var tierCol = _tierCol(o.tier);
      var dirArrow = o.direction==='long' ? '<span style="color:#4ade80">▲</span>' : '<span style="color:#f87171">▼</span>';
      var giiTag = '';
      if (o.giiAlign==='confirmed')    giiTag = '<span class="mo-tag mo-tag-gii">GII✓</span>';
      else if (o.giiAlign==='conflicting') giiTag = '<span class="mo-tag mo-tag-conflict">GII✗</span>';

      var hintHtml = o.hints.map(function(ht){
        return '<span class="mo-hint">'+ht+'</span>';
      }).join('');

      var eeTag = _eeInjected.includes(o.id) ? '<span class="mo-tag mo-tag-ee">→EE</span>' : '';
      var ts = new Date(o.ts).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});

      h.push('<div class="mo-row">');
      h.push('<span class="mo-asset">'+o.asset+'<span class="mo-ts">'+ts+'</span></span>');
      h.push('<span>'+dirArrow+' '+o.movePct+'% '+eeTag+'</span>');
      h.push('<span>'+_typeIcon(o.type)+' '+o.type+'</span>');
      h.push('<span class="mo-hints">'+hintHtml+'</span>');
      h.push('<span>'+giiTag+'</span>');
      h.push('<span class="mo-score" style="color:'+tierCol+'">'+o.score+'<span class="mo-tier"> '+o.tier+'</span></span>');
      h.push('</div>');
    });

    el.innerHTML = h.join('');

    // Update timestamp in header
    var ts = document.getElementById('mo-timestamp');
    if (ts) ts.textContent = new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  }

  // ── init ─────────────────────────────────────────────────────────────────────

  function _init() {
    // Restore persisted obs for immediate display (drop any with NaN/null scores)
    try {
      var saved = JSON.parse(localStorage.getItem(OBS_KEY) || '[]');
      if (Array.isArray(saved)) _allObs = saved.filter(function(o){ return isFinite(o.score) && o.score > 0; });
    } catch(e){}

    // First scan after 15s (let HL WebSocket warm up), then every 5min
    setTimeout(function(){
      _scan();
      setInterval(_scan, SCAN_MS);
    }, 15000);
  }

  // ── public API ───────────────────────────────────────────────────────────────

  window.GII_AGENT_MARKET_OBSERVER = {
    scan        : _scan,
    signals     : function(){ return _observations.slice(); },
    observations: function(){ return _allObs.slice(); },
    status      : function(){
      return Object.assign({}, _status, {
        lastPoll      : _status.lastScan,   // alias for agent status table
        assetsTracked : Object.keys(_priceHistory).length,
        tradeableCount: _tradeableList.length,
        note          : _status.scanCount
          ? (_status.obsThisScan + ' obs · ' + _status.eeSignalsTotal + ' EE signals sent')
          : 'warming up — first scan in ~15s'
      });
    },
    tier        : _tier,
    thresholds  : function(){ return THRESHOLDS; }
  };

  window.addEventListener('load', _init);

})();
