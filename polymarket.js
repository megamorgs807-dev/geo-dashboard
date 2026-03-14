/* ══ POLYMARKET PREDICTION MARKET INTEGRATION ══════════════════════════════════
   Two signal streams fed into the IC pipeline:

   STREAM 1 — Geopolitical markets (geo + macro)
     YES token price (wallet consensus) · order book imbalance · whale trades
     pmBoost: 0-18 pts added by scoreEvent() when PM confirms a geo signal

   STREAM 2 — Short-term direction markets (new in V12)
     Hourly / 4H / 24H BTC/ETH/SOL direction bets
     stBoost: 0-8 pts added by scoreEvent() based on conviction distance from 0.5
     One slot per asset — highest conviction wins; refreshed every 60 s

   window.PM public API:
     PM.config({ pmMult, enabled })   — reconfigure
     PM.pollAll()                     — fire all pollers immediately
     PM.setMult(v)                    — set aggressiveness multiplier
     PM.toggleEnabled()               — pause / resume
     PM.demo()                        — inject 3 synthetic demo events
     PM.status()                      — return copy of _status
     PM.markets()                     — return copy of geo _markets array
     PM.events()                      — return scored geo event cache
     PM.stEvents()                    — return scored ST direction event cache

   V12  2026-03-14
   ══════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── CONFIG ──────────────────────────────────────────────────────────────── */
  var _cfg = {
    enabled:          true,
    pmMult:           1.0,               // aggressiveness multiplier 0.1-3.0
    pollMarkets:      300000,            // 5 min — Gamma discovery (geo markets)
    pollOrderBook:     60000,            // 1 min — CLOB order book refresh
    pollActivity:     120000,            // 2 min — whale trade scan
    minVolume:          5000,            // min 24h USD volume for geo markets
    minYesPrice:        0.05,            // ignore near-zero (no real signal)
    maxYesPrice:        0.95,            // ignore near-certain (already priced in)
    whaleThreshold:     1000,            // min USD size to count as whale trade
    stDiscoverPoll:   300000,            // 5 min — rediscover ST direction markets
    stPollMs:          60000,            // 60s  — refresh ST market prices
    stMinVol:              1,            // min 24h vol — hourly direction bets have tiny vol ($5-$20)
    stMinConviction:    0.08,            // |YES - 0.5| threshold; 0.08 = outside 42-58% band
    gammaBase: 'https://gamma-api.polymarket.com',
    clobBase:  'https://clob.polymarket.com',
    dataBase:  'https://data-api.polymarket.com',
    proxy:     'https://corsproxy.io/?',
    panelId:   'pmStatusPanel',
  };

  /* ── STATE ───────────────────────────────────────────────────────────────── */
  var _status = {
    markets:   { ok: false, count: 0, last: null, err: '' },
    orderbook: { ok: false, count: 0, last: null, err: '' },
    activity:  { ok: false, count: 0, last: null, err: '' },
    st:        { ok: false, count: 0, last: null, err: '' },
  };
  var _markets     = [];   // geo filtered + normalised market objects
  var _obCache     = {};   // condition_id → {bidVol, askVol, imbalance, ts}
  var _actCache    = {};   // condition_id → {whaleCount, netWhales, largestTrade, whaleBias}
  var _seen        = new Set();
  var _pmEvents    = [];   // scored geo PM event cache (max 20) — won't be evicted by IC overflow
  var _stMarkets   = [];   // filtered short-term direction markets (one per asset)
  var _stEvents    = [];   // scored ST event cache (max 10) — one slot per asset
  var _stLastTitle = {};   // asset code → last injected IC title (for dedup cleanup)

  /* ── GEO MARKET KEYWORD FILTER ───────────────────────────────────────────── */
  var PM_GEO_KWS = [
    // Conflict / military
    'conflict','attack','military','missile','troops','invasion','airstrike',
    'strike','ceasefire','nato','nuclear','sanction','offensive','coup','assassination',
    'drone','blockade','warfare','warhead','peacekeeping','arms deal',

    // Energy / commodities
    'oil','crude','opec','gas','petroleum','hormuz','energy','barrel','brent','wti',
    'natural gas','lng','uranium','lithium','copper','wheat','corn','soybean',
    'rare earth','palladium','platinum','coal',

    // Geopolitical countries & hotspots
    'iran','russia','ukraine','taiwan','china','israel','gaza','hamas','hezbollah',
    'north korea','korea','pakistan','india','saudi','houthi','yemen','syria','iraq',
    'venezuela','crimea','donbas','turkey','afghanistan','myanmar','ethiopia','sudan',
    'mexico','nato','europe','european union','g7','g20',

    // US macro / politics
    'election','regime','tariff','trade war','default','inflation','recession','stagflation',
    'interest rate','federal reserve','fomc','rate cut','rate hike','basis point',
    'trump','congress','senate','house vote','debt ceiling','government shutdown',
    'gdp','unemployment','nonfarm','payroll','cpi','ppi','jobs report',
    'powell','yellen','treasury','stimulus','spending bill','budget',

    // Geopolitical leaders & orgs
    'putin','zelensky','netanyahu','xi jinping','kim jong','modi','erdogan',
    'imf','world bank','wto','opec','brics','un security',

    // Crypto
    'bitcoin','btc','ethereum','eth','crypto','solana','xrp','ripple',
    'dogecoin','coinbase','binance','stablecoin','tether','usdc',
    'defi','nft','crypto regulation','sec crypto','tiktok ban',

    // Financial markets & instruments
    'nasdaq','s&p 500','dow jones','vix','gold price','silver price',
    'dollar index','dxy','yen','yuan','renminbi','euro','pound sterling',
    '10-year','treasury yield','bond yield','fed balance','quantitative',
    'ipo','merger','acquisition','bankruptcy','short squeeze',

    // Tech / strategic
    'semiconductor','chip ban','huawei','tiktok','ai regulation',
    'antitrust','monopoly','data privacy',
  ];

  /* ── REGION MAPPING ──────────────────────────────────────────────────────── */
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
    ['oil','MIDDLE EAST'],          ['crude','MIDDLE EAST'],
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

  /* ── SHORT-TERM DIRECTION MARKET DETECTION ───────────────────────────────── */
  // Must match at least one of these to qualify as a direction market
  var _ST_POS = [
    // Classic direction phrasing
    'higher in', 'be higher', 'go up', 'up or down', 'higher or lower',
    'above or below', 'above $', 'below $', 'reach $', 'hit $', 'exceed $',
    'less than $', 'greater than $', 'more than $',
    'be above', 'be below', 'fall below', 'drop below', 'close above', 'close below',
    'lower than', 'higher than',
    // Time-scoped end events
    'end of day', 'end of week', 'by end of day', 'by end of week',
    // Explicit short timeframes
    'in 1 hour', 'in 2 hour', 'in 4 hour', 'in 6 hour', 'in 12 hour',
    'in 24 hour', 'next hour', 'this hour',
  ];
  // Disqualify if any of these match — long-term or non-price markets
  var _ST_NEJ = [
    'q1 2026','q2 2026','q3 2026','q4 2026','q1 2027',
    'march 2026','april 2026','may 2026','june 2026','july 2026',
    'august 2026','september 2026','october 2026',
    'year end','end of year','all time high','all-time high','ever reach',
    'election','win the ','championship','super bowl','world cup','mvp',
    'military','launch a','attack on','invasion','troops',    // geo → use geo pipeline
  ];
  // Asset name patterns → ticker code (checked in order, first match wins)
  var _ST_ASSETS = [
    { p: ['bitcoin','btc'],            c: 'BTC' },
    { p: ['ethereum',' eth ','eth/'],  c: 'ETH' },
    { p: ['solana',' sol ','sol/'],    c: 'SOL' },
    { p: ['ripple',' xrp'],            c: 'XRP' },
    { p: ['dogecoin','doge'],          c: 'DOGE' },
    { p: [' bnb','binance coin'],      c: 'BNB' },
    { p: ['gold price','xau/usd'],     c: 'GLD' },
    { p: ['s&p 500',' spx ',' spy '], c: 'SPY' },
    { p: ['nasdaq',' qqq'],            c: 'QQQ' },
    { p: ['crude oil',' wti ','brent'],c: 'WTI' },
    { p: ['silver price',' slv '],     c: 'SLV' },
  ];

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

  /* ── GENERAL HELPERS ─────────────────────────────────────────────────────── */
  function _hhmm() {
    var d = new Date();
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  }

  // Gamma API returns outcomePrices + tokens as JSON strings — parse safely
  function _parseField(v, fallback) {
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return fallback; } }
    return v || fallback;
  }

  // YES price from market object (handles string-encoded outcomePrices)
  function _yesPrice(market) {
    var op = market.outcomePrices || ['0'];
    if (typeof op === 'string') { try { op = JSON.parse(op); } catch (e) { op = ['0']; } }
    return parseFloat(op[0]) || 0;
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
    ' vs ', ' vs. ', 'nfl ', 'nba ', 'nhl ', 'mlb ', 'premier league',
    'super bowl', 'world series', 'stanley cup', 'playoffs', 'championship game',
    'oilers', 'rangers', 'warriors', 'rockets', 'patriots', 'raiders', 'capitals',
    'nationals', 'strikers', 'united fc', ' fc ', ' afc ', ' nfc ',
  ];
  function _geoMatch(text) {
    var low = (text || '').toLowerCase();
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

  /* ── ST HELPER FUNCTIONS ─────────────────────────────────────────────────── */
  // Extract asset ticker from question text; null = not a recognised asset
  function _stAsset(question) {
    var low = (question || '').toLowerCase();
    for (var i = 0; i < _ST_ASSETS.length; i++) {
      var a = _ST_ASSETS[i];
      for (var j = 0; j < a.p.length; j++) {
        if (low.indexOf(a.p[j]) !== -1) return a.c;
      }
    }
    return null;
  }

  // Extract human-readable timeframe label from question text
  function _stTimeframe(question) {
    var low = (question || '').toLowerCase();
    if (/\b1\s*h(our)?\b/.test(low) || low.indexOf('in 1 hour') !== -1 || low.indexOf('next hour') !== -1) return '1H';
    if (/\b4\s*h(our)?\b/.test(low) || low.indexOf('in 4 hour') !== -1) return '4H';
    if (/\b6\s*h(our)?\b/.test(low) || low.indexOf('in 6 hour') !== -1) return '6H';
    if (/\b12\s*h(our)?\b/.test(low) || low.indexOf('in 12 hour') !== -1) return '12H';
    if (/\b24\s*h(our)?\b/.test(low) || low.indexOf('in 24 hour') !== -1 || low.indexOf('24 hours') !== -1) return '24H';
    if (low.indexOf('end of day') !== -1 || low.indexOf('by end of day') !== -1) return 'EOD';
    if (low.indexOf('end of week') !== -1) return 'EOW';
    if (low.indexOf('today') !== -1) return 'TODAY';
    return 'DAY';
  }

  // Does the question contain an explicit short-term time keyword?
  function _hasSTTimeword(question) {
    var low = (question || '').toLowerCase();
    return low.indexOf('1 hour') !== -1
      || low.indexOf('4 hour') !== -1
      || low.indexOf('24 hour') !== -1
      || low.indexOf('next hour') !== -1
      || low.indexOf('end of day') !== -1
      || low.indexOf('this hour') !== -1;
  }

  // Combined filter: is this market a short-term direction bet on a known asset?
  function _isSTMarket(m) {
    var q = (m.question || '').toLowerCase();
    if (!_stAsset(q)) return false;                             // must be a known asset
    for (var n = 0; n < _ST_NEJ.length; n++) {
      if (q.indexOf(_ST_NEJ[n]) !== -1) return false;          // rejected
    }
    for (var p = 0; p < _ST_POS.length; p++) {
      if (q.indexOf(_ST_POS[p]) !== -1) return true;           // positive match
    }
    return false;
  }

  // Format ms remaining as "2h 15m" or "<1h" etc.
  function _tte(endDate) {
    if (!endDate) return '';
    var msLeft = new Date(endDate).getTime() - Date.now();
    if (msLeft <= 0) return 'exp';
    var hLeft = Math.floor(msLeft / 3600000);
    var mLeft = Math.floor((msLeft % 3600000) / 60000);
    if (hLeft > 0) return hLeft + 'h' + (mLeft > 0 ? mLeft + 'm' : '');
    return mLeft > 0 ? mLeft + 'm' : '<1m';
  }

  /* ── GEO SIGNAL SYNTHESIS ────────────────────────────────────────────────── */
  function _synthesise(market) {
    var yp  = _yesPrice(market);
    var vol = parseFloat(market.volume24hr || market.volume || 0);
    var ob  = (_obCache[market.condition_id] || {}).imbalance || 0;
    var act = _actCache[market.condition_id] || {};
    var net = act.netWhales || 0;

    var volW   = Math.min(1.0, Math.log10(Math.max(1, vol)) / Math.log10(50000));
    var whaleW = net / (Math.abs(net) + 3);

    var obContrib    = 0.5 + ob    * 0.5;
    var whaleContrib = 0.5 + whaleW * 0.5;
    var rawSignal    = yp * 0.55 + obContrib * 0.25 + whaleContrib * 0.10 + volW * 0.10;
    var pmYesProb    = Math.min(1.0, Math.max(0, rawSignal * _cfg.pmMult));

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

  /* ── INJECT GEO MARKET INTO IC PIPELINE ─────────────────────────────────── */
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

    var icKey = title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 48);
    if (IC.eventIds) IC.eventIds.delete(icKey);
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

  /* ── INJECT ST DIRECTION SIGNAL INTO IC PIPELINE ────────────────────────── */
  function _injectST(m) {
    if (!_cfg.enabled) return;
    var IC = window.__IC;
    if (!IC || typeof IC.ingest !== 'function') return;

    var yp = _yesPrice(m);
    var conviction = Math.abs(yp - 0.5);
    if (conviction < _cfg.stMinConviction) return; // inside 42-58% band — no clear signal

    var asset = m.stAsset || 'CRYPTO';
    var dir   = yp >= 0.5 ? '↑' : '↓';
    var pct   = Math.round(yp * 100);
    var tf    = m.stTimeframe || 'DAY';
    var tte   = _tte(m.endDate);

    var title = '[ST] ' + asset + dir + pct + '% · ' + tf + (tte ? ' · ' + tte : '');
    var desc  = 'Short-term direction | ' + m.question.slice(0, 80)
      + ' | Conviction: ' + Math.round(conviction * 100) + '%'
      + (tte ? ' | Expires in: ' + tte : '');

    // Clear old dedup key for this asset (title changes each update cycle as % shifts)
    if (_stLastTitle[asset]) {
      var oldKey = _stLastTitle[asset].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 48);
      if (IC.eventIds) IC.eventIds.delete(oldKey);
    }
    var icKey = title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 48);
    if (IC.eventIds) IC.eventIds.delete(icKey);
    _stLastTitle[asset] = title;

    // Remove stale IC event for this asset before re-injecting
    for (var i = IC.events.length - 1; i >= 0; i--) {
      if (IC.events[i].stAsset === asset && IC.events[i].stFeed) {
        IC.events.splice(i, 1); break;
      }
    }

    IC.ingest(title, desc, 'Polymarket/ST', {
      ts:           Date.now(),
      region:       'GLOBAL',
      srcCount:     1,
      socialV:      yp,
      stFeed:       'direction',
      stAsset:      asset,
      stDir:        dir,
      stYesProb:    yp,
      stConviction: conviction,
      stTimeframe:  tf,
      pmFeed:       null,   // suppress pmBadge — stBadge handles display
    });

    // Capture scored event into persistent cache
    if (IC.events[0] && IC.events[0].stAsset === asset) {
      var scored = IC.events[0];
      _stEvents = _stEvents.filter(function (e) { return e.stAsset !== asset; });
      _stEvents.unshift({
        title:        scored.title,
        desc:         scored.desc,
        source:       scored.source,
        stFeed:       scored.stFeed,
        stAsset:      asset,
        stDir:        dir,
        stYesProb:    yp,
        stConviction: conviction,
        stTimeframe:  tf,
        signal:       scored.signal,
        stBoost:      scored.stBoost || 0,
        ts:           scored.ts,
        time:         scored.time,
        endDate:      m.endDate,
      });
      if (_stEvents.length > 10) _stEvents.pop();
    }
    _scheduleRedraw();
  }

  /* ── POLL: GEO MARKETS (Gamma API, via proxy) ────────────────────────────── */
  function _pollMarkets() {
    var url = _cfg.gammaBase + '/markets?active=true&closed=false&limit=100&order=volume24hr&ascending=false';
    _fetchProxy(url, 15000, function (err, data) {
      if (err || !Array.isArray(data)) {
        _status.markets.ok  = false;
        _status.markets.err = err || 'no data';
        _renderPanel();
        return;
      }

      var filtered = data.filter(function (m) {
        var yp  = _yesPrice(m);
        var vol = parseFloat(m.volume24hr || m.volume || 0);
        return _geoMatch(m.question || '')
          && vol >= _cfg.minVolume
          && yp >= _cfg.minYesPrice
          && yp <= _cfg.maxYesPrice;
      });

      _markets = filtered.slice(0, 50).map(function (m) {
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

      _markets.forEach(function (m, i) {
        setTimeout(function () {
          var sig = _synthesise(m);
          if (sig.pmYesProb >= 0.35 && sig.pmYesProb <= 0.95) { _inject(m, sig); }
        }, i * 300);
      });

      _markets.forEach(function (m, i) {
        setTimeout(function () { _pollOrderBook(m); }, i * 800 + 500);
        setTimeout(function () { _pollActivity(m); }, i * 1000 + 800);
      });

      _renderPanel();
    });
  }

  /* ── POLL: ORDER BOOK (CLOB, via proxy) ──────────────────────────────────── */
  function _pollOrderBook(market) {
    var tokens   = market.tokens || [];
    var yesToken = null;
    for (var i = 0; i < tokens.length; i++) {
      if ((tokens[i].outcome || '').toLowerCase() === 'yes') {
        yesToken = tokens[i].token_id || tokens[i].tokenId;
        break;
      }
    }
    if (!yesToken) yesToken = tokens[0] && (tokens[0].token_id || tokens[0].tokenId);
    if (!yesToken) return;

    var url = _cfg.clobBase + '/book?token_id=' + yesToken;
    _fetchProxyText(url, 8000, function (err, data) {
      if (err || !data) { _status.orderbook.err = err || 'no data'; return; }

      var bids = data.bids || [];
      var asks = data.asks || [];
      var bidVol = bids.reduce(function (s, b) { return s + parseFloat(b.price||0) * parseFloat(b.size||0); }, 0);
      var askVol = asks.reduce(function (s, a) { return s + parseFloat(a.price||0) * parseFloat(a.size||0); }, 0);
      var total  = bidVol + askVol;
      var imbalance = total > 0.001 ? (bidVol - askVol) / total : 0;

      _obCache[market.condition_id] = { bidVol: bidVol, askVol: askVol, imbalance: imbalance, ts: Date.now() };
      _status.orderbook.ok    = true;
      _status.orderbook.count = Object.keys(_obCache).length;
      _status.orderbook.last  = _hhmm();
      _status.orderbook.err   = '';

      var sig = _synthesise(market);
      if (sig.pmYesProb >= 0.35 && sig.pmYesProb <= 0.95) { _inject(market, sig); }
      _renderPanel();
    });
  }

  /* ── POLL: WHALE ACTIVITY (Data API, via proxy) ───────────────────────────── */
  function _pollActivity(market) {
    var url = _cfg.dataBase + '/activity?market=' + market.condition_id + '&limit=50';
    _fetchProxyText(url, 8000, function (err, data) {
      if (err || !data) { _status.activity.err = err || 'no data'; return; }

      var trades = Array.isArray(data) ? data : (data.data || data.activity || []);
      var whaleBuys = 0, whaleSells = 0, largest = 0;

      trades.forEach(function (t) {
        var usdSize = parseFloat(t.usdcSize || t.size || t.amount || 0);
        if (usdSize < _cfg.whaleThreshold) return;
        if (usdSize > largest) largest = usdSize;
        var outcome = (t.outcome || t.side || '').toLowerCase();
        if (outcome === 'yes' || outcome === 'buy') whaleBuys++;
        else whaleSells++;
      });

      var netWhales = whaleBuys - whaleSells;
      _actCache[market.condition_id] = {
        whaleCount: whaleBuys + whaleSells, netWhales: netWhales,
        largestTrade: largest,
        whaleBias: netWhales > 0 ? 'BUY' : netWhales < 0 ? 'SELL' : 'NEUTRAL',
        ts: Date.now(),
      };
      _status.activity.ok    = true;
      _status.activity.count = Object.keys(_actCache).length;
      _status.activity.last  = _hhmm();
      _status.activity.err   = '';
      _renderPanel();
    });
  }

  /* ── POLL: ST DISCOVER (find short-expiry direction markets) ─────────────── */
  function _pollSTDiscover() {
    if (!_cfg.enabled) return;
    var url = _cfg.gammaBase + '/markets?active=true&closed=false&limit=100&order=volume&ascending=false';
    _fetchProxy(url, 15000, function (err, data) {
      if (err || !Array.isArray(data)) {
        _status.st.err = err || 'no data';
        return;
      }

      var now = Date.now();
      var h7d = 604800000; // 7 days in ms — include weekly price targets too

      var filtered = data.filter(function (m) {
        var vol = parseFloat(m.volume24hr || m.volume || 0);
        if (vol < _cfg.stMinVol) return false;
        if (!_isSTMarket(m)) return false;
        var endMs = m.endDate ? new Date(m.endDate).getTime() : 0;
        var shortExpiry = endMs > now && (endMs - now) < h7d;
        return shortExpiry || _hasSTTimeword(m.question || '');
      });

      // Normalise
      var normalised = filtered.slice(0, 30).map(function (m) {
        return {
          id:           m.id,
          condition_id: m.condition_id || m.conditionId || m.id,
          question:     (m.question || '').trim(),
          outcomePrices: _parseField(m.outcomePrices, ['0.5','0.5']),
          volume24hr:   parseFloat(m.volume24hr || m.volume || 0),
          endDate:      m.endDate || null,
          tokens:       _parseField(m.tokens, []),
          stAsset:      _stAsset(m.question || ''),
          stTimeframe:  _stTimeframe(m.question || ''),
        };
      });

      // De-duplicate: one market per asset — keep highest volume
      var bestByAsset = {};
      normalised.forEach(function (m) {
        var a = m.stAsset;
        if (!bestByAsset[a] || m.volume24hr > bestByAsset[a].volume24hr) {
          bestByAsset[a] = m;
        }
      });
      _stMarkets = Object.keys(bestByAsset).map(function (k) { return bestByAsset[k]; });

      _status.st.ok    = true;
      _status.st.count = _stMarkets.length;
      _status.st.last  = _hhmm();
      _status.st.err   = '';

      // Inject immediately — staggered to avoid proxy rate limits
      _stMarkets.forEach(function (m, i) {
        setTimeout(function () { _injectST(m); }, i * 400);
      });

      _renderPanel();
    });
  }

  /* ── POLL: ST PRICE REFRESH (individual Gamma market endpoint) ───────────── */
  function _pollSTPrice() {
    if (!_cfg.enabled || !_stMarkets.length) return;
    _stMarkets.forEach(function (m, i) {
      setTimeout(function () {
        if (!m.id) { _injectST(m); return; } // no market ID — re-use cached price
        var url = _cfg.gammaBase + '/markets/' + m.id;
        _fetchProxy(url, 8000, function (err, data) {
          if (err || !data) { _injectST(m); return; } // network error — inject with cached price
          m.outcomePrices = _parseField(data.outcomePrices, m.outcomePrices);
          _injectST(m);
        });
      }, i * 600);
    });
  }

  /* ── PANEL RENDER ────────────────────────────────────────────────────────── */
  function _renderPanel() {
    var el = document.getElementById(_cfg.panelId);
    if (!el) return;

    var total = _seen.size;
    var html  = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
      + '<span class="signal-tag polymarket">POLYMARKET</span>'
      + '<span style="font-size:10px;color:var(--dim)">'
      +   (_markets.length ? _markets.length + ' geo · ' + total + ' injected' : 'no markets loaded')
      + '</span>'
      + (_stMarkets.length ? '<span style="font-size:10px;color:#e86020;margin-left:auto">' + _stMarkets.length + ' ST direction</span>' : '')
      + '</div>';

    // ── Feed Status Rows ──
    var feedDefs = [
      { key: 'markets',   label: 'Gamma Markets',    src: 'gamma-api' },
      { key: 'orderbook', label: 'CLOB Order Book',  src: 'clob+proxy' },
      { key: 'activity',  label: 'Whale Trades',     src: 'data-api+proxy' },
      { key: 'st',        label: 'ST Direction',     src: 'gamma+proxy' },
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

    // ── ST Momentum Strip ──
    if (_stEvents.length) {
      html += '<div style="margin-top:8px;padding:6px;background:rgba(232,96,32,0.08);border:1px solid rgba(232,96,32,0.3);border-radius:2px">'
        + '<div style="font-size:8px;color:#e86020;font-weight:bold;letter-spacing:1px;margin-bottom:5px">⚡ SHORT-TERM DIRECTION</div>'
        + '<div style="display:flex;flex-wrap:wrap;gap:5px">';
      _stEvents.slice(0, 6).forEach(function (e) {
        var upColor = 'var(--green)';
        var dnColor = 'var(--red)';
        var color   = e.stDir === '↑' ? upColor : dnColor;
        var tte     = _tte(e.endDate);
        html += '<div style="background:var(--bg3);padding:3px 7px;font-size:9px;border:1px solid rgba(232,96,32,0.2)">'
          + '<span style="color:' + color + ';font-weight:bold">'
          + e.stAsset + e.stDir + Math.round(e.stYesProb * 100) + '%</span>'
          + '<span style="color:var(--dim);font-size:8px"> ' + e.stTimeframe
          + (tte ? ' · ' + tte : '') + '</span>'
          + '</div>';
      });
      html += '</div></div>';
    }

    // ── Top Geo Markets Table ──
    if (_markets.length) {
      html += '<div style="margin-top:8px">';
      _markets.slice(0, 5).forEach(function (m) {
        var yp      = _yesPrice(m);
        var ypPct   = Math.round(yp * 100);
        var ob      = (_obCache[m.condition_id] || {}).imbalance || 0;
        var act     = _actCache[m.condition_id] || {};
        var region  = _textToRegion(m.question || '');
        var barClr  = yp >= 0.6 ? 'var(--red)' : yp >= 0.4 ? 'var(--amber)' : 'var(--green)';
        var obPct   = Math.round(Math.abs(ob) * 50);
        var obFill  = ob > 0.05
          ? '<div class="pm-ob-fill-bid" style="width:' + obPct + '%"></div>'
          : ob < -0.05
          ? '<div class="pm-ob-fill-ask" style="width:' + obPct + '%"></div>'
          : '';
        var obLabel = ob > 0.05
          ? '<span style="color:var(--green);font-size:8px">+' + Math.round(ob*100) + '% BID</span>'
          : ob < -0.05
          ? '<span style="color:var(--red);font-size:8px">-' + Math.round(Math.abs(ob)*100) + '% ASK</span>'
          : '<span style="color:var(--dim);font-size:8px">NEUTRAL</span>';
        var whaleBadge = '';
        if (act.whaleBias === 'BUY') {
          whaleBadge = '<span style="color:var(--green);font-size:8px;margin-left:4px">⬆WHALE×' + act.whaleCount + '</span>';
        } else if (act.whaleBias === 'SELL') {
          whaleBadge = '<span style="color:var(--red);font-size:8px;margin-left:4px">⬇WHALE×' + act.whaleCount + '</span>';
        }

        html += '<div style="padding:5px 0;border-bottom:1px solid var(--border)">'
          + '<div style="font-size:9px;color:var(--bright);margin-bottom:3px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:340px">'
          +   m.question.slice(0, 80)
          + '</div>'
          + '<div style="display:flex;align-items:center;gap:6px">'
          + '<div style="width:60px;height:4px;background:var(--bg3);position:relative">'
          +   '<div style="width:' + ypPct + '%;height:100%;background:' + barClr + '"></div>'
          + '</div>'
          + '<span style="font-size:9px;color:' + barClr + ';min-width:28px">' + ypPct + '%</span>'
          + '<div class="pm-ob-bar">' + obFill + '</div>'
          + obLabel
          + whaleBadge
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
        outcomePrices: ['0.68','0.32'], volume24hr: 124000, tokens: [],
        _sig: { pmYesProb: 0.71, pmImbalance: 0.22, pmWhaleNet: 3, whaleBias: 'BUY', whaleCount: 3, largestTrade: 8400 }
      },
      {
        condition_id: 'demo_wti_001',
        question: 'Will WTI crude oil exceed $95 per barrel before end of Q2 2026?',
        outcomePrices: ['0.54','0.46'], volume24hr: 89000, tokens: [],
        _sig: { pmYesProb: 0.54, pmImbalance: 0.08, pmWhaleNet: 1, whaleBias: 'BUY', whaleCount: 1, largestTrade: 1200 }
      },
      {
        condition_id: 'demo_russia_001',
        question: 'Will Russia launch a major new offensive in Ukraine before May 2026?',
        outcomePrices: ['0.41','0.59'], volume24hr: 210000, tokens: [],
        _sig: { pmYesProb: 0.42, pmImbalance: -0.05, pmWhaleNet: -1, whaleBias: 'SELL', whaleCount: 2, largestTrade: 3100 }
      },
    ];
    demos.forEach(function (m, i) {
      setTimeout(function () {
        _obCache[m.condition_id]  = { imbalance: m._sig.pmImbalance, ts: Date.now() };
        _actCache[m.condition_id] = {
          netWhales: m._sig.pmWhaleNet, whaleBias: m._sig.whaleBias,
          whaleCount: m._sig.whaleCount, largestTrade: m._sig.largestTrade,
        };
        _seen.delete('pm_' + m.condition_id);
        _inject(m, m._sig);
        console.log('[Polymarket] Demo: injected "' + m.question.slice(0, 40) + '…"');
      }, i * 600);
    });
  }

  /* ── BOOT ─────────────────────────────────────────────────────────────────── */
  function _start() {
    // Geo markets
    _pollMarkets();
    setInterval(_pollMarkets, _cfg.pollMarkets);
    setInterval(function () {
      _markets.forEach(function (m, i) { setTimeout(function () { _pollOrderBook(m); }, i * 600); });
    }, _cfg.pollOrderBook);
    setInterval(function () {
      _markets.forEach(function (m, i) { setTimeout(function () { _pollActivity(m); }, i * 800); });
    }, _cfg.pollActivity);

    // Short-term direction markets
    setTimeout(function () {
      _pollSTDiscover();
      setInterval(_pollSTDiscover, _cfg.stDiscoverPoll);
      setInterval(_pollSTPrice,    _cfg.stPollMs);
    }, 3000); // slight offset so geo poll goes first

    // Panel refresh
    _renderPanel();
    setInterval(_renderPanel, 15000);

    console.log('[Polymarket] V12 active | Geo markets + ST direction | Mult: ' + _cfg.pmMult + '× | PAPER ONLY');
  }

  /* ── PUBLIC API ──────────────────────────────────────────────────────────── */
  window.PM = {
    config: function (opts) {
      if (opts && opts.pmMult  !== undefined) _cfg.pmMult  = Math.max(0.1, Math.min(3.0, parseFloat(opts.pmMult) || 1.0));
      if (opts && opts.enabled !== undefined) _cfg.enabled = !!opts.enabled;
      if (opts && opts.proxy   !== undefined) _cfg.proxy   = opts.proxy;
      _renderPanel();
    },
    pollAll: function () {
      _pollMarkets();
      _pollSTDiscover();
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
    demo:     function () { _runDemo(); },
    status:   function () { return JSON.parse(JSON.stringify(_status)); },
    markets:  function () { return _markets.slice(); },
    events:   function () { return _pmEvents.slice(); },
    stEvents: function () { return _stEvents.slice(); },
  };

  // Boot after IC pipeline is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _start);
  } else {
    setTimeout(_start, 1500);
  }

})();
