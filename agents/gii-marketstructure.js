/* GII Market Structure Agent — gii-marketstructure.js v1
 *
 * Analyses the Hyperliquid BTC order book for microstructure signals.
 * Uses the public l2Book endpoint (no key, CORS-accessible) to compute:
 *
 *   1. Bid/Ask Imbalance  — weighted volume ratio across top 10 levels
 *      Positive = more buy pressure → bullish
 *      Negative = more sell pressure → bearish
 *
 *   2. Spread              — bid-ask spread as % of mid price
 *      Wide spread = uncertainty / thin liquidity
 *
 *   3. Wall Detection      — identifies unusually large single orders
 *      Large bid wall = strong support level
 *      Large ask wall = strong resistance level
 *
 *   4. Depth Ratio         — total USD bid depth vs ask depth in top 10 levels
 *
 * Poll interval: 3 minutes (order book is dynamic)
 * Exposes: window.GII_AGENT_MARKETSTRUCTURE
 */
(function () {
  'use strict';

  // ── constants ─────────────────────────────────────────────────────────────

  var POLL_INTERVAL_MS  = 3 * 60 * 1000;   // 3 minutes
  var INIT_DELAY_MS     = 19500;            // after smartmoney (18.5s) + buffer
  var HL_INFO           = 'https://api.hyperliquid.xyz/info';
  var DEPTH_LEVELS      = 10;               // number of order book levels to analyse
  var IMBALANCE_THRESH  = 0.18;             // minimum |imbalance| to emit signal
  var WALL_MULTIPLIER   = 5.0;              // a level is a "wall" if size > N × avg level size
  var SPREAD_WIDE_PCT   = 0.05;             // spread > 0.05% = wide / uncertain market
  var FEEDBACK_KEY      = 'gii_marketstructure_feedback_v1';

  // Assets to monitor
  var TARGET_COINS = ['BTC', 'ETH'];

  // ── private state ─────────────────────────────────────────────────────────

  var _signals      = [];
  var _status       = {};
  var _lastPollTs   = 0;
  var _lastBooks    = {};   // { BTC: { bids, asks, computed }, ETH: {...} }
  var _feedback     = {};

  // ── helpers ───────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function _round2(v) { return Math.round(v * 100) / 100; }
  function _round4(v) { return Math.round(v * 10000) / 10000; }

  function _loadFeedback() {
    try { var r = localStorage.getItem(FEEDBACK_KEY); _feedback = r ? JSON.parse(r) : {}; }
    catch (e) { _feedback = {}; }
  }

  function _saveFeedback() {
    try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(_feedback)); } catch (e) {}
  }

  // ── order book fetch ──────────────────────────────────────────────────────

  function _fetchBook(coin) {
    return fetch(HL_INFO, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'l2Book', coin: coin })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // data.levels[0] = bids (descending by price), data.levels[1] = asks (ascending)
        if (!data || !data.levels) return null;
        return {
          coin: coin,
          time: data.time,
          bids: (data.levels[0] || []).map(function (l) {
            return { px: parseFloat(l.px), sz: parseFloat(l.sz), n: l.n || 1 };
          }),
          asks: (data.levels[1] || []).map(function (l) {
            return { px: parseFloat(l.px), sz: parseFloat(l.sz), n: l.n || 1 };
          })
        };
      })
      .catch(function () { return null; });
  }

  // ── microstructure computation ────────────────────────────────────────────

  function _computeStructure(book) {
    if (!book || !book.bids.length || !book.asks.length) return null;

    var bids = book.bids.slice(0, DEPTH_LEVELS);
    var asks = book.asks.slice(0, DEPTH_LEVELS);

    var topBid = bids[0].px;
    var topAsk = asks[0].px;
    var midPx  = (topBid + topAsk) / 2;

    // Spread
    var spreadAbs = topAsk - topBid;
    var spreadPct = spreadAbs / midPx * 100;

    // Total volume each side (in coin units)
    var totalBidVol = 0, totalAskVol = 0;
    bids.forEach(function (l) { totalBidVol += l.sz; });
    asks.forEach(function (l) { totalAskVol += l.sz; });

    // USD depth each side
    var bidDepthUsd = 0, askDepthUsd = 0;
    bids.forEach(function (l) { bidDepthUsd += l.sz * l.px; });
    asks.forEach(function (l) { askDepthUsd += l.sz * l.px; });

    // Order book imbalance: +1 = all bids, -1 = all asks
    var totalVol = totalBidVol + totalAskVol;
    var imbalance = totalVol > 0 ? (totalBidVol - totalAskVol) / totalVol : 0;

    // Depth ratio
    var depthRatio = askDepthUsd > 0 ? bidDepthUsd / askDepthUsd : 1.0;

    // Wall detection — find any level with size significantly above average
    var allLevels = bids.concat(asks);
    var avgSize = 0;
    allLevels.forEach(function (l) { avgSize += l.sz; });
    avgSize /= allLevels.length || 1;

    var bidWall = null, askWall = null;
    bids.forEach(function (l) {
      if (l.sz > avgSize * WALL_MULTIPLIER && (!bidWall || l.sz > bidWall.sz)) bidWall = l;
    });
    asks.forEach(function (l) {
      if (l.sz > avgSize * WALL_MULTIPLIER && (!askWall || l.sz > askWall.sz)) askWall = l;
    });

    return {
      midPx:       _round2(midPx),
      spreadPct:   _round4(spreadPct),
      spreadWide:  spreadPct > SPREAD_WIDE_PCT,
      imbalance:   _round4(imbalance),
      bidDepthUsd: Math.round(bidDepthUsd),
      askDepthUsd: Math.round(askDepthUsd),
      depthRatio:  _round2(depthRatio),
      bidWall:     bidWall ? { px: bidWall.px, sz: _round2(bidWall.sz) } : null,
      askWall:     askWall ? { px: askWall.px, sz: _round2(askWall.sz) } : null,
      totalBidVol: _round2(totalBidVol),
      totalAskVol: _round2(totalAskVol)
    };
  }

  // ── signal building ───────────────────────────────────────────────────────

  function _buildSignal(coin, computed) {
    var imb = computed.imbalance;
    var absImb = Math.abs(imb);

    if (absImb < IMBALANCE_THRESH) return null;  // not enough conviction

    var dir = imb > 0 ? 'long' : 'short';

    // Base confidence from imbalance strength
    var conf = _clamp(0.42 + (absImb - IMBALANCE_THRESH) * 2.0, 0, 0.78);

    // Penalty for wide spread (uncertain / thin market)
    if (computed.spreadWide) conf = _clamp(conf - 0.06, 0, 0.78);

    // Boost if depth ratio confirms (more USD on the dominant side)
    var depthConfirms = (dir === 'long' && computed.depthRatio > 1.20) ||
                        (dir === 'short' && computed.depthRatio < 0.83);
    if (depthConfirms) conf = _clamp(conf + 0.05, 0, 0.78);

    // Wall note
    var wallNote = '';
    if (dir === 'long'  && computed.bidWall) wallNote = ' | bid wall @ ' + computed.bidWall.px;
    if (dir === 'short' && computed.askWall) wallNote = ' | ask wall @ ' + computed.askWall.px;

    // Feedback adjustment
    var fbKey = coin + '_' + dir;
    var fb = _feedback[fbKey];
    if (fb && fb.total >= 5) {
      if (fb.winRate < 0.40) conf = _clamp(conf * 0.75, 0, 0.78);
      else if (fb.winRate >= 0.65) conf = _clamp(conf * 1.08, 0, 0.78);
    }

    return {
      source:       'marketstructure',
      asset:        coin,
      bias:         dir,
      confidence:   _round2(conf),
      reasoning:    'OB imbalance ' + (imb > 0 ? '+' : '') + (imb * 100).toFixed(1) +
                    '% (' + dir + ' pressure) | spread=' + (computed.spreadPct * 100).toFixed(2) +
                    'bps | depth $' + Math.round(computed.bidDepthUsd / 1000) + 'k bid vs $' +
                    Math.round(computed.askDepthUsd / 1000) + 'k ask' + wallNote,
      timestamp:    Date.now(),
      region:       'GLOBAL',
      evidenceKeys: ['order_book', 'microstructure', coin.toLowerCase()],
      marketStructure: true,
      imbalance:    computed.imbalance,
      spreadPct:    computed.spreadPct,
      depthRatio:   computed.depthRatio,
      bidWall:      computed.bidWall,
      askWall:      computed.askWall
    };
  }

  // ── main poll ─────────────────────────────────────────────────────────────

  function poll() {
    _lastPollTs = Date.now();
    _status.lastPoll = _lastPollTs;

    // Fetch all target coins
    var fetches = TARGET_COINS.map(function (coin) {
      return _fetchBook(coin);
    });

    Promise.all(fetches)
      .then(function (books) {
        var newSigs = [];

        books.forEach(function (book) {
          if (!book) return;

          var computed = _computeStructure(book);
          if (!computed) return;

          _lastBooks[book.coin] = Object.assign({ coin: book.coin }, computed);

          var sig = _buildSignal(book.coin, computed);
          if (sig) newSigs.push(sig);
        });

        _signals = newSigs;
        _status.error = null;
        _status.books = Object.assign({}, _lastBooks);
        _status.signalCount = _signals.length;

        // Status summary for UI
        var btcBook = _lastBooks['BTC'];
        if (btcBook) {
          _status.btcImbalance  = (btcBook.imbalance * 100).toFixed(1) + '%';
          _status.btcSpread     = (btcBook.spreadPct * 100).toFixed(2) + 'bps';
          _status.btcMidPx      = btcBook.midPx;
          _status.btcDepthRatio = btcBook.depthRatio;
        }

        if (_signals.length) {
          _signals.forEach(function (s) {
            console.info('[GII MKTSTRUCT] ' + s.bias.toUpperCase() + ' ' + s.asset +
              ' conf=' + s.confidence + ' | ' + s.reasoning);
          });
        }
      })
      .catch(function (e) {
        _status.error = 'Poll error: ' + (e.message || String(e));
      });
  }

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_AGENT_MARKETSTRUCTURE = {
    poll:     poll,
    signals:  function () { return _signals.slice(); },
    status:   function () { return Object.assign({ lastPoll: _lastPollTs }, _status); },
    accuracy: function () { return Object.assign({}, _feedback); },
    books:    function () { return Object.assign({}, _lastBooks); }
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
