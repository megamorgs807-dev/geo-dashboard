/* Forex Fundamentals Agent — forex-fundamentals.js v1
 *
 * Elite-level forex signal generation using fundamental + structural factors:
 *
 *   1. Currency Strength Index (CSI)
 *      Ranks all 8 G10 currencies dynamically from live OANDA prices.
 *      Signals the strongest currency LONG vs the weakest SHORT.
 *      Pair selection is derived, not hardcoded.
 *
 *   2. Volatility-adjusted carry trade scoring
 *      Rate differential ÷ recent pair volatility — avoids carry traps.
 *
 *   3. Carry unwind detector
 *      JPY or CHF strengthening >0.4% in 30 min during RISK_ON = early warning.
 *      Fires SHORT signals on carry pairs before the stampede.
 *
 *   4. Per-currency economic calendar blocking
 *      Maps events to specific currencies (US events → USD only, not EUR/GBP).
 *      Non-affected pairs can still trade during news windows.
 *
 *   5. Bid/ask spread health gate
 *      OANDA live spread checked vs normal baseline. Wide spread = suppressed.
 *
 *   6. Session-weighted confidence
 *      London-NY overlap (13:00–16:00 UTC): +15 pts
 *      Correct single session: +10 pts  |  Off-session: +0 pts
 *
 *   7. Multi-factor confluence scoring (max 100 pts, threshold 50)
 *      CSI rank spread (30) + carry alignment (25) + session (15)
 *      + MacroRegime (20) + GII alignment (10)
 *
 *   8. MacroRegime gating
 *      RISK_OFF: blocks carry longs, boosts JPY/CHF signals.
 *      TRANSITIONING: raises effective threshold.
 *
 * Central bank rates are hardcoded — update after each CB decision via:
 *   FOREX_FUNDAMENTALS.updateRate('USD', 4.00)
 *
 * Price source  : OANDA_RATES (live bid/ask/mid, polled every 30s)
 * Price sampling: every 60s (between scans)
 * Scan interval : 5 minutes, first scan 25s after load
 * Cooldown      : 4 hours per pair + direction
 *
 * Exposes: window.FOREX_FUNDAMENTALS
 */
(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────

  var SCAN_MS       = 300000;            // 5-minute scan cycle
  var COLLECT_MS    = 60000;             // price sample every 60s
  var FIRST_SCAN_MS = 25000;            // first scan 25s after load
  var HISTORY_MAX   = 48;               // 48 × 5min = 4h price history
  var H1_IDX        = 12;               // 12 samples back = ~1h return
  var H30_IDX       = 6;                // 6 samples back = ~30min return
  var COOLDOWN_MS   = 4 * 60 * 60 * 1000; // 4-hour cooldown per pair+direction
  var MIN_SCORE     = 50;               // minimum confluence score to emit
  var MAX_SIGNALS   = 80;

  // ── Central Bank Policy Rates (% p.a.) ────────────────────────────────────
  // UPDATE AFTER EACH CENTRAL BANK MEETING
  // Last reviewed: March 2026
  var CB_RATES = {
    GBP: 4.50,   // Bank of England
    USD: 4.25,   // Federal Reserve
    AUD: 3.85,   // Reserve Bank of Australia
    NZD: 3.25,   // Reserve Bank of New Zealand
    CAD: 2.75,   // Bank of Canada
    EUR: 2.50,   // European Central Bank
    JPY: 0.50,   // Bank of Japan (normalising slowly)
    CHF: 0.25    // Swiss National Bank
  };

  // ── Pair definitions ───────────────────────────────────────────────────────
  // Matches OANDA instrument names (underscore format)
  var PAIRS = {
    'EUR_USD': { base: 'EUR', quote: 'USD' },
    'GBP_USD': { base: 'GBP', quote: 'USD' },
    'USD_JPY': { base: 'USD', quote: 'JPY' },
    'USD_CHF': { base: 'USD', quote: 'CHF' },
    'AUD_USD': { base: 'AUD', quote: 'USD' },
    'USD_CAD': { base: 'USD', quote: 'CAD' },
    'NZD_USD': { base: 'NZD', quote: 'USD' },
    'GBP_JPY': { base: 'GBP', quote: 'JPY' },
    'EUR_JPY': { base: 'EUR', quote: 'JPY' },
    'EUR_GBP': { base: 'EUR', quote: 'GBP' }
  };

  // Normal bid/ask spread baselines in pips (for spread health gate)
  // JPY pairs: 1 pip = 0.01  |  All others: 1 pip = 0.0001
  var NORMAL_SPREAD_PIPS = {
    'EUR_USD': 1.0, 'GBP_USD': 1.2, 'USD_JPY': 1.0, 'USD_CHF': 1.5,
    'AUD_USD': 1.2, 'USD_CAD': 1.5, 'NZD_USD': 1.5,
    'GBP_JPY': 2.0, 'EUR_JPY': 1.5, 'EUR_GBP': 1.2
  };

  // Safe-haven currencies — different behaviour in risk-off
  var SAFE_HAVENS = { JPY: true, CHF: true };

  // Risky / high-beta currencies — punished in risk-off
  var RISK_CURRENCIES = { AUD: true, NZD: true, CAD: true };

  // Country/region code → currency (for calendar event filtering)
  var COUNTRY_CCY = {
    'US': 'USD', 'USD': 'USD',
    'EU': 'EUR', 'EUR': 'EUR', 'DE': 'EUR', 'FR': 'EUR', 'IT': 'EUR',
    'GB': 'GBP', 'UK': 'GBP', 'GBP': 'GBP',
    'JP': 'JPY', 'JPN': 'JPY', 'JPY': 'JPY',
    'AU': 'AUD', 'AUD': 'AUD',
    'CA': 'CAD', 'CAD': 'CAD',
    'NZ': 'NZD', 'NZD': 'NZD',
    'CH': 'CHF', 'CHF': 'CHF'
  };

  // Trading session definitions (UTC hour ranges)
  var SESSIONS = [
    { name: 'Tokyo',        start: 23, end: 8,  currencies: ['JPY', 'AUD', 'NZD'],   bonus: 10 },
    { name: 'London',       start: 7,  end: 16, currencies: ['EUR', 'GBP', 'CHF'],   bonus: 10 },
    { name: 'New York',     start: 13, end: 22, currencies: ['USD', 'CAD'],           bonus: 10 },
    { name: 'LDN-NY Overlap', start: 13, end: 16, currencies: null,                  bonus: 15 }
  ];

  // ── State ──────────────────────────────────────────────────────────────────

  var _priceHistory = {};   // pair → [{mid, bid, ask, ts}]
  var _signals      = [];   // emitted signals this session
  var _cooldowns    = {};   // 'PAIR:DIR' → expiry timestamp
  var _csiRanks     = {};   // currency → rank (1=strongest)
  var _csiScores    = {};   // currency → raw avg return
  var _scanCount    = 0;
  var _signalCount  = 0;
  var _lastScan     = null;
  var _online       = false;

  // ── Price history helpers ──────────────────────────────────────────────────

  function _record(pair, mid, bid, ask) {
    if (!mid || !isFinite(mid) || mid <= 0) return;
    if (!_priceHistory[pair]) _priceHistory[pair] = [];
    _priceHistory[pair].push({ mid: mid, bid: bid || mid, ask: ask || mid, ts: Date.now() });
    if (_priceHistory[pair].length > HISTORY_MAX) _priceHistory[pair].shift();
  }

  function _pairReturn(pair, samplesBack) {
    var h = _priceHistory[pair];
    if (!h || h.length < samplesBack + 2) return null;
    var older  = h[h.length - 1 - samplesBack].mid;
    var latest = h[h.length - 1].mid;
    if (!older || older === 0) return null;
    var r = (latest - older) / older * 100;
    return isFinite(r) ? r : null;
  }

  // Volatility proxy — std deviation of last N per-sample returns (%)
  function _pairVol(pair, n) {
    n = n || 12;
    var h = _priceHistory[pair];
    if (!h || h.length < n + 2) return null;
    var returns = [];
    for (var i = h.length - n; i < h.length; i++) {
      var prev = h[i - 1].mid, cur = h[i].mid;
      if (prev > 0) returns.push((cur - prev) / prev * 100);
    }
    if (returns.length < 3) return null;
    var mean = returns.reduce(function(s, v) { return s + v; }, 0) / returns.length;
    var variance = returns.reduce(function(s, v) { return s + (v - mean) * (v - mean); }, 0) / returns.length;
    return Math.sqrt(variance);
  }

  // ── 1. Currency Strength Index (CSI) ──────────────────────────────────────
  //
  // For each pair, the base currency gains strength when price rises,
  // and the quote currency loses strength. Average across all pairs per currency.
  // Returns currencies ranked 1 (strongest) to 8 (weakest).

  function _buildCSI() {
    var sum    = {};
    var counts = {};
    var currencies = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'NZD', 'CHF'];
    currencies.forEach(function(c) { sum[c] = 0; counts[c] = 0; });

    Object.keys(PAIRS).forEach(function(pair) {
      var def = PAIRS[pair];
      var ret = _pairReturn(pair, H1_IDX);
      if (ret === null) return;
      sum[def.base]  += ret;
      sum[def.quote] -= ret;
      counts[def.base]++;
      counts[def.quote]++;
    });

    var avgScores = {};
    currencies.forEach(function(c) {
      avgScores[c] = counts[c] > 0 ? sum[c] / counts[c] : 0;
    });

    var sorted = currencies.slice().sort(function(a, b) {
      return avgScores[b] - avgScores[a];
    });

    var ranks = {};
    sorted.forEach(function(c, i) { ranks[c] = i + 1; });

    _csiRanks  = ranks;
    _csiScores = avgScores;
    return sorted;  // strongest → weakest
  }

  // ── 2. Volatility-adjusted carry score ────────────────────────────────────
  //
  // Rate differential / recent volatility.
  // Positive = carry favours LONG; negative = carry favours SHORT.

  function _carryScore(pair) {
    var def     = PAIRS[pair];
    if (!def) return 0;
    var rawDiff = (CB_RATES[def.base] || 0) - (CB_RATES[def.quote] || 0);
    var vol     = _pairVol(pair, 12);
    if (!vol || vol < 0.001) {
      // No vol data yet — return a small directional carry score
      return Math.max(-12, Math.min(12, rawDiff * 3));
    }
    // Scale: rawDiff of 4% at vol 0.05% → score ≈ 20
    var adj = (rawDiff / (vol * 10)) * 25;
    return Math.max(-25, Math.min(25, adj));
  }

  // ── 3. Spread health gate ─────────────────────────────────────────────────

  function _spreadOk(pair) {
    var h = _priceHistory[pair];
    if (!h || !h.length) return true;
    var latest = h[h.length - 1];
    if (!latest.bid || !latest.ask || latest.bid >= latest.ask) return true;
    var isJpy      = pair.indexOf('JPY') >= 0;
    var mult       = isJpy ? 100 : 10000;
    var spreadPips = (latest.ask - latest.bid) * mult;
    var normal     = NORMAL_SPREAD_PIPS[pair] || 2.0;
    return spreadPips <= normal * 3.0;
  }

  function _spreadPips(pair) {
    var h = _priceHistory[pair];
    if (!h || !h.length) return null;
    var latest = h[h.length - 1];
    if (!latest.bid || !latest.ask) return null;
    var isJpy = pair.indexOf('JPY') >= 0;
    return (latest.ask - latest.bid) * (isJpy ? 100 : 10000);
  }

  // ── 4. Per-currency calendar blocking ─────────────────────────────────────

  function _blockedCurrencies() {
    var blocked = {};
    if (!window.ECON_CALENDAR || typeof ECON_CALENDAR.upcoming !== 'function') return blocked;
    try {
      var events = ECON_CALENDAR.upcoming(0.75);   // next 45 minutes
      if (!Array.isArray(events)) return blocked;
      events.forEach(function(ev) {
        var country = ((ev.country || ev.eventCountry || ev.region || '')).toUpperCase().trim();
        var ccy = COUNTRY_CCY[country];
        if (ccy) blocked[ccy] = ev.title || country;
      });
    } catch(e) {}
    return blocked;
  }

  function _pairCalendarOk(pair, blocked) {
    var def = PAIRS[pair];
    if (!def) return true;
    return !blocked[def.base] && !blocked[def.quote];
  }

  // ── 5. Session weighting ──────────────────────────────────────────────────

  function _sessionBonus(pair) {
    var h   = new Date().getUTCHours();
    var def = PAIRS[pair];
    if (!def) return 0;

    // London-NY overlap — highest liquidity window for any pair
    if (h >= 13 && h < 16) return 15;

    var best = 0;
    SESSIONS.forEach(function(ses) {
      if (ses.name === 'LDN-NY Overlap') return;
      var active = ses.start < ses.end
        ? (h >= ses.start && h < ses.end)
        : (h >= ses.start || h < ses.end);   // wraps midnight (Tokyo)
      if (!active) return;
      if (!ses.currencies) return;
      var match = ses.currencies.indexOf(def.base) >= 0 ||
                  ses.currencies.indexOf(def.quote) >= 0;
      if (match && ses.bonus > best) best = ses.bonus;
    });
    return best;
  }

  function _activeSessions() {
    var h = new Date().getUTCHours();
    var active = [];
    SESSIONS.forEach(function(ses) {
      var on = ses.start < ses.end
        ? (h >= ses.start && h < ses.end)
        : (h >= ses.start || h < ses.end);
      if (on) active.push(ses.name);
    });
    return active.join(', ') || 'Off-session';
  }

  // ── 6. MacroRegime gating and bonus ──────────────────────────────────────

  function _getRegime() {
    if (!window.MacroRegime || typeof MacroRegime.current !== 'function') return 'RISK_ON';
    try { return MacroRegime.current().regime || 'RISK_ON'; } catch(e) { return 'RISK_ON'; }
  }

  function _regimePts(pair, direction, regime) {
    var def    = PAIRS[pair];
    if (!def) return 0;
    var isLong = direction === 'LONG';
    var baseSH = SAFE_HAVENS[def.base];
    var quoteSH = SAFE_HAVENS[def.quote];
    var baseRisk = RISK_CURRENCIES[def.base];
    var quoteRisk = RISK_CURRENCIES[def.quote];

    if (regime === 'RISK_OFF') {
      if (isLong && baseSH)    return 20;   // long JPY or CHF = correct
      if (!isLong && quoteSH)  return 20;   // short USD/JPY = JPY long = correct
      if (isLong && baseRisk)  return -15;  // long AUD in risk-off = penalise
      if (!isLong && quoteRisk) return -15; // short AUD/USD = shorting risky from wrong side
      return 0;
    }
    if (regime === 'RISK_ON') {
      // Carry trades are rewarded in risk-on
      var carry = _carryScore(pair);
      var carryAligned = (isLong && carry > 0) || (!isLong && carry < 0);
      if (carryAligned) return 15;
      // Safe-haven longs get penalised in risk-on (counter-trend)
      if (isLong && baseSH) return -10;
      return 0;
    }
    if (regime === 'TRANSITIONING') return 5;
    return 0;
  }

  // ── GII alignment bonus ───────────────────────────────────────────────────

  function _giiPts(pair, direction) {
    var biasDir = direction === 'LONG' ? 'long' : 'short';
    if (!window.GII || typeof GII.signals !== 'function') return 0;
    try {
      var sigs = GII.signals();
      for (var i = 0; i < sigs.length; i++) {
        var s  = sigs[i];
        var sa = (s.asset || '').toUpperCase().replace('/', '_');
        if (sa !== pair) continue;
        var sb = (s.bias || '').toLowerCase();
        if (sb === biasDir)  return 10;
        if (sb && sb !== biasDir) return -15;
      }
    } catch(e) {}
    return 0;
  }

  // ── Cooldown helpers ──────────────────────────────────────────────────────

  function _onCooldown(pair, dir) {
    var exp = _cooldowns[pair + ':' + dir];
    return !!exp && Date.now() < exp;
  }

  function _setCooldown(pair, dir) {
    _cooldowns[pair + ':' + dir] = Date.now() + COOLDOWN_MS;
  }

  // ── Signal builder ────────────────────────────────────────────────────────

  function _mkSig(pair, direction, confidence, reasoning, score) {
    return {
      source       : 'forex-fundamentals',
      asset        : pair,
      bias         : direction,
      confidence   : Math.round(confidence * 100) / 100,
      reasoning    : reasoning,
      region       : 'GLOBAL',
      sector       : 'fx',
      evidenceKeys : ['forex-fundamentals', 'csi', 'carry'],
      ffScore      : score,
      timestamp    : Date.now()
    };
  }

  // ── 3b. Carry unwind detector ─────────────────────────────────────────────
  //
  // In RISK_ON, JPY or CHF strengthening >0.4% in 30 min = carry trades unwinding.
  // This is a contrarian signal — fire BEFORE the herd catches up.

  function _checkCarryUnwind(batch, regime) {
    if (regime !== 'RISK_ON') return;

    var jpyRet30 = _pairReturn('USD_JPY', H30_IDX);   // negative = JPY strengthening
    var chfRet30 = _pairReturn('USD_CHF', H30_IDX);   // negative = CHF strengthening

    if (jpyRet30 !== null && jpyRet30 < -0.4) {
      var jpyMsg = 'USD/JPY ' + jpyRet30.toFixed(3) + '% (30m) in RISK_ON — carry unwind detected, JPY bid';
      ['GBP_JPY', 'EUR_JPY', 'AUD_USD', 'NZD_USD'].forEach(function(p) {
        if (!_priceHistory[p] || _priceHistory[p].length < 3) return;
        if (_onCooldown(p, 'SHORT')) return;
        var sig = _mkSig(p, 'SHORT', 0.72, jpyMsg + ' — unwind ' + p, 85);
        batch.push(sig);
        _signals.unshift(sig);
        if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
        _setCooldown(p, 'SHORT');
        _signalCount++;
        console.log('[FF] Carry unwind: ' + p + ' SHORT');
      });
    }

    if (chfRet30 !== null && chfRet30 < -0.4) {
      var chfMsg = 'USD/CHF ' + chfRet30.toFixed(3) + '% (30m) in RISK_ON — CHF bid, carry unwind';
      if (!_onCooldown('USD_CHF', 'SHORT') && _priceHistory['USD_CHF'] &&
          _priceHistory['USD_CHF'].length >= 3) {
        var sig2 = _mkSig('USD_CHF', 'SHORT', 0.68, chfMsg, 80);
        batch.push(sig2);
        _signals.unshift(sig2);
        if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
        _setCooldown('USD_CHF', 'SHORT');
        _signalCount++;
        console.log('[FF] Carry unwind: USD_CHF SHORT');
      }
    }
  }

  // ── Price collection ──────────────────────────────────────────────────────

  function _collectPrices() {
    if (!window.OANDA_RATES || !OANDA_RATES.isConnected()) return;
    Object.keys(PAIRS).forEach(function(pair) {
      var r = OANDA_RATES.getRate(pair);
      if (r && r.mid) _record(pair, r.mid, r.bid, r.ask);
    });
  }

  // ── Main scan ─────────────────────────────────────────────────────────────

  function _scan() {
    _scanCount++;
    _lastScan = Date.now();
    _online   = true;

    _collectPrices();

    if (!window.OANDA_RATES || !OANDA_RATES.isConnected()) {
      console.log('[FF] OANDA not connected — scan #' + _scanCount + ' skipped');
      return;
    }

    var regime  = _getRegime();
    var sorted  = _buildCSI();        // sorted currencies: strongest → weakest
    var blocked = _blockedCurrencies();
    var batch   = [];
    var session = _activeSessions();

    // ── Carry unwind check (independent of CSI scoring)
    _checkCarryUnwind(batch, regime);

    // ── Score every pair via multi-factor confluence ───────────────────────
    Object.keys(PAIRS).forEach(function(pair) {
      var def = PAIRS[pair];
      var h   = _priceHistory[pair];
      if (!h || h.length < H1_IDX + 2) return;   // need enough history

      // ── GATES (must pass — not scored) ──────────────────────────────────
      if (!_spreadOk(pair)) return;               // spread too wide
      if (!_pairCalendarOk(pair, blocked)) return; // imminent news for this ccy

      // ── Determine direction from CSI ─────────────────────────────────────
      var baseRank  = _csiRanks[def.base]  || 5;
      var quoteRank = _csiRanks[def.quote] || 5;
      var rankDiff  = quoteRank - baseRank;        // positive = base is stronger

      // Need at least 2 rank positions of separation to consider a signal
      if (Math.abs(rankDiff) < 2) return;

      var direction  = rankDiff > 0 ? 'LONG' : 'SHORT';
      var absRankDiff = Math.abs(rankDiff);

      // ── Regime safety gates ──────────────────────────────────────────────
      // Block risky-currency longs in RISK_OFF
      if (regime === 'RISK_OFF' &&
          direction === 'LONG' &&
          (RISK_CURRENCIES[def.base] || (!SAFE_HAVENS[def.base] && !SAFE_HAVENS[def.quote]))) {
        return;
      }

      // ── Cooldown check ───────────────────────────────────────────────────
      if (_onCooldown(pair, direction)) return;

      // ── Scoring ──────────────────────────────────────────────────────────

      // 1. CSI strength spread (0–30 pts)
      var csiPts = absRankDiff >= 5 ? 30
                 : absRankDiff >= 4 ? 24
                 : absRankDiff >= 3 ? 18
                 : 10;

      // 2. Volatility-adjusted carry (0–25 pts — only when direction agrees)
      var carry = _carryScore(pair);
      var carryAligned = (direction === 'LONG' && carry > 0) || (direction === 'SHORT' && carry < 0);
      var carryPts = carryAligned ? Math.round(Math.min(25, Math.abs(carry))) : 0;

      // 3. Session bonus (0–15 pts)
      var sessionPts = _sessionBonus(pair);

      // 4. MacroRegime pts (-15 to +20)
      var regPts = _regimePts(pair, direction, regime);

      // 5. GII alignment bonus (-15 to +10)
      var giiBonus = _giiPts(pair, direction);

      var score = csiPts + carryPts + sessionPts + regPts + giiBonus;
      if (!isFinite(score) || score < MIN_SCORE) return;

      // ── Confidence ───────────────────────────────────────────────────────
      // Maps score 50→0.78, 75→0.88 (capped)
      var conf = Math.min(0.88, 0.55 + score / 200);

      // ── Reasoning string ─────────────────────────────────────────────────
      var csiStr   = def.base + '#' + baseRank + ' vs ' + def.quote + '#' + quoteRank;
      var carryStr = 'carry ' + (carry >= 0 ? '+' : '') + carry.toFixed(1) + 'pt';
      var ret1h    = _pairReturn(pair, H1_IDX);
      var movStr   = ret1h !== null ? (ret1h >= 0 ? '+' : '') + ret1h.toFixed(3) + '% 1h' : '';
      var spPips   = _spreadPips(pair);
      var spStr    = spPips !== null ? 'sprd ' + spPips.toFixed(1) + 'pip' : '';
      var regStr   = 'regime:' + regime;
      var sesStr   = session;
      var scoreStr = 'score:' + score;

      var reasoning = [csiStr, carryStr, movStr, spStr, sesStr, regStr, scoreStr]
        .filter(Boolean).join(' · ');

      var sig = _mkSig(pair, direction, conf, reasoning, score);
      batch.push(sig);
      _signals.unshift(sig);
      if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
      _setCooldown(pair, direction);
      _signalCount++;

      console.log('[FF] Signal: ' + pair + ' ' + direction +
                  ' score=' + score + ' conf=' + conf.toFixed(2) +
                  ' | ' + reasoning);
    });

    // ── Forward to Execution Engine ───────────────────────────────────────
    if (batch.length && window.EE && typeof EE.onSignals === 'function') {
      try { EE.onSignals(batch); }
      catch(e) { console.warn('[FF] EE.onSignals error:', e.message || e); }
    }

    var pairsReady = Object.keys(_priceHistory).filter(function(p) {
      return _priceHistory[p] && _priceHistory[p].length >= H1_IDX + 2;
    }).length;

    console.log('[FF] Scan #' + _scanCount +
                ' | pairs ready: ' + pairsReady + '/' + Object.keys(PAIRS).length +
                ' | signals: ' + batch.length +
                ' | total: ' + _signalCount +
                ' | regime: ' + regime +
                ' | CSI: ' + sorted.join('>'));
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function _init() {
    console.log('[FF] Forex Fundamentals Agent v1 — warming up, first scan in ' +
                (FIRST_SCAN_MS / 1000) + 's');
    _collectPrices();                           // pre-seed immediately
    setInterval(_collectPrices, COLLECT_MS);    // keep history building between scans
    setTimeout(function() {
      _scan();
      setInterval(_scan, SCAN_MS);
    }, FIRST_SCAN_MS);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.FOREX_FUNDAMENTALS = {

    status: function() {
      var pairsReady = Object.keys(_priceHistory).filter(function(p) {
        return _priceHistory[p] && _priceHistory[p].length >= H1_IDX + 2;
      }).length;
      var sortedCcy = Object.keys(_csiRanks).sort(function(a, b) {
        return _csiRanks[a] - _csiRanks[b];
      });
      return {
        online        : _online,
        lastPoll      : _lastScan,
        scanCount     : _scanCount,
        signalCount   : _signalCount,
        pairsReady    : pairsReady + '/' + Object.keys(PAIRS).length,
        oandaConnected: !!(window.OANDA_RATES && typeof OANDA_RATES.isConnected === 'function' && OANDA_RATES.isConnected()),
        regime        : _getRegime(),
        session       : _activeSessions(),
        csiRanking    : sortedCcy.length ? sortedCcy.join(' > ') : 'building…',
        note          : _scanCount
          ? (pairsReady + '/10 pairs · ' + _signalCount + ' signals · ' +
             (sortedCcy.length ? sortedCcy.join('>') : 'CSI building'))
          : 'warming up — first scan in ~' + (FIRST_SCAN_MS / 1000) + 's'
      };
    },

    signals: function() { return _signals.slice(); },

    /** Live currency strength rankings and raw scores */
    csi: function() {
      return {
        ranks  : Object.assign({}, _csiRanks),
        scores : Object.assign({}, _csiScores)
      };
    },

    /** Current carry score for every pair */
    carry: function() {
      var out = {};
      Object.keys(PAIRS).forEach(function(p) { out[p] = _carryScore(p); });
      return out;
    },

    /** Current central bank rates */
    cbRates: function() { return Object.assign({}, CB_RATES); },

    /**
     * Update a central bank rate after a policy decision.
     * e.g. FOREX_FUNDAMENTALS.updateRate('USD', 4.00)
     */
    updateRate: function(ccy, rate) {
      if (!CB_RATES.hasOwnProperty(ccy)) {
        console.warn('[FF] Unknown currency: ' + ccy);
        return;
      }
      var old = CB_RATES[ccy];
      CB_RATES[ccy] = +rate;
      console.log('[FF] CB rate updated: ' + ccy + ' ' + old + '% → ' + rate + '%');
    },

    /** Force an immediate scan (bypasses 5-min timer) */
    scan: function() { _scan(); }
  };

  window.addEventListener('load', _init);

}());
