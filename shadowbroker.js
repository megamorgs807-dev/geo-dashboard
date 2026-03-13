/* ══════════════════════════════════════════════════════════════════════════════
   SHADOWBROKER INTEGRATION MODULE  —  V21
   ══════════════════════════════════════════════════════════════════════════════
   Public-API fallback chain (no keys, all CORS-open, verified working):

     GDELT/Conflict → ShadowBroker /api/geopolitics
                    → BBC World RSS + Al Jazeera RSS (via corsproxy.io)

     Seismic        → ShadowBroker /api/earthquakes
                    → USGS M4.5+ past 24 h (direct, CORS-open)
                    → USGS Significant Week (backup)

     Maritime       → ShadowBroker /api/ships
                    → RSS maritime-keyword extraction (BBC + AJ)

     Aircraft       → ShadowBroker /api/aircraft
                    → OpenSky Network bounding-box queries (CORS-open)
                    → RSS military-aviation keyword extraction (fallback)

     Satellite      → ShadowBroker /api/satellites
                    → RSS satellite/ASAT keyword extraction (BBC + AJ)

   Design rules (unchanged):
     • Does NOT touch existing scoring logic, thresholds, or trade rules
     • All trades remain in SIMULATION / paper mode
     • SB_CONF_MULT scales socialV without altering the formula itself
   ══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── CONFIG ─────────────────────────────────────────────────────────────── */
  var _cfg = Object.assign({
    api:           'http://localhost:8000',
    enabled:       true,
    confMult:      1.0,
    pollGdelt:     300000,   // 5 min
    pollSeismic:    60000,   // 1 min
    pollMaritime:  180000,   // 3 min
    pollAircraft:  180000,   // 3 min
    pollSatellite: 300000,   // 5 min
    minMagnitude:    5.5,
    panelId:       'sbStatusPanel',
  }, window.SB_CONFIG || {});

  /* ── STATUS ──────────────────────────────────────────────────────────────── */
  var _status = {
    gdelt:     { ok: false, count: 0, last: null, err: '', src: '' },
    seismic:   { ok: false, count: 0, last: null, err: '', src: '' },
    maritime:  { ok: false, count: 0, last: null, err: '', src: '' },
    aircraft:  { ok: false, count: 0, last: null, err: '', src: '' },
    satellite: { ok: false, count: 0, last: null, err: '', src: '' },
  };

  /* Deduplication — last 1 000 keys */
  var _seen = new Set();

  /* ── GEOGRAPHY ───────────────────────────────────────────────────────────── */
  var GEO_BOXES = [
    [23, 28,  56,  60, 'STRAIT OF HORMUZ'],
    [11, 14,  43,  46, 'RED SEA'],
    [28, 32,  31,  34, 'SUEZ'],
    [ 1,  5, 100, 105, 'MALACCA STRAIT'],
    [20, 26, 118, 126, 'TAIWAN STRAIT'],
    [33, 45,  28,  42, 'BLACK SEA'],
    [20, 45,  25,  63, 'MIDDLE EAST'],
    [44, 72,  22,  45, 'EASTERN EUROPE'],
    [44, 82,  40, 180, 'RUSSIA'],
    [20, 55,  73, 145, 'ASIA PACIFIC'],
    [20, 50, 100, 145, 'EAST ASIA'],
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

  var _TEXT_REGIONS = [
    ['strait of hormuz','STRAIT OF HORMUZ'],['hormuz','STRAIT OF HORMUZ'],
    ['red sea','RED SEA'],['bab el','RED SEA'],['bab-el','RED SEA'],
    ['suez','SUEZ'],
    ['malacca','MALACCA STRAIT'],
    ['taiwan strait','TAIWAN STRAIT'],['taiwan','TAIWAN STRAIT'],
    ['south china sea','EAST ASIA'],
    ['ukraine','EASTERN EUROPE'],['kyiv','EASTERN EUROPE'],['donbas','EASTERN EUROPE'],['crimea','EASTERN EUROPE'],
    ['russia','RUSSIA'],['moscow','RUSSIA'],
    ['iran','MIDDLE EAST'],['tehran','MIDDLE EAST'],
    ['iraq','MIDDLE EAST'],['baghdad','MIDDLE EAST'],
    ['israel','MIDDLE EAST'],['gaza','MIDDLE EAST'],['lebanon','MIDDLE EAST'],
    ['saudi','MIDDLE EAST'],['yemen','MIDDLE EAST'],['persian gulf','MIDDLE EAST'],
    ['syria','MIDDLE EAST'],
    ['china','EAST ASIA'],['beijing','EAST ASIA'],
    ['korea','EAST ASIA'],['pyongyang','EAST ASIA'],
    ['japan','EAST ASIA'],['tokyo','EAST ASIA'],
    ['india','ASIA PACIFIC'],['pakistan','ASIA PACIFIC'],['kashmir','ASIA PACIFIC'],
    ['venezuela','SOUTH AMERICA'],['colombia','SOUTH AMERICA'],
    ['niger','AFRICA'],['mali','AFRICA'],['sudan','AFRICA'],['somalia','AFRICA'],
  ];

  function _textToRegion(text) {
    var l = text.toLowerCase();
    for (var i = 0; i < _TEXT_REGIONS.length; i++) {
      if (l.indexOf(_TEXT_REGIONS[i][0]) !== -1) return _TEXT_REGIONS[i][1];
    }
    return null;
  }

  /* ── SEVERITY MAPPERS ────────────────────────────────────────────────────── */
  function _goldsteinToSocialV(gs) {
    if (gs >= 0) return Math.max(0, 0.15 - gs * 0.015);
    return Math.min(1.0, (-gs / 10) * 0.85 + 0.10);
  }

  function _magnitudeToSocialV(mag) {
    if (mag < _cfg.minMagnitude) return 0;
    if (mag < 6.0) return 0.30;
    if (mag < 6.5) return 0.50;
    if (mag < 7.0) return 0.65;
    if (mag < 7.5) return 0.78;
    if (mag < 8.0) return 0.88;
    return 0.96;
  }

  function _sv(raw) { return Math.min(1.0, Math.max(0, raw * _cfg.confMult)); }

  function _sevClause(level) {
    if (level === 'critical') return 'emergency alert — escalation warning';
    if (level === 'high')     return 'crisis alert';
    if (level === 'medium')   return 'elevated alert';
    return '';
  }

  /* ── ASSET HINTS ─────────────────────────────────────────────────────────── */
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
    'SOUTH AMERICA':    'oil venezuela emerging market',
    'AFRICA':           'gold mining commodity',
  };

  function _regionAssetHint(region) { return _REGION_HINTS[region] || ''; }

  /* ── RSS KEYWORD SETS ────────────────────────────────────────────────────── */
  var _CONFLICT_KWS  = ['war','attack','strike','missile','military','troops','conflict',
                         'invasion','bomb','explosion','soldiers','killed','airstrike',
                         'sanctions','nuclear','offensive','ceasefire','artillery',
                         'hostilities','escalation','clash','combat'];
  var _MARITIME_KWS  = ['tanker','vessel','ship','maritime','hormuz','malacca','suez',
                         'shipping','strait','blockade','navy','flotilla','naval',
                         'coast guard','red sea','gulf','cargo','freighter','seized',
                         'hijacked','piracy','mine','underwater'];
  var _AIRCRAFT_KWS  = ['warplane','fighter jet','military aircraft','drone','uav',
                         'air force','squadron','intercepted','airspace','sortie',
                         'bomber','airstrike','helicopter gunship','reconnaissance',
                         'stealth','supersonic','ballistic'];
  var _SATELLITE_KWS = ['satellite','asat','space force','spy satellite','reconnaissance',
                         'gps jamming','orbital','launch vehicle','hypersonic',
                         'anti-satellite','space warfare','killsat','surveillance satellite'];

  function _kwScore(text, kws) {
    var l = text.toLowerCase();
    return kws.filter(function(k) { return l.indexOf(k) !== -1; }).length;
  }

  /* ── FETCH HELPERS ───────────────────────────────────────────────────────── */
  var _PROXY = 'https://corsproxy.io/?';

  /* JSON fetch with timeout */
  function _fetch(url, timeoutMs, cb) {
    var ctrl  = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 6000);
    fetch(url, { signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) { cb(null, data); })
      .catch(function (err) { clearTimeout(timer); cb(err, null); });
  }

  /* Text/XML fetch with timeout */
  function _fetchText(url, timeoutMs, cb) {
    var ctrl  = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 8000);
    fetch(url, { signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (text) { cb(null, text); })
      .catch(function (err) { clearTimeout(timer); cb(err, null); });
  }

  /* Fetch + parse RSS XML → array of {title, desc, pubDate, link} */
  function _fetchRss(url, timeoutMs, cb) {
    _fetchText(_PROXY + encodeURIComponent(url), timeoutMs || 8000, function (err, text) {
      if (err) { cb(err, null); return; }
      try {
        var doc   = new DOMParser().parseFromString(text, 'text/xml');
        var items = Array.from(doc.querySelectorAll('item')).map(function (el) {
          var get = function (tag) { var n = el.querySelector(tag); return n ? (n.textContent || '') : ''; };
          return { title: get('title'), desc: get('description'), pubDate: get('pubDate'), link: get('link') };
        });
        cb(items.length ? null : new Error('empty feed'), items);
      } catch (e) { cb(e, null); }
    });
  }

  /* Fetch multiple RSS feeds, merge items, call cb(items) */
  function _fetchRssMulti(urls, timeoutMs, cb) {
    var all = [], pending = urls.length;
    urls.forEach(function (url) {
      _fetchRss(url, timeoutMs, function (err, items) {
        if (!err && items) all = all.concat(items);
        if (--pending === 0) cb(all.length ? all : null);
      });
    });
  }

  var _RSS_SOURCES = [
    'https://feeds.bbci.co.uk/news/world/rss.xml',
    'https://www.aljazeera.com/xml/rss/all.xml',
  ];

  /* ── NORMALISERS (existing — unchanged) ──────────────────────────────────── */

  function _normaliseGdelt(raw) {
    var gs    = parseFloat(raw.GoldsteinScale || raw.goldstein_scale || raw.goldstein || 0);
    var sv    = _goldsteinToSocialV(gs);
    var title = (raw.headline || raw.title || raw.SOURCEURL || '').slice(0, 90);
    var place = raw.ActionGeo_Fullname || raw.action_geo || raw.location || '';
    var lat   = parseFloat(raw.ActionGeo_Lat  || raw.lat || 0);
    var lon   = parseFloat(raw.ActionGeo_Long || raw.lon || 0);
    var region = _textToRegion(place + ' ' + title) || _latLonToRegion(lat, lon);
    var tone  = parseFloat(raw.AvgTone || raw.avg_tone || raw.tone || 0);
    var level = sv >= 0.65 ? 'high' : sv >= 0.35 ? 'medium' : 'low';
    if (sv < 0.15 || !title || title.length < 8) return null;
    var assetHint = _regionAssetHint(region);
    var desc = ('GDELT event | Goldstein: ' + gs.toFixed(1) + ' | Tone: ' + tone.toFixed(1) +
                (place ? ' | ' + place : '') +
                (assetHint ? ' — ' + assetHint : '') +
                (' — ' + _sevClause(level))).slice(0, 200);
    return { title, desc, source: 'ShadowBroker/GDELT', region,
             ts: _parseGdeltDate(raw.DATEADDED || raw.date_added) || Date.now(),
             srcCount: 2, socialV: _sv(sv), sbFeed: 'gdelt' };
  }

  function _normaliseEarthquake(feature) {
    var props  = feature.properties || feature;
    var mag    = parseFloat(props.mag || props.magnitude || 0);
    var place  = (props.place || props.location || '').slice(0, 80);
    var coords = (feature.geometry && feature.geometry.coordinates) || [];
    var lon    = parseFloat(coords[0] || props.longitude || 0);
    var lat    = parseFloat(coords[1] || props.latitude  || 0);
    var sv     = _magnitudeToSocialV(mag);
    if (sv === 0) return null;
    var region = _textToRegion(place) || _latLonToRegion(lat, lon);
    var level  = mag >= 7.0 ? 'critical' : mag >= 6.5 ? 'high' : 'medium';
    var assetHint = _regionAssetHint(region);
    var extra = mag >= 7.0  ? ' — major infrastructure emergency alert'
              : mag >= 6.5  ? ' — crisis alert infrastructure disruption'
              : mag >= 6.0  ? ' — elevated alert' : '';
    var title = 'M' + mag.toFixed(1) + ' Earthquake — ' + place;
    var desc  = ('Seismic event M' + mag.toFixed(1) + ' in ' + (region || place) +
                 (assetHint ? '. ' + assetHint + ' supply chain risk' : '') + extra).slice(0, 200);
    return { title, desc, source: 'ShadowBroker/USGS', region,
             ts: props.time || Date.now(), srcCount: 1, socialV: _sv(sv), sbFeed: 'seismic' };
  }

  var _SENSITIVE_REGIONS = ['STRAIT OF HORMUZ','RED SEA','MALACCA STRAIT','TAIWAN STRAIT','SUEZ','BLACK SEA'];

  function _normaliseMaritime(ship) {
    var name     = (ship.ShipName || ship.ship_name || ship.name || ship.mmsi || 'Unknown').slice(0, 30);
    var shipType = (ship.ShipType || ship.ship_type || ship.type || '').toLowerCase();
    var lat      = parseFloat(ship.lat || ship.latitude  || 0);
    var lon      = parseFloat(ship.lon || ship.longitude || 0);
    var speed    = parseFloat(ship.SpeedOverGround || ship.speed || 0);
    var military = ship.military === true || /military|naval|warship/.test(shipType);
    var region   = _latLonToRegion(lat, lon);
    if (_SENSITIVE_REGIONS.indexOf(region) === -1 && !military) return null;
    var isTanker    = /tanker|crude|chemical|oil/.test(shipType);
    var isContainer = /container|cargo/.test(shipType);
    var sv = military ? 0.68 : isTanker && speed < 1.0 ? 0.60 : isTanker ? 0.42 : isContainer ? 0.32 : 0.28;
    var assetHint = _regionAssetHint(region);
    var typeLabel = military ? '[NAVAL]' : isTanker ? '[TANKER]' : isContainer ? '[CARGO]' : '[VESSEL]';
    var activity  = speed < 0.5 ? 'stopped' : speed < 3 ? 'slow-moving' : 'transiting';
    var extraKws  = isTanker && (region === 'STRAIT OF HORMUZ' || region === 'RED SEA')
                  ? ' — oil tanker route hormuz strait petroleum'
                  : isTanker ? ' — oil tanker petroleum shipping route'
                  : isContainer && region === 'MALACCA STRAIT' ? ' — container shipping semiconductor supply chain' : '';
    var title = typeLabel + ' ' + name + ' ' + activity + ' in ' + region;
    var desc  = ('AIS track: ' + (shipType || 'vessel') + ' in ' + region + ' at ' + speed.toFixed(1) + ' kt' +
                 (assetHint ? ' — ' + assetHint + ' impact' : '') + extraKws +
                 (military ? ' — military confrontation naval alert' : '')).slice(0, 200);
    return { title, desc, source: 'ShadowBroker/AIS', region,
             ts: Date.now(), srcCount: military ? 2 : 1, socialV: _sv(sv), sbFeed: 'maritime' };
  }

  var _MIL_CALLSIGNS = /^(RCH|REACH|IRON|KNIFE|VIPER|RAPTOR|EAGLE|BOXER|DOOM|SKULL|HAVOC|SPECTRE|GHOST|CHAOS|BIGFOOT|DARKSTAR|JAKE|LOBO|FURY|REAPER|ATLAS|ANVIL|VENUS|ASCOT|TOPSY|COLT)\d/i;

  function _normaliseAircraft(ac) {
    var callsign = (ac.callsign || ac.flight || ac.registration || '').trim();
    var type     = (ac.type || ac.category || ac.aircraft_type || '').toLowerCase();
    var lat      = parseFloat(ac.lat || ac.latitude  || 0);
    var lon      = parseFloat(ac.lon || ac.longitude || 0);
    var alt      = parseFloat(ac.altitude || ac.baro_altitude || ac.geo_altitude || 0);
    var region   = _latLonToRegion(lat, lon);
    var military = ac.military === true || /military/.test(type) || _MIL_CALLSIGNS.test(callsign);
    if (!military) return null;
    var senRegions = ['STRAIT OF HORMUZ','RED SEA','TAIWAN STRAIT','EAST ASIA','MIDDLE EAST','EASTERN EUROPE','RUSSIA','BLACK SEA'];
    if (senRegions.indexOf(region) === -1) return null;
    var sv = 0.58;
    if (region === 'TAIWAN STRAIT')    sv = 0.78;
    if (region === 'STRAIT OF HORMUZ') sv = 0.72;
    if (region === 'RUSSIA')           sv = 0.68;
    var assetHint = _regionAssetHint(region);
    var fl = alt > 0 ? ' FL' + Math.round(alt / 100) : '';
    var title = '[MILITARY AC] ' + (callsign || 'UNKNOWN') + ' in ' + region + fl;
    var desc  = ('ADS-B: military aircraft ' + callsign + ' tracked ' + region +
                 (type ? '. Type: ' + type : '') +
                 (assetHint ? ' — ' + assetHint + ' military alert' : ' — military escalation alert') +
                 ' confrontation').slice(0, 200);
    return { title, desc, source: 'ShadowBroker/ADS-B', region,
             ts: Date.now(), srcCount: 1, socialV: _sv(sv), sbFeed: 'aircraft' };
  }

  var _MIL_SAT_TYPES = ['MILITARY','SIGINT','RECON','SAR','ISR','RADAR'];

  function _normaliseSatelliteCluster(region, count) {
    if (count < 3) return null;
    var sv = Math.min(1.0, 0.25 + count * 0.06);
    var assetHint = _regionAssetHint(region);
    return {
      title: '[SAT CLUSTER] ' + count + ' mil/recon satellites over ' + region,
      desc:  ('ShadowBroker satellite tracking: ' + count + ' military/recon satellites concentrated over ' +
               region + ' AO' + (assetHint ? ' — ' + assetHint + ' military alert' : '') +
               ' — military buildup escalation').slice(0, 200),
      source: 'ShadowBroker/SAT', region, ts: Date.now(),
      srcCount: 2, socialV: _sv(sv), sbFeed: 'satellite',
    };
  }

  /* ── RSS NORMALISERS (new — public fallbacks) ────────────────────────────── */

  /* General conflict event from a news RSS item */
  function _normaliseNewsConflict(item) {
    var text = item.title + ' ' + item.desc.replace(/<[^>]+>/g, '');
    var score = _kwScore(text, _CONFLICT_KWS);
    if (score < 2) return null;
    var region = _textToRegion(text);
    if (!region) return null;                          // skip global fluff
    var ts = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
    if (isNaN(ts) || Date.now() - ts > 12 * 3600 * 1000) return null;
    var sv    = Math.min(1.0, 0.15 + score * 0.08);
    var level = sv >= 0.55 ? 'high' : sv >= 0.35 ? 'medium' : 'low';
    var hint  = _regionAssetHint(region);
    var desc  = (text.slice(0, 130) + (hint ? ' — ' + hint : '') +
                 (' — ' + _sevClause(level))).slice(0, 200);
    return { title: item.title.slice(0, 90), desc, source: 'ShadowBroker/RSS-News',
             region, ts, srcCount: 1, socialV: _sv(sv), sbFeed: 'gdelt' };
  }

  /* Maritime event from a news RSS item */
  function _normaliseNewsMaritime(item) {
    var text  = item.title + ' ' + item.desc.replace(/<[^>]+>/g, '');
    var mScore = _kwScore(text, _MARITIME_KWS);
    var cScore = _kwScore(text, _CONFLICT_KWS);
    if (mScore < 2 || mScore + cScore < 3) return null;
    var region = _textToRegion(text);
    if (!region || region === 'GLOBAL') return null;
    var ts = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
    if (isNaN(ts) || Date.now() - ts > 12 * 3600 * 1000) return null;
    var sv      = Math.min(1.0, 0.25 + (mScore + cScore) * 0.07);
    var hint    = _regionAssetHint(region);
    var tanker  = /tanker|crude|petroleum|oil/i.test(text);
    var extraKw = tanker ? ' — oil tanker petroleum shipping route hormuz' : ' — shipping route maritime';
    var desc    = (text.slice(0, 120) + (hint ? ' — ' + hint : '') + extraKw).slice(0, 200);
    return { title: ('[MARITIME] ' + item.title).slice(0, 90), desc,
             source: 'ShadowBroker/RSS-Maritime', region, ts,
             srcCount: 1, socialV: _sv(sv), sbFeed: 'maritime' };
  }

  /* Military aircraft event from a news RSS item */
  function _normaliseNewsAircraft(item) {
    var text  = item.title + ' ' + item.desc.replace(/<[^>]+>/g, '');
    var score = _kwScore(text, _AIRCRAFT_KWS);
    if (score < 2) return null;
    var region = _textToRegion(text);
    if (!region || region === 'GLOBAL') return null;
    var ts = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
    if (isNaN(ts) || Date.now() - ts > 12 * 3600 * 1000) return null;
    var sv   = Math.min(1.0, 0.40 + score * 0.08);
    var hint = _regionAssetHint(region);
    var desc = (text.replace(/<[^>]+>/g,'').slice(0, 120) +
                (hint ? ' — ' + hint + ' military alert confrontation' : ' — military escalation alert')).slice(0, 200);
    return { title: ('[AIR] ' + item.title).slice(0, 90), desc,
             source: 'ShadowBroker/RSS-AirTrack', region, ts,
             srcCount: 1, socialV: _sv(sv), sbFeed: 'aircraft' };
  }

  /* Satellite / ASAT event from a news RSS item */
  function _normaliseNewsSatellite(item) {
    var text  = item.title + ' ' + item.desc.replace(/<[^>]+>/g, '');
    var score = _kwScore(text, _SATELLITE_KWS);
    if (score < 1) return null;
    var region = _textToRegion(text) || 'GLOBAL';
    var ts = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
    if (isNaN(ts) || Date.now() - ts > 24 * 3600 * 1000) return null;
    var sv   = Math.min(1.0, 0.28 + score * 0.10);
    var hint = _regionAssetHint(region);
    var desc = (text.replace(/<[^>]+>/g,'').slice(0, 120) +
                (hint ? ' — ' + hint + ' military alert' : ' — military buildup escalation')).slice(0, 200);
    return { title: ('[SAT] ' + item.title).slice(0, 90), desc,
             source: 'ShadowBroker/RSS-SpaceTrack', region, ts,
             srcCount: 1, socialV: _sv(sv), sbFeed: 'satellite' };
  }

  /* ── INJECTION BUS ───────────────────────────────────────────────────────── */
  function _inject(norm) {
    if (!norm || !norm.title || norm.title.length < 8) return;
    var IC = window.__IC;
    if (!IC || typeof IC.ingest !== 'function') return;
    var key = (norm.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
    if (_seen.has(key)) return;
    _seen.add(key);
    if (_seen.size > 1000) { var arr = Array.from(_seen); _seen = new Set(arr.slice(-600)); }
    IC.ingest(norm.title, norm.desc, norm.source, {
      ts: norm.ts, region: norm.region, srcCount: norm.srcCount,
      socialV: norm.socialV, sbFeed: norm.sbFeed,
    });
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

  /* ── POLLERS ─────────────────────────────────────────────────────────────── */

  /* ── GDELT / Conflict ── */
  function _pollGdelt() {
    if (!_cfg.enabled) return;
    _fetch(_cfg.api + '/api/geopolitics', 5000, function (err, data) {
      if (err) { _gdeltPublicFallback(); return; }
      var events = data.events || data.gdelt || data || [];
      if (!Array.isArray(events)) events = [];
      var n = 0;
      events.forEach(function (e) { var x = _normaliseGdelt(e); if (x) { _inject(x); n++; } });
      _tick('gdelt', n, null, 'SB live');
    });
  }

  function _gdeltPublicFallback() {
    /* BBC World + Al Jazeera RSS — CORS-open via corsproxy, no rate limit */
    _fetchRssMulti(_RSS_SOURCES, 9000, function (items) {
      if (!items) { _tick('gdelt', 0, 'RSS unavailable', ''); return; }
      var n = 0;
      items.forEach(function (item) {
        var ev = _normaliseNewsConflict(item);
        if (ev) { _inject(ev); n++; }
      });
      _tick('gdelt', n, null, 'BBC+AJ RSS');
    });
  }

  /* ── Seismic ── */
  function _pollSeismic() {
    if (!_cfg.enabled) return;
    _fetch(_cfg.api + '/api/earthquakes', 5000, function (err, data) {
      if (err) { _seismicFallback(); return; }
      var features = data.features || data.earthquakes || (Array.isArray(data) ? data : []);
      var n = 0;
      features.forEach(function (f) { var x = _normaliseEarthquake(f); if (x) { _inject(x); n++; } });
      _tick('seismic', n, null, 'SB live');
    });
  }

  function _seismicFallback() {
    /* USGS M4.5+ past 24 h — direct, CORS-open, confirmed working */
    _fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson', 9000,
      function (err, data) {
        if (err) { _seismicSignificantFallback(); return; }
        var cutoff = Date.now() - 6 * 3600 * 1000;   // last 6 h
        var n = 0;
        (data.features || []).forEach(function (f) {
          if ((f.properties.time || 0) < cutoff) return;
          var x = _normaliseEarthquake(f);
          if (x) { _inject(x); n++; }
        });
        _tick('seismic', n, null, 'USGS M4.5+');
      });
  }

  function _seismicSignificantFallback() {
    /* USGS significant quakes — past week, always tiny response */
    _fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson', 7000,
      function (err, data) {
        if (err) { _tick('seismic', 0, 'USGS offline', ''); return; }
        var n = 0;
        (data.features || []).forEach(function (f) {
          var x = _normaliseEarthquake(f);
          if (x) { _inject(x); n++; }
        });
        _tick('seismic', n, null, 'USGS Significant');
      });
  }

  /* ── Maritime ── */
  function _pollMaritime() {
    if (!_cfg.enabled) return;
    _fetch(_cfg.api + '/api/ships', 5000, function (err, data) {
      if (err) { _maritimeFallback(); return; }
      var ships = data.ships || data.vessels || (Array.isArray(data) ? data : Object.values(data || {}));
      var n = 0;
      ships.forEach(function (s) { var x = _normaliseMaritime(s); if (x) { _inject(x); n++; } });
      _tick('maritime', n, null, 'SB live');
    });
  }

  function _maritimeFallback() {
    /* Extract maritime signals from news RSS */
    _fetchRssMulti(_RSS_SOURCES, 9000, function (items) {
      if (!items) { _tick('maritime', 0, 'RSS unavailable', ''); return; }
      var n = 0;
      items.forEach(function (item) {
        var ev = _normaliseNewsMaritime(item);
        if (ev) { _inject(ev); n++; }
      });
      _tick('maritime', n, null, 'RSS keyword');
    });
  }

  /* ── Aircraft ── */

  /* OpenSky bounding boxes — one query per critical region */
  var _OPENSKY_BOXES = [
    { lamin: 23, lomin: 56, lamax: 28, lomax: 60 },   // Strait of Hormuz
    { lamin: 20, lomin: 118, lamax: 26, lomax: 126 },  // Taiwan Strait
    { lamin: 44, lomin: 22, lamax: 52, lomax: 38 },    // Ukraine / Eastern Europe
    { lamin: 28, lomin: 33, lamax: 38, lomax: 42 },    // Israel / Levant
    { lamin: 11, lomin: 43, lamax: 16, lomax: 46 },    // Red Sea / Bab-el-Mandeb
  ];

  function _pollAircraft() {
    if (!_cfg.enabled) return;
    _fetch(_cfg.api + '/api/aircraft', 5000, function (err, data) {
      if (err) { _aircraftOpenSkyFallback(); return; }
      var ac = data.aircraft || data.planes || (Array.isArray(data) ? data : Object.values(data || {}));
      var n = 0;
      ac.forEach(function (a) { var x = _normaliseAircraft(a); if (x) { _inject(x); n++; } });
      _tick('aircraft', n, null, 'SB live');
    });
  }

  function _aircraftOpenSkyFallback() {
    /* OpenSky Network — query each sensitive-region bounding box */
    var n = 0, pending = _OPENSKY_BOXES.length;
    var seen = {};

    _OPENSKY_BOXES.forEach(function (box) {
      var url = 'https://opensky-network.org/api/states/all' +
                '?lamin=' + box.lamin + '&lomin=' + box.lomin +
                '&lamax=' + box.lamax + '&lomax=' + box.lomax;
      _fetchText(url, 9000, function (err, text) {
        if (!err && text) {
          try {
            var d = JSON.parse(text);
            (d.states || []).forEach(function (s) {
              var icao     = s[0] || '';
              var callsign = (s[1] || '').trim();
              var lon      = parseFloat(s[5]);
              var lat      = parseFloat(s[6]);
              var alt      = parseFloat(s[7]) || 0;
              if (!callsign || isNaN(lon) || isNaN(lat) || seen[icao]) return;
              seen[icao] = true;
              if (!_MIL_CALLSIGNS.test(callsign)) return;
              var ev = _normaliseAircraft({ callsign, lat, lon, altitude: alt, military: true });
              if (ev) { _inject(ev); n++; }
            });
          } catch (e) {}
        }
        if (--pending === 0) {
          if (n > 0) {
            _tick('aircraft', n, null, 'OpenSky');
          } else {
            /* No military callsigns spotted — fall back to news */
            _aircraftNewsFallback();
          }
        }
      });
    });
  }

  function _aircraftNewsFallback() {
    _fetchRssMulti(_RSS_SOURCES, 9000, function (items) {
      if (!items) { _tick('aircraft', 0, 'no data', ''); return; }
      var n = 0;
      items.forEach(function (item) {
        var ev = _normaliseNewsAircraft(item);
        if (ev) { _inject(ev); n++; }
      });
      _tick('aircraft', n, null, 'RSS keyword');
    });
  }

  /* ── Satellite ── */
  function _pollSatellite() {
    if (!_cfg.enabled) return;
    _fetch(_cfg.api + '/api/satellites', 5000, function (err, data) {
      if (err) { _satelliteNewsFallback(); return; }
      var sats = data.satellites || (Array.isArray(data) ? data : []);
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
      _tick('satellite', n, null, 'SB live');
    });
  }

  function _satelliteNewsFallback() {
    /* Extract satellite/ASAT/space warfare events from news RSS */
    _fetchRssMulti(_RSS_SOURCES, 9000, function (items) {
      if (!items) { _tick('satellite', 0, 'RSS unavailable', ''); return; }
      var n = 0;
      items.forEach(function (item) {
        var ev = _normaliseNewsSatellite(item);
        if (ev) { _inject(ev); n++; }
      });
      _tick('satellite', n, null, 'RSS keyword');
    });
  }

  /* ── STATUS PANEL ────────────────────────────────────────────────────────── */
  function _tick(feed, count, err, src) {
    _status[feed].ok    = !err;
    _status[feed].count = count;
    _status[feed].last  = new Date().toLocaleTimeString();
    _status[feed].err   = err || '';
    _status[feed].src   = src || '';
    _renderPanel();
  }

  function _renderPanel() {
    var el = document.getElementById(_cfg.panelId);
    if (!el) return;
    var feeds   = Object.keys(_status);
    var anyLive = feeds.some(function (f) { return _status[f].ok; });
    var total   = feeds.reduce(function (s, f) { return s + _status[f].count; }, 0);

    var rows = feeds.map(function (f) {
      var s   = _status[f];
      var dot = s.ok
        ? '<span style="color:var(--green);font-size:10px">●</span>'
        : '<span style="color:var(--red);font-size:10px">○</span>';
      var srcBadge = s.src
        ? '<span style="font-size:8px;padding:1px 4px;background:var(--bg);border:1px solid var(--border);color:var(--dim);margin-left:4px">' + s.src + '</span>'
        : '';
      var info = s.ok
        ? '<span style="color:var(--dim)">' + s.count + ' evt · ' + s.last + '</span>' + srcBadge
        : '<span style="color:var(--red);font-size:9px">' + (s.err || 'offline') + '</span>';
      return '<div style="display:flex;align-items:center;gap:8px;padding:3px 0;border-bottom:1px solid var(--border);font-size:10px">' +
             dot +
             '<span style="min-width:78px;font-weight:bold;text-transform:uppercase;letter-spacing:0.8px;color:var(--bright)">' + f + '</span>' +
             info + '</div>';
    }).join('');

    el.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
        '<span class="signal-tag shadowbroker">SHADOWBROKER</span>' +
        '<span style="font-size:10px;color:var(--dim)">' +
          (anyLive ? total + ' events injected' : 'all feeds offline') +
        '</span>' +
      '</div>' + rows +
      '<div style="margin-top:8px;font-size:9px;color:var(--dim)">' +
        'Conf×: <span style="color:var(--amber)">' + _cfg.confMult.toFixed(1) + '×</span>' +
        ' · Mode: <span style="color:var(--green)">PAPER</span>' +
        ' · API: <span style="color:var(--dim)">' + _cfg.api + '</span>' +
      '</div>' +
      '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<button onclick="SB.pollAll()" style="font-size:9px;padding:2px 8px;background:var(--bg3);border:1px solid var(--border);color:var(--amber);cursor:pointer">▶ POLL NOW</button>' +
        '<button onclick="SB.toggleEnabled()" style="font-size:9px;padding:2px 8px;background:var(--bg3);border:1px solid var(--border);color:var(--dim);cursor:pointer">' +
          (_cfg.enabled ? '■ DISABLE' : '▶ ENABLE') + '</button>' +
      '</div>';
  }

  /* ── UTILITY ─────────────────────────────────────────────────────────────── */
  function _parseGdeltDate(str) {
    if (!str) return null;
    var s = String(str);
    if (s.length === 14) {
      var iso = s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8)+'T'+s.slice(8,10)+':'+s.slice(10,12)+':'+s.slice(12,14)+'Z';
      var d = new Date(iso);
      return isNaN(d) ? null : d.getTime();
    }
    return null;
  }

  /* ── DEMO ────────────────────────────────────────────────────────────────── */
  function _runDemo() {
    console.log('[ShadowBroker] Running demo...');
    var demo = [
      { title: 'Iranian navy vessels shadow US carrier in Strait of Hormuz',
        desc: 'GDELT | Goldstein: -7.8 | Strait of Hormuz — oil hormuz petroleum energy military confrontation naval alert — crisis alert',
        source: 'ShadowBroker/GDELT [DEMO]', region: 'STRAIT OF HORMUZ',
        ts: Date.now(), srcCount: 2, socialV: _sv(0.75), sbFeed: 'gdelt' },
      { title: 'M6.4 Earthquake — Bandar Abbas, Iran',
        desc: 'Seismic event M6.4 near Strait of Hormuz. oil hormuz energy crisis alert',
        source: 'ShadowBroker/USGS [DEMO]', region: 'STRAIT OF HORMUZ',
        ts: Date.now() - 3600000, srcCount: 1, socialV: _sv(0.55), sbFeed: 'seismic' },
      { title: '[MILITARY AC] IRON51 in TAIWAN STRAIT FL350',
        desc: 'ADS-B: military aircraft IRON51 tracked Taiwan Strait — taiwan chip semiconductor military alert confrontation',
        source: 'ShadowBroker/ADS-B [DEMO]', region: 'TAIWAN STRAIT',
        ts: Date.now() - 900000, srcCount: 1, socialV: _sv(0.78), sbFeed: 'aircraft' },
      { title: '[TANKER] OCEAN PROVIDER stopped in STRAIT OF HORMUZ',
        desc: 'AIS track: oil tanker stopped at 0.2 kt — oil hormuz petroleum energy blockade',
        source: 'ShadowBroker/AIS [DEMO]', region: 'STRAIT OF HORMUZ',
        ts: Date.now() - 1800000, srcCount: 1, socialV: _sv(0.62), sbFeed: 'maritime' },
      { title: '[SAT CLUSTER] 5 mil/recon satellites over EASTERN EUROPE',
        desc: 'ShadowBroker sat tracking: 5 mil/recon sats over EASTERN EUROPE — ukraine russia war energy military buildup escalation',
        source: 'ShadowBroker/SAT [DEMO]', region: 'EASTERN EUROPE',
        ts: Date.now() - 600000, srcCount: 2, socialV: _sv(0.40), sbFeed: 'satellite' },
    ];
    demo.forEach(function (e) { _inject(e); });
    console.log('[ShadowBroker] Demo: injected ' + demo.length + ' events.');
  }

  /* ── BOOT ────────────────────────────────────────────────────────────────── */
  function _start() {
    _pollGdelt();
    _pollSeismic();
    _pollMaritime();
    _pollAircraft();
    _pollSatellite();
    setInterval(_pollGdelt,     _cfg.pollGdelt);
    setInterval(_pollSeismic,   _cfg.pollSeismic);
    setInterval(_pollMaritime,  _cfg.pollMaritime);
    setInterval(_pollAircraft,  _cfg.pollAircraft);
    setInterval(_pollSatellite, _cfg.pollSatellite);
    setTimeout(_renderPanel, 1500);
    console.log('[ShadowBroker] V21 active | API: ' + _cfg.api + ' | Conf×: ' + _cfg.confMult + ' | Mode: PAPER');
  }

  /* ── PUBLIC API ──────────────────────────────────────────────────────────── */
  window.SB = {
    config:        function (opts) {
      if (opts.api      !== undefined) _cfg.api      = opts.api;
      if (opts.confMult !== undefined) _cfg.confMult = Math.max(0.1, Math.min(3.0, parseFloat(opts.confMult)));
      if (opts.enabled  !== undefined) _cfg.enabled  = !!opts.enabled;
      _renderPanel();
    },
    pollAll:       function () { _pollGdelt(); _pollSeismic(); _pollMaritime(); _pollAircraft(); _pollSatellite(); },
    setMult:       function (v) { _cfg.confMult = Math.max(0.1, Math.min(3.0, parseFloat(v) || 1.0)); _renderPanel(); },
    toggleEnabled: function () { _cfg.enabled = !_cfg.enabled; _renderPanel(); },
    demo:          function () { _runDemo(); },
    status:        function () { return JSON.parse(JSON.stringify(_status)); },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _start);
  } else {
    _start();
  }

})();
