/* GII Geopolitical Calendar Agent — gii-calendar.js v1
 * Tracks scheduled geopolitical flashpoints and upcoming risk events.
 * Emits early-warning signals based on proximity to known high-risk dates
 * and cross-references IC events for keyword confirmation.
 * Reads: window.__IC.events (keyword confirmation)
 * Exposes: window.GII_AGENT_CALENDAR
 */
(function () {
  'use strict';

  var MAX_SIGNALS   = 20;
  var POLL_INTERVAL = 900000; // 15 min — calendar rarely changes

  // ── Event catalogue ───────────────────────────────────────────────────────
  // importance: 1–5 (5 = market-moving)
  // type: MILITARY | DIPLOMACY | ELECTION | ECONOMIC | SANCTIONS

  var CALENDAR_EVENTS = [
    // ── March 2026 ──
    {
      id: 'fed_fomc_mar26', label: 'Federal Reserve FOMC Decision',
      date: '2026-03-18', region: 'US', asset: 'SPY', importance: 3,
      type: 'ECONOMIC',
      keywords: ['federal reserve', 'fomc', 'interest rate decision', 'rate hike', 'rate cut', 'powell']
    },
    {
      id: 'ukraine_sc_mar26', label: 'UN Security Council Ukraine Ceasefire Review',
      date: '2026-03-31', region: 'UKRAINE', asset: 'GLD', importance: 3,
      type: 'DIPLOMACY',
      keywords: ['ukraine ceasefire', 'un security council ukraine', 'peace talks ukraine', 'nato ukraine']
    },

    // ── April 2026 ──
    {
      id: 'opec_apr26', label: 'OPEC+ Production Level Review',
      date: '2026-04-03', region: 'MIDDLE EAST', asset: 'WTI', importance: 4,
      type: 'ECONOMIC',
      keywords: ['opec', 'opec+', 'oil production cut', 'oil quota', 'saudi output', 'opec meeting']
    },
    {
      id: 'iran_nuclear_apr26', label: 'Iran Nuclear Talks Deadline',
      date: '2026-04-15', region: 'IRAN', asset: 'WTI', importance: 5,
      type: 'DIPLOMACY',
      keywords: ['iran nuclear', 'jcpoa', 'enrichment deal', 'iaea iran', 'centrifuge', 'iran atomic', 'nuclear talks']
    },
    {
      id: 'nk_exercises_apr26', label: 'North Korea Spring Exercise Window',
      date: '2026-04-20', region: 'NORTH KOREA', asset: 'GLD', importance: 3,
      type: 'MILITARY',
      keywords: ['north korea missile', 'dprk test', 'kim jong', 'pyongyang', 'icbm test', 'north korea exercise']
    },
    {
      id: 'ukraine_ceasefire_apr26', label: 'Russia-Ukraine Ceasefire Terms Deadline',
      date: '2026-04-30', region: 'UKRAINE', asset: 'GLD', importance: 5,
      type: 'MILITARY',
      keywords: ['ukraine ceasefire deadline', 'russia ukraine peace', 'zelensky trump', 'minsk', 'ukraine negotiations']
    },

    // ── May 2026 ──
    {
      id: 'fed_fomc_may26', label: 'Federal Reserve FOMC Decision',
      date: '2026-05-06', region: 'US', asset: 'SPY', importance: 3,
      type: 'ECONOMIC',
      keywords: ['federal reserve', 'fomc', 'interest rate', 'rate decision', 'powell statement']
    },
    {
      id: 'g7_may26', label: 'G7 Summit (Kananaskis, Canada)',
      date: '2026-05-15', region: 'GLOBAL', asset: 'GLD', importance: 3,
      type: 'DIPLOMACY',
      keywords: ['g7 summit', 'g7 leaders', 'g7 canada', 'kananaskis', 'g7 communique']
    },
    {
      id: 'iran_sanctions_may26', label: 'US-Iran Sanctions Review Deadline',
      date: '2026-05-25', region: 'IRAN', asset: 'WTI', importance: 4,
      type: 'SANCTIONS',
      keywords: ['iran sanctions', 'iran oil embargo', 'ofac iran', 'iran export', 'iran nuclear sanctions']
    },

    // ── June 2026 ──
    {
      id: 'sk_election_jun26', label: 'South Korean Presidential Election',
      date: '2026-06-03', region: 'SOUTH CHINA SEA', asset: 'TSM', importance: 4,
      type: 'ELECTION',
      keywords: ['south korea election', 'korea president', 'seoul election', 'korea vote', 'korean election']
    },
    {
      id: 'nato_summit_jun26', label: 'NATO Summit (The Hague)',
      date: '2026-06-24', region: 'UKRAINE', asset: 'GLD', importance: 4,
      type: 'MILITARY',
      keywords: ['nato summit', 'nato hague', 'nato ukraine', 'nato expansion', 'article 5', 'nato alliance']
    },

    // ── August 2026 ──
    {
      id: 'taiwan_exercises_aug26', label: 'PLA Taiwan Strait Annual Exercise Window',
      date: '2026-08-10', region: 'TAIWAN', asset: 'TSM', importance: 5,
      type: 'MILITARY',
      keywords: ['taiwan strait exercises', 'pla taiwan', 'china taiwan military', 'taiwan blockade', 'pla navy taiwan', 'china military drills taiwan']
    },

    // ── September 2026 ──
    {
      id: 'unga_sep26', label: 'UN General Assembly Opening',
      date: '2026-09-22', region: 'GLOBAL', asset: 'GLD', importance: 3,
      type: 'DIPLOMACY',
      keywords: ['un general assembly', 'unga', 'united nations general assembly', 'un summit', 'world leaders un']
    },

    // ── November 2026 ──
    {
      id: 'us_midterms_nov26', label: 'US Congressional Midterm Elections',
      date: '2026-11-03', region: 'US', asset: 'SPY', importance: 4,
      type: 'ELECTION',
      keywords: ['us midterm', 'congressional election', 'house election', 'senate election', 'us election 2026']
    },
    {
      id: 'g20_nov26', label: 'G20 Summit',
      date: '2026-11-15', region: 'GLOBAL', asset: 'GLD', importance: 3,
      type: 'DIPLOMACY',
      keywords: ['g20 summit', 'g20 leaders', 'g20 communique', 'g20 2026']
    }
  ];

  var _signals    = [];
  var _upcoming   = []; // enriched list for status() / UI
  var _status = {
    lastPoll:      null,
    upcomingCount: 0,
    next7Days:     0,
    next30Days:    0
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  // ── helpers ───────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  function _daysUntil(dateStr) {
    var target = new Date(dateStr + 'T00:00:00Z').getTime();
    // Return fractional days so the EE event-gate (gateHours/24 window) works precisely.
    // Previously used Math.floor() which made any same-day event show days=0 and gate
    // ALL day instead of just the last 30 min before the event.
    return (target - Date.now()) / 86400000;
  }

  function _icKeywordMatch(ev) {
    // Check if any IC events in last 48h mention this calendar event's keywords
    var IC = window.__IC;
    if (!IC || !IC.events || !ev.keywords || !ev.keywords.length) return false;
    var cutoff = Date.now() - 48 * 60 * 60 * 1000;
    return IC.events.some(function (e) {
      if (e.ts <= cutoff) return false;
      var text = (e.title || e.headline || e.text || '').toLowerCase();
      return ev.keywords.some(function (kw) { return text.indexOf(kw) !== -1; });
    });
  }

  function _proximityMultiplier(days) {
    if (days <= 0)  return null;  // past
    if (days <= 7)  return 1.00;
    if (days <= 21) return 0.75;
    if (days <= 45) return 0.50;
    if (days <= 90) return 0.25;
    return null; // too far out — only emit if IC confirms
  }

  // ── analysis ──────────────────────────────────────────────────────────────

  function _analyseCalendar() {
    _signals = [];
    _upcoming = [];

    var next7 = 0, next30 = 0;
    // Region bucketing for multi-event cluster detection
    var regionCounts = {};

    CALENDAR_EVENTS.forEach(function (ev) {
      var days   = _daysUntil(ev.date);
      var mult   = _proximityMultiplier(days);
      var icHit  = _icKeywordMatch(ev);

      // Track upcoming events for status
      if (days >= 0 && days <= 90) {
        _upcoming.push({ id: ev.id, label: ev.label, days: days, region: ev.region, asset: ev.asset, importance: ev.importance, icConfirmed: icHit });
        if (days <= 7)  next7++;
        if (days <= 30) next30++;

        // Count by region for cluster detection
        var r = ev.region;
        if (!regionCounts[r]) regionCounts[r] = 0;
        regionCounts[r]++;
      }

      // Skip emission if too far out AND no IC confirmation
      if (mult === null && !icHit) return;
      // If past, skip
      if (days < 0) return;
      // If IC confirms even a distant event, use a floor multiplier
      var effectiveMult = mult !== null ? mult : 0.20;
      // IC confirmation adds a 10% bonus
      if (icHit) effectiveMult = Math.min(effectiveMult + 0.10, 1.10);

      // Base confidence from importance (1–5 → 0.38–0.78)
      var typeBoost  = ev.type === 'MILITARY' ? 0.06 : (ev.type === 'SANCTIONS' ? 0.04 : 0);
      var baseConf   = _clamp(0.28 + ev.importance * 0.10 + typeBoost, 0.28, 0.80);
      var finalConf  = _clamp(baseConf * effectiveMult, 0.22, 0.85);

      if (finalConf < 0.22) return; // don't clutter with very weak signals

      var _daysInt  = Math.floor(days);
      var timeLabel = days < 0           ? 'PAST' :
                      days < (1/24)      ? 'in <1h' :
                      days < 1           ? 'in ' + Math.round(days * 24) + 'h' :
                      _daysInt === 1     ? 'TOMORROW' :
                      _daysInt <= 7      ? 'in ' + _daysInt + ' days' :
                                          'in ' + _daysInt + ' days';
      var icTag = icHit ? ' [IC confirmed]' : '';

      _pushSignal({
        source:       'calendar',
        asset:        ev.asset,
        bias:         'long', // calendar events = risk premium build-up
        confidence:   finalConf,
        reasoning:    '[' + ev.type + '] ' + ev.label + ' — ' + timeLabel + icTag,
        region:       ev.region,
        evidenceKeys: ev.keywords ? ev.keywords.slice(0, 3) : ['calendar', 'scheduled']
      });
    });

    // ── Region cluster signal: 2+ high-importance events in same region ──

    Object.keys(regionCounts).forEach(function (region) {
      if (regionCounts[region] < 2) return;
      // Check if at least one of those events is within 45 days
      var nearEvents = _upcoming.filter(function (u) { return u.region === region && u.days <= 45; });
      if (nearEvents.length < 2) return;
      var maxImp = Math.max.apply(null, nearEvents.map(function (u) { return u.importance; }));
      if (maxImp < 3) return;

      var clusterConf = _clamp(0.38 + nearEvents.length * 0.06, 0.38, 0.70);
      var assetMap    = { 'US': 'SPY', 'UKRAINE': 'GLD', 'IRAN': 'WTI', 'MIDDLE EAST': 'WTI',
                          'TAIWAN': 'TSM', 'SOUTH CHINA SEA': 'TSM', 'GLOBAL': 'GLD', 'NORTH KOREA': 'GLD' };
      var asset       = assetMap[region] || 'GLD';

      _pushSignal({
        source:       'calendar',
        asset:        asset,
        bias:         'long',
        confidence:   clusterConf,
        reasoning:    'Calendar cluster: ' + nearEvents.length + ' scheduled events in ' + region +
                      ' within 45 days — elevated risk window',
        region:       region,
        evidenceKeys: ['calendar', 'risk event', 'scheduled']
      });
    });

    // Sort upcoming by days ascending for display
    _upcoming.sort(function (a, b) { return a.days - b.days; });

    _status.upcomingCount = _upcoming.length;
    _status.next7Days     = next7;
    _status.next30Days    = next30;
  }

  // ── public poll ───────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    _analyseCalendar();
  }

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_AGENT_CALENDAR = {
    poll:     poll,
    signals:  function () { return _signals.slice(); },
    status:   function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); },
    upcoming: function () { return _upcoming.slice(); } // extra: list for UI display
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 8800);
  });

})();
