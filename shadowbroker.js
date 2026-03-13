/* ══════════════════════════════════════════════════════════════════════════════
   SHADOWBROKER INTEGRATION MODULE
   ══════════════════════════════════════════════════════════════════════════════
   Pulls from ShadowBroker's local OSINT feeds (GDELT, Maritime/AIS, Aircraft/
   ADS-B, Earthquakes, Satellites) and injects normalised events into the
   Geopolitical Dashboard AI pipeline.

   How it fits into the existing pipeline:
     ShadowBroker feeds
       → normalise to {title, desc, source, region, ts, srcCount, socialV, ...}
       → window.__IC.ingest(title, desc, source, extras)
         → scoreEvent() runs (SEV + GEO + MKTMAP keyword scoring, S1–S6)
         → event lands in IC.events[]
       → window.__IC.redrawAll()
         → renderTrades() recomputes candidates + calls EE.onSignals()
           → Execution Engine opens paper trades automatically

   Design rules:
     • Does NOT touch any existing scoring logic, thresholds, or trade rules
     • All trades remain in SIMULATION / paper mode
     • Graceful degradation — if ShadowBroker is offline, falls back to public
       APIs (USGS earthquakes, GDELT Doc API via corsproxy.io)
     • SB_CONF_MULT scales socialV, boosting signal confidence for ShadowBroker
       events without altering the formula itself
   ══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── CONFIG (override before script loads via window.SB_CONFIG) ─────────── */
  var _cfg = Object.assign({
    api:          'http://localhost:8000',   // ShadowBroker FastAPI base URL
    enabled:      true,                      // master on/off switch
    confMult:     1.0,                       // confidence multiplier (0.1–3.0)
    pollGdelt:    300000,                    // 5 min  (GDELT updates every 6h)
    pollSeismic:   60000,                    // 1 min  (USGS 60s updates)
    pollMaritime: 120000,                    // 2 min  (AIS near-real-time)
    pollAircraft: 120000,                    // 2 min  (ADS-B 60s updates)
    pollSatellite:300000,                    // 5 min  (TLE propagation ~60s)
    minMagnitude:   5.5,                     // seismic threshold (Richter)
    panelId:      'sbStatusPanel',           // DOM ID for the status panel
  }, window.SB_CONFIG || {});

  /* ── STATUS TRACKING ────────────────────────────────────────────────────── */
  var _status = {
    gdelt:     { ok: false, count: 0, last: null, err: '' },
    seismic:   { ok: false, count: 0, last: null, err: '' },
    maritime:  { ok: false, count: 0, last: null, err: '' },
    aircraft:  { ok: false, count: 0, last: null, err: '' },
    satellite: { ok: false, count: 0, last: null, err: '' },
  };

  /* Deduplication — keeps last 1 000 injected keys */
  var _seen = new Set();

  /* ══════════════════════════════════════════════════════════════════════════
     GEOGRAPHY HELPERS
     Map lat/lon → dashboard region labels.  Checked in order — more specific
     straits first so they override broad regions.
  ══════════════════════════════════════════════════════════════════════════ */

  var GEO_BOXES = [
    // [latMin, latMax, lonMin, lonMax, regionLabel]
    // ── Critical straits / chokepoints ───────────────────────────────────
    [23, 28,  56,  60, 'STRAIT OF HORMUZ'],
    [11, 14,  43,  46, 'RED SEA'],          // Bab-el-Mandeb area
    [28, 32,  31,  34, 'SUEZ'],
    [ 1,  5, 100, 105, 'MALACCA STRAIT'],
    [20, 26, 118, 126, 'TAIWAN STRAIT'],
    [33, 45,  28,  42, 'BLACK SEA'],
    // ── Broad regions ───────────────────────────────────────────────────
    [20, 45,  25,  63, 'MIDDLE EAST'],      // incl. Persian Gulf, Levant
    [44, 72,  22,  45, 'EASTERN EUROPE'],   // Ukraine, Balkans
    [44, 82,  40, 180, 'RUSSIA'],
    [20, 55,  73, 145, 'ASIA PACIFIC'],
    [20, 50, 100, 145, 'EAST ASIA'],        // China, Korea, Japan
    [-5, 25,  95, 145, 'SOUTHEAST ASIA'],
    [20, 42,  60, 100, 'CENTRAL ASIA'],
    [ 8, 37, -18,  44, 'AFRICA'],
    [-35, 15, -82, -34, 'SOUTH AMERICA'],
    [25, 72, -170, -50, 'NORTH AMERICA'],
    [35, 72,  -30,  25, 'EUROPE'],
    [-50, -8, 112, 180, 'OCEANIA'],
  ];

  function _latLonToRegion(lat, lon) {
    for (var i = 0; i < GEO_BOXES.length; i++) {
      var b = GEO_BOXES[i];
      if (lat >= b[0] && lat <= b[1] && lon >= b[2] && lon <= b[3]) return b[4];
    }
    return 'GLOBAL';
  }

  /* Fast text → region (for GDELT place strings) */
  var _TEXT_REGIONS = [
    ['strait of hormuz', 'STRAIT OF HORMUZ'], ['hormuz',   'STRAIT OF HORMUZ'],
    ['red sea',          'RED SEA'],           ['bab el',   'RED SEA'],
    ['suez',             'SUEZ'],
    ['malacca',          'MALACCA STRAIT'],
    ['taiwan strait',    'TAIWAN STRAIT'],     ['taiwan',   'TAIWAN STRAIT'],
    ['south china sea',  'EAST ASIA'],
    ['ukraine',          'EASTERN EUROPE'],    ['kyiv',     'EASTERN EUROPE'],
    ['donbas',           'EASTERN EUROPE'],    ['crimea',   'EASTERN EUROPE'],
    ['russia',           'RUSSIA'],            ['moscow',   'RUSSIA'],
    ['iran',             'MIDDLE EAST'],       ['tehran',   'MIDDLE EAST'],
    ['iraq',             'MIDDLE EAST'],       ['baghdad',  'MIDDLE EAST'],
    ['israel',           'MIDDLE EAST'],       ['gaza',     'MIDDLE EAST'],
    ['saudi',            'MIDDLE EAST'],       ['yemen',    'MIDDLE EAST'],
    ['persian gulf',     'MIDDLE EAST'],
    ['china',            'EAST ASIA'],         ['beijing',  'EAST ASIA'],
    ['korea',            'EAST ASIA'],         ['pyongyang','EAST ASIA'],
    ['japan',            'EAST ASIA'],         ['tokyo',    'EAST ASIA'],
    ['india',            'ASIA PACIFIC'],      ['pakistan', 'ASIA PACIFIC'],
    ['kashmir',          'ASIA PACIFIC'],
  ];

  function _textToRegion(text) {
    var l = text.toLowerCase();
    for (var i = 0; i < _TEXT_REGIONS.length; i++) {
      if (l.indexOf(_TEXT_REGIONS[i][0]) !== -1) return _TEXT_REGIONS[i][1];
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SEVERITY MAPPERS
     Each feed has its own scale → map to signal-relevant 0–1 float for socialV.
     socialV feeds into S4 (0–15 pts) of scoreEvent().  We then apply confMult
     so the operator can tune aggressiveness without touching the formula.
  ══════════════════════════════════════════════════════════════════════════ */

  /* GDELT GoldsteinScale: -10 (destabilising) → +10 (cooperative) */
  function _goldsteinToSocialV(gs) {
    if (gs >= 0) return Math.max(0, 0.15 - gs * 0.015);   // cooperation → tiny
    return Math.min(1.0, (-gs / 10) * 0.85 + 0.10);        // conflict → strong
  }

  /* Earthquake Richter scale → socialV */
  function _magnitudeToSocialV(mag) {
    if (mag < _cfg.minMagnitude) return 0;
    if (mag < 6.0) return 0.30;
    if (mag < 6.5) return 0.50;
    if (mag < 7.0) return 0.65;
    if (mag < 7.5) return 0.78;
    if (mag < 8.0) return 0.88;
    return 0.96;
  }

  /* Apply confidence multiplier (clamped so we never exceed 1.0) */
  function _sv(raw) {
    return Math.min(1.0, Math.max(0, raw * _cfg.confMult));
  }

  /* ══════════════════════════════════════════════════════════════════════════
     NORMALISER HELPERS
     Each normaliser returns an object ready for IC.ingest() extras, OR null
     if the event doesn't meet the relevance bar.
  ══════════════════════════════════════════════════════════════════════════ */

  /* Build a severity keyword clause for embedding in descriptions.
     This gives scoreEvent() something to bite on for S1/S2. */
  function _sevClause(level) {
    // level: 'low' | 'medium' | 'high' | 'critical'
    if (level === 'critical') return 'emergency alert — escalation warning';
    if (level === 'high')     return 'crisis alert';
    if (level === 'medium')   return 'elevated alert';
    return '';
  }

  /* ══════════════════════════════════════════════════════════════════════════
     NORMALISER: GDELT
  ══════════════════════════════════════════════════════════════════════════ */

  function _normaliseGdelt(raw) {
    /* Accept both ShadowBroker-shaped and raw GDELT shapes */
    var gs    = parseFloat(raw.GoldsteinScale || raw.goldstein_scale || raw.goldstein || 0);
    var sv    = _goldsteinToSocialV(gs);
    var title = (raw.headline || raw.title || raw.SOURCEURL || '').slice(0, 90);
    var place = raw.ActionGeo_Fullname || raw.action_geo || raw.location || '';
    var lat   = parseFloat(raw.ActionGeo_Lat  || raw.lat || 0);
    var lon   = parseFloat(raw.ActionGeo_Long || raw.lon || 0);
    var region = _textToRegion(place + ' ' + title) ||
                 _latLonToRegion(lat, lon);
    var tone  = parseFloat(raw.AvgTone || raw.avg_tone || raw.tone || 0);
    var level = sv >= 0.65 ? 'high' : sv >= 0.35 ? 'medium' : 'low';

    /* Only inject events with meaningful conflict signal */
    if (sv < 0.15) return null;
    if (!title || title.length < 8) return null;

    /* Embed region-specific asset keywords for MKTMAP lookup */
    var assetHint = _regionAssetHint(region);
    var sevText   = _sevClause(level);
    var desc = ('GDELT event | Goldstein: ' + gs.toFixed(1) +
                ' | Tone: ' + tone.toFixed(1) +
                (place ? ' | ' + place : '') +
                (assetHint ? ' — ' + assetHint : '') +
                (sevText  ? ' — ' + sevText  : '')).slice(0, 200);

    /* Timestamp */
    var ts = _parseGdeltDate(raw.DATEADDED || raw.date_added) || Date.now();

    return {
      title:    title,
      desc:     desc,
      source:   'ShadowBroker/GDELT',
      region:   region,
      ts:       ts,
      srcCount: 2,                  // GDELT aggregates multiple sources
      socialV:  _sv(sv),
      sbFeed:   'gdelt',
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     NORMALISER: GDELT Doc API (public fallback)
     Returns article-list items from the GDELT Doc API
  ══════════════════════════════════════════════════════════════════════════ */

  function _normaliseGdeltArticle(art) {
    var title  = (art.title  || art.url || '').slice(0, 90);
    var url    = art.url    || '';
    var domain = art.domain || '';
    /* GDELT Doc tone: negative = conflict */
    var tone   = parseFloat(art.tone || 0);
    var sv     = tone < 0 ? Math.min(1.0, (-tone / 20) * 0.75) : 0.05;

    if (sv < 0.15 || !title || title.length < 8) return null;

    var region = _textToRegion(title) || 'GLOBAL';
    var level  = sv >= 0.50 ? 'high' : 'medium';
    var sevText = _sevClause(level);
    var assetHint = _regionAssetHint(region);
    var desc = (domain + (assetHint ? ' — ' + assetHint : '') +
                (sevText ? ' — ' + sevText : '')).slice(0, 200);

    return {
      title:    title,
      desc:     desc,
      source:   'ShadowBroker/GDELT',
      region:   region,
      ts:       Date.now(),
      srcCount: 1,
      socialV:  _sv(sv),
      sbFeed:   'gdelt',
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     NORMALISER: EARTHQUAKES (USGS GeoJSON)
  ══════════════════════════════════════════════════════════════════════════ */

  function _normaliseEarthquake(feature) {
    var props  = feature.properties || feature;
    var mag    = parseFloat(props.mag || props.magnitude || 0);
    var place  = (props.place || props.location || '').slice(0, 80);
    var coords = (feature.geometry && feature.geometry.coordinates) || [];
    var lon    = parseFloat(coords[0] || props.longitude || 0);
    var lat    = parseFloat(coords[1] || props.latitude  || 0);
    var ts     = props.time || Date.now();
    var sv     = _magnitudeToSocialV(mag);

    if (sv === 0) return null;  /* below threshold */

    var region = _textToRegion(place) || _latLonToRegion(lat, lon);
    var level  = mag >= 7.0 ? 'critical' : mag >= 6.5 ? 'high' : 'medium';

    /* Embed MKTMAP-triggering keywords based on region and magnitude */
    var assetHint = _regionAssetHint(region);
    var sevText   = _sevClause(level);

    /* High-magnitude quakes near critical infra warrant escalation language */
    var extra = '';
    if (mag >= 7.0)  extra = ' — major infrastructure emergency alert';
    else if (mag >= 6.5) extra = ' — crisis alert infrastructure disruption';
    else if (mag >= 6.0) extra = ' — elevated alert';

    var title = 'M' + mag.toFixed(1) + ' Earthquake — ' + place;
    var desc  = ('Seismic event M' + mag.toFixed(1) + ' in ' + (region || place) +
                 (assetHint ? '. ' + assetHint + ' supply chain risk' : '') +
                 extra).slice(0, 200);

    return {
      title:    title,
      desc:     desc,
      source:   'ShadowBroker/USGS',
      region:   region,
      ts:       ts,
      srcCount: 1,
      socialV:  _sv(sv),
      sbFeed:   'seismic',
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     NORMALISER: MARITIME (AIS)
     Only flag vessels in strategic chokepoints or behaving unusually
     (stopped, very slow, military classification).
  ══════════════════════════════════════════════════════════════════════════ */

  var _SENSITIVE_REGIONS = [
    'STRAIT OF HORMUZ', 'RED SEA', 'MALACCA STRAIT',
    'TAIWAN STRAIT', 'SUEZ', 'BLACK SEA',
  ];

  function _normaliseMaritime(ship) {
    var name     = (ship.ShipName || ship.ship_name || ship.name || ship.mmsi || 'Unknown').slice(0, 30);
    var shipType = (ship.ShipType || ship.ship_type || ship.type || '').toLowerCase();
    var lat      = parseFloat(ship.lat || ship.latitude  || ship.Latitude  || 0);
    var lon      = parseFloat(ship.lon || ship.longitude || ship.Longitude || 0);
    var speed    = parseFloat(ship.SpeedOverGround || ship.speed || 0);
    var military = ship.military === true || shipType.indexOf('military') !== -1 ||
                   shipType.indexOf('naval') !== -1 || shipType.indexOf('warship') !== -1;
    var region   = _latLonToRegion(lat, lon);

    /* Skip if not in a sensitive region AND not military */
    if (_SENSITIVE_REGIONS.indexOf(region) === -1 && !military) return null;

    var isTanker    = shipType.indexOf('tanker') !== -1 || shipType.indexOf('crude') !== -1 ||
                      shipType.indexOf('chemical') !== -1 || shipType.indexOf('oil') !== -1;
    var isContainer = shipType.indexOf('container') !== -1 || shipType.indexOf('cargo') !== -1;

    /* Severity: military > tanker stopped > tanker moving > container */
    var sv;
    if (military)         sv = 0.68;
    else if (isTanker && speed < 1.0) sv = 0.60;   // stopped tanker
    else if (isTanker)    sv = 0.42;
    else if (isContainer) sv = 0.32;
    else                  sv = 0.28;

    /* Asset-triggering keywords in desc */
    var assetHint = _regionAssetHint(region);
    var typeLabel = military ? '[NAVAL]' : isTanker ? '[TANKER]' : isContainer ? '[CARGO]' : '[VESSEL]';
    var activity  = speed < 0.5 ? 'stopped' : speed < 3 ? 'slow-moving' : 'transiting';

    /* For oil tankers add oil/hormuz keywords to trigger MKTMAP entries */
    var extraKeywords = '';
    if (isTanker && (region === 'STRAIT OF HORMUZ' || region === 'RED SEA')) {
      extraKeywords = ' — oil tanker route hormuz strait petroleum';
    } else if (isTanker) {
      extraKeywords = ' — oil tanker petroleum shipping route';
    } else if (isContainer && region === 'MALACCA STRAIT') {
      extraKeywords = ' — container shipping semiconductor supply chain';
    }

    var title = typeLabel + ' ' + name + ' ' + activity + ' in ' + region;
    var desc  = ('AIS track: ' + (shipType || 'vessel') + ' in ' + region +
                 ' at ' + speed.toFixed(1) + ' kt' +
                 (assetHint ? ' — ' + assetHint + ' impact' : '') +
                 extraKeywords +
                 (military ? ' — military confrontation naval alert' : '')).slice(0, 200);

    return {
      title:    title,
      desc:     desc,
      source:   'ShadowBroker/AIS',
      region:   region,
      ts:       Date.now(),
      srcCount: military ? 2 : 1,
      socialV:  _sv(sv),
      sbFeed:   'maritime',
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     NORMALISER: AIRCRAFT (ADS-B)
     Only flag military aircraft in sensitive regions.
     Callsign patterns for known US military transport/tanker/ISR callsigns.
  ══════════════════════════════════════════════════════════════════════════ */

  var _MIL_CALLSIGNS = /^(RCH|REACH|IRON|KNIFE|VIPER|RAPTOR|EAGLE|BOXER|DOOM|SKULL|HAVOC|SPECTRE|GHOST|CHAOS|BIGFOOT|DARKSTAR)\d/i;

  function _normaliseAircraft(ac) {
    var callsign = (ac.callsign || ac.flight || ac.registration || '').trim();
    var type     = (ac.type || ac.category || ac.aircraft_type || '').toLowerCase();
    var lat      = parseFloat(ac.lat || ac.latitude  || 0);
    var lon      = parseFloat(ac.lon || ac.longitude || 0);
    var alt      = parseFloat(ac.altitude || ac.baro_altitude || ac.geo_altitude || 0);
    var region   = _latLonToRegion(lat, lon);

    var military = ac.military === true  ||
                   type.indexOf('military') !== -1 ||
                   _MIL_CALLSIGNS.test(callsign);

    if (!military) return null;  /* only military aircraft generate signals */

    var senRegions = ['STRAIT OF HORMUZ', 'RED SEA', 'TAIWAN STRAIT', 'EAST ASIA',
                      'MIDDLE EAST', 'EASTERN EUROPE', 'RUSSIA', 'BLACK SEA'];
    if (senRegions.indexOf(region) === -1) return null;

    var sv = 0.58;
    if (region === 'TAIWAN STRAIT')    sv = 0.78;
    if (region === 'STRAIT OF HORMUZ') sv = 0.72;
    if (region === 'RUSSIA')           sv = 0.68;

    var assetHint = _regionAssetHint(region);
    var fl = alt > 0 ? ' FL' + Math.round(alt / 100) : '';
    var title = '[MILITARY AC] ' + (callsign || 'UNKNOWN') + ' in ' + region + fl;
    var desc  = ('ADS-B: military aircraft ' + callsign + ' tracked ' + region +
                 '. Type: ' + (type || 'mil') +
                 (assetHint ? ' — ' + assetHint + ' military alert' : ' — military escalation alert') +
                 ' confrontation').slice(0, 200);

    return {
      title:    title,
      desc:     desc,
      source:   'ShadowBroker/ADS-B',
      region:   region,
      ts:       Date.now(),
      srcCount: 1,
      socialV:  _sv(sv),
      sbFeed:   'aircraft',
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     NORMALISER: SATELLITES
     Aggregate military/SIGINT/RECON satellite concentration per region.
     A cluster of 3+ military sats over a hotspot is meaningful.
  ══════════════════════════════════════════════════════════════════════════ */

  var _MIL_SAT_TYPES = ['MILITARY', 'SIGINT', 'RECON', 'SAR', 'ISR', 'RADAR'];

  function _normaliseSatelliteCluster(region, count) {
    if (count < 3) return null;
    var sv  = Math.min(1.0, 0.25 + count * 0.06);
    var assetHint = _regionAssetHint(region);
    return {
      title:    '[SAT CLUSTER] ' + count + ' mil/recon satellites over ' + region,
      desc:     ('ShadowBroker satellite tracking: ' + count + ' military/recon satellites concentrated over ' +
                 region + ' AO' +
                 (assetHint ? ' — ' + assetHint + ' military alert' : '') +
                 ' — military buildup escalation').slice(0, 200),
      source:   'ShadowBroker/SAT',
      region:   region,
      ts:       Date.now(),
      srcCount: 2,
      socialV:  _sv(sv),
      sbFeed:   'satellite',
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     ASSET HINT HELPER
     Returns a short phrase of MKTMAP-triggering keywords for a given region,
     so scoreEvent() can map the event to the right assets.
  ══════════════════════════════════════════════════════════════════════════ */

  var _REGION_HINTS = {
    'STRAIT OF HORMUZ': 'oil hormuz petroleum energy',
    'RED SEA':          'oil shipping energy suez',
    'SUEZ':             'oil shipping trade war',
    'MALACCA STRAIT':   'semiconductor chip supply trade',
    'TAIWAN STRAIT':    'taiwan chip semiconductor trade war',
    'EAST ASIA':        'china semiconductor trade war korea',
    'MIDDLE EAST':      'oil middle east iran energy gold',
    'EASTERN EUROPE':   'ukraine russia war energy oil gold',
    'RUSSIA':           'russia oil gas energy gold war sanction',
    'ASIA PACIFIC':     'india china trade emerging',
    'BLACK SEA':        'ukraine russia war grain wheat',
    'EUROPE':           'gas energy trade recession',
  };

  function _regionAssetHint(region) {
    return _REGION_HINTS[region] || '';
  }

  /* ══════════════════════════════════════════════════════════════════════════
     INJECTION BUS
  ══════════════════════════════════════════════════════════════════════════ */

  function _inject(norm) {
    if (!norm || !norm.title || norm.title.length < 8) return;

    var IC = window.__IC;
    if (!IC || typeof IC.ingest !== 'function') return;

    /* Deduplicate: key = first 40 alphanum chars of title */
    var key = (norm.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
    if (_seen.has(key)) return;
    _seen.add(key);

    /* Trim dedup set to last 1 000 to avoid unbounded memory growth */
    if (_seen.size > 1000) {
      var arr = Array.from(_seen);
      _seen = new Set(arr.slice(-600));
    }

    /* Fire — extras override ts, region, srcCount, socialV, sbFeed */
    IC.ingest(norm.title, norm.desc, norm.source, {
      ts:       norm.ts,
      region:   norm.region,
      srcCount: norm.srcCount,
      socialV:  norm.socialV,
      sbFeed:   norm.sbFeed,
    });

    /* Redraw (debounced to avoid hammering on bulk injections) */
    _scheduleRedraw();
  }

  var _redrawTimer = null;
  function _scheduleRedraw() {
    if (_redrawTimer) return;
    _redrawTimer = setTimeout(function () {
      _redrawTimer = null;
      var IC = window.__IC;
      if (IC && typeof IC.redrawAll === 'function') IC.redrawAll();
    }, 800);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     FETCH HELPERS  (manual timeout via AbortController for wider compat)
  ══════════════════════════════════════════════════════════════════════════ */

  function _fetch(url, timeoutMs, cb) {
    var ctrl    = new AbortController();
    var timer   = setTimeout(function () { ctrl.abort(); }, timeoutMs || 6000);
    fetch(url, { signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) { cb(null, data); })
      .catch(function (err) { clearTimeout(timer); cb(err, null); });
  }

  var _PROXY = 'https://corsproxy.io/?';

  /* ══════════════════════════════════════════════════════════════════════════
     FEED POLLERS
  ══════════════════════════════════════════════════════════════════════════ */

  /* ── GDELT ─────────────────────────────────────────────────────────────── */

  function _pollGdelt() {
    if (!_cfg.enabled) return;
    /* Try ShadowBroker backend first */
    _fetch(_cfg.api + '/api/geopolitics', 5000, function (err, data) {
      if (err) { _gdeltPublicFallback(); return; }
      var events = data.events || data.gdelt || data || [];
      if (!Array.isArray(events)) events = [];
      var n = 0;
      events.forEach(function (e) { var x = _normaliseGdelt(e); if (x) { _inject(x); n++; } });
      _tick('gdelt', n, null);
    });
  }

  function _gdeltPublicFallback() {
    /* GDELT 2.0 Doc API — article search, tone-based conflict filter.
       Hits corsproxy because GDELT blocks direct browser CORS.             */
    var query = encodeURIComponent('war OR missile OR airstrike OR invasion OR conflict OR escalation');
    var gdUrl = 'https://api.gdeltproject.org/api/v2/doc/doc?query=' + query +
                '&mode=artlist&maxrecords=15&format=json';
    _fetch(_PROXY + encodeURIComponent(gdUrl), 10000, function (err, data) {
      if (err) { _tick('gdelt', 0, 'fallback failed'); return; }
      var articles = (data.articles || []);
      var n = 0;
      articles.forEach(function (a) {
        var x = _normaliseGdeltArticle(a);
        if (x) { _inject(x); n++; }
      });
      _tick('gdelt', n, null);
    });
  }

  /* ── EARTHQUAKES ───────────────────────────────────────────────────────── */

  function _pollSeismic() {
    if (!_cfg.enabled) return;
    _fetch(_cfg.api + '/api/earthquakes', 5000, function (err, data) {
      if (err) { _seismicPublicFallback(); return; }
      var features = data.features || data.earthquakes || (Array.isArray(data) ? data : []);
      var n = 0;
      features.forEach(function (f) { var x = _normaliseEarthquake(f); if (x) { _inject(x); n++; } });
      _tick('seismic', n, null);
    });
  }

  function _seismicPublicFallback() {
    /* USGS M4.5+ past 24h GeoJSON — CORS-open, no key */
    _fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson', 8000,
      function (err, data) {
        if (err) { _tick('seismic', 0, 'USGS unreachable'); return; }
        var cutoff  = Date.now() - 3 * 3600 * 1000;  /* last 3h only */
        var n = 0;
        (data.features || []).forEach(function (f) {
          if ((f.properties.time || 0) < cutoff) return;
          var x = _normaliseEarthquake(f);
          if (x) { _inject(x); n++; }
        });
        _tick('seismic', n, null);
      });
  }

  /* ── MARITIME ──────────────────────────────────────────────────────────── */

  function _pollMaritime() {
    if (!_cfg.enabled) return;
    _fetch(_cfg.api + '/api/ships', 5000, function (err, data) {
      if (err) { _tick('maritime', 0, 'ShadowBroker offline'); return; }
      var ships = data.ships || data.vessels || (Array.isArray(data) ? data : Object.values(data || {}));
      var n = 0;
      ships.forEach(function (s) { var x = _normaliseMaritime(s); if (x) { _inject(x); n++; } });
      _tick('maritime', n, null);
    });
  }

  /* ── AIRCRAFT ──────────────────────────────────────────────────────────── */

  function _pollAircraft() {
    if (!_cfg.enabled) return;
    _fetch(_cfg.api + '/api/aircraft', 5000, function (err, data) {
      if (err) { _tick('aircraft', 0, 'ShadowBroker offline'); return; }
      var ac = data.aircraft || data.planes || (Array.isArray(data) ? data : Object.values(data || {}));
      var n = 0;
      ac.forEach(function (a) { var x = _normaliseAircraft(a); if (x) { _inject(x); n++; } });
      _tick('aircraft', n, null);
    });
  }

  /* ── SATELLITES ────────────────────────────────────────────────────────── */

  function _pollSatellite() {
    if (!_cfg.enabled) return;
    _fetch(_cfg.api + '/api/satellites', 5000, function (err, data) {
      if (err) { _tick('satellite', 0, 'ShadowBroker offline'); return; }
      var sats = data.satellites || (Array.isArray(data) ? data : []);
      /* Find military / SIGINT satellites and cluster by region */
      var milSats = sats.filter(function (s) {
        var t = (s.type || s.mission_type || s.category || '').toUpperCase();
        return _MIL_SAT_TYPES.some(function (mt) { return t.indexOf(mt) !== -1; });
      });
      var clusters = {};
      milSats.forEach(function (s) {
        var lat = parseFloat(s.lat || s.latitude  || 0);
        var lon = parseFloat(s.lon || s.longitude || 0);
        var r   = _latLonToRegion(lat, lon);
        if (r !== 'GLOBAL') clusters[r] = (clusters[r] || 0) + 1;
      });
      var n = 0;
      Object.keys(clusters).forEach(function (r) {
        var x = _normaliseSatelliteCluster(r, clusters[r]);
        if (x) { _inject(x); n++; }
      });
      _tick('satellite', n, null);
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     STATUS PANEL UI
     Injected into the DOM — renders inside #sbStatusPanel if present,
     otherwise creates a floating mini-panel at the bottom-left.
  ══════════════════════════════════════════════════════════════════════════ */

  function _tick(feed, count, err) {
    _status[feed].ok    = !err;
    _status[feed].count = count;
    _status[feed].last  = new Date().toLocaleTimeString();
    _status[feed].err   = err || '';
    _renderPanel();
  }

  function _renderPanel() {
    var el = document.getElementById(_cfg.panelId);
    if (!el) return;

    var feeds    = Object.keys(_status);
    var anyLive  = feeds.some(function (f) { return _status[f].ok; });
    var totalEvt = feeds.reduce(function (s, f) { return s + _status[f].count; }, 0);

    var rows = feeds.map(function (f) {
      var s   = _status[f];
      var dot = s.ok
        ? '<span style="color:var(--green);font-size:10px">●</span>'
        : '<span style="color:var(--dim);font-size:10px">○</span>';
      var info = s.ok
        ? '<span style="color:var(--dim)">' + s.count + ' evt · ' + s.last + '</span>'
        : '<span style="color:var(--dim)">' + (s.err || 'offline') + '</span>';
      return '<div style="display:flex;align-items:center;gap:8px;padding:3px 0;' +
             'border-bottom:1px solid var(--border);font-size:10px">' +
             dot +
             '<span style="min-width:78px;font-weight:bold;text-transform:uppercase;' +
             'letter-spacing:0.8px;color:var(--bright)">' + f + '</span>' +
             info + '</div>';
    }).join('');

    el.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
        '<span class="signal-tag shadowbroker">SHADOWBROKER</span>' +
        '<span style="font-size:10px;color:var(--dim)">' +
          (anyLive ? totalEvt + ' events injected' : 'offline — using fallbacks') +
        '</span>' +
      '</div>' +
      rows +
      '<div style="margin-top:8px;font-size:9px;color:var(--dim)">' +
        'Conf. Multiplier: <span style="color:var(--amber)">' + _cfg.confMult.toFixed(1) + '×</span>' +
        ' &nbsp;·&nbsp; Mode: <span style="color:var(--green)">PAPER</span>' +
        ' &nbsp;·&nbsp; API: <span style="color:var(--dim)">' + _cfg.api + '</span>' +
      '</div>' +
      '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<button onclick="SB.pollAll()" style="font-size:9px;padding:2px 8px;background:var(--bg3);' +
          'border:1px solid var(--border);color:var(--amber);cursor:pointer;letter-spacing:0.5px">' +
          '▶ POLL NOW</button>' +
        '<button onclick="SB.toggleEnabled()" style="font-size:9px;padding:2px 8px;background:var(--bg3);' +
          'border:1px solid var(--border);color:var(--dim);cursor:pointer;letter-spacing:0.5px" id="sbToggleBtn">' +
          (_cfg.enabled ? '■ DISABLE' : '▶ ENABLE') + '</button>' +
      '</div>';
  }

  /* ══════════════════════════════════════════════════════════════════════════
     UTILITY
  ══════════════════════════════════════════════════════════════════════════ */

  function _parseGdeltDate(str) {
    if (!str) return null;
    var s = String(str);
    /* GDELT raw format: "20260312143000" */
    if (s.length === 14) {
      var iso = s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8) + 'T' +
                s.slice(8,10) + ':' + s.slice(10,12) + ':' + s.slice(12,14) + 'Z';
      var d = new Date(iso);
      return isNaN(d) ? null : d.getTime();
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     EXAMPLE WORKFLOW DEMO
     Call SB.demo() from the browser console to inject a representative set
     of ShadowBroker-sourced events and watch them appear in the pipeline.
  ══════════════════════════════════════════════════════════════════════════ */

  function _runDemo() {
    console.log('[ShadowBroker] Running demo injection...');
    var demoEvents = [
      /* GDELT high-conflict event */
      {
        title:   'Iranian navy vessels shadow US carrier in Strait of Hormuz',
        desc:    'GDELT event | Goldstein: -7.8 | Strait of Hormuz — oil hormuz ' +
                 'petroleum energy military confrontation naval alert — crisis alert',
        source:  'ShadowBroker/GDELT [DEMO]',
        region:  'STRAIT OF HORMUZ', ts: Date.now(), srcCount: 2, socialV: _sv(0.75), sbFeed: 'gdelt',
      },
      /* Earthquake near oil infrastructure */
      {
        title:   'M6.4 Earthquake — Bandar Abbas, Iran',
        desc:    'Seismic event M6.4 near Strait of Hormuz oil infrastructure. ' +
                 'Bandar Abbas port affected — oil hormuz energy crisis alert',
        source:  'ShadowBroker/USGS [DEMO]',
        region:  'STRAIT OF HORMUZ', ts: Date.now() - 3600000, srcCount: 1, socialV: _sv(0.55), sbFeed: 'seismic',
      },
      /* Military aircraft in Taiwan Strait */
      {
        title:   '[MILITARY AC] IRON51 in TAIWAN STRAIT FL350',
        desc:    'ADS-B: military aircraft IRON51 tracked Taiwan Strait. Type: mil — ' +
                 'taiwan chip semiconductor military alert confrontation',
        source:  'ShadowBroker/ADS-B [DEMO]',
        region:  'TAIWAN STRAIT', ts: Date.now() - 900000, srcCount: 1, socialV: _sv(0.78), sbFeed: 'aircraft',
      },
      /* Tanker stopped in Hormuz */
      {
        title:   '[TANKER] OCEAN PROVIDER stopped in STRAIT OF HORMUZ',
        desc:    'AIS track: oil tanker stopped in Strait of Hormuz at 0.2 kt — ' +
                 'oil hormuz petroleum energy blockade',
        source:  'ShadowBroker/AIS [DEMO]',
        region:  'STRAIT OF HORMUZ', ts: Date.now() - 1800000, srcCount: 1, socialV: _sv(0.62), sbFeed: 'maritime',
      },
      /* Satellite cluster over Eastern Europe */
      {
        title:   '[SAT CLUSTER] 5 mil/recon satellites over EASTERN EUROPE',
        desc:    'ShadowBroker satellite tracking: 5 military/recon satellites concentrated ' +
                 'over EASTERN EUROPE AO — ukraine russia war energy military buildup escalation',
        source:  'ShadowBroker/SAT [DEMO]',
        region:  'EASTERN EUROPE', ts: Date.now() - 600000, srcCount: 2, socialV: _sv(0.40), sbFeed: 'satellite',
      },
    ];
    demoEvents.forEach(function (e) {
      _inject(e);
    });
    console.log('[ShadowBroker] Demo: injected ' + demoEvents.length + ' events. Check IC events panel and Trade Signals.');
  }

  /* ══════════════════════════════════════════════════════════════════════════
     BOOT
  ══════════════════════════════════════════════════════════════════════════ */

  function _start() {
    /* Initial polls */
    _pollGdelt();
    _pollSeismic();
    _pollMaritime();
    _pollAircraft();
    _pollSatellite();

    /* Scheduled polls */
    setInterval(_pollGdelt,    _cfg.pollGdelt);
    setInterval(_pollSeismic,  _cfg.pollSeismic);
    setInterval(_pollMaritime, _cfg.pollMaritime);
    setInterval(_pollAircraft, _cfg.pollAircraft);
    setInterval(_pollSatellite,_cfg.pollSatellite);

    /* Render initial (empty) status panel */
    setTimeout(_renderPanel, 1200);

    console.log('[ShadowBroker] Integration active. API: ' + _cfg.api +
                ' | Conf×: ' + _cfg.confMult + ' | Mode: PAPER');
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PUBLIC API  —  window.SB
     SB.config({ api, confMult, enabled })   — reconfigure at runtime
     SB.pollAll()                            — force-poll all feeds
     SB.setMult(n)                           — set confidence multiplier
     SB.toggleEnabled()                      — pause/resume injection
     SB.demo()                               — inject demo events
     SB.status()                             — return _status object
  ══════════════════════════════════════════════════════════════════════════ */

  window.SB = {
    config: function (opts) {
      if (opts.api     !== undefined) _cfg.api      = opts.api;
      if (opts.confMult!== undefined) _cfg.confMult = Math.max(0.1, Math.min(3.0, parseFloat(opts.confMult)));
      if (opts.enabled !== undefined) _cfg.enabled  = !!opts.enabled;
      _renderPanel();
    },
    pollAll:       function () { _pollGdelt(); _pollSeismic(); _pollMaritime(); _pollAircraft(); _pollSatellite(); },
    setMult:       function (v) { _cfg.confMult = Math.max(0.1, Math.min(3.0, parseFloat(v) || 1.0)); _renderPanel(); console.log('[SB] confMult → ' + _cfg.confMult); },
    toggleEnabled: function () { _cfg.enabled = !_cfg.enabled; _renderPanel(); console.log('[SB] enabled:', _cfg.enabled); },
    demo:          function () { _runDemo(); },
    status:        function () { return JSON.parse(JSON.stringify(_status)); },
  };

  /* Start once DOM is ready */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _start);
  } else {
    _start();
  }

})();
