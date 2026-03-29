/* ══════════════════════════════════════════════════════════════════════════════
   EXECUTION ENGINE (EE) — Signal-Driven Trade Automation
   ══════════════════════════════════════════════════════════════════════════════
   Architecture:
     Signal bus hook   → EE.onSignals(sigs) called by renderTrades() each cycle
     Risk gate         → canExecute(sig) checks all risk rules before opening
     Trade lifecycle   → openTrade() → monitorTrades() → closeTrade()
     Persistence       → localStorage for config + full trade history
     HRS bridge        → auto-captures & evaluates in the Hit Rate Tracker
     Broker stubs      → connectBroker() interface ready for Binance / Alpaca / Polymarket

   Modes:
     SIMULATION  — paper trades with virtual balance, real prices where available
     LIVE        — real execution via broker API (not yet wired, stubs only)

   Design constraints:
     • Does NOT modify the intelligence pipeline (scoreEvent, ingest, regionStates)
     • renderTrades() only gained one non-breaking emit line
     • All EE logic is fully isolated in this file
   ══════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Storage keys ──────────────────────────────────────────────────────────── */
  var CFG_KEY         = 'geodash_ee_config_v2';
  var TRADES_KEY      = 'geodash_ee_trades_v1';
  var SIGLOG_KEY      = 'geodash_ee_siglog_v1';
  var PNL_HISTORY_KEY = 'geodash_pnl_history_v1';
  var HALT_KEY        = 'geodash_ee_halted_v1';
  var STATE_VERSION   = '2.0';

  /* ── SQLite API ─────────────────────────────────────────────────────────────
     Primary persistence: GeoIntel backend on port 8765.
     Falls back to localStorage silently if the backend isn't running.         */
  // API base: fixed to local backend. Do not change this to a remote URL.
  var _BACKEND_URL_KEY = 'geodash_backend_url_v1';
  var _API_BASE = 'http://localhost:8765';
  var _apiOnline    = false;   // set true after first successful /api/status ping
  var _backendChecked = false; // set true after first ping attempt resolves (ok or fail)

  /* ── Default risk configuration ────────────────────────────────────────────── */
  var DEFAULTS = {
    // ── Mode & execution ──────────────────────────────────────────────────────
    mode:                  'SIMULATION', // start in paper mode for safety; user switches to LIVE
    enabled:               true,
    auto_start:            true,
    broker:                'SIMULATION',
    max_siglog:            200,
    cooldown_ms:           60000,
    // ── Core risk parameters (Morgan's live settings — these are the standard) ─
    min_confidence:        55,           // minimum signal confidence to trade
    virtual_balance:       1000,         // placeholder — overwritten by live broker equity sync
    risk_per_trade_pct:    1,            // 1% per trade: conservative for small account
    stop_loss_pct:         2.5,          // 2.5% stop distance
    take_profit_ratio:     3.0,          // 3.0R target (raised from 2.5 — partial TP at 70% = 2.1R vs old 1.25R)
    max_open_trades:       12,
    max_per_region:        6,
    max_per_sector:        6,
    max_exposure_pct:      45,
    max_risk_usd:          30,           // hard cap $30 risk per trade
    // ── Risk management toggles ───────────────────────────────────────────────
    trailing_stop_enabled:  false,       // gii-exit owns progressive trailing — keep off here
    trailing_stop_pct:      1.0,
    break_even_enabled:     true,        // move SL to entry once 50% of way to TP
    break_even_trigger_pct: 40,          // trigger BE at 40% of TP distance (raised from 50% — fire BE earlier so runner has more room)
    partial_tp_enabled:     true,        // take 50% off at TP1
    daily_loss_limit_pct:   15,          // circuit breaker at -15% session loss
    daily_profit_target_pct: 0,          // T4-C: 0 = disabled; set e.g. 5 to pause new trades after +5% session gain
    event_gate_enabled:     true,        // block new trades 30min before major events
    event_gate_hours:       0.5,
  };

  /* ── Sector map — used for max_per_sector concentration cap ──────────────── */
  // Per-asset minimum confidence floors — derived from historical win-rate data.
  // Assets with poor track records require stronger signal conviction before opening.
  // Format: normalised asset key → minimum conf% required (overrides global min_confidence).
  var EE_ASSET_CONF_FLOOR = {
    'ADA':  85,  // 0% WR across 4 trades  — effectively blocked until signal quality improves
    'BNB':  80,  // 9% WR across 11 trades — very high bar
    'XRP':  75,  // 12% WR across 8 trades
    'LTC':  73,  // 20% WR across 5 trades
    'DOGE': 70,  // 30% WR across 10 trades
    'DOT':  70,  // 29% WR across 7 trades
  };

  /* ── Dynamic confidence floor updater ─────────────────────────────────────
     Reads all-time attribution data from localStorage and recalculates
     per-asset confidence floors every 30 minutes.
     Rules (require ≥12 closed trades per asset to take effect):
       WR < 25%: floor = max(current, 85)  — near-blocked, very poor
       WR < 35%: floor = max(current, 78)  — poor, high bar
       WR < 45%: floor = max(current, 70)  — below average, raise bar
       WR 45–55%: floor unchanged
       WR > 60%: floor = min(current, 60)  — relax floor for hot assets
       WR > 70%: floor = min(current, 55)  — strong performer, relax further
     Static hardcoded values above serve as a starting point; once enough
     trade data exists the dynamic calculation takes over.                   */
  function _updateDynamicFloors() {
    try {
      var recs = JSON.parse(localStorage.getItem('geodash_attribution_v1') || '[]');
      if (!recs.length) return;
      // Group by asset
      var byAsset = {};
      recs.forEach(function (r) {
        var a = r.asset;
        if (!a) return;
        if (!byAsset[a]) byAsset[a] = { total: 0, wins: 0 };
        byAsset[a].total++;
        if (r.win) byAsset[a].wins++;
      });
      var changed = [];
      Object.keys(byAsset).forEach(function (asset) {
        var d  = byAsset[asset];
        if (d.total < 12) return;  // insufficient data
        var wr = d.wins / d.total;
        var cur = EE_ASSET_CONF_FLOOR[asset] || 0;
        var next = cur;
        if      (wr < 0.25) next = Math.max(cur, 85);
        else if (wr < 0.35) next = Math.max(cur, 78);
        else if (wr < 0.45) next = Math.max(cur, 70);
        else if (wr > 0.70) next = Math.min(cur || 65, 55);
        else if (wr > 0.60) next = Math.min(cur || 65, 60);
        if (next !== cur) {
          EE_ASSET_CONF_FLOOR[asset] = next;
          changed.push(asset + ':' + cur + '→' + next + '(' + Math.round(wr*100) + '%WR)');
        } else if (next > 0 && !EE_ASSET_CONF_FLOOR[asset]) {
          EE_ASSET_CONF_FLOOR[asset] = next;
        }
      });
      if (changed.length) log('RISK', 'Dynamic floors updated: ' + changed.join(', '), 'dim');
    } catch(e) {}
  }

  var EE_SECTOR_MAP = {
    /* Energy — WTI, BRENT, GAS on HL perps; XLE/XOM flagged (no HL token) */
    'WTI':'energy',   'BRENT':'energy', 'XLE':'energy',  'XOM':'energy',
    'GAS':'energy',   'NATGAS':'energy',
    /* Precious */
    'XAU':'precious', 'GLD':'precious', 'SLV':'precious', 'SILVER':'precious',
    /* Defense — not on HL spot (flagged) */
    'XAR':'defense',  'LMT':'defense',  'RTX':'defense',  'NOC':'defense',
    /* Crypto perps */
    'BTC':'crypto',   'ETH':'crypto',   'SOL':'crypto',   'BNB':'crypto',   'ADA':'crypto',
    /* HL spot equity tokens */
    'TSLA':'equity',  'AAPL':'equity',  'AMZN':'equity',  'META':'equity',
    'QQQ':'equity',   'MSFT':'equity',  'GOOGL':'equity', 'HOOD':'equity',
    'SPY':'equity',   'CRCL':'equity',
    /* Other equities — various HL coverage status */
    'VIX':'equity',   'VXX':'equity',   'EEM':'equity',   'FXI':'equity',
    /* Semis — mostly not on HL (flagged) */
    'SMH':'semis',    'TSM':'semis',    'NVDA':'semis',   'ASML':'semis',
    /* Agri — not on HL (flagged) */
    'WHT':'agri',     'CORN':'agri',    'SOYB':'agri',
    'DAL':'airlines', 'UAL':'airlines',
    'LIT':'battery',  'COPX':'metals',  'XME':'metals',
    /* Forex — via TickTrader broker */
    'EURUSD':'forex', 'GBPUSD':'forex', 'USDJPY':'forex', 'USDCHF':'forex',
    'AUDUSD':'forex', 'USDCAD':'forex', 'NZDUSD':'forex',
    'GBPJPY':'forex', 'EURJPY':'forex', 'EURGBP':'forex',
    'EURCAD':'forex', 'EURCHF':'forex', 'AUDJPY':'forex', 'CHFJPY':'forex',
    'EUR':'forex',    'JPY':'forex',    'CHF':'forex',    'NOK':'forex',
    'GBP':'forex',    'AUD':'forex',    'CAD':'forex',    'NZD':'forex',
    'INDA':'em'
  };

  /* ── Flagged trades state (assets not available on Hyperliquid) ─────────────
     Captured BEFORE canExecute() so we record every opportunity missed due to
     HL unavailability, regardless of other risk limits.
     Stored in localStorage (FLAG_STORE_KEY) and rendered in #eeFlaggedTrades. */
  var _flaggedTrades  = [];
  var FLAG_STORE_KEY  = 'ee_flagged_v1';
  var FLAG_MAX        = 500;

  function _loadFlaggedTrades() {
    try { _flaggedTrades = JSON.parse(localStorage.getItem(FLAG_STORE_KEY) || '[]'); }
    catch (e) { _flaggedTrades = []; }
  }
  function _saveFlaggedTrades() {
    try { localStorage.setItem(FLAG_STORE_KEY, JSON.stringify(_flaggedTrades.slice(0, FLAG_MAX))); }
    catch (e) {
      console.warn('[EE] _saveFlaggedTrades FAILED — flagged trade log not persisted (storage full or unavailable).', e);
    }
  }

  /* Create a flag record from a signal and persist it */
  function _flagTrade(sig, hlReason) {
    var record = {
      id:          'FLAG-' + Date.now().toString(36).toUpperCase(),
      flaggedAt:   new Date().toISOString(),
      asset:       sig.asset  || '—',
      direction:   sig.dir    || '—',
      confidence:  sig.conf   || 0,
      signalSource:sig.from   || sig.source || (sig.reason ? sig.reason.split(':')[0] : '—'),
      region:      sig.region || '—',
      signalReason:sig.reason || '',
      hlReason:    hlReason,
      intendedRiskPct: _cfg.risk_per_trade_pct
    };
    _flaggedTrades.unshift(record);
    if (_flaggedTrades.length > FLAG_MAX) _flaggedTrades.pop();
    _saveFlaggedTrades();
    _renderFlaggedTrades();
    log('FLAG', record.asset + ' ' + record.direction +
        ' ' + record.confidence + '% — ' + hlReason, 'dim');
  }

  /* Summarise flagged trades: top blocked assets over last 7 days */
  function _getFlagSummary() {
    var cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    var recent = _flaggedTrades.filter(function (f) {
      return new Date(f.flaggedAt).getTime() >= cutoff;
    });
    var counts = {};
    recent.forEach(function (f) {
      counts[f.asset] = (counts[f.asset] || 0) + 1;
    });
    return Object.keys(counts)
      .sort(function (a, b) { return counts[b] - counts[a]; })
      .slice(0, 5)
      .map(function (asset) { return { asset: asset, count: counts[asset] }; });
  }

  /* Render the flagged trades panel */
  function _renderFlaggedTrades() {
    var panel = document.getElementById('eeFlaggedTrades');
    if (!panel) return;
    var todayCutoff = Date.now() - 24 * 3600 * 1000;
    var todayFlags  = _flaggedTrades.filter(function (f) { return new Date(f.flaggedAt).getTime() >= todayCutoff; });
    var weekFlags   = _flaggedTrades.filter(function (f) { return new Date(f.flaggedAt).getTime() >= Date.now() - 7 * 24 * 3600 * 1000; });

    // Update counters
    var todayEl = document.getElementById('eeFlaggedToday');
    var weekEl  = document.getElementById('eeFlaggedWeek');
    if (todayEl) todayEl.textContent = todayFlags.length;
    if (weekEl)  weekEl.textContent  = weekFlags.length;

    // Top missed assets summary
    var summary = _getFlagSummary();
    var summaryEl = document.getElementById('eeFlaggedSummary');
    if (summaryEl && summary.length) {
      summaryEl.textContent = 'Most missed this week: ' +
        summary.map(function (s) { return s.asset + ' (' + s.count + '×)'; }).join('  ·  ');
    }

    // Rows — show last 25
    var show = _flaggedTrades.slice(0, 25);
    panel.innerHTML = show.length ? show.map(function (f) {
      var t   = new Date(f.flaggedAt);
      var ts  = (t.getHours() < 10 ? '0' : '') + t.getHours() + ':' +
                (t.getMinutes() < 10 ? '0' : '') + t.getMinutes();
      var dir = f.direction === 'LONG' ? '<span style="color:#4fc">▲ LONG</span>'
                                       : '<span style="color:#f88">▼ SHORT</span>';
      return '<div class="ee-flag-row">' +
        '<span class="ee-flag-ts">'   + ts               + '</span>' +
        '<span class="ee-flag-asset">'+ f.asset          + '</span>' +
        '<span class="ee-flag-dir">'  + dir              + '</span>' +
        '<span class="ee-flag-conf">' + f.confidence     + '%</span>' +
        '<span class="ee-flag-src">'  + (f.signalSource || '—').substring(0,18) + '</span>' +
        '<span class="ee-flag-why">'  + f.hlReason       + '</span>' +
        '</div>';
    }).join('') : '<div class="ee-flag-empty">No flagged trades yet — all signals so far are on HL</div>';
  }

  /* Render the portfolio watchlist panel (from gii-portfolio agent) */
  function renderPortfolioWatchlist() {
    var listEl = document.getElementById('eePortfolioWatchlist');
    var metaEl = document.getElementById('eePortfolioMeta');
    var rotEl  = document.getElementById('eePortfolioLastRotation');
    if (!listEl) return;

    var agent = window.GII_AGENT_PORTFOLIO;
    if (!agent) {
      listEl.innerHTML = '<div class="ee-flag-empty">Portfolio agent not loaded</div>';
      return;
    }

    var wl  = agent.watchlist();
    var st  = agent.status();
    var rot = agent.rotations();

    /* Meta stats */
    if (metaEl) {
      var ago = st.lastPoll ? Math.round((Date.now() - st.lastPoll) / 1000) + 's ago' : 'never';
      metaEl.textContent = 'Cycle #' + st.pollCount +
        '  ·  ' + (st.stats.scanned || 0) + ' combos scanned' +
        '  ·  ' + (st.stats.candidates || 0) + ' candidates' +
        '  ·  last: ' + ago;
    }

    /* Candidate rows */
    if (!wl.length) {
      listEl.innerHTML = '<div class="ee-flag-empty">No candidates yet — waiting for first scan</div>';
    } else {
      listEl.innerHTML = wl.slice(0, 15).map(function (c, i) {
        var dirHtml = c.dir === 'LONG'
          ? '<span style="color:#4fc">▲ LONG</span>'
          : '<span style="color:#f88">▼ SHORT</span>';
        var scoreColor = c.score >= 4 ? '#4fc' : c.score >= 2.5 ? '#fc4' : '#aaa';
        return '<div class="ee-pw-row">' +
          '<span class="ee-pw-asset">' + (i + 1) + '. ' + c.asset + '</span>' +
          '<span class="ee-pw-dir">' + dirHtml + '</span>' +
          '<span class="ee-pw-score" style="color:' + scoreColor + '">' + c.score.toFixed(2) + '</span>' +
          '<span class="ee-pw-agents" style="color:#888">' + c.agentCount + '</span>' +
          '<span class="ee-pw-reason">' + (c.reason || '').substring(0, 60) + '</span>' +
          '</div>';
      }).join('');
    }

    /* Last rotation */
    if (rotEl) {
      var r = rot[0];
      rotEl.textContent = r
        ? 'Last rotation: closed ' + r.closed + ' (' + r.closedScore + ') → ' +
          r.opened + ' (' + r.openScore + ')  Δ' + r.delta
        : 'No rotations yet';
    }
  }

  /* ── Adaptive confirmation tiers ───────────────────────────────────────────
     Specialist agents with high confidence can execute without second confirmation.
     Generalist/geopolitical signals always require corroboration (srcCount >= 2).

     FAST TRACK  — specialist source + conf >= 88%: execute immediately, single-source OK.
                   confMult applies 1.5–1.75× sizing based on confidence level.
     STANDARD    — 2+ sources (srcCount >= 2): full execution.
     BLOCKED     — single source, conf < 88%, non-specialist: blocked as before.

     Source category map: confirms complementarity. If srcCount >= 2 but both sources
     are the same category (e.g. two social-sentiment agents), it counts as 1 category.
     Full cross-category corroboration is the gold standard.                          */
  var SPECIALIST_SOURCES = {
    'forex-fundamentals': 'fundamental',
    'technicals':         'technical',
    'ta-scanner':         'technical',
    'market-obs':         'market-structure',
    'market-observer':    'market-structure',
    'macro-cross':        'macro-cross',
    'macro-events':       'macro-event',
    'crypto-signals':     'on-chain',
    'onchain':            'on-chain',
    'momentum':           'momentum',
    'correlation':        'correlation',
    'cot':                'fundamental',
    'funding-rate':       'on-chain',
    'funding':            'on-chain',
    'smartmoney':         'fundamental',
    'positioning':        'fundamental',
    'opening-bias':       'technical'
  };

  /* ── Asset remap table ─────────────────────────────────────────────────────
     Maps signal asset names that are not directly tradeable to their real-market
     proxies. Applied in onSignals() before any execution logic runs.
     VIX (CBOE Volatility Index) is a spot index — cannot be bought/sold directly.
     VXX (iPath S&P 500 VIX Short-Term Futures ETN) is the standard retail proxy.  */
  var ASSET_REMAP = {
    'VIX':  'VXX'   // volatility index → tradeable VIX ETN
  };

  /* ── Correlation groups — assets within each group are treated as equivalent
     exposure. Only ONE asset per group (in the same direction) can be open at
     a time. Prevents doubling up on WTI + BRENT, BTC + ETH, etc.              */
  var CORR_GROUPS = [
    ['WTI',  'BRENT', 'XLE', 'XOM'],    // oil / energy
    ['GLD',  'XAU'],                     // gold
    ['BTC',  'ETH',  'SOL'],            // crypto
    ['LMT',  'RTX',  'NOC',  'XAR'],   // defense
    ['TSM',  'NVDA', 'SMH',  'ASML'],  // semis
    ['SPY',  'QQQ'],                     // US equities
    ['FXI',  'EEM'],                     // emerging markets
    ['DAL',  'UAL'],                     // airlines
  ];

  /* Returns the correlation group containing `asset`, or null.
     Checks static CORR_GROUPS first, then the dynamic matrix from the
     correlation agent (updated every 5 min from live price history). */
  function _getCorrGroup(asset) {
    var decorrM = window._dynamicDecorrMatrix;

    /* 1. Static group lookup — but filter out peers that have dynamically
          decorrelated (Pearson < 0.30 over recent price history).
          This lets BTC/ETH trade independently on days they genuinely diverge. */
    for (var i = 0; i < CORR_GROUPS.length; i++) {
      if (CORR_GROUPS[i].indexOf(asset) !== -1) {
        if (decorrM && decorrM[asset]) {
          var filtered = CORR_GROUPS[i].filter(function (peer) {
            return peer === asset || !decorrM[asset][peer];
          });
          return filtered.length > 1 ? filtered : null;
        }
        return CORR_GROUPS[i];
      }
    }
    /* 2. Dynamic group lookup — assets not in static groups may still be
          correlated at runtime (e.g. XRP/ETH during a crypto-wide move) */
    var dynMatrix = window._dynamicCorrMatrix;
    if (dynMatrix && dynMatrix[asset]) {
      var dynPeers = Object.keys(dynMatrix[asset]);
      if (dynPeers.length) {
        return [asset].concat(dynPeers);   // synthetic group
      }
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     EXECUTION REALITY CHECKS — cost model, slippage, liquidity, hold-time guard
     All values are conservative estimates based on retail CFD / futures brokers.
     ══════════════════════════════════════════════════════════════════════════════ */

  /* Per-asset-class cost model
     spread:     one-way half-spread as fraction of price (e.g. 0.0002 = 0.02%)
     slippage:   extra fill degradation on market orders (entries + SL exits)
     commission: per-side rate; round-trip = 2× (e.g. 0.0007 = 0.07% per side)
     funding8h:  crypto perpetual funding rate per 8-hour period                */
  var TRADING_COSTS = {
    crypto:   { spread: 0.0008, slippage: 0.0005, commission: 0.0010, funding8h: 0.0001 },
    energy:   { spread: 0.0004, slippage: 0.0003, commission: 0.0007, funding8h: 0      },
    precious: { spread: 0.0002, slippage: 0.0002, commission: 0.0007, funding8h: 0      },
    equity:   { spread: 0.0001, slippage: 0.0001, commission: 0.0005, funding8h: 0      },
    forex:    { spread: 0.0003, slippage: 0.0002, commission: 0.0006, funding8h: 0      },
    def:      { spread: 0.0006, slippage: 0.0004, commission: 0.0008, funding8h: 0      }
  };

  /* Max realistic position notional per asset class (prevents market-moving sizes) */
  var LIQUIDITY_CAPS = {
    crypto:   500000,
    energy:   200000,
    precious:  50000,
    equity:   100000,
    def:       25000
  };

  /* Minimum time a trade must be open before TP/SL can trigger (ms).
     Prevents instant open→close in a single 30s monitor cycle. */
  var MIN_HOLD_MS = 90000;   // 1.5 minutes
  /* Maximum time a geopolitical trade can remain open before auto-expiry.
     Geopolitical events resolve/price-in within days. A trade still open
     after 7 days means the thesis was never invalidated and exit signals
     failed — safer to close stale positions than hold indefinitely.
     Scalper trades use a much tighter 6-hour limit (set per-trade via source). */
  var MAX_HOLD_MS_GEO     = 7 * 24 * 60 * 60 * 1000;  // 7 days
  var MAX_HOLD_MS_SCALPER = 6 * 60 * 60 * 1000;        // 6 hours

  /* Maximum realistic leverage (notional / balance).
     Standard retail CFD/futures cap — resets to this if exceeded. */
  var MAX_LEVERAGE = 20;

  /* Look up cost profile for an asset.
     HL-covered assets use HL perpetual fees (0.05% taker, tighter spreads).
     Non-HL assets fall back to the existing sector-based CFD/futures model.  */
  function _getCosts(asset) {
    // HL fee override: if this asset trades on Hyperliquid, use HL cost model
    // regardless of whether the WS is currently connected (intent is HL trading).
    try {
      if (window.HLFeed && typeof HLFeed.costs === 'function') {
        var _hlCosts = HLFeed.costs(normaliseAsset(asset));
        if (_hlCosts) return _hlCosts;
      }
    } catch (e) { /* HLFeed mid-reconnect — fall through to sector model */ }
    var sector = EE_SECTOR_MAP[normaliseAsset(asset)] || '';
    if (sector === 'crypto')   return TRADING_COSTS.crypto;
    if (sector === 'energy')   return TRADING_COSTS.energy;
    if (sector === 'precious') return TRADING_COSTS.precious;
    if (sector === 'forex')    return TRADING_COSTS.forex;
    if (['equity','defense','semis','airlines','em','ev','battery','metals'].indexOf(sector) !== -1)
      return TRADING_COSTS.equity;
    return TRADING_COSTS.def;
  }

  /* VIX multiplier for slippage: above VIX 20 → wider fills scale linearly.
     VIX 20 → 1.0×, VIX 30 → 1.5×, VIX 40 → 2.0×. Capped at 3.0× for outlier spikes.
     Reads from GII_AGENT_MACRO.status().vix if available; falls back to 1.0. */
  function _vixSlippageMult() {
    try {
      if (window.GII_AGENT_MACRO && typeof GII_AGENT_MACRO.status === 'function') {
        var _vix = GII_AGENT_MACRO.status().vix;
        if (typeof _vix === 'number' && _vix > 0) {
          return Math.min(3.0, Math.max(1.0, _vix / 20));
        }
      }
    } catch (e) {}
    return 1.0;
  }

  /* Adjust entry price for spread (half) + slippage (market order fill degradation).
     LONG buys at ask (higher); SHORT sells at bid (lower).
     Slippage scaled by VIX: high-vol environments produce wider fills. */
  function _adjustedEntryPrice(asset, price, dir) {
    var c      = _getCosts(asset);
    var vixMul = _vixSlippageMult();
    var adj    = c.spread / 2 + c.slippage * vixMul;
    return dir === 'LONG' ? price * (1 + adj) : price * (1 - adj);
  }

  /* Adjust exit price for spread (half) and, for market orders, slippage.
     TP = limit order (spread only — guaranteed fill at limit);
     SL / manual = market order (spread + extra slippage — can gap through).
     LONG sells at bid (lower); SHORT buys back at ask (higher).
     Slippage scaled by VIX on market orders (SL/manual exits). */
  function _adjustedExitPrice(asset, price, dir, reason) {
    var c           = _getCosts(asset);
    var marketOrder = (reason !== 'TAKE_PROFIT');
    var vixMul      = marketOrder ? _vixSlippageMult() : 1.0;
    var adj         = c.spread / 2 + (marketOrder ? c.slippage * vixMul : 0);
    return dir === 'LONG' ? price * (1 - adj) : price * (1 + adj);
  }

  /* Check position notional against liquidity cap; log warning if exceeded */
  // Returns true if position is within liquidity limits, false if it should be rejected.
  // Hard cap: reject if position > 2× the liquidity cap (would cause serious market impact).
  // Soft warning: log if position > 1× cap (oversized but may fill with extra slippage).
  function _checkLiquidity(asset, sizeUsd) {
    var sector = EE_SECTOR_MAP[normaliseAsset(asset)] || 'def';
    var cap    = LIQUIDITY_CAPS[sector] || LIQUIDITY_CAPS.def;
    if (sizeUsd > cap * 2) {
      log('AUDIT', '⛔ LIQUIDITY REJECT: ' + asset + ' position $' + _num(sizeUsd) +
        ' exceeds hard cap $' + _num(cap * 2) + ' — trade blocked (would move market)', 'red');
      return false;
    }
    if (sizeUsd > cap) {
      log('AUDIT', '⚠ LIQUIDITY: ' + asset + ' position $' + _num(sizeUsd) +
        ' exceeds soft cap $' + _num(cap) + ' — expect extra slippage on real exchange', 'amber');
    }
    return true;
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     TRADE OBJECT SCHEMA
     Each trade stored in _trades[] follows this exact structure — designed to be
     read directly by a future bot / broker adapter without transformation.
     ══════════════════════════════════════════════════════════════════════════════
     {
       trade_id:        string   — unique "TRD-xxxx" identifier
       signal_id:       string   — source signal ID (IC-generated or HRS)
       timestamp_open:  ISO8601  — UTC time trade was opened
       asset:           string   — e.g. "WTI Crude Oil", "BTC/USD"
       direction:       string   — "LONG" | "SHORT"
       confidence:      number   — IC confidence 0–100
       entry_price:     number   — price at open
       stop_loss:       number   — absolute price level
       take_profit:     number   — absolute price level
       units:           number   — position size in asset units
       size_usd:        number   — notional USD value of position
       mode:            string   — "SIMULATION" | "LIVE"
       status:          string   — "OPEN" | "CLOSED" | "CANCELLED"
       close_price:     number|null
       timestamp_close: ISO8601|null
       pnl_pct:         number|null  — % P&L from entry
       pnl_usd:         number|null  — USD P&L
       close_reason:    string|null  — "TAKE_PROFIT"|"STOP_LOSS"|"TRAILING_STOP"|"MANUAL"|"EXPIRED"
       price_source:    string   — "HYPERLIQUID" (HL WS live at open) | "SIMULATED" (HTTP fallback)
       region:          string   — geopolitical region that triggered signal
       reason:          string   — human-readable signal reason from IC
       broker:          string   — "SIMULATION" | future broker name
       broker_order_id: string|null  — set by broker adapter on live execution
       broker_status:   string|null  — broker-side order status
     }
     ══════════════════════════════════════════════════════════════════════════════ */

  /* ── State ─────────────────────────────────────────────────────────────────── */
  var _cfg         = {};   // active config (merged DEFAULTS + localStorage)
  var _trades      = [];   // all trades: open + closed
  var _cooldown         = {};   // 'ASSET_DIR' → timestamp of last open (direction-aware)
  var _reversalCooldown = {};   // 'ASSET_DIR' → expiry ms — longer block after opposite-direction SL
  var _log         = [];   // activity log entries
  var _seq         = 0;    // ID sequence counter
  var _livePrice   = {};   // trade_id → most-recently fetched market price
  var _lastSignals = [];   // most recent IC signal batch — used by the re-scan loop
  var _signalLog   = [];   // full history of every IC signal seen (capped at 200)
  var _pnlHistory  = [];   // { ts, balance, event, pnl_usd } balance timeline (capped at 500)
  var _pendingOpen = {};   // asset → true while a fetchPrice is in-flight (prevents duplicate opens)
  var _initialised = false; // reentrancy guard — prevents duplicate intervals if init() called twice
  var _showAllClosed        = false; // UI toggle: show all closed trades vs capped at 25
  var _closedSessionOnly    = true;  // UI toggle: show only this-session closed trades (default: session view)
  var _sessionStartBalance  = null;  // balance at session start — for daily loss limit
  var _lossStreak           = { long: 0, short: 0 };  // v61: per-direction streak — long losses don't penalise short sizing
  var _fillLatencies        = [];   // rolling last-20 signal-to-fill latencies (ms) for Alpaca orders
  var _winStreak            = { long: 0, short: 0 };  // symmetric to _lossStreak — 3 consecutive wins → +15% size
  var _lastPriceTs          = {};  // trade_id → ms of last successful price fetch (stale-price watchdog)
  var _peakEquity           = null;  // highest virtual_balance since session start — drawdown-from-peak guard
  var _ddFromPeak           = 0;     // current % drawdown from peak — read by buildTrade for size scaling
  var _liveBrokerEquity     = null;  // sum of all connected broker equities — polled every 60s, used for sizing
  var _liveBrokerEquityTs   = 0;     // timestamp of last successful equity fetch
  var _liveBrokerSources    = [];    // which brokers contributed to _liveBrokerEquity
  var _halted               = false; // emergency kill switch — blocks all new trade execution when true
  var _wsConnected          = false; // Binance WebSocket status
  var _wsBtcWs              = null;  // WebSocket instance (BTC real-time)
  var _wsBinanceRetries     = 0;     // Fix #17: exponential backoff retry counter
  var _backendPrices        = {};   // symbol → price, populated by _pollBackendPrices() every 25 s (H4)
  var _stalePriceSymbols    = [];   // symbols with stale:true from backend (e.g. futures roll period)
  var _backendPriceInterval = null; // stored so a second _apiInit call can't create a duplicate interval
  var _sessionStart  = null; // ISO timestamp — set on init, reset on analyticsReset/fullReset
  var _initTs        = Date.now(); // page-load time — used for broker startup grace period
  var _lastRegime    = null; // Fix #26: tracks last known MacroRegime to detect transitions
  var _priceFeedHealth = {}; // source → { ok: bool, lastOk: ms, lastFail: ms }

  /* ── Price source maps ──────────────────────────────────────────────────────── */

  // 1. Binance: crypto USDT pairs — public REST, no API key required
  var PRICE_SOURCES = {
    'BTC':   'BTCUSDT',
    'ETH':   'ETHUSDT',
    'BNB':   'BNBUSDT',
    'SOL':   'SOLUSDT',
    'ADA':   'ADAUSDT',
    'DOGE':  'DOGEUSDT',
    'XRP':   'XRPUSDT',
    'AVAX':  'AVAXUSDT',
    'LINK':  'LINKUSDT',
    'DOT':   'DOTUSDT'
  };

  // 2. CoinGecko: tokenised gold — 1 PAXG = 1 troy oz gold (CORS-open, no key)
  // https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd
  var COINGECKO_SOURCES = {
    'XAU':  'pax-gold',    // PAX Gold ≈ spot gold price
    'GOLD': 'pax-gold',
    'PAXG': 'pax-gold',
    'XAUT': 'tether-gold'  // Tether Gold: alternative gold token
  };

  // 3. Yahoo Finance via corsproxy.io: commodities, equities, ETFs
  // corsproxy.io adds CORS headers; Yahoo itself blocks direct browser requests.
  // https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1m&range=1d
  var YAHOO_SOURCES = {
    'WTI':     'CL=F',   // WTI Crude Oil futures
    'CRUDE':   'CL=F',
    'OIL':     'CL=F',
    'BRENT':   'BZ=F',   // Brent Crude futures
    'XAG':     'SI=F',   // Silver futures
    'SILVER':  'SI=F',
    'GAS':     'NG=F',   // Natural Gas futures
    'NATURAL': 'NG=F',   // "Natural Gas" → first token = NATURAL
    'NATGAS':  'NG=F',
    'COPPER':  'HG=F',   // Copper futures
    'GDX':     'GDX',    // VanEck Gold Miners ETF
    'GLD':     'GLD',    // SPDR Gold Shares
    'SLV':     'SLV',    // iShares Silver Trust
    'SPY':     'SPY',
    'QQQ':     'QQQ',
    'DAL':     'DAL',    // Delta Air Lines
    'UAL':     'UAL',    // United Airlines
    'LMT':     'LMT',    // Lockheed Martin
    'RTX':     'RTX',    // Raytheon Technologies
    'NOC':     'NOC',    // Northrop Grumman
    'GD':      'GD',     // General Dynamics
    'BA':      'BA',     // Boeing
    'XAR':     'XAR',    // iShares Aerospace & Defense ETF (emitted by gii-macro)
    'ITA':     'ITA',    // iShares U.S. Aerospace & Defense ETF
    'XOM':     'XOM',    // ExxonMobil
    'CVX':     'CVX',    // Chevron
    'TSM':     'TSM',    // Taiwan Semiconductor
    'NVDA':    'NVDA',
    'AMD':     'AMD',
    'TLT':     'TLT',    // iShares 20+ Year Treasury Bond
    'IEF':     'IEF',    // iShares 7-10 Year Treasury Bond
    'HYG':     'HYG',    // iShares High Yield Corporate Bond
    'DXY':     'DX-Y.NYB', // US Dollar Index
    'WEAT':    'WEAT',   // Teucrium Wheat Fund
    'WHT':     'WEAT',   // "Wheat" shorthand → Teucrium Wheat Fund
    'WHEAT':   'WEAT',
    'CORN':    'CORN',   // Teucrium Corn Fund
    'TSLA':    'TSLA',
    'MSFT':    'MSFT',
    'AAPL':    'AAPL',
    'AMZN':    'AMZN',
    'GOOGL':   'GOOGL',
    'META':    'META',
    'INDA':    'INDA',   // iShares MSCI India ETF
    'EEM':     'EEM',    // iShares MSCI Emerging Markets
    'EWZ':     'EWZ',    // iShares MSCI Brazil
    'EWJ':     'EWJ',    // iShares MSCI Japan
    'LIT':     'LIT',    // Global X Lithium & Battery Tech ETF
    'COPX':    'COPX',   // Global X Copper Miners ETF
    'URA':     'URA',    // Global X Uranium ETF
    'URBN':    'URBN',
    'VIX':     '^VIX',   // kept for price reference only — trades remap to VXX
    'VXX':     'VXX'    // iPath Series B S&P 500 VIX Short-Term Futures ETN (actual tradeable proxy)
  };

  // 4. Frankfurter API: ECB forex rates (CORS-open, no key)
  // https://api.frankfurter.app/latest?base={CURRENCY}&symbols=USD → rates.USD
  var FRANKFURTER_SOURCES = {
    'EUR':    'EUR',  'EURUSD': 'EUR',
    'GBP':    'GBP',  'GBPUSD': 'GBP',
    'CHF':    'CHF',
    'JPY':    'JPY',
    'AUD':    'AUD',
    'CAD':    'CAD',
    'NOK':    'NOK'
  };

  // OANDA rate mapping: Frankfurter base → { OANDA pair key, inverse flag }
  // inverse=true means OANDA stores the pair as USD/BASE, so 1/mid = BASE/USD
  var _OANDA_FX_MAP = {
    'EUR': { key: 'EUR_USD', inverse: false },
    'GBP': { key: 'GBP_USD', inverse: false },
    'AUD': { key: 'AUD_USD', inverse: false },
    'NZD': { key: 'NZD_USD', inverse: false },
    'CHF': { key: 'USD_CHF', inverse: true  },
    'JPY': { key: 'USD_JPY', inverse: true  },
    'CAD': { key: 'USD_CAD', inverse: true  },
  };

  var _priceCache       = {};   // token → last known price (any source)
  var _priceCacheTs     = {};   // token → ms timestamp of last successful fetch
  // Fix #15: unified price-cache TTL constants — three different magic numbers
  // replaced with named constants so any future change is made in one place.
  var _CACHE_TTL           = 15000;          // 15 s — freshness window for _cacheFresh() (monitor cycle)
  var _PRICE_STALE_RESCAN  = 10 * 60 * 1000; // 10 min — skip re-scan signal if price this old
  var _PRICE_STALE_TIMEOUT = 30 * 60 * 1000; // 30 min — force-close open trade if no fresh price
  var _noPriceThrottle  = {};   // asset → ts of last "Price unavailable" siglog entry (1h throttle)

  /* ══════════════════════════════════════════════════════════════════════════════
     PERSISTENCE
     ══════════════════════════════════════════════════════════════════════════════
     Primary store  : SQLite via GeoIntel backend (http://localhost:8765/api/trades)
     Fallback store : localStorage (always written as an immediate backup)

     Strategy:
       1. On init, try API. If online → load from DB (authoritative).
       2. Migrate any localStorage trades not in the DB (one-time, then clear LS).
       3. On openTrade / closeTrade → fire async POST/PATCH to API (fire-and-forget).
       4. localStorage is always written synchronously so the UI works offline.
     ══════════════════════════════════════════════════════════════════════════════ */

  /* ── Config (localStorage only — lightweight, no history needed) ─────────── */

  function loadCfg() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      _cfg = raw ? Object.assign({}, DEFAULTS, JSON.parse(raw)) : Object.assign({}, DEFAULTS);
      if (_cfg._state_version !== STATE_VERSION) {
        console.info('[EE] State version migrating from', _cfg._state_version || 'none', '→', STATE_VERSION);
      }
      _cfg._state_version = STATE_VERSION;
      // H5 fix: migration cap was >10 but DEFAULTS is 15 — any user with a value
      // between 11–100% was silently reset on every load. Changed to only catch the
      // truly invalid old default of 50% (and anything above 100% or below 1%).
      if (_cfg.daily_loss_limit_pct > 100 || _cfg.daily_loss_limit_pct < 1 ||
          _cfg.daily_loss_limit_pct === 50) {
        _cfg.daily_loss_limit_pct = DEFAULTS.daily_loss_limit_pct;
      }
      // floor guards — prevent accidental misconfiguration
      if (_cfg.max_open_trades < 1)  _cfg.max_open_trades = DEFAULTS.max_open_trades;
      if (_cfg.max_per_region  < 1)  _cfg.max_per_region  = DEFAULTS.max_per_region;
      if (_cfg.max_per_sector  < 1)  _cfg.max_per_sector  = DEFAULTS.max_per_sector;
      // audit-v2 migration: disable crude trailing stop — gii-exit progressive trail owns this now
      _cfg.trailing_stop_enabled = false;
      // threshold floored at 50 to prevent accidental misconfiguration
      if (_cfg.min_confidence < 50) {
        _cfg.min_confidence = DEFAULTS.min_confidence;
      }
      // Restore kill switch state — prevents a page refresh from silently re-enabling trading
      try { _halted = localStorage.getItem(HALT_KEY) === 'true'; } catch(e2) {}
    } catch (e) {
      console.error('[EE] ⚠ Config load FAILED — localStorage corrupt or missing. ' +
        'Reverting to DEFAULTS. All risk limits reset to factory values. ' +
        'Re-configure before live trading.', e);
      _cfg = Object.assign({}, DEFAULTS);
    }
  }

  function saveCfg() {
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(_cfg));
    } catch (e) {
      console.warn('[EE] saveCfg FAILED — config not persisted (storage full or unavailable). ' +
                   'Risk params, cooldowns and balance may revert on reload.', e);
    }
    // Smart Improvement 2: mirror config to backend so it survives Chrome crashes/localStorage wipes
    if (_apiOnline) {
      _apiFetch('/api/config', { method: 'POST', body: JSON.stringify(_cfg) }).catch(function () {});
    }
  }

  /* ── Trades — synchronous localStorage (immediate) ───────────────────────── */

  function loadTrades() {
    try {
      var raw = localStorage.getItem(TRADES_KEY);
      // Legacy migration intentionally removed — DB is the sole source of truth.
      // Old keys (geodash_ee_trades, geodash_ee_trades_v0) are ignored.
      if (raw) {
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('trades not array');
        _trades = parsed;
      } else {
        _trades = [];
      }
    } catch (e) { _trades = []; }
  }

  function saveTrades() {
    // v60: in-memory soft cap — keep ALL open trades + last 500 closed.
    // Full history is always safe in localStorage and the Render SQLite backend.
    var open   = _trades.filter(function (t) { return t.status === 'OPEN'; });
    var closed = _trades.filter(function (t) { return t.status !== 'OPEN'; });
    if (closed.length > 500) {
      closed = closed.slice(-500);   // keep most-recent 500 closed
      _trades = open.concat(closed);
    }
    try {
      localStorage.setItem(TRADES_KEY, JSON.stringify(_trades));
    } catch (e) {
      // QuotaExceededError: browser storage is full — warn the user visibly
      var isQuota = e && (e.name === 'QuotaExceededError' ||
                          e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
                          e.code === 22 || e.code === 1014);
      if (isQuota) {
        log('ERROR', 'localStorage FULL — trades not saved locally. Export now!', 'red');
        var banner = document.getElementById('eeDataSafetyBanner');
        if (banner) {
          banner.style.display = 'block';
          banner.innerHTML =
            '<span style="color:#e84040;font-weight:bold">&#9888; STORAGE FULL</span>' +
            '<span style="color:var(--dim);margin-left:8px">Browser storage is full — new trades are NOT being saved locally.</span>' +
            '<button onclick="EE.exportJSON()" style="margin-left:10px;padding:2px 10px;background:#e84040;color:#fff;border:none;font-family:inherit;font-size:10px;font-weight:bold;cursor:pointer">&#8595; EXPORT NOW</button>';
        }
      }
    }
  }

  /* ── Signal log (localStorage only) ────────────────────────────────────────── */

  function loadSigLog() {
    try {
      var raw = localStorage.getItem(SIGLOG_KEY);
      _signalLog = raw ? JSON.parse(raw) : [];
    } catch (e) { _signalLog = []; }
  }

  function saveSigLog() {
    try {
      localStorage.setItem(SIGLOG_KEY, JSON.stringify(_signalLog));
    } catch (e) {
      console.warn('[EE] saveSigLog FAILED — signal history not persisted.', e);
    }
  }

  /* ── P&L History (localStorage) ─────────────────────────────────────────── */

  function loadPnlHistory() {
    try {
      var raw = localStorage.getItem(PNL_HISTORY_KEY);
      _pnlHistory = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(_pnlHistory)) _pnlHistory = [];
    } catch (e) { _pnlHistory = []; }
  }

  function savePnlHistory() {
    try {
      localStorage.setItem(PNL_HISTORY_KEY, JSON.stringify(_pnlHistory));
    } catch (e) {
      console.warn('[EE] savePnlHistory FAILED — P&L history not persisted.', e);
    }
  }

  function _recordPnlSnapshot(event, pnl_usd) {
    _pnlHistory.push({
      ts:      Date.now(),
      balance: _cfg.virtual_balance,
      event:   event || 'unknown',
      pnl_usd: pnl_usd || 0
    });
    if (_pnlHistory.length > 500) _pnlHistory = _pnlHistory.slice(-500);
    savePnlHistory();
  }

  /* ── Backup — snapshot state before destructive operations ──────────────── */

  function _createBackup() {
    try {
      var ts  = Date.now();
      var bak = {
        version:    STATE_VERSION,
        created:    new Date().toISOString(),
        cfg:        JSON.stringify(_cfg),
        trades:     JSON.stringify(_trades),
        sigLog:     JSON.stringify(_signalLog.slice(0, 50)),
        pnlHistory: JSON.stringify(_pnlHistory)
      };
      localStorage.setItem('geodash_backup_' + ts, JSON.stringify(bak));
      // Keep only the 3 most recent backups to stay within quota
      var bkeys = Object.keys(localStorage)
        .filter(function (k) { return k.indexOf('geodash_backup_') === 0; })
        .sort();
      while (bkeys.length > 3) { try { localStorage.removeItem(bkeys.shift()); } catch(e) {} }
      return ts;
    } catch (e) { return null; }
  }

  /* ── API helpers (async, fire-and-forget) ────────────────────────────────── */

  function _apiFetch(path, opts) {
    return fetch(_API_BASE + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  }

  /* ── Backend write retry queue (Fix 6) ─────────────────────────────────────
     If the backend is offline or a write fails, operations are queued and
     retried automatically when the connection comes back. Queue survives
     page reloads via localStorage.                                             */
  var _WRITE_QUEUE_KEY = 'geodash_write_queue_v1';
  var _writeQueue      = [];   // [{ op: 'POST'|'PATCH', tradeId, data, ts }]
  var _writeQueueBusy  = false;

  function _loadWriteQueue() {
    try {
      var raw = localStorage.getItem(_WRITE_QUEUE_KEY);
      _writeQueue = raw ? JSON.parse(raw) : [];
    } catch (e) { _writeQueue = []; }
  }

  function _saveWriteQueue() {
    try { localStorage.setItem(_WRITE_QUEUE_KEY, JSON.stringify(_writeQueue)); } catch (e) {}
  }

  function _enqueue(op, tradeId, data) {
    // Deduplicate: if a PATCH for same tradeId already queued, merge updates
    if (op === 'PATCH') {
      var existing = _writeQueue.find(function (q) { return q.op === 'PATCH' && q.tradeId === tradeId; });
      if (existing) { Object.assign(existing.data, data); _saveWriteQueue(); return; }
    }
    _writeQueue.push({ op: op, tradeId: tradeId, data: data, ts: Date.now() });
    _saveWriteQueue();
  }

  function _flushWriteQueue() {
    if (_writeQueueBusy || !_apiOnline || !_writeQueue.length) return;
    _writeQueueBusy = true;
    var item = _writeQueue[0];
    var url  = item.op === 'POST'
      ? '/api/trades'
      : '/api/trades/' + encodeURIComponent(item.tradeId);
    _apiFetch(url, { method: item.op, body: JSON.stringify(item.data) })
      .then(function (r) {
        // H3 fix: HTTP 5xx resolves (not rejects) — must check r.ok.
        // On 4xx (stale/deleted trade): discard silently (it's a stale operation).
        // On 5xx: keep item in queue and retry on next flush.
        if (!r.ok) {
          if (r.status >= 400 && r.status < 500) {
            log('SYSTEM', 'Write queue: ' + item.op + ' ' + item.tradeId + ' → ' + r.status + ' (stale, discarding)', 'dim');
            _writeQueue.shift(); // discard 4xx
          } else {
            log('SYSTEM', 'Write queue: ' + item.op + ' ' + item.tradeId + ' → ' + r.status + ' (server error, will retry)', 'amber');
            // keep item for retry
          }
          _saveWriteQueue();
          _writeQueueBusy = false;
          if (_writeQueue.length) setTimeout(_flushWriteQueue, 2000); // back off on error
          return;
        }
        _writeQueue.shift();
        _saveWriteQueue();
        _writeQueueBusy = false;
        if (_writeQueue.length) setTimeout(_flushWriteQueue, 200);
        else log('SYSTEM', 'Backend write queue flushed ✓', 'dim');
      })
      .catch(function () {
        _writeQueueBusy = false;
        // Will retry next time _flushWriteQueue() is called (on reconnect or next write)
      });
  }

  /* POST a single trade to the API — queued on failure */
  function _apiPostTrade(trade) {
    if (!_apiOnline) { _enqueue('POST', trade.trade_id, trade); return; }
    _apiFetch('/api/trades', { method: 'POST', body: JSON.stringify(trade) })
      .then(function () { _flushWriteQueue(); })   // drain any queued items too
      .catch(function (e) {
        log('SYSTEM', '⚠ Backend sync failed — trade ' + trade.trade_id + ' queued for retry. '
          + '(' + (e && e.message ? e.message : 'network error') + ')', 'amber');
        _enqueue('POST', trade.trade_id, trade);
        setTimeout(function () {
          _apiFetch('/api/status').then(function (r) { if (r.ok) { _apiOnline = true; _flushWriteQueue(); } }).catch(function () {});
        }, 15000);
      });
  }

  /* PATCH an existing trade in the API — queued on failure */
  function _apiPatchTrade(tradeId, updates) {
    if (!_apiOnline) { _enqueue('PATCH', tradeId, updates); return; }
    _apiFetch('/api/trades/' + encodeURIComponent(tradeId), {
      method: 'PATCH',
      body:   JSON.stringify(updates)
    })
      .then(function () { _flushWriteQueue(); })
      .catch(function (e) {
        log('SYSTEM', '⚠ Backend sync failed — trade update ' + tradeId + ' queued for retry. '
          + '(' + (e && e.message ? e.message : 'network error') + ')', 'amber');
        _enqueue('PATCH', tradeId, updates);
        setTimeout(function () {
          _apiFetch('/api/status').then(function (r) { if (r.ok) { _apiOnline = true; _flushWriteQueue(); } }).catch(function () {});
        }, 15000);
      });
  }

  /* ── Resume Alpaca fill polling for trades that survived a page reload ───────
     If the page reloads while an Alpaca order is mid-flight (PENDING_FILL),
     the poll loop is lost. This re-attaches the callbacks so the trade still
     lands as FILLED (or gets closed on timeout/cancel) after reload.           */
  function _resumeAlpacaPolling(trade) {
    if (!window.AlpacaBroker || !AlpacaBroker.isConnected()) return;
    AlpacaBroker.resumeOrderPoll(
      trade.broker_order_id,
      /* onFill */ function (fillPrice, order) {
        trade.broker_status     = 'FILLED';
        trade.broker_fill_price = fillPrice;
        if (fillPrice > 0) trade.entry_price = fillPrice;
        saveTrades();
        _apiPatchTrade(trade.trade_id, {
          broker_status: 'FILLED',
          broker_fill_price: fillPrice,
          entry_price: trade.entry_price
        });
        log('ALPACA', trade.asset + ' FILLED @ $' + fillPrice.toFixed(4) +
          ' (resumed poll, order ' + order.id + ')', 'green');
        renderUI();
      },
      /* onFail */ function (reason) {
        trade.broker_status   = 'REJECTED';
        trade.broker_error    = 'Order ' + reason + ' (detected on reload)';
        trade.status          = 'CLOSED';
        trade.close_reason    = 'BROKER_REJECTED';
        trade.timestamp_close = new Date().toISOString();
        _cfg.virtual_balance += (trade.open_commission || 0);
        saveTrades();
        saveCfg();
        _apiPatchTrade(trade.trade_id, {
          status: 'CLOSED', close_reason: 'BROKER_REJECTED',
          broker_error: trade.broker_error, timestamp_close: trade.timestamp_close
        });
        log('ALPACA', '⚠ Order ' + reason + ' for ' + trade.asset +
          ' (detected on reload) — trade closed, commission refunded.', 'red');
        renderUI();
      }
    );
    log('ALPACA', 'Resumed fill poll for ' + trade.asset + ' order ' + trade.broker_order_id, 'dim');
  }

  /* ── API startup: check online, load DB trades, migrate localStorage ──────── */

  function _apiInit(retryCount) {
    retryCount = retryCount || 0;
    var RETRY_DELAYS = [2000, 4000, 8000];   // backoff: 2s, 4s, 8s then give up

    _apiFetch('/api/status')
      .then(function (r) {
        if (!r.ok) throw new Error('status ' + r.status);
        _apiOnline = true;
        _backendChecked = true;
        _pollBackendPrices();
        if (!_backendPriceInterval) {
          _backendPriceInterval = setInterval(_pollBackendPrices, 25000);
        }
        // Smart Improvement 2: if localStorage config was wiped (e.g. Chrome crash),
        // restore it from the backend's saved copy before loading trades.
        var lsCfgRaw = localStorage.getItem(CFG_KEY);
        // C5 fix: JSON.parse can throw if localStorage was corrupted (e.g. partial write
        // during storage-full condition). Catch and treat as missing so the backend restore
        // path fires instead of crashing _apiInit and leaving backendChecked=false forever.
        var lsCfg = null;
        try { lsCfg = lsCfgRaw ? JSON.parse(lsCfgRaw) : null; }
        catch (e) { log('SYSTEM', 'localStorage config corrupted — restoring from backend', 'amber'); }
        var cfgFetch = (!lsCfg || !lsCfg.mode)
          ? _apiFetch('/api/config').then(function (cr) {
              return cr.json().then(function (saved) {
                if (saved && saved.mode) {
                  _cfg = Object.assign({}, DEFAULTS, saved);
                  localStorage.setItem(CFG_KEY, JSON.stringify(_cfg));
                  log('CONFIG', 'Risk settings restored from backend after localStorage wipe ✓', 'green');
                }
              }).catch(function () {});
            }).catch(function () {})
          : Promise.resolve();

        // Flush any write queue that survived a reload
        _loadWriteQueue();
        setTimeout(_flushWriteQueue, 3000);

        return cfgFetch.then(function () { return _apiFetch('/api/trades'); });
      })
      .then(function (r) {
        // H2 fix: guard against malformed JSON from backend (e.g. maintenance page returning
        // HTML as a 200). Without this, r.json() throws, the catch marks backend offline,
        // even though the status check succeeded — causing a false offline state.
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json().catch(function () { return { trades: [] }; });
      })
      .then(function (data) {
        var dbTrades = data.trades || [];

        // Rescue any OPEN trades from localStorage that aren't in the DB.
        // These are trades that were opened while the backend was offline and
        // never synced. Without this merge they'd be silently lost on reload.
        var lsTrades = [];
        try {
          var _lsRaw = localStorage.getItem(TRADES_KEY);
          lsTrades = _lsRaw ? JSON.parse(_lsRaw) : [];
          if (!Array.isArray(lsTrades)) lsTrades = Object.values(lsTrades);
        } catch(e) {}
        var _dbIds = new Set(dbTrades.map(function(t) { return t.trade_id; }));
        var _lsOnlyOpen = lsTrades.filter(function(t) {
          return t.status === 'OPEN' && t.trade_id && !_dbIds.has(t.trade_id);
        });
        if (_lsOnlyOpen.length) {
          log('SYSTEM', _lsOnlyOpen.length + ' open trade(s) rescued from localStorage — syncing to DB', 'amber');
          _lsOnlyOpen.forEach(function(t) { _apiPostTrade(t); });
        }

        dbTrades.sort(function (a, b) {
          return new Date(b.timestamp_open) - new Date(a.timestamp_open);
        });
        _trades = dbTrades.concat(_lsOnlyOpen);

        // Resume fill polling for any Alpaca trades stuck in PENDING_FILL
        // (e.g. page was reloaded while an order was mid-flight)
        var _pendingFill = _trades.filter(function (t) {
          return t.status === 'OPEN' &&
                 t.broker_status === 'PENDING_FILL' &&
                 t.broker_order_id &&
                 t.venue === 'ALPACA';
        });
        // T1-B: auto-purge phantom trades on startup — OPEN trades with no broker_status
        // that are >5 min old. These are positions that opened while no broker was connected
        // and were never sent. They block asset slots and corrupt analytics indefinitely.
        var _phantomCutoff = Date.now() - 300000;
        _trades.forEach(function (t) {
          if (t.status === 'OPEN' && !t.broker_status &&
              new Date(t.timestamp_open).getTime() < _phantomCutoff) {
            log('SYSTEM', t.asset + ' phantom trade purged on startup (no broker fill, >5min old)', 'amber');
            closeTrade(t.trade_id, t.entry_price || 0.01, 'PHANTOM-PURGE');
          }
        });

        if (_pendingFill.length) {
          // Fix 7: event-driven resume — poll until AlpacaBroker is connected
          // rather than a fixed 6s guess that breaks if auth takes longer.
          var _fillRetries = 0;
          function _waitAndResumeFills() {
            if (window.AlpacaBroker && AlpacaBroker.isConnected()) {
              _pendingFill.forEach(function (t) { _resumeAlpacaPolling(t); });
              log('ALPACA', _pendingFill.length + ' pending fill(s) resumed after reload', 'amber');
            } else if (_fillRetries < 20) {  // give up after ~40s
              _fillRetries++;
              setTimeout(_waitAndResumeFills, 2000);
            } else {
              log('ALPACA', '⚠ Could not resume ' + _pendingFill.length + ' pending fill(s) — Alpaca not reconnecting. Check API key.', 'red');
            }
          }
          setTimeout(_waitAndResumeFills, 1000);
        }

        saveTrades();
        renderUI();
        log('SYSTEM', 'SQLite backend online — ' + dbTrades.length + ' trade(s) loaded from DB' +
          (_lsOnlyOpen.length ? ', ' + _lsOnlyOpen.length + ' rescued from localStorage' : ''), 'green');
      })
      .catch(function (err) {
        _apiOnline = false;
        // A3: stop the price-poll interval if it was started by /api/status success
        // but the trades fetch (or config fetch) subsequently failed — otherwise the
        // engine stays in a degraded state: online=false but polling indefinitely.
        if (_backendPriceInterval) {
          clearInterval(_backendPriceInterval);
          _backendPriceInterval = null;
        }
        if (retryCount < RETRY_DELAYS.length) {
          var delay = RETRY_DELAYS[retryCount];
          log('SYSTEM', 'Backend unreachable — retrying in ' + (delay / 1000) + 's (attempt ' + (retryCount + 1) + '/' + RETRY_DELAYS.length + ')', 'dim');
          setTimeout(function () { _apiInit(retryCount + 1); }, delay);
        } else {
          _backendChecked = true;
          log('SYSTEM', 'SQLite backend offline — using localStorage only', 'dim');
          renderUI(); // refresh banner
        }
      });
  }

  /* H4 — Poll backend /api/market and cache prices in _backendPrices.
     Runs every 25 s while backend is online. Gives fetchPrice() a privacy-safe
     step-0 source that avoids corsproxy.io for all backend-tracked symbols.     */
  function _pollBackendPrices() {
    if (!_apiOnline) return;
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var tid = controller ? setTimeout(function () { controller.abort(); }, 5000) : null;
    _apiFetch('/api/market', controller ? { signal: controller.signal } : {})
      .then(function (r) {
        clearTimeout(tid);
        // F28 fix: guard r.ok before parsing — a maintenance page or 5xx returning
        // HTML as 200 would throw in r.json() and fall into the catch below, leaving
        // _stalePriceSymbols stale indefinitely. Also clears stale badge on bad response.
        if (!r.ok) { _stalePriceSymbols = []; return null; }
        return r.json().catch(function () { _stalePriceSymbols = []; return null; });
      })
      .then(function (data) {
        if (!data) return; // bad response handled above
        var staleNow = [];
        Object.keys(data).forEach(function (sym) {
          var entry = data[sym];
          if (entry && typeof entry.price === 'number' && entry.price > 0) {
            _backendPrices[sym] = entry.price;
            if (entry.stale) staleNow.push(sym);
          }
        });
        _stalePriceSymbols = staleNow;
        /* Update stale-price badge in EE header */
        var _staleBadge = document.getElementById('eeStaleDataBadge');
        if (_staleBadge) {
          if (staleNow.length) {
            _staleBadge.textContent = 'STALE: ' + staleNow.join(', ');
            _staleBadge.style.display = '';
          } else {
            _staleBadge.style.display = 'none';
          }
        }
      })
      .catch(function () { clearTimeout(tid); });   // silent — fetchPrice falls through to other sources

    // v60: prune stale _priceCache entries (older than 5 min) to prevent unbounded growth
    var _PRUNE_AGE = 300000;
    var _now = Date.now();
    Object.keys(_priceCacheTs).forEach(function (tok) {
      if (_now - _priceCacheTs[tok] > _PRUNE_AGE) {
        delete _priceCache[tok];
        delete _priceCacheTs[tok];
      }
    });
  }

  /* Record one signal event — action: 'TRADED' | 'SKIPPED' | 'WATCH' */
  function _logSignal(sig, action, skipReason) {
    // Throttle "Price unavailable" skips to one entry per asset per hour.
    // Assets like SOXX/SMH/XLE that never have a price feed would otherwise
    // consume all 200 siglog slots with identical SKIPPED entries each cycle.
    if (skipReason && skipReason.indexOf('Price unavailable') !== -1) {
      var _throttleKey = sig.asset || '__unknown__';
      var _lastLogged  = _noPriceThrottle[_throttleKey] || 0;
      if (Date.now() - _lastLogged < 3600000) return;  // skip — already logged within 1h
      _noPriceThrottle[_throttleKey] = Date.now();
    }
    _signalLog.unshift({
      ts:          new Date().toISOString(),
      asset:       sig.asset  || '—',
      dir:         sig.dir    || '—',
      conf:        sig.conf   || 0,
      reason:      sig.reason || '',
      region:      sig.region || '—',
      action:      action,
      skip_reason: skipReason || null
    });
    var _maxLog = _cfg.max_siglog || 200;
    if (_signalLog.length > _maxLog) _signalLog.length = _maxLog;  // cap (configurable via max_siglog)
    saveSigLog();
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     PRICE FETCHING
     Waterfall — all paths fire cb(price|null), never throw.

       API coverage (all confirmed CORS-open from browser):
         Binance      → crypto: BTC, ETH, SOL, …
         CoinGecko    → gold: XAU/GOLD (via PAX Gold token 1 PAXG ≈ 1 troy oz)
         corsproxy.io → commodities, stocks, ETFs via Yahoo Finance charts
                        WTI/Brent oil, Silver, Nat-Gas, DAL, LMT, GDX, SPY, …
         Frankfurter  → forex spot: EUR/USD, GBP/USD, …
         Ticker scrape→ any price already shown in the dashboard ticker bar
         Cache        → last-known price from any prior source

       CORS situation (as of March 2026):
         Yahoo Finance directly = CORS-blocked  ✗
         metals.live directly  = CORS-blocked  ✗
         Stooq directly        = CORS-blocked  ✗
         Binance               = CORS-open     ✓
         CoinGecko             = CORS-open     ✓
         corsproxy.io (proxy)  = CORS-open     ✓
         Frankfurter           = CORS-open     ✓
     ══════════════════════════════════════════════════════════════════════════════ */

  /* CORS proxy list — tried in order if primary fails.
     corsproxy.io: fast, reliable, but single point of failure.
     allorigins.win/raw: independent backup, same raw-content interface. */
  var _CORS_PROXIES = [
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url='
  ];
  var _CORS_PROXY      = _CORS_PROXIES[0];   // kept for any other usages
  var _proxyHealth     = {};   // proxy url → { ok: bool, fails: number, lastCheck: ms }
  var _activeProxyIdx  = 0;   // index into _CORS_PROXIES of currently preferred proxy

  /* Proxy health monitor (Smart Improvement 3) — pings each proxy every 5 min
     with a known-safe Yahoo URL and rotates to a healthy one automatically.    */
  function _checkProxyHealth() {
    var testUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1m&range=1d';
    _CORS_PROXIES.forEach(function (proxy, idx) {
      fetch(proxy + encodeURIComponent(testUrl), { signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function (d) {
          var ok = !!(d && d.chart && d.chart.result && d.chart.result[0]);
          _proxyHealth[proxy] = { ok: ok, fails: ok ? 0 : (_proxyHealth[proxy] || {}).fails + 1, lastCheck: Date.now() };
          if (!ok && idx === _activeProxyIdx) _rotateProxy();
        })
        .catch(function () {
          _proxyHealth[proxy] = { ok: false, fails: ((_proxyHealth[proxy] || {}).fails || 0) + 1, lastCheck: Date.now() };
          if (idx === _activeProxyIdx) _rotateProxy();
        });
    });
  }

  function _rotateProxy() {
    for (var i = 0; i < _CORS_PROXIES.length; i++) {
      var candidate = _CORS_PROXIES[i];
      if ((_proxyHealth[candidate] || {}).ok !== false) {
        if (i !== _activeProxyIdx) {
          _activeProxyIdx = i;
          _CORS_PROXY = _CORS_PROXIES[i];
          log('SYSTEM', 'CORS proxy rotated → ' + _CORS_PROXIES[i].split('?')[0], 'amber');
        }
        return;
      }
    }
  }

  setInterval(_checkProxyHealth, 5 * 60 * 1000);
  setTimeout(_checkProxyHealth, 20000);   // first check 20s after load

  function normaliseAsset(asset) {
    // "WTI Crude Oil"→"WTI",  "BTC/USD"→"BTC",  "GDX (Gold Miners)"→"GDX"
    // Known multi-word aliases: "NATURAL GAS" was incorrectly → "NATURAL" (not "GAS").
    // Check full-string alias table before falling through to first-token logic.
    var MULTI_WORD_ALIASES = {
      'NATURAL GAS':  'GAS',   'NAT GAS':      'GAS',
      'CRUDE OIL':    'WTI',   'US OIL':       'WTI',   'LIGHT CRUDE':  'WTI',
      'BRENT CRUDE':  'BRENT', 'BRENT OIL':    'BRENT',
      'GOLD':         'XAU',   'SPOT GOLD':    'XAU',
      'SILVER':       'SLV',   'SPOT SILVER':  'SLV',
      'S&P 500':      'SPY',   'S&P500':       'SPY',   'SP500':        'SPY',
      'NASDAQ':       'QQQ',   'NASDAQ 100':   'QQQ',   'NASDAQ100':    'QQQ',
      'DOW JONES':    'DIA',   'DOW':          'DIA',
      'BITCOIN':      'BTC',   'ETHEREUM':     'ETH',
      'JAPANESE YEN': 'JPY',   'SWISS FRANC':  'CHF',
      /* Forex pairs — slash/space variants → canonical 6-char EE name */
      'EUR/USD': 'EURUSD',  'EUR USD': 'EURUSD',
      'GBP/USD': 'GBPUSD',  'GBP USD': 'GBPUSD',
      'USD/JPY': 'USDJPY',  'USD JPY': 'USDJPY',
      'USD/CHF': 'USDCHF',  'USD CHF': 'USDCHF',
      'AUD/USD': 'AUDUSD',  'AUD USD': 'AUDUSD',
      'USD/CAD': 'USDCAD',  'USD CAD': 'USDCAD',
      'NZD/USD': 'NZDUSD',  'NZD USD': 'NZDUSD',
      'GBP/JPY': 'GBPJPY',  'EUR/JPY': 'EURJPY',
      'EUR/GBP': 'EURGBP',  'EUR/CAD': 'EURCAD',
      'EUR/CHF': 'EURCHF',  'AUD/JPY': 'AUDJPY'
    };
    var up = String(asset || '').toUpperCase().trim();
    if (MULTI_WORD_ALIASES[up]) return MULTI_WORD_ALIASES[up];
    return up.replace(/[^A-Z0-9]/g, ' ').trim().split(' ')[0];
  }

  function _cacheSet(token, price) {
    _priceCache[token]   = price;
    _priceCacheTs[token] = Date.now();
  }

  function _cacheFresh(token) {
    return _priceCacheTs[token] && (Date.now() - _priceCacheTs[token]) < _CACHE_TTL;
  }

  /* Scrape the on-page live ticker for a price — used as a reliable fallback
     when external APIs (Yahoo/CoinGecko) fail due to CORS or rate limits.
     Handles aliases: GLD→GOLD, XAG→SILVER, OIL→WTI so tickers with
     different names are still matched. */
  // Note: GLD is intentionally excluded — GLD is the SPDR ETF (~1/10 oz gold), NOT spot gold.
  // If Yahoo Finance fails, returning the dashboard's spot GOLD price (10× higher) would corrupt
  // position sizing. Better to return null (skip trade) than trade at 10× the wrong price.
  var _TICKER_ALIASES = { 'XAU':'GOLD', 'XAG':'SILVER', 'SLV':'SILVER', 'OIL':'WTI', 'CRUDE':'WTI', 'BRENT':'OIL', 'GAS':'NATGAS' };
  function _tickerPrice(token) {
    var searches = [token];
    if (_TICKER_ALIASES[token]) searches.push(_TICKER_ALIASES[token]);
    var found = null;
    var els = document.querySelectorAll('.tick-item');
    els.forEach(function (el) {
      if (found) return;
      var txt = (el.textContent || '').toUpperCase();
      for (var i = 0; i < searches.length; i++) {
        if (txt.indexOf(searches[i]) !== -1) {
          var m = txt.match(/\$([\d,]+\.?\d*)/);
          if (m) { found = parseFloat(m[1].replace(/,/g, '')); break; }
        }
      }
    });
    return found;
  }

  /* Gold via CoinGecko PAX Gold (1 PAXG = 1 troy oz, price tracks spot) */
  function _fetchCoinGecko(token, coinId, cb) {
    if (_cacheFresh(token)) { cb(_priceCache[token] || null); return; }
    var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' +
              encodeURIComponent(coinId) + '&vs_currencies=usd';
    fetch(url)
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (data) {
        var price = data && data[coinId] && parseFloat(data[coinId].usd);
        if (!isNaN(price) && price > 0) {
          var isFirst = !_priceCache[token];
          _cacheSet(token, price);
          if (isFirst) log('PRICE', 'CoinGecko → ' + token + ' $' + price.toFixed(2) +
                           ' (via ' + coinId + ')', 'dim');
        }
        cb(!isNaN(price) && price > 0 ? price : (_priceCache[token] || null));
      })
      .catch(function () {
        var tp = _tickerPrice(token);
        if (tp) { _cacheSet(token, tp); cb(tp); return; }
        cb(_priceCache[token] || null);
      });
  }

  /* Yahoo Finance chart API — tries each CORS proxy in sequence on failure */
  function _fetchYahoo(token, sym, cb) {
    if (_cacheFresh(token)) { cb(_priceCache[token] || null); return; }
    var yahooUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                   encodeURIComponent(sym) + '?interval=1m&range=1d';
    var proxyIdx = 0;

    function tryProxy() {
      if (proxyIdx >= _CORS_PROXIES.length) {
        // All proxies failed — fall back to on-page ticker then cache
        var tp = _tickerPrice(token);
        if (tp) {
          _cacheSet(token, tp);
          log('PRICE', 'Ticker fallback → ' + token + ' $' + tp.toFixed(2) + ' (Yahoo unavailable)', 'dim');
          cb(tp);
          return;
        }
        if (_priceCache[token]) {
          log('PRICE', 'Cache fallback → ' + token + ' $' + _priceCache[token].toFixed(2) + ' (stale)', 'dim');
        }
        cb(_priceCache[token] || null);
        return;
      }
      var proxy = _CORS_PROXIES[proxyIdx++];
      fetch(proxy + encodeURIComponent(yahooUrl))
        .then(function (r) { if (!r.ok) throw 0; return r.json(); })
        .then(function (data) {
          var meta  = data && data.chart && data.chart.result &&
                      data.chart.result[0] && data.chart.result[0].meta;
          var price = meta ? parseFloat(meta.regularMarketPrice) : NaN;
          if (!isNaN(price) && price > 0) {
            var isFirst = !_priceCache[token];
            _cacheSet(token, price);
            if (isFirst) log('PRICE', 'Yahoo → ' + sym + ' $' + price.toFixed(2), 'dim');
            cb(price);
          } else {
            tryProxy();   // try next proxy — bad data
          }
        })
        .catch(function () { tryProxy(); });   // try next proxy — network error
    }
    tryProxy();
  }

  /* Frankfurter API — ECB-sourced forex spot rates, no API key needed.
     If OANDA Rates agent is connected, use its real-time prices instead
     and skip Frankfurter entirely (OANDA is ~30s fresh vs ECB once-daily). */
  function _fetchFrankfurter(token, base, cb) {
    if (_cacheFresh(token)) { cb(_priceCache[token] || null); return; }

    // ── OANDA path (real-time, 30s refresh) ────────────────────────────────
    if (window.OANDA_RATES && OANDA_RATES.isConnected()) {
      var fxInfo = _OANDA_FX_MAP[base];
      if (fxInfo) {
        var oRate = OANDA_RATES.getRate(fxInfo.key);
        if (oRate && oRate.mid > 0) {
          var oPrice = fxInfo.inverse ? (1 / oRate.mid) : oRate.mid;
          var isFirstO = !_priceCache[token];
          _cacheSet(token, oPrice);
          if (isFirstO) log('PRICE', 'OANDA → ' + base + '/USD ' + oPrice.toFixed(base === 'JPY' ? 6 : 4), 'dim');
          cb(oPrice);
          return;
        }
      }
    }

    // ── Frankfurter fallback (ECB once-daily) ───────────────────────────────
    fetch('https://api.frankfurter.app/latest?base=' + base + '&symbols=USD')
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (data) {
        var price = data && data.rates && parseFloat(data.rates.USD);
        if (!isNaN(price) && price > 0) {
          var isFirst = !_priceCache[token];
          _cacheSet(token, price);
          if (isFirst) log('PRICE', 'Frankfurter → ' + base + '/USD ' + price.toFixed(4), 'dim');
        }
        cb(!isNaN(price) && price > 0 ? price : (_priceCache[token] || null));
      })
      .catch(function () { cb(_priceCache[token] || null); });
  }

  /* Main entry point — routes to correct source, falls through to cache */
  function fetchPrice(asset, cb) {
    var token = normaliseAsset(asset);

    function _feedOk(src)   { _priceFeedHealth[src] = { ok: true,  lastOk:   Date.now(), lastFail: (_priceFeedHealth[src]||{}).lastFail||null }; }
    function _feedFail(src) { _priceFeedHealth[src] = { ok: false, lastOk:   (_priceFeedHealth[src]||{}).lastOk||null, lastFail: Date.now() }; }

    // -1. Hyperliquid WebSocket — real-time prices, highest priority when connected.
    //     HL streams allMids for 300+ pairs incl. WTI, Brent, Gold, BTC, equities.
    //     Only used when the price is fresh (< 30s), meaning the WS is actively streaming.
    //     Falls through to the backend/HTTP chain if WS is down or asset not on HL.
    if (window.HLFeed && typeof HLFeed.getPrice === 'function') {
      var _hlr = HLFeed.getPrice(token);
      if (_hlr && _hlr.fresh) {
        _cacheSet(token, _hlr.price);
        _priceFeedHealth['hl'] = { ok: true, lastOk: Date.now(),
          lastFail: (_priceFeedHealth['hl'] || {}).lastFail || null };
        cb(_hlr.price);
        return;
      }
      // HL covers this asset but price is stale (WS briefly disconnected) —
      // mark feed as degraded and fall through to backup sources.
      if (_hlr && !_hlr.fresh && window.HLFeed.covers(token)) {
        _priceFeedHealth['hl'] = { ok: false, lastOk: (_priceFeedHealth['hl'] || {}).lastOk || null,
          lastFail: Date.now() };
      }
    }

    // 0. Backend market cache — privacy-safe, no corsproxy needed (H4)
    //    Covers WTI, BRENT, GLD, LMT, TSM, SPY, BTC, ETH, etc.
    if (_apiOnline && _backendPrices[token] !== undefined) {
      _cacheSet(token, _backendPrices[token]);
      _feedOk('backend');
      cb(_backendPrices[token]);
      return;
    }

    // 1. Binance — crypto USDT pairs (public, no key, CORS-open)
    if (PRICE_SOURCES[token]) {
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=' + PRICE_SOURCES[token])
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var price = parseFloat(d.price);
          if (!isNaN(price)) { _cacheSet(token, price); _feedOk('binance'); }
          else { _feedFail('binance'); }
          cb(!isNaN(price) ? price : (_priceCache[token] || null));
        })
        .catch(function () { _feedFail('binance'); cb(_priceCache[token] || null); });
      return;
    }

    // 2. CoinGecko — gold (XAU via PAX Gold; 1 PAXG ≈ 1 troy oz)
    if (COINGECKO_SOURCES[token]) {
      _fetchCoinGecko(token, COINGECKO_SOURCES[token], function(p) {
        if (p) _feedOk('coingecko'); else _feedFail('coingecko');
        cb(p);
      });
      return;
    }

    // 3. corsproxy + Yahoo Finance — oil, silver, nat-gas, stocks, ETFs
    if (YAHOO_SOURCES[token]) {
      _fetchYahoo(token, YAHOO_SOURCES[token], function(p) {
        if (p) _feedOk('yahoo'); else _feedFail('yahoo');
        cb(p);
      });
      return;
    }

    // 4. Frankfurter — major forex spot rates (ECB data)
    if (FRANKFURTER_SOURCES[token]) {
      _fetchFrankfurter(token, FRANKFURTER_SOURCES[token], function(p) {
        if (p) _feedOk('frankfurter'); else _feedFail('frankfurter');
        cb(p);
      });
      return;
    }

    // 5. Dashboard live ticker (prices already shown on-page, handles aliases GLD→GOLD etc.)
    var found = _tickerPrice(token);
    if (found) { _cacheSet(token, found); cb(found); return; }

    // 6. Last-known price from any prior source
    cb(_priceCache[token] || null);
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     RISK GATE — canExecute(sig)
     Returns { ok: boolean, reason: string }
     All rules must pass before a trade is opened.
     ══════════════════════════════════════════════════════════════════════════════ */

  function openTrades() {
    return _trades.filter(function (t) { return t.status === 'OPEN'; });
  }

  /* _skipPendingCheck: pass true from the post-fetch recheck path.
     The pending lock is held by the CURRENT signal at that point — checking it
     would always return false and block the trade from opening itself. */
  function canExecute(sig, _skipPendingCheck) {
    if (_halted)
      return { ok: false, reason: '🛑 KILL SWITCH ACTIVE — EE.resume() to re-enable' };

    if (!_cfg.enabled)
      return { ok: false, reason: 'Auto-execution disabled' };

    if (sig.dir === 'WATCH')
      return { ok: false, reason: 'WATCH signals are excluded from execution' };

    // Economic calendar gate: block all new trades within 30 min of a high-impact event
    if (window.ECON_CALENDAR) {
      try {
        if (ECON_CALENDAR.shouldBlock()) {
          var _calEvt = ECON_CALENDAR.imminent();
          return { ok: false, reason: 'High-impact event imminent: ' +
            (_calEvt ? _calEvt.country + ' ' + _calEvt.title : 'economic release') +
            ' — new trades blocked within 30 min of release' };
        }
      } catch (e) {}
    }

    if (sig.conf < _cfg.min_confidence)
      return { ok: false, reason: 'Conf ' + sig.conf + '% < threshold ' + _cfg.min_confidence + '%' };

    // T2-A: attribution-adjusted confidence floor.
    // If historical data shows this asset in the current regime has a poor win rate,
    // require higher confidence before opening. Conversely, relax slightly for hot assets.
    // Only adjusts when ≥10 historical records exist (insufficient data → no change).
    (function () {
      var _ceRegime = null;
      try { if (window.MacroRegime) _ceRegime = (MacroRegime.current() || {}).regime; } catch(e) {}
      var _attrWr = _attrWinRate(normaliseAsset(sig.asset), _ceRegime);
      if (_attrWr === null) return;  // not enough data
      var _adjFloor = _cfg.min_confidence;
      if      (_attrWr < 0.35) _adjFloor = Math.min(80, _adjFloor + 15);  // very poor WR: raise bar
      else if (_attrWr < 0.45) _adjFloor = Math.min(75, _adjFloor + 8);   // below avg: raise bar
      else if (_attrWr > 0.60) _adjFloor = Math.max(45, _adjFloor - 5);   // hot asset: relax slightly
      if (sig.conf < _adjFloor) {
        // Store the adjusted floor on sig so _logSignal can show it
        sig._attrAdjFloor = _adjFloor;
        sig._attrWr       = _attrWr;
      }
    })();
    if (sig._attrAdjFloor && sig.conf < sig._attrAdjFloor) {
      return { ok: false, reason: 'Conf ' + sig.conf + '% < attribution floor ' + sig._attrAdjFloor + '% (' + Math.round((sig._attrWr || 0) * 100) + '% hist. WR in current regime)' };
    }

    // Per-asset confidence floor: poor historical performers require higher conviction.
    var _assetFloor = EE_ASSET_CONF_FLOOR[normaliseAsset(sig.asset)];
    if (_assetFloor && sig.conf < _assetFloor) {
      return { ok: false, reason: sig.asset + ' requires conf ≥' + _assetFloor + '% (poor hist. WR) — got ' + sig.conf + '%' };
    }

    // Adaptive confirmation tiers:
    //   Fast Track  — specialist agent + conf >= 88%: single-source execution allowed.
    //   Standard    — srcCount >= 2: corroborated by 2+ independent sources.
    //   Blocked     — single source, conf < 88%, or non-specialist.
    // Scalper/GII signals are always exempt (they have their own scoring pipeline).
    var _isSrcScalper = sig.reason && (sig.reason.indexOf('SCALPER') === 0 || sig.reason.indexOf('GII:') === 0);
    if (!_isSrcScalper) {
      var _needsCorroboration = sig.srcCount === undefined || sig.srcCount < 2;
      if (_needsCorroboration) {
        // Check if it qualifies for Fast Track
        var _sigSrcName  = (sig.source || _inferSource(sig.reason || '')).toLowerCase();
        var _isSpecialist = !!SPECIALIST_SOURCES[_sigSrcName];
        var _sigConfNow  = sig.conf || 0;  // already 0-100 after normalisation
        if (_isSpecialist && _sigConfNow >= 88) {
          // Fast Track: specialist agent, very high confidence — execute without second confirmation.
          // confMult will apply 1.5-1.75× sizing boost for this confidence level.
          log('RISK', sig.asset + ' fast-track: ' + _sigSrcName + ' specialist conf=' + _sigConfNow +
              '% — single-source execution allowed', 'green');
        } else {
          return { ok: false, reason: 'srcCount ' + (sig.srcCount === undefined ? 'missing' : sig.srcCount) +
                   ' — not corroborated (need 2+ sources, or specialist conf≥88%). Source: ' + _sigSrcName };
        }
      }
    }

    var open = openTrades();

    if (open.length >= _cfg.max_open_trades)
      return { ok: false, reason: 'Max open trades (' + _cfg.max_open_trades + ') reached' };

    var regionOpen = open.filter(function (t) { return t.region === sig.region; }).length;
    if (regionOpen >= _cfg.max_per_region)
      return { ok: false, reason: 'Max per region (' + _cfg.max_per_region + ') reached for ' + sig.region };

    // Sector concentration cap: prevent overloading a single sector (energy, crypto, etc.)
    var sector = EE_SECTOR_MAP[normaliseAsset(sig.asset)];
    if (sector && _cfg.max_per_sector) {
      var sectorOpen = open.filter(function (t) { return EE_SECTOR_MAP[normaliseAsset(t.asset)] === sector; }).length;
      if (sectorOpen >= _cfg.max_per_sector)
        return { ok: false, reason: 'Max per sector (' + _cfg.max_per_sector + ') reached for ' + sector };
    }

    if (open.some(function (t) { return normaliseAsset(t.asset) === normaliseAsset(sig.asset); }))
      return { ok: false, reason: 'Already have open trade for ' + sig.asset };

    // Pending lock: fetchPrice is async — block second signal for same asset while first is in flight.
    // Skip this check in the post-fetch recheck (_skipPendingCheck=true) — the lock was set by the
    // current signal itself, so checking it would always reject the trade we're trying to open.
    if (!_skipPendingCheck && _pendingOpen[normaliseAsset(sig.asset)])
      return { ok: false, reason: 'Price fetch already in progress for ' + sig.asset };

    // Correlation guard: block if a correlated asset is already open in the same direction.
    // Scalper signals are exempt — they have tight stops and short hold times,
    // so running BTC and ETH scalps simultaneously is acceptable.
    var _isSrcScalperCorr = sig.reason && (sig.reason.indexOf('SCALPER') === 0 || sig.reason.indexOf('GII:') === 0);
    if (!_isSrcScalperCorr) {
      var corrGroup = _getCorrGroup(normaliseAsset(sig.asset));
      if (corrGroup) {
        var corrConflict = open.find(function (t) {
          return corrGroup.indexOf(normaliseAsset(t.asset)) !== -1 && t.direction === sig.dir;
        });
        if (corrConflict)
          return { ok: false, reason: 'Correlated position open: ' + corrConflict.asset + ' ' + corrConflict.direction };
      }
    }

    // Direction-aware cooldown: keyed on asset+direction so a BTC SHORT can enter
    // independently of a BTC LONG cooldown (previously asset-only key caused both
    // directions to share one slot).
    var _cdAsset = normaliseAsset(sig.asset);
    var _cdKey   = _cdAsset + '_' + sig.dir;
    var lastTs = _cooldown[_cdKey];
    // Fix #25: adaptive cooldown — extend baseline when volatility is high or on loss streaks.
    //   High VIX (>25): signals are noisier; wait 1.5× longer before re-entering.
    //   Extreme VIX (>35): 2.0× — market regime is dislocated, give extra breathing room.
    //   Loss streak ≥2: 1.25×; ≥4: 1.5× — consecutive losses suggest the thesis isn't working.
    //   Multipliers stack multiplicatively (max 3.0× to prevent indefinite lockout).
    var _adaptCooldownMs = (function () {
      var base = _cfg.cooldown_ms;
      var mult = 1.0;
      // VIX factor
      try {
        if (window.VIXFeed && typeof VIXFeed.current === 'function') {
          var _vix = VIXFeed.current();
          if (_vix > 35) mult *= 2.0;
          else if (_vix > 25) mult *= 1.5;
        }
      } catch (e) {}
      // Loss streak factor
      var _cdDirKey = (sig.dir || 'LONG').toLowerCase() === 'short' ? 'short' : 'long';
      var _cdStreak = Math.max(
        _lossStreak[_cdDirKey] || 0,
        _lossStreak[_cdDirKey + '_' + (EE_SECTOR_MAP[_cdAsset] || 'other')] || 0
      );
      if (_cdStreak >= 4) mult *= 1.5;
      else if (_cdStreak >= 2) mult *= 1.25;
      return Math.min(base * mult, base * 3.0); // hard cap: never more than 3× base
    })();
    if (lastTs && (Date.now() - lastTs) < _adaptCooldownMs)
      return { ok: false, reason: 'Cooldown active for ' + sig.asset + ' ' + sig.dir +
        (_adaptCooldownMs > _cfg.cooldown_ms ? ' (extended ×' + (_adaptCooldownMs / _cfg.cooldown_ms).toFixed(1) + ')' : '') };

    // Reversal cooldown: after a stop-loss, block the OPPOSITE direction for 5 min.
    // Prevents whipsaw entries where BTC LONG stops out and a SHORT opens seconds later
    // right at the stop zone (worst possible fill + likely dead-cat reversal).
    var REVERSAL_COOLDOWN_MS = 5 * 60 * 1000;
    var _revKey = _cdAsset + '_' + sig.dir;  // the direction we WANT to enter
    if (_reversalCooldown[_revKey] && Date.now() < _reversalCooldown[_revKey]) {
      var _revSec = Math.ceil((_reversalCooldown[_revKey] - Date.now()) / 1000);
      return { ok: false, reason: 'Reversal cooldown: ' + sig.asset + ' ' + sig.dir +
               ' blocked for ' + _revSec + 's after opposite-direction SL' };
    }

    // Exposure = total risk dollars at stake (units × |entry−stop| per trade).
    // Using notional size_usd here would falsely block every trade because
    // position sizing math produces size_usd ≈ full balance per trade.
    // Correlated positions (same CORR_GROUP) are weighted 1.5× because they
    // tend to move together — opening BTC while ETH is live = ~1.5× real BTC risk.
    var _newCorrGroup = _getCorrGroup(normaliseAsset(sig.asset));
    var exposure = open.reduce(function (s, t) {
      var slDist = Math.abs((t.entry_price || 0) - (t.stop_loss || 0));
      var riskDollars = slDist > 0 ? (t.units || 0) * slDist : 0;
      var corrMult = (_newCorrGroup && _newCorrGroup.indexOf(normaliseAsset(t.asset)) !== -1) ? 1.5 : 1.0;
      return s + riskDollars * corrMult;
    }, 0);
    var maxExp   = _getEffectiveBalance() * _cfg.max_exposure_pct / 100;
    if (exposure >= maxExp)
      return { ok: false, reason: 'Max exposure ' + _cfg.max_exposure_pct + '% reached' };

    // Macro regime gate: block risk-asset LONGs in RISK_OFF; raise bar in TRANSITIONING
    if (window.MacroRegime) {
      var _regimeCheck = MacroRegime.checkSignal(sig);
      if (!_regimeCheck.ok)
        return { ok: false, reason: _regimeCheck.reason };
    }

    // Session daily loss limit (configurable, replaces hard-coded 10% check)
    // Fix #6: use REALISED P&L only (sum of closed-trade pnl_usd this session).
    // Previously used (_cfg.virtual_balance - _sessionStartBalance) which includes
    // unrealised losses from OPEN positions — a large losing trade in progress
    // could trigger the daily loss limit and pause new entries before anything
    // was actually realised. If that trade then recovered, execution stayed paused.
    var _effectiveStart = _sessionStartBalance || _cfg.virtual_balance;
    if (_effectiveStart && _cfg.daily_loss_limit_pct > 0) {
      var _sessionTs2 = _sessionStart ? new Date(_sessionStart).getTime() : 0;
      var _realisedPnl = _trades
        .filter(function (t) {
          return t.status === 'CLOSED' && t.timestamp_close &&
                 new Date(t.timestamp_close).getTime() >= _sessionTs2;
        })
        .reduce(function (s, t) { return s + (t.pnl_usd || 0); }, 0);
      var sessionLossPct = _effectiveStart > 0 ? (_realisedPnl / _effectiveStart * 100) : 0;
      if (sessionLossPct < -_cfg.daily_loss_limit_pct) {
        return { ok: false, reason: 'Daily loss limit -' + _cfg.daily_loss_limit_pct + '% reached (realised: ' + sessionLossPct.toFixed(1) + '%) — execution paused' };
      }
    }

    // Session health throttle: rapid loss rate detection.
    // If 3+ losses occur within 45 minutes, signal quality has likely degraded
    // (bad data feed, choppy market, broken thesis). Raise the confidence floor
    // by +12% for the next entry to filter low-conviction noise.
    // This is a SOFT brake — it raises the bar rather than fully stopping.
    // Distinct from: daily loss limit (hard stop), _ddMult (size scaler), lossStreak (cooldown).
    // Scalper signals exempt — they use their own tight risk controls.
    var _isScalperHealth = sig.reason && (sig.reason.indexOf('SCALPER') === 0 || sig.reason.indexOf('GII:') === 0);
    if (!_isScalperHealth) {
      var _rapWin = 45 * 60 * 1000;  // 45-minute window
      var _rapNow = Date.now();
      var _rapLosses = _trades.filter(function(t) {
        return t.status === 'CLOSED' && (t.pnl_usd || 0) < 0 && t.timestamp_close &&
               (_rapNow - new Date(t.timestamp_close).getTime()) < _rapWin;
      }).length;
      if (_rapLosses >= 3) {
        var _rapFloor = _cfg.min_confidence + 12;
        if (sig.conf < _rapFloor) {
          return { ok: false, reason: 'Session health: ' + _rapLosses + ' losses in 45min — conf floor raised to ' + _rapFloor + '% (soft brake)' };
        }
      }
    }

    // Pre-event gate: block new trades within event_gate_hours of HIGH-IMPACT calendar events.
    // Asset/region-aware: an event in one region doesn't block unrelated assets.
    //   importance >= 5 (market-moving): blocks ALL signals — systemic global risk.
    //   importance >= 4 (major):         blocks if event region matches signal region.
    //   importance >= 3 (medium-high):   blocks only if event asset matches signal asset.
    // This prevents a minor EU event from blocking BTC or JPY pairs.
    if (_cfg.event_gate_enabled) {
      var calAgent = window.GII_AGENT_CALENDAR;
      if (calAgent && typeof calAgent.upcoming === 'function') {
        try {
          var upcoming = calAgent.upcoming();
          var gateHours = _cfg.event_gate_hours || 0.5;
          var _sigRegion  = (sig.region || '').toUpperCase();
          var _sigAsset   = normaliseAsset(sig.asset);
          var blocked = upcoming.filter(function (ev) {
            if (ev.days < 0 || ev.days > gateHours / 24) return false;
            var imp = ev.importance || 0;
            if (imp >= 5) return true;                          // market-moving: block everything
            var evRegion = (ev.region || '').toUpperCase();
            var evAsset  = (ev.asset  || '').toUpperCase();
            if (imp >= 4 && evRegion && evRegion === _sigRegion) return true;  // major event, same region
            if (imp >= 3 && evAsset  && evAsset  === _sigAsset)  return true;  // any event, same asset
            return false;
          });
          if (blocked.length) {
            var ev0 = blocked[0];
            var minsAway = Math.round(ev0.days * 24 * 60);
            return { ok: false, reason: 'Event gate: "' + ev0.label.substring(0, 45) + '" in ' + minsAway + 'min' };
          }
        } catch (e) { /* calendar agent unavailable — skip gate */ }
      }
    }

    // ── Forex market hours gate (OANDA only) ─────────────────────────────────
    // OANDA trades 24/5: Sun 17:00 ET → Fri 17:00 ET.
    // Block signals during the weekend closure window and add a 30-min buffer
    // after the Sunday open (wide spreads and gap risk).
    // US equity session gates below are irrelevant for forex — skip them.
    var _isOandaFx = sig._venue === 'OANDA';
    if (_isOandaFx) {
      var _fxNow    = new Date();
      var _fxDay    = _fxNow.getUTCDay();  // 0=Sun, 1=Mon, …, 5=Fri, 6=Sat
      var _fxMoFx   = _fxNow.getUTCMonth();
      var _fxEtOff  = (_fxMoFx >= 2 && _fxMoFx <= 10) ? 240 : 300; // EDT/EST
      var _fxEtMins = (_fxNow.getUTCHours() * 60 + _fxNow.getUTCMinutes() + 1440 - _fxEtOff) % 1440;
      var _fxClose  = 17 * 60;   // 5pm ET — Friday close / Sunday open
      var _fxClosed =
        _fxDay === 6 ||                                         // all day Saturday
        (_fxDay === 5 && _fxEtMins >= _fxClose) ||             // Friday after 5pm ET
        (_fxDay === 0 && _fxEtMins < _fxClose);                // Sunday before 5pm ET
      if (_fxClosed) {
        return { ok: false, reason: 'Forex market closed — OANDA trades Sun 17:00 ET – Fri 17:00 ET' };
      }
      // 30-min buffer after Sunday open: spreads are wide, weekend gaps settle
      if (_fxDay === 0 && _fxEtMins >= _fxClose && _fxEtMins < _fxClose + 30) {
        return { ok: false, reason: 'Forex Sunday-open buffer (17:00–17:30 ET) — wide spreads/gap risk' };
      }
      // No US equity session gate for forex — fall through to age check
    }

    // Time-of-day filter: avoid first and last 30 min of US equity session.
    // Open (09:30–10:00 ET) and close (15:30–16:00 ET) have wide spreads,
    // erratic price action, and high false-signal rates for news-based entries.
    // Scalper signals and OANDA forex signals are exempt.
    var _isScalperForTod = sig.reason && (sig.reason.indexOf('SCALPER') === 0 || sig.reason.indexOf('GII:') === 0);
    if (!_isScalperForTod && !_isOandaFx) {
      var _now = new Date();
      // Convert to US Eastern Time (UTC-5 standard, UTC-4 daylight saving).
      var _utcH = _now.getUTCHours(), _utcM = _now.getUTCMinutes();
      // DST approximation: EDT (UTC-4) runs Mar–Nov, EST (UTC-5) Nov–Mar
      var _mo = _now.getUTCMonth(); // 0=Jan
      var _etOffset = (_mo >= 2 && _mo <= 10) ? 240 : 300; // EDT=240min, EST=300min
      var _etMins = (_utcH * 60 + _utcM + 1440 - _etOffset) % 1440;
      var _openStart = 9 * 60 + 30, _openEnd = 10 * 60;         // 09:30–10:00
      var _closeStart = 15 * 60 + 30, _closeEnd = 16 * 60;      // 15:30–16:00
      if ((_etMins >= _openStart && _etMins < _openEnd) ||
          (_etMins >= _closeStart && _etMins < _closeEnd)) {
        return { ok: false, reason: 'Time-of-day gate: US session open/close window (avoid first/last 30min)' };
      }
    }

    // Signal age check: if the signal carries a timestamp and it is older than
    // 15 minutes, reject. The market has already moved on — we're chasing.
    // T3-E: scalper signals get a 5-min age gate (was fully exempt).
    // Scalp theses (momentum, breakout, RSI extreme) decay within minutes;
    // a 20-min-old scalp signal is not just stale — it's likely a reversal risk.
    var _isScalperForAge = sig.reason && (sig.reason.indexOf('SCALPER') === 0 || sig.reason.indexOf('GII:') === 0);
    var _maxAgeMs = _isScalperForAge ? 5 * 60 * 1000 : 15 * 60 * 1000;
    if (sig.ts && (Date.now() - sig.ts) > _maxAgeMs) {
      return { ok: false, reason: 'Signal stale — ' + Math.round((Date.now() - sig.ts) / 60000) + 'min old (>' + (_maxAgeMs / 60000) + 'min threshold for ' + (_isScalperForAge ? 'scalper' : 'IC') + ')' };
    }

    return { ok: true, reason: 'All risk checks passed' };
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     TRADE LIFECYCLE
     ══════════════════════════════════════════════════════════════════════════════ */

  function makeId(prefix) {
    // timestamp(base36) + sequence(base36) + 4-char random hex → collision-safe unique IDs
    var r = ('000' + Math.floor(Math.random() * 0xFFFF).toString(16)).slice(-4).toUpperCase();
    return prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + (++_seq).toString(36).toUpperCase() + '-' + r;
  }

  /* Infer signal source from reason string — fallback for pre-tagging legacy trades */
  function _inferSource(reason) {
    if (reason.indexOf('SCALPER-SESSION:') === 0) return 'scalper-session';
    if (reason.indexOf('SCALPER:')         === 0) return 'scalper';
    if (reason.indexOf('GII:')             === 0) return 'gii';
    return 'ic';  // default: IC-sourced trade
  }

  /* Capture market regime at the moment a trade is opened.
     Reads from GII, GII_AGENT_MACRO, and __IC — all optional/safe. */
  function _captureRegime() {
    var r = { ts: new Date().toISOString() };
    try {
      if (window.GII && typeof GII.gti === 'function') {
        var g = GII.gti();
        if (g) { r.gti = +g.value.toFixed(1); r.gtiLevel = g.level; }
      }
      if (window.GII_AGENT_MACRO && typeof GII_AGENT_MACRO.status === 'function') {
        var m = GII_AGENT_MACRO.status();
        if (m) { r.riskMode = m.riskMode || 'NEUTRAL'; r.vix = m.vix || null; }
      }
      if (window.__IC && window.__IC.stats) {
        var w = window.__IC.stats.warnings || 0;
        r.threatLevel = w >= 5 ? 'CRITICAL' : w >= 3 ? 'HIGH' : w >= 1 ? 'MODERATE' : 'LOW';
      }
    } catch (e) {}
    return r;
  }

  /* Build a complete trade object from a signal + entry price */
  function buildTrade(sig, entryPrice) {
    var dir     = sig.dir === 'SHORT' ? 'SHORT' : 'LONG';
    // ATR-based stop/target: prefer per-signal values from gii-technicals
    // over the global fixed-percentage config (backward-compatible fallback).
    // Also accepts sig.stopPct / sig.tpRatio for volatility-adjusted sizing
    // from gii-entry (asset-specific percentage stops, e.g. BTC=6%, GLD=2%).
    var sigStopPct = (sig.stopPct  && isFinite(sig.stopPct)  && sig.stopPct  > 0) ? sig.stopPct  : _cfg.stop_loss_pct;
    var sigTpRatio = (sig.tpRatio  && isFinite(sig.tpRatio)  && sig.tpRatio  > 0) ? sig.tpRatio  : _cfg.take_profit_ratio;
    var defaultSlDist = entryPrice * (sigStopPct / 100);
    var slDist_ = (sig.atrStop  && isFinite(sig.atrStop)  && sig.atrStop  > 0) ? sig.atrStop  : defaultSlDist;
    var tpDist_ = (sig.atrTarget && isFinite(sig.atrTarget) && sig.atrTarget > 0) ? sig.atrTarget : slDist_ * sigTpRatio;

    var stopLoss, takeProfit;
    if (dir === 'LONG') {
      stopLoss   = entryPrice - slDist_;
      takeProfit = entryPrice + tpDist_;
    } else {
      stopLoss   = entryPrice + slDist_;
      takeProfit = entryPrice - tpDist_;
    }

    // T2-D: dynamic TP ratio — scale the take-profit target based on current macro regime
    // and momentum strength. RISK_ON trending markets justify holding for more; choppy
    // RISK_OFF environments should take profit earlier. Only applies when signal doesn't
    // already provide an explicit atrTarget (which is already regime-calibrated by gii-technicals).
    if (!sig.atrTarget) {
      var _dynTPRatio = sigTpRatio;
      try {
        if (window.MacroRegime && typeof MacroRegime.current === 'function') {
          var _dynMR = (MacroRegime.current() || {}).regime;
          if      (_dynMR === 'RISK_ON')       _dynTPRatio *= 1.20;  // trending: let winners run
          else if (_dynMR === 'RISK_OFF')       _dynTPRatio *= 0.80;  // choppy: take profit early
          else if (_dynMR === 'TRANSITIONING')  _dynTPRatio *= 0.90;  // uncertain: modest trim
        }
        if (window.GII_AGENT_MOMENTUM && typeof GII_AGENT_MOMENTUM.status === 'function') {
          var _momStr = (GII_AGENT_MOMENTUM.status() || {}).strength;  // 0–1 normalised
          if (typeof _momStr === 'number' && isFinite(_momStr)) {
            _dynTPRatio *= (1.0 + (_momStr * 0.30));  // up to +30% on strong momentum
          }
        }
      } catch(e) {}
      _dynTPRatio = Math.max(1.5, Math.min(4.0, _dynTPRatio));  // floor 1.5R, cap 4.0R
      tpDist_ = slDist_ * _dynTPRatio;
      // Recalculate TP with the adjusted ratio
      takeProfit = dir === 'LONG'
        ? entryPrice + tpDist_
        : entryPrice - tpDist_;
    }

    // Sanity check: stop must be on correct side of entry, and slDist must be
    // reasonable (≤ 20% of entry). Catches GLD spot/ETF price mix-ups and
    // wrong-direction stops from GII signals that reference a different price source.
    var rawSlDist = Math.abs(entryPrice - stopLoss);
    var maxSlDist  = entryPrice * 0.20;
    var stopOnWrongSide = (dir === 'LONG' && stopLoss >= entryPrice) ||
                          (dir === 'SHORT' && stopLoss <= entryPrice);
    if (stopOnWrongSide || rawSlDist > maxSlDist) {
      log('RISK', '⚠ SL sanity override for ' + sig.asset + ' ' + dir +
        ' — signal SL ' + (stopLoss ? stopLoss.toFixed(6) : 'none') +
        ' was ' + (stopOnWrongSide ? 'wrong side of entry' : 'too wide (>' + (maxSlDist*100/entryPrice).toFixed(1) + '%)') +
        ' — recalculated using cfg stop_loss_pct', 'warn');
      slDist_ = entryPrice * (_cfg.stop_loss_pct / 100);
      tpDist_ = slDist_ * sigTpRatio;
      stopLoss   = dir === 'LONG' ? entryPrice - slDist_ : entryPrice + slDist_;
      takeProfit = dir === 'LONG' ? entryPrice + tpDist_ : entryPrice - tpDist_;
    }

    // Position sizing: base risk scaled by signal impact strength
    // sig.impactMult: GTI size reduction (0.45–1.0) OR event impact (0.5–2.0)
    // Floor lowered to 0.1 so GTI extreme-tension 0.45 passes through correctly
    var impactMult = (sig.impactMult && isFinite(sig.impactMult))
      ? Math.max(0.1, Math.min(2.0, sig.impactMult))
      : 1.0;

    // F31 fix: cache closed trades once here — both the Kelly IIFE and the
    // _srcWrMult IIFE independently called _trades.filter(CLOSED), scanning
    // the full array twice per signal. Shared reference eliminates the duplicate.
    var _btClosedCache = _trades.filter(function (t) { return t.status === 'CLOSED'; });

    // EV/Kelly adjustment: scale size by simplified Kelly fraction using
    // historical win rate. Uses a global prior from total trade history so that
    // every trade (not just those with 5+ asset-specific records) gets Kelly sizing.
    // Kelly f* = (W * R - L) / R  where W=winRate, L=1-W, R=TP:SL ratio
    // We use a half-Kelly approach (×0.5) for safety.
    //
    // Audit fix: previous version used kellyMult=1.0 for assets without ≥5 trades,
    // meaning untested assets always got full sizing. At a 13% system win rate,
    // Kelly says negative EV — we should be sizing DOWN on all untested trades.
    // Now: calculate global win rate from all closed trades as the default prior.
    var kellyMult = 1.0;
    (function () {
      var R = _cfg.take_profit_ratio;
      if (R <= 1.0) return;   // degenerate config — Kelly undefined

      // Global prior: use shared closed-trade cache (avoids double filter — F31 fix)
      var _allClosed = _btClosedCache;
      // Fix #21: regime-conditional prior — when the market regime is known, adjust
      // the prior win-rate before we have 10 trades. RISK_ON favours momentum signals
      // (higher prior); RISK_OFF tightens capital deployment; TRANSITIONING is neutral.
      //   RISK_ON        → 0.42 prior (trending mkts improve signal hit rate)
      //   RISK_OFF       → 0.36 prior (cautious; volatility suppresses mean-reversion)
      //   TRANSITIONING  → 0.32 prior (uncertainty; regime in flux, expect more noise)
      //   unknown/error  → 0.36 (safe default)
      var _kellRegimePrior = 0.36;
      try {
        if (window.MacroRegime && typeof MacroRegime.current === 'function') {
          var _mr = MacroRegime.current();
          if (_mr && _mr.regime === 'RISK_ON')        _kellRegimePrior = 0.42;
          else if (_mr && _mr.regime === 'TRANSITIONING') _kellRegimePrior = 0.32;
          // RISK_OFF stays at 0.36 — don't block trades, just don't inflate sizing
        }
      } catch (e) {}
      var _globalW = _allClosed.length >= 10
        ? _allClosed.filter(function (t) { return (t.pnl_usd || 0) > 0; }).length / _allClosed.length
        : _kellRegimePrior;

      // Per-asset prior: if ≥5 trades exist for this asset+direction, use that instead
      var W = _globalW;
      if (window.GII && typeof GII.agentReputations === 'function') {
        try {
          var reps    = GII.agentReputations();
          var assetKey = normaliseAsset(sig.asset);
          var biasKey  = dir === 'LONG' ? 'long' : 'short';
          Object.keys(reps).forEach(function (k) {
            if (k.indexOf(assetKey) !== -1 && k.indexOf(biasKey) !== -1 && reps[k] && reps[k].total >= 5) {
              W = reps[k].winRate;
            }
          });
        } catch (e) {}
      }

      // H6 fix: Kelly uses realised R (avg win / avg loss from closed trades) not
      // the theoretical TP:SL config ratio. Partial TPs mean actual realised R is
      // often 1.5–2.0× not the configured 2.5×, causing systematic over-sizing.
      // With ≥10 closed trades, compute realised R from actual trade P&L.
      // Fall back to configured R when data is insufficient.
      // T2-C: recency-weighted realised R — trades from 30 days ago carry 50% weight,
      // trades from 60 days ago carry 25% weight. Recent performance adapts Kelly faster
      // after strategy shifts or regime changes. Win rate uses the same decay weights.
      var _realisedR = R; // default: use configured ratio
      if (_allClosed.length >= 10) {
        var _realisedWins   = _allClosed.filter(function (t) { return (t.pnl_usd || 0) > 0; });
        var _realisedLosses = _allClosed.filter(function (t) { return (t.pnl_usd || 0) < 0; });
        if (_realisedWins.length >= 5 && _realisedLosses.length >= 5) {
          var _rNow      = Date.now();
          var _halfLifeMs = 30 * 24 * 60 * 60 * 1000;  // 30-day half-life
          function _rw(t) {
            var age = _rNow - new Date(t.timestamp_close || t.timestamp_open || _rNow).getTime();
            return Math.pow(0.5, age / _halfLifeMs);
          }
          var _wWin   = _realisedWins.reduce(function (s, t)   { return s + (t.pnl_usd || 0) * _rw(t); }, 0);
          var _wLoss  = _realisedLosses.reduce(function (s, t) { return s + Math.abs(t.pnl_usd || 0) * _rw(t); }, 0);
          var _wWinN  = _realisedWins.reduce(function (s, t)   { return s + _rw(t); }, 0);
          var _wLossN = _realisedLosses.reduce(function (s, t) { return s + _rw(t); }, 0);
          var _avgWin  = _wWinN  > 0 ? _wWin  / _wWinN  : 0;
          var _avgLoss = _wLossN > 0 ? _wLoss / _wLossN : 0;
          if (_avgLoss > 0) _realisedR = Math.max(1.0, _avgWin / _avgLoss);
          // Also update global win rate with recency weighting
          if (_allClosed.length >= 10) {
            var _wWinsTotal = _allClosed.reduce(function (s, t) { return s + ((t.pnl_usd || 0) > 0 ? _rw(t) : 0); }, 0);
            var _wTotal     = _allClosed.reduce(function (s, t) { return s + _rw(t); }, 0);
            if (_wTotal > 0) _globalW = _wWinsTotal / _wTotal;
          }
        }
      }
      var kelly = (W * _realisedR - (1 - W)) / _realisedR;
      var baseKelly = Math.max(0.01, (0.5 * _realisedR - 0.5) / _realisedR);  // BE kelly at 50% win rate
      if (kelly > 0) {
        kellyMult = Math.max(0.3, Math.min(2.0, kelly * 0.5 / baseKelly));  // raised cap 1.5→2.0
        // Floor lowered 0.50→0.30: prior win rate now genuinely affects sizing.
        // At W=0.36 → kellyMult≈0.35 (was 0.50 — prior change was a no-op at 0.50 floor).
        // At W=0.55+ → kellyMult scales up naturally above 0.5. Responsive, not fixed.
      } else {
        // Fix #7: distinguish between "not enough data" (use a small prior)
        // and "data confirms negative EV" (cut size meaningfully).
        // Kelly ≤ 0 means the system is below breakeven — the mathematically
        // correct size is 0 (don't trade). We don't go to zero because we need
        // trades to gather data and regime conditions can flip, but we DO cut
        // harder than the old 0.30 floor which provided no real penalty.
        if (_allClosed.length < 10) {
          kellyMult = 0.30;  // insufficient data — conservative prior, keep gathering info
          log('RISK', sig.asset + ' Kelly: negative EV but <10 trades — using conservative 30% prior', 'dim');
        } else {
          kellyMult = 0.15;  // data-confirmed negative EV — cut to 15% to preserve capital
          log('RISK', '⚠ ' + sig.asset + ' Kelly: negative EV (W=' + (_globalW*100).toFixed(0) + '%, R=' + R.toFixed(1) + ') — sizing at 15% floor to protect capital', 'amber');
        }
      }
    })();

    // v61: per-direction loss streak — long losses don't penalise short sizing.
    // Fix #9: also make streak sector-aware so a BTC crypto losing streak doesn't
    // penalise EUR/USD forex trades which are in a completely different market.
    // We read the tighter sector key first; if no data yet, fall back to the
    // global direction key so new asset classes still get protection.
    var _dirKey    = (sig.dir || 'LONG').toLowerCase() === 'short' ? 'short' : 'long';
    var _sigSector = EE_SECTOR_MAP[normaliseAsset(sig.asset)] || 'other';
    var _sectorDirKey = _dirKey + '_' + _sigSector;  // e.g. 'long_crypto', 'short_forex'
    // Use sector-specific streak if it has any data, else fall back to global direction streak
    var _dirStreak = (_lossStreak[_sectorDirKey] !== undefined)
      ? (_lossStreak[_sectorDirKey] || 0)
      : (_lossStreak[_dirKey] || 0);
    var _dirWinStreak = _winStreak[_dirKey]  || 0;
    var streakMult    = _dirStreak >= 3 ? 0.50 : _dirStreak >= 2 ? 0.75 : 1.0;
    if (streakMult < 1.0) {
      log('RISK', sig.asset + ' [' + _sigSector + '] ' + _dirKey + ' streak ' + _dirStreak + ' → size ×' + streakMult, 'amber');
    }
    // Win-streak tracking kept for display purposes but no longer applied to sizing.
    // Win streaks in markets are largely random — after 3 wins you're not "hot",
    // you may just have had favourable conditions. Amplifying size at that point
    // increases exposure precisely when a mean-reversion is likely.
    // Kelly already captures genuine edge; this was double-counting.
    var winStreakMult = 1.0;   // informational only — see _winStreak for badge display

    // HIGH_CONVICTION timeframe alignment: when all timeframes agree, Kelly gets a 1.2× boost.
    // convictionTier = 'HIGH_CONVICTION' is set by gii-technicals when multi-TF aligned.
    // Cap: never push kellyMult above 1.5 even with the boost — prevents overconfidence.
    if (sig.convictionTier === 'HIGH_CONVICTION' || sig.conviction === 'HIGH_CONVICTION') {
      var _prevKelly = kellyMult;
      kellyMult = Math.min(1.5, kellyMult * 1.2);
      if (kellyMult > _prevKelly) {
        log('RISK', sig.asset + ' HIGH_CONVICTION alignment → Kelly ×' + kellyMult.toFixed(2) +
            ' (was ×' + _prevKelly.toFixed(2) + ')', 'green');
      }
    }

    // Peak drawdown size scaler: limits new exposure when the account is in a drawdown.
    // Thresholds loosened to give the system more room to recover before cutting size.
    var _ddMult = _ddFromPeak >= 12 ? 0.25   // -12%+: cut to 25%  (was -8%)
               : _ddFromPeak >=  8 ? 0.50   // -8 to -12%: cut to 50% (was -5%)
               : 1.0;

    // Confidence-tiered sizing: scale position based on signal confidence.
    // Fix #10: replaced stepped tiers with a smooth continuous curve to eliminate
    // the hard cliff at 90% (was a 43% size jump — 1.75× → 2.50× — at one point).
    // A signal at 89% vs 90% should not differ by 43% in size; random noise in
    // confidence scoring could arbitrarily swing position size at key thresholds.
    //
    // New formula: smooth power curve anchored at:
    //   conf = 40%  → 0.75× (weak — reduce size; hard floor at min_confidence anyway)
    //   conf = 55%  → 1.00× (standard — min_confidence threshold)
    //   conf = 70%  → 1.30× (good signal)
    //   conf = 80%  → 1.65× (strong — was 1.75×, now smoother)
    //   conf = 90%  → 2.10× (very strong — was 2.50×, reduced to avoid overconcentration)
    //   conf = 100% → 2.50× (maximum — only reachable with perfect-score signals)
    // The _dynamicCap still hard-caps the resulting riskAmt regardless.
    var _sigConf = sig.conf || sig.confidence || 0;
    var confMult;
    if (_sigConf <= 0) {
      confMult = 1.0;
    } else if (_sigConf < 40) {
      confMult = 0.75;  // hard floor — below practical min_confidence
    } else {
      // Smooth power curve: 0.75 at conf=40, 1.0 at conf=55, 2.5 at conf=100
      // Exponent 1.5 gives a gentle S-shape: grows slowly at first, accelerates above 70%
      var _confNorm = Math.max(0, (_sigConf - 40)) / 60;  // 0.0 at conf=40, 1.0 at conf=100
      confMult = Math.max(0.75, Math.min(2.50, 0.75 + 1.75 * Math.pow(_confNorm, 1.5)));
    }
    confMult = +confMult.toFixed(3);
    if (Math.abs(confMult - 1.0) > 0.02) {
      log('RISK', sig.asset + ' conf ' + _sigConf + '% → size ×' + confMult.toFixed(2),
          confMult > 1.0 ? 'green' : 'dim');
    }

    // Fix #23: source win-rate weighting — auto-allocate more capital to proven agents.
    // Compute a multiplier from the historical win rate of the signal's source.
    // Range: 0.70× (source winning <30% of time) → 1.30× (source winning >60%).
    // Capped to ±30% so no single source dominates position sizing.
    // Requires ≥10 closed trades from this source to take effect (less = neutral 1.0).
    var _srcWrMult = 1.0;
    (function () {
      var _srcName = (sig.source || _inferSource(sig.reason || '')).toLowerCase();
      if (!_srcName) return;
      // Use shared closed cache (F31 fix — avoids redundant full array scan)
      var _srcClosed = _btClosedCache.filter(function (t) {
        return (t.source || _inferSource(t.reason || '')).toLowerCase() === _srcName;
      });
      if (_srcClosed.length < 10) return; // insufficient data — stay neutral
      var _srcWr = _srcClosed.filter(function (t) { return (t.pnl_usd || 0) > 0; }).length / _srcClosed.length;
      // H7 fix: previous formula had neutral point at 0.30 WR, not 0.45 as intended.
      // Formula: 0.70 + (srcWr - 0.45) / 0.15 * 0.30
      //   → WR=0.30 → 0.70×, WR=0.45 → 1.00× (neutral), WR=0.60 → 1.30×
      _srcWrMult = Math.max(0.70, Math.min(1.30, 1.0 + (_srcWr - 0.45) / 0.15 * 0.30));
      if (Math.abs(_srcWrMult - 1.0) > 0.03) {
        log('RISK', sig.asset + ' source "' + _srcName + '" WR=' + (_srcWr * 100).toFixed(0) +
          '% (' + _srcClosed.length + ' trades) → size ×' + _srcWrMult.toFixed(2),
          _srcWrMult > 1.0 ? 'green' : 'amber');
      }
    })();

    // Source credibility multiplier: high-credibility sources (Reuters, Pentagon, central banks)
    // get larger position sizes; low-credibility sources (Reddit, TASS, unverified Telegram)
    // get smaller sizes. Range: 0.75× (junk) → 1.20× (official/wire). Neutral at 1.0 (tier-1 press).
    // Requires window.SourceCredibility — falls back to 1.0 if unavailable.
    var _credMult = 1.0;
    if (window.SourceCredibility) {
      try {
        var _credSrc = sig.source || _inferSource(sig.reason || '');
        var _credW   = SourceCredibility.weight(_credSrc);
        // Smooth scale: 0.75 at weight=0.3, 1.00 at weight=1.0, 1.20 at weight=1.5
        _credMult = Math.max(0.75, Math.min(1.20, 0.75 + (_credW - 0.3) / 1.2 * 0.45));
        _credMult = +_credMult.toFixed(3);
        if (Math.abs(_credMult - 1.0) > 0.04) {
          log('RISK', sig.asset + ' src credibility "' + _credSrc + '" T' + SourceCredibility.tier(_credSrc) +
              ' → size ×' + _credMult.toFixed(2), _credMult > 1.0 ? 'green' : 'dim');
        }
      } catch(e) {}
    }

    var _effectiveBal = _getEffectiveBalance();
    var riskAmt  = _effectiveBal * _cfg.risk_per_trade_pct / 100 * impactMult * kellyMult * streakMult * _ddMult * confMult * _srcWrMult * _credMult;
    if (_ddMult < 1.0) {
      log('RISK', sig.asset + ' peak-DD -' + _ddFromPeak.toFixed(1) + '% → size ×' + _ddMult + ' (' + (_ddMult * 100) + '%)', 'amber');
    }
    // Hard cap: prevents compounding from creating unrealistically large positions.
    // Dynamic cap scales at 1% of balance (raised from 0.5%) to grow with the account.
    // At $1k balance → cap=$100, at $10k → cap=$100, at $20k → cap=$200.
    // A7: use _effectiveBal (already computed above) so the cap scales with
    // live broker equity when connected, not just the paper virtual_balance.
    var _dynamicCap = (_cfg.max_risk_usd > 0)
      ? Math.max(_cfg.max_risk_usd, _effectiveBal * 0.01)
      : 0;
    if (_dynamicCap > 0) riskAmt = Math.min(riskAmt, _dynamicCap);

    // Scalper-specific risk cap: scraper/scalper signals are short-timeframe with
    // fast-moving entries — cap them at $15 max to prevent a single BTC scalp
    // from taking a large chunk of the session balance.
    var _isScalperSig = (sig.reason && sig.reason.indexOf('SCALPER') === 0) ||
                        (sig.from  && sig.from.toLowerCase().indexOf('scalp')   !== -1) ||
                        (sig.from  && sig.from.toLowerCase().indexOf('scraper') !== -1);
    var SCALPER_RISK_CAP = 15;  // $15 max per scalp entry
    if (_isScalperSig && riskAmt > SCALPER_RISK_CAP) {
      log('SCALPER', sig.asset + ' scalper risk capped $' + riskAmt.toFixed(2) + ' → $' + SCALPER_RISK_CAP, 'dim');
      riskAmt = SCALPER_RISK_CAP;
    }

    // Forex leverage gate — tiered by confidence on OANDA currency pairs.
    // Only applies to pure FX pairs (not metals/energy/indices).
    // Hard cap: 10% of balance per trade regardless of leverage tier.
    //   conf 82–84%: 5×   — solid signal, meaningful amplification
    //   conf 85–89%: 15×  — strong signal, aggressive sizing
    //   conf ≥ 90%:  25×  — near OANDA's 30:1 limit, reserved for best setups
    // Blocked in RISK_OFF regime (safe-haven flows override carry/momentum).
    var _FX_PAIRS = {
      'EUR_USD':1,'GBP_USD':1,'USD_JPY':1,'USD_CHF':1,'AUD_USD':1,
      'USD_CAD':1,'NZD_USD':1,'GBP_JPY':1,'EUR_JPY':1,'EUR_GBP':1
    };
    var _fxLeveraged = false;
    if (sig._venue === 'OANDA' && _FX_PAIRS[normaliseAsset(sig.asset)]) {
      var _fxRegime = 'RISK_ON';
      try { if (window.MacroRegime && MacroRegime.current) _fxRegime = MacroRegime.current().regime || 'RISK_ON'; } catch(e) {}
      var _fxConf = sig.conf || 0;
      if (_fxConf >= 82 && _fxRegime !== 'RISK_OFF') {
        var _fxLevMult = _fxConf >= 90 ? 25 : _fxConf >= 85 ? 15 : 5;
        var _fxLevAmt  = Math.min(riskAmt * _fxLevMult, _effectiveBal * 0.10);
        if (_fxLevAmt > riskAmt) {
          log('RISK', sig.asset + ' forex ' + _fxLevMult + '× lev (conf=' + _fxConf + '% ' + _fxRegime + '): $' +
              riskAmt.toFixed(2) + ' → $' + _fxLevAmt.toFixed(2), 'green');
          riskAmt = _fxLevAmt;
          _fxLeveraged = true;
        }
      }
    }

    // Crypto volatility discount: BTC/ETH/SOL are 3-5× more volatile than equities/energy.
    // Wide stops (6-7%) mean larger notional positions — cap by halving the risk budget.
    // EXCEPTION: scalper signals already have ATR-based tight stops + their own $15 cap —
    // applying a second 50% haircut double-counts risk mitigation and halves trade size for no reason.
    var _cryptoAssets = {
      'BTC':true,'ETH':true,'SOL':true,'BNB':true,'ADA':true,
      'DOGE':true,'AVAX':true,'DOT':true,'LINK':true,'LTC':true,
      'UNI':true,'AAVE':true,'INJ':true,'SUI':true,'APT':true,
      'TIA':true,'TON':true,'NEAR':true,'ARB':true,'OP':true,
      'ATOM':true,'HYPE':true,'WIF':true,'PEPE':true,'BONK':true,
      'TAO':true,'RENDER':true,'FET':true,'IMX':true,'HBAR':true,
      'ICP':true,'ETC':true,'BCH':true,'SEI':true,'RUNE':true,
      'ONDO':true,'JUP':true,'MKR':true,'XRP':true
    };
    if (_cryptoAssets[normaliseAsset(sig.asset)] && !_isScalperSig) {
      var _beforeCrypto = riskAmt;
      riskAmt = riskAmt * 0.50;
      log('RISK', sig.asset + ' crypto size discount: $' + _beforeCrypto.toFixed(2) + ' → $' + riskAmt.toFixed(2) + ' (50% vol cap)', 'dim');
    }

    // VIX-scaled position sizing for risk-on assets.
    // High VIX = wider intra-day swings = stops hit more often by noise = smaller size.
    // Only applied to risk-on assets (not defensive/safe-haven, which BENEFIT from high VIX).
    var _vixRiskAssets = { 'BTC':1, 'ETH':1, 'SOL':1, 'SPY':1, 'QQQ':1, 'TSLA':1, 'NVDA':1,
                           'AAPL':1, 'MSFT':1, 'AMZN':1, 'GOOGL':1, 'META':1 };
    if (_vixRiskAssets[normaliseAsset(sig.asset)]) {
      var _vixNow = 20;
      try {
        if (window.GII_AGENT_MACRO && typeof GII_AGENT_MACRO.status === 'function') {
          _vixNow = GII_AGENT_MACRO.status().vix || 20;
        }
      } catch (e) {}
      var _vixSizeMult = _vixNow >= 35 ? 0.50   // extreme vol: half size
                       : _vixNow >= 25 ? 0.70   // elevated vol: 70%
                       : _vixNow >= 20 ? 0.85   // mild elevation: 85%
                       : 1.0;                   // calm market: full size
      if (_vixSizeMult < 1.0) {
        var _bfVix = riskAmt;
        riskAmt = riskAmt * _vixSizeMult;
        log('RISK', sig.asset + ' VIX ' + _vixNow.toFixed(0) + ' size ×' + _vixSizeMult +
            ': $' + _bfVix.toFixed(2) + ' → $' + riskAmt.toFixed(2), 'amber');
      }
    }

    // Options market stress multiplier: VIX term structure and PCR give an
    // independent read on near-term fear that VIX alone can miss.
    // BACKWARDATION (short vol > long vol) = crisis pricing → reduce risk-asset longs.
    // EUPHORIA (PCR very low) = complacency → reduce longs (crowded, reversal risk).
    // Not applied to: forex, defensive assets (GLD/XAU/TLT), scalper signals.
    if (window.OptionsMarket && !_fxLeveraged && !_isScalperSig) {
      try {
        var _opts = OptionsMarket.current();
        var _optRisk = _opts.riskScore || 0;  // -20 to +20 (positive = risk-off)
        var _optMult = 1.0;
        var _isDefOpt = ['GLD','XAU','SLV','TLT','SILVER'].indexOf(normaliseAsset(sig.asset)) !== -1;
        if (!_isDefOpt) {
          if (_optRisk >= 14 && sig.dir === 'LONG') _optMult = 0.65;       // SEVERE_BACKWARDATION: 65%
          else if (_optRisk >= 8 && sig.dir === 'LONG') _optMult = 0.80;   // BACKWARDATION/FEAR:   80%
          else if (_optRisk <= -8 && sig.dir === 'LONG') _optMult = 0.80;  // EUPHORIA: complacent longs, shrink
        }
        if (_optMult < 1.0) {
          var _bfOpt = riskAmt;
          riskAmt = riskAmt * _optMult;
          log('RISK', sig.asset + ' options stress (' + (_opts.tsSignal || '?') + '/' + (_opts.pcrSignal || '?') +
              ') ×' + _optMult + ': $' + _bfOpt.toFixed(2) + ' → $' + riskAmt.toFixed(2), 'amber');
        }
      } catch(e) {}
    }

    // Correlation load multiplier: if many risk-on LONG trades are already open,
    // downsize new entries — the portfolio is already fully exposed to that theme.
    // Defensive trades (GLD, JPY, TLT…) are not counted because they naturally hedge.
    var _riskOnOpen = openTrades().filter(function (t) {
      return t.direction === 'LONG' && _vixRiskAssets[normaliseAsset(t.asset)];
    }).length;
    var _corrLoadMult = _riskOnOpen >= 4 ? 0.50   // 4+ risk-on longs: halve new exposure
                      : _riskOnOpen >= 3 ? 0.70   // 3 risk-on longs: 70%
                      : 1.0;
    if (_corrLoadMult < 1.0 && _vixRiskAssets[normaliseAsset(sig.asset)] && sig.dir === 'LONG') {
      var _bfCorr = riskAmt;
      riskAmt = riskAmt * _corrLoadMult;
      log('RISK', sig.asset + ' corr-load (' + _riskOnOpen + ' risk-on longs open) ×' + _corrLoadMult +
          ': $' + _bfCorr.toFixed(2) + ' → $' + riskAmt.toFixed(2), 'amber');
    }

    // Regime-aware sizing: trend markets get more size, choppy markets get less.
    // Uses BTC as a broad market regime indicator (available on HL).
    // Trending = 1h and 4h returns aligned and > threshold. Choppy = conflicting.
    (function() {
      if (!window.GII_AGENT_MOMENTUM) return;
      try {
        var mSt = GII_AGENT_MOMENTUM.status();
        if (!mSt || !mSt.assetsTracked) return;
        // Momentum agent exposes a regime hint via its last scan
        var sigs = GII_AGENT_MOMENTUM.signals ? GII_AGENT_MOMENTUM.signals() : [];
        var assetHasMomentum = sigs.some(function(s) {
          return s.asset === normaliseAsset(sig.asset) && s.bias === (sig.dir || sig.bias);
        });
        var regimeMult = assetHasMomentum ? 1.20 : 0.90;
        if (regimeMult !== 1.0) {
          var _bfRegime = riskAmt;
          riskAmt = riskAmt * regimeMult;
          log('RISK', sig.asset + ' regime ×' + regimeMult +
              ' (momentum ' + (assetHasMomentum ? 'aligned' : 'absent') + ')' +
              ': $' + _bfRegime.toFixed(2) + ' → $' + riskAmt.toFixed(2), 'dim');
        }
      } catch(e) {}
    })();

    var slDist   = Math.abs(entryPrice - stopLoss);

    // Risk-of-ruin guard: scale down so total max drawdown stays ≤ 20% of balance
    var maxRiskBudget = _effectiveBal * 0.20;
    var currentMaxLoss = openTrades().reduce(function (s, t) {
      var td = Math.abs(t.entry_price - t.stop_loss);
      return s + (td > 0 ? t.units * td : 0);
    }, 0);
    var remainingBudget = maxRiskBudget - currentMaxLoss;
    if (remainingBudget < riskAmt) {
      riskAmt = Math.max(0, remainingBudget);   // scale down rather than reject outright
    }

    /* ── IC DYNAMIC RISK SCALING ────────────────────────────────────────────
     * ICRiskEngine tracks rolling IC win rate / expectancy / TP-hit rate and
     * adjusts the risk multiplier incrementally (0.25x–3.0x of base risk).
     * Per-asset bonuses for TSLA and VXX are applied when those assets have
     * independently demonstrated positive expectancy.
     * Total IC portfolio exposure is hard-capped at 15 % of virtual_balance.
     * ----------------------------------------------------------------------- */
    var _sigSrc = (sig.source || _inferSource(sig.reason || '')).toLowerCase();
    if (_sigSrc === 'ic') {
      /* Exposure cap: always enforced for IC signals regardless of whether
         ICRiskEngine has loaded. Prevents cap bypass if engine script is slow
         to initialise or fails silently. */
      var _openICUSD = openTrades().filter(function (t) {
        return (t.source || '').toLowerCase() === 'ic';
      }).reduce(function (s, t) { return s + Math.abs(t.size_usd || 0); }, 0);

      var _icCapUSD = _effectiveBal * 0.15;
      var _icAtCap  = window.ICRiskEngine
                        ? ICRiskEngine.isAtMaxICExposure(_cfg.virtual_balance, _openICUSD)
                        : (_openICUSD >= _icCapUSD);   // fallback: raw calculation

      if (_icAtCap) {
        log('RISK', sig.asset + ' IC exposure cap: $' + _openICUSD.toFixed(2) +
            ' open ≥ $' + _icCapUSD.toFixed(2) + ' cap — signal skipped', 'amber');
        riskAmt = 0;
      } else if (window.ICRiskEngine) {
        /* Dynamic multiplier based on rolling IC edge (only when engine is live) */
        var _icMult = ICRiskEngine.getICRiskMultiplier(normaliseAsset(sig.asset));
        if (_icMult !== 1.0) {
          var _beforeIC = riskAmt;
          /* Re-clamp to budget after scaling to preserve portfolio RoR guard */
          riskAmt = Math.min(Math.max(0, remainingBudget), riskAmt * _icMult);
          log('RISK', sig.asset + ' IC scale ' + _icMult.toFixed(2) + 'x: $' +
              _beforeIC.toFixed(2) + ' → $' + riskAmt.toFixed(2), 'dim');
        }
      }
    }
    /* ─────────────────────────────────────────────────────────────────────── */

    var units    = (slDist > 0 && riskAmt > 0) ? riskAmt / slDist : 0;
    // Apply signal leverage: scales notional so a 5× signal produces 5× exposure.
    // The MAX_LEVERAGE cap below still applies as a hard ceiling.
    var _sigLev  = Math.max(1, sig.leverage || 1);
    if (_sigLev > 1) {
      units = units * _sigLev;
      log('RISK', sig.asset + ' leverage ×' + _sigLev + ' applied → notional ×' + _sigLev, 'dim');
    }
    var sizeUsd  = units * entryPrice;

    // Reality check 6 — leverage validation: if notional exceeds MAX_LEVERAGE × balance,
    // scale units down to the cap. Prevents positions a retail broker would reject.
    if (_effectiveBal > 0 && sizeUsd / _effectiveBal > MAX_LEVERAGE) {
      units   = (_effectiveBal * MAX_LEVERAGE) / entryPrice;
      sizeUsd = units * entryPrice;
      log('AUDIT', '⚠ LEVERAGE: ' + sig.asset + ' capped at ' + MAX_LEVERAGE + '× — units reduced to ' + units.toFixed(4), 'amber');
    }

    // Reality check 6b — notional cap: max position = 50% of balance (cash account protection).
    // Prevents $2k+ positions on a $1k account regardless of leverage or Kelly.
    var _maxNotional = _effectiveBal * 0.50;
    if (sizeUsd > _maxNotional) {
      units   = _maxNotional / entryPrice;
      sizeUsd = _maxNotional;
      log('AUDIT', '⚠ SIZE CAP: ' + sig.asset + ' capped at 50% balance ($' + _maxNotional.toFixed(0) + ')', 'amber');
    }

    // Reality check 7 — reject zero-size positions: risk budget exhausted or SL too wide.
    // Previously these slipped through as phantom trades (units=0) blocking asset slots.
    var MIN_SIZE_USD = 1.0;  // absolute floor — $1 minimum position
    if (units <= 0 || sizeUsd < MIN_SIZE_USD) {
      log('RISK', sig.asset + ' rejected — position too small ($' + sizeUsd.toFixed(2) + '): risk budget exhausted or SL distance too wide', 'amber');
      return null;
    }

    return {
      trade_id:        makeId('TRD'),
      signal_id:       makeId('IC-' + normaliseAsset(sig.asset)),
      timestamp_open:  new Date().toISOString(),
      asset:           sig.asset,
      direction:       dir,
      confidence:      sig.conf,
      entry_price:     entryPrice,
      stop_loss:       +stopLoss.toFixed(6),
      take_profit:     +takeProfit.toFixed(6),
      units:           +units.toFixed(6),
      size_usd:        +sizeUsd.toFixed(2),
      mode:            _cfg.mode,
      status:          'OPEN',
      close_price:     null,
      timestamp_close: null,
      pnl_pct:         null,
      pnl_usd:         null,
      close_reason:    null,
      region:           sig.region           || 'GLOBAL',
      reason:           sig.reason           || '',
      matched_keywords: sig.matchedKeywords  || [],  // learning loop: keywords that triggered this trade
      source:           sig.source           || _inferSource(sig.reason || ''),
      kelly_mult:       +kellyMult.toFixed(2),       // EV sizing multiplier applied (for display/audit)
      streak_mult:      +streakMult.toFixed(2),      // loss-streak sizing reduction
      win_streak_mult:  +winStreakMult.toFixed(2),   // win-streak sizing boost
      conf_mult:        +confMult.toFixed(2),        // confidence-tier sizing multiplier
      forex_leveraged:  _fxLeveraged,             // true when 2× forex leverage was applied
      // v61: signal metadata for smart partial TP and trailing logic
      signal_conf:  sig.conf  || 0,
      entry_type:   sig.entryType || ((sig.reason || '').toLowerCase().indexOf('breakout') !== -1 ? 'breakout' : 'other'),
      // ── Trailing / break-even / partial TP state ────────────────────────────
      // v61: breakout trades start with trailing active immediately (no need to wait for partial TP)
      trailing_stop_active: !!(_cfg.trailing_stop_enabled &&
        (sig.entryType === 'breakout' || (sig.reason || '').toLowerCase().indexOf('breakout') !== -1)),
      highest_price:        null,    // LONG: tracks peak price for trail
      lowest_price:         null,    // SHORT: tracks trough price for trail
      break_even_done:      false,   // true once stop moved to entry
      partial_tp_taken:     false,   // true once TP1 partial close fired
      partial_tp_price:     null,    // price at which partial was taken
      partial_pnl_usd:      null,    // P&L banked from partial close
      // ────────────────────────────────────────────────────────────────────────
      venue:            sig._venue || 'HL',  // 'HL' | 'ALPACA' — which platform executed
      broker:           _cfg.mode === 'LIVE' ? _cfg.broker : 'SIMULATION',
      // Broker integration stubs — set by adapter on live execution
      broker_order_id:  null,
      broker_status:    null,
      // Entry thesis fingerprint — stored by gii-entry for exit validation
      thesis:           sig.thesis || null,
      // ── Execution Reality Check audit fields ────────────────────────────────
      raw_entry_price:      null,    // pre-slippage mid price (set by openTrade)
      entry_slippage_pct:   null,    // % degradation applied at entry
      open_commission:      0,       // fee deducted at open
      costs_usd:            0,       // total round-trip cost (open + partial + close)
      funding_periods_paid: 0,       // crypto: 8h funding periods already charged
      raw_close_price:      null,    // pre-slippage exit price (TP/SL level)
      // Price source: HYPERLIQUID when HL WS was live at open; SIMULATED when
      // prices came from backend cache / Yahoo / Binance / etc.
      price_source: (window.HLFeed && typeof HLFeed.isAvailable === 'function' &&
                     HLFeed.isAvailable(normaliseAsset(sig.asset)))
                    ? 'HYPERLIQUID' : 'SIMULATED',
      // Intended leverage from gii-routing (1 = no leverage). The actual
      // notional leverage may differ if risk caps were hit — compare with
      // size_usd / virtual_balance in the UI to see the effective leverage.
      leverage:     sig.leverage || 1,
      // Dollar risk at open (used for R-multiple display in closed trade rows)
      initial_risk_usd: +riskAmt.toFixed(2),
      // Original (pre-routing) asset name if gii-routing remapped it (e.g. GLD→XAU).
      original_asset: sig.original_asset || null,
      // Regime snapshot: market conditions at trade open (GTI level, risk mode, VIX, threat).
      regime: _captureRegime()
    };
  }

  /* Open a trade: build object, persist, sync HRS, log */
  function openTrade(sig, entryPrice) {
    // Belt-and-suspenders: final same-asset guard before writing to _trades.
    // Catches any path that bypassed canExecute (rotation timing, re-scan race, etc.).
    // A11: normalise both sides so "WTI" and "WTI Crude Oil" resolve to the same key
    if (openTrades().some(function (t) { return normaliseAsset(t.asset) === normaliseAsset(sig.asset); })) {
      log('TRADE', sig.asset + ' openTrade blocked — position already open (final guard)', 'amber');
      return;
    }
    // Reality check 1+2 — realistic fill: adjust raw mid-price for spread + slippage
    var dir = sig.dir === 'SHORT' ? 'SHORT' : 'LONG';
    var adjustedEntry = _adjustedEntryPrice(sig.asset, entryPrice, dir);

    var trade = buildTrade(sig, adjustedEntry);

    // Zero-size guard: risk-of-ruin budget can be exhausted by existing open trades,
    // leaving riskAmt=0 for the next signal. Opening a 0-unit trade is pointless —
    // it costs commission, clutters the log, and never closes. Skip it cleanly.
    if (!trade || trade.units < 0.001) {
      _logSignal(sig, 'SKIPPED', 'risk budget exhausted — 0 units available');
      log('TRADE', sig.asset + ' ' + dir + ' skipped — risk budget exhausted by open positions (0 units available)', 'amber');
      return;
    }
    // M7 fix: log TRADED only after confirming units > 0 (trade will actually open)
    _logSignal(sig, 'TRADED', null);

    // Store raw (pre-slippage) price for audit display
    trade.raw_entry_price    = +entryPrice.toFixed(6);
    trade.entry_slippage_pct = +((adjustedEntry / entryPrice - 1) * 100).toFixed(4);
    trade.signal_ts          = sig._signalTs || null;  // for fill-latency measurement

    // Reality check 3 — liquidity: block if position would move the market
    if (!_checkLiquidity(sig.asset, trade.size_usd)) return;

    // Reality check 5 — open commission: deduct immediately so it cannot compound
    var openComm = trade.size_usd * _getCosts(sig.asset).commission;
    trade.open_commission = +openComm.toFixed(4);
    trade.costs_usd       = trade.open_commission;
    _cfg.virtual_balance -= openComm;
    saveCfg();

    // ── Final broker connectivity guard ──────────────────────────────────
    // Abort if the assigned venue's broker is no longer connected at execution
    // time (e.g. disconnected between venue assignment and here). Refund the
    // open commission so the virtual balance stays clean.
    var _brokerReady = (
      (trade.venue === 'HL'         && window.HLBroker    && HLBroker.isConnected())    ||
      (trade.venue === 'ALPACA'     && window.AlpacaBroker && AlpacaBroker.isConnected()) ||
      (trade.venue === 'OANDA'      && window.OANDABroker  && OANDABroker.isConnected())  ||
      (trade.venue === 'TICKTRADER' && window.TTBroker     && TTBroker.isConnected())
    );
    if (!_brokerReady) {
      _cfg.virtual_balance += (trade.open_commission || 0);
      saveCfg();
      _flagTrade(sig, trade.venue + ' broker disconnected at execution — trade aborted.');
      _logSignal(sig, 'SKIPPED', trade.venue + ' broker not ready');
      return;
    }

    _trades.unshift(trade);
    _cooldown[normaliseAsset(sig.asset) + '_' + dir] = Date.now();
    saveTrades();
    _apiPostTrade(trade);   // async push to SQLite (fire-and-forget)

    // ── Fire HL order if this trade is routed to Hyperliquid ─────────────
    if (trade.venue === 'HL' && window.HLBroker && HLBroker.isConnected()) {
      var _hlSide = trade.direction === 'LONG' ? 'buy' : 'sell';
      var _hlLev  = trade.leverage ? Math.round(trade.leverage) : 1;
      HLBroker.placeOrderWithConfirmation(
        trade.asset, null, _hlSide,
        // Fix #19: cloid = idempotency key — HL rejects a second order with the same cloid
        { notional: trade.size_usd, leverage: _hlLev, cloid: trade.trade_id },
        /* onFill */ function (fillPrice, pos) {
          trade.broker_status     = 'FILLED';
          trade.broker_fill_price = fillPrice;
          if (fillPrice > 0 && isFinite(fillPrice)) trade.entry_price = fillPrice;
          if (trade.signal_ts) {
            var _hlLatMs = Date.now() - trade.signal_ts;
            trade.fill_latency_ms = _hlLatMs;
            _fillLatencies.push(_hlLatMs);
            if (_fillLatencies.length > 20) _fillLatencies.shift();
            var _hlAvgLat = Math.round(_fillLatencies.reduce(function(a,b){return a+b;},0) / _fillLatencies.length);
            log('HL', trade.asset + ' fill latency: ' + (_hlLatMs/1000).toFixed(1) + 's (avg ' + (_hlAvgLat/1000).toFixed(1) + 's)', 'dim');
            if (_hlLatMs > 10000) log('HL', '⚠ Slow fill: ' + trade.asset + ' took ' + (_hlLatMs/1000).toFixed(0) + 's — check HL connection', 'amber');
          }
          saveTrades();
          _apiPatchTrade(trade.trade_id, {
            broker_status:     'FILLED',
            broker_fill_price: fillPrice,
            entry_price:       trade.entry_price,
            fill_latency_ms:   trade.fill_latency_ms || null
          });
          log('HL', trade.asset + ' FILLED @ $' + fillPrice.toFixed(4) +
            ' · lev ' + _hlLev + 'x · notional $' + trade.size_usd.toFixed(0), 'green');
          renderUI();
        },
        /* onFail */ function (reason) {
          trade.broker_status   = 'REJECTED';
          trade.broker_error    = 'Order ' + reason;
          trade.status          = 'CLOSED';
          trade.close_reason    = 'BROKER_REJECTED';
          trade.timestamp_close = new Date().toISOString();
          _cfg.virtual_balance += (trade.open_commission || 0);
          saveTrades();
          saveCfg();
          _apiPatchTrade(trade.trade_id, {
            status: 'CLOSED', close_reason: 'BROKER_REJECTED',
            broker_error: trade.broker_error, timestamp_close: trade.timestamp_close
          });
          log('HL', '⚠ Order ' + reason + ' for ' + trade.asset +
            ' — trade closed, commission refunded.', 'red');
          renderUI();
        }
      ).then(function (result) {
        if (!result || !result.ok) return;
        trade.broker_status = 'PENDING_FILL';
        saveTrades();
        log('HL', trade.asset + ' order submitted — awaiting fill', 'cyan');
      }).catch(function (e) {
        trade.broker_status   = 'REJECTED';
        trade.broker_error    = e.message || 'unknown error';
        trade.status          = 'CLOSED';
        trade.close_reason    = 'BROKER_REJECTED';
        trade.timestamp_close = new Date().toISOString();
        _cfg.virtual_balance += (trade.open_commission || 0);
        saveTrades();
        saveCfg();
        _apiPatchTrade(trade.trade_id, {
          status: 'CLOSED', close_reason: 'BROKER_REJECTED',
          broker_error: trade.broker_error, timestamp_close: trade.timestamp_close
        });
        log('HL', '⚠ Order REJECTED for ' + trade.asset + ': ' + trade.broker_error, 'red');
        renderUI();
      });
    }

    // ── Fire Alpaca order if this trade is routed to Alpaca ──────────────
    if (trade.venue === 'ALPACA' && window.AlpacaBroker && AlpacaBroker.isConnected()) {
      var _alpSide = trade.direction === 'LONG' ? 'buy' : 'sell';
      var _MIN_ALPACA_NOTIONAL = 5; // Alpaca minimum order size
      var _buyPow = AlpacaBroker.status().buyingPow;
      if (trade.size_usd < _MIN_ALPACA_NOTIONAL) {
        log('ALPACA', trade.asset + ' order skipped — size $' + trade.size_usd.toFixed(2) +
          ' below Alpaca $' + _MIN_ALPACA_NOTIONAL + ' minimum', 'amber');
        trade.broker_status = 'SKIPPED_MIN_SIZE';
        saveTrades();
      } else if (_buyPow !== null && _buyPow !== undefined && _buyPow < trade.size_usd) {
        log('ALPACA', trade.asset + ' order skipped — insufficient buying power ($' +
          _buyPow.toFixed(2) + ' available, $' + trade.size_usd.toFixed(2) + ' needed)', 'amber');
        trade.broker_status = 'SKIPPED_BUYING_POWER';
        saveTrades();
      } else
      AlpacaBroker.placeOrderWithConfirmation(
        trade.asset, null, _alpSide,
        // Fix #19: client_order_id = idempotency key — Alpaca rejects duplicate IDs
        { notional: trade.size_usd, client_order_id: trade.trade_id },
        /* onFill */ function (fillPrice, order) {
          trade.broker_status     = 'FILLED';
          trade.broker_fill_price = fillPrice;
          if (fillPrice > 0 && isFinite(fillPrice)) trade.entry_price = fillPrice;
          // Signal-to-fill latency tracking
          if (trade.signal_ts) {
            var _latMs = Date.now() - trade.signal_ts;
            trade.fill_latency_ms = _latMs;
            _fillLatencies.push(_latMs);
            if (_fillLatencies.length > 20) _fillLatencies.shift();
            var _avgLat = Math.round(_fillLatencies.reduce(function(a,b){return a+b;},0) / _fillLatencies.length);
            log('ALPACA', trade.asset + ' fill latency: ' + (_latMs/1000).toFixed(1) + 's' +
              ' (avg ' + (_avgLat/1000).toFixed(1) + 's over last ' + _fillLatencies.length + ' fills)', 'dim');
            if (_latMs > 10000) log('ALPACA', '⚠ Slow fill: ' + trade.asset + ' took ' + (_latMs/1000).toFixed(0) + 's — check feed/broker latency', 'amber');
          }
          saveTrades();
          _apiPatchTrade(trade.trade_id, {
            broker_status: 'FILLED',
            broker_fill_price: fillPrice,
            entry_price: trade.entry_price,
            fill_latency_ms: trade.fill_latency_ms || null
          });
          log('ALPACA', trade.asset + ' FILLED @ $' + fillPrice.toFixed(4) +
            ' (order ' + order.id + ')', 'green');
          renderUI();
        },
        /* onFail */ function (reason) {
          trade.broker_status   = 'REJECTED';
          trade.broker_error    = 'Order ' + reason;
          trade.status          = 'CLOSED';
          trade.close_reason    = 'BROKER_REJECTED';
          trade.timestamp_close = new Date().toISOString();
          _cfg.virtual_balance += (trade.open_commission || 0);
          saveTrades();
          saveCfg();
          _apiPatchTrade(trade.trade_id, {
            status: 'CLOSED', close_reason: 'BROKER_REJECTED',
            broker_error: trade.broker_error, timestamp_close: trade.timestamp_close
          });
          log('ALPACA', '⚠ Order ' + reason + ' for ' + trade.asset +
            ' — trade closed, commission refunded.', 'red');
          renderUI();
        }
      ).then(function (order) {
        if (!order) return; // catch path already handled
        trade.broker_order_id = order.id;
        trade.broker_status   = 'PENDING_FILL';
        saveTrades();
        log('ALPACA', trade.asset + ' order submitted: ' + order.id + ' — awaiting fill confirmation (30s max)', 'cyan');
      }).catch(function (e) {
        // placeOrderWithConfirmation itself threw (network/auth error before order was created)
        trade.broker_status   = 'REJECTED';
        trade.broker_error    = e.message || 'unknown error';
        trade.status          = 'CLOSED';
        trade.close_reason    = 'BROKER_REJECTED';
        trade.timestamp_close = new Date().toISOString();
        _cfg.virtual_balance += (trade.open_commission || 0);
        saveTrades();
        saveCfg();
        _apiPatchTrade(trade.trade_id, {
          status: 'CLOSED', close_reason: 'BROKER_REJECTED',
          broker_error: trade.broker_error, timestamp_close: trade.timestamp_close
        });
        log('ALPACA', '⚠ Order REJECTED for ' + trade.asset +
          ' — trade closed, commission refunded. Reason: ' + trade.broker_error, 'red');
        renderUI();
      });
    }

    // ── Fire TickTrader order if this trade is routed there ───────────────
    if (trade.venue === 'OANDA' && window.OANDABroker && OANDABroker.isConnected()) {
      OANDABroker.placeOrder(trade.asset, trade.size_usd, trade.direction, trade)
        .then(function (order) {
          trade.broker_order_id = order.id;
          trade.broker_status   = order.status || 'FILLED';
          if (trade.signal_ts) {
            var _oaLatMs = Date.now() - trade.signal_ts;
            trade.fill_latency_ms = _oaLatMs;
            _fillLatencies.push(_oaLatMs);
            if (_fillLatencies.length > 20) _fillLatencies.shift();
            log('OANDA', trade.asset + ' fill latency: ' + (_oaLatMs/1000).toFixed(1) + 's', 'dim');
            if (_oaLatMs > 10000) log('OANDA', '⚠ Slow fill: ' + trade.asset + ' took ' + (_oaLatMs/1000).toFixed(0) + 's — check OANDA connection', 'amber');
          }
          saveTrades();
          _apiPatchTrade(trade.trade_id, {
            broker_status:   trade.broker_status,
            broker_order_id: trade.broker_order_id,
            fill_latency_ms: trade.fill_latency_ms || null
          });
          log('OANDA', trade.asset + ' order placed: ' + order.id + ' (' + order.status + ')', 'cyan');
          renderUI();
        })
        .catch(function (e) {
          trade.broker_status   = 'REJECTED';
          trade.broker_error    = e.message || 'unknown error';
          trade.status          = 'CLOSED';
          trade.close_reason    = 'BROKER_REJECTED';
          trade.timestamp_close = new Date().toISOString();
          _cfg.virtual_balance += (trade.open_commission || 0);
          saveTrades();
          saveCfg();
          _apiPatchTrade(trade.trade_id, {
            status: 'CLOSED', close_reason: 'BROKER_REJECTED',
            broker_error: trade.broker_error, timestamp_close: trade.timestamp_close
          });
          log('OANDA', '⚠ Order REJECTED for ' + trade.asset + ' — trade closed, commission refunded. Reason: ' + trade.broker_error, 'red');
          renderUI();
        });
    }

    if (trade.venue === 'TICKTRADER' && window.TTBroker && TTBroker.isConnected()) {
      TTBroker.placeOrder(trade.asset, trade.size_usd, trade.direction, trade)
        .then(function (order) {
          trade.broker_order_id = order.id;
          trade.broker_status   = order.status;
          saveTrades();
          log('TT', trade.asset + ' order placed: ' + order.id + ' (' + order.status + ')', 'cyan');
        })
        .catch(function (e) {
          trade.broker_status   = 'REJECTED';
          trade.broker_error    = e.message || 'unknown error';
          trade.status          = 'CLOSED';
          trade.close_reason    = 'BROKER_REJECTED';
          trade.timestamp_close = new Date().toISOString();
          _cfg.virtual_balance += (trade.open_commission || 0);
          saveTrades();
          saveCfg();
          _apiPatchTrade(trade.trade_id, {
            status: 'CLOSED', close_reason: 'BROKER_REJECTED',
            broker_error: trade.broker_error, timestamp_close: trade.timestamp_close
          });
          log('TT', '⚠ Order REJECTED for ' + trade.asset + ' — trade closed, commission refunded. Reason: ' + trade.broker_error, 'red');
          renderUI();
        });
    }

    // Auto-capture in Hit Rate Tracker if available
    if (window.HRS && typeof HRS.capture === 'function') {
      HRS.capture({
        signal_id:       trade.signal_id,
        asset:           trade.asset,
        direction:       trade.direction,
        entry_price:     trade.entry_price,
        target_price:    trade.take_profit,
        stop_loss:       trade.stop_loss,
        confidence:      trade.confidence / 100,
        duration_target: '1w',
        source:          'EE-' + _cfg.mode,
        notes:           trade.reason
      });
    }

    log('OPENED',
      trade.asset + ' ' + trade.direction +
      ' @ ' + _num(trade.entry_price) +
      '  (mid ' + _num(trade.raw_entry_price) + '  slip ' + (trade.entry_slippage_pct > 0 ? '+' : '') + trade.entry_slippage_pct + '%)' +
      '  SL:' + _num(trade.stop_loss) +
      '  TP:' + _num(trade.take_profit) +
      '  Conf:' + trade.confidence + '%' +
      '  comm:-$' + _num(trade.open_commission) +
      (trade.streak_mult < 1 ? '  ⚠ streak×' + trade.streak_mult : '') +
      '  [' + (trade.price_source === 'HYPERLIQUID' ? '🟣 HL' : 'SIM') + ']',
      'green');

    renderUI();
    return trade;
  }

  /* ── Causal Win-Rate Attribution ──────────────────────────────────────────
     Records market conditions at trade close so we can answer:
     "In which macro regimes / VIX ranges / confidence bands do we actually win?"
     Stored in localStorage under 'geodash_attribution_v1' (max 500 records).
     Accessible via EE.attributionStats() for console analysis.           */

  var _ATTR_KEY = 'geodash_attribution_v1';
  var _ATTR_MAX = 500;

  // T2-A: cached attribution win-rate lookup for use in canExecute().
  // Reads from localStorage attribution store and caches per asset+regime for 60s
  // so canExecute() hot-path doesn't hit localStorage on every signal.
  var _attrWinRateCache = {};
  function _attrWinRate(asset, regime) {
    var key = (asset || '') + '|' + (regime || '');
    var c = _attrWinRateCache[key];
    if (c && (Date.now() - c.ts) < 60000) return c.wr;  // 1-min cache
    try {
      var recs = JSON.parse(localStorage.getItem(_ATTR_KEY) || '[]');
      var filtered = recs.filter(function (r) {
        return (!asset || r.asset === asset) && (!regime || r.regime === regime);
      });
      var wr = filtered.length >= 10
        ? filtered.filter(function (r) { return r.win; }).length / filtered.length
        : null;  // insufficient data — don't adjust threshold
      _attrWinRateCache[key] = { wr: wr, ts: Date.now() };
      return wr;
    } catch(e) { return null; }
  }

  function _recordTradeAttribution(trade) {
    try {
      /* Snapshot current market conditions */
      var regime = window.MacroRegime ? MacroRegime.current() : {};
      var opts   = window.OptionsMarket ? OptionsMarket.current() : {};
      var velTop = window.SentimentVelocity
        ? (SentimentVelocity.allStats()[0] || {})
        : {};

      var holdMs  = trade.timestamp_close && trade.timestamp_open
        ? new Date(trade.timestamp_close) - new Date(trade.timestamp_open)
        : null;

      var record = {
        trade_id:      trade.trade_id,
        asset:         trade.asset,
        direction:     trade.direction,
        region:        trade.region || 'GLOBAL',
        confidence:    trade.confidence,
        source:        trade.source || 'ic',
        confluence:    trade.confluenceScore || null,
        pnl_pct:       trade.pnl_pct,
        pnl_usd:       trade.pnl_usd,
        win:           trade.pnl_usd > 0,
        close_reason:  trade.close_reason,
        hold_min:      holdMs !== null ? Math.round(holdMs / 60000) : null,
        ts:            Date.now(),
        /* Conditions at close */
        regime:        regime.regime  || 'UNKNOWN',
        regime_score:  regime.score   || null,
        vix:           regime.vix     || null,
        dxy:           regime.dxy     || null,
        vix_ts:        opts.tsSignal  || null,
        pcr:           opts.pcr       || null,
        vel_region:    velTop.region  || null,
        vel_accel:     velTop.acceleration || null,
        matched_kws:   (trade.matchedKeywords || []).slice(0, 5),
      };

      var stored = [];
      try { stored = JSON.parse(localStorage.getItem(_ATTR_KEY) || '[]'); } catch(e) {}
      stored.unshift(record);
      if (stored.length > _ATTR_MAX) stored.length = _ATTR_MAX;
      localStorage.setItem(_ATTR_KEY, JSON.stringify(stored));
    } catch (e) { /* attribution is non-critical */ }
  }

  /* Close a trade: compute P&L, update balance, sync HRS, log */
  function closeTrade(tradeId, closePrice, reason) {
    var trade = _trades.find(function (t) { return t.trade_id === tradeId; });
    if (!trade || trade.status !== 'OPEN') return;

    trade.status          = 'CLOSED';
    trade.timestamp_close = new Date().toISOString();
    trade.close_reason    = reason;

    // Guard: corrupted or missing close price (NaN, Infinity, 0, negative) must not
    // propagate into P&L. Reject the close and log — the monitor loop will retry.
    var rawClosePrice = parseFloat(closePrice);
    if (!isFinite(rawClosePrice) || rawClosePrice <= 0) {
      log('TRADE', trade.asset + ' closeTrade: invalid closePrice (' + closePrice + ') — close aborted, will retry', 'amber');
      trade.status = 'OPEN';  // revert
      trade.timestamp_close = null;
      trade.close_reason    = null;
      return;
    }

    // Reality check 2 — exit slippage: adjust fill price for spread + market-order slippage.
    // TP = limit order (spread only); SL / manual = market order (spread + slippage gap risk).
    var adjClosePrice = _adjustedExitPrice(trade.asset, rawClosePrice, trade.direction, reason);
    trade.raw_close_price = +rawClosePrice.toFixed(6);
    trade.close_price     = +adjClosePrice.toFixed(6);

    // Guard: invalid entry_price or units would corrupt P&L calculation.
    // undefined * N = NaN in JS; NaN.toFixed(2) throws. Set P&L to 0 and log.
    if (!trade.entry_price || !isFinite(trade.entry_price) || trade.entry_price <= 0 ||
        !trade.units || !isFinite(trade.units)) {
      log('TRADE', trade.asset + ' closeTrade: invalid entry_price (' + trade.entry_price + ') — P&L set to 0', 'amber');
      trade.pnl_pct = 0;
      trade.pnl_usd = 0;
    } else {
      var effClose  = adjClosePrice;
      var rawPnlPct = trade.direction === 'LONG'
        ? (effClose - trade.entry_price) / trade.entry_price * 100
        : (trade.entry_price - effClose) / trade.entry_price * 100;

      trade.pnl_pct = +rawPnlPct.toFixed(2);
      trade.pnl_usd = +(trade.units * Math.abs(effClose - trade.entry_price) * (rawPnlPct >= 0 ? 1 : -1)).toFixed(2);
    }

    // Reality check 5 — close commission: deducted from gross P&L
    var closeComm = (trade.units * adjClosePrice) * _getCosts(trade.asset).commission;
    trade.pnl_usd  = +(trade.pnl_usd - closeComm).toFixed(2);
    trade.costs_usd = +((trade.costs_usd || 0) + closeComm).toFixed(4);

    // NOTE: do NOT subtract funding_cost_usd here.
    // Funding is already deducted from virtual_balance in real-time inside monitorTrades()
    // (balance -= fundingCost each 8h period). Subtracting again here would double-charge
    // the account. The pnl_usd stored on the trade reflects price movement minus commissions;
    // the real-time balance already captures the funding impact separately.

    // Recalculate pnl_pct from the final net pnl_usd (after commission + funding).
    // pnl_pct was set earlier from the raw price move — it doesn't reflect real costs.
    // Avoids the situation where pnl_pct shows +2.5% but pnl_usd shows only +$8 (net fees).
    if (trade.size_usd && trade.size_usd > 0) {
      trade.pnl_pct = +(trade.pnl_usd / trade.size_usd * 100).toFixed(2);
    }

    // Reality check 8 — plausibility: detect wrong-side close prices (price corruption)
    // and cap P&L at theoretical max. Two-tier check:
    //   Tier A (hard): close price moved in wrong direction vs. entry for the given reason.
    //       e.g. LONG+STOP_LOSS close_price > entry_price is impossible — price must fall to hit SL.
    //       Fix: recalculate P&L using the correct SL/TP level.
    //   Tier B (warn): |P&L| > 10× theoretical max even after correct-side check — extreme outlier.
    var isLongClose  = trade.direction === 'LONG';
    var wrongSide    = isLongClose
      ? (reason === 'STOP_LOSS'   && adjClosePrice > trade.entry_price && !trade.trailing_stop_active)   // LONG SL: price must be below entry (unless trailing already in profit)
      || (reason === 'TAKE_PROFIT' && adjClosePrice < trade.entry_price)   // LONG TP: price must be above entry
      : (reason === 'STOP_LOSS'   && adjClosePrice < trade.entry_price && !trade.trailing_stop_active)   // SHORT SL: price must be above entry (unless trailing already in profit)
      || (reason === 'TAKE_PROFIT' && adjClosePrice > trade.entry_price);  // SHORT TP: price must be below entry

    if (wrongSide) {
      // Corrupt price — recalculate using the correct reference level
      var correctRef  = (reason === 'TAKE_PROFIT') ? trade.take_profit : trade.stop_loss;
      var adjCorrect  = _adjustedExitPrice(trade.asset, correctRef, trade.direction, reason);
      var rawPnlCorrect = isLongClose
        ? (adjCorrect - trade.entry_price) / trade.entry_price * 100
        : (trade.entry_price - adjCorrect) / trade.entry_price * 100;
      var correctedPnl = +(trade.units * Math.abs(adjCorrect - trade.entry_price) * (rawPnlCorrect >= 0 ? 1 : -1)).toFixed(2);
      var corrCloseComm = (trade.units * Math.abs(adjCorrect)) * _getCosts(trade.asset).commission;
      correctedPnl = +(correctedPnl - corrCloseComm).toFixed(2);
      log('AUDIT',
        '⚠ PRICE CORRUPTION: ' + trade.asset + ' ' + reason + ' close @ ' + adjClosePrice.toFixed(4) +
        ' is on wrong side of entry ' + trade.entry_price.toFixed(4) +
        ' — P&L corrected from $' + trade.pnl_usd + ' → $' + correctedPnl +
        ' using ' + reason + ' level ' + correctRef.toFixed(4), 'amber');
      trade.close_price    = +adjCorrect.toFixed(6);
      trade.pnl_usd        = correctedPnl;
      trade.pnl_pct        = +rawPnlCorrect.toFixed(2);
      trade.costs_usd      = +((trade.costs_usd || 0) - closeComm + corrCloseComm).toFixed(4);
    } else {
      // Tier B: warn (but don't correct) if P&L still > 10× theoretical max after passing side check
      // (trailing stop can legitimately exceed 2× by riding past original TP, so threshold is 10×)
      // Use original full units (×2 if partial TP has already halved them) for the theoretical max
      // so the check isn't artificially loosened on partial-close trades.
      var fullUnits = trade.partial_tp_taken ? trade.units * 2 : trade.units;
      var theoreticalMax = Math.abs(fullUnits * (trade.take_profit - trade.entry_price));
      if (theoreticalMax > 0 && Math.abs(trade.pnl_usd) > theoreticalMax * 10) {
        log('AUDIT',
          '⚠ PLAUSIBILITY: ' + trade.asset + ' P&L $' + trade.pnl_usd +
          ' is ' + (Math.abs(trade.pnl_usd) / theoreticalMax).toFixed(1) + '× theoretical max $' +
          theoreticalMax.toFixed(2) + ' — check price sources', 'amber');
      }
    }

    // v48 fix: relabel trailing-stop closes that fired in profit.
    // A trailing stop that banked profit should show as 'TRAILING_STOP', not 'STOP_LOSS',
    // so win-rate stats and trade history correctly count it as a win.
    if (reason === 'STOP_LOSS' && trade.trailing_stop_active && trade.pnl_usd > 0) {
      trade.close_reason = 'TRAILING_STOP';
    }

    // C4 fix: store total_pnl_usd = final close P&L + any partial TP P&L already banked.
    // pnl_usd alone only reflects the remaining position at close — analytics uses
    // total_pnl_usd so partial-TP trades aren't misclassified as losses when they're
    // actually net winners (e.g. +$20 partial then -$2 at break-even = +$18 net win).
    trade.total_pnl_usd = +((trade.pnl_usd || 0) + (trade.partial_pnl_usd || 0)).toFixed(2);

    // Update virtual balance (pnl_usd is net of close commission; open commission already deducted at open)
    _cfg.virtual_balance += trade.pnl_usd;
    if (_cfg.virtual_balance < 0) {
      log('RISK', 'Virtual balance negative (' + _cfg.virtual_balance.toFixed(2) +
          ') after closing ' + trade.asset + ' — resetting to $1 to prevent Kelly sizing errors', 'amber');
      _cfg.virtual_balance = 1;
    }
    saveCfg();
    _recordPnlSnapshot('close:' + reason, trade.pnl_usd);

    // Sync outcome back to Hit Rate Tracker
    if (window.HRS && typeof HRS.signals !== 'undefined') {
      var hrsSig = HRS.signals.find(function (s) { return s.signal_id === trade.signal_id; });
      if (hrsSig) {
        // TP/SL are unambiguous; manual closes within ±$5 of breakeven are neutral
        // (avoids inflating win rate from near-zero P&L manual exits)
        var outcome;
        if (trade.close_reason === 'TAKE_PROFIT' || trade.close_reason === 'TRAILING_STOP') {
          outcome = 'hit';
        } else if (trade.close_reason === 'STOP_LOSS') {
          outcome = 'miss';
        } else {
          var pnlAbs = Math.abs(trade.pnl_usd || 0);
          outcome = pnlAbs < 5 ? 'neutral'
                  : (trade.pnl_usd >= 0) ? 'hit' : 'miss';
        }
        HRS.evaluate(hrsSig.signal_id, outcome, closePrice);
      }
    }

    // ── Close HL position if routed there ────────────────────────────────
    if (trade.venue === 'HL' && window.HLBroker && HLBroker.isConnected()) {
      HLBroker.closePosition(trade.asset).catch(function (e) {
        log('HL', '⚠ Close position failed for ' + trade.asset + ': ' + e.message, 'amber');
      });
    }

    // ── Close Alpaca position if routed there ────────────────────────────
    if (trade.venue === 'ALPACA' && window.AlpacaBroker && AlpacaBroker.isConnected()) {
      AlpacaBroker.closePosition(trade.asset).catch(function (e) {
        log('ALPACA', '⚠ Close position failed for ' + trade.asset + ': ' + e.message, 'amber');
      });
    }

    // ── Close OANDA position if routed there ─────────────────────────────
    if (trade.venue === 'OANDA' && window.OANDABroker && OANDABroker.isConnected()) {
      OANDABroker.closePosition(trade.asset, trade.broker_order_id).catch(function (e) {
        log('OANDA', '⚠ Close position failed for ' + trade.asset + ': ' + e.message, 'amber');
      });
    }

    // ── Close TickTrader position if routed there ─────────────────────────
    if (trade.venue === 'TICKTRADER' && window.TTBroker && TTBroker.isConnected()) {
      TTBroker.closePosition(trade.asset, trade.broker_order_id).catch(function (e) {
        log('TT', '⚠ Close position failed for ' + trade.asset + ': ' + e.message, 'amber');
      });
    }

    saveTrades();

    /* ── Causal attribution: record conditions at close for win-rate analysis ── */
    _recordTradeAttribution(trade);

    // Async push updated trade to SQLite (queued, retries on failure)
    _apiPatchTrade(trade.trade_id, {
      status:          trade.status,
      close_price:     trade.close_price,
      timestamp_close: trade.timestamp_close,
      close_reason:    trade.close_reason,
      pnl_pct:         trade.pnl_pct,
      pnl_usd:         trade.pnl_usd,
      // A10: persist total_pnl_usd (pnl_usd + partial_pnl_usd) so analytics
      // correctly classify partial-TP trades after a DB reload
      total_pnl_usd:   trade.total_pnl_usd,
      price_source:    trade.price_source || 'SIMULATED'
    });

    // Check for balance drift after every close (Fix 5)
    setTimeout(_reconcileBalance, 3000);

    log('CLOSED',
      trade.asset + ' ' + trade.direction +
      ' → ' + reason +
      ' @ ' + _num(trade.close_price) +
      '  (raw ' + _num(trade.raw_close_price) + ')' +
      '  P&L: ' + (trade.pnl_pct >= 0 ? '+' : '') + trade.pnl_pct + '%' +
      '  (' + (trade.pnl_usd >= 0 ? '+$' : '-$') + _num(Math.abs(trade.pnl_usd)) + ' net)' +
      '  costs:-$' + _num(trade.costs_usd),
      trade.pnl_pct >= 0 ? 'green' : 'red');

    // Browser notification for TP/SL hits (only when tab is not visible)
    if ((trade.close_reason === 'TAKE_PROFIT' || trade.close_reason === 'STOP_LOSS' || trade.close_reason === 'TRAILING_STOP') &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted') {
      var isTP   = trade.close_reason === 'TAKE_PROFIT' || trade.close_reason === 'TRAILING_STOP';
      var sign   = trade.pnl_usd >= 0 ? '+' : '-';
      var pnlStr = sign + '$' + _num(Math.abs(trade.pnl_usd)) +
                   ' (' + (trade.pnl_pct >= 0 ? '+' : '') + trade.pnl_pct + '%)';
      try {
        var _ntfLabel = trade.close_reason === 'TAKE_PROFIT' ? '✅ Take Profit'
                      : trade.close_reason === 'TRAILING_STOP' ? '🎯 Trailing Stop'
                      : '❌ Stop Loss';
        new Notification(
          _ntfLabel + ' — ' + trade.asset,
          {
            body: trade.direction + ' closed @ ' + _num(closePrice) + '\nP&L: ' + pnlStr,
            icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="' + (isTP ? '%2300e676' : '%23ff1744') + '"/></svg>',
            tag: 'ee-trade-' + trade.trade_id,
            requireInteraction: false
          }
        );
      } catch (e) { /* notification may fail silently */ }
    }

    // Per-direction streak tracking — loss streak reduces size; win streak is display-only.
    // Fix #9: update BOTH the sector-specific key AND the global direction key.
    // The sector key is used for fine-grained sizing; the global key is used as
    // a fallback for assets without a sector-level history. Both stay in sync.
    var _tradeDir = (trade.direction || 'LONG').toLowerCase() === 'short' ? 'short' : 'long';
    var _tradeSector = EE_SECTOR_MAP[normaliseAsset(trade.asset)] || 'other';
    var _tradeSectorKey = _tradeDir + '_' + _tradeSector;
    if (trade.pnl_usd > 0) {
      // Win: reset sector loss streak + global direction streak
      if (_lossStreak[_tradeSectorKey] > 0) log('RISK', trade.asset + ' [' + _tradeSector + '] ' + _tradeDir + ' loss streak ended at ' + _lossStreak[_tradeSectorKey] + ' — full size restored', 'green');
      _lossStreak[_tradeSectorKey] = 0;
      _lossStreak[_tradeDir] = Math.max(0, (_lossStreak[_tradeDir] || 0) - 1); // global decays gradually
      _winStreak[_tradeDir] = (_winStreak[_tradeDir] || 0) + 1;
      if (_winStreak[_tradeDir] === 3) log('RISK', _tradeDir.toUpperCase() + ' win streak ' + _winStreak[_tradeDir] + ' 🔥 (informational — no size change)', 'green');
      else if (_winStreak[_tradeDir] > 3) log('RISK', _tradeDir.toUpperCase() + ' win streak ' + _winStreak[_tradeDir] + ' 🔥', 'green');
    } else {
      // Loss: increment sector streak + global direction streak
      if (_winStreak[_tradeDir] >= 3) log('RISK', _tradeDir.toUpperCase() + ' win streak ended at ' + _winStreak[_tradeDir], 'dim');
      _winStreak[_tradeDir] = 0;
      _lossStreak[_tradeSectorKey] = (_lossStreak[_tradeSectorKey] || 0) + 1;
      _lossStreak[_tradeDir] = (_lossStreak[_tradeDir] || 0) + 1;
      var _displayStreak = _lossStreak[_tradeSectorKey];
      if (_displayStreak >= 3)      log('RISK', trade.asset + ' [' + _tradeSector + '] ' + _tradeDir + ' streak ' + _displayStreak + ' losses — position size halved', 'red');
      else if (_displayStreak >= 2) log('RISK', trade.asset + ' [' + _tradeSector + '] ' + _tradeDir + ' streak ' + _displayStreak + ' losses — position size at 75%', 'amber');
    }

    // Reversal cooldown: after a stop-loss, block the opposite direction on this asset
    // for 5 minutes to prevent immediately flipping into a whipsaw trade.
    // (Normal per-direction cooldown was already set in openTrade.)
    if (reason === 'STOP_LOSS' || reason === 'GII-EXIT:SL') {
      var _slAsset  = normaliseAsset(trade.asset);
      var _oppDir   = trade.direction === 'LONG' ? 'SHORT' : 'LONG';
      var _revExpiry = Date.now() + 5 * 60 * 1000;  // 5-minute reversal block
      _reversalCooldown[_slAsset + '_' + _oppDir] = _revExpiry;
      log('RISK', trade.asset + ' stop-loss → ' + _oppDir + ' reversal blocked for 5 min', 'amber');
    }

    // M2+M3 fix: clean up per-trade runtime maps when a trade closes.
    // _livePrice and _lastPriceTs entries for closed trade IDs are never read again
    // but accumulate indefinitely — one entry per closed trade.
    delete _livePrice[tradeId];
    delete _lastPriceTs[tradeId];

    renderUI();

    /* Learning loop feedback: notify dashboard of trade outcome */
    if (typeof window.onTradeClose === 'function') window.onTradeClose(trade);
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     SIGNAL LISTENER — called by renderTrades() each IC cycle
     Signature: EE.onSignals(sigs)
     sigs: Array<{ asset, dir, conf, reason, region }>
     ══════════════════════════════════════════════════════════════════════════════ */

  /* Validate a signal object before it enters the execution pipeline.
     Returns { ok: true } or { ok: false, reason: string }.
     Rejects malformed/incomplete signals before they hit canExecute. */
  function validateSignal(sig) {
    if (!sig || typeof sig !== 'object')
      return { ok: false, reason: 'Signal is not an object' };
    if (!sig.asset || typeof sig.asset !== 'string' || sig.asset.trim().length < 1)
      return { ok: false, reason: 'Signal missing valid asset' };
    if (!sig.dir || ['LONG', 'SHORT', 'WATCH'].indexOf(sig.dir) === -1)
      return { ok: false, reason: 'Signal dir must be LONG/SHORT/WATCH, got: ' + sig.dir };
    if (typeof sig.conf !== 'number' || isNaN(sig.conf) || sig.conf < 0 || sig.conf > 100)
      return { ok: false, reason: 'Signal conf must be 0–100, got: ' + sig.conf };
    return { ok: true };
  }

  // Rate limiter state for runaway signal protection
  var _sigRateWindow = 0;   // start of current 10s window
  var _sigRateCount  = 0;   // signals processed in current window
  var _SIG_RATE_LIMIT = 50; // max signals per 10s before throttling

  // T2-B: signal fusion — when multiple independent agents agree on the same asset+direction
  // within a single batch, merge them into the highest-confidence signal with a confidence
  // boost. +4% per extra confirming agent, capped at +10%. This boosts multi-agent
  // confluence trades above the min_confidence floor naturally without special-casing.
  function _fuseSignals(sigs) {
    var groups = {};
    sigs.forEach(function (s) {
      var key = normaliseAsset(s.asset || '') + '|' + ((s.dir || s.direction || s.bias || '')).toUpperCase();
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    });
    return Object.keys(groups).map(function (k) {
      var g = groups[k];
      if (g.length === 1) return g[0];
      // Pick the signal with the highest confidence as the base
      var best = g.reduce(function (a, b) {
        return ((b.conf || b.confidence || 0) > (a.conf || a.confidence || 0)) ? b : a;
      });
      var fused = Object.assign({}, best);
      var boost = Math.min(10, (g.length - 1) * 4);  // +4% per extra agent, max +10%
      fused.conf       = Math.min(100, (fused.conf       || 60) + boost);
      fused.confidence = Math.min(100, (fused.confidence || 60) + boost);
      fused._fusedFrom = g.map(function (s) { return s.source || 'unknown'; });
      fused.srcCount   = Math.max(fused.srcCount || 1, g.length);  // satisfy confirmation gate
      log('SIGNAL', fused.asset + ' fused: ' + g.length + ' agents agree → conf boosted to ' + fused.conf + '%' +
          (boost ? ' (+' + boost + '%)' : '') + ' sources: [' + fused._fusedFrom.join(', ') + ']', 'cyan');
      return fused;
    });
  }

  function onSignals(sigs) {
    if (!sigs || !sigs.length) return;

    // Circuit breaker: if an agent goes haywire and floods >50 signals/10s, throttle it.
    var _now = Date.now();
    if (_now - _sigRateWindow > 10000) { _sigRateWindow = _now; _sigRateCount = 0; }
    // A16: trim to the remaining quota rather than dropping the entire batch —
    // if 48 signals have passed and a batch of 5 arrives, 2 are legitimate.
    var _quota = Math.max(0, _SIG_RATE_LIMIT - _sigRateCount);
    if (sigs.length > _quota) {
      log('SYSTEM', '⚠ Signal rate limit — accepting ' + _quota + '/' + sigs.length +
        ' signal(s) this window (' + _sigRateCount + '/' + _SIG_RATE_LIMIT + ' used)', 'warn');
      sigs = sigs.slice(0, _quota);
    }
    _sigRateCount += sigs.length;

    /* Auto-halt on extreme signal storm (>150 signals in a 10s window = clear malfunction).
       Activates the kill switch and logs loudly. Human must call EE.resume() to re-enable.
       Normal busy cycles peak around 10-20 signals; 150 indicates a runaway agent loop.  */
    if (_sigRateCount > 150) {
      if (!_halted) {
        _halted = true;
        log('SYSTEM', '🛑 AUTO KILL SWITCH — signal storm detected (' + _sigRateCount +
          ' signals in 10s). All execution halted. Investigate agents, then call EE.resume().', 'warn');
      }
      return;
    }
    if (!sigs.length) return;

    // T2-B: fuse multi-agent agreement before processing
    sigs = _fuseSignals(sigs);

    _lastSignals = sigs;                 // always cache — re-scan loop needs these

    sigs.forEach(function (sig) {
      sig._signalTs = sig._signalTs || Date.now(); // stamp entry time for fill-latency tracking
      // ── Field normalisation ─────────────────────────────────────────────────────
      // New signal agents (technicals, crypto-signals, correlation, momentum, etc.)
      // send { bias, confidence (0-1 float), reasoning } instead of { dir, conf (0-100), reason }.
      // market-observer sends direction as lowercase 'long'/'short'.
      // Normalise here so ALL agents work without modifying every agent file.
      if (sig.bias      !== undefined && sig.dir  === undefined) sig.dir  = sig.bias;
      if (sig.direction !== undefined && sig.dir  === undefined) sig.dir  = sig.direction;
      if (sig.dir) sig.dir = sig.dir.toUpperCase();   // 'long' → 'LONG', 'short' → 'SHORT'
      if (sig.confidence !== undefined && sig.conf === undefined) {
        var _numConf = typeof sig.confidence === 'number' ? sig.confidence : parseFloat(sig.confidence) || 0;
        var _rawConf = _numConf <= 1 ? Math.round(_numConf * 100) : _numConf;
        sig.conf = Math.max(0, Math.min(100, _rawConf));  // clamp: agent could send out-of-range value
      }
      if (sig.reasoning !== undefined && sig.reason === undefined) sig.reason = sig.reasoning;
      // ───────────────────────────────────────────────────────────────────────────

      // Asset remap: replace untradeable index/spot assets with their tradeable proxies.
      // Mutates a shallow copy so the original signal object is not modified.
      if (sig.asset && ASSET_REMAP[normaliseAsset(sig.asset)]) {
        var remapped = ASSET_REMAP[normaliseAsset(sig.asset)];
        log('SYSTEM', sig.asset + ' remapped → ' + remapped + ' (untradeable asset replaced with proxy)', 'dim');
        sig = Object.assign({}, sig, { asset: remapped });
      }

      // GII Routing: check if there is a better HL instrument (e.g. GLD → XAU)
      // and whether leverage improves EV for this confidence level.
      // Runs after ASSET_REMAP so routing sees the final tradeable asset name.
      if (window.GII_ROUTING && typeof GII_ROUTING.route === 'function') {
        var _routed = GII_ROUTING.route(sig);
        if (_routed && _routed !== sig) {
          var _routeNote = (_routed.asset !== sig.asset)
            ? sig.asset + ' → ' + _routed.asset + (_routed.leverage > 1 ? ' ' + _routed.leverage + '×' : '')
            : (_routed.leverage > 1 ? sig.asset + ' ' + _routed.leverage + '× lev' : null);
          if (_routeNote) log('ROUTING', _routeNote, 'purple');
          sig = _routed;
        }
      }

      // Pre-validate signal shape before any further processing
      var valid = validateSignal(sig);
      if (!valid.ok) {
        log('SYSTEM', 'Invalid signal dropped: ' + valid.reason, 'dim');
        return;
      }

      // WATCH signals: log but never execute
      if (sig.dir === 'WATCH') {
        _logSignal(sig, 'WATCH', null);
        return;
      }

      // ── Venue router: HL → Alpaca → TickTrader → flag ───────────────────────
      // Runs before the enabled check so every signal is routed or captured.
      // Priority: HL perps first (lowest cost), then Alpaca (US equities),
      // then TickTrader (forex majors), else flag for future integration.
      //
      // CIRCUIT BREAKER: if HL WebSocket has been silent for >5 minutes we
      // treat HL as unavailable for new trades — prices are too stale to size
      // positions reliably. Open trades already being monitored are unaffected.
      // Signal falls through to the next available venue (Alpaca/OANDA).
      var _hlStale = (function () {
        if (!window.HLFeed) return false;
        try {
          var st = HLFeed.status();
          if (!st.lastTs) return false;                   // never connected — not stale
          return (Date.now() - st.lastTs) > 300000;       // > 5 minutes since last tick
        } catch (e) { return false; }
      })();
      if (_hlStale) {
        log('SYSTEM', 'HL price feed stale (>5 min) — bypassing HL venue for ' + sig.asset, 'warn');
      }

      var _asset = normaliseAsset(sig.asset);
      var _venue;
      /* HL venue requires BOTH a price feed AND a broker execution layer.
         HLFeed provides prices only — without HLBroker, fall through to Alpaca.
         In SIMULATION mode: accept HL as a venue even with $0 equity — no real orders
         are sent, so the equity guard (which protects live execution) is unnecessary.
         In LIVE mode: full isConnected() check including equity > 0 is required. */
      var _hlReady = !_hlStale && window.HLFeed && HLFeed.covers(_asset) &&
          window.HLBroker && typeof HLBroker.isConnected === 'function';
      var _hlConnectedCheck = _hlReady && (
          HLBroker.isConnected() ||
          (_cfg.broker === 'SIMULATION' && HLBroker.status && HLBroker.status().connected)
      );
      if (_hlConnectedCheck) {
        _venue = 'HL';
      } else if (window.AlpacaBroker && AlpacaBroker.isConnected() && AlpacaBroker.covers(_asset)) {
        // Alpaca spot crypto cannot be shorted (buy-only). Block crypto SHORTs only.
        // Stock shorts are fine — Alpaca paper supports margin shorting for equities.
        var _isAlpacaCrypto = window.AlpacaBroker && typeof AlpacaBroker.isCrypto === 'function'
          ? AlpacaBroker.isCrypto(_asset)
          : !!(window.AlpacaBroker && AlpacaBroker.covers(_asset) &&
               ['BTC','ETH','SOL','XRP','DOGE','LTC','AVAX','LINK','BCH','UNI','AAVE','DOT','ADA','BNB','SHIB'].indexOf(_asset.toUpperCase()) !== -1);
        if (sig.dir === 'SHORT' && _isAlpacaCrypto) {
          _flagTrade(sig, 'Alpaca spot crypto cannot be shorted — ' + _asset + ' is buy-only on Alpaca.');
          _logSignal(sig, 'SKIPPED', 'Alpaca crypto no-short: ' + _asset);
          return;
        }
        _venue = 'ALPACA';
      } else if (window.OANDABroker && OANDABroker.isConnected() && OANDABroker.covers(_asset)) {
        _venue = 'OANDA';
      } else if (window.TTBroker && TTBroker.isConnected() && TTBroker.covers(_asset)) {
        _venue = 'TICKTRADER';
      } else {
        _flagTrade(sig, 'No venue — not on Hyperliquid, Alpaca, OANDA, or TickTrader. Add broker for this asset.');
        _logSignal(sig, 'SKIPPED', 'No venue: ' + sig.asset);
        return;
      }
      sig = Object.assign({}, sig, { _venue: _venue });

      if (!_cfg.enabled) {
        _logSignal(sig, 'SKIPPED', 'Auto-execution paused');
        return;
      }

      var check = canExecute(sig);
      if (!check.ok) {
        _logSignal(sig, 'SKIPPED', check.reason);
        return;
      }

      // All checks passed — acquire pending lock, then fetch price and open.
      // Fix #5: add a 30s safety timeout on the lock. If fetchPrice hangs (network
      // timeout, dead CORS proxy, etc.) the callback may never fire, leaving
      // _pendingOpen[asset]=true forever and permanently blocking that asset.
      var _lockKey = normaliseAsset(sig.asset);
      _pendingOpen[_lockKey] = true;
      var _pendingTimer = setTimeout(function () {
        if (_pendingOpen[_lockKey]) {
          delete _pendingOpen[_lockKey];
          log('TRADE', sig.asset + ' pending-open lock cleared after 30s timeout — fetchPrice may have hung', 'amber');
        }
      }, 30000);
      fetchPrice(sig.asset, function (price) {
        clearTimeout(_pendingTimer);
        // M1 fix: hold the lock through the post-fetch canExecute re-check.
        // Releasing here and re-checking below left a brief window where a second
        // signal for the same asset (e.g. from re-scan) could pass canExecute
        // concurrently. Lock stays until openTrade() completes or is rejected.
        // _pendingOpen[_lockKey] = true; ← keep held, delete after recheck below
        if (!price) {
          delete _pendingOpen[_lockKey]; // release on early-out paths
          // No price available — skip this trade entirely rather than open at
          // a meaningless $100 fallback which would corrupt P&L. The 5-min
          // re-scan loop will retry this signal when a price becomes available.
          _logSignal(sig, 'SKIPPED', 'Price unavailable — will retry');
          log('TRADE', sig.asset + ' skipped: no price feed. Re-scan will retry.', 'amber');
          return;
        }
        // Re-validate after async gap — another signal for same asset may have
        // opened while price was being fetched (fixes duplicate-position race condition).
        // Lock is still held through this check (M1 fix), so pass _skipPendingCheck=true
        // to avoid canExecute rejecting the trade on its own lock.
        var recheck = canExecute(sig, true);
        if (!recheck.ok) {
          delete _pendingOpen[_lockKey]; // release on reject
          _logSignal(sig, 'SKIPPED', 'post-fetch recheck: ' + recheck.reason);
          return;
        }
        // Stale-price guard: if the price in cache is older than 10 minutes,
        // refuse to open — stale prices cause badly-sized positions (e.g. GLD
        // fallback to Gold Futures ~$4456 when HL disconnects).
        var _staleTok = normaliseAsset(sig.asset);
        var _priceAge = _priceCacheTs[_staleTok] ? (Date.now() - _priceCacheTs[_staleTok]) : Infinity;
        if (_priceAge > _PRICE_STALE_RESCAN) {
          delete _pendingOpen[_lockKey]; // release on reject
          _logSignal(sig, 'SKIPPED', 'Stale price (' + Math.round(_priceAge / 60000) + ' min old) — refusing trade on ' + sig.asset);
          log('TRADE', sig.asset + ' skipped: price is ' + Math.round(_priceAge / 60000) + ' min old (limit 10 min). Re-scan will retry when feed recovers.', 'amber');
          return;
        }
        delete _pendingOpen[_lockKey]; // release only after all checks pass, immediately before openTrade
        // M7 fix: _logSignal(TRADED) moved to inside openTrade() after the zero-size guard.
        // Previously it fired here before openTrade, so a risk-budget-exhausted rejection
        // still showed as TRADED in the signal log with no actual trade opened.
        openTrade(sig, price);
      });
    });
  }

  /* ── Live broker equity polling ─────────────────────────────────────────────
     Fetches real equity from every connected broker every 60 seconds.
     Result is used by _getEffectiveBalance() for all position sizing so the EE
     always works from the real portfolio size, not a manually-set static number.
     virtual_balance is kept for P&L accounting and session tracking only.      */
  function _pollBrokerEquity() {
    var total   = 0;
    var sources = [];
    var checks  = [];

    if (window.HLBroker && HLBroker.isConnected()) {
      checks.push(
        Promise.resolve().then(function () {
          try {
            var s = HLBroker.status();
            if (s && s.equity > 0) { total += s.equity; sources.push('HL:$' + s.equity.toFixed(2)); }
          } catch (e) {}
        })
      );
    }

    if (window.AlpacaBroker && AlpacaBroker.isConnected()) {
      checks.push(
        AlpacaBroker.getAccount().then(function (acct) {
          var eq = parseFloat(acct.equity || acct.portfolio_value || 0);
          if (eq > 0) { total += eq; sources.push('Alpaca:$' + eq.toFixed(2)); }
        }).catch(function () {})
      );
    }

    if (window.OANDABroker && OANDABroker.isConnected()) {
      checks.push(
        OANDABroker.getAccount().then(function (acct) {
          var nav = acct && parseFloat(acct.nav || 0);
          if (nav > 0) {
            // Fix #1: Convert OANDA nav to USD if account is in a non-USD currency (e.g. GBP).
            // OANDABroker.getAccount() returns nav in the account's base currency.
            // Without conversion, £1,024 would be added as $1,024 — a ~21% error at 1.27 fx.
            var currency = (acct.currency || 'USD').toUpperCase();
            var navUsd = nav;
            if (currency !== 'USD') {
              // Prefer live OANDA_RATES feed; fall back to a conservative GBP/USD estimate
              var _fxPair = currency + 'USD';
              var _fxRate = null;
              if (window.OANDA_RATES && typeof OANDA_RATES.getRate === 'function') {
                var _rateObj = OANDA_RATES.getRate(_fxPair);
                if (_rateObj && _rateObj.mid && _rateObj.mid > 0) _fxRate = _rateObj.mid;
              }
              if (!_fxRate) {
                // Static fallbacks for common account currencies
                var _fxFallbacks = { GBP: 1.27, EUR: 1.08, CAD: 0.74, AUD: 0.65, JPY: 0.0067, CHF: 1.12 };
                _fxRate = _fxFallbacks[currency] || 1.0;
                log('SYSTEM', 'OANDA: no live rate for ' + _fxPair + ', using fallback ' + _fxRate, 'dim');
              }
              navUsd = nav * _fxRate;
              sources.push('OANDA:$' + navUsd.toFixed(2) + ' (' + currency + nav.toFixed(0) + ' @' + _fxRate.toFixed(4) + ')');
            } else {
              sources.push('OANDA:$' + navUsd.toFixed(2));
            }
            total += navUsd;
          }
        }).catch(function () {})
      );
    }

    if (!checks.length) return;   // no brokers connected yet

    Promise.all(checks).then(function () {
      if (total > 0) {
        var prev = _liveBrokerEquity;
        _liveBrokerEquity   = total;
        _liveBrokerEquityTs = Date.now();
        _liveBrokerSources  = sources;
        // Log only when equity changes by > $1 to avoid noise
        if (prev === null || Math.abs(total - prev) > 1) {
          log('SYSTEM', 'Portfolio equity updated: $' + total.toFixed(2) +
            ' (' + sources.join(', ') + ')', 'dim');
        }
        // Auto-update virtual_balance to stay aligned with real equity
        // so session P&L tracking stays meaningful.
        // Allow update on the very first poll (prev === null) so the stale
        // manually-set value is replaced immediately on page load.
        // Fix #2: Use symmetric guard — compare change against the LARGER of the two values
        // so large downward corrections (e.g. recovering from an inflated cached value) are
        // allowed through. Previous: Math.abs(total-prev) < total*0.5 blocked drops >50% of
        // the NEW value, meaning a correction from $4,159→$2,218 was permanently stuck.
        // New: allow changes up to 60% of whichever value is bigger (symmetrical).
        var _glitchGuard = prev === null || Math.abs(total - prev) < Math.max(total, prev) * 0.6;
        if (_glitchGuard) {
          _cfg.virtual_balance = total;
          saveCfg();
        } else {
          log('SYSTEM', '⚠ Broker equity change >' + Math.round(Math.abs(total - prev) / Math.max(total, prev) * 100) + '% ($' + (prev||0).toFixed(0) + '→$' + total.toFixed(0) + ') — possible API glitch, skipping update', 'amber');
        }
      }
    });
  }

  /* Returns the balance to use for ALL position sizing decisions.
     Prefers live broker equity (fresh within 3 min) over virtual_balance. */
  function _getEffectiveBalance() {
    // Fix #11: extend staleness threshold to 5 min (within one poll cycle) and log
    // when the fallback activates so the user knows position sizing is using cached data.
    var EQUITY_STALE_MS = 5 * 60 * 1000;  // was 3 min — extended to one full poll cycle
    var age   = _liveBrokerEquityTs ? (Date.now() - _liveBrokerEquityTs) : Infinity;
    var fresh = _liveBrokerEquity !== null && age < EQUITY_STALE_MS;
    if (!fresh && _liveBrokerEquity !== null && age < 30 * 60 * 1000) {
      // Warn once per 10 min to avoid log spam during short connectivity gaps
      var _lastWarn = _getEffectiveBalance._lastWarnTs || 0;
      if (Date.now() - _lastWarn > 10 * 60 * 1000) {
        _getEffectiveBalance._lastWarnTs = Date.now();
        log('RISK', '⚠ Live broker equity stale (' + Math.round(age / 1000) + 's) — position sizing from cached virtual_balance $' + _cfg.virtual_balance.toFixed(0), 'amber');
      }
    }
    return fresh ? _liveBrokerEquity : _cfg.virtual_balance;
  }

  /* ── Balance reconciliation (Fix 5) ─────────────────────────────────────────
     After each trade closes, or on demand, compare EE virtual_balance against
     the sum of connected broker equities. If they diverge by > 5%, log a warning
     and expose EE.syncBalance() to auto-correct from the broker.               */
  function _reconcileBalance() {
    var brokerEquity = 0;
    var brokersChecked = 0;

    function _check(equity) {
      if (!equity || !isFinite(equity) || equity <= 0) return;
      brokerEquity += equity;
      brokersChecked++;
    }

    // Collect equity from each connected broker
    if (window.HLBroker && HLBroker.isConnected()) {
      try { _check(HLBroker.status().equity); } catch (e) {}
    }
    if (window.AlpacaBroker && AlpacaBroker.isConnected()) {
      try { _check(AlpacaBroker.status().equity); } catch (e) {}
    }
    if (window.OANDABroker && OANDABroker.isConnected()) {
      try { _check(OANDABroker.status().nav); } catch (e) {}   // OANDA uses .nav not .equity
    }

    if (!brokersChecked || brokerEquity <= 0) return;

    var vb   = _cfg.virtual_balance;
    var diff = Math.abs(vb - brokerEquity);
    // A23: use max(vb, brokerEquity) as denominator — if vb hits the $1 floor after
    // a catastrophic loss the pct would explode vs real broker equity, spamming the log.
    var _driftBase = Math.max(vb, brokerEquity);
    var pct  = _driftBase > 0 ? diff / _driftBase * 100 : 100;

    if (pct > 5) {
      log('SYSTEM',
        '⚠ Balance drift detected: EE virtual $' + vb.toFixed(2) +
        ' vs broker equity $' + brokerEquity.toFixed(2) +
        ' (' + pct.toFixed(1) + '% gap). Run EE.syncBalance() to reconcile.',
        'amber');
    }
  }

  /* ── Alpaca position reconciliation ─────────────────────────────────────────
     Compares EE's in-memory OPEN Alpaca trades against actual Alpaca positions.
     • EE open + Alpaca has position   → all good
     • EE open + Alpaca no position    → closed externally (manual, margin, API) → close in EE
     • Alpaca position + no EE trade   → orphan (opened outside EE) → log warning
     Runs every 5 minutes and also exposed as EE.reconcileAlpaca() for manual use. */
  function _reconcileAlpacaPositions() {
    if (!window.AlpacaBroker || !AlpacaBroker.isConnected()) return;
    AlpacaBroker.getPositions()
      .then(function (positions) {
        var alpacaSymbols = new Set(
          (positions || []).map(function (p) { return (p.symbol || '').toUpperCase(); })
        );
        var eeAlpacaTrades = openTrades().filter(function (t) {
          return t.venue === 'ALPACA' && t.broker_status === 'FILLED';
        });

        // Trades EE thinks are open but Alpaca no longer has
        eeAlpacaTrades.forEach(function (trade) {
          if (!alpacaSymbols.has(trade.asset.toUpperCase())) {
            var closeAt = _livePrice[trade.trade_id] ||
                          _priceCache[normaliseAsset(trade.asset)] ||
                          trade.entry_price;
            log('ALPACA', trade.asset + ' position missing from Alpaca — closed externally. Closing in EE at $' +
              (closeAt || 0).toFixed(4), 'amber');
            closeTrade(trade.trade_id, closeAt || trade.entry_price, 'EXTERNALLY_CLOSED');
          }
        });

        // Positions in Alpaca not tracked by EE
        (positions || []).forEach(function (pos) {
          var sym = (pos.symbol || '').toUpperCase();
          var eeMatch = eeAlpacaTrades.some(function (t) { return t.asset.toUpperCase() === sym; });
          if (!eeMatch) {
            log('ALPACA', '⚠ Orphan Alpaca position: ' + sym +
              ' (not in EE trades) — manually opened or from a prior session', 'amber');
          }
        });
      })
      .catch(function () { /* silent — Alpaca may be temporarily unavailable */ });
  }

  // T1-A: HL position reconciliation — mirrors _reconcileAlpacaPositions().
  // If HL liquidates a position (margin call, exchange risk limit, server-side close),
  // the EE trade stays permanently OPEN, corrupting balance and blocking the asset slot.
  // This runs every 5 minutes alongside Alpaca reconciliation.
  var _lastHLReconcile = 0;
  function _reconcileHLPositions() {
    if (!window.HLBroker || typeof HLBroker.isConnected !== 'function' || !HLBroker.isConnected()) return;
    if (typeof HLBroker.getOpenPositions !== 'function') return;
    var now = Date.now();
    if (now - _lastHLReconcile < 4 * 60 * 1000) return;  // dedupe: max once per 4 min
    _lastHLReconcile = now;
    var hlTrades = openTrades().filter(function (t) {
      return t.venue === 'HL' && t.broker_status === 'FILLED' && t.broker_order_id;
    });
    if (!hlTrades.length) return;
    HLBroker.getOpenPositions(function (hlPositions) {
      // Safety: if HL returns an empty/null list, it almost certainly means the connection
      // isn't fully established yet, not that every position was liquidated simultaneously.
      // An empty response with open EE trades = connection gap, not mass liquidation.
      // Only close trades when HL reports AT LEAST ONE position (proves the feed is live).
      if (!hlPositions || !hlPositions.length) {
        log('HL', 'Reconciliation skipped — HL returned empty position list (connection not ready?). ' + hlTrades.length + ' EE trade(s) left open.', 'amber');
        return;
      }
      var hlAssets = {};
      hlPositions.forEach(function (p) { hlAssets[normaliseAsset(p.asset || p.coin || '')] = p; });
      hlTrades.forEach(function (t) {
        if (!hlAssets[normaliseAsset(t.asset)]) {
          var fallback = _livePrice[t.trade_id] || _priceCache[normaliseAsset(t.asset)] || t.entry_price;
          log('HL', t.asset + ' confirmed missing from HL position list — closing as LIQUIDATED @ $' + (fallback || 0).toFixed(4), 'red');
          closeTrade(t.trade_id, fallback || t.entry_price, 'LIQUIDATED');
        }
      });
    });
  }

  // OANDA position reconciliation — mirrors _reconcileAlpacaPositions().
  // Catches trades closed externally (margin, API, manual) that EE never saw.
  var _lastOANDAReconcile = 0;
  function _reconcileOANDAPositions() {
    if (!window.OANDABroker || !OANDABroker.isConnected()) return;
    var now = Date.now();
    if (now - _lastOANDAReconcile < 4 * 60 * 1000) return;  // dedupe: max once per 4 min
    _lastOANDAReconcile = now;
    var oandaTrades = openTrades().filter(function (t) {
      return t.venue === 'OANDA' && t.broker_status === 'FILLED';
    });
    if (!oandaTrades.length) return;
    OANDABroker.getPositions()
      .then(function (positions) {
        if (!positions || !positions.length) {
          // Empty = connection not ready, not mass close — same guard as HL
          log('OANDA', 'Reconciliation skipped — OANDA returned empty position list. ' + oandaTrades.length + ' EE trade(s) left open.', 'amber');
          return;
        }
        // OANDA instruments are formatted as "EUR_USD"; normalise to "EURUSD" for matching
        var oandaKeys = {};
        (positions || []).forEach(function (p) {
          var key = (p.instrument || '').replace(/_/g, '').toUpperCase();
          oandaKeys[key] = p;
        });
        oandaTrades.forEach(function (t) {
          var key = normaliseAsset(t.asset).toUpperCase();
          if (!oandaKeys[key]) {
            var fallback = _livePrice[t.trade_id] || _priceCache[normaliseAsset(t.asset)] || t.entry_price;
            log('OANDA', t.asset + ' position missing from OANDA — closed externally. Closing in EE at $' + (fallback || 0).toFixed(4), 'amber');
            closeTrade(t.trade_id, fallback || t.entry_price, 'EXTERNALLY_CLOSED');
          }
        });
        (positions || []).forEach(function (pos) {
          var instr = (pos.instrument || '').replace(/_/g, '').toUpperCase();
          var eeMatch = oandaTrades.some(function (t) { return normaliseAsset(t.asset).toUpperCase() === instr; });
          if (!eeMatch) {
            log('OANDA', '⚠ Orphan OANDA position: ' + instr + ' — not in EE trades (manually opened or prior session)', 'amber');
          }
        });
      })
      .catch(function () { /* silent — OANDA may be temporarily unavailable */ });
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     TRADE MONITOR — runs every 30s, checks open trades against live prices
     ══════════════════════════════════════════════════════════════════════════════ */

  function monitorTrades() {
    window._eeLastMonitor = Date.now(); // heartbeat — visible via EE.status() for watchdog checks
    // Daily loss limit check: if REALISED session P&L hits the limit, disable auto-execution.
    // Fix #6 (monitor): match canExecute() — use realised P&L from closed trades only,
    // not the virtual_balance delta which includes unrealised open-trade fluctuations.
    var _monEffectiveStart = _sessionStartBalance || _cfg.virtual_balance;
    if (_monEffectiveStart && _cfg.daily_loss_limit_pct > 0 && _cfg.enabled) {
      var _monSessionTs = _sessionStart ? new Date(_sessionStart).getTime() : 0;
      var _monRealisedPnl = _trades
        .filter(function (t) {
          return t.status === 'CLOSED' && t.timestamp_close &&
                 new Date(t.timestamp_close).getTime() >= _monSessionTs;
        })
        .reduce(function (s, t) { return s + (t.pnl_usd || 0); }, 0);
      var sessionLossPct = _monEffectiveStart > 0 ? (_monRealisedPnl / _monEffectiveStart * 100) : 0;
      if (sessionLossPct < -_cfg.daily_loss_limit_pct) {
        _cfg.enabled = false;
        saveCfg();
        log('RISK', 'Daily loss limit -' + _cfg.daily_loss_limit_pct + '% reached (' +
          sessionLossPct.toFixed(1) + '%) — no new trades until tomorrow', 'red');
        _notify('⚠ Daily Loss Limit Hit',
          'Session P&L: ' + sessionLossPct.toFixed(1) + '% — paused for new entries. Existing trades run to TP/SL.',
          'ee-daily-limit');
        // Existing open trades are left to run to their natural TP/SL —
        // force-closing mid-trade locks in losses and can turn recoverable
        // drawdowns into confirmed ones. The stop-loss on each trade IS the
        // real risk-management tool.
        renderUI();
      }
    }

    // T4-C: daily profit target — symmetric circuit breaker to the daily loss limit.
    // When session realised P&L hits the configured target, pause new entries to
    // protect the day's gains. Existing open trades continue to their natural TP/SL.
    // Set daily_profit_target_pct: 0 (default) to disable.
    if (_monEffectiveStart && _cfg.daily_profit_target_pct > 0 && _cfg.enabled) {
      var _monProfitPnl = _trades
        .filter(function (t) {
          return t.status === 'CLOSED' && t.timestamp_close &&
                 new Date(t.timestamp_close).getTime() >= (_sessionStart ? new Date(_sessionStart).getTime() : 0);
        })
        .reduce(function (s, t) { return s + (t.pnl_usd || 0); }, 0);
      var _profitPct = _monEffectiveStart > 0 ? (_monProfitPnl / _monEffectiveStart * 100) : 0;
      if (_profitPct >= _cfg.daily_profit_target_pct) {
        _cfg.enabled = false;
        saveCfg();
        log('RISK', '🎯 Daily profit target +' + _cfg.daily_profit_target_pct + '% reached (' +
          _profitPct.toFixed(1) + '%) — pausing new entries to protect gains', 'green');
        _notify('🎯 Daily Target Hit',
          'Session P&L: +' + _profitPct.toFixed(1) + '% — new entries paused. Open trades run to TP/SL.',
          'ee-daily-target');
        renderUI();
      }
    }

    // Fix #26: Regime-shift stop-tightening — when macro regime deteriorates,
    // tighten stops on all open trades to protect accumulated gains.
    // Only fires once per transition (guarded by _lastRegime).
    // RISK_ON → TRANSITIONING: tighten by 15% (modest protection, regime may recover)
    // RISK_ON / TRANSITIONING → RISK_OFF: tighten by 30% (significant protection)
    // TRANSITIONING → RISK_ON: loosen by 10% (give more room as conditions improve)
    (function () {
      if (!window.MacroRegime || typeof MacroRegime.current !== 'function') return;
      try {
        var _newRegime = (MacroRegime.current() || {}).regime || null;
        if (!_newRegime || _newRegime === _lastRegime) { _lastRegime = _newRegime; return; }
        var _prevR = _lastRegime;
        _lastRegime = _newRegime;
        var _tightenFrac = 0;  // fraction to REDUCE stop distance from entry (tighten = closer to entry)
        if (_prevR === 'RISK_ON'  && _newRegime === 'TRANSITIONING') _tightenFrac = 0.15;
        if ((_prevR === 'RISK_ON' || _prevR === 'TRANSITIONING') && _newRegime === 'RISK_OFF') _tightenFrac = 0.30;
        if (_prevR === 'TRANSITIONING' && _newRegime === 'RISK_ON') _tightenFrac = -0.10; // loosen (negative = widen)
        if (_tightenFrac === 0) return;
        var _openNow = openTrades();
        if (!_openNow.length) return;
        log('REGIME', 'Regime shift: ' + _prevR + ' → ' + _newRegime +
          ' — adjusting stops on ' + _openNow.length + ' open trade(s) (' +
          (_tightenFrac > 0 ? 'tighten ' : 'widen ') + Math.abs(_tightenFrac * 100) + '%)', 'amber');
        _openNow.forEach(function (t) {
          var _isLng = t.direction === 'LONG';
          var _slDist = Math.abs(t.entry_price - t.stop_loss);
          if (!_slDist || _slDist <= 0) return;
          var _newDist = _slDist * (1 - _tightenFrac);  // tighten (smaller distance) or widen
          var _newSL   = _isLng
            ? +(t.entry_price - _newDist).toFixed(6)
            : +(t.entry_price + _newDist).toFixed(6);
          // Safety: never move SL through current price (would immediately trigger)
          var _curPrice = _livePrice[t.trade_id] || t.entry_price;
          if (_isLng && _newSL >= _curPrice) return;
          if (!_isLng && _newSL <= _curPrice) return;
          t.stop_loss = _newSL;
          t._regimeSLAdjusted = _newRegime;
          log('REGIME', t.asset + ' ' + t.direction + ' SL adjusted: ' + _num(t.stop_loss) +
            ' (' + (_tightenFrac > 0 ? 'tightened' : 'widened') + ')', 'dim');
        });
        saveTrades();
        _notify('📊 Regime Shift: ' + _prevR + ' → ' + _newRegime,
          'Stops on ' + _openNow.length + ' trade(s) ' + (_tightenFrac > 0 ? 'tightened' : 'widened') +
          ' ' + Math.abs(_tightenFrac * 100) + '% to protect open positions.',
          'ee-regime-' + _newRegime);
      } catch (e) { /* MacroRegime unavailable */ }
    })();

    // Peak equity tracking + staged drawdown response.
    // Update session peak each cycle; staged position-size reductions prevent
    // blowing the account if multiple trades run in a losing streak.
    //   -5% from peak → 50% position sizes (caution)
    //   -8% from peak → 25% position sizes (defensive)
    //  -10% from peak → auto-execution paused (same as daily loss limit)
    // F44: use _getEffectiveBalance() so live broker equity is reflected when
    // a broker connection is active, instead of relying solely on virtual_balance.
    var _curEquity = _getEffectiveBalance();
    if (_peakEquity === null) _peakEquity = _curEquity;
    if (_curEquity > _peakEquity) _peakEquity = _curEquity;  // update high-water mark
    if (_peakEquity > 0) {
      var _newDd  = (_peakEquity - _curEquity) / _peakEquity * 100;
      var _prevDd = _ddFromPeak;
      _ddFromPeak = _newDd;
      if (_newDd >= 10 && _prevDd < 10 && _cfg.enabled) {
        _cfg.enabled = false; saveCfg();
        log('RISK', '⛔ Peak-equity drawdown -' + _newDd.toFixed(1) + '% (peak $' +
            _num(_peakEquity) + ') — auto-execution paused', 'red');
        _notify('⚠ Peak Drawdown -10%', '-' + _newDd.toFixed(1) + '% from peak $' +
            _num(_peakEquity) + ' — new trades paused.', 'ee-peak-dd');
        renderUI();
      } else if (_newDd >= 8 && _prevDd < 8) {
        log('RISK', '⚠ Peak-equity drawdown -' + _newDd.toFixed(1) + '% — position sizes at 25% until recovery', 'red');
      } else if (_newDd >= 5 && _prevDd < 5) {
        log('RISK', '⚠ Peak-equity drawdown -' + _newDd.toFixed(1) + '% — position sizes at 50% until recovery', 'amber');
      } else if (_prevDd >= 5 && _newDd < 5) {
        log('RISK', '✓ Drawdown recovered to -' + _newDd.toFixed(1) + '% — full position sizing restored', 'green');
      }
    }

    // Zombie position cleanup: cancel any open trade with $0 size that has been
    // sitting for >5 minutes. These are phantom positions (price feed failed at open)
    // that occupy slots and block real signals but contribute nothing.
    var _zombieMs = 5 * 60 * 1000;
    openTrades().forEach(function (zt) {
      if ((zt.size_usd === 0 || !zt.size_usd) && zt.units === 0) {
        var ageMs = Date.now() - new Date(zt.timestamp_open || 0).getTime();
        if (ageMs > _zombieMs) {
          log('TRADE', 'Zombie position cancelled: ' + zt.asset + ' (size=$0, age=' +
            Math.round(ageMs / 60000) + 'min)', 'amber');
          // H4 fix: closeTrade rejects price ≤ 0 and reverts to OPEN, causing
          // infinite spam. Use a non-zero fallback (stop_loss > 0 else 1 cent).
          var _zombiePx = (zt.entry_price > 0) ? zt.entry_price
                        : (zt.stop_loss   > 0) ? zt.stop_loss
                        : 0.01;
          closeTrade(zt.trade_id, _zombiePx, 'ZOMBIE-CANCEL');
        }
      }
    });

    // Fix #14: prune expired _cooldown entries every monitor cycle.
    // Without pruning the map grows indefinitely — one entry per asset/direction
    // ever traded. Entries are safe to remove once the cooldown window has elapsed.
    (function () {
      var _cdNow = Date.now();
      Object.keys(_cooldown).forEach(function (k) {
        if (_cdNow - (_cooldown[k] || 0) > _cfg.cooldown_ms) {
          delete _cooldown[k];
        }
      });
      // H8 fix: _reversalCooldown also never pruned — same unbounded growth issue.
      // Entries store an expiry ms timestamp (unlike _cooldown which stores a start ts).
      Object.keys(_reversalCooldown).forEach(function (k) {
        if (_cdNow > (_reversalCooldown[k] || 0)) {
          delete _reversalCooldown[k];
        }
      });
      // A20: prune _noPriceThrottle — 1h entries for assets with no price feed.
      // Never pruned before → one entry per dead asset accumulates indefinitely.
      Object.keys(_noPriceThrottle).forEach(function (k) {
        if (_cdNow - (_noPriceThrottle[k] || 0) > 3600000) {
          delete _noPriceThrottle[k];
        }
      });
    })();

    // A5: compute _tpHitRate ONCE per monitor cycle (outside forEach) — it was
    // previously an IIFE inside forEach, scanning all trades for every open trade.
    // With N open trades and M closed trades that was O(N×M) per 15s cycle.
    var _monCycleHitRate = (function () {
      var _closed = _trades.filter(function (t) { return t.status === 'CLOSED'; });
      if (_closed.length < 20) return 0.40; // conservative prior — favour partial until we have data
      var _tpHits = _closed.filter(function (t) {
        return t.close_reason === 'TAKE_PROFIT' || t.close_reason === 'TRAILING_STOP';
      }).length;
      return _tpHits / _closed.length;
    })();

    openTrades().forEach(function (trade, _monIdx) {
      // Skip trades awaiting broker fill confirmation — no price has been
      // locked in yet, so SL/TP/funding checks would fire against the wrong price.
      if (trade.broker_status === 'PENDING_FILL') return;

      // F33: stagger fetches by 100 ms per trade to avoid rate-limit bursts
      // (e.g. 12 open trades → last fetch starts at 1.1 s, well within 15 s cycle)
      setTimeout(function () { fetchPrice(trade.asset, function (price) {
        // Use cached price as display fallback so unrealised P&L always renders
        var displayPrice = price || _priceCache[normaliseAsset(trade.asset)] || null;
        if (displayPrice) _livePrice[trade.trade_id] = displayPrice;
        if (!price) {
          // Stale-price watchdog: if no fresh price AND cache is > 30 min old, force-close.
          // Prevents ghost trades accumulating funding costs during feed outages.
          // Raised from 10→30 min: 10 min was too aggressive during feed blips or
          // cold starts where the price backend needs time to warm up.
          var _cacheAge = _priceCacheTs[normaliseAsset(trade.asset)]
            ? (Date.now() - _priceCacheTs[normaliseAsset(trade.asset)])
            : (Date.now() - new Date(trade.timestamp_open || 0).getTime());
          if (_cacheAge > _PRICE_STALE_TIMEOUT) {
            var _fallback = _priceCache[normaliseAsset(trade.asset)] || trade.entry_price;
            log('TRADE', trade.asset + ' STALE-PRICE-TIMEOUT: no fresh price for ' +
                Math.round(_cacheAge / 60000) + 'min — closing at last known $' +
                (_fallback || 0).toFixed(2), 'amber');
            closeTrade(trade.trade_id, _fallback || trade.entry_price || 0, 'STALE-PRICE-TIMEOUT');
          }
          renderUI(); return;
        }

        _lastPriceTs[trade.trade_id] = Date.now();  // record successful price fetch
        _livePrice[trade.trade_id] = price;
        var saved = false;  // track if we need to saveTrades() this cycle

        var isLong  = trade.direction === 'LONG';
        var isShort = trade.direction === 'SHORT';

        // ── Partial TP1: dynamic fraction based on signal confidence ────────
        // v61: high-conf breakouts skip partial TP to capture full move;
        //      lower-conf / mean-reversion trades take 50% early as protection.
        // Fix #13: data-driven gate — skip partial when full-TP hit rate ≥ 45%.
        //   Taking a 50% partial at the midpoint forfeits 32%+ of expected upside
        //   on every winning trade. Only use partial TP when the system rarely
        //   reaches full TP (< 45%), where banking early is positive-EV.
        var _sconf       = trade.signal_conf || 65;
        // A5: use pre-computed per-cycle hit rate (not a per-trade IIFE scan)
        var _skipPartial = (_sconf >= 75 && trade.entry_type === 'breakout') || (_monCycleHitRate >= 0.45);
        var _partialFrac = _sconf >= 70 ? 0.25 : 0.50;
        if (_cfg.partial_tp_enabled && !trade.partial_tp_taken && !_skipPartial) {
          // Partial TP trigger moved from 50% → 70% of TP distance.
          // At 50% (old): partial fires at 1.25R on a 2.5R target — too early, forfeits most upside.
          // At 70% (new): partial fires at 2.1R on a 3.0R target — banks a meaningful gain while
          // leaving room to capture the full move. Fixes the 0.29 realised R:R observed in data.
          var tp1 = isLong
            ? trade.entry_price + 0.70 * (trade.take_profit - trade.entry_price)
            : trade.entry_price - 0.70 * (trade.entry_price - trade.take_profit);
          var hitTP1 = isLong ? (price >= tp1) : (price <= tp1);
          if (hitTP1) {
            var closedUnits  = trade.units * _partialFrac;
            // Use tp1 price (not current price) so partial P&L is always capped at 1×R.
            // C6 fix: for LONG, cap at tp1 (Math.min = don't pay above tp1).
            // For SHORT, tp1 is BELOW entry; a lower price is MORE favourable, so
            // Math.max is wrong (it would use a worse-than-available price).
            // Correct: Math.min for SHORT too (fill at the best/lowest available fill).
            // A6: both LONG and SHORT use Math.min(price, tp1):
          // For LONG: cap at tp1 so we don't claim a better fill than the limit.
          // For SHORT: tp1 is below entry; min gives the lower (more favourable) price.
          // The ternary was dead code (both arms identical) — simplified to one expression.
          var partialClosePrice = Math.min(price, tp1);
            // Reality check 2 — apply limit-order exit slippage (spread only, no market slippage)
            var adjPartialClose = _adjustedExitPrice(trade.asset, partialClosePrice, trade.direction, 'TAKE_PROFIT');
            var pnlPerUnit   = isLong ? (adjPartialClose - trade.entry_price) : (trade.entry_price - adjPartialClose);
            var partialPnl   = +(closedUnits * pnlPerUnit).toFixed(2);
            // Reality check 5 — deduct commission on partial close
            var partialComm = (closedUnits * adjPartialClose) * _getCosts(trade.asset).commission;
            partialPnl = +(partialPnl - partialComm).toFixed(2);
            trade.partial_tp_taken  = true;
            trade.partial_tp_price  = +adjPartialClose.toFixed(6);
            trade.partial_pnl_usd   = partialPnl;
            trade.costs_usd         = +((trade.costs_usd || 0) + partialComm).toFixed(4);
            trade.units             = +(trade.units * (1 - _partialFrac)).toFixed(6);
            trade.size_usd          = +(trade.units * trade.entry_price).toFixed(2); // v48 fix: use entry price, not live price
            // Move stop to entry + round-trip exit cost (break-even) — v53: cost-based, not hardcoded
            var _beCosts = _getCosts(trade.asset);
            var _beBuf   = _beCosts.commission + _beCosts.spread * 0.5 + (_beCosts.slippage || 0);
            var beStop = isLong
              ? +(trade.entry_price * (1 + _beBuf)).toFixed(6)
              : +(trade.entry_price * (1 - _beBuf)).toFixed(6);
            trade.stop_loss        = beStop;
            trade.break_even_done  = true;
            trade.trailing_stop_active = true;
            // Bank partial P&L into balance (net of commission)
            _cfg.virtual_balance  += partialPnl;
            saveCfg();
            saved = true;
            log('PARTIAL',
              trade.asset + ' ' + Math.round(_partialFrac * 100) + '% TP @ ' + _num(adjPartialClose) +
              '  Banked: ' + (partialPnl >= 0 ? '+' : '') + '$' + _num(partialPnl) +
              '  comm:-$' + _num(partialComm) +
              '  SL→breakeven', 'green');
            _notify('🎯 Partial TP — ' + trade.asset,
              Math.round(_partialFrac * 100) + '% closed @ ' + _num(adjPartialClose) + ' (+$' + _num(partialPnl) + ' net)\nStop moved to break-even.',
              'ee-partial-' + trade.trade_id);
          }
        }

        // ── Break-even stop: move stop to entry at configurable % of distance to TP ──
        // Threshold controlled by break_even_trigger_pct config (default 50%).
        // Lower values (e.g. 35%) lock in profit sooner on volatile assets;
        // higher values (e.g. 65%) let trades breathe before committing to BE.
        if (_cfg.break_even_enabled && !trade.break_even_done && !trade.partial_tp_taken) {
          var _beTrigPct = (_cfg.break_even_trigger_pct || 50) / 100;
          var halfDist = isLong
            ? _beTrigPct * (trade.take_profit - trade.entry_price)
            : _beTrigPct * (trade.entry_price - trade.take_profit);
          var beTrigger = isLong
            ? trade.entry_price + halfDist
            : trade.entry_price - halfDist;
          var hitBE = isLong ? (price >= beTrigger) : (price <= beTrigger);
          if (hitBE) {
            var _beCosts2 = _getCosts(trade.asset);
            var _beBuf2   = _beCosts2.commission + _beCosts2.spread * 0.5 + (_beCosts2.slippage || 0);
            var newBEStop = isLong
              ? +(trade.entry_price * (1 + _beBuf2)).toFixed(6)
              : +(trade.entry_price * (1 - _beBuf2)).toFixed(6);
            if ((isLong && newBEStop > trade.stop_loss) ||
                (isShort && newBEStop < trade.stop_loss)) {
              trade.stop_loss           = newBEStop;
              trade.break_even_done     = true;
              trade.trailing_stop_active = true;
              saved = true;
              log('TRAIL', trade.asset + ' break-even stop @ ' + _num(newBEStop), 'amber');
              // Fix #12: when break-even is activated, the trade has proven momentum by
              // reaching 50% of the TP distance. Extend the TP by 20% to capture the
              // remaining run — this turns break-even into a net positive expectation
              // (risk-free with an extended target) rather than just a defensive move.
              // Only extend if not already trailing (trailing stop can naturally extend gains).
              // L5 fix: only extend TP on genuine forward momentum, not a pullback re-touch.
              // Check that price is above (LONG) or below (SHORT) the midpoint by at least 55%
              // of the full TP distance — i.e. clearly moving toward TP, not just at the 50% trigger.
              var _tpProgress = isLong
                ? (price - trade.entry_price) / Math.max(0.0001, trade.take_profit - trade.entry_price)
                : (trade.entry_price - price) / Math.max(0.0001, trade.entry_price - trade.take_profit);
              if (!trade._tpExtended && _tpProgress >= 0.55) {
                var _origTpDist = Math.abs(trade.take_profit - trade.entry_price);
                var _tpExtension = _origTpDist * 0.20;  // +20% of original TP distance
                trade.take_profit = isLong
                  ? +(trade.take_profit + _tpExtension).toFixed(6)
                  : +(trade.take_profit - _tpExtension).toFixed(6);
                trade._tpExtended = true;
                log('TRAIL', trade.asset + ' TP extended +20% to ' + _num(trade.take_profit) + ' (break-even momentum bonus, progress=' + Math.round(_tpProgress * 100) + '%)', 'green');
              }
              _notify('🔒 Break-Even — ' + trade.asset,
                'Stop moved to entry. TP extended +20% to capture momentum.',
                'ee-be-' + trade.trade_id);
            }
          }
        }

        // ── T1-D: gii-exit fallback trailing stop ───────────────────────────────────
        // gii-exit owns the progressive trailing stop. If it goes offline (stale >5min),
        // apply a simple 2% fallback trail on any trade that has already hit break-even
        // so gains are not fully surrendered if gii-exit is not responding.
        if (trade.break_even_done && !_cfg.trailing_stop_enabled) {
          var _giiExitAlive = false;
          try {
            _giiExitAlive = window.GII_EXIT_AGENT &&
              typeof GII_EXIT_AGENT.lastSignalTs === 'number' &&
              (Date.now() - GII_EXIT_AGENT.lastSignalTs) < 300000;
          } catch(e) {}
          if (!_giiExitAlive) {
            var _fbTrailPct = 0.02;  // 2% trail distance
            var _fbTrail    = trade.entry_price * _fbTrailPct;
            var _fbNewSL    = isLong ? price - _fbTrail : price + _fbTrail;
            if ((isLong  && _fbNewSL > trade.stop_loss && _fbNewSL < trade.take_profit) ||
                (!isLong && _fbNewSL < trade.stop_loss && _fbNewSL > trade.take_profit)) {
              trade.stop_loss = +_fbNewSL.toFixed(6);
              saved = true;
              log('TRAIL', trade.asset + ' fallback trail (gii-exit offline) SL → ' + _num(trade.stop_loss), 'dim');
            }
          }
        }

        // ── Fix #24: Pre-event partial close — reduce exposure before HIGH-IMPACT events ─
        // Instead of hard-blocking new entries (canExecute gate), we also pro-actively
        // trim any OPEN trade that is affected by an approaching event.
        // Only fires once per trade per event window (guarded by _preEventPartial flag).
        // Reduces position by 40% at market price — less disruptive than a full close.
        if (_cfg.event_gate_enabled && !trade._preEventPartial) {
          var _peCalAgent = window.GII_AGENT_CALENDAR;
          if (_peCalAgent && typeof _peCalAgent.upcoming === 'function') {
            try {
              var _peUpcoming = _peCalAgent.upcoming();
              var _peGateHrs  = _cfg.event_gate_hours || 0.5;
              var _peAsset    = normaliseAsset(trade.asset);
              var _peRegion   = (trade.region || '').toUpperCase();
              var _peBlocking = _peUpcoming.filter(function (ev) {
                if (ev.days < 0 || ev.days > _peGateHrs / 24) return false;
                var imp = ev.importance || 0;
                if (imp >= 5) return true;
                var evRegion = (ev.region || '').toUpperCase();
                var evAsset  = (ev.asset  || '').toUpperCase();
                if (imp >= 4 && evRegion && evRegion === _peRegion) return true;
                if (imp >= 3 && evAsset  && evAsset  === _peAsset)  return true;
                return false;
              });
              if (_peBlocking.length) {
                var _peEv  = _peBlocking[0];
                var _peMins = Math.round(_peEv.days * 24 * 60);
                var _peFrac = 0.40;  // close 40% of the position before the event
                var _peUnits = trade.units * _peFrac;
                var _peClosePrice = _adjustedExitPrice(trade.asset, price, trade.direction, 'EVENT_PARTIAL');
                var _pePnlPerUnit = isLong ? (_peClosePrice - trade.entry_price) : (trade.entry_price - _peClosePrice);
                var _pePnl = +(_peUnits * _pePnlPerUnit).toFixed(2);
                var _peComm = (_peUnits * _peClosePrice) * _getCosts(trade.asset).commission;
                _pePnl = +(_pePnl - _peComm).toFixed(2);
                trade._preEventPartial = true;
                trade.units    = +(trade.units * (1 - _peFrac)).toFixed(6);
                trade.size_usd = +(trade.units * trade.entry_price).toFixed(2);
                trade.costs_usd = +((trade.costs_usd || 0) + _peComm).toFixed(4);
                trade.partial_pnl_usd = +((trade.partial_pnl_usd || 0) + _pePnl).toFixed(2);
                _cfg.virtual_balance += _pePnl;
                saveCfg();
                saved = true;
                log('EVENT', trade.asset + ' pre-event partial (-' + (_peFrac * 100) + '%) before "' +
                  _peEv.label.substring(0, 30) + '" in ' + _peMins + 'min  banked ' +
                  (_pePnl >= 0 ? '+' : '') + '$' + _num(_pePnl), 'amber');
                _notify('⚡ Pre-Event Partial — ' + trade.asset,
                  _peFrac * 100 + '% closed ahead of: ' + _peEv.label.substring(0, 40) + ' (in ' + _peMins + 'min)',
                  'ee-event-partial-' + trade.trade_id);
              }
            } catch (e) { /* calendar unavailable */ }
          }
        }

        // ── Trailing stop: once active, trail price by trailing_stop_pct ────
        // Guard: skip if the TP level has already been reached this cycle.
        // Without this, a SHORT's trailing stop can be clamped to trade.take_profit
        // and then immediately trigger hitSL (price >= stop_loss == take_profit),
        // closing a profitable trade as STOP_LOSS instead of TAKE_PROFIT.
        // Checking TP first and skipping the trail update avoids the race entirely.
        var _tpAlreadyHit = isLong ? price >= trade.take_profit : price <= trade.take_profit;
        if (_cfg.trailing_stop_enabled && trade.trailing_stop_active && !_tpAlreadyHit) {
          var trailDist = trade.entry_price * (_cfg.trailing_stop_pct / 100);
          if (isLong) {
            var newHigh = Math.max(price, trade.highest_price || price);
            trade.highest_price = newHigh;
            var trailedStop = +(newHigh - trailDist).toFixed(6);
            // Symmetric TP clamp for LONG: trail must not exceed TP (mirrors SHORT clamp below)
            if (trade.take_profit && trailedStop > trade.take_profit) trailedStop = +trade.take_profit.toFixed(6);
            if (trailedStop > trade.stop_loss) {
              trade.stop_loss = trailedStop;
              saved = true;
            }
          } else {
            var newLow = Math.min(price, trade.lowest_price || price);
            trade.lowest_price = newLow;
            var trailedStopS = +(newLow + trailDist).toFixed(6);
            // Clamp: trailing SL for SHORT must not go below the TP level.
            // If SL went below TP, price could skip past TP in one monitoring cycle
            // and close as STOP_LOSS instead of TAKE_PROFIT, garbling the close reason
            // and bypassing the correct TP-level P&L calculation.
            if (trailedStopS < trade.take_profit) trailedStopS = +trade.take_profit.toFixed(6);
            if (trailedStopS < trade.stop_loss) {
              trade.stop_loss = trailedStopS;
              saved = true;
            }
          }
        }

        if (saved) saveTrades();

        // Reality check 4 — minimum hold time: trades cannot open and close within
        // the same monitor cycle. Prevents unrealistic instant fills in fast moves.
        var tradeAgeMs = Date.now() - new Date(trade.timestamp_open).getTime();
        if (tradeAgeMs < MIN_HOLD_MS) {
          renderUI();
          return;
        }

        // Reality check 4b — maximum hold time: auto-expire stale trades.
        // Geopolitical trades go stale after ~7 days; scalper trades after 6h.
        // If exit signals haven't fired by then, the trade is a zombie — close it.
        var _isScalperTrade = trade.source === 'scalper' || trade.source === 'scalper-session';
        var _maxHoldMs = _isScalperTrade ? MAX_HOLD_MS_SCALPER : MAX_HOLD_MS_GEO;
        if (tradeAgeMs > _maxHoldMs) {
          var _expiredHrs = Math.round(tradeAgeMs / 3600000);
          log('TRADE', trade.asset + ' ' + trade.direction + ' auto-expired after ' +
            _expiredHrs + 'h (max=' + (_maxHoldMs / 3600000) + 'h)', 'amber');
          // C3 fix: _getPrice doesn't exist — use cached price with fallbacks
          var _expiredPx = _livePrice[trade.trade_id] ||
                           _priceCache[normaliseAsset(trade.asset)] ||
                           trade.entry_price;
          closeTrade(trade.trade_id, _expiredPx, 'MAX-HOLD-EXPIRED');
          return;
        }

        // Reality check 5 — crypto funding rate: deducted every 8 hours.
        // Simulates perpetual swap funding charged on leveraged crypto positions.
        var tradeCosts = _getCosts(trade.asset);
        if (tradeCosts.funding8h > 0) {
          var ageHours        = tradeAgeMs / 3600000;
          var fundingDue      = Math.floor(ageHours / 8);
          var fundingPaid     = trade.funding_periods_paid || 0;
          if (fundingDue > fundingPaid) {
            var fundingCost = trade.size_usd * tradeCosts.funding8h * (fundingDue - fundingPaid);
            trade.funding_periods_paid = fundingDue;
            trade.costs_usd = +((trade.costs_usd || 0) + fundingCost).toFixed(4);
            // Track running funding deduction on the trade itself so win/loss stats
            // reflect actual net P&L (not just price movement minus entry commission).
            trade.funding_cost_usd = +((trade.funding_cost_usd || 0) + fundingCost).toFixed(4);
            _cfg.virtual_balance -= fundingCost;
            saveCfg();
            // A9: saveTrades() here so costs_usd/funding_cost_usd reach localStorage/DB
            // immediately — previously saved=true but saveTrades() had already passed.
            saveTrades();
            log('COST', trade.asset + ' funding ×' + (fundingDue - fundingPaid) +
              ' periods  -$' + _num(fundingCost), 'dim');
          }
        }

        // ── TP / SL checks (with updated stop) ──────────────────────────────
        var hitTP, hitSL;
        if (isLong) {
          hitTP = price >= trade.take_profit;
          hitSL = price <= trade.stop_loss;
        } else {
          hitTP = price <= trade.take_profit;
          hitSL = price >= trade.stop_loss;
        }

        if (hitTP)      closeTrade(trade.trade_id, trade.take_profit, 'TAKE_PROFIT');
        else if (hitSL) closeTrade(trade.trade_id, trade.stop_loss,   'STOP_LOSS');
        else            renderUI();
      }); }, _monIdx * 100); // closes fetchPrice callback + setTimeout (F33 stagger)
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     BROKER ADAPTER INTERFACE
     Implement these stubs in a separate adapter file for each broker.
     Connect via: EE.connectBroker('BINANCE', { apiKey, apiSecret })
     ══════════════════════════════════════════════════════════════════════════════ */

  var _brokerAdapter = null;

  var BROKER_STUBS = {
    /*
    BINANCE: {
      name: 'Binance',
      placeOrder: function(trade, cfg) { ... POST /api/v3/order ... },
      cancelOrder: function(orderId, cfg) { ... DELETE /api/v3/order ... },
      getPrice: function(symbol, cb) { ... GET /api/v3/ticker/price ... }
    },
    ALPACA: {
      name: 'Alpaca',
      placeOrder: function(trade, cfg) { ... POST /v2/orders ... },
      cancelOrder: function(orderId, cfg) { ... DELETE /v2/orders/:id ... },
      getPrice: function(symbol, cb) { ... GET /v2/stocks/:symbol/quotes/latest ... }
    },
    POLYMARKET: {
      name: 'Polymarket',
      placeOrder: function(trade, cfg) { ... CLOB API ... },
      cancelOrder: function(orderId, cfg) { ... },
      getPrice: function(marketId, cb) { ... }
    }
    */
  };

  function connectBroker(brokerName, credentials) {
    // Placeholder — implement adapter in a separate file
    // adapter should set _brokerAdapter to an object with placeOrder / cancelOrder / getPrice
    log('BROKER', 'connectBroker(' + brokerName + ') — not yet implemented', 'amber');
  }

  /* ── Binance WebSocket — real-time BTC price (no API key needed) ────────────── */
  function _startBinanceWS() {
    if (_wsConnected || typeof WebSocket === 'undefined') return;
    try {
      var ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@miniTicker');
      ws.onmessage = function (evt) {
        try {
          var data = JSON.parse(evt.data);
          var price = parseFloat(data.c);   // close price of miniTicker
          if (price > 0) {
            // HL-Feed is higher priority for BTC. If HL has a fresh price, record
            // Binance as healthy (it's still streaming) but don't overwrite HL's price.
            _priceFeedHealth['binance'] = { ok: true, lastOk: Date.now(),
              lastFail: (_priceFeedHealth['binance'] || {}).lastFail || null };
            if (window.HLFeed && typeof HLFeed.isAvailable === 'function' &&
                HLFeed.isAvailable('BTC')) {
              return;   // HL has fresh BTC — Binance is warm fallback only
            }
            _cacheSet('BTC', price);
            _cacheSet('BITCOIN', price);
            // Push real-time price to all open BTC trades so P&L updates without polling
            _trades.forEach(function (t) {
              if (t.status === 'OPEN' && normaliseAsset(t.asset) === 'BTC') {
                _livePrice[t.trade_id] = price;
              }
            });
          }
        } catch (e) {}
      };
      ws.onopen  = function () {
        _wsConnected = true;
        _wsBinanceRetries = 0;  // Fix #17: reset backoff on successful connect
        log('SYSTEM', 'Binance WebSocket connected — BTC fallback feed active (yields to HL when live)', 'dim');
      };
      ws.onclose = function () {
        _wsConnected = false;
        // Fix #17: exponential backoff — 5s, 10s, 20s, 40s … cap at 5 min
        _wsBinanceRetries++;
        var _bkDelay = Math.min(5000 * Math.pow(2, _wsBinanceRetries - 1), 300000);
        log('SYSTEM', 'Binance WS closed — retry in ' + Math.round(_bkDelay / 1000) + 's (attempt ' + _wsBinanceRetries + ')', 'dim');
        setTimeout(_startBinanceWS, _bkDelay);
      };
      ws.onerror = function () { _wsConnected = false; };
      _wsBtcWs = ws;
    } catch (e) {
      log('SYSTEM', 'BTC WebSocket unavailable: ' + (e.message || String(e)), 'dim');
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     ACTIVITY LOG
     ══════════════════════════════════════════════════════════════════════════════ */

  function log(action, msg, colour) {
    _log.unshift({ ts: new Date().toISOString(), action: action, msg: msg, colour: colour || 'dim' });
    if (_log.length > 200) _log.length = 200;   // v60: raised cap to 200; trim in-place
    var el = document.getElementById('eeActivityLog');
    if (el) renderLog(el);
  }

  /* ── Browser notification helper (respects existing permission) ─────────────── */
  function _notify(title, body, tag) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try { new Notification(title, { body: body, tag: tag || ('ee-' + Date.now()), requireInteraction: false }); }
    catch (e) { /* silent */ }
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     UI RENDERING
     ══════════════════════════════════════════════════════════════════════════════ */

  /* ── Agent Manager Alerts ─────────────────────────────────────────────────────
     Reads alerts from GII_AGENT_MANAGER (if available) and surfaces them in the
     #eeManagerAlerts strip below the live-mode warning banner.                  */
  function renderManagerAlerts() {
    var el = document.getElementById('eeManagerAlerts');
    if (!el) return;
    var alerts = [];
    try {
      if (window.GII_AGENT_MANAGER && typeof GII_AGENT_MANAGER.alerts === 'function') {
        alerts = GII_AGENT_MANAGER.alerts() || [];
      }
    } catch (e) {}
    // Also surface kill-switch state as a top-level alert
    if (_halted) {
      alerts = [{ level: 'crit', msg: '🛑 KILL SWITCH ACTIVE — all new trade execution is halted. Click HALT to resume.', ts: null }].concat(alerts);
    }
    if (!alerts.length) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.innerHTML = alerts.slice(0, 8).map(function (a) {
      var lvl  = (a.level === 'critical' || a.level === 'crit'    || a.severity === 'error') ? 'crit'
               : (a.level === 'warn'     || a.level === 'warning' || a.severity === 'warn')  ? 'warn'
               : '';
      var icon = lvl === 'crit' ? '🔴' : lvl === 'warn' ? '⚠️' : 'ℹ️';
      var tsStr = a.ts ? ('<span class="ee-mgr-alert-ts">' + _age(a.ts) + ' ago</span>') : '';
      return '<div class="ee-mgr-alert ' + lvl + '">' +
        '<span class="ee-mgr-alert-icon">' + icon + '</span>' +
        '<span class="ee-mgr-alert-msg">' + _esc(String(a.msg || a.message || '')) + '</span>' +
        tsStr +
      '</div>';
    }).join('');
  }

  /* ── Agent Heartbeat Panel ────────────────────────────────────────────────────
     Reads GII_AGENT_MANAGER.healthReport() and renders a compact status grid
     in #eeAgentHeartbeat showing last-poll age and status for every watched agent. */
  function renderAgentHeartbeat() {
    var el = document.getElementById('eeAgentHeartbeat');
    if (!el) return;
    var report = null;
    try {
      if (window.GII_AGENT_MANAGER && typeof GII_AGENT_MANAGER.healthReport === 'function') {
        report = GII_AGENT_MANAGER.healthReport();
      }
    } catch (e) {}
    if (!report || !report.agents || !Object.keys(report.agents).length) {
      el.innerHTML = '<span style="font-size:9px;color:var(--dim)">Agent manager not yet initialised — waiting for first health check (30s after load)…</span>';
      return;
    }
    var now = Date.now();
    var rows = Object.keys(report.agents).map(function (name) {
      var h   = report.agents[name];
      var age = h.lastPoll ? Math.round((now - (h.lastPoll || 0)) / 1000) : null;
      var ageStr = age === null ? '—' : age < 60 ? age + 's' : Math.round(age / 60) + 'm';
      var statusCol = h.status === 'ok'   ? '#00c8a0'
                    : h.status === 'warn' ? '#ff9500'
                    : h.status === 'error'? '#ff4444'
                    : '#555';
      var dot = h.status === 'ok' ? '●' : h.status === 'warn' ? '◐' : '○';
      var shortName = name.replace('GII_AGENT_', '').replace('GII_SCRAPER_', 'SCR_');
      return '<div class="ee-hb-row">' +
        '<span style="color:' + statusCol + ';font-size:9px">' + dot + '</span>' +
        '<span class="ee-hb-name">' + shortName + '</span>' +
        '<span class="ee-hb-age" style="color:' + (age !== null && age > 300 ? '#ff9500' : 'var(--dim)') + '">' + ageStr + '</span>' +
        (h.message ? '<span class="ee-hb-msg" style="color:' + statusCol + '">' + h.message + '</span>' : '<span class="ee-hb-msg"></span>') +
      '</div>';
    }).join('');
    var lastCheck = report.lastCheck ? Math.round((now - report.lastCheck) / 1000) + 's ago' : 'pending';
    el.innerHTML = '<div class="ee-hb-header">Agent Heartbeats <span style="color:var(--dim);font-weight:normal">· last check: ' + lastCheck + '</span></div>' +
      '<div class="ee-hb-grid">' + rows + '</div>';
  }

  function renderUI() {
    renderStatusBar();
    renderPortfolioSummary();
    renderConfigFields();
    renderOpenTrades();
    renderClosedTrades();
    _renderFlaggedTrades();
    var el = document.getElementById('eeActivityLog');
    if (el) renderLog(el);
    // Show/hide live mode warning
    var warn = document.getElementById('eeLiveWarning');
    if (warn) warn.classList.toggle('show', _cfg.mode === 'LIVE');
    // Agent manager alerts strip
    renderManagerAlerts();
    // Agent heartbeat panel
    renderAgentHeartbeat();
    // Refresh strategy analytics panel
    renderAnalytics();
    // Refresh signal history + risk simulator
    renderSigLog();
    renderSim();
    renderPriceFeedHealth();
    renderPortfolioWatchlist();
  }

  function renderPortfolioSummary() {
    var el = document.getElementById('eePortfolioSummary');
    if (!el) return;

    // Realised P&L from all closed trades this session
    var sessionTs = _sessionStart ? new Date(_sessionStart).getTime() : 0;
    var closed = _trades.filter(function (t) { return t.status === 'CLOSED'; });
    var sessionClosed = closed.filter(function (t) {
      return t.timestamp_close && new Date(t.timestamp_close).getTime() >= sessionTs;
    });
    var realisedPnl = sessionClosed.reduce(function (s, t) { return s + (t.pnl_usd || 0) + (t.partial_pnl_usd || 0); }, 0);

    // Unrealised P&L from open trades using live prices
    var unrealisedPnl = 0;
    openTrades().forEach(function (t) {
      var px = _livePrice[t.trade_id] || _priceCache[normaliseAsset(t.asset)] || null;
      if (!px) return;
      var diff = t.direction === 'LONG' ? (px - t.entry_price) : (t.entry_price - px);
      unrealisedPnl += t.units * diff;
    });

    // Use actual session-start balance, not the hardcoded DEFAULTS constant.
    // _sessionStartBalance is set at init time from the live virtual_balance config.
    var startBalance = _sessionStartBalance || DEFAULTS.virtual_balance;
    var totalPnl     = realisedPnl + unrealisedPnl;
    var returnPct    = startBalance > 0 ? (totalPnl / startBalance * 100) : 0;
    var retCol       = returnPct >= 0 ? '#00c8a0' : '#ff4444';
    var uCol         = unrealisedPnl >= 0 ? '#00c8a0' : '#ff4444';
    var rCol         = realisedPnl   >= 0 ? '#00c8a0' : '#ff4444';

    // Session duration
    var sessionAge = '';
    if (_sessionStart) {
      var mins = Math.floor((Date.now() - new Date(_sessionStart).getTime()) / 60000);
      sessionAge = mins < 60
        ? mins + 'm'
        : Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
    }

    el.innerHTML =
      '<div class="ee-psb-item">' +
        '<span class="ee-psb-label">Balance</span>' +
        '<span class="ee-psb-val">' +
          '<b style="color:var(--bright)">$' + _num(_cfg.virtual_balance) + '</b>' +
        '</span>' +
      '</div>' +
      '<div class="ee-psb-item">' +
        '<span class="ee-psb-label">Unrealised</span>' +
        '<span class="ee-psb-val" style="color:' + uCol + '">' +
          (unrealisedPnl >= 0 ? '+' : '') + '$' + _num(Math.abs(unrealisedPnl)) +
        '</span>' +
      '</div>' +
      '<div class="ee-psb-item">' +
        '<span class="ee-psb-label">Realised</span>' +
        '<span class="ee-psb-val" style="color:' + rCol + '">' +
          (realisedPnl >= 0 ? '+' : '-') + '$' + _num(Math.abs(realisedPnl)) +
        '</span>' +
      '</div>' +
      '<div class="ee-psb-item">' +
        '<span class="ee-psb-label">Session Return</span>' +
        '<span class="ee-psb-val" style="color:' + retCol + ';font-weight:700">' +
          (returnPct >= 0 ? '+' : '') + returnPct.toFixed(2) + '%' +
        '</span>' +
      '</div>' +
      '<div class="ee-psb-item ee-psb-session">' +
        '<span class="ee-psb-label">Session started</span>' +
        '<span class="ee-psb-val" style="color:var(--dim)">' +
          (_sessionStart ? new Date(_sessionStart).toUTCString().replace(' GMT','') : '—') +
          (sessionAge ? ' (' + sessionAge + ' ago)' : '') +
        '</span>' +
      '</div>';

    // Daily loss limit gauge — shows below the summary bar
    var gaugeEl = document.getElementById('eeDailyLossGauge');
    if (gaugeEl && _cfg.daily_loss_limit_pct > 0) {
      var dailyLimitPct = _cfg.daily_loss_limit_pct;
      var dailyLossPct  = startBalance > 0 ? (realisedPnl / startBalance * 100) : 0;
      var usedFraction  = Math.min(1, Math.max(0, -dailyLossPct / dailyLimitPct));  // 0–1
      var usedPct       = Math.round(usedFraction * 100);
      var gaugeColor    = usedFraction > 0.75 ? '#ff4444' : usedFraction > 0.50 ? '#ffaa00' : '#00c8a0';
      var lossStr       = dailyLossPct < 0 ? dailyLossPct.toFixed(2) + '%' : '+' + dailyLossPct.toFixed(2) + '%';
      gaugeEl.innerHTML =
        '<div style="display:flex;justify-content:space-between;font-size:9px;color:var(--dim);margin-bottom:3px">' +
          '<span title="Daily loss limit circuit breaker">Daily Loss Limit' +
            (usedFraction > 0.5 ? ' <span style="color:' + gaugeColor + ';font-weight:700">⚠</span>' : '') +
          '</span>' +
          '<span style="color:' + (dailyLossPct < 0 ? gaugeColor : 'var(--dim)') + '">' +
            lossStr + ' / <span style="color:var(--dim)">-' + dailyLimitPct + '% limit</span>' +
          '</span>' +
        '</div>' +
        '<div style="height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden">' +
          '<div style="height:4px;width:' + usedPct + '%;background:' + gaugeColor + ';border-radius:2px;transition:width 1s"></div>' +
        '</div>';
    }
  }

  function renderPriceFeedHealth() {
    var el = document.getElementById('eePriceFeedHealth');
    if (!el) return;
    var sources = [
      { name: 'Hyperliquid',key: 'hl'         },   // highest-priority WS feed
      { name: 'Backend',    key: 'backend'    },
      { name: 'Binance',    key: 'binance'    },
      { name: 'Yahoo',      key: 'yahoo'      },
      { name: 'CoinGecko',  key: 'coingecko'  },
      { name: 'Frankfurter',key: 'frankfurter'}
    ];
    el.innerHTML = '<span style="color:var(--dim);font-size:9px;margin-right:6px">Price feeds:</span>' +
      sources.map(function (s) {
        var h   = _priceFeedHealth[s.key];
        var ok  = h && h.ok;
        var age = h && h.lastOk ? Math.floor((Date.now() - h.lastOk) / 60000) : null;
        var dot = ok ? '#00c8a0' : (h ? '#ff4444' : '#555');
        var tip = ok ? (age !== null ? s.name + ' OK (' + age + 'm ago)' : s.name + ' OK')
                     : (h ? s.name + ' failing' : s.name + ' untested');
        return '<span title="' + tip + '" style="font-size:9px;margin-right:8px">' +
               '<span style="color:' + dot + '">●</span> ' +
               '<span style="color:var(--dim)">' + s.name + '</span></span>';
      }).join('');
  }

  function renderStatusBar() {
    var open   = openTrades();
    // Session-filtered closed trades — matches calcAnalytics so win rate stays consistent
    var sessionTs  = _sessionStart ? new Date(_sessionStart).getTime() : 0;
    var allClosed  = _trades.filter(function (t) { return t.status === 'CLOSED'; });
    var closed     = allClosed.filter(function (t) {
      return t.timestamp_close && new Date(t.timestamp_close).getTime() >= sessionTs;
    });
    var wins   = closed.filter(function (t) { return t.close_reason === 'TAKE_PROFIT' || t.close_reason === 'TRAILING_STOP'; });
    // Session P&L — balance change since session start (not vs hard-coded default)
    // A18: fall back to current balance (0 P&L) not the hardcoded default ($1000)
    // — avoids a misleading "+$4000" P&L flash on page load before init sets the baseline
    var startBal = _sessionStartBalance || _cfg.virtual_balance;
    var totPnl   = _cfg.virtual_balance - startBal;
    var rate   = closed.length ? Math.round(wins.length / closed.length * 100) : null;

    var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
    set('eeBadgeMode',    _cfg.mode);
    set('eeBadgeEnabled', _cfg.enabled ? 'AUTO ON' : 'AUTO OFF');
    set('eeBadgeBalance', '$' + _num(_cfg.virtual_balance));
    set('eeBadgeOpen',    open.length + ' OPEN');
    set('eeBadgePnl',     (totPnl >= 0 ? '+$' : '-$') + _num(Math.abs(totPnl)) + ' P&L');
    set('eeBadgeRate',    rate !== null ? rate + '% WIN (' + closed.length + ')' : '— WIN');
    set('eeOpenCount',    open.length);

    /* Attribution tooltip on win-rate badge — regime + confidence breakdown */
    var _rateBadge = document.getElementById('eeBadgeRate');
    if (_rateBadge && closed.length >= 3) {
      try {
        var _attrRec = JSON.parse(localStorage.getItem(_ATTR_KEY) || '[]');
        if (_attrRec.length >= 3) {
          /* By regime */
          var _byReg = {};
          _attrRec.forEach(function (r) {
            var rg = r.regime || 'UNKNOWN';
            if (!_byReg[rg]) _byReg[rg] = { t: 0, w: 0 };
            _byReg[rg].t++;
            if (r.win) _byReg[rg].w++;
          });
          var _regLines = Object.keys(_byReg).map(function (k) {
            var b = _byReg[k];
            return k + ': ' + Math.round(b.w / b.t * 100) + '% (' + b.t + ')';
          });
          /* By confidence band */
          var _byConf = { 'hi(85+)': {t:0,w:0}, 'mid(70-84)': {t:0,w:0}, 'lo(<70)': {t:0,w:0} };
          _attrRec.forEach(function (r) {
            var c = r.confidence || 0;
            var band = c >= 85 ? 'hi(85+)' : c >= 70 ? 'mid(70-84)' : 'lo(<70)';
            _byConf[band].t++; if (r.win) _byConf[band].w++;
          });
          var _confLines = Object.keys(_byConf).map(function (k) {
            var b = _byConf[k];
            return b.t ? k + ': ' + Math.round(b.w / b.t * 100) + '% (' + b.t + ')' : null;
          }).filter(Boolean);
          _rateBadge.title = 'By regime:\n' + _regLines.join('\n') +
                             '\n\nBy confidence:\n' + _confLines.join('\n');
        }
      } catch(e) {}
    }

    // Data safety banner: show until there are closed trades on record
    var banner = document.getElementById('eeDataSafetyBanner');
    if (banner) banner.style.display = allClosed.length === 0 ? 'block' : 'none';

    // Live mode warning — dynamic broker connection status
    var liveWarn = document.getElementById('eeLiveWarning');
    if (liveWarn) {
      if (_cfg.mode === 'LIVE') {
        var connectedBrokers = [];
        try { if (window.AlpacaBroker  && AlpacaBroker.isConnected())  connectedBrokers.push('Alpaca'); }  catch(e) {}
        try { if (window.OANDABroker   && OANDABroker.isConnected())   connectedBrokers.push('OANDA'); }   catch(e) {}
        try { if (window.HLBroker      && HLBroker.isConnected())      connectedBrokers.push('Hyperliquid'); } catch(e) {}
        try { if (window.TTBroker      && TTBroker.isConnected())      connectedBrokers.push('TickTrader'); } catch(e) {}
        if (connectedBrokers.length > 0) {
          liveWarn.innerHTML = '&#9889; LIVE MODE &mdash; Routing orders to: <b>' + connectedBrokers.join(', ') + '</b>. Real money at risk. Switch to SIMULATION to paper trade.';
          liveWarn.style.background    = 'rgba(255,68,68,0.12)';
          liveWarn.style.borderColor   = 'rgba(255,68,68,0.5)';
          liveWarn.style.color         = '#ff8888';
        } else {
          // Grace period: brokers auto-reconnect asynchronously on startup.
          // Don't show "No brokers connected" for the first 15s — show "connecting" instead.
          var _sinceInit = Date.now() - _initTs;
          if (_sinceInit < 15000) {
            liveWarn.innerHTML = '&#8987; LIVE MODE &mdash; Brokers connecting&hellip; (' + Math.ceil((15000 - _sinceInit) / 1000) + 's)';
          } else {
            liveWarn.innerHTML = '&#9888; LIVE MODE &mdash; No brokers connected. Orders will be rejected until a broker is connected. Switch to SIMULATION to paper trade.';
          }
          liveWarn.style.background  = '';
          liveWarn.style.borderColor = '';
          liveWarn.style.color       = '';
        }
        liveWarn.style.display = 'block';
      } else {
        liveWarn.style.display = 'none';
      }
    }

    // Backend offline warning banner
    var backendBanner = document.getElementById('eeBackendBanner');
    if (backendBanner) {
      if (!_apiOnline && _backendChecked) {
        backendBanner.style.display = 'flex';
        // Show how long backend has been offline (last check time)
        var bfh = _priceFeedHealth['backend'];
        if (bfh && bfh.lastFail) {
          var offSec = Math.round((Date.now() - bfh.lastFail) / 1000);
          var offStr = offSec < 60 ? offSec + 's' : Math.round(offSec / 60) + 'm';
          var timerEl = document.getElementById('eeBackendRetryTimer');
          if (timerEl) timerEl.textContent = 'Offline ' + offStr;
        }
      } else {
        backendBanner.style.display = 'none';
      }
    }

    var pnlEl = document.getElementById('eeBadgePnl');
    if (pnlEl) {
      pnlEl.className = 'ee-badge ' + (totPnl > 0 ? 'pos' : totPnl < 0 ? 'neg' : '');
    }

    var toggleBtn = document.getElementById('eeToggleBtn');
    if (toggleBtn) {
      toggleBtn.textContent = _cfg.enabled ? '\u25a0 STOP AUTO' : '\u25b6 START AUTO';
      // Red "danger" style when LIVE + AUTO ON — this is the emergency stop
      var isLiveDanger = _cfg.enabled && _cfg.mode === 'LIVE';
      toggleBtn.className = 'ee-toggle-btn' + (_cfg.enabled ? ' active' : '') + (isLiveDanger ? ' live-danger' : '');
      toggleBtn.title = isLiveDanger ? 'Click to stop automated live trading' : (_cfg.enabled ? 'Auto-execution is running' : 'Click to start auto-execution');
    }
    var modeBtn = document.getElementById('eeModeBtn');
    if (modeBtn) {
      modeBtn.textContent = 'MODE: ' + _cfg.mode;
      modeBtn.className   = 'ee-mode-btn ' + (_cfg.mode === 'LIVE' ? 'live' : 'sim');
    }
    var haltBtn = document.getElementById('eeHaltBtn');
    if (haltBtn) {
      haltBtn.textContent = _halted ? '\u25a0 HALTED' : '\u25a0 HALT';
      haltBtn.className   = 'ee-halt-btn' + (_halted ? ' halted' : '');
      haltBtn.title       = _halted
        ? 'Kill switch is ACTIVE — click to resume trade execution'
        : 'Emergency kill switch — halts all new trade execution immediately. Existing trades are unaffected.';
    }
    var subtitleEl = document.getElementById('eeSubtitle');
    if (subtitleEl) {
      // Market status: show which venues are currently open
      var _sbNow    = new Date();
      var _sbDay    = _sbNow.getUTCDay();  // 0=Sun, 6=Sat
      var _sbMo     = _sbNow.getUTCMonth();
      var _sbEtOff  = (_sbMo >= 2 && _sbMo <= 10) ? 240 : 300;
      var _sbEtMins = (_sbNow.getUTCHours() * 60 + _sbNow.getUTCMinutes() + 1440 - _sbEtOff) % 1440;
      // US equity: Mon–Fri 09:30–16:00 ET
      var _usOpen = _sbDay >= 1 && _sbDay <= 5 &&
                    _sbEtMins >= 570 && _sbEtMins < 960;  // 9:30–16:00
      // OANDA forex: Sun 17:00 ET – Fri 17:00 ET
      var _fxClosed2 = _sbDay === 6 ||
        (_sbDay === 5 && _sbEtMins >= 1020) ||  // Fri after 17:00 ET
        (_sbDay === 0 && _sbEtMins < 1020);      // Sun before 17:00 ET
      var _mktStatus = [];
      if (_usOpen) _mktStatus.push('US\u2009\u25cf');       // green dot via CSS
      else         _mktStatus.push('US\u2009\u25cb');
      if (!_fxClosed2) _mktStatus.push('FX\u2009\u25cf');
      else             _mktStatus.push('FX\u2009\u25cb');
      // Crypto: always 24/7
      _mktStatus.push('Crypto\u2009\u25cf');
      subtitleEl.innerHTML = 'Signal-driven trade automation &middot; ' +
        (_cfg.mode === 'LIVE' ? 'Live trading' : 'Paper trading') +
        ' &middot; ' +
        _mktStatus.map(function (s) {
          var open = s.indexOf('\u25cf') !== -1;
          return '<span style="color:' + (open ? '#22dd88' : '#888') + '">' + s + '</span>';
        }).join(' &nbsp; ');
    }
  }

  function renderConfigFields() {
    var fields = ['min_confidence','risk_per_trade_pct','stop_loss_pct',
                  'take_profit_ratio','max_open_trades','max_per_region','max_per_sector',
                  'virtual_balance','max_risk_usd','trailing_stop_pct','daily_loss_limit_pct',
                  'daily_profit_target_pct','event_gate_hours'];
    fields.forEach(function (f) {
      var el = document.getElementById('eeCfg_' + f);
      if (el && document.activeElement !== el) el.value = _cfg[f];
    });
    // Sync checkbox toggles
    var toggles = ['trailing_stop_enabled','break_even_enabled','partial_tp_enabled','event_gate_enabled'];
    toggles.forEach(function (f) {
      var el = document.getElementById('eeCfg_' + f);
      if (el) el.checked = !!_cfg[f];
    });
    // Streak indicator — shows loss streak warning OR win streak boost
    var streakEl = document.getElementById('eeStreakBadge');
    if (streakEl) {
      var _totalLoss = (_lossStreak.long || 0) + (_lossStreak.short || 0);
      var _maxLoss   = Math.max(_lossStreak.long || 0, _lossStreak.short || 0);
      var _maxWin    = Math.max(_winStreak.long  || 0, _winStreak.short  || 0);
      if (_totalLoss === 0 && _maxWin < 3) {
        streakEl.textContent = '';
        streakEl.style.display = 'none';
      } else if (_totalLoss > 0) {
        streakEl.style.display = 'inline';
        var streakParts = [];
        if (_lossStreak.long  > 0) streakParts.push('L×' + _lossStreak.long);
        if (_lossStreak.short > 0) streakParts.push('S×' + _lossStreak.short);
        var mult = _maxLoss >= 3 ? '½ size' : '¾ size';
        streakEl.textContent = '⚠ ' + streakParts.join(' ') + ' — ' + mult;
        streakEl.style.color = _maxLoss >= 3 ? 'var(--red)' : 'var(--amber)';
      } else {
        // Win streak — show boost badge
        streakEl.style.display = 'inline';
        var winParts = [];
        if (_winStreak.long  >= 3) winParts.push('L×' + _winStreak.long);
        if (_winStreak.short >= 3) winParts.push('S×' + _winStreak.short);
        streakEl.textContent = '🔥 ' + winParts.join(' ') + ' win streak';
        streakEl.style.color = 'var(--green)';
      }
    }
    // WebSocket status
    var wsEl = document.getElementById('eeWsBadge');
    if (wsEl) {
      wsEl.textContent = _wsConnected ? '⚡ WS BTC' : '· WS off';
      wsEl.style.color = _wsConnected ? 'var(--green)' : 'var(--dim)';
    }
  }

  function renderOpenTrades() {
    var el = document.getElementById('eeOpenTrades');
    if (!el) return;
    var open = openTrades();
    if (!open.length) {
      el.innerHTML = '<div class="ee-placeholder">No open trades. Enable auto-execution or wait for a high-confidence signal.</div>';
      return;
    }
    el.innerHTML = open.map(function (t) {
      var dirCls  = t.direction === 'LONG' ? 'ee-dir-long' : 'ee-dir-short';
      // Prefer freshly-polled price → price cache → on-page ticker scrape
      var _tok = normaliseAsset(t.asset);
      var livePx = _livePrice[t.trade_id] || _priceCache[_tok] || _tickerPrice(_tok) || null;

      // Unrealised P&L row — always rendered; shows placeholder if price unavailable
      var liveRow = '';
      if (livePx && t.entry_price && t.entry_price > 0) {
        var uPct = t.direction === 'LONG'
          ? (livePx - t.entry_price) / t.entry_price * 100
          : (t.entry_price - livePx) / t.entry_price * 100;
        var uUsd = t.units * Math.abs(livePx - t.entry_price) * (uPct >= 0 ? 1 : -1);
        var uCol = uPct >= 0 ? '#00c8a0' : '#ff4444';
        // Distance to SL and TP as % of entry
        var slDist = t.stop_loss   ? Math.abs(livePx - t.stop_loss)   / t.entry_price * 100 : null;
        var tpDist = t.take_profit ? Math.abs(t.take_profit - livePx) / t.entry_price * 100 : null;
        liveRow =
          '<div style="margin:6px 0 0 0;padding-top:6px;border-top:1px solid rgba(255,255,255,0.07)">' +
            '<span style="font-size:9px;color:var(--dim)">Live: <b style="color:var(--text)">$' + _num(livePx) + '</b></span>' +
            '&nbsp;&nbsp;' +
            '<span style="font-size:13px;font-weight:700;color:' + uCol + ';letter-spacing:0.3px">' +
              (uUsd >= 0 ? '+$' : '-$') + _num(Math.abs(uUsd)) +
            '</span>' +
            '&nbsp;<span style="font-size:10px;color:' + uCol + ';opacity:0.85">' +
              '(' + (uPct >= 0 ? '+' : '') + uPct.toFixed(2) + '%)' +
            '</span>' +
            (slDist !== null || tpDist !== null
              ? '&nbsp;&nbsp;<span style="font-size:9px;color:var(--dim)">' +
                  (slDist !== null ? 'SL&nbsp;' + slDist.toFixed(1) + '% away' : '') +
                  (slDist !== null && tpDist !== null ? '&nbsp;·&nbsp;' : '') +
                  (tpDist !== null ? 'TP&nbsp;' + tpDist.toFixed(1) + '% away' : '') +
                '</span>'
              : '') +
          '</div>';
      } else {
        liveRow =
          '<div style="font-size:9px;margin:5px 0 0 0;padding-top:5px;border-top:1px solid rgba(255,255,255,0.07);color:var(--dim)">' +
            'Unrealised P&amp;L: <span style="color:#888">awaiting price feed&hellip;</span>' +
          '</div>';
      }

      var venueBadge = t.venue === 'ALPACA'
        ? '<span style="font-size:7px;padding:1px 4px;border-radius:2px;background:#1a2a4a;color:#4da6ff;margin-left:4px;letter-spacing:0.5px">ALPACA</span>'
        : t.venue === 'OANDA'
        ? '<span style="font-size:7px;padding:1px 4px;border-radius:2px;background:#1a2a1a;color:#22dd88;margin-left:4px;letter-spacing:0.5px">OANDA</span>'
        : t.venue === 'TICKTRADER'
        ? '<span style="font-size:7px;padding:1px 4px;border-radius:2px;background:#2a1a2a;color:#dd88ff;margin-left:4px;letter-spacing:0.5px">TT</span>'
        : '<span style="font-size:7px;padding:1px 4px;border-radius:2px;background:#1a1a3a;color:#a78bfa;margin-left:4px;letter-spacing:0.5px">HL</span>';
      return '<div class="ee-trade-card">' +
        '<div class="ee-tc-hdr">' +
          '<span class="' + dirCls + '">' + _esc(t.direction) + '</span>' +
          '<span class="ee-tc-asset">' + _esc(t.asset) + '</span>' +
          venueBadge +
          '<span class="ee-tc-conf">' + t.confidence + '%</span>' +
          '<span class="ee-tc-age">' + _age(t.timestamp_open) + '</span>' +
          '<span class="ee-tc-mode ' + (t.mode === 'LIVE' ? 'live' : 'sim') + '">' + _esc(t.mode) + '</span>' +
        '</div>' +
        '<div class="ee-tc-prices">' +
          'Entry: <b>' + _num(t.entry_price) + '</b>' +
          ' &nbsp; <span class="ee-tc-sl">SL: ' + _num(t.stop_loss) + '</span>' +
          ' &nbsp; <span class="ee-tc-tp">TP: ' + _num(t.take_profit) + '</span>' +
          ' &nbsp; Size: $' + _num(t.size_usd) +
          ' &nbsp; <span style="color:#e040fb">Lev: ' + (t.size_usd > 0 ? (t.size_usd / _cfg.virtual_balance).toFixed(2) : '—') + '×</span>' +
          liveRow +
        '</div>' +
        '<div class="ee-tc-actions">' +
          '<button class="ee-tc-btn close-btn" onclick="EE.manualClose(\'' + _esc(t.trade_id) + '\')">&#10005; Close</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderClosedTrades() {
    var el = document.getElementById('eeClosedTrades');
    if (!el) return;

    // Session filter: only show trades closed after session start
    var sessionTs = _sessionStart ? new Date(_sessionStart).getTime() : 0;
    var allClosed = _trades.filter(function (t) {
      if (t.status !== 'CLOSED') return false;
      if (_closedSessionOnly && sessionTs) {
        var closeTs = t.timestamp_close ? new Date(t.timestamp_close).getTime() : 0;
        return closeTs >= sessionTs;
      }
      return true;
    });

    // Update toggle button label
    var btn = document.getElementById('eeClosedSessionBtn');
    if (btn) {
      btn.textContent = _closedSessionOnly ? 'All Time' : 'This Session';
      btn.style.color = _closedSessionOnly ? 'var(--green, #00e676)' : 'var(--dim)';
      btn.style.borderColor = _closedSessionOnly ? 'var(--green, #00e676)' : 'var(--dim)';
    }

    var closed    = _showAllClosed ? allClosed : allClosed.slice(0, 25);

    if (!allClosed.length) {
      // Show open trades as context instead of a blank panel
      var open = _trades.filter(function (t) { return t.status === 'OPEN'; });
      if (open.length) {
        el.innerHTML = '<div class="ee-placeholder" style="margin-bottom:6px">No closed trades yet — ' + open.length + ' position(s) open.</div>'
          + open.map(function (t) {
            return '<div class="ee-closed-row" style="opacity:0.6">'
              + '<span class="ee-cr-reason" style="color:var(--amber)">●</span>'
              + '<span class="ee-cr-asset">' + _esc(t.asset) + '</span>'
              + '<span class="ee-cr-dir ' + t.direction.toLowerCase() + '">' + t.direction + '</span>'
              + '<span class="ee-cr-pnl" style="color:var(--amber)">OPEN</span>'
              + '<span class="ee-cr-ts">' + _age(t.timestamp_open) + '</span>'
            + '</div>';
          }).join('');
      } else {
        el.innerHTML = '<div class="ee-placeholder">No closed trades yet.</div>';
      }
      return;
    }

    var rows = closed.map(function (t) {
      var pc  = t.pnl_pct || 0;
      var pu  = t.pnl_usd || 0;
      var cls = pc >= 0 ? 'pos' : 'neg';
      var icon    = (t.close_reason === 'TAKE_PROFIT' || t.close_reason === 'TRAILING_STOP') ? '\u2713' : t.close_reason === 'STOP_LOSS' ? '\u2717' : '\u2014';
      var iconCls = (t.close_reason === 'TAKE_PROFIT' || t.close_reason === 'TRAILING_STOP') ? 'tp' : 'sl';
      // R-multiple: pnl_usd / initial_risk_usd (1R = risked $, so 2R = 2× the risk)
      var rMult = '';
      if (t.initial_risk_usd && Math.abs(t.initial_risk_usd) > 0) {
        var r = pu / Math.abs(t.initial_risk_usd);
        rMult = '<span style="font-size:9px;color:' + (r >= 0 ? '#00c8a0' : '#ff4444') + ';margin-left:3px">' +
          (r >= 0 ? '+' : '') + r.toFixed(1) + 'R</span>';
      }
      // Small venue badge on closed rows
      var crVenue = t.venue === 'ALPACA' ? '<span style="font-size:7px;color:#4da6ff;margin-left:3px">ALP</span>'
        : t.venue === 'OANDA'      ? '<span style="font-size:7px;color:#22dd88;margin-left:3px">FX</span>'
        : t.venue === 'TICKTRADER' ? '<span style="font-size:7px;color:#dd88ff;margin-left:3px">TT</span>'
        : '<span style="font-size:7px;color:#a78bfa;margin-left:3px">HL</span>';
      return '<div class="ee-closed-row">' +
        '<span class="ee-cr-reason ' + iconCls + '">' + icon + '</span>' +
        '<span class="ee-cr-asset">' + _esc(t.asset) + crVenue + '</span>' +
        '<span class="ee-cr-dir ' + t.direction.toLowerCase() + '">' + t.direction + '</span>' +
        '<span class="ee-cr-pnl ' + cls + '">' + (pc >= 0 ? '+' : '') + pc + '%</span>' +
        '<span class="ee-cr-usd ' + cls + '">' + (pu >= 0 ? '+$' : '-$') + _num(Math.abs(pu)) + rMult + '</span>' +
        '<span class="ee-cr-ts">' + _age(t.timestamp_open) + '</span>' +
      '</div>';
    }).join('');

    // Show-all toggle when there are more than 25 closed trades
    var toggleBtn = '';
    if (allClosed.length > 25) {
      var label = _showAllClosed
        ? '&#9650; Show recent 25'
        : '&#9660; Show all ' + allClosed.length + ' trades';
      toggleBtn = '<div style="text-align:center;margin-top:6px">' +
        '<button onclick="EE.toggleAllClosed()" style="background:none;border:1px solid var(--dim);color:var(--dim);font-family:inherit;font-size:10px;padding:2px 10px;cursor:pointer;letter-spacing:1px">' +
        label + '</button></div>';
    }

    el.innerHTML = rows + toggleBtn;
  }

  function renderLog(el) {
    if (!_log.length) {
      el.innerHTML = '<div class="ee-placeholder">No activity yet.</div>';
      return;
    }
    el.innerHTML = _log.slice(0, 20).map(function (e) {
      var ts = new Date(e.ts);
      var t  = String(ts.getHours()).padStart(2, '0') + ':' + String(ts.getMinutes()).padStart(2, '0');
      return '<div class="ee-log-row">' +
        '<span class="ee-log-ts">' + t + '</span>' +
        '<span class="ee-log-action ' + (e.colour || 'dim') + '">' + e.action + '</span>' +
        '<span class="ee-log-msg">' + _esc(e.msg) + '</span>' +
      '</div>';
    }).join('');
  }

  /* ── Signal History Log ─────────────────────────────────────────────────────── */

  var _sigLogSessionOnly = false; // toggle: show this session's signals only

  function renderSigLog() {
    var el = document.getElementById('eeSigLog');
    if (!el) return;

    // Session filter
    var sessionTs  = _sessionStart ? new Date(_sessionStart).getTime() : 0;
    var logs = _sigLogSessionOnly
      ? _signalLog.filter(function (e) { return new Date(e.ts).getTime() >= sessionTs; })
      : _signalLog;

    // Update toggle button label
    var btn = document.getElementById('eeSigLogSessionBtn');
    if (btn) btn.textContent = _sigLogSessionOnly ? 'All Signals' : 'This Session';

    if (!logs.length) {
      el.innerHTML = '<div class="ee-placeholder">' +
        (_sigLogSessionOnly ? 'No signals this session yet.' : 'No signals seen yet — waiting for IC cycle.') +
        '</div>';
      return;
    }
    el.innerHTML = logs.slice(0, 50).map(function (e) {
      var d   = new Date(e.ts);
      var ts  = String(d.getMonth()+1).padStart(2,'0') + '/' +
                String(d.getDate()).padStart(2,'0') + ' ' +
                String(d.getHours()).padStart(2,'0') + ':' +
                String(d.getMinutes()).padStart(2,'0');
      var actionCls = e.action === 'TRADED' ? 'sl-act-traded'
                    : e.action === 'WATCH'  ? 'sl-act-watch'
                    : 'sl-act-skipped';
      var actionLbl = e.action === 'TRADED' ? '&#10003; TRADED'
                    : e.action === 'WATCH'  ? '&#9900; WATCH'
                    : '&#8212; SKIP';
      var dirCls  = e.dir === 'LONG' ? 'sl-long' : e.dir === 'SHORT' ? 'sl-short' : 'sl-watch-dir';
      // For skipped signals, show reason prominently in place of region (more useful than region name)
      var lastCol = (e.action === 'SKIP' && e.skip_reason)
        ? '<span class="sl-skip-reason prominent" style="color:#ff9500;font-style:normal;font-weight:600;grid-column:auto">' + _esc(e.skip_reason) + '</span>'
        : '<span class="ee-sl-region">' + _esc(e.region) + '</span>';
      return '<div class="ee-sl-row">' +
        '<span class="ee-sl-ts">'  + ts + '</span>' +
        '<span class="ee-sl-asset">' + _esc(e.asset) + '</span>' +
        '<span class="ee-sl-dir ' + dirCls + '">' + _esc(e.dir) + '</span>' +
        '<span class="ee-sl-conf">' + e.conf + '%</span>' +
        '<span class="ee-sl-act ' + actionCls + '">' + actionLbl + '</span>' +
        lastCol +
      '</div>';
    }).join('');
  }

  /* ── Risk Tuning Simulator ──────────────────────────────────────────────────── */

  /* Replay closed trades using different risk settings — pure read-only calc */
  function simAnalytics(cfg) {
    var closed   = _trades.filter(function (t) { return t.status === 'CLOSED'; });
    var eligible = closed.filter(function (t) { return (t.confidence || 0) >= cfg.min_confidence; });
    if (!eligible.length) return { count: 0, winRate: 0, totalPnl: 0, maxDD: 0, pf: null };

    // A19: use a fixed starting balance so sim results are reproducible regardless
    // of current account size — live balance makes comparisons misleading
    var balance  = DEFAULTS.virtual_balance;
    var riskUsd  = balance * cfg.risk_per_trade_pct / 100;
    var wins = 0, totalPnl = 0, peak = 0, running = 0, maxDD = 0, grossWins = 0, grossLoss = 0;

    eligible.forEach(function (t) {
      var pnl;
      if (t.close_reason === 'TAKE_PROFIT' || t.close_reason === 'TRAILING_STOP') {
        pnl = riskUsd * cfg.take_profit_ratio;
        wins++;
        grossWins += pnl;
      } else {
        pnl = -riskUsd;
        grossLoss += riskUsd;
      }
      totalPnl += pnl;
      running  += pnl;
      if (running > peak) peak = running;
      var dd = peak - running;
      if (dd > maxDD) maxDD = dd;
    });

    return {
      count:    eligible.length,
      winRate:  wins / eligible.length * 100,
      totalPnl: totalPnl,
      maxDD:    maxDD,
      pf:       grossLoss > 0 ? grossWins / grossLoss : (grossWins > 0 ? Infinity : null)
    };
  }

  function renderSim() {
    var wrap = document.getElementById('eeSimWrap');
    if (!wrap) return;

    var closed = _trades.filter(function (t) { return t.status === 'CLOSED'; });
    var countEl = document.getElementById('eeSimTradeCount');
    if (countEl) countEl.textContent = closed.length + ' closed trade' + (closed.length !== 1 ? 's' : '');
    var balEl = document.getElementById('eeSimBal');
    if (balEl) balEl.textContent = (_cfg.virtual_balance || 10000).toLocaleString();

    /* Read slider values */
    function slVal(id, def) {
      var e = document.getElementById(id);
      return e ? parseFloat(e.value) : def;
    }
    var testCfg = {
      min_confidence:     slVal('simConf',   _cfg.min_confidence    || 65),
      stop_loss_pct:      slVal('simSL',     _cfg.stop_loss_pct     || 3),
      take_profit_ratio:  slVal('simTP',     _cfg.take_profit_ratio || 2),
      risk_per_trade_pct: slVal('simRisk',   _cfg.risk_per_trade_pct|| 2)
    };

    /* Update displayed values next to sliders */
    function setLabel(id, val, suffix) {
      var e = document.getElementById(id); if (e) e.textContent = val + (suffix || '');
    }
    setLabel('simConfVal',  testCfg.min_confidence,     '%');
    setLabel('simSLVal',    testCfg.stop_loss_pct,       '%');
    setLabel('simTPVal',    testCfg.take_profit_ratio,   'x');
    setLabel('simRiskVal',  testCfg.risk_per_trade_pct,  '%');

    /* Current actual settings */
    var curCfg = {
      min_confidence:     _cfg.min_confidence,
      stop_loss_pct:      _cfg.stop_loss_pct,
      take_profit_ratio:  _cfg.take_profit_ratio,
      risk_per_trade_pct: _cfg.risk_per_trade_pct
    };

    var cur  = simAnalytics(curCfg);
    var test = simAnalytics(testCfg);

    function fmt(v, prefix, decimals) {
      if (v === null || v === undefined) return '—';
      if (v === Infinity) return '∞';
      return (prefix || '') + v.toFixed(decimals !== undefined ? decimals : 2);
    }
    function colClass(v) { return v > 0 ? 'sim-pos' : v < 0 ? 'sim-neg' : ''; }

    var rows = [
      ['Trades Taken',   cur.count,    test.count,    '', 0],
      ['Win Rate',       cur.winRate,  test.winRate,  '%', 1],
      ['Total P&L',      cur.totalPnl, test.totalPnl, '$', 2],
      ['Max Drawdown',   -cur.maxDD,   -test.maxDD,   '$', 2],
      ['Profit Factor',  cur.pf,       test.pf,       '',  2]
    ];

    var tbody = document.getElementById('eeSimTbody');
    if (tbody) {
      tbody.innerHTML = rows.map(function (r) {
        var label = r[0], cV = r[1], tV = r[2], sfx = r[3], dec = r[4];
        var cStr = (cV === null || cV === undefined) ? '—'
                 : (sfx === '$' ? (cV >= 0 ? '+$' : '-$') + Math.abs(cV).toFixed(dec) : cV.toFixed(dec) + sfx);
        var tStr = (tV === null || tV === undefined) ? '—'
                 : (sfx === '$' ? (tV >= 0 ? '+$' : '-$') + Math.abs(tV).toFixed(dec) : tV.toFixed(dec) + sfx);
        if (r[0] === 'Trades Taken' || r[0] === 'Profit Factor') {
          cStr = cV === null ? '—' : (cV === Infinity ? '∞' : cV.toFixed ? cV.toFixed(dec) : cV);
          tStr = tV === null ? '—' : (tV === Infinity ? '∞' : tV.toFixed ? tV.toFixed(dec) : tV);
        }
        var diff = (typeof cV === 'number' && typeof tV === 'number') ? (tV - cV) : null;
        var diffStr = diff === null ? ''
                    : diff > 0 ? '<span class="sim-pos">▲ ' + Math.abs(diff).toFixed(dec) + sfx + '</span>'
                    : diff < 0 ? '<span class="sim-neg">▼ ' + Math.abs(diff).toFixed(dec) + sfx + '</span>'
                    : '<span class="sim-flat">= no change</span>';
        return '<tr>' +
          '<td class="sim-label">' + label + '</td>' +
          '<td class="' + colClass(cV) + '">' + cStr + '</td>' +
          '<td class="' + colClass(tV) + '">' + tStr + '</td>' +
          '<td>' + diffStr + '</td>' +
        '</tr>';
      }).join('');
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     HELPERS
     ══════════════════════════════════════════════════════════════════════════════ */

  function _esc(s) {
    // A15: also escape quotes — required for safe use inside HTML attribute values
    // (e.g. onclick="EE.manualClose('...')" where trade_id is user/DB-supplied)
    // F20: also escape backticks and newlines which could break inline event handlers
    return String(s || '')
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/'/g,  '&#39;')
      .replace(/"/g,  '&quot;')
      .replace(/`/g,  '&#96;')
      .replace(/\n/g, '&#10;')
      .replace(/\r/g, '&#13;');
  }

  function _num(n) {
    var v = parseFloat(n);
    if (isNaN(v)) return '—';
    if (v >= 10000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (v >= 100)   return v.toFixed(2);
    if (v >= 1)     return v.toFixed(4);
    return v.toFixed(6);
  }

  function _age(ts) {
    var ms = Date.now() - new Date(ts).getTime();
    var m  = Math.floor(ms / 60000);
    var h  = Math.floor(m / 60);
    var d  = Math.floor(h / 24);
    if (d > 0) return d + 'd ago';
    if (h > 0) return h + 'h ago';
    return m + 'm ago';
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     STRATEGY ANALYTICS
     ══════════════════════════════════════════════════════════════════════════════ */

  /* Compute all analytics metrics from closed trade history */
  function calcAnalytics() {
    // Only count trades closed after the current session started.
    // This means sessionReset() (which updates _sessionStart to NOW) immediately
    // clears analytics even though historical trades stay in the backend DB.
    var sessionTs = _sessionStart ? new Date(_sessionStart).getTime() : 0;
    var closed = _trades.filter(function (t) {
      return t.status === 'CLOSED' &&
             t.timestamp_close &&
             new Date(t.timestamp_close).getTime() >= sessionTs;
    });
    var sorted = closed.slice().sort(function (a, b) {
      return new Date(a.timestamp_close) - new Date(b.timestamp_close);
    });

    // Fix #16: single-pass analytics — previously 11 separate .filter/.forEach/.map
    // passes over the same closed/sorted array. Now one loop computes everything.
    var _ddBaseline = _cfg.virtual_balance || 1000;
    var _nowMs      = Date.now();
    var DAY_MS = 86400000, WEEK_MS = 604800000;

    // Accumulators
    var winsCount = 0, lossesCount = 0;
    var sumWinPct = 0, sumLossPct = 0, sumWinUsd = 0, sumLossUsd = 0;
    var grossWins = 0, grossLoss = 0;
    var equity = [], cumPnl = 0;
    var ddPeak = 0, ddRunning = 0, maxDDUsd = 0, maxDDPct = 0;
    var durs = [], returns = [];
    var wrDayW = 0, wrDayL = 0, wrWeekW = 0, wrWeekL = 0;
    var assetMap = {}, regionMap = {};
    var buckets = { '<-5%': 0, '-5~-2%': 0, '-2~0%': 0, '0~2%': 0, '2~5%': 0, '>5%': 0 };
    var scalperStats = {};

    sorted.forEach(function (t) {
      // C4 fix: use total_pnl_usd (final close + partial TP banked) for analytics.
      // Without this, a trade that partially TP'd (+$20) and then stopped at break-even (-$2)
      // would be classified as a LOSS (pnl_usd = -$2), even though net P&L = +$18.
      var pnl   = t.total_pnl_usd !== undefined ? t.total_pnl_usd : (t.pnl_usd || 0);
      var isWin = pnl > 0;

      // Win/loss tallies
      if (isWin) {
        winsCount++;  sumWinPct  += (t.pnl_pct || 0);  sumWinUsd  += pnl;  grossWins += pnl;
      } else {
        lossesCount++; sumLossPct += (t.pnl_pct || 0); sumLossUsd += pnl;  grossLoss += Math.abs(pnl);
      }

      // Equity curve
      cumPnl += pnl;
      equity.push({ ts: t.timestamp_close, bal: cumPnl });

      // Max drawdown
      ddRunning += pnl;
      if (ddRunning > ddPeak) ddPeak = ddRunning;
      var dd = ddPeak - ddRunning;
      if (dd > maxDDUsd) { maxDDUsd = dd; maxDDPct = _ddBaseline > 0 ? dd / _ddBaseline * 100 : 0; }

      // Duration (hours) + Sharpe returns
      if (t.timestamp_close && t.timestamp_open) {
        durs.push((new Date(t.timestamp_close) - new Date(t.timestamp_open)) / 3600000);
      }
      returns.push(pnl / (t.size_usd || 1));

      // Timeframe counters
      var tAge = _nowMs - new Date(t.timestamp_close).getTime();
      if (tAge <= DAY_MS)  { if (isWin) wrDayW++;  else wrDayL++; }
      if (tAge <= WEEK_MS) { if (isWin) wrWeekW++; else wrWeekL++; }

      // Per-asset
      var ak = t.asset || 'Unknown';
      if (!assetMap[ak]) assetMap[ak] = { wins: 0, losses: 0, pnl_usd: 0, partial: 0 };
      if (isWin) assetMap[ak].wins++; else assetMap[ak].losses++;
      assetMap[ak].pnl_usd += pnl;
      if (t.partial_tp_taken) assetMap[ak].partial++;

      // Per-region
      var rk = t.region || 'GLOBAL';
      if (!regionMap[rk]) regionMap[rk] = { wins: 0, losses: 0, pnl_usd: 0 };
      if (isWin) regionMap[rk].wins++; else regionMap[rk].losses++;
      regionMap[rk].pnl_usd += pnl;

      // P&L distribution
      var p = t.pnl_pct || 0;
      if      (p < -5) buckets['<-5%']++;
      else if (p < -2) buckets['-5~-2%']++;
      else if (p <  0) buckets['-2~0%']++;
      else if (p <  2) buckets['0~2%']++;
      else if (p <  5) buckets['2~5%']++;
      else             buckets['>5%']++;

      // Per-scalper agent
      var src = t.source || _inferSource(t.reason || '');
      if (src && src.indexOf('scalper') !== -1) {
        if (!scalperStats[src]) scalperStats[src] = { trades: 0, wins: 0, losses: 0, pnl: 0, partial: 0, durs: [] };
        var ss = scalperStats[src];
        ss.trades++;
        if (isWin) ss.wins++; else ss.losses++;
        // A14: pnl is already total_pnl_usd (which includes partial_pnl_usd) —
        // adding partial_pnl_usd again double-counted every partial-TP trade.
        ss.pnl += pnl;
        if (t.partial_tp_taken) ss.partial++;
        if (t.timestamp_open && t.timestamp_close) {
          var sdur = (new Date(t.timestamp_close).getTime() - new Date(t.timestamp_open).getTime()) / 60000;
          if (sdur > 0) ss.durs.push(sdur);
        }
      }
    });

    // Derived values from accumulators
    var total      = sorted.length;
    var avgWinPct  = winsCount  ? sumWinPct  / winsCount  : 0;
    var avgLossPct = lossesCount ? sumLossPct / lossesCount : 0;
    var avgWinUsd  = winsCount  ? sumWinUsd  / winsCount  : 0;
    var avgLossUsd = lossesCount ? sumLossUsd / lossesCount : 0;
    var profitFactor = grossLoss > 0 ? grossWins / grossLoss : (grossWins > 0 ? Infinity : null);
    var winRate    = total ? winsCount / total : 0;
    var expectancy = winRate * avgWinUsd + (1 - winRate) * avgLossUsd;

    function _tfObj(w, l) {
      var tot = w + l;
      return { wins: w, losses: l, total: tot, pct: tot ? Math.round(w / tot * 100) : null };
    }
    var wrDay  = _tfObj(wrDayW,   wrDayL);
    var wrWeek = _tfObj(wrWeekW,  wrWeekL);
    var wrAll  = _tfObj(winsCount, lossesCount);

    var avgDur = durs.length ? durs.reduce(function (s, v) { return s + v; }, 0) / durs.length : null;
    var minDur = durs.length ? Math.min.apply(null, durs) : null;
    var maxDur = durs.length ? Math.max.apply(null, durs) : null;

    /* Sharpe ratio — per-trade return (pnl / size_usd), annualised */
    var sharpeRatio = null;
    if (total >= 3) {
      var meanR = returns.reduce(function (s, r) { return s + r; }, 0) / returns.length;
      var variance = returns.reduce(function (s, r) { return s + (r - meanR) * (r - meanR); }, 0) / (returns.length - 1);
      var stdR = Math.sqrt(variance);
      if (stdR > 0) {
        var avgDurHrs = avgDur !== null ? avgDur : 24;
        // M4 fix: 8760/avgDur assumes 24/7 trading, overstating Sharpe ~1.2× for
        // market-hours systems. Cap at 250 trading days/year × (24/avgDur) to account
        // for the fact that signals only fire during active market sessions.
        var tradesPerYear = Math.min(8760 / Math.max(avgDurHrs, 0.25), 250 * (24 / Math.max(avgDurHrs, 1)));
        sharpeRatio = +(meanR / stdR * Math.sqrt(tradesPerYear)).toFixed(2);
      }
    }
    // Also include all-time open scalp count
    var openScalpers = _trades.filter(function (t) {
      if (t.status !== 'OPEN') return false;
      var src = t.source || _inferSource(t.reason || '');
      return src && src.indexOf('scalper') !== -1;
    });

    return {
      closed: total, equity: equity,
      maxDDPct: maxDDPct, maxDDUsd: maxDDUsd,
      avgWinPct: avgWinPct, avgLossPct: avgLossPct,
      avgWinUsd: avgWinUsd, avgLossUsd: avgLossUsd,
      profitFactor: profitFactor, expectancy: expectancy,
      wrDay: wrDay, wrWeek: wrWeek, wrAll: wrAll,
      avgDur: avgDur, minDur: minDur, maxDur: maxDur,
      assetMap: assetMap, regionMap: regionMap, buckets: buckets,
      scalperStats: scalperStats, openScalpers: openScalpers,
      sharpeRatio: sharpeRatio
    };
  }

  /* ── Canvas chart helpers ──────────────────────────────────────────────── */

  function _setupCanvas(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    var dpr  = window.devicePixelRatio || 1;
    var cw   = el.offsetWidth || 400;
    var ch   = parseInt(el.getAttribute('height'), 10) || 160;
    el.width  = Math.round(cw * dpr);
    el.height = Math.round(ch * dpr);
    el.style.width  = cw + 'px';
    el.style.height = ch + 'px';
    var ctx = el.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx: ctx, w: cw, h: ch };
  }

  function _clearCanvas(ctx, w, h) {
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);
  }

  function _noData(ctx, w, h, msg) {
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg || 'No data yet', w / 2, h / 2);
  }

  /* Cumulative equity / P&L curve */
  function drawEquityCurve(canvasId, points) {
    var c = _setupCanvas(canvasId);
    if (!c) return;
    var ctx = c.ctx, w = c.w, h = c.h;
    _clearCanvas(ctx, w, h);

    if (!points || !points.length) { _noData(ctx, w, h, 'No closed trades yet'); return; }

    var pad = { t: 10, r: 10, b: 24, l: 52 };
    var cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;

    var allVals = [0].concat(points.map(function (p) { return p.bal; }));
    var minV = Math.min.apply(null, allVals), maxV = Math.max.apply(null, allVals);
    var range = maxV - minV || 1;

    /* Horizontal grid */
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (var gi = 0; gi <= 4; gi++) {
      var gy = pad.t + ch - (gi / 4) * ch;
      ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(pad.l + cw, gy); ctx.stroke();
      var lv = minV + (gi / 4) * range;
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '8px monospace'; ctx.textAlign = 'right';
      ctx.fillText((lv >= 0 ? '+$' : '-$') + _num(Math.abs(lv)), pad.l - 4, gy + 3);
    }

    /* Zero dashed line */
    var zeroY = pad.t + ch - ((0 - minV) / range * ch);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pad.l, zeroY); ctx.lineTo(pad.l + cw, zeroY); ctx.stroke();
    ctx.setLineDash([]);

    /* Plot coordinates */
    var coords = allVals.map(function (v, i) {
      return { x: pad.l + (i / (allVals.length - 1 || 1)) * cw,
               y: pad.t + ch - ((v - minV) / range * ch) };
    });

    var lastBal  = allVals[allVals.length - 1];
    var lineCol  = lastBal >= 0 ? '#00c8a0' : '#ff4444';
    var fillTop  = lastBal >= 0 ? 'rgba(0,200,160,0.22)' : 'rgba(255,68,68,0.22)';

    /* Fill under curve */
    var grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch);
    grad.addColorStop(0, fillTop); grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.moveTo(coords[0].x, pad.t + ch);
    coords.forEach(function (p) { ctx.lineTo(p.x, p.y); });
    ctx.lineTo(coords[coords.length - 1].x, pad.t + ch);
    ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

    /* Line */
    ctx.beginPath();
    ctx.moveTo(coords[0].x, coords[0].y);
    coords.slice(1).forEach(function (p) { ctx.lineTo(p.x, p.y); });
    ctx.strokeStyle = lineCol; ctx.lineWidth = 2; ctx.stroke();

    /* Terminal dot */
    var last = coords[coords.length - 1];
    ctx.beginPath(); ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = lineCol; ctx.fill();
  }

  /* P&L distribution — vertical bar chart */
  function drawDistribution(canvasId, buckets) {
    var c = _setupCanvas(canvasId);
    if (!c) return;
    var ctx = c.ctx, w = c.w, h = c.h;
    _clearCanvas(ctx, w, h);

    var pad  = { t: 14, r: 10, b: 38, l: 20 };
    var cw   = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    var lbls = Object.keys(buckets);
    var vals = lbls.map(function (k) { return buckets[k]; });
    var maxV = Math.max.apply(null, vals) || 1;
    var bw   = cw / lbls.length;
    var bp   = 4;
    var cols = ['#cc3333','#ee6644','#ffaa44','#44aa88','#00c8a0','#00ddbb'];

    lbls.forEach(function (lbl, i) {
      var v   = vals[i];
      var bh  = ch * (v / maxV);
      var x   = pad.l + i * bw + bp;
      var bww = bw - bp * 2;
      var y   = pad.t + ch - bh;

      ctx.fillStyle = cols[i] || '#888';
      ctx.fillRect(x, y, bww, bh);

      if (v > 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = '9px monospace'; ctx.textAlign = 'center';
        ctx.fillText(v, x + bww / 2, y - 3);
      }

      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.font = '7px monospace'; ctx.textAlign = 'center';
      ctx.fillText(lbl, x + bww / 2, pad.t + ch + 12);
    });
  }

  /* Trades per asset — stacked win/loss vertical bars */
  function drawTradesPerAsset(canvasId, assetMap) {
    var c = _setupCanvas(canvasId);
    if (!c) return;
    var ctx = c.ctx, w = c.w, h = c.h;
    _clearCanvas(ctx, w, h);

    var entries = Object.keys(assetMap).map(function (k) {
      var d = assetMap[k];
      return { label: k, wins: d.wins, losses: d.losses, total: d.wins + d.losses };
    }).sort(function (a, b) { return b.total - a.total; }).slice(0, 8);

    if (!entries.length) { _noData(ctx, w, h); return; }

    var pad  = { t: 14, r: 10, b: 36, l: 10 };
    var cw   = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    var maxT = Math.max.apply(null, entries.map(function (e) { return e.total; })) || 1;
    var bw   = cw / entries.length, bp = 3;

    entries.forEach(function (e, i) {
      var x    = pad.l + i * bw + bp;
      var bww  = bw - bp * 2;
      var winH = ch * (e.wins   / maxT);
      var losH = ch * (e.losses / maxT);

      ctx.fillStyle = 'rgba(0,200,160,0.72)';
      ctx.fillRect(x, pad.t + ch - winH - losH, bww, winH);
      ctx.fillStyle = 'rgba(255,68,68,0.72)';
      ctx.fillRect(x, pad.t + ch - losH, bww, losH);

      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '8px monospace'; ctx.textAlign = 'center';
      if (e.total > 0) ctx.fillText(e.total, x + bww / 2, pad.t + ch - winH - losH - 3);

      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.font = '7px monospace'; ctx.textAlign = 'center';
      ctx.fillText(e.label.split(' ')[0].substring(0, 6), x + bww / 2, pad.t + ch + 14);
    });
  }

  /* Horizontal bar chart — asset P&L or region P&L */
  function drawHBar(canvasId, items, valueKey, labelKey, colorFn) {
    var c = _setupCanvas(canvasId);
    if (!c) return;
    var ctx = c.ctx, w = c.w, h = c.h;
    _clearCanvas(ctx, w, h);

    var slice = (items || []).slice(0, 8);
    if (!slice.length) { _noData(ctx, w, h); return; }

    var labW = 82, valW = 52;
    var barAreaW = w - labW - valW - 8;
    var rowH = h / slice.length;
    var vals = slice.map(function (d) { return Math.abs(d[valueKey] || 0); });
    var maxV = Math.max.apply(null, vals) || 1;

    slice.forEach(function (d, i) {
      var v   = d[valueKey] || 0;
      var bw  = barAreaW * (Math.abs(v) / maxV);
      var y   = i * rowH;
      var midY = y + rowH / 2;

      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'transparent';
      ctx.fillRect(0, y, w, rowH);

      var col = colorFn ? colorFn(v) : (v >= 0 ? '#00c8a0' : '#ff4444');
      ctx.fillStyle = col;
      ctx.fillRect(labW, midY - rowH * 0.3, bw, rowH * 0.6);

      /* Label */
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.font = '8px monospace'; ctx.textAlign = 'right';
      ctx.fillText(String(d[labelKey] || '').substring(0, 11), labW - 5, midY + 3);

      /* Value */
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.fillText((v >= 0 ? '+$' : '-$') + _num(Math.abs(v)), labW + bw + 5, midY + 3);
    });
  }

  /* ── renderAnalytics — updates all KPIs and redraws all charts ─────────── */

  function renderAnalytics() {
    var a = calcAnalytics();

    var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };

    /* ── Win rates ── */
    function wrText(wr) { return wr.total === 0 ? '—' : wr.pct + '%'; }
    function wrSub(wr)  {
      if (wr.total === 0) return 'No closed trades';
      return wr.wins + 'W / ' + wr.losses + 'L  (' + wr.total + ')';
    }
    function applyWrCls(id, wr) {
      var el = document.getElementById(id);
      if (!el) return;
      el.className = 'ee-an-wr-val' +
        (wr.total === 0 ? ' dim' : wr.pct >= 55 ? ' good' : wr.pct < 45 ? ' bad' : '');
    }

    set('eeAnWinDay',     wrText(a.wrDay));
    set('eeAnWinDaySub',  wrSub(a.wrDay));
    applyWrCls('eeAnWinDay', a.wrDay);

    set('eeAnWinWeek',    wrText(a.wrWeek));
    set('eeAnWinWeekSub', wrSub(a.wrWeek));
    applyWrCls('eeAnWinWeek', a.wrWeek);

    set('eeAnWinAll',    wrText(a.wrAll));
    set('eeAnWinAllSub', wrSub(a.wrAll));
    applyWrCls('eeAnWinAll', a.wrAll);

    /* ── KPIs ── */
    set('eeAnMaxDD',  a.closed ? '-' + a.maxDDPct.toFixed(1) + '%' : '—');
    set('eeAnAvgWin', a.closed ? '+' + a.avgWinPct.toFixed(2) + '%' : '—');
    set('eeAnAvgLoss', a.closed ? a.avgLossPct.toFixed(2) + '%' : '—');

    var pfEl = document.getElementById('eeAnPF');
    if (pfEl) {
      if (a.profitFactor === null) {
        pfEl.textContent = '—'; pfEl.className = 'ee-an-kpi-val dim';
      } else if (!isFinite(a.profitFactor)) {
        pfEl.textContent = '∞'; pfEl.className = 'ee-an-kpi-val green';
      } else {
        pfEl.textContent = a.profitFactor.toFixed(2);
        pfEl.className = 'ee-an-kpi-val ' +
          (a.profitFactor >= 1.5 ? 'green' : a.profitFactor < 1 ? 'red' : '');
      }
    }

    var exEl = document.getElementById('eeAnExpect');
    if (exEl) {
      if (!a.closed) { exEl.textContent = '—'; exEl.className = 'ee-an-kpi-val dim'; }
      else {
        exEl.textContent = (a.expectancy >= 0 ? '+$' : '-$') + _num(Math.abs(a.expectancy));
        exEl.className = 'ee-an-kpi-val ' + (a.expectancy > 0 ? 'green' : 'red');
      }
    }

    /* ── Sharpe Ratio & Max DD USD ── */
    var srEl = document.getElementById('eeAnSharpe');
    if (srEl) {
      if (a.sharpeRatio === null) {
        srEl.textContent = '—';
        srEl.className = 'ee-an-kpi-val dim';
      } else {
        srEl.textContent = a.sharpeRatio.toFixed(2);
        srEl.className = 'ee-an-kpi-val ' +
          (a.sharpeRatio >= 1.5 ? 'green' : a.sharpeRatio < 0 ? 'red' : '');
      }
    }

    /* Max DD in USD (already have pct; also show dollar amount) */
    var ddUsdEl = document.getElementById('eeAnMaxDDUsd');
    if (ddUsdEl) {
      ddUsdEl.textContent = a.closed && a.maxDDUsd > 0 ? '-$' + _num(a.maxDDUsd) : '—';
    }

    /* ── Duration stats ── */
    function fmtDur(hrs) {
      if (hrs === null) return '—';
      if (hrs < 1)  return Math.round(hrs * 60) + 'm';
      if (hrs < 24) return hrs.toFixed(1) + 'h';
      return (hrs / 24).toFixed(1) + 'd';
    }
    set('eeAnAvgDur', fmtDur(a.avgDur));
    set('eeAnMinDur', fmtDur(a.minDur));
    set('eeAnMaxDur', fmtDur(a.maxDur));

    /* ── Charts ── */
    drawEquityCurve('eeChartEquity', a.equity);
    drawDistribution('eeChartDist', a.buckets);
    drawTradesPerAsset('eeChartAsset', a.assetMap);

    var assetPnlItems = Object.keys(a.assetMap).map(function (k) {
      return { label: k, pnl_usd: a.assetMap[k].pnl_usd };
    }).sort(function (x, y) { return Math.abs(y.pnl_usd) - Math.abs(x.pnl_usd); });
    drawHBar('eeChartAssetPnl', assetPnlItems, 'pnl_usd', 'label',
      function (v) { return v >= 0 ? '#00c8a0' : '#ff4444'; });

    /* ── Open positions unrealised P&L bar ── */
    var openEl = document.getElementById('eeAnOpenPnl');
    if (openEl) {
      var openT = openTrades();
      if (!openT.length) {
        openEl.textContent = 'No open positions';
        openEl.style.color = 'var(--dim)';
      } else {
        var totPct = 0, totUsd = 0, priced = 0;
        openT.forEach(function (t) {
          var px = _livePrice[t.trade_id] || null;
          if (!px) return;
          var p = t.direction === 'LONG'
            ? (px - t.entry_price) / t.entry_price * 100
            : (t.entry_price - px) / t.entry_price * 100;
          totPct += p;
          totUsd += t.units * Math.abs(px - t.entry_price) * (p >= 0 ? 1 : -1);
          priced++;
        });
        if (priced === 0) {
          openEl.textContent = openT.length + ' open trade' + (openT.length > 1 ? 's' : '') + ' — awaiting price feed';
          openEl.style.color = 'var(--dim)';
        } else {
          var ap = Math.round(totPct * 100) / 100;
          var au = Math.round(totUsd * 100) / 100;
          openEl.textContent = openT.length + ' open · Unrealised: ' +
            (ap >= 0 ? '+' : '') + ap.toFixed(1) + '%  (' +
            (au >= 0 ? '+$' : '-$') + _num(Math.abs(au)) + ')';
          openEl.style.color = totUsd >= 0 ? 'var(--green)' : 'var(--red)';
        }
      }
    }

    var regionItems = Object.keys(a.regionMap).map(function (k) {
      return { label: k, pnl_usd: a.regionMap[k].pnl_usd };
    }).sort(function (x, y) { return Math.abs(y.pnl_usd) - Math.abs(x.pnl_usd); });
    drawHBar('eeChartRegion', regionItems, 'pnl_usd', 'label',
      function (v) { return v >= 0 ? '#00c8a0' : '#ff4444'; });

    // ── Per-asset win rate breakdown ─────────────────────────────────────────
    var assetEl = document.getElementById('eeAssetWinRate');
    if (assetEl) {
      // F32 fix: calcAnalytics() already built assetMap — reuse it instead of
      // re-filtering and re-iterating all closed trades a second time.
      if (!a.closed) {
        assetEl.innerHTML = '<span style="color:var(--dim);font-size:10px">No closed trades yet.</span>';
      } else {
        var assetStats = a.assetMap; // already computed above
        var assetKeys = Object.keys(assetStats).sort(function (a, b) {
          // A4 fix: field is pnl_usd, not pnl
          return Math.abs(assetStats[b].pnl_usd) - Math.abs(assetStats[a].pnl_usd);
        });
        var rows = assetKeys.map(function (k) {
          var s = assetStats[k];
          var tot = s.wins + s.losses;
          var wr = tot ? Math.round(s.wins / tot * 100) : 0;
          var wrCls = wr >= 60 ? 'color:var(--green)' : wr < 40 ? 'color:var(--red)' : 'color:var(--amber)';
          // A4 fix: use pnl_usd (the actual field name from calcAnalytics)
          var pnlCls = s.pnl_usd >= 0 ? 'color:var(--green)' : 'color:var(--red)';
          var pnlStr = (s.pnl_usd >= 0 ? '+$' : '-$') + _num(Math.abs(s.pnl_usd));
          return '<tr style="border-bottom:1px solid rgba(255,255,255,0.05)">' +
            '<td style="padding:3px 8px;font-weight:700">' + _esc(k) + '</td>' +
            '<td style="padding:3px 8px">' + tot + '</td>' +
            '<td style="padding:3px 8px;' + wrCls + '">' + wr + '%</td>' +
            '<td style="padding:3px 8px">' + s.wins + '/' + s.losses + '</td>' +
            '<td style="padding:3px 8px;' + pnlCls + '">' + pnlStr + '</td>' +
            '<td style="padding:3px 8px;color:var(--dim)">' + (s.partial ? '½×' + s.partial : '—') + '</td>' +
            '</tr>';
        }).join('');
        assetEl.innerHTML =
          '<table style="width:100%;border-collapse:collapse;font-size:10px">' +
          '<thead><tr style="color:rgba(255,255,255,0.45);font-size:9px">' +
          '<th style="padding:3px 8px;text-align:left">Asset</th>' +
          '<th style="padding:3px 8px;text-align:left">Trades</th>' +
          '<th style="padding:3px 8px;text-align:left">Win%</th>' +
          '<th style="padding:3px 8px;text-align:left">W/L</th>' +
          '<th style="padding:3px 8px;text-align:left">P&L</th>' +
          '<th style="padding:3px 8px;text-align:left">Partial</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table>';
      }
    }

    // ── Correlation heat map ──────────────────────────────────────────────────
    var heatEl = document.getElementById('eeCorrHeat');
    if (heatEl) {
      var open = openTrades();
      if (!open.length) {
        heatEl.innerHTML = '<span style="color:var(--dim);font-size:10px">No open positions.</span>';
      } else {
        // Count by sector and direction
        var sectorCounts = {};
        open.forEach(function (t) {
          var sector = EE_SECTOR_MAP[normaliseAsset(t.asset)] || 'other';
          if (!sectorCounts[sector]) sectorCounts[sector] = { long: 0, short: 0, assets: [] };
          sectorCounts[sector][t.direction === 'LONG' ? 'long' : 'short']++;
          sectorCounts[sector].assets.push(t.asset);
        });
        var sectorKeys = Object.keys(sectorCounts).sort(function (a, b) {
          var ta = sectorCounts[a].long + sectorCounts[a].short;
          var tb = sectorCounts[b].long + sectorCounts[b].short;
          return tb - ta;
        });
        heatEl.innerHTML = sectorKeys.map(function (s) {
          var c = sectorCounts[s];
          var tot = c.long + c.short;
          var maxPerSector = _cfg.max_per_sector || 2;
          var heat = tot >= maxPerSector ? '#ff4444' : tot >= maxPerSector - 1 ? '#ffc107' : '#00e676';
          return '<div style="display:inline-flex;align-items:center;gap:4px;' +
            'margin:2px 6px 2px 0;padding:3px 8px;background:rgba(255,255,255,0.05);' +
            'border:1px solid ' + heat + ';border-radius:4px;font-size:10px">' +
            '<span style="color:' + heat + '">●</span>' +
            '<span style="color:var(--text)">' + s + '</span>' +
            '<span style="color:var(--dim)">' + c.assets.join('/') + '</span>' +
            (c.long  ? '<span style="color:var(--green)">↑' + c.long  + '</span>' : '') +
            (c.short ? '<span style="color:var(--red)">↓'   + c.short + '</span>' : '') +
            '</div>';
        }).join('');
      }
    }

    // ── Scalper agent performance panel ──────────────────────────────────────
    var scalperEl = document.getElementById('eeScalperStats');
    if (scalperEl) {
      var stats   = a.scalperStats || {};
      var sources = Object.keys(stats);

      // Live status badges from agent globals
      var agentStatus = [
        { key: 'scalper',         global: 'GII_AGENT_SCALPER',         label: '24/7 Scalper',    icon: '⚡' },
        { key: 'scalper-session', global: 'GII_AGENT_SCALPER_SESSION', label: 'Session Scalper', icon: '🕐' }
      ];

      var liveHtml = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
      agentStatus.forEach(function (ag) {
        var agObj = window[ag.global];
        var st    = agObj ? (function () { try { return agObj.status(); } catch(e) { return {}; } })() : null;
        var isActive   = st && st.activeScalp;
        var isSessionOff = st && st.note && st.note.indexOf('Outside session') !== -1;
        var isGated    = st && st.gtiGated;
        var badgeColor = isActive ? '#00e676' : (isSessionOff || isGated) ? 'rgba(255,255,255,0.3)' : 'var(--amber)';
        var stateLabel = isActive ? '⚡ Active: BTC ' + (st.activeScalp.bias || '').toUpperCase()
                       : isSessionOff ? 'Outside session'
                       : isGated      ? 'GTI gated'
                       : st           ? 'Scanning'
                       :                'Not loaded';
        liveHtml += '<div style="padding:5px 10px;background:var(--bg3);border:1px solid ' + badgeColor +
          ';border-radius:4px;font-size:10px">' +
          '<span style="color:' + badgeColor + ';font-weight:700">' + ag.icon + ' ' + ag.label + '</span>' +
          '<span style="color:rgba(255,255,255,0.5);margin-left:8px">' + stateLabel + '</span>' +
          (st && typeof st.rsi5m === 'number'
            ? '<span style="color:rgba(255,255,255,0.4);margin-left:8px;font-size:9px">RSI ' + st.rsi5m +
              ' | Vol×' + (st.volRatio || '—') + '</span>'
            : '') +
          '</div>';
      });
      liveHtml += '</div>';

      if (!sources.length) {
        scalperEl.innerHTML = liveHtml +
          '<span style="color:var(--dim);font-size:10px">No closed scalper trades yet — stats will appear here once a BTC scalp closes.</span>';
      } else {
        var combined = { trades: 0, wins: 0, losses: 0, pnl: 0, partial: 0, durs: [] };
        sources.forEach(function (k) {
          var s = stats[k];
          combined.trades += s.trades; combined.wins += s.wins; combined.losses += s.losses;
          combined.pnl += s.pnl; combined.partial += s.partial;
          combined.durs = combined.durs.concat(s.durs);
        });

        var LABELS = { 'scalper': '24/7 Scalper', 'scalper-session': 'Session Scalper' };

        var rows = sources.concat(['combined']).map(function (k) {
          var s = (k === 'combined') ? combined : stats[k];
          if (!s || !s.trades) return '';
          var tot  = s.wins + s.losses;
          var wr   = tot ? Math.round(s.wins / tot * 100) : 0;
          var wrCl = wr >= 60 ? 'var(--green)' : wr < 40 ? 'var(--red)' : 'var(--amber)';
          var pnlCl = s.pnl >= 0 ? 'var(--green)' : 'var(--red)';
          var avgDur = s.durs.length
            ? (s.durs.reduce(function (a, b) { return a + b; }, 0) / s.durs.length).toFixed(0) + 'm'
            : '—';
          var label = k === 'combined' ? '<b>COMBINED</b>' : (LABELS[k] || k);
          var rowStyle = k === 'combined'
            ? 'border-top:1px solid rgba(255,255,255,0.15);font-weight:700'
            : 'border-bottom:1px solid rgba(255,255,255,0.05)';
          return '<tr style="' + rowStyle + '">' +
            '<td style="padding:4px 8px">' + label + '</td>' +
            '<td style="padding:4px 8px">' + s.trades + '</td>' +
            '<td style="padding:4px 8px;color:' + wrCl + '">' + wr + '%</td>' +
            '<td style="padding:4px 8px">' + s.wins + ' / ' + s.losses + '</td>' +
            '<td style="padding:4px 8px;color:' + pnlCl + '">' + (s.pnl >= 0 ? '+$' : '-$') + _num(Math.abs(s.pnl)) + '</td>' +
            '<td style="padding:4px 8px;color:var(--dim)">' + avgDur + '</td>' +
            '<td style="padding:4px 8px;color:var(--dim)">' + (s.partial ? '½×' + s.partial : '—') + '</td>' +
            '</tr>';
        }).join('');

        scalperEl.innerHTML = liveHtml +
          '<table style="width:100%;border-collapse:collapse;font-size:10px">' +
          '<thead><tr style="color:rgba(255,255,255,0.4);font-size:9px;border-bottom:1px solid rgba(255,255,255,0.12)">' +
          '<th style="padding:4px 8px;text-align:left">Agent</th>' +
          '<th style="padding:4px 8px;text-align:left">Trades</th>' +
          '<th style="padding:4px 8px;text-align:left">Win%</th>' +
          '<th style="padding:4px 8px;text-align:left">W / L</th>' +
          '<th style="padding:4px 8px;text-align:left">P&amp;L</th>' +
          '<th style="padding:4px 8px;text-align:left">Avg Hold</th>' +
          '<th style="padding:4px 8px;text-align:left">Partial TPs</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table>';
      }
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     PUBLIC API  (window.EE)
     ══════════════════════════════════════════════════════════════════════════════ */

  window.EE = {

    /* ── Emergency kill switch ── */
    /* EE.halt()   — immediately stops all new trade execution (canExecute returns false).
       EE.resume() — re-enables execution.
       Existing open trades are not affected — positions are managed normally.
       Use EE.halt() if a signal source malfunctions, API misbehaves, or unexpected
       trades are opening. Dashboard auto-calls halt() if signal storm is detected. */
    halt: function () {
      _halted = true;
      try { localStorage.setItem(HALT_KEY, 'true'); } catch(e) {}
      log('SYSTEM', '🛑 KILL SWITCH ACTIVATED — all new trade execution halted. Call EE.resume() to re-enable.', 'warn');
      renderUI();
    },
    resume: function () {
      _halted = false;
      try { localStorage.setItem(HALT_KEY, 'false'); } catch(e) {}
      log('SYSTEM', '✅ KILL SWITCH CLEARED — trade execution re-enabled.', 'green');
      renderUI();
    },
    isHalted: function () { return _halted; },
    toggleHalt: function () {
      if (_halted) window.EE.resume(); else window.EE.halt();
    },

    /* ── Collapsible config panel ── */
    toggleConfig: function () {
      var body  = document.getElementById('eeConfigBody');
      var arrow = document.getElementById('eeCfgArrow');
      if (!body) return;
      var collapsed = body.classList.toggle('collapsed');
      if (arrow) arrow.style.transform = collapsed ? '' : 'rotate(90deg)';
      try { localStorage.setItem('geodash_ee_cfg_collapsed_v1', collapsed ? '1' : '0'); } catch(e) {}
    },

    /* ── Called by renderTrades() hook each cycle ── */
    onSignals: onSignals,

    /* ── One-time sync: push all in-memory trades to backend DB ── */
    syncAllTradesToBackend: function () {
      if (!_apiOnline) { log('SYSTEM', '⚠ Backend offline — cannot sync trades', 'warn'); return; }
      var all = Array.isArray(_trades) ? _trades : Object.values(_trades);
      if (!all.length) { log('SYSTEM', 'No trades in memory to sync', 'amber'); return; }
      log('SYSTEM', 'Syncing ' + all.length + ' trades to backend (POST = upsert, safe to re-run)…', 'amber');
      var ok = 0, fail = 0;
      all.forEach(function (t) {
        _apiFetch('/api/trades', { method: 'POST', body: JSON.stringify(t) })
          .then(function () { ok++; if (ok + fail === all.length) log('SYSTEM', '✓ Sync complete — ' + ok + ' trades pushed to backend', 'green'); })
          .catch(function () { fail++; if (ok + fail === all.length) log('SYSTEM', '⚠ Sync done — ' + ok + ' ok, ' + fail + ' failed', 'warn'); });
      });
    },

    /* ── Risk Simulator: called by slider oninput events ── */
    updateSim: function () { renderSim(); },

    /* ── Reset all learned weight adjustments (called by learning panel) ── */
    resetLearning: function () {
      if (!confirm('Reset all learned weight adjustments?\n\nThis clears the model\'s training history. The IMPACT_MAP base scores will be used instead.')) return;
      if (typeof window._learnedWeights !== 'undefined') {
        // Clear via dashboard's exposed reset hook
        if (typeof window.onLearnReset === 'function') window.onLearnReset();
        else {
          try { localStorage.removeItem('geodash_learned_weights_v1'); } catch(e) {}
          log('LEARN', 'Learning weights reset — all adjustments cleared', 'amber');
          renderUI();
        }
      }
    },

    /* ── Backend connectivity status (readable from outside the closure) ── */
    isBackendOnline: function () { return _apiOnline; },

    /* ── Toggle auto-execution on/off ── */
    toggleAuto: function () {
      _cfg.enabled = !_cfg.enabled;
      saveCfg();
      log('CONFIG', 'Auto-execution ' + (_cfg.enabled ? 'ENABLED' : 'DISABLED'),
          _cfg.enabled ? 'green' : 'amber');
      renderUI();
    },

    /* ── Toggle SIMULATION ↔ LIVE mode ── */
    toggleMode: function () {
      if (_cfg.mode === 'LIVE') {
        _cfg.mode = 'SIMULATION';
        log('CONFIG', 'Switched to SIMULATION mode', 'amber');
        saveCfg(); renderUI();
      } else {
        if (!confirm(
          'Switch to LIVE MODE?\n\n' +
          'This will send REAL orders to connected exchanges.\n' +
          'Ensure broker API keys are configured and risk parameters are correct.\n\n' +
          'Broker integrations are currently stubs — no real orders will fire\n' +
          'until a broker adapter is implemented.'
        )) return;
        _cfg.mode = 'LIVE';
        log('CONFIG', 'Switched to LIVE mode — broker adapter required for real execution', 'amber');
        saveCfg(); renderUI();
      }
    },

    /* ── Save updated risk parameters from form ── */
    updateConfig: function () {
      var rules = {
        min_confidence:       { min: 10,  max: 95,       int: true  },
        risk_per_trade_pct:   { min: 0.1, max: 10,       int: false },
        stop_loss_pct:        { min: 0.1, max: 20,       int: false },
        take_profit_ratio:    { min: 0.5, max: 10,       int: false },
        max_open_trades:      { min: 1,   max: 20,       int: true  },
        max_per_region:       { min: 1,   max: 5,        int: true  },
        max_per_sector:       { min: 1,   max: 5,        int: true  },
        virtual_balance:      { min: 100, max: 10000000, int: false },
        // A21: min=1 so that 0 can't accidentally disable the hard risk cap entirely
        max_risk_usd:         { min: 1,   max: 10000,    int: false },
        trailing_stop_pct:    { min: 0.1, max: 10,       int: false },
        daily_loss_limit_pct:    { min: 1,   max: 100,  int: false },
        daily_profit_target_pct: { min: 0,   max: 50,   int: false },
        event_gate_hours:        { min: 0,   max: 4,    int: false }
      };
      Object.keys(rules).forEach(function (f) {
        var el = document.getElementById('eeCfg_' + f);
        if (!el) return;
        var v = parseFloat(el.value), r = rules[f];
        if (isNaN(v) || v < r.min || v > r.max) return;
        _cfg[f] = r.int ? Math.round(v) : v;
      });
      // Sync checkbox toggles
      ['trailing_stop_enabled','break_even_enabled','partial_tp_enabled','event_gate_enabled'].forEach(function (f) {
        var el = document.getElementById('eeCfg_' + f);
        if (el) _cfg[f] = el.checked;
      });
      saveCfg();
      log('CONFIG', 'Risk parameters updated', 'amber');
      renderUI();
    },

    /* ── Manually close an open trade ── */
    manualClose: function (tradeId) {
      var trade = _trades.find(function (t) { return t.trade_id === tradeId; });
      if (!trade) return;
      fetchPrice(trade.asset, function (price) {
        // Cascade: fresh fetch → cache → live-price map → stop level → entry price.
        // Never fall back to entry_price alone — a real close at entry hides all losses.
        var _tok     = normaliseAsset(trade.asset);
        var _closeAt = price
                    || _priceCache[_tok]
                    || _livePrice[trade.trade_id]
                    || trade.stop_loss
                    || trade.entry_price;
        if (!price) log('PRICE', 'Manual close ' + trade.asset + ' — using cached price $' + _num(_closeAt), 'amber');
        closeTrade(tradeId, _closeAt, 'MANUAL');
      });
    },

    /* ── gii-exit: update stop/TP on an open trade without closing it ──
       changes = { stop_loss, take_profit }  (either or both)               */
    updateOpenTrade: function (tradeId, changes) {
      var trade = _trades.find(function (t) {
        return t.trade_id === tradeId && t.status === 'OPEN';
      });
      if (!trade) return false;
      if (changes.stop_loss   !== undefined) trade.stop_loss   = +changes.stop_loss;
      if (changes.take_profit !== undefined) trade.take_profit = +changes.take_profit;
      saveTrades();
      renderUI();
      return true;
    },

    /* ── gii-exit: force-close an open trade at current market price ──
       reason should be prefixed 'GII-EXIT: ...' for log clarity           */
    forceCloseTrade: function (tradeId, reason) {
      var trade = _trades.find(function (t) {
        return t.trade_id === tradeId && t.status === 'OPEN';
      });
      if (!trade) return false;
      // H1 fix: add 30s fallback so close fires even if fetchPrice hangs (dead feed).
      // The caller receives true meaning "request dispatched", not "close complete".
      var _fcDone = false;
      var _fcTimeout = setTimeout(function () {
        if (_fcDone) return;
        _fcDone = true;
        var _tok = normaliseAsset(trade.asset);
        var _fallbackPx = _priceCache[_tok] || _livePrice[trade.trade_id] || trade.stop_loss || trade.entry_price;
        log('PRICE', 'Force-close ' + trade.asset + ' — fetchPrice timed out, using cached $' + _num(_fallbackPx), 'amber');
        closeTrade(tradeId, _fallbackPx, reason || 'GII-EXIT');
      }, 30000);
      fetchPrice(trade.asset, function (price) {
        clearTimeout(_fcTimeout);
        if (_fcDone) return;
        _fcDone = true;
        var _tok     = normaliseAsset(trade.asset);
        var _closeAt = price
                    || _priceCache[_tok]
                    || _livePrice[trade.trade_id]
                    || trade.stop_loss
                    || trade.entry_price;
        if (!price) log('PRICE', 'Force-close ' + trade.asset + ' — using cached price $' + _num(_closeAt), 'amber');
        closeTrade(tradeId, _closeAt, reason || 'GII-EXIT');
      });
      return true; // means "dispatched", not "complete" — close fires async
    },

    /* ── Purge phantom trades: close all open trades that never got a broker fill ──
       Phantom trades have broker_status === null (the order was queued but never sent
       to the broker, e.g. because the broker wasn't connected at signal time).
       They count against position limits and block new signals without being real.
       This closes each one at its entry price (P&L ≈ 0) so no phantom gains/losses
       hit the balance. saveTrades() + saveCfg() + _apiPatchTrade() are all called
       inside closeTrade(), so the fix persists across reloads.                       */
    purgePhantomTrades: function () {
      var phantoms = _trades.filter(function (t) {
        return t.status === 'OPEN' && t.broker_status == null;
      });
      if (!phantoms.length) {
        log('CONFIG', 'No phantom trades found — all open trades have broker confirmation', 'dim');
        return 0;
      }
      var n = phantoms.length;
      phantoms.forEach(function (t) {
        var ep = t.entry_price;
        if (!ep || !isFinite(ep) || ep <= 0) {
          // Fallback: use stop_loss as a proxy if entry_price is missing
          ep = t.stop_loss || 1;
        }
        log('CONFIG', 'Phantom purge: ' + t.asset + ' ' + t.direction +
          ' [venue:' + t.venue + '] broker_status=null — closing flat @ $' + ep.toFixed(2), 'amber');
        // closeTrade saves to localStorage, patches SQLite, and updates virtual_balance
        closeTrade(t.trade_id, ep, 'PHANTOM_PURGE');
      });
      log('CONFIG', 'Purged ' + n + ' phantom trade(s) — signals now unblocked', 'green');
      renderUI();
      return n;
    },

    /* ── gii-exit: get last known price for an asset from the price cache ── */
    getLastPrice: function (asset) {
      if (!asset) return null;
      var token = normaliseAsset(asset);
      var price = _priceCache[token];
      return (price && isFinite(price)) ? price : null;
    },

    /* ── Soft reset — close all open trades at market, keep everything else ── */
    softReset: function () {
      var open = openTrades();
      if (!open.length) { alert('No open trades to close.'); return; }
      if (!confirm('Close all ' + open.length + ' open trade(s) at current market price?\n\nBalance, history and learning data are preserved.')) return;
      var n = open.length;
      open.forEach(function (t) {
        var token = normaliseAsset(t.asset);
        var price = _priceCache[token] || _livePrice[t.trade_id] || t.entry_price;
        closeTrade(t.trade_id, price, 'MANUAL');
      });
      log('CONFIG', 'Soft reset: ' + n + ' open trade(s) closed at market', 'amber');
      renderUI();
    },

    /* ── Account reset — reset balance + P&L timeline, keep trade history ── */
    accountReset: function () {
      if (!confirm(
        'Account Reset:\n\n' +
        '✓ Reset balance to $' + DEFAULTS.virtual_balance + '\n' +
        '✓ Clear P&L timeline\n\n' +
        '✗ Trade history kept\n' +
        '✗ Learning weights kept\n' +
        '✗ Settings kept'
      )) return;
      _cfg.virtual_balance = DEFAULTS.virtual_balance;
      saveCfg();
      _pnlHistory = [];
      savePnlHistory();
      _sessionStart = new Date().toISOString();
      _sessionStartBalance = DEFAULTS.virtual_balance;
      _peakEquity  = DEFAULTS.virtual_balance;   // reset peak on account reset
      _ddFromPeak  = 0;
      try { localStorage.setItem('geodash_session_start_v1', _sessionStart); } catch(e) {}
      try { localStorage.removeItem('geodash_session_balance_v1'); } catch(e) {}   // v63: clear persisted day-open balance on reset
      _recordPnlSnapshot('account-reset', 0);
      log('CONFIG', 'Account reset: balance restored to $' + DEFAULTS.virtual_balance, 'amber');
      renderUI();
    },

    /* ── Reset virtual balance (alias kept for any existing onclick refs) ── */
    resetBalance: function () { return this.accountReset(); },

    /* ── Stats checkpoint — zero the session counters without touching anything else ── */
    sessionReset: function () {
      /* Re-baseline session start to NOW and session balance to current balance.
         Effect: Balance display resets to 0 change, Unrealised/Realised/Session Returns
         all reset from this moment. Closed trade history and Strategy Analytics are also
         cleared. Open trades, config — nothing else changes. */
      _sessionStart        = new Date().toISOString();
      _sessionStartBalance = _cfg.virtual_balance;
      _peakEquity          = _cfg.virtual_balance;
      _ddFromPeak          = 0;
      try { localStorage.setItem('geodash_session_start_v1', _sessionStart); } catch(e) {}
      // A8: write same JSON object format that init() expects — plain String() caused
      // a TypeError on reload because init() does JSON.parse().date/.balance
      var _srTodayKey = new Date().toISOString().slice(0, 10);
      try { localStorage.setItem('geodash_session_balance_v1', JSON.stringify({ date: _srTodayKey, balance: _sessionStartBalance })); } catch(e) {}
      // Clear closed trade history so Strategy Analytics resets too
      _trades = _trades.filter(function (t) { return t.status === 'OPEN'; });
      saveTrades();
      // Also purge closed trades from the backend DB so they don't reload on next page refresh.
      // Uses ?closed=true to preserve any OPEN trades in the DB.
      if (_apiOnline) {
        _apiFetch('/api/trades?closed=true', { method: 'DELETE' })
          .then(function (r) { return r.json(); })
          .then(function (d) { log('CONFIG', 'Backend: ' + (d.deleted || 0) + ' closed trade(s) purged from DB', 'amber'); })
          .catch(function () { log('CONFIG', 'Backend closed-trade purge failed — old trades may reappear on reload', 'amber'); });
      }
      log('CONFIG', 'Stats reset: session counters and Strategy Analytics cleared. Balance $' +
          _cfg.virtual_balance.toFixed(2), 'amber');
      renderUI();
    },

    /* ── Clear closed trade history ── */
    clearHistory: function () {
      if (!confirm('Clear all closed trade history? Open trades are not affected.')) return;
      _trades = _trades.filter(function (t) { return t.status === 'OPEN'; });
      saveTrades();
      log('CONFIG', 'Closed trade history cleared', 'amber');
      renderUI();
    },

    /* ── Full reset — wipes everything and starts fresh ── */
    fullReset: function () {
      // Fix #20: two-step guard — accidental one-click no longer wipes everything.
      // Step 1: confirm dialog warns what will be lost.
      if (!confirm(
        '⚠ FULL RESET — CANNOT BE UNDONE\n\n' +
        'This will:\n' +
        '  • Close ALL open trades\n' +
        '  • Wipe all trade history & P&L\n' +
        '  • Reset balance to $' + DEFAULTS.virtual_balance + '\n' +
        '  • Clear all signals, analytics, and learning state\n\n' +
        'Are you sure you want to continue?'
      )) return;
      // Step 2: typed confirmation — must enter "RESET" exactly to proceed.
      var _typed = (window.prompt('Type RESET (all caps) to confirm the full data wipe:') || '').trim();
      if (_typed !== 'RESET') {
        alert('Full reset cancelled — "' + _typed + '" does not match. Nothing was changed.');
        return;
      }
      // 0. Backup current state before wiping (survives the reload)
      var _bts = _createBackup();
      if (_bts) console.info('[EE] Full-reset backup saved: geodash_backup_' + _bts);
      // 1. Wipe backend DB first (fire-and-forget with log)
      if (_apiOnline) {
        _apiFetch('/api/trades', { method: 'DELETE' })
          .then(function (r) { return r.json(); })
          .then(function (d) { log('CONFIG', 'Backend wiped — ' + (d.deleted || 0) + ' trades deleted', 'amber'); })
          .catch(function () { log('CONFIG', 'Backend wipe failed — restart backend to clear DB', 'red'); });
      }
      // 2. Wipe in-memory state
      _trades       = [];
      _livePrice    = {};
      _cooldown     = {};
      _pendingOpen  = {};
      _lastSignals  = [];
      _cfg.virtual_balance = DEFAULTS.virtual_balance;
      // 3. Reset HRS in memory immediately (don't wait for reload)
      if (window.HRS && typeof HRS.reset === 'function') HRS.reset();
      // 4. Sweep ALL geodash_* and gii_* keys so nothing is missed
      try {
        Object.keys(localStorage).forEach(function (k) {
          if (k.indexOf('geodash_') === 0 || k.indexOf('gii_') === 0) {
            localStorage.removeItem(k);
          }
        });
      } catch (e) {}
      saveTrades();
      saveCfg();
      // Reload so all other in-memory state reinitialises cleanly
      window.location.reload();
    },

    /* ── Analytics Reset — clears all performance data, keeps settings & agents ── */
    analyticsReset: function () {
      if (!confirm(
        '⚠ FULL RESET\n\n' +
        'WILL BE WIPED:\n' +
        '✓ All trade history & P&L stats\n' +
        '✓ Signal log & flagged trades\n' +
        '✓ Agent learning, win-rate & IC feedback\n' +
        '✓ Scaling engine state (probation, smoke-alarm, etc)\n' +
        '✓ Session stats\n\n' +
        'WILL BE KEPT:\n' +
        '✗ All risk settings (confidence, sizing, SL/TP, limits)\n' +
        '✗ Broker connections\n' +
        '✗ Balance (stays synced from brokers)\n\n' +
        'Page reloads cleanly after. Continue?'
      )) return;

      // 1. Wipe backend trade DB (analytics only — no config tables)
      var apiWipe = _apiOnline
        ? _apiFetch('/api/trades', { method: 'DELETE' }).catch(function () {})
        : Promise.resolve();

      apiWipe.then(function () {
        // 2. Reset HRS in memory immediately
        if (window.HRS && typeof HRS.reset === 'function') HRS.reset();
        // 3. Sweep ALL geodash_* and gii_* keys (catches anything we might have missed)
        //    Keep geodash_ee_config_v2 so settings/balance are preserved
        try {
          Object.keys(localStorage).forEach(function (k) {
            if (k === 'geodash_ee_config_v2') return; // keep settings
            if (k.indexOf('geodash_') === 0 || k.indexOf('gii_') === 0) {
              localStorage.removeItem(k);
            }
          });
        } catch (e) {}
        // 4. Reload page — agents reinitialise fresh, scanning resumes immediately
        window.location.reload();
      });
    },

    /* ── P&L timeline access ── */
    getPnlHistory: function () { return _pnlHistory.slice(); },

    /* ── Backup management ── */
    listBackups: function () {
      try {
        return Object.keys(localStorage)
          .filter(function (k) { return k.indexOf('geodash_backup_') === 0; })
          .map(function (k) {
            try {
              var b = JSON.parse(localStorage.getItem(k));
              return { key: k, created: b.created, version: b.version,
                       trades: JSON.parse(b.trades || '[]').length };
            } catch(e) { return { key: k, created: null }; }
          }).sort(function (a, b) { return b.key > a.key ? -1 : 1; });
      } catch(e) { return []; }
    },

    restoreBackup: function (ts) {
      try {
        var key = 'geodash_backup_' + ts;
        var raw = localStorage.getItem(key);
        if (!raw) { alert('Backup not found: ' + key); return; }
        var b = JSON.parse(raw);
        var tradeCount = JSON.parse(b.trades || '[]').length;
        if (!confirm('Restore backup from ' + b.created + ' (' + tradeCount + ' trades)?\n\nCurrent state will be overwritten. Page will reload.')) return;
        try { localStorage.setItem(CFG_KEY,          b.cfg);         } catch(e) {}
        try { localStorage.setItem(TRADES_KEY,        b.trades);     } catch(e) {}
        try { localStorage.setItem(SIGLOG_KEY,        b.sigLog);     } catch(e) {}
        try { localStorage.setItem(PNL_HISTORY_KEY,   b.pnlHistory); } catch(e) {}
        window.location.reload();
      } catch(e) { alert('Restore failed: ' + (e.message || String(e))); }
    },

    /* ── Future broker integration (stubs) ── */
    connectBroker: connectBroker,

    /* ── Risk gate — exposed for testing and external use ── */
    canExecute: canExecute,

    /* ── Manual Alpaca position reconciliation ── */
    reconcileAlpaca: _reconcileAlpacaPositions,

    /* ── Balance sync from broker equity (Fix 5) ──
       Sets virtual_balance to the connected broker's actual equity.
       Use after depositing or withdrawing real funds.                */
    /* ── Reset IC / scaling engine state — clears probation, smoke-alarm, learning feedback ── */
    resetICEngine: function () {
      if (!confirm(
        'Reset IC Engine & Scaling State?\n\n' +
        'WILL BE CLEARED:\n' +
        '✓ Probation / smoke-alarm state\n' +
        '✓ Agent win-rate feedback\n' +
        '✓ Scalper session feedback\n' +
        '✓ Trade map & escalation history\n\n' +
        'WILL BE KEPT:\n' +
        '✗ Open trades\n' +
        '✗ Risk settings\n' +
        '✗ Balance\n\n' +
        'Scaling engine restarts fresh at 1× multiplier. Continue?'
      )) return;
      var keysToWipe = [
        'gii_agent_feedback_v1', 'gii_scalper_feedback_v1', 'gii_scalper_session_feedback_v1',
        'gii_brain_v1', 'gii_trade_map_v1', 'gii_escalation_v1', 'gii_ta_quota_v1',
        'geodash_attribution_v1', 'geodash_learned_weights_v1'
      ];
      keysToWipe.forEach(function (k) { try { localStorage.removeItem(k); } catch(e) {} });
      if (window.HRS && typeof HRS.reset === 'function') HRS.reset();
      log('RISK', '🔄 IC engine reset: probation/smoke-alarm cleared, scaling returns to 1×', 'amber');
      setTimeout(function () { window.location.reload(); }, 800);
    },

    /* ── Force-close all open positions immediately ── */
    forceCloseAll: function () {
      var openT = openTrades();
      if (openT.length === 0) { alert('No open positions to close.'); return; }
      if (!confirm('Force-close ALL ' + openT.length + ' open position(s) at market price?\n\nThis cannot be undone.')) return;
      var ids = openT.map(function (t) { return t.trade_id; });
      ids.forEach(function (id) {
        // C2 fix: was calling non-existent _closeTrade — use closeTrade with a real price
        var trade = _trades.find(function (t) { return t.trade_id === id; });
        if (!trade) return;
        var px = _livePrice[id] || _priceCache[normaliseAsset(trade.asset)] || trade.entry_price;
        try { closeTrade(id, px, 'MANUAL_FORCE_CLOSE'); } catch (e) {
          log('RISK', '⚠ forceCloseAll: error closing ' + (trade.asset || id) + ': ' + (e.message || e), 'red');
        }
      });
      log('RISK', '🚨 Force-closed ' + ids.length + ' position(s) manually', 'amber');
      renderUI();
    },

    syncBalance: function () {
      var equity = 0;
      var source = '';
      if (window.HLBroker && HLBroker.isConnected()) {
        try { var s = HLBroker.status(); if (s.equity > 0) { equity = s.equity; source = 'HL'; } } catch (e) {}
      }
      if (!equity && window.AlpacaBroker && AlpacaBroker.isConnected()) {
        try { var s = AlpacaBroker.status(); if (s.equity > 0) { equity = s.equity; source = 'Alpaca'; } } catch (e) {}
      }
      if (!equity && window.OANDABroker && OANDABroker.isConnected()) {
        try { var s = OANDABroker.status(); if (s.nav > 0) { equity = s.nav; source = 'OANDA'; } } catch (e) {}  // OANDA uses .nav
      }
      if (!equity) { log('SYSTEM', 'syncBalance: no connected broker with equity found', 'amber'); return; }
      _cfg.virtual_balance = equity;
      saveCfg();
      log('CONFIG', 'Balance synced from ' + source + ' broker: $' + equity.toFixed(2), 'green');
      renderUI();
    },

    /* ── Fill latency stats ── */
    fillLatencyStats: function () {
      if (!_fillLatencies.length) return { count: 0, avgMs: null, maxMs: null, minMs: null };
      var avg = Math.round(_fillLatencies.reduce(function(a,b){return a+b;},0) / _fillLatencies.length);
      return {
        count: _fillLatencies.length,
        avgMs: avg,
        avgS:  +(avg / 1000).toFixed(2),
        maxMs: Math.max.apply(null, _fillLatencies),
        minMs: Math.min.apply(null, _fillLatencies),
        samples: _fillLatencies.slice()
      };
    },

    /* ── Causal Win-Rate Attribution ── */
    attributionStats: function (filter) {
      var records = [];
      try { records = JSON.parse(localStorage.getItem(_ATTR_KEY) || '[]'); } catch(e) {}
      if (!records.length) return { count: 0, note: 'No closed trades recorded yet' };

      /* Optional filter: {regime, asset, direction, source} */
      if (filter) {
        records = records.filter(function (r) {
          return Object.keys(filter).every(function (k) { return r[k] === filter[k]; });
        });
      }

      var total  = records.length;
      var wins   = records.filter(function (r) { return r.win; }).length;
      var avgPnl = records.reduce(function (s, r) { return s + (r.pnl_usd || 0); }, 0) / total;

      /* Break down win rate by regime */
      var byRegime = {};
      records.forEach(function (r) {
        var rg = r.regime || 'UNKNOWN';
        if (!byRegime[rg]) byRegime[rg] = { total: 0, wins: 0 };
        byRegime[rg].total++;
        if (r.win) byRegime[rg].wins++;
      });
      Object.keys(byRegime).forEach(function (k) {
        byRegime[k].winRate = Math.round(byRegime[k].wins / byRegime[k].total * 100) + '%';
      });

      /* Break down by confidence band */
      var byConf = { 'lo(<70)': {t:0,w:0}, 'mid(70-84)': {t:0,w:0}, 'hi(85+)': {t:0,w:0} };
      records.forEach(function (r) {
        var c = r.confidence || 0;
        var band = c < 70 ? 'lo(<70)' : c < 85 ? 'mid(70-84)' : 'hi(85+)';
        byConf[band].t++; if (r.win) byConf[band].w++;
      });
      Object.keys(byConf).forEach(function (k) {
        var b = byConf[k];
        byConf[k].winRate = b.t ? Math.round(b.w / b.t * 100) + '%' : 'n/a';
      });

      return {
        count:     total,
        winRate:   Math.round(wins / total * 100) + '%',
        avgPnlUsd: +avgPnl.toFixed(2),
        byRegime:  byRegime,
        byConf:    byConf,
        records:   records   /* full detail — filter before logging */
      };
    },

    /* ── Data access for external scripts / debugging ── */
    getOpenTrades:  function () { return openTrades().slice(); },
    getAllTrades:    function () { return _trades.slice(); },

    /* ── v60: Memory stats — call EE.memStats() in console to inspect sizes ── */
    memStats: function () {
      return {
        log:           _log.length,
        trades:        _trades.length,
        tradesOpen:    openTrades().length,
        tradesClosed:  _trades.filter(function(t){ return t.status !== 'OPEN'; }).length,
        signalLog:     _signalLog.length,
        pnlHistory:    _pnlHistory.length,
        priceCache:    Object.keys(_priceCache).length,
        backendPrices: Object.keys(_backendPrices).length,
        livePrice:     Object.keys(_livePrice).length,
        priceFeedHealth: Object.keys(_priceFeedHealth).length
      };
    },

    /* ── Unrealised P&L for open trades using latest live prices ── */
    unrealisedPnl: function () {
      var result = [];
      openTrades().forEach(function (t) {
        var px = _livePrice[t.trade_id] || null;
        if (!px) return;
        var pct = t.direction === 'LONG'
          ? (px - t.entry_price) / t.entry_price * 100
          : (t.entry_price - px) / t.entry_price * 100;
        var usd = t.units * Math.abs(px - t.entry_price) * (pct >= 0 ? 1 : -1);
        result.push({ trade_id: t.trade_id, signal_id: t.signal_id, asset: t.asset,
                      pct: Math.round(pct * 100) / 100, usd: Math.round(usd * 100) / 100 });
      });
      return result;
    },
    getConfig:      function () { return Object.assign({}, _cfg); },
    exportJSON:     function () {
      var blob = new Blob([JSON.stringify(_trades, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ee_trades_' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(a.href);
    },

    exportCSV:      function () {
      // Build CSV: closed trades ordered newest-first
      var cols = [
        'trade_id','asset','direction','status','confidence',
        'entry_price','stop_loss','take_profit','close_price',
        'pnl_pct','pnl_usd','close_reason',
        'timestamp_open','timestamp_close',
        'units','size_usd','region','reason','kelly_mult'
      ];
      var rows = [cols.join(',')];
      _trades.forEach(function (t) {
        rows.push(cols.map(function (c) {
          var v = t[c];
          if (v === null || v === undefined) return '';
          // Wrap strings with commas or quotes in double-quotes
          var s = String(v);
          if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
            s = '"' + s.replace(/"/g, '""') + '"';
          }
          return s;
        }).join(','));
      });
      var blob = new Blob([rows.join('\n')], { type: 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ee_trades_' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(a.href);
    },

    render: renderUI,

    /* ── External price injection — called by hl-feed.js (and any future feed) ── */
    /* Pushes a real-time price into the cache and live-price map so monitorTrades  */
    /* uses fresh data without waiting for the next HTTP poll cycle.                */
    injectPrice: function (asset, price) {
      if (!asset || !price || price <= 0 || !isFinite(price)) return;
      var tok = normaliseAsset(asset);
      _cacheSet(tok, price);
      // Mark HL feed health as ok whenever a price is injected from HL.
      // Without this the feed dot stays grey even when the WS is streaming.
      if (window.HLFeed && typeof HLFeed.covers === 'function' && HLFeed.covers(tok)) {
        _priceFeedHealth['hl'] = { ok: true, lastOk: Date.now(),
          lastFail: (_priceFeedHealth['hl'] || {}).lastFail || null };
      }
      // Also set any aliases so all spelling variants get the update
      // Note: BRENT intentionally excluded — Brent and WTI are separate instruments
      // ($3-5 spread) and must not share a price cache entry.
      var aliasMap = { 'OIL': 'WTI', 'CRUDE': 'WTI', 'XAU': 'GOLD', 'XAG': 'SILVER' };
      if (aliasMap[tok]) _cacheSet(aliasMap[tok], price);
      if (aliasMap[tok] === 'WTI' || tok === 'WTI') { _cacheSet('WTI', price); _cacheSet('OIL', price); }
      // Push to live-price map for all open trades on this asset
      _trades.forEach(function (t) {
        if (t.status === 'OPEN' && normaliseAsset(t.asset) === tok) {
          _livePrice[t.trade_id] = price;
        }
      });
    },

    /* ── Toggle full closed-trade history in the UI ── */
    toggleAllClosed: function () {
      _showAllClosed = !_showAllClosed;
      renderClosedTrades();
    },
    toggleSigLogSession: function () {
      _sigLogSessionOnly = !_sigLogSessionOnly;
      renderSigLog();
    },
    toggleClosedSession: function () {
      _closedSessionOnly = !_closedSessionOnly;
      renderClosedTrades();
    },

    /* ── Browser notification permission ── */
    requestNotifications: function () {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'granted') {
        // Already granted — show a test notification
        try {
          new Notification('✅ EE Alerts active', {
            body: 'You will be notified when a trade hits TP or SL.',
            tag: 'ee-test-notif'
          });
        } catch (e) {}
        return;
      }
      Notification.requestPermission().then(function (perm) {
        var btn = document.getElementById('eeNotifBtn');
        if (perm === 'granted') {
          if (btn) { btn.style.color = 'var(--green, #00e676)'; btn.style.borderColor = 'var(--green, #00e676)'; btn.textContent = '🔔 Alerts ON'; }
          try { new Notification('✅ EE Alerts active', { body: 'You will be notified on TP/SL hits.', tag: 'ee-test-notif' }); } catch (e) {}
        } else {
          if (btn) { btn.textContent = '🔕 Blocked'; }
        }
      });
    },

    saveBackendUrl: function () {
      var input  = document.getElementById('eeBackendUrl');
      var status = document.getElementById('eeBackendUrlStatus');
      if (!input) return;
      var url = input.value.trim().replace(/\/$/, '');
      if (!url) {
        // Clear saved URL — revert to local backend
        try { localStorage.removeItem(_BACKEND_URL_KEY); } catch (e) {}
        _API_BASE = 'http://localhost:8765';
        _apiOnline = false;
        _backendChecked = false;
        input.style.borderColor = 'var(--border)';
        if (status) { status.textContent = 'Cleared — using Render default'; status.style.color = 'var(--dim)'; }
        return;
      }
      if (!/^https?:\/\//.test(url)) url = 'https://' + url;
      // Fix #18: domain whitelist — only allow localhost or known safe backend hosts.
      // This prevents XSS/injection from re-pointing the backend at an attacker's server.
      var _allowedBackend = (function (u) {
        try {
          var _parsed = new URL(u);
          var h = _parsed.hostname;
          return h === 'localhost' ||
                 h === '127.0.0.1' ||
                 h.endsWith('.onrender.com') ||
                 h.endsWith('.railway.app') ||
                 h.endsWith('.vercel.app') ||
                 h.endsWith('.fly.dev');
        } catch (e) { return false; }
      })(url);
      if (!_allowedBackend) {
        input.style.borderColor = 'var(--red)';
        if (status) { status.textContent = '✗ URL not on allowlist (use localhost or a known host)'; status.style.color = 'var(--red)'; }
        log('SYSTEM', 'Backend URL rejected — not on allowlist: ' + url, 'red');
        return;
      }
      _API_BASE = url;
      try { localStorage.setItem(_BACKEND_URL_KEY, url); } catch (e) {}
      _apiOnline = false;
      _backendChecked = false;
      input.style.borderColor = 'var(--amber)';
      if (status) { status.textContent = 'Connecting…'; status.style.color = 'var(--amber)'; }
      // Ping the new URL
      fetch(url + '/api/status', { headers: { 'Content-Type': 'application/json' } })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function () {
          _apiOnline = true;
          _backendChecked = true;
          input.style.borderColor = 'var(--green, #00e676)';
          if (status) { status.textContent = '● Connected'; status.style.color = 'var(--green, #00e676)'; }
          log('SYSTEM', 'Backend connected: ' + url, 'green');
          // Re-run startup sync now that backend is online
          _apiInit();
        })
        .catch(function () {
          _apiOnline = false;
          _backendChecked = true;
          input.style.borderColor = 'var(--red)';
          if (status) { status.textContent = '✗ Unreachable — check URL'; status.style.color = 'var(--red)'; }
          log('SYSTEM', 'Backend unreachable: ' + url, 'red');
        });
    }
  };

  /* ══════════════════════════════════════════════════════════════════════════════
     INITIALISATION
     ══════════════════════════════════════════════════════════════════════════════ */

  function init() {
    if (_initialised) return;   // guard against duplicate intervals if called twice
    _initialised = true;

    loadCfg();
    loadTrades();
    loadSigLog();
    loadPnlHistory();
    _loadFlaggedTrades();

    // Populate backend URL input with saved value (if any)
    try {
      var savedUrl = localStorage.getItem(_BACKEND_URL_KEY);
      var urlInput = document.getElementById('eeBackendUrl');
      if (urlInput) urlInput.value = savedUrl || '';
    } catch (e) {}

    // Session start — restore from localStorage so it survives page reloads
    // but gets wiped by analyticsReset/fullReset (they clear geodash_* keys)
    var storedSession = null;
    try { storedSession = localStorage.getItem('geodash_session_start_v1'); } catch(e) {}
    _sessionStart = storedSession || new Date().toISOString();
    try { localStorage.setItem('geodash_session_start_v1', _sessionStart); } catch(e) {}

    // Record balance at session start for daily loss limit tracking.
    // v63: persist to localStorage so page reloads don't reset the baseline —
    // otherwise a reload after a 3% loss lets the engine lose another 5% (8% total).
    var _todayKey = new Date().toISOString().slice(0, 10);   // 'YYYY-MM-DD' UTC
    var _savedSBal = null;
    try {
      var _sbRaw = localStorage.getItem('geodash_session_balance_v1');
      if (_sbRaw) {
        var _sb = JSON.parse(_sbRaw);
        if (_sb && _sb.date === _todayKey && typeof _sb.balance === 'number') _savedSBal = _sb.balance;
      }
    } catch(e) {}
    if (_savedSBal !== null) {
      _sessionStartBalance = _savedSBal;   // reload mid-session — restore today's opening balance
      log('RISK', 'Session balance restored from today\'s open: $' + _savedSBal.toFixed(2), 'dim');
    } else {
      _sessionStartBalance = _cfg.virtual_balance;
      try { localStorage.setItem('geodash_session_balance_v1', JSON.stringify({ date: _todayKey, balance: _sessionStartBalance })); } catch(e) {}
    }
    // Peak equity: initialise at current balance on load
    // Will update to true high-water mark as trades close
    _peakEquity = _cfg.virtual_balance;
    _ddFromPeak = 0;

    /* Auto-start: honour the auto_start config flag (M6).
       Defaults to true (original behaviour) — set auto_start: false to keep
       auto-execution OFF on page load (e.g. review mode).                    */
    if (_cfg.auto_start !== false) {
      _cfg.enabled = true;
    }
    saveCfg();

    // Autosave safety net — belt-and-suspenders every 7 s (guarded against double-load)
    if (!window._eeSaveInterval) {
      window._eeSaveInterval = setInterval(function () { saveTrades(); saveCfg(); }, 7000);
    }

    // monitorTrades watchdog — checks every 2 min that the monitor interval is still firing.
    // If _eeLastMonitor is >2 min stale, something killed the interval (e.g. browser tab
    // throttling, JS error). Logs a warning and attempts to restart the interval.
    if (!window._eeWatchdogInterval) {
      window._eeWatchdogInterval = setInterval(function () {
        var _WATCHDOG_LIMIT = 2 * 60 * 1000; // 2 minutes
        var _lastFire = window._eeLastMonitor || 0;
        if (_lastFire && Date.now() - _lastFire > _WATCHDOG_LIMIT) {
          log('SYSTEM', '⚠ monitorTrades heartbeat stale (' +
            Math.round((Date.now() - _lastFire) / 1000) + 's ago) — restarting monitor interval', 'red');
          if (window._eeMonitorInterval) clearInterval(window._eeMonitorInterval);
          window._eeMonitorInterval = setInterval(monitorTrades, 15000);
          monitorTrades(); // fire immediately to catch any missed SL/TP checks
        }
      }, 2 * 60 * 1000);
    }

    // Record starting balance for P&L timeline
    _recordPnlSnapshot('load', 0);

    // First monitor at 9s: HL-Feed connects at 6s + ~1-2s for WS handshake and first
    // allMids message. Waiting until 9s ensures the first stop/TP check has real prices.
    setTimeout(monitorTrades, 9000);
    if (!window._eeMonitorInterval) {
      window._eeMonitorInterval = setInterval(monitorTrades, 15000);  // guarded — prevents double-firing if script loaded twice
    }
    _startBinanceWS();                  // BTC fallback feed — yields to HL when live

    // Position reconciliation — Alpaca + HL — every 5 minutes (guarded against double-start)
    if (!window._eeReconcileInterval) {
      window._eeReconcileInterval = setInterval(function () {
        _reconcileAlpacaPositions();
        _reconcileHLPositions();
        _reconcileOANDAPositions();
      }, 5 * 60 * 1000);
      setTimeout(function () {
        _reconcileAlpacaPositions();
        _reconcileHLPositions();
        _reconcileOANDAPositions();
      }, 15000); // first run 15s after load (let fills settle)
    }

    // Dynamic confidence floors: run at init (5s delay for attribution data to load)
    // and every 30 min thereafter — adjusts EE_ASSET_CONF_FLOOR from live trade history.
    // Restore config panel collapse state from last session
    try {
      var _cfgCollapsed = localStorage.getItem('geodash_ee_cfg_collapsed_v1');
      var _cfgBody  = document.getElementById('eeConfigBody');
      var _cfgArrow = document.getElementById('eeCfgArrow');
      if (_cfgBody && _cfgCollapsed === '0') {
        _cfgBody.classList.remove('collapsed');
        if (_cfgArrow) _cfgArrow.style.transform = 'rotate(90deg)';
      }
    } catch(e) {}

    setTimeout(_updateDynamicFloors, 5000);
    if (!window._eeFloorsInterval) {
      window._eeFloorsInterval = setInterval(_updateDynamicFloors, 30 * 60 * 1000);
    }

    // Live broker equity polling — every 60 seconds, used for real-time position sizing
    if (!window._eeBrokerEquityInterval) {
      window._eeBrokerEquityInterval = setInterval(_pollBrokerEquity, 60 * 1000);
      setTimeout(_pollBrokerEquity, 8000);   // first poll 8s after load (let brokers auto-reconnect first)
    }

    /* Re-scan loop: every 5 minutes re-process the last IC signal batch.
       Only re-evaluates signals for assets that have no open trade AND whose
       cooldown has expired — prevents re-opening a trade that was just closed.
       Fix #3: guarded with window._eeReScanInterval to prevent double-firing
       if the script is loaded more than once (browser quirk / hot-reload). */
    if (!window._eeReScanInterval) window._eeReScanInterval = setInterval(function () {
      if (!_cfg.enabled || !_lastSignals.length) return;
      var now  = Date.now();
      var open = openTrades();
      var freshSigs = _lastSignals.filter(function (s) {
        var asset = normaliseAsset(s.asset);
        // Skip WATCH-direction signals — informational only, not tradeable.
        if (s.dir === 'WATCH') return false;
        // Fix #8: scalp signals expire after 30 minutes in the re-scan loop.
        // Scalp theses are time-critical (momentum, breakout, RSI extreme) — a
        // scalp signal from 45 minutes ago is no longer valid market context.
        // canExecute() normally exempts scalps from the 15-min age check,
        // so without this guard scalp signals could fire hours after the
        // original batch, on completely stale momentum. IC signals are already
        // gated by the 15-min check inside canExecute() so need no extra guard.
        var _isScalpSig = s.reason && (s.reason.indexOf('SCALPER') === 0 || s.reason.indexOf('scalper') !== -1);
        var _sigAge = now - (s._signalTs || 0);
        if (_isScalpSig && s._signalTs && _sigAge > 30 * 60 * 1000) return false;
        // Skip signals already successfully traded in _signalLog (same asset+dir).
        // After cooldown expires the re-scan would otherwise re-open a position for a
        // signal that was already executed and then closed — a stale IC batch.
        // Time-bounded to 2 hours: a TRADED entry older than 2h is a different market
        // event; a fresh IC signal for the same asset should be allowed through.
        var _2h = 2 * 60 * 60 * 1000;
        if (_signalLog.some(function (e) {
          return normaliseAsset(e.asset) === asset && e.dir === s.dir && e.action === 'TRADED' &&
                 (now - new Date(e.ts).getTime()) < _2h;
        })) return false;
        // Skip if we already have an open trade for this asset.
        // Also check original_asset (pre-remap): GII_ROUTING maps GLD→XAU at signal
        // time. The open trade stores asset='XAU', but _lastSignals still has 'GLD'.
        // Without checking original_asset, the re-scan would re-fire the GLD signal
        // and open a second XAU position while the first is still live.
        if (open.some(function (t) {
          return normaliseAsset(t.asset) === asset ||
                 (t.original_asset && normaliseAsset(t.original_asset) === asset);
        })) return false;
        // Skip if still in direction-aware cooldown
        var _rsSigDir  = s.dir || 'LONG';
        var _rsCdKey   = asset + '_' + _rsSigDir;
        var _rsOrigKey = normaliseAsset(s.original_asset || '') + '_' + _rsSigDir;
        var cd = _cooldown[_rsCdKey] || _cooldown[_rsOrigKey];
        if (cd && (now - cd) < _cfg.cooldown_ms) return false;
        // Also skip if reversal cooldown is active for this direction
        if (_reversalCooldown[_rsCdKey] && now < _reversalCooldown[_rsCdKey]) return false;
        // T1-C: skip assets where price was unavailable recently — _noPriceThrottle is set
        // for 1 hour when fetchPrice returns null. No point retrying every 5 min if all
        // price sources are down for this asset; skip until the throttle window clears.
        if (_noPriceThrottle[asset] && (now - _noPriceThrottle[asset]) < 3600000) return false;
        return true;
      });
      // T3-A: re-scan retry budget — cap at 5 signals per cycle, prioritised by decayed
      // confidence. Prevents 20+ concurrent fetchPrice calls + pendingOpen lock fights
      // when _lastSignals has many eligible entries after a long quiet period.
      if (freshSigs.length > 5) {
        freshSigs.sort(function (a, b) {
          return ((b.conf || b.confidence || 0)) - ((a.conf || a.confidence || 0));
        });
        freshSigs = freshSigs.slice(0, 5);
      }

      if (freshSigs.length) {
        // Fix #22: apply freshness decay to re-scanned signals.
        // Confidence decays linearly from 100% at age=0 to 50% at age=60 min.
        // A signal from 30 min ago fires at 75% of its original confidence.
        // This prevents hour-old medium-confidence signals from being treated as
        // fresh high-confidence entries — the thesis may no longer hold.
        var _decayedSigs = freshSigs.map(function (s) {
          var _ageMin = s._signalTs ? (now - s._signalTs) / 60000 : 0;
          var _decayFrac = Math.max(0.50, 1.0 - (_ageMin / 120));  // 0→1.0, 60→0.75, 120→0.50
          var _decayed = Object.assign({}, s);  // always shallow-copy — don't mutate original
          // F22: propagate _signalTs → ts so canExecute's 15-min age gate works for agents
          // that don't include ts. Without this, re-scan bypasses the staleness check.
          if (!_decayed.ts && s._signalTs) _decayed.ts = s._signalTs;
          if (_decayFrac < 1.0) {
            _decayed.confidence = Math.round((s.confidence || 60) * _decayFrac);
            // M6 fix: canExecute reads sig.conf, not sig.confidence — decay both fields
            // so the gate actually sees the reduced confidence value.
            _decayed.conf = Math.round((s.conf || s.confidence || 60) * _decayFrac);
            _decayed._rescanDecay = +_decayFrac.toFixed(2);
          }
          return _decayed;
        });
        log('SCAN', 'Periodic re-scan — ' + _decayedSigs.length + '/' + _lastSignals.length + ' signal(s) eligible (confidence decayed by age)', 'dim');
        onSignals(_decayedSigs);
      }
    }, 300000);  // 5 minutes — guarded above with window._eeReScanInterval

    // Update notification button state based on existing permission
    (function () {
      var btn = document.getElementById('eeNotifBtn');
      if (!btn || typeof Notification === 'undefined') return;
      if (Notification.permission === 'granted') {
        btn.style.color = 'var(--green, #00e676)';
        btn.style.borderColor = 'var(--green, #00e676)';
        btn.textContent = '🔔 Alerts ON';
      } else if (Notification.permission === 'denied') {
        btn.textContent = '🔕 Blocked';
        btn.disabled = true;
      }
    })();

    renderUI();
    log('SYSTEM', 'Execution Engine v1.0 ready — ' + _cfg.mode + ' mode  |  ' +
        'Auto-scan ALWAYS ON  |  ' + openTrades().length + ' open trade(s) restored', 'green');

    // Async: connect to SQLite backend, migrate localStorage data if needed
    _apiInit();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
