/* ══ POLYMARKET PREDICTION MARKET INTEGRATION ══════════════════════════════════
   Ingests geopolitically-relevant Polymarket markets into the IC pipeline.

   Signal layers (capital-weighted wallet consensus):
     1. YES token price     — aggregate of all wallet positions (Gamma API, via corsproxy)
     2. Order book imbalance — live bid vs ask pressure (CLOB, via corsproxy)
     3. Whale trades        — single trades ≥ $1 000 flagged as institutional signals
                              (Data API, via corsproxy)

   Outputs injected into window.__IC.ingest() with pmFeed / pmYesProb / pmImbalance /
   pmWhaleNet extras — scoreEvent() picks up pmBoost of 0-18 pts automatically.

   window.PM public API:
     PM.config({ pmMult, enabled })   — reconfigure
     PM.pollAll()                     — fire all pollers immediately
     PM.setMult(v)                    — set aggressiveness multiplier
     PM.toggleEnabled()               — pause / resume
     PM.demo()                        — inject 3 synthetic demo events
     PM.status()                      — return copy of _status
     PM.markets()                     — return copy of _markets array

   V1  2026-03-13
   ══════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── CONFIG ──────────────────────────────────────────────────────────────── */
  var _cfg = {
    enabled:       true,
    pmMult:        1.0,               // aggressiveness multiplier 0.1-3.0
    pollMarkets:   300000,            // 5 min — Gamma discovery is slow-changing
    pollOrderBook:  60000,            // 1 min — matches IC TICK_MS
    pollActivity:  120000,            // 2 min — whale trade scan
    minVolume:     5000,              // min 24h USD volume to include a market
    minYesPrice:   0.05,              // ignore near-zero (no real signal)
    maxYesPrice:   0.95,              // ignore near-certain (already priced in)
    whaleThreshold: 1000,             // min USD size to count as whale trade
    gammaBase:  'https://gamma-api.polymarket.com',
    clobBase:   'https://clob.polymarket.com',
    dataBase:   'https://data-api.polymarket.com',
    proxy:      'https://corsproxy.io/?',
    panelId:    'pmStatusPanel',
  };

  /* ── STATE ───────────────────────────────────────────────────────────────── */
  var _status = {
    markets:   { ok: false, count: 0, last: null, err: '' },
    orderbook: { ok: false, count: 0, last: null, err: '' },
    activity:  { ok: false, count: 0, last: null, err: '' },
  };
  var _markets  = [];   // filtered + normalised market objects
  var _obCache  = {};   // condition_id → {bidVol, askVol, imbalance, ts}
  var _actCache = {};   // condition_id → {whaleCount, netWhales, largestTrade, whaleBias}
  var _seen     = new Set();
  var _pmEvents = [];   // scored PM event cache — won't be evicted by IC overflow
  var _panelTimer = null;

  /* ── MARKET KEYWORD FILTER (geo + macro tradeable signals) ──────────────── */
  var PM_GEO_KWS = [
    // Conflict / military (no bare 'war' — matches "Warriors", "award" etc.)
    'conflict','attack','military','missile','troops','invasion','airstrike',
    'strike','ceasefire','nato','nuclear','sanction','offensive','coup','assassination',
    'drone','blockade','warfare','warhead',
    // Energy / commodities
    'oil','crude','opec','gas','petroleum','hormuz','energy','barrel','brent','wti',
    // Geopolitical countries & hotspots
    'iran','russia','ukraine','taiwan','china','israel','gaza','hamas','hezbollah',
    'north korea','korea','pakistan','india','saudi','houthi','yemen','syria','iraq',
    'venezuela','crimea','donbas','nato','turkey',
    // Macro / politics (directly market-moving)
    'election','regime','protest','tariff','trade war','default','inflation','recession',
    'interest rate','federal reserve','fed rate','rate cut','rate hike','basis point',
    'trump','congress','senate','debt ceiling','gdp','unemployment',
    // Crypto (risk-on/off signals, directly tradeable)
    'bitcoin','btc','ethereum','eth','crypto','solana','sol ','coinbase','binance',
    'stablecoin','defi','sec crypto','crypto regulation',
    // Financial markets
    'nasdaq','s&p','dow jones','vix','gold price','silver price',
    'dollar index','dxy','yen','yuan','euro','pound sterling',
  ];

  /* ── REGION MAPPING ──────────────────────────────────────────────────────── */
  // Ordered most-specific first; first match wins
  var PM_REGION_MAP = [
    ['strait of hormuz','STRAIT OF HORMUZ'], ['hormuz','STRAIT OF HORMUZ'],
    ['red sea','RED SEA'], ['bab el','RED SEA'], ['houthi','RED SEA'],
    ['suez','SUEZ'],
    ['malacca','MALACCA STRAIT'],
    ['taiwan strait','TAIWAN STRAIT'], ['taiwan','TAIWAN STRAIT'],
    ['south china sea','EAST ASIA'],
    ['ukraine','EASTERN EUROPE'],   ['kyiv','EASTERN EUROPE'],
    ['donbas','EASTERN EUROPE'],    ['crimea','EASTERN EUROPE'],
    ['russia','RUSSIA'],            ['moscow','RUSSIA'], ['putin','RUSSIA'],
    ['iran','MIDDLE EAST'],         ['tehran','MIDDLE EAST'],
    ['iraq','MIDDLE EAST'],         ['baghdad','MIDDLE EAST'],
    ['israel','MIDDLE EAST'],       ['gaza','MIDDLE EAST'], ['hamas','MIDDLE EAST'],
    ['hezbollah','MIDDLE EAST'],    ['lebanon','MIDDLE EAST'],
    ['saudi','MIDDLE EAST'],        ['riyadh','MIDDLE EAST'], ['opec','MIDDLE EAST'],
    ['yemen','MIDDLE EAST'],        ['syria','MIDDLE EAST'],
    ['china','EAST ASIA'],          ['beijing','EAST ASIA'], ['xi jinping','EAST ASIA'],
    ['north korea','EAST ASIA'],    ['pyongyang','EAST ASIA'],
    ['india','ASIA PACIFIC'],       ['pakistan','ASIA PACIFIC'], ['kashmir','ASIA PACIFIC'],
    ['venezuela','SOUTH AMERICA'],
    ['niger','AFRICA'],             ['mali','AFRICA'],  ['sudan','AFRICA'],
    ['nato','EASTERN EUROPE'],
    ['oil','MIDDLE EAST'],          ['crude','MIDDLE EAST'], // energy fallback
  ];

  /* ── ASSET MAPPING ───────────────────────────────────────────────────────── */
  var PM_ASSET_MAP = {
    'STRAIT OF HORMUZ': ['WTI','BRENT','GLD','XLE'],
    'RED SEA':          ['WTI','BRENT','XLE','GLD'],
    'SUEZ':             ['WTI','BRENT','XLE'],
    'MALACCA STRAIT':   ['TSM','SMH'],
    'TAIWAN STRAIT':    ['TSM','SMH','GLD','LMT'],
    'EAST ASIA':        ['TSM','GLD'],
    'MIDDLE EAST':      ['WTI','BRENT','GLD','XAR','LMT'],
    'EASTERN EUROPE':   ['WTI','BRENT','GLD','XAR'],
    'RUSSIA':           ['WTI','BRENT','GLD'],
    'ASIA PACIFIC':     ['GLD'],
    'BLACK SEA':        ['WTI','GLD'],
    'EUROPE':           ['GLD'],
    'SOUTH AMERICA':    ['WTI'],
    'AFRICA':           ['GLD'],
    'GLOBAL':           ['GLD'],
  };

  /* ── FETCH HELPERS ───────────────────────────────────────────────────────── */
  function _fetch(url, timeoutMs, cb) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 10000);
    fetch(url, { signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) { cb(null, d); })
      .catch(function (e) { clearTimeout(timer); cb(e.message || 'fetch error', null); });
  }

  function _fetchProxy(url, timeoutMs, cb) {
    _fetch(_cfg.proxy + encodeURIComponent(url), timeoutMs, function (err, data) {
      if (err) return cb(err, null);
      // corsproxy returns raw JSON — pass through
      cb(null, data);
    });
  }

  function _fetchProxyText(url, timeoutMs, cb) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 10000);
    fetch(_cfg.proxy + encodeURIComponent(url), { signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (text) {
        var d; try { d = JSON.parse(text); } catch (e) { d = null; }
        cb(null, d);
      })
      .catch(function (e) { clearTimeout(timer); cb(e.message || 'fetch error', null); });
  }

  /* ── HELPERS ─────────────────────────────────────────────────────────────── */
  function _hhmm() {
    var d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function _textToRegion(text) {
    var low = (text || '').toLowerCase();
    for (var i = 0; i < PM_REGION_MAP.length; i++) {
      if (low.indexOf(PM_REGION_MAP[i][0]) !== -1) return PM_REGION_MAP[i][1];
    }
    return 'GLOBAL';
  }

  // Sports team/league patterns that can trigger false geo keyword matches
  var _SPORTS_BLOCK = [
    ' vs ', ' vs. ', 'nfl ', 'nba ', 'nhl ', 'mlb ', 'nba ', 'premier league',
    'super bowl', 'world series', 'stanley cup', 'playoffs', 'championship game',
    'oilers', 'rangers', 'warriors', 'rockets', 'patriots', 'raiders', 'capitals',
    'nationals', 'strikers', 'united fc', ' fc ', ' afc ', ' nfc ',
  ];
  function _geoMatch(text) {
    var low = (text || '').toLowerCase();
    // Reject obvious sports matchups first
    for (var s = 0; s < _SPORTS_BLOCK.length; s++) {
      if (low.indexOf(_SPORTS_BLOCK[s]) !== -1) return false;
    }
    for (var i = 0; i < PM_GEO_KWS.length; i++) {
      if (low.indexOf(PM_GEO_KWS[i]) !== -1) return true;
    }
    return false;
  }

  function _scheduleRedraw() {
    if (window.__IC && typeof window.__IC.redrawAll === 'function') {
      setTimeout(window.__IC.redrawAll, 200);
    }
  }

  /* outcomePrices arrives as JSON string "[\"0.72\",\"0.28\"]" from Gamma API */
  function _yesPrice(market) {
    var op = market.outcomePrices || ['0'];
    if (typeof op === 'string') { try { op = JSON.parse(op); } catch (e) { op = ['0']; } }
    return parseFloat(op[0]) || 0;
  }

  /* ── SIGNAL SYNTHESIS ────────────────────────────────────────────────────── */
  function _synthesise(market) {
    var yp  = _yesPrice(market);
    var vol = parseFloat(market.volume24hr || market.volume || 0);
    var ob  = (_obCache[market.condition_id] || {}).imbalance || 0;
    var act = _actCache[market.condition_id] || {};
    var net = act.netWhales || 0;

    // Credibility weight: log scale, 0 at $0 vol → 1.0 at $50k+
    var volW = Math.min(1.0, Math.log10(Math.max(1, vol)) / Math.log10(50000));

    // Soften whale count: sigmoid-like to prevent a single $100k trade dominating
    var whaleW = net / (Math.abs(net) + 3);   // range -1 to +1

    // Core signal weights: YES price (55%) + OB pressure (25%) + whale bias (10%) + vol credibility (10%)
    var obContrib    = 0.5 + ob    * 0.5;   // -1..+1 → 0..1
    var whaleContrib = 0.5 + whaleW * 0.5; // -1..+1 → 0..1
    var rawSignal    = yp * 0.55 + obContrib * 0.25 + whaleContrib * 0.10 + volW * 0.10;

    // Apply aggressiveness multiplier
    var pmYesProb = Math.min(1.0, Math.max(0, rawSignal * _cfg.pmMult));

    return {
      pmYesProb:   pmYesProb,
      pmImbalance: ob,
      pmWhaleNet:  net,
      whaleBias:   act.whaleBias || 'NEUTRAL',
      whaleCount:  act.whaleCount || 0,
      largestTrade: act.largestTrade || 0,
      volW:        volW,
    };
  }

  /* ── INJECT INTO IC PIPELINE ─────────────────────────────────────────────── */
  function _inject(market, sig) {
    if (!_cfg.enabled) return;
    var IC = window.__IC;
    if (!IC || typeof IC.ingest !== 'function') return;

    var yp     = _yesPrice(market);
    var vol    = parseFloat(market.volume24hr || market.volume || 0);
    var region = _textToRegion(market.question || '');
    var obPct  = Math.round(Math.abs(sig.pmImbalance) * 100);
    var obDir  = sig.pmImbalance > 0.05 ? '+' : sig.pmImbalance < -0.05 ? '-' : '±';
    var whaleTxt = sig.whaleBias !== 'NEUTRAL'
      ? ' | ' + (sig.whaleBias === 'BUY' ? '⬆' : '⬇') + ' WHALE×' + sig.whaleCount
      : '';

    var title = '[PM] ' + (market.question || '').slice(0, 60);
    var desc  = 'Polymarket | YES: ' + Math.round(yp * 100) + '%'
      + ' | OB: ' + obDir + obPct + '%'
      + whaleTxt
      + ' | Vol: $' + vol.toLocaleString(undefined, { maximumFractionDigits: 0 })
      + ' | ' + region;

    // PM events refresh every poll cycle — evict stale IC entry so the updated
    // signal replaces it rather than being blocked by the IC dedup set
    var icKey = title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 48);
    if (IC.eventIds) IC.eventIds.delete(icKey);
    // Also remove matching stale event from the events array
    var pmMkt = (market.question || '').slice(0, 80);
    for (var i = IC.events.length - 1; i >= 0; i--) {
      if (IC.events[i].pmMarket === pmMkt) { IC.events.splice(i, 1); break; }
    }

    IC.ingest(title, desc, 'Polymarket/Gamma', {
      ts:          Date.now(),
      region:      region,
      srcCount:    sig.pmImbalance !== 0 ? 2 : 1,
      socialV:     sig.pmYesProb,
      pmFeed:      'markets',
      pmYesProb:   sig.pmYesProb,
      pmMarket:    pmMkt,
      pmImbalance: sig.pmImbalance,
      pmWhaleNet:  sig.pmWhaleNet,
    });

    // Capture the fully-scored event from IC immediately after injection (before eviction)
    // and store in _pmEvents — this array is never evicted, ensuring PM signals persist
    if (IC.events[0] && IC.events[0].pmMarket === pmMkt) {
      var scored = IC.events[0];
      _pmEvents = _pmEvents.filter(function(e) { return e.pmMarket !== pmMkt; });
      _pmEvents.unshift({
        title: scored.title, desc: scored.desc, source: scored.source,
        pmFeed: scored.pmFeed, pmYesProb: scored.pmYesProb, pmMarket: scored.pmMarket,
        pmImbalance: scored.pmImbalance, pmWhaleNet: scored.pmWhaleNet,
        signal: scored.signal, pmBoost: scored.pmBoost,
        ts: scored.ts, time: scored.time, region: scored.region,
      });
      if (_pmEvents.length > 20) _pmEvents.pop();
    }

    _scheduleRedraw();
  }

  /* ── POLL: MARKETS (Gamma API, via proxy — direct fetch blocked from localhost) */
  function _pollMarkets() {
    var url = _cfg.gammaBase + '/markets?active=true&closed=false&limit=100&order=volume24hr&ascending=false';
    _fetchProxy(url, 15000, function (err, data) {
      if (err || !Array.isArray(data)) {
        _status.markets.ok  = false;
        _status.markets.err = err || 'no data';
        _renderPanel();
        return;
      }

      // Filter: geo-relevant + minimum volume + meaningful YES price
      var filtered = data.filter(function (m) {
        var yp  = _yesPrice(m);
        var vol = parseFloat(m.volume24hr || m.volume || 0);
        return _geoMatch(m.question || '')
          && vol >= _cfg.minVolume
          && yp >= _cfg.minYesPrice
          && yp <= _cfg.maxYesPrice;
      });

      // Normalise and store — Gamma returns outcomePrices + tokens as JSON strings
      function _parseField(v, fallback) {
        if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return fallback; } }
        return v || fallback;
      }
      _markets = filtered.slice(0, 30).map(function (m) {
        return {
          id:           m.id,
          condition_id: m.condition_id || m.conditionId || m.id,
          question:     (m.question || '').trim(),
          outcomePrices: _parseField(m.outcomePrices, ['0.5','0.5']),
          volume24hr:   parseFloat(m.volume24hr || m.volume || 0),
          liquidityNum: parseFloat(m.liquidityNum || 0),
          endDate:      m.endDate || null,
          tokens:       _parseField(m.tokens, []),
        };
      });

      _status.markets.ok    = true;
      _status.markets.count = _markets.length;
      _status.markets.last  = _hhmm();
      _status.markets.err   = '';

      // Inject YES-price signals immediately (token IDs not in Gamma /markets response,
      // so OB/whale data unavailable — signal still meaningful from market consensus price)
      _markets.forEach(function (m, i) {
        setTimeout(function () {
          var sig = _synthesise(m);
          if (sig.pmYesProb >= 0.35 && sig.pmYesProb <= 0.95) {
            _inject(m, sig);
          }
        }, i * 300);
      });

      // Trigger order book + activity polls for each discovered market (if tokens available)
      _markets.forEach(function (m, i) {
        setTimeout(function () { _pollOrderBook(m); }, i * 800 + 500);
        setTimeout(function () { _pollActivity(m); }, i * 1000 + 800);
      });

      _renderPanel();
    });
  }

  /* ── POLL: ORDER BOOK (CLOB) ─────────────────────────────────────────────── */
  function _pollOrderBook(market) {
    // Get YES token_id from tokens array
    var tokens = market.tokens || [];
    var yesToken = null;
    for (var i = 0; i < tokens.length; i++) {
      if ((tokens[i].outcome || '').toLowerCase() === 'yes') {
        yesToken = tokens[i].token_id || tokens[i].tokenId;
        break;
      }
    }
    if (!yesToken) {
      // Try first token if outcome labels aren't populated
      yesToken = tokens[0] && (tokens[0].token_id || tokens[0].tokenId);
    }
    if (!yesToken) return;

    var url = _cfg.clobBase + '/book?token_id=' + yesToken;
    _fetchProxyText(url, 8000, function (err, data) {
      if (err || !data) {
        _status.orderbook.err = err || 'no data';
        return;
      }

      var bids = data.bids || [];
      var asks = data.asks || [];

      var bidVol = bids.reduce(function (s, b) {
        return s + parseFloat(b.price || 0) * parseFloat(b.size || 0);
      }, 0);
      var askVol = asks.reduce(function (s, a) {
        return s + parseFloat(a.price || 0) * parseFloat(a.size || 0);
      }, 0);

      var total = bidVol + askVol;
      var imbalance = total > 0.001 ? (bidVol - askVol) / total : 0;

      _obCache[market.condition_id] = {
        bidVol: bidVol,
        askVol: askVol,
        imbalance: imbalance,
        ts: Date.now(),
      };

      _status.orderbook.ok    = true;
      _status.orderbook.count = Object.keys(_obCache).length;
      _status.orderbook.last  = _hhmm();
      _status.orderbook.err   = '';

      // Synthesise + inject after OB data is ready
      var sig = _synthesise(market);
      if (sig.pmYesProb >= 0.35 && sig.pmYesProb <= 0.95) {
        _inject(market, sig);
      }

      _renderPanel();
    });
  }

  /* ── POLL: ACTIVITY / WHALE DETECTION (Data API) ─────────────────────────── */
  function _pollActivity(market) {
    var condId = market.condition_id;
    var url = _cfg.dataBase + '/activity?market=' + condId + '&limit=50';
    _fetchProxyText(url, 8000, function (err, data) {
      if (err || !data) {
        _status.activity.err = err || 'no data';
        // Not critical — silently continue
        return;
      }

      var trades = Array.isArray(data) ? data : (data.data || data.activity || []);
      var whaleBuys  = 0;
      var whaleSells = 0;
      var largest    = 0;

      trades.forEach(function (t) {
        var usdSize = parseFloat(t.usdcSize || t.size || t.amount || 0);
        if (usdSize < _cfg.whaleThreshold) return;

        if (usdSize > largest) largest = usdSize;

        // Determine direction: 'Yes' outcome = buying YES token = bullish
        var outcome = (t.outcome || t.side || '').toLowerCase();
        if (outcome === 'yes' || outcome === 'buy') whaleBuys++;
        else whaleSells++;
      });

      var netWhales = whaleBuys - whaleSells;
      var bias = netWhales > 0 ? 'BUY' : netWhales < 0 ? 'SELL' : 'NEUTRAL';

      _actCache[condId] = {
        whaleCount:   whaleBuys + whaleSells,
        netWhales:    netWhales,
        largestTrade: largest,
        whaleBias:    bias,
        ts:           Date.now(),
      };

      _status.activity.ok    = true;
      _status.activity.count = Object.keys(_actCache).length;
      _status.activity.last  = _hhmm();
      _status.activity.err   = '';

      _renderPanel();
    });
  }

  /* ── PANEL RENDER ────────────────────────────────────────────────────────── */
  function _renderPanel() {
    var el = document.getElementById(_cfg.panelId);
    if (!el) return;

    // ── Header ──
    var total = _seen.size;
    var html  = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
      + '<span class="signal-tag polymarket">POLYMARKET</span>'
      + '<span style="font-size:10px;color:var(--dim)">'
      +   (_markets.length ? _markets.length + ' geo markets · ' + total + ' injected' : 'no markets loaded')
      + '</span></div>';

    // ── Feed Status Rows ──
    var feedDefs = [
      { key: 'markets',   label: 'Gamma Markets', src: 'gamma-api' },
      { key: 'orderbook', label: 'CLOB Order Book', src: 'clob+proxy' },
      { key: 'activity',  label: 'Whale Trades', src: 'data-api+proxy' },
    ];
    feedDefs.forEach(function (f) {
      var s   = _status[f.key];
      var dot = s.ok
        ? '<span style="color:var(--green);font-size:10px">●</span>'
        : '<span style="color:var(--red);font-size:10px">○</span>';
      var info = s.ok
        ? s.count + ' · ' + (s.last || '--')
        : (s.err || 'offline');
      html += '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--border);font-size:10px">'
        + dot
        + '<span style="min-width:90px;font-weight:bold;color:var(--text)">' + f.label + '</span>'
        + '<span style="color:var(--dim);flex:1">' + info + '</span>'
        + '<span style="font-size:8px;padding:1px 4px;background:var(--bg);color:var(--dim);border:1px solid var(--border)">'
        + f.src + '</span>'
        + '</div>';
    });

    // ── Top Markets Table ──
    if (_markets.length) {
      html += '<div style="margin-top:8px">';
      _markets.slice(0, 5).forEach(function (m) {
        var yp  = _yesPrice(m);
        var ypPct = Math.round(yp * 100);
        var ob  = (_obCache[m.condition_id] || {}).imbalance || 0;
        var act = _actCache[m.condition_id] || {};
        var region = _textToRegion(m.question || '');

        // Yield YES bar
        var yesBarColor = yp >= 0.6 ? 'var(--red)' : yp >= 0.4 ? 'var(--amber)' : 'var(--green)';
        // (high YES = higher geo risk = red; low YES = calmer = green)

        // OB imbalance: center-origin bar
        var obPct    = Math.round(Math.abs(ob) * 50);  // 0-50% from center
        var obFill   = ob > 0.05
          ? '<div class="pm-ob-fill-bid" style="width:' + obPct + '%"></div>'
          : ob < -0.05
          ? '<div class="pm-ob-fill-ask" style="width:' + obPct + '%"></div>'
          : '';
        var obLabel = ob > 0.05
          ? '<span style="color:var(--green);font-size:8px">+' + Math.round(ob*100) + '% BID</span>'
          : ob < -0.05
          ? '<span style="color:var(--red);font-size:8px">-' + Math.round(Math.abs(ob)*100) + '% ASK</span>'
          : '<span style="color:var(--dim);font-size:8px">NEUTRAL</span>';

        // Whale badge
        var whaleBadge = '';
        if (act.whaleBias === 'BUY') {
          whaleBadge = '<span style="color:var(--green);font-size:8px;margin-left:4px">⬆WHALE×' + act.whaleCount + '</span>';
        } else if (act.whaleBias === 'SELL') {
          whaleBadge = '<span style="color:var(--red);font-size:8px;margin-left:4px">⬇WHALE×' + act.whaleCount + '</span>';
        }

        html += '<div style="padding:5px 0;border-bottom:1px solid var(--border)">'
          // Question text
          + '<div style="font-size:9px;color:var(--bright);margin-bottom:3px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:340px">'
          +   m.question.slice(0, 80)
          + '</div>'
          // Metrics row
          + '<div style="display:flex;align-items:center;gap:6px">'
          // YES% bar
          + '<div style="width:60px;height:4px;background:var(--bg3);position:relative">'
          +   '<div style="width:' + ypPct + '%;height:100%;background:' + yesBarColor + '"></div>'
          + '</div>'
          + '<span style="font-size:9px;color:' + yesBarColor + ';min-width:28px">' + ypPct + '%</span>'
          // OB bar
          + '<div class="pm-ob-bar">' + obFill + '</div>'
          + obLabel
          // Whale badge
          + whaleBadge
          // Region tag
          + '<span style="color:var(--dim);font-size:8px;margin-left:auto">' + region.slice(0, 12) + '</span>'
          + '</div></div>';
      });
      html += '</div>';
    }

    // ── Footer ──
    html += '<div style="margin-top:8px;font-size:9px;color:var(--dim)">'
      + 'PM×: <span style="color:#1ec8e0;font-weight:bold">' + _cfg.pmMult.toFixed(1) + '×</span>'
      + ' · Mode: <span style="color:var(--green)">PAPER ONLY</span>'
      + ' · YES price = capital-weighted wallet consensus'
      + '</div>'
      + '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">'
      + '<button onclick="PM.pollAll()" style="font-size:9px;padding:2px 8px;background:var(--bg3);border:1px solid #1ec8e0;color:#1ec8e0;cursor:pointer;letter-spacing:0.5px">▶ POLL NOW</button>'
      + '<button onclick="PM.toggleEnabled()" style="font-size:9px;padding:2px 8px;background:var(--bg3);border:1px solid var(--border);color:var(--dim);cursor:pointer">'
      + (_cfg.enabled ? '■ PAUSE' : '▶ RESUME') + '</button>'
      + '</div>';

    el.innerHTML = html;
  }

  /* ── DEMO ────────────────────────────────────────────────────────────────── */
  function _runDemo() {
    var IC = window.__IC;
    if (!IC || typeof IC.ingest !== 'function') {
      console.warn('[Polymarket] IC pipeline not ready for demo');
      return;
    }

    var demos = [
      {
        condition_id: 'demo_iran_001',
        question: 'Will Iran launch a direct military attack on Israel before June 2026?',
        outcomePrices: ['0.68','0.32'],
        volume24hr: 124000,
        tokens: [],
        _sig: { pmYesProb: 0.71, pmImbalance: 0.22, pmWhaleNet: 3, whaleBias: 'BUY', whaleCount: 3, largestTrade: 8400 }
      },
      {
        condition_id: 'demo_wti_001',
        question: 'Will WTI crude oil exceed $95 per barrel before end of Q2 2026?',
        outcomePrices: ['0.54','0.46'],
        volume24hr: 89000,
        tokens: [],
        _sig: { pmYesProb: 0.54, pmImbalance: 0.08, pmWhaleNet: 1, whaleBias: 'BUY', whaleCount: 1, largestTrade: 1200 }
      },
      {
        condition_id: 'demo_russia_001',
        question: 'Will Russia launch a major new offensive in Ukraine before May 2026?',
        outcomePrices: ['0.41','0.59'],
        volume24hr: 210000,
        tokens: [],
        _sig: { pmYesProb: 0.42, pmImbalance: -0.05, pmWhaleNet: -1, whaleBias: 'SELL', whaleCount: 2, largestTrade: 3100 }
      },
    ];

    demos.forEach(function (m, i) {
      setTimeout(function () {
        _obCache[m.condition_id] = { imbalance: m._sig.pmImbalance, ts: Date.now() };
        _actCache[m.condition_id] = {
          netWhales: m._sig.pmWhaleNet, whaleBias: m._sig.whaleBias,
          whaleCount: m._sig.whaleCount, largestTrade: m._sig.largestTrade,
        };
        // Allow re-injection for demo (clear dedup key)
        _seen.delete('pm_' + m.condition_id);
        _inject(m, m._sig);
        console.log('[Polymarket] Demo: injected "' + m.question.slice(0, 40) + '…"');
      }, i * 600);
    });
  }

  /* ── BOOT ─────────────────────────────────────────────────────────────────── */
  function _start() {
    // Initial poll
    _pollMarkets();
    // Recurring polls
    setInterval(_pollMarkets, _cfg.pollMarkets);
    // OB + activity are triggered from within _pollMarkets after markets load
    // But also run them independently to keep them fresh between market polls
    setInterval(function () {
      _markets.forEach(function (m, i) {
        setTimeout(function () { _pollOrderBook(m); }, i * 600);
      });
    }, _cfg.pollOrderBook);
    setInterval(function () {
      _markets.forEach(function (m, i) {
        setTimeout(function () { _pollActivity(m); }, i * 800);
      });
    }, _cfg.pollActivity);

    // Panel refresh
    _renderPanel();
    setInterval(_renderPanel, 15000);  // keep panel live even without new data

    console.log('[Polymarket] V1 active | Mult: ' + _cfg.pmMult + '× | Mode: PAPER ONLY');
  }

  /* ── PUBLIC API ──────────────────────────────────────────────────────────── */
  window.PM = {
    config: function (opts) {
      if (opts && opts.pmMult   !== undefined) _cfg.pmMult   = Math.max(0.1, Math.min(3.0, parseFloat(opts.pmMult) || 1.0));
      if (opts && opts.enabled  !== undefined) _cfg.enabled  = !!opts.enabled;
      if (opts && opts.proxy    !== undefined) _cfg.proxy    = opts.proxy;
      _renderPanel();
    },
    pollAll: function () {
      _pollMarkets();
    },
    setMult: function (v) {
      _cfg.pmMult = Math.max(0.1, Math.min(3.0, parseFloat(v) || 1.0));
      _renderPanel();
    },
    toggleEnabled: function () {
      _cfg.enabled = !_cfg.enabled;
      console.log('[Polymarket] ' + (_cfg.enabled ? 'enabled' : 'paused'));
      _renderPanel();
    },
    demo: function () {
      _runDemo();
    },
    status: function () {
      return JSON.parse(JSON.stringify(_status));
    },
    markets: function () {
      return _markets.slice();
    },
    events: function () {
      return _pmEvents.slice();
    },
  };

  // Boot after IC pipeline is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _start);
  } else {
    setTimeout(_start, 1500);  // slight delay to let IC and ShadowBroker initialise first
  }

})();
