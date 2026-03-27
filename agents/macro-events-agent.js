/* Macro Events Agent — macro-events-agent.js v1
 * Monitors upcoming macroeconomic scheduled events (FOMC, CPI, NFP, ECB, GDP)
 * and emits pre-event signals to the Execution Engine via EE.onSignals().
 *
 * Scan cycle  : every 30 minutes (first scan after 5 seconds)
 * Signal gate : pre-event only; cooldown per event prevents re-emission
 * Exposes     : window.GII_AGENT_MACRO_EVENTS
 */
(function () {
  'use strict';

  // ── constants ───────────────────────────────────────────────────────────────

  var SCAN_MS        = 1800000;  // 30 minutes
  var FIRST_SCAN_MS  = 5000;     // 5 seconds after load
  var MAX_SIGNALS    = 40;

  // ── asset class map ─────────────────────────────────────────────────────────

  var ASSET_CLASS = {
    'BTC':'crypto',   'ETH':'crypto',    'SOL':'crypto',    'XRP':'crypto',
    'ADA':'crypto',   'BNB':'crypto',
    'SPY':'equity',   'QQQ':'equity',    'AAPL':'equity',   'MSFT':'equity',
    'GOOGL':'equity', 'AMZN':'equity',   'TSLA':'equity',   'META':'equity',
    'GLD':'metals',   'SLV':'metals',    'SILVER':'metals',
    'BRENT':'energy', 'BRENTOIL':'energy','OIL':'energy',   'WTI':'energy',
    'NATGAS':'energy','GAS':'energy',
    'WEAT':'agri',    'CORN':'agri',     'WHT':'agri',
    'SOXX':'equity',  'XAR':'equity',    'GDX':'metals',    'XLE':'energy'
  };

  // ── event definitions ────────────────────────────────────────────────────────
  //
  // Each event has:
  //   id         : unique string — used for cooldown tracking
  //   type       : 'FOMC' | 'CPI' | 'NFP' | 'ECB' | 'GDP'
  //   label      : human-readable name
  //   date       : ISO date string 'YYYY-MM-DD' (event date, US Eastern time implied)
  //   gateHours  : emit pre-event signals when this many hours remain or fewer
  //   signals    : array of signal definitions to emit
  //     .asset       : ticker symbol
  //     .bias        : 'LONG' | 'SHORT'
  //     .confidence  : 0–1
  //     .reasoning   : template string — {{LABEL}} and {{HOURS}} are substituted at runtime
  //     .evidenceKeys: array of tags
  //     .region      : region string
  //     .sector      : ASSET_CLASS value (resolved at runtime if omitted)
  //
  // Dates cover March 2026 through June 2026 (with today = 2026-03-25)
  //
  // FOMC meeting dates: approximately every 6 weeks
  //   Mar 18 (past), May 6–7, Jun 17–18  (2026 schedule)
  //
  // CPI release dates: 2nd week of each month
  //   Mar 12 (past), Apr 10, May 13, Jun 11
  //
  // NFP dates: first Friday of each month
  //   Mar 6 (past), Apr 3, May 1, Jun 5
  //
  // ECB dates: approximately every 6 weeks
  //   Mar 6 (past), Apr 17, Jun 5
  //
  // GDP (advance estimate): quarterly, usually end of month following quarter end
  //   Q4 2025 final: Feb 27 (past)
  //   Q1 2026 advance: Apr 29, Q2 2026 advance: Jul 30 (out of window)

  var EVENT_CALENDAR = [

    // ── FOMC ──────────────────────────────────────────────────────────────────

    {
      id        : 'fomc_may2026',
      type      : 'FOMC',
      label     : 'FOMC Rate Decision (May 2026)',
      date      : '2026-05-07',  // Day 2 of the meeting — decision day
      gateHours : 24,
      signals   : [
        {
          asset        : 'GLD',
          bias         : 'LONG',
          confidence   : 70,
          reasoning    : 'Fed rate decision in {{HOURS}}h — gold historically rallies into uncertainty and dovish meeting bets',
          region       : 'US',
          sector       : 'metals',
          evidenceKeys : ['macro', 'fed', 'fomc', 'metals', 'uncertainty']
        },
        {
          asset        : 'BTC',
          bias         : 'LONG',
          confidence   : 70,
          reasoning    : 'FOMC in {{HOURS}}h — crypto risk-on flow into dovish Fed expectations',
          region       : 'US',
          sector       : 'crypto',
          evidenceKeys : ['macro', 'fed', 'fomc', 'crypto', 'risk-on']
        }
      ]
    },

    {
      id        : 'fomc_jun2026',
      type      : 'FOMC',
      label     : 'FOMC Rate Decision (Jun 2026)',
      date      : '2026-06-18',  // Day 2 — decision day
      gateHours : 24,
      signals   : [
        {
          asset        : 'GLD',
          bias         : 'LONG',
          confidence   : 70,
          reasoning    : 'Fed rate decision in {{HOURS}}h — gold historically rallies into uncertainty and dovish meeting bets',
          region       : 'US',
          sector       : 'metals',
          evidenceKeys : ['macro', 'fed', 'fomc', 'metals', 'uncertainty']
        },
        {
          asset        : 'BTC',
          bias         : 'LONG',
          confidence   : 70,
          reasoning    : 'FOMC in {{HOURS}}h — crypto risk-on flow into dovish Fed expectations',
          region       : 'US',
          sector       : 'crypto',
          evidenceKeys : ['macro', 'fed', 'fomc', 'crypto', 'risk-on']
        }
      ]
    },

    // ── CPI ───────────────────────────────────────────────────────────────────

    {
      id        : 'cpi_apr2026',
      type      : 'CPI',
      label     : 'US CPI Release (Apr 2026)',
      date      : '2026-04-10',
      gateHours : 12,
      signals   : [
        {
          asset        : 'GLD',
          bias         : 'LONG',
          confidence   : 68,
          reasoning    : 'CPI data in {{HOURS}}h — gold bid as inflation hedge ahead of print',
          region       : 'US',
          sector       : 'metals',
          evidenceKeys : ['macro', 'cpi', 'inflation', 'metals']
        },
        {
          asset        : 'SILVER',
          bias         : 'LONG',
          confidence   : 68,
          reasoning    : 'CPI print in {{HOURS}}h — silver follows gold as inflation hedge',
          region       : 'US',
          sector       : 'metals',
          evidenceKeys : ['macro', 'cpi', 'inflation', 'metals', 'silver']
        },
        {
          asset        : 'BTC',
          bias         : 'LONG',
          confidence   : 68,
          reasoning    : 'CPI release in {{HOURS}}h — crypto bid as digital inflation hedge',
          region       : 'US',
          sector       : 'crypto',
          evidenceKeys : ['macro', 'cpi', 'inflation', 'crypto']
        },
        {
          asset        : 'SPY',
          bias         : 'SHORT',
          confidence   : 68,
          reasoning    : 'CPI in {{HOURS}}h — equities pressured by rate hike fears ahead of hot print risk',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['macro', 'cpi', 'inflation', 'rates', 'equities']
        }
      ]
    },

    {
      id        : 'cpi_may2026',
      type      : 'CPI',
      label     : 'US CPI Release (May 2026)',
      date      : '2026-05-13',
      gateHours : 12,
      signals   : [
        {
          asset        : 'GLD',
          bias         : 'LONG',
          confidence   : 68,
          reasoning    : 'CPI data in {{HOURS}}h — gold bid as inflation hedge ahead of print',
          region       : 'US',
          sector       : 'metals',
          evidenceKeys : ['macro', 'cpi', 'inflation', 'metals']
        },
        {
          asset        : 'SILVER',
          bias         : 'LONG',
          confidence   : 68,
          reasoning    : 'CPI print in {{HOURS}}h — silver follows gold as inflation hedge',
          region       : 'US',
          sector       : 'metals',
          evidenceKeys : ['macro', 'cpi', 'inflation', 'metals', 'silver']
        },
        {
          asset        : 'BTC',
          bias         : 'LONG',
          confidence   : 68,
          reasoning    : 'CPI release in {{HOURS}}h — crypto bid as digital inflation hedge',
          region       : 'US',
          sector       : 'crypto',
          evidenceKeys : ['macro', 'cpi', 'inflation', 'crypto']
        },
        {
          asset        : 'SPY',
          bias         : 'SHORT',
          confidence   : 68,
          reasoning    : 'CPI in {{HOURS}}h — equities pressured by rate hike fears ahead of hot print risk',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['macro', 'cpi', 'inflation', 'rates', 'equities']
        }
      ]
    },

    {
      id        : 'cpi_jun2026',
      type      : 'CPI',
      label     : 'US CPI Release (Jun 2026)',
      date      : '2026-06-11',
      gateHours : 12,
      signals   : [
        {
          asset        : 'GLD',
          bias         : 'LONG',
          confidence   : 68,
          reasoning    : 'CPI data in {{HOURS}}h — gold bid as inflation hedge ahead of print',
          region       : 'US',
          sector       : 'metals',
          evidenceKeys : ['macro', 'cpi', 'inflation', 'metals']
        },
        {
          asset        : 'SILVER',
          bias         : 'LONG',
          confidence   : 68,
          reasoning    : 'CPI print in {{HOURS}}h — silver follows gold as inflation hedge',
          region       : 'US',
          sector       : 'metals',
          evidenceKeys : ['macro', 'cpi', 'inflation', 'metals', 'silver']
        },
        {
          asset        : 'BTC',
          bias         : 'LONG',
          confidence   : 68,
          reasoning    : 'CPI release in {{HOURS}}h — crypto bid as digital inflation hedge',
          region       : 'US',
          sector       : 'crypto',
          evidenceKeys : ['macro', 'cpi', 'inflation', 'crypto']
        },
        {
          asset        : 'SPY',
          bias         : 'SHORT',
          confidence   : 68,
          reasoning    : 'CPI in {{HOURS}}h — equities pressured by rate hike fears ahead of hot print risk',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['macro', 'cpi', 'inflation', 'rates', 'equities']
        }
      ]
    },

    // ── NFP ───────────────────────────────────────────────────────────────────

    {
      id        : 'nfp_apr2026',
      type      : 'NFP',
      label     : 'US NFP Jobs Report (Apr 2026)',
      date      : '2026-04-03',  // First Friday of April
      gateHours : 6,
      signals   : [
        {
          asset        : 'SPY',
          bias         : 'LONG',
          confidence   : 63,
          reasoning    : 'NFP jobs report in {{HOURS}}h — risk-on positioning into strong labour market expectations',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['macro', 'nfp', 'jobs', 'labour', 'equities']
        },
        {
          asset        : 'QQQ',
          bias         : 'LONG',
          confidence   : 63,
          reasoning    : 'NFP in {{HOURS}}h — QQQ follows SPY risk-on into jobs beat expectations',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['macro', 'nfp', 'jobs', 'labour', 'tech']
        }
      ]
    },

    {
      id        : 'nfp_may2026',
      type      : 'NFP',
      label     : 'US NFP Jobs Report (May 2026)',
      date      : '2026-05-01',  // First Friday of May
      gateHours : 6,
      signals   : [
        {
          asset        : 'SPY',
          bias         : 'LONG',
          confidence   : 63,
          reasoning    : 'NFP jobs report in {{HOURS}}h — risk-on positioning into strong labour market expectations',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['macro', 'nfp', 'jobs', 'labour', 'equities']
        },
        {
          asset        : 'QQQ',
          bias         : 'LONG',
          confidence   : 63,
          reasoning    : 'NFP in {{HOURS}}h — QQQ follows SPY risk-on into jobs beat expectations',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['macro', 'nfp', 'jobs', 'labour', 'tech']
        }
      ]
    },

    {
      id        : 'nfp_jun2026',
      type      : 'NFP',
      label     : 'US NFP Jobs Report (Jun 2026)',
      date      : '2026-06-05',  // First Friday of June
      gateHours : 6,
      signals   : [
        {
          asset        : 'SPY',
          bias         : 'LONG',
          confidence   : 63,
          reasoning    : 'NFP jobs report in {{HOURS}}h — risk-on positioning into strong labour market expectations',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['macro', 'nfp', 'jobs', 'labour', 'equities']
        },
        {
          asset        : 'QQQ',
          bias         : 'LONG',
          confidence   : 63,
          reasoning    : 'NFP in {{HOURS}}h — QQQ follows SPY risk-on into jobs beat expectations',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['macro', 'nfp', 'jobs', 'labour', 'tech']
        }
      ]
    },

    // ── ECB ───────────────────────────────────────────────────────────────────

    {
      id        : 'ecb_apr2026',
      type      : 'ECB',
      label     : 'ECB Rate Decision (Apr 2026)',
      date      : '2026-04-17',
      gateHours : 24,
      signals   : [
        {
          asset        : 'GLD',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'ECB rate decision in {{HOURS}}h — EUR volatility drives commodity safe-haven demand',
          region       : 'EU',
          sector       : 'metals',
          evidenceKeys : ['macro', 'ecb', 'europe', 'metals', 'fx-vol']
        },
        {
          asset        : 'BRENT',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'ECB decision in {{HOURS}}h — EUR policy shift drives energy commodity hedging',
          region       : 'EU',
          sector       : 'energy',
          evidenceKeys : ['macro', 'ecb', 'europe', 'energy', 'brent']
        }
      ]
    },

    {
      id        : 'ecb_jun2026',
      type      : 'ECB',
      label     : 'ECB Rate Decision (Jun 2026)',
      date      : '2026-06-05',
      gateHours : 24,
      signals   : [
        {
          asset        : 'GLD',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'ECB rate decision in {{HOURS}}h — EUR volatility drives commodity safe-haven demand',
          region       : 'EU',
          sector       : 'metals',
          evidenceKeys : ['macro', 'ecb', 'europe', 'metals', 'fx-vol']
        },
        {
          asset        : 'BRENT',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'ECB decision in {{HOURS}}h — EUR policy shift drives energy commodity hedging',
          region       : 'EU',
          sector       : 'energy',
          evidenceKeys : ['macro', 'ecb', 'europe', 'energy', 'brent']
        }
      ]
    },

    // ── GDP ───────────────────────────────────────────────────────────────────

    {
      id        : 'gdp_q1_advance_2026',
      type      : 'GDP',
      label     : 'US GDP Q1 2026 Advance Estimate',
      date      : '2026-04-29',  // BEA typically releases ~4 weeks after quarter end
      gateHours : 24,
      signals   : [
        {
          asset        : 'SPY',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'US GDP advance estimate in {{HOURS}}h — markets positioning into growth-positive print',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['macro', 'gdp', 'growth', 'equities', 'us']
        },
        {
          asset        : 'GLD',
          bias         : 'LONG',
          confidence   : 62,
          reasoning    : 'GDP release in {{HOURS}}h — gold bid as hedge against growth surprise in either direction',
          region       : 'US',
          sector       : 'metals',
          evidenceKeys : ['macro', 'gdp', 'growth', 'metals', 'uncertainty']
        }
      ]
    },

    // ── EARNINGS (Q1 2026) ────────────────────────────────────────────────────

    {
      id        : 'earnings_tsla_q1_2026',
      type      : 'EARNINGS',
      label     : 'TSLA Q1 2026 Earnings',
      date      : '2026-04-22',
      gateHours : 48,
      signals   : [
        {
          asset        : 'TSLA',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'Q1 earnings in {{HOURS}}h — pre-earnings momentum historically bullish',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['earnings', 'equity']
        },
        {
          asset        : 'QQQ',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'Q1 earnings in {{HOURS}}h — pre-earnings momentum historically bullish',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['earnings', 'equity']
        }
      ]
    },

    {
      id        : 'earnings_msft_q1_2026',
      type      : 'EARNINGS',
      label     : 'MSFT Q1 2026 Earnings',
      date      : '2026-04-29',
      gateHours : 48,
      signals   : [
        {
          asset        : 'MSFT',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'Q1 earnings in {{HOURS}}h — pre-earnings momentum historically bullish',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['earnings', 'equity']
        },
        {
          asset        : 'QQQ',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'Q1 earnings in {{HOURS}}h — pre-earnings momentum historically bullish',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['earnings', 'equity']
        }
      ]
    },

    {
      id        : 'earnings_googl_q1_2026',
      type      : 'EARNINGS',
      label     : 'GOOGL Q1 2026 Earnings',
      date      : '2026-04-29',
      gateHours : 48,
      signals   : [
        {
          asset        : 'GOOGL',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'Q1 earnings in {{HOURS}}h — pre-earnings momentum historically bullish',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['earnings', 'equity']
        },
        {
          asset        : 'QQQ',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'Q1 earnings in {{HOURS}}h — pre-earnings momentum historically bullish',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['earnings', 'equity']
        }
      ]
    },

    {
      id        : 'earnings_aapl_q1_2026',
      type      : 'EARNINGS',
      label     : 'AAPL Q1 2026 Earnings',
      date      : '2026-04-30',
      gateHours : 48,
      signals   : [
        {
          asset        : 'AAPL',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'Q1 earnings in {{HOURS}}h — pre-earnings momentum historically bullish',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['earnings', 'equity']
        },
        {
          asset        : 'QQQ',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'Q1 earnings in {{HOURS}}h — pre-earnings momentum historically bullish',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['earnings', 'equity']
        }
      ]
    },

    {
      id        : 'earnings_meta_q1_2026',
      type      : 'EARNINGS',
      label     : 'META Q1 2026 Earnings',
      date      : '2026-04-30',
      gateHours : 48,
      signals   : [
        {
          asset        : 'META',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'Q1 earnings in {{HOURS}}h — pre-earnings momentum historically bullish',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['earnings', 'equity']
        },
        {
          asset        : 'QQQ',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'Q1 earnings in {{HOURS}}h — pre-earnings momentum historically bullish',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['earnings', 'equity']
        }
      ]
    },

    {
      id        : 'earnings_hood_q1_2026',
      type      : 'EARNINGS',
      label     : 'HOOD Q1 2026 Earnings',
      date      : '2026-04-30',
      gateHours : 48,
      signals   : [
        {
          asset        : 'QQQ',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'Q1 earnings in {{HOURS}}h — pre-earnings momentum historically bullish',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['earnings', 'equity']
        }
      ]
    },

    {
      id        : 'earnings_amzn_q1_2026',
      type      : 'EARNINGS',
      label     : 'AMZN Q1 2026 Earnings',
      date      : '2026-05-01',
      gateHours : 48,
      signals   : [
        {
          asset        : 'AMZN',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'Q1 earnings in {{HOURS}}h — pre-earnings momentum historically bullish',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['earnings', 'equity']
        },
        {
          asset        : 'QQQ',
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'Q1 earnings in {{HOURS}}h — pre-earnings momentum historically bullish',
          region       : 'US',
          sector       : 'equity',
          evidenceKeys : ['earnings', 'equity']
        }
      ]
    }

  ];

  // ── state ────────────────────────────────────────────────────────────────────

  var _signals       = [];   // ring buffer of emitted signals
  var _activeSignals = [];   // signals emitted this scan cycle for status().signals()
  var _emittedEvents = {};   // cooldown map: eventId → true
  var _scanCount     = 0;
  var _signalCount   = 0;

  var _status = {
    lastPoll     : null,
    online       : true,       // always true — no network required
    eventsTracked: EVENT_CALENDAR.length,
    nextEvent    : null,
    signalCount  : 0,
    note         : 'Initialising…'
  };

  // ── helpers ──────────────────────────────────────────────────────────────────

  /*
   * Return hours until the given ISO date string at 14:00 ET (19:00 UTC).
   * FOMC decisions and most releases happen early afternoon ET.
   * Using 14:00 ET = 19:00 UTC as the event time.
   */
  function _hoursUntil(dateStr) {
    // Parse date and set event time to 14:00 ET (approximated as UTC-5 → 19:00 UTC)
    var parts  = dateStr.split('-');
    var year   = parseInt(parts[0], 10);
    var month  = parseInt(parts[1], 10) - 1; // zero-indexed
    var day    = parseInt(parts[2], 10);
    var eventMs = Date.UTC(year, month, day, 19, 0, 0); // 19:00 UTC ≈ 14:00 ET
    return (eventMs - Date.now()) / 3600000;
  }

  /*
   * Format a duration in hours as a human-readable string, e.g. "3d 4h" or "6h".
   */
  function _fmtHours(h) {
    if (h < 0) return 'NOW';
    var days  = Math.floor(h / 24);
    var hours = Math.floor(h % 24);
    if (days > 0) return days + 'd ' + hours + 'h';
    return Math.round(h) + 'h';
  }

  /*
   * Check whether an asset is tradeable via HLFeed.
   * Returns true if HLFeed is unavailable (fail-open — better to send the signal
   * and let the EE gate it than to silently drop it when the feed is slow to init).
   */
  function _isAvailable(asset) {
    if (window.HLFeed && typeof HLFeed.isAvailable === 'function') {
      return HLFeed.isAvailable(asset);
    }
    return true; // fail-open: HLFeed not ready yet
  }

  /*
   * Substitute {{LABEL}} and {{HOURS}} tokens in a reasoning template string.
   */
  function _fillTemplate(template, label, hoursStr) {
    return template
      .replace('{{LABEL}}', label)
      .replace('{{HOURS}}', hoursStr);
  }

  /*
   * Push a signal into the ring buffer.
   */
  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  // ── core scan ────────────────────────────────────────────────────────────────

  function _scan() {
    _scanCount++;
    _status.lastPoll = Date.now();
    _activeSignals   = [];

    var newEESignals  = [];  // collected this scan cycle for single EE.onSignals() call
    var soonestHours  = Infinity;
    var soonestLabel  = null;

    for (var i = 0; i < EVENT_CALENDAR.length; i++) {
      var ev     = EVENT_CALENDAR[i];
      var hours  = _hoursUntil(ev.date);

      // Track the next upcoming event for the status note
      if (hours > 0 && hours < soonestHours) {
        soonestHours = hours;
        soonestLabel = ev.type + ' (' + ev.label + ')';
      }

      // Skip events that are in the past (event time has passed)
      if (hours < 0) continue;

      // Skip if outside the pre-event gate window
      if (hours > ev.gateHours) continue;

      // Skip if we already emitted signals for this event (cooldown)
      if (_emittedEvents[ev.id]) continue;

      // This event is within the gate window and not yet fired — build signals
      var hoursStr  = _fmtHours(hours);
      var evSignals = ev.signals;

      for (var j = 0; j < evSignals.length; j++) {
        var def   = evSignals[j];
        var asset = def.asset;

        // Tradeable check
        if (!_isAvailable(asset)) {
          console.log('[MACRO-EVENTS] ' + ev.id + ': skipping ' + asset + ' — not available in HLFeed');
          continue;
        }

        var sector = def.sector || ASSET_CLASS[asset] || 'unknown';

        var sig = {
          source       : 'macro-events',
          asset        : asset,
          bias         : def.bias,
          confidence   : def.confidence,
          reasoning    : _fillTemplate(def.reasoning, ev.label, hoursStr),
          region       : def.region,
          sector       : sector,
          evidenceKeys : def.evidenceKeys.slice(),
          eventId      : ev.id,
          eventType    : ev.type,
          eventLabel   : ev.label,
          hoursToEvent : Math.round(hours * 10) / 10,
          timestamp    : Date.now()
        };

        _pushSignal(sig);
        _activeSignals.push(sig);
        newEESignals.push(sig);
        _signalCount++;
      }

      // Mark this event as emitted so cooldown applies until next distinct event
      _emittedEvents[ev.id] = true;

      console.log('[MACRO-EVENTS] Fired pre-event signals for: ' + ev.id +
                  ' (' + ev.type + ' in ' + hoursStr + ')');
    }

    // Update status
    _status.signalCount = _signalCount;
    _status.eventsTracked = EVENT_CALENDAR.length;

    // Build status note
    if (_activeSignals.length > 0) {
      _status.note = _activeSignals.length + ' signal' + (_activeSignals.length > 1 ? 's' : '') + ' active';
    } else if (soonestLabel !== null && soonestHours < Infinity) {
      // Show next upcoming event
      var typeShort = soonestLabel.split(' ')[0]; // e.g. 'FOMC'
      _status.note = 'Next: ' + typeShort + ' in ' + _fmtHours(soonestHours);
    } else {
      _status.note = 'No events in window';
    }

    // Build nextEvent for status()
    if (soonestLabel !== null && soonestHours < Infinity) {
      _status.nextEvent = {
        label      : soonestLabel,
        hoursAway  : Math.round(soonestHours * 10) / 10,
        humanLabel : _fmtHours(soonestHours)
      };
    } else {
      _status.nextEvent = null;
    }

    // Forward to Execution Engine
    if (newEESignals.length > 0) {
      _forwardToEE(newEESignals);
    }
  }

  // ── EE forwarding ────────────────────────────────────────────────────────────

  function _forwardToEE(sigs) {
    if (!window.EE || typeof EE.onSignals !== 'function') {
      console.warn('[MACRO-EVENTS] EE.onSignals not available — signals buffered locally only');
      return;
    }
    try {
      EE.onSignals(sigs);
      console.log('[MACRO-EVENTS] Forwarded ' + sigs.length + ' signal(s) to EE');
    } catch (e) {
      console.warn('[MACRO-EVENTS] EE.onSignals error: ' + (e.message || String(e)));
    }
  }

  // ── public API ───────────────────────────────────────────────────────────────

  /*
   * status() — current agent health and summary
   *   lastPoll      : timestamp of last scan
   *   online        : always true (no network dependency)
   *   eventsTracked : total events in the calendar
   *   nextEvent     : { label, hoursAway, humanLabel } or null
   *   signalCount   : total signals emitted since load
   *   note          : human-readable summary string
   */
  function _statusFn() {
    return {
      lastPoll     : _status.lastPoll,
      online       : _status.online,
      eventsTracked: _status.eventsTracked,
      nextEvent    : _status.nextEvent,
      signalCount  : _status.signalCount,
      note         : _status.note
    };
  }

  /*
   * signals() — returns a copy of the current active signals array
   * (populated during the most recent scan cycle that hit a gate window)
   */
  function _signalsFn() {
    return _activeSignals.slice();
  }

  /*
   * scan() — force an immediate scan outside the normal 30-minute interval
   */
  function _scanFn() {
    console.log('[MACRO-EVENTS] Manual scan triggered');
    _scan();
    return _statusFn();
  }

  window.GII_AGENT_MACRO_EVENTS = {
    status  : _statusFn,
    signals : _signalsFn,
    scan    : _scanFn
  };

  // ── init ─────────────────────────────────────────────────────────────────────

  function _init() {
    console.log('[MACRO-EVENTS] Agent loaded — ' + EVENT_CALENDAR.length +
                ' events tracked, first scan in ' + (FIRST_SCAN_MS / 1000) + 's');
    setTimeout(function () {
      _scan();
      setInterval(_scan, SCAN_MS);
    }, FIRST_SCAN_MS);
  }

  window.addEventListener('load', _init);

})();
