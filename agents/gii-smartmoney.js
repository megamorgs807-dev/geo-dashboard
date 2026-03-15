/* GII Smart Money Agent — gii-smartmoney.js v1
 *
 * Tracks the top 20 Hyperliquid traders by all-time PnL and aggregates
 * their open positions to detect smart-money consensus on BTC and ETH.
 *
 * When 60%+ of top traders (weighted by PnL rank) are positioned the same
 * way on an asset, this agent emits a directional signal.
 *
 * Data sources (all public, no key, CORS-accessible):
 *   Leaderboard: https://stats-data.hyperliquid.xyz/Mainnet/leaderboard
 *   Positions:   https://api.hyperliquid.xyz/info  (clearinghouseState per trader)
 *
 * Poll interval: 15 minutes (positions change slowly relative to order books)
 * Exposes: window.GII_AGENT_SMARTMONEY
 */
(function () {
  'use strict';

  // ── constants ─────────────────────────────────────────────────────────────

  var POLL_INTERVAL_MS   = 15 * 60 * 1000;  // 15 minutes
  var INIT_DELAY_MS      = 18500;            // after optimizer (17.5s) + buffer
  var TOP_N_TRADERS      = 20;               // how many top traders to track
  var MIN_ACCOUNT_VALUE  = 50000;            // ignore accounts under $50k (bots/dust)
  var CONSENSUS_THRESH   = 0.60;             // 60%+ weighted consensus to emit signal
  var FETCH_GAP_MS       = 1500;             // gap between position fetches (rate polite)
  var LB_URL             = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
  var HL_INFO            = 'https://api.hyperliquid.xyz/info';
  var FEEDBACK_KEY       = 'gii_smartmoney_feedback_v1';

  // Assets we care about for GII signals
  var TARGET_ASSETS = ['BTC', 'ETH'];

  // ── private state ─────────────────────────────────────────────────────────

  var _signals      = [];
  var _status       = {};
  var _lastPollTs   = 0;
  var _traderCache  = [];   // top traders from last leaderboard fetch
  var _posCache     = {};   // { address: [positions] }
  var _lastSnapshot = {};   // { BTC: { longPct, shortPct, neutralPct, traderCount } }
  var _feedback     = {};

  // ── helpers ───────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function _round2(v) { return Math.round(v * 100) / 100; }

  function _loadFeedback() {
    try { var r = localStorage.getItem(FEEDBACK_KEY); _feedback = r ? JSON.parse(r) : {}; }
    catch (e) { _feedback = {}; }
  }

  function _saveFeedback() {
    try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(_feedback)); } catch (e) {}
  }

  // Sequential promise queue with a gap between each call
  function _seq(items, fn) {
    return items.reduce(function (chain, item) {
      return chain.then(function (results) {
        return new Promise(function (resolve) {
          setTimeout(function () {
            fn(item).then(function (result) {
              results.push(result);
              resolve(results);
            }).catch(function () {
              results.push(null);
              resolve(results);
            });
          }, FETCH_GAP_MS);
        });
      });
    }, Promise.resolve([]));
  }

  // ── leaderboard fetch ─────────────────────────────────────────────────────

  function _fetchLeaderboard() {
    return fetch(LB_URL)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var rows = data.leaderboardRows || [];

        // Filter to traders with meaningful accounts
        rows = rows.filter(function (r) {
          return parseFloat(r.accountValue || 0) >= MIN_ACCOUNT_VALUE;
        });

        // Sort by all-time PnL (most reliable signal of sustained edge)
        rows.sort(function (a, b) {
          var aPnl = _allTimePnl(a);
          var bPnl = _allTimePnl(b);
          return bPnl - aPnl;
        });

        // Also require positive month PnL to filter out "got lucky once" traders
        rows = rows.filter(function (r) {
          return _windowPnl(r, 'month') > 0;
        });

        return rows.slice(0, TOP_N_TRADERS);
      })
      .catch(function () { return []; });
  }

  function _allTimePnl(row) {
    return _windowPnl(row, 'allTime');
  }

  function _windowPnl(row, window) {
    var perfs = row.windowPerformances || [];
    for (var i = 0; i < perfs.length; i++) {
      if (perfs[i][0] === window) return parseFloat(perfs[i][1].pnl || 0);
    }
    return 0;
  }

  // ── position fetch ────────────────────────────────────────────────────────

  function _fetchPositions(address) {
    return fetch(HL_INFO, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'clearinghouseState', user: address })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var positions = (data.assetPositions || [])
          .filter(function (p) {
            return p.position && parseFloat(p.position.szi || 0) !== 0;
          })
          .map(function (p) {
            var szi = parseFloat(p.position.szi || 0);
            return {
              coin:          p.position.coin,
              size:          szi,
              dir:           szi > 0 ? 'long' : 'short',
              entryPx:       parseFloat(p.position.entryPx || 0),
              unrealizedPnl: parseFloat(p.position.unrealizedPnl || 0),
              leverage:      (p.position.leverage && p.position.leverage.value) || 1
            };
          });
        return { address: address, positions: positions };
      })
      .catch(function () { return { address: address, positions: [] }; });
  }

  // ── consensus computation ─────────────────────────────────────────────────

  function _computeConsensus(traders, positionResults) {
    // Build position map: address → positions
    var posMap = {};
    positionResults.forEach(function (r) {
      if (r) posMap[r.address] = r.positions;
    });

    var snapshot = {};

    TARGET_ASSETS.forEach(function (asset) {
      var longWeight  = 0;
      var shortWeight = 0;
      var totalWeight = 0;
      var traderCount = 0;

      traders.forEach(function (trader, idx) {
        // Weight: top trader gets weight TOP_N, bottom gets 1
        var weight = TOP_N_TRADERS - idx;
        var positions = posMap[trader.ethAddress] || [];
        var pos = null;
        for (var i = 0; i < positions.length; i++) {
          if (positions[i].coin === asset) { pos = positions[i]; break; }
        }

        totalWeight += weight;
        if (pos) {
          traderCount++;
          if (pos.dir === 'long')  longWeight  += weight;
          else                     shortWeight += weight;
        }
      });

      var longPct  = totalWeight > 0 ? longWeight  / totalWeight : 0;
      var shortPct = totalWeight > 0 ? shortWeight / totalWeight : 0;

      snapshot[asset] = {
        longPct:      _round2(longPct),
        shortPct:     _round2(shortPct),
        neutralPct:   _round2(1 - longPct - shortPct),
        traderCount:  traderCount,
        totalTracked: traders.length
      };
    });

    return snapshot;
  }

  // ── signal building ───────────────────────────────────────────────────────

  function _buildSignals(snapshot) {
    var sigs = [];

    TARGET_ASSETS.forEach(function (asset) {
      var s = snapshot[asset];
      if (!s || s.traderCount < 3) return;  // need at least 3 traders with positions

      var dominant, dominantPct;
      if (s.longPct >= CONSENSUS_THRESH) {
        dominant    = 'long';
        dominantPct = s.longPct;
      } else if (s.shortPct >= CONSENSUS_THRESH) {
        dominant    = 'short';
        dominantPct = s.shortPct;
      } else {
        return;  // no consensus
      }

      // Confidence scales with consensus strength
      var conf = _clamp(0.48 + (dominantPct - CONSENSUS_THRESH) * 1.8, 0, 0.82);

      // Feedback adjustment
      var fbKey = asset + '_' + dominant;
      var fb = _feedback[fbKey];
      if (fb && fb.total >= 5) {
        if (fb.winRate < 0.40) conf = _clamp(conf * 0.75, 0, 0.82);
        else if (fb.winRate >= 0.65) conf = _clamp(conf * 1.08, 0, 0.82);
      }

      sigs.push({
        source:       'smartmoney',
        asset:        asset,
        bias:         dominant,
        confidence:   _round2(conf),
        reasoning:    'Top ' + s.totalTracked + ' HL traders: ' +
                      Math.round(dominantPct * 100) + '% ' + dominant.toUpperCase() +
                      ' ' + asset + ' (' + s.traderCount + ' with open positions)',
        timestamp:    Date.now(),
        region:       'GLOBAL',
        evidenceKeys: ['smart_money', 'hl_leaderboard', asset.toLowerCase()],
        smartMoney:   true,
        longPct:      s.longPct,
        shortPct:     s.shortPct,
        traderCount:  s.traderCount
      });
    });

    return sigs;
  }

  // ── main poll ─────────────────────────────────────────────────────────────

  function poll() {
    _lastPollTs = Date.now();
    _status.lastPoll = _lastPollTs;
    _status.phase    = 'fetching leaderboard';

    _fetchLeaderboard()
      .then(function (traders) {
        if (!traders.length) {
          _status.error = 'Leaderboard fetch returned 0 traders';
          return;
        }

        _traderCache = traders;
        _status.tradersLoaded = traders.length;
        _status.phase = 'fetching positions (0/' + traders.length + ')';

        // Fetch positions serially to be polite to the API
        return _seq(traders, function (trader, idx) {
          _status.phase = 'fetching positions (' + (idx + 1) + '/' + traders.length + ')';
          return _fetchPositions(trader.ethAddress);
        });
      })
      .then(function (positionResults) {
        if (!positionResults) return;

        var snapshot = _computeConsensus(_traderCache, positionResults);
        _lastSnapshot = snapshot;

        _signals = _buildSignals(snapshot);

        _status.phase   = 'complete';
        _status.error   = null;
        _status.snapshot = snapshot;
        _status.signalCount = _signals.length;

        if (_signals.length) {
          _signals.forEach(function (s) {
            console.info('[GII SMARTMONEY] ' + s.bias.toUpperCase() + ' ' + s.asset +
              ' conf=' + s.confidence + ' | ' + s.reasoning);
          });
        } else {
          _status.note = 'No consensus (BTC: ' +
            Math.round((_lastSnapshot.BTC || {}).longPct * 100 || 0) + '% long, ' +
            Math.round((_lastSnapshot.BTC || {}).shortPct * 100 || 0) + '% short)';
        }
      })
      .catch(function (e) {
        _status.error = 'Poll error: ' + (e.message || String(e));
        _status.phase = 'error';
      });
  }

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_AGENT_SMARTMONEY = {
    poll:      poll,
    signals:   function () { return _signals.slice(); },
    status:    function () { return Object.assign({ lastPoll: _lastPollTs }, _status); },
    accuracy:  function () { return Object.assign({}, _feedback); },
    snapshot:  function () { return Object.assign({}, _lastSnapshot); },
    traders:   function () { return _traderCache.slice(); }
  };

  // ── init ──────────────────────────────────────────────────────────────────

  window.addEventListener('load', function () {
    _loadFeedback();
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL_MS);
    }, INIT_DELAY_MS);
  });

})();
