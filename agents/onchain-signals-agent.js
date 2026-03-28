/* On-Chain Signals Agent — onchain-signals-agent.js v1
 *
 * Generates crypto trading signals from on-chain and exchange data
 * using free public APIs only — no API key required.
 *
 * Data sources:
 *   1. CoinGecko markets  — volume surge signal per asset (every 15 min)
 *   2. CoinGecko global   — market cap change & BTC dominance (every 20 min)
 *   3. Blockchain.com     — BTC transaction count / hash rate (every 30 min)
 *
 * Signal format: EE.onSignals([{ source, asset, bias, confidence, reasoning,
 *                                region, sector, evidenceKeys, timestamp }])
 *
 * Exposes: window.GII_AGENT_ONCHAIN
 *   .status()  — { lastPoll, online, lastFetch, signalCount, note }
 *   .signals() — current active signals array
 *   .scan()    — force an immediate scan
 *
 * First fetch: 10 seconds after window load
 * Cooldown   : 2 hours per asset+direction
 */
(function () {
  'use strict';

  // ── constants ─────────────────────────────────────────────────────────────

  var INIT_DELAY_MS       = 10000;          // first fetch 10s after load
  var MARKETS_REFRESH_MS  = 900000;         // CoinGecko markets every 15 min
  var GLOBAL_REFRESH_MS   = 1200000;        // CoinGecko global every 20 min
  var BLOCKCHAIN_REFRESH_MS = 1800000;      // Blockchain.com stats every 30 min
  var COOLDOWN_MS         = 7200000;        // 2-hour cooldown per asset+direction
  var VOLUME_HISTORY_MAX  = 7;             // keep last 7 volume readings per asset
  var VOLUME_SURGE_MULTI  = 2.0;           // current vol > 2× avg → surge
  var TX_HISTORY_MAX      = 10;            // rolling window for n_tx average
  var TX_SURGE_RATIO      = 1.25;          // n_tx must exceed avg by 25%

  // CoinGecko API URLs (free tier, no key)
  var CG_MARKETS_URL =
    'https://api.coingecko.com/api/v3/coins/markets' +
    '?vs_currency=usd' +
    '&ids=bitcoin,ethereum,solana,ripple' +
    '&order=market_cap_desc' +
    '&per_page=4&page=1' +
    '&sparkline=false' +
    '&price_change_percentage=24h';

  var CG_GLOBAL_URL = 'https://api.coingecko.com/api/v3/global';

  var BLOCKCHAIN_STATS_URL = 'https://api.blockchain.info/stats';

  // Map CoinGecko IDs to HL ticker symbols
  var CG_ID_MAP = {
    'bitcoin'  : 'BTC',
    'ethereum' : 'ETH',
    'solana'   : 'SOL',
    'ripple'   : 'XRP'
  };

  // Global dominance thresholds (BTC % of total market cap)
  var DOM_RISE_THR = 2.0;    // BTC dominance rose > 2% → risk-off
  var DOM_DROP_THR = 2.0;    // BTC dominance dropped > 2% → alt season
  var MCAP_UP_THR  = 3.0;    // total market cap up >3% in 24h → risk-on

  // ── private state ─────────────────────────────────────────────────────────

  var _signals       = [];    // emitted signals this session
  var _cooldowns     = {};    // 'ASSET:BIAS' → last-fired timestamp
  var _volumeHistory = {};    // asset → [vol, vol, …]  (max 7 entries)
  var _txHistory     = [];    // rolling n_tx readings from Blockchain.com
  var _prevBtcDom    = null;  // previous BTC dominance % (for shift calc)

  var _lastPoll         = 0;
  var _lastFetch        = 0;
  var _cgBackoffUntil   = 0;   // CoinGecko 429 backoff — don't retry until this timestamp
  var _signalCount      = 0;
  var _online           = false;

  // Track when each source was last fetched
  var _lastMarketsAt    = 0;
  var _lastGlobalAt     = 0;
  var _lastBlockchainAt = 0;

  // ── cooldown helpers ──────────────────────────────────────────────────────

  function _onCooldown(asset, bias) {
    var key  = asset + ':' + bias;
    var last = _cooldowns[key];
    return last && (Date.now() - last) < COOLDOWN_MS;
  }

  function _setCooldown(asset, bias) {
    _cooldowns[asset + ':' + bias] = Date.now();
  }

  // ── tradeable check ───────────────────────────────────────────────────────

  function _tradeable(asset) {
    if (!window.HLFeed) return true;   // HLFeed not loaded — emit anyway
    return HLFeed.isAvailable(asset);
  }

  // ── emit helper ───────────────────────────────────────────────────────────

  function _emit(sigs) {
    if (!sigs || !sigs.length) return;

    var toEmit = [];
    for (var i = 0; i < sigs.length; i++) {
      var sig = sigs[i];
      if (_onCooldown(sig.asset, sig.bias)) continue;
      if (!_tradeable(sig.asset)) continue;
      _setCooldown(sig.asset, sig.bias);
      toEmit.push(sig);
    }

    if (!toEmit.length) return;

    // Append to session store (cap at 100)
    for (var j = 0; j < toEmit.length; j++) {
      _signals.push(toEmit[j]);
    }
    if (_signals.length > 100) _signals = _signals.slice(_signals.length - 100);
    _signalCount += toEmit.length;

    if (window.EE && typeof EE.onSignals === 'function') {
      try {
        EE.onSignals(toEmit);
      } catch (e) {
        console.warn('[OnChain] EE.onSignals error:', e);
      }
    }

    var labels = toEmit.map(function (s) { return s.asset + ':' + s.bias; }).join(', ');
    console.log('[OnChain] Emitted ' + toEmit.length + ' signal(s): ' + labels);
  }

  // ── Source 1: CoinGecko markets — volume surge ────────────────────────────

  function _fetchMarkets() {
    /* Respect CoinGecko 429 backoff window — don't hammer the API during throttle */
    if (Date.now() < _cgBackoffUntil) {
      var _waitSec = Math.ceil((_cgBackoffUntil - Date.now()) / 1000);
      console.log('[OnChain] CoinGecko backoff active — skipping markets fetch (' + _waitSec + 's remaining)');
      return;
    }
    var ctrl = new AbortController();
    var tid  = setTimeout(function () { ctrl.abort(); }, 120000);
    fetch(CG_MARKETS_URL, { signal: ctrl.signal })
      .then(function (res) {
        clearTimeout(tid);
        if (res.status === 429) {
          _cgBackoffUntil = Date.now() + 90000;  // back off 90s before retrying
          console.warn('[OnChain] CoinGecko rate-limited (429) — backing off 90s');
          return null;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        _lastMarketsAt = Date.now();
        _processMarkets(data);
      })
      .catch(function (err) {
        clearTimeout(tid);
        console.warn('[OnChain] CoinGecko markets fetch failed:', err.message);
      });
  }

  function _processMarkets(coins) {
    if (!Array.isArray(coins)) return;
    var sigs = [];
    var now  = Date.now();

    for (var i = 0; i < coins.length; i++) {
      var coin  = coins[i];
      var cgId  = coin.id;
      var asset = CG_ID_MAP[cgId];
      if (!asset) continue;

      var vol     = coin.total_volume;
      var chg24h  = coin.price_change_percentage_24h_in_currency;
      if (typeof vol !== 'number' || isNaN(vol)) continue;

      // Maintain rolling volume history
      if (!_volumeHistory[asset]) _volumeHistory[asset] = [];
      _volumeHistory[asset].push(vol);
      if (_volumeHistory[asset].length > VOLUME_HISTORY_MAX) {
        _volumeHistory[asset].shift();
      }

      // Need at least 2 prior readings before we can compare
      if (_volumeHistory[asset].length < 2) continue;

      // Average of all readings except the latest
      var hist = _volumeHistory[asset].slice(0, _volumeHistory[asset].length - 1);
      var sum  = 0;
      for (var k = 0; k < hist.length; k++) { sum += hist[k]; }
      var avg  = sum / hist.length;

      if (!avg || vol < avg * VOLUME_SURGE_MULTI) continue;

      // Volume surge — direction follows 24h price change
      var priceUp = typeof chg24h === 'number' && chg24h > 0;
      var bias    = priceUp ? 'LONG' : 'SHORT';
      var volX    = (vol / avg).toFixed(1);
      var chgStr  = (typeof chg24h === 'number') ? chg24h.toFixed(2) + '%' : 'n/a';

      sigs.push({
        source       : 'onchain',
        asset        : asset,
        bias         : bias,
        confidence   : 67,
        reasoning    : 'Volume surge: ' + asset + ' 24h volume ' + volX +
                       '\u00d7 rolling avg \u2014 price 24h: ' + chgStr +
                       ' \u2192 ' + bias.toLowerCase() + ' momentum signal',
        region       : 'GLOBAL',
        sector       : 'crypto',
        evidenceKeys : ['volume-surge', 'crypto', 'onchain'],
        timestamp    : now
      });
    }

    _emit(sigs);
  }

  // ── Source 2: CoinGecko global — market cap & BTC dominance ──────────────

  function _fetchGlobal() {
    if (Date.now() < _cgBackoffUntil) return;   // shared backoff with _fetchMarkets
    var ctrl = new AbortController();
    var tid  = setTimeout(function () { ctrl.abort(); }, 120000);
    fetch(CG_GLOBAL_URL, { signal: ctrl.signal })
      .then(function (res) {
        clearTimeout(tid);
        if (res.status === 429) {
          _cgBackoffUntil = Date.now() + 90000;
          console.warn('[OnChain] CoinGecko global rate-limited (429) — backing off 90s');
          return null;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (body) {
        if (!body) return;
        _lastGlobalAt = Date.now();
        _processGlobal(body.data);
      })
      .catch(function (err) {
        clearTimeout(tid);
        console.warn('[OnChain] CoinGecko global fetch failed:', err.message);
      });
  }

  function _processGlobal(data) {
    if (!data) return;
    var sigs = [];
    var now  = Date.now();

    var mcapChg24h = data.market_cap_change_percentage_24h_usd;  // e.g. 4.5
    var domPct     = data.market_cap_percentage;                  // { btc: 52.3, eth: … }
    var btcDom     = (domPct && typeof domPct.btc === 'number') ? domPct.btc : null;

    // Signal A: total market cap up >3% in 24h → risk-on
    if (typeof mcapChg24h === 'number' && mcapChg24h > MCAP_UP_THR) {
      var riskAssets = ['BTC', 'ETH'];
      for (var i = 0; i < riskAssets.length; i++) {
        sigs.push({
          source       : 'onchain',
          asset        : riskAssets[i],
          bias         : 'LONG',
          confidence   : 65,
          reasoning    : 'Total crypto market cap up ' + mcapChg24h.toFixed(1) +
                         '% in 24h \u2014 risk-on environment \u2192 ' + riskAssets[i] + ' LONG',
          region       : 'GLOBAL',
          sector       : 'crypto',
          evidenceKeys : ['market-cap', 'risk-on', 'crypto', 'onchain'],
          timestamp    : now
        });
      }
    }

    // BTC dominance shift signals — only if we have a prior reading to compare
    if (btcDom !== null && _prevBtcDom !== null) {
      var domShift = btcDom - _prevBtcDom;   // positive = BTC dom rose

      // Signal B: BTC dominance drops >2% → alt season → ETH and SOL LONG
      if (domShift <= -DOM_DROP_THR) {
        var altAssets = ['ETH', 'SOL'];
        for (var j = 0; j < altAssets.length; j++) {
          sigs.push({
            source       : 'onchain',
            asset        : altAssets[j],
            bias         : 'LONG',
            confidence   : 66,
            reasoning    : 'BTC dominance fell ' + Math.abs(domShift).toFixed(1) +
                           '% to ' + btcDom.toFixed(1) + '% \u2014 alt season rotation' +
                           ' \u2192 ' + altAssets[j] + ' LONG',
            region       : 'GLOBAL',
            sector       : 'crypto',
            evidenceKeys : ['btc-dominance', 'alt-season', 'crypto', 'onchain'],
            timestamp    : now
          });
        }
      }

      // Signal C: BTC dominance rises >2% → risk-off → BTC LONG only
      if (domShift >= DOM_RISE_THR) {
        sigs.push({
          source       : 'onchain',
          asset        : 'BTC',
          bias         : 'LONG',
          confidence   : 64,
          reasoning    : 'BTC dominance rose ' + domShift.toFixed(1) +
                         '% to ' + btcDom.toFixed(1) + '% \u2014 risk-off rotation' +
                         ' into BTC \u2192 BTC LONG',
          region       : 'GLOBAL',
          sector       : 'crypto',
          evidenceKeys : ['btc-dominance', 'risk-off', 'crypto', 'onchain'],
          timestamp    : now
        });
      }
    }

    // Store dominance for next comparison
    if (btcDom !== null) {
      _prevBtcDom = btcDom;
    }

    _emit(sigs);
  }

  // ── Source 3: Blockchain.com BTC stats — on-chain activity ───────────────

  function _fetchBlockchain() {
    var ctrl = new AbortController();
    var tid  = setTimeout(function () { ctrl.abort(); }, 120000);
    fetch(BLOCKCHAIN_STATS_URL, { signal: ctrl.signal })
      .then(function (res) {
        clearTimeout(tid);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        _lastBlockchainAt = Date.now();
        _processBlockchain(data);
      })
      .catch(function (err) {
        clearTimeout(tid);
        // CORS or network failure — skip gracefully, this source is optional
        console.warn('[OnChain] Blockchain.com stats fetch failed (may be CORS) — skipping:', err.message);
      });
  }

  function _processBlockchain(data) {
    if (!data) return;
    var sigs = [];
    var now  = Date.now();

    var nTx = data.n_tx;
    if (typeof nTx !== 'number' || isNaN(nTx)) return;

    // Update rolling average
    _txHistory.push(nTx);
    if (_txHistory.length > TX_HISTORY_MAX) _txHistory.shift();

    // Need at least 3 readings to establish a baseline
    if (_txHistory.length < 3) {
      console.log('[OnChain] Blockchain.com: building tx baseline (' + _txHistory.length + '/' + TX_HISTORY_MAX + ')');
      return;
    }

    // Average of previous readings (exclude current)
    var prev = _txHistory.slice(0, _txHistory.length - 1);
    var sum  = 0;
    for (var i = 0; i < prev.length; i++) { sum += prev[i]; }
    var avg = sum / prev.length;

    if (!avg) return;

    var ratio = nTx / avg;
    if (ratio < TX_SURGE_RATIO) return;  // not notably high

    sigs.push({
      source       : 'onchain',
      asset        : 'BTC',
      bias         : 'LONG',
      confidence   : 65,
      reasoning    : 'BTC on-chain transaction count elevated: ' + nTx.toLocaleString() +
                     ' tx (' + ratio.toFixed(2) + '\u00d7 rolling avg of ' + Math.round(avg).toLocaleString() +
                     ') \u2014 rising network activity \u2192 BTC LONG',
      region       : 'GLOBAL',
      sector       : 'crypto',
      evidenceKeys : ['onchain', 'exchange-flow', 'crypto'],
      timestamp    : now
    });

    _emit(sigs);
  }

  // ── main scan ─────────────────────────────────────────────────────────────

  function _scan() {
    var now = Date.now();
    _lastPoll = now;
    _online   = true;

    // Fetch each source if its interval has elapsed (or first run)
    if (!_lastMarketsAt || (now - _lastMarketsAt) >= MARKETS_REFRESH_MS) {
      _fetchMarkets();
    }

    if (!_lastGlobalAt || (now - _lastGlobalAt) >= GLOBAL_REFRESH_MS) {
      _fetchGlobal();
    }

    if (!_lastBlockchainAt || (now - _lastBlockchainAt) >= BLOCKCHAIN_REFRESH_MS) {
      _fetchBlockchain();
    }

    // Track most recent fetch attempt across all sources
    _lastFetch = now;

    console.log('[OnChain] Scan triggered at ' + new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
  }

  // ── init ──────────────────────────────────────────────────────────────────

  function _init() {
    // First fetch after 10 seconds, then poll on the shortest interval (15 min)
    // Each fetcher internally checks whether its own interval has elapsed.
    setTimeout(function () {
      _scan();
      setInterval(_scan, MARKETS_REFRESH_MS);  // 15-min heartbeat
    }, INIT_DELAY_MS);

    console.log('[OnChain] Agent initialised — first fetch in 10s');
  }

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_AGENT_ONCHAIN = {

    status: function () {
      var activeCooldowns = 0;
      var now = Date.now();
      for (var key in _cooldowns) {
        if (_cooldowns.hasOwnProperty(key)) {
          if ((now - _cooldowns[key]) < COOLDOWN_MS) activeCooldowns++;
        }
      }

      var sourceNotes = [];
      if (_lastMarketsAt)    sourceNotes.push('CG-markets: ' + _tsAgo(_lastMarketsAt));
      if (_lastGlobalAt)     sourceNotes.push('CG-global: ' + _tsAgo(_lastGlobalAt));
      if (_lastBlockchainAt) sourceNotes.push('blockchain: ' + _tsAgo(_lastBlockchainAt));

      var note = _online
        ? (_signalCount + ' signal(s) emitted \u00b7 ' + activeCooldowns + ' cooldown(s) active' +
           (sourceNotes.length ? ' \u00b7 ' + sourceNotes.join(' \u00b7 ') : ''))
        : 'warming up \u2014 first fetch in ~10s';

      return {
        lastPoll    : _lastPoll,
        online      : _online,
        lastFetch   : _lastFetch,
        signalCount : _signalCount,
        note        : note
      };
    },

    signals: function () {
      return _signals.slice();
    },

    scan: function () {
      console.log('[OnChain] Manual scan triggered');
      _scan();
    }

  };

  // ── internal helpers ──────────────────────────────────────────────────────

  function _tsAgo(ts) {
    var sec = Math.round((Date.now() - ts) / 1000);
    if (sec < 60)   return sec + 's ago';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    return Math.floor(sec / 3600) + 'h ago';
  }

  window.addEventListener('load', _init);

})();
