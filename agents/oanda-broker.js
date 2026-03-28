/**
 * OANDA Broker v1 — Live/Demo trading via OANDA v20 REST API
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shares the connection from OANDA_RATES (same token, same accountId).
 * When OANDA_RATES is connected, OANDABroker is automatically available.
 *
 * Covers:
 *   Forex    — EUR, GBP, JPY, CHF, AUD, CAD, NZD (+ cross pairs)
 *   Metals   — XAU/GLD (gold), XAG/SLV (silver)
 *   Energy   — WTI/OIL/CRUDE, BRENT/BRENTOIL, NATGAS/GAS
 *   Indices  — SPX/SPY (S&P500), NAS/QQQ (Nasdaq), DOW/DIA (Dow)
 *
 * Usage (from EE or console):
 *   OANDABroker.covers('EURUSD')              → true
 *   OANDABroker.placeOrder('EUR', 1000, 'buy') → Promise<orderResponse>
 *   OANDABroker.closePosition('XAU')           → Promise
 *   OANDABroker.getPositions()                 → Promise<positions[]>
 *   OANDABroker.getAccount()                   → Promise<{nav, balance, unrealizedPL}>
 *   OANDABroker.status()                       → { connected, demo, nav, positions, … }
 *
 * Exposed as window.OANDABroker
 * ═══════════════════════════════════════════════════════════════════════════════
 */
(function () {
  'use strict';

  var DEMO_URL = 'https://api-fxpractice.oanda.com';
  var LIVE_URL = 'https://api-fxtrade.oanda.com';

  /* ── Instrument map: EE asset name → OANDA instrument ──────────────────────
     inverse: true means the EE "LONG X" = OANDA short (e.g. LONG JPY = short USD/JPY)
     minUnits: smallest order size (varies by instrument)
     precision: decimal places for units                                        */
  var OANDA_INSTRUMENTS = {
    /* ── Forex ───────────────────────────────────────────────────────── */
    'EUR':    { instrument: 'EUR_USD', inverse: false, sector: 'fx',       minUnits: 1,    precision: 0 },
    'EURUSD': { instrument: 'EUR_USD', inverse: false, sector: 'fx',       minUnits: 1,    precision: 0 },
    'GBP':    { instrument: 'GBP_USD', inverse: false, sector: 'fx',       minUnits: 1,    precision: 0 },
    'GBPUSD': { instrument: 'GBP_USD', inverse: false, sector: 'fx',       minUnits: 1,    precision: 0 },
    'AUD':    { instrument: 'AUD_USD', inverse: false, sector: 'fx',       minUnits: 1,    precision: 0 },
    'AUDUSD': { instrument: 'AUD_USD', inverse: false, sector: 'fx',       minUnits: 1,    precision: 0 },
    'NZD':    { instrument: 'NZD_USD', inverse: false, sector: 'fx',       minUnits: 1,    precision: 0 },
    'NZDUSD': { instrument: 'NZD_USD', inverse: false, sector: 'fx',       minUnits: 1,    precision: 0 },
    /* USD-base pairs: "LONG JPY" = JPY rising = short USD/JPY */
    'JPY':    { instrument: 'USD_JPY', inverse: true,  sector: 'fx',       minUnits: 1,    precision: 0 },
    'USDJPY': { instrument: 'USD_JPY', inverse: false, sector: 'fx',       minUnits: 1,    precision: 0 },
    'CHF':    { instrument: 'USD_CHF', inverse: true,  sector: 'fx',       minUnits: 1,    precision: 0 },
    'USDCHF': { instrument: 'USD_CHF', inverse: false, sector: 'fx',       minUnits: 1,    precision: 0 },
    'CAD':    { instrument: 'USD_CAD', inverse: true,  sector: 'fx',       minUnits: 1,    precision: 0 },
    'USDCAD': { instrument: 'USD_CAD', inverse: false, sector: 'fx',       minUnits: 1,    precision: 0 },
    'GBPJPY': { instrument: 'GBP_JPY', inverse: false, sector: 'fx',       minUnits: 1,    precision: 0 },
    'EURJPY': { instrument: 'EUR_JPY', inverse: false, sector: 'fx',       minUnits: 1,    precision: 0 },
    'EURGBP': { instrument: 'EUR_GBP', inverse: false, sector: 'fx',       minUnits: 1,    precision: 0 },
    /* ── Precious metals ─────────────────────────────────────────────── */
    'XAU':    { instrument: 'XAU_USD', inverse: false, sector: 'precious', minUnits: 1,    precision: 0 },
    'GLD':    { instrument: 'XAU_USD', inverse: false, sector: 'precious', minUnits: 1,    precision: 0 },
    'GOLD':   { instrument: 'XAU_USD', inverse: false, sector: 'precious', minUnits: 1,    precision: 0 },
    'XAG':    { instrument: 'XAG_USD', inverse: false, sector: 'precious', minUnits: 1,    precision: 0 },
    'SLV':    { instrument: 'XAG_USD', inverse: false, sector: 'precious', minUnits: 1,    precision: 0 },
    'SILVER': { instrument: 'XAG_USD', inverse: false, sector: 'precious', minUnits: 1,    precision: 0 },
    /* ── Energy ──────────────────────────────────────────────────────── */
    'WTI':      { instrument: 'WTICO_USD', inverse: false, sector: 'energy', minUnits: 1,  precision: 0 },
    'OIL':      { instrument: 'WTICO_USD', inverse: false, sector: 'energy', minUnits: 1,  precision: 0 },
    'CRUDE':    { instrument: 'WTICO_USD', inverse: false, sector: 'energy', minUnits: 1,  precision: 0 },
    'BRENT':    { instrument: 'BCO_USD',   inverse: false, sector: 'energy', minUnits: 1,  precision: 0 },
    'BRENTOIL': { instrument: 'BCO_USD',   inverse: false, sector: 'energy', minUnits: 1,  precision: 0 },
    'NATGAS':   { instrument: 'NATGAS_USD',inverse: false, sector: 'energy', minUnits: 1,  precision: 0 },
    'GAS':      { instrument: 'NATGAS_USD',inverse: false, sector: 'energy', minUnits: 1,  precision: 0 },
    /* ── Indices (CFDs) ──────────────────────────────────────────────── */
    'SPX':    { instrument: 'SPX500_USD', inverse: false, sector: 'equity',  minUnits: 1,  precision: 0 },
    'SPY':    { instrument: 'SPX500_USD', inverse: false, sector: 'equity',  minUnits: 1,  precision: 0 },
    'SP500':  { instrument: 'SPX500_USD', inverse: false, sector: 'equity',  minUnits: 1,  precision: 0 },
    'NAS':    { instrument: 'NAS100_USD', inverse: false, sector: 'equity',  minUnits: 1,  precision: 0 },
    'QQQ':    { instrument: 'NAS100_USD', inverse: false, sector: 'equity',  minUnits: 1,  precision: 0 },
    'NASDAQ': { instrument: 'NAS100_USD', inverse: false, sector: 'equity',  minUnits: 1,  precision: 0 },
    'DOW':    { instrument: 'US30_USD',   inverse: false, sector: 'equity',  minUnits: 1,  precision: 0 },
    'DIA':    { instrument: 'US30_USD',   inverse: false, sector: 'equity',  minUnits: 1,  precision: 0 },
    'DAX':    { instrument: 'DE30_EUR',   inverse: false, sector: 'equity',  minUnits: 1,  precision: 0 },
    'FTSE':   { instrument: 'UK100_GBP',  inverse: false, sector: 'equity',  minUnits: 1,  precision: 0 },
    /* ── Palladium / Platinum ─────────────────────────────────────────── */
    'XPD':    { instrument: 'XPD_USD', inverse: false, sector: 'precious', minUnits: 1,    precision: 2 },
    'XPT':    { instrument: 'XPT_USD', inverse: false, sector: 'precious', minUnits: 1,    precision: 2 },
  };

  /* ── Internal state ────────────────────────────────────────────────────── */
  var _acctCache   = null;   // cached account summary { nav, balance, unrealizedPL }
  var _acctFetchTs = 0;
  var ACCT_TTL_MS  = 30000;  // refresh account every 30s max

  /* ── Helpers: share token from OANDA_RATES ─────────────────────────────── */

  function _isRatesConnected() {
    return typeof window.OANDA_RATES !== 'undefined' && OANDA_RATES.isConnected();
  }

  function _ratesCfg() {
    // Read the saved config from OANDA_RATES localStorage key
    try {
      return JSON.parse(localStorage.getItem('oanda_rates_cfg_v1') || '{}');
    } catch (e) { return {}; }
  }

  function _baseUrl() {
    var cfg = _ratesCfg();
    return cfg.demo !== false ? DEMO_URL : LIVE_URL;
  }

  function _headers() {
    var cfg = _ratesCfg();
    return {
      'Authorization': 'Bearer ' + (cfg.token || ''),
      'Content-Type':  'application/json'
    };
  }

  function _accountId() {
    return _ratesCfg().accountId || '';
  }

  /* Generic fetch wrapper.
     Detects 401/403 immediately and marks broker disconnected — catches expired
     API tokens mid-session without waiting for the next health-check cycle.     */
  async function _api(path, opts) {
    var url = _baseUrl() + path;
    var res = await fetch(url, Object.assign({ headers: _headers() }, opts || {}));
    if (!res.ok) {
      var txt = await res.text();
      if (res.status === 401 || res.status === 403) {
        console.warn('[OANDA] ⚠ Auth failure (' + res.status + ') — broker marked disconnected. ' +
          'Check API key / account ID and re-connect.', txt.substring(0, 100));
        /* Mark OANDA_RATES disconnected so downstream agents stop using stale prices */
        if (window.OANDA_RATES && typeof OANDA_RATES._setConnected === 'function') {
          OANDA_RATES._setConnected(false);
        }
      }
      throw new Error('OANDA ' + res.status + ': ' + txt.substring(0, 300));
    }
    return res.json();
  }

  /* ── Unit sizing ──────────────────────────────────────────────────────────
     OANDA units = base currency amount.
     For EUR_USD: units = sizeUsd / eurUsdRate  (buying X euros)
     For USD_JPY: units = sizeUsd               (buying X US dollars)
     For XAU_USD: units = sizeUsd / goldPrice   (buying X troy oz)
     For SPX500_USD: units = sizeUsd / spxPrice (buying X index units)         */
  function _calcUnits(info, sizeUsd, price) {
    var instr = info.instrument;
    // USD is the base currency for these pairs — 1 unit = 1 USD
    var usdBasePairs = ['USD_JPY', 'USD_CHF', 'USD_CAD'];
    var units;
    if (usdBasePairs.indexOf(instr) >= 0) {
      units = Math.round(sizeUsd);
    } else if (price && price > 0) {
      // 1 unit = 1 of the base currency (EUR, XAU, WTI barrel, etc.)
      units = sizeUsd / price;
      // Round to precision
      units = parseFloat(units.toFixed(info.precision || 0));
    } else {
      // No price available — use 1 unit as fallback (will be tiny, safe)
      units = 1;
    }
    return Math.max(units, info.minUnits || 1);
  }

  /* ── Render the broker card ───────────────────────────────────────────── */
  function _renderCard() {
    var card = document.getElementById('oandaBrokerCard');
    if (!card) return;

    var connected = _isRatesConnected();
    var cfg = _ratesCfg();
    var isDemo = cfg.demo !== false;

    if (connected) {
      var nav = _acctCache ? '$' + _acctCache.nav.toFixed(2) : '—';
      var pl  = _acctCache ? (_acctCache.unrealizedPL >= 0 ? '+' : '') +
                             '$' + _acctCache.unrealizedPL.toFixed(2) : '—';
      var plColor = _acctCache ? (_acctCache.unrealizedPL >= 0 ? '#00e676' : '#ff5252') : '#aaa';

      card.innerHTML =
        '<div class="ee-broker-header">' +
          '<span class="ee-broker-icon">🏦</span>' +
          '<span class="ee-broker-name">OANDA BROKER</span>' +
          '<span class="ee-broker-status ee-status-connected">' +
            (isDemo ? 'DEMO ✓' : 'LIVE ✓') +
          '</span>' +
        '</div>' +
        '<div class="ee-broker-body" style="padding:6px 10px;font-size:11px">' +
          '<div style="display:flex;gap:16px;margin-bottom:4px">' +
            '<span><span style="color:#aaa">NAV</span> <b style="color:#eee">' + nav + '</b></span>' +
            '<span><span style="color:#aaa">P/L</span> <b style="color:' + plColor + '">' + pl + '</b></span>' +
          '</div>' +
          '<div style="color:#888;font-size:10px;margin-bottom:4px">' +
            Object.keys(OANDA_INSTRUMENTS).length + ' instruments covered · ' +
            'Forex · Metals · Energy · Indices' +
          '</div>' +
          '<div style="display:flex;gap:6px">' +
            '<button onclick="OANDABroker._refreshAccount()" ' +
              'style="background:none;border:1px solid #444;color:#aaa;padding:2px 8px;' +
              'border-radius:3px;font-size:10px;cursor:pointer">↻ Refresh</button>' +
            '<button onclick="OANDABroker._showPositions()" ' +
              'style="background:none;border:1px solid #444;color:#aaa;padding:2px 8px;' +
              'border-radius:3px;font-size:10px;cursor:pointer">Positions</button>' +
          '</div>' +
        '</div>';

      // Refresh account info on first render
      if (!_acctCache) OANDABroker._refreshAccount();

    } else {
      card.innerHTML =
        '<div class="ee-broker-header">' +
          '<span class="ee-broker-icon">🏦</span>' +
          '<span class="ee-broker-name">OANDA BROKER</span>' +
          '<span class="ee-broker-status ee-status-disconnected">DISCONNECTED</span>' +
        '</div>' +
        '<div class="ee-broker-body" style="padding:8px 10px;font-size:11px;color:#888">' +
          'Connect the OANDA Rates card above first to enable trading.' +
        '</div>';
    }
  }

  /* ── Public API ─────────────────────────────────────────────────────────── */
  var OANDABroker = {

    name:    'OANDA',
    version: 1,

    isConnected: function () { return _isRatesConnected(); },
    isDemo:      function () { return _ratesCfg().demo !== false; },

    /** Does OANDA cover this asset? */
    covers: function (asset) {
      if (!asset) return false;
      return Object.prototype.hasOwnProperty.call(
        OANDA_INSTRUMENTS, String(asset).toUpperCase().replace('/', '').replace('_', '')
      );
    },

    /** Instrument info for an asset */
    instrumentInfo: function (asset) {
      return OANDA_INSTRUMENTS[String(asset).toUpperCase().replace('/', '').replace('_', '')] || null;
    },

    /** All covered assets */
    assets: function () { return Object.keys(OANDA_INSTRUMENTS); },

    /** Get live mid price for an instrument (via OANDA_RATES if available, else API) */
    getPrice: async function (asset) {
      var info = OANDABroker.instrumentInfo(asset);
      if (!info) return null;
      // Try OANDA_RATES first (already polling)
      if (_isRatesConnected()) {
        var rate = OANDA_RATES.getRate(info.instrument);
        if (rate && rate.mid > 0) return rate.mid;
      }
      // Fallback: fetch from pricing API
      try {
        var acctId = _accountId();
        if (!acctId) return null;
        var d = await _api('/v3/accounts/' + acctId + '/pricing?instruments=' + info.instrument);
        var p = d.prices && d.prices[0];
        if (!p) return null;
        var bid = parseFloat(p.bids[0].price);
        var ask = parseFloat(p.asks[0].price);
        return (bid + ask) / 2;
      } catch (e) {
        return null;
      }
    },

    /**
     * Place a market order on OANDA.
     * @param {string} asset      EE asset name (e.g. 'EUR', 'XAU', 'WTI', 'SPX')
     * @param {number} sizeUsd    Dollar notional to trade
     * @param {string} side       'buy' | 'sell'  (EE LONG → buy, SHORT → sell)
     * @param {object} opts       { stopLoss, takeProfit } in price terms (optional)
     */
    placeOrder: async function (asset, sizeUsd, side, opts) {
      if (!_isRatesConnected()) throw new Error('OANDA not connected');
      var info = OANDABroker.instrumentInfo(asset);
      if (!info) throw new Error('OANDA does not cover: ' + asset);

      var acctId = _accountId();
      // Get current price for unit sizing
      var price = await OANDABroker.getPrice(asset);

      // Calculate units, applying inverse flag
      var units = _calcUnits(info, sizeUsd, price);

      // Apply inverse: LONG JPY = short USD/JPY = negative units
      var effectiveSide = side.toLowerCase();
      if (info.inverse) {
        effectiveSide = (effectiveSide === 'buy') ? 'sell' : 'buy';
      }
      var signedUnits = String((effectiveSide === 'buy' ? 1 : -1) * units);

      var order = {
        order: {
          type:          'MARKET',
          instrument:    info.instrument,
          units:         signedUnits,
          timeInForce:   'FOK',
          positionFill:  'DEFAULT'
        }
      };

      // Optional stop-loss and take-profit — validate direction before attaching
      if (opts) {
        if (opts.stopLoss && opts.stopLoss > 0) {
          /* SL must be below entry for LONG, above entry for SHORT.
             If SL is on the wrong side, OANDA would trigger it immediately.
             Warn and skip the SL rather than opening a position that auto-closes. */
          var slValid = price ? (effectiveSide === 'buy'  ? opts.stopLoss < price
                                                          : opts.stopLoss > price)
                              : true;   // no price available — trust EE's calculation
          if (slValid) {
            order.order.stopLossOnFill = { price: String(opts.stopLoss.toFixed(5)) };
          } else {
            console.warn('[OANDA] ⚠ Stop-loss ' + opts.stopLoss + ' is on wrong side of entry ' +
              price + ' for ' + effectiveSide.toUpperCase() + ' — SL omitted to prevent immediate trigger');
          }
        }
        if (opts.takeProfit && opts.takeProfit > 0) {
          order.order.takeProfitOnFill = { price: String(opts.takeProfit.toFixed(5)) };
        }
      }

      console.log('[OANDA] Placing order:', info.instrument, signedUnits + ' units', '@ ~$' + (price || '?'));
      var resp = await _api('/v3/accounts/' + acctId + '/orders', {
        method: 'POST',
        body: JSON.stringify(order)
      });

      /* OANDA v20 can return HTTP 200 with an embedded rejection.
         Validate that the order was actually accepted before returning.
         Success paths: orderFillTransaction (market filled immediately) or
         orderCreateTransaction (order created, pending fill confirmation).
         Rejection paths: orderCancelTransaction, errorMessage field.         */
      if (resp) {
        if (resp.errorMessage) {
          throw new Error('OANDA order rejected: ' + resp.errorMessage +
            (resp.errorCode ? ' (' + resp.errorCode + ')' : ''));
        }
        if (resp.orderCancelTransaction && !resp.orderFillTransaction) {
          var cancelReason = resp.orderCancelTransaction.reason || 'unknown';
          throw new Error('OANDA order cancelled at placement: ' + cancelReason);
        }
        var txId = (resp.orderFillTransaction && resp.orderFillTransaction.id) ||
                   (resp.orderCreateTransaction && resp.orderCreateTransaction.id);
        if (!txId) {
          console.warn('[OANDA] Order response missing transaction ID — response:', JSON.stringify(resp).slice(0, 200));
        }
      }

      return resp;
    },

    /**
     * Close an entire open position.
     * @param {string} asset   EE asset name or OANDA instrument (e.g. 'XAU', 'EUR_USD')
     */
    closePosition: async function (asset) {
      if (!_isRatesConnected()) throw new Error('OANDA not connected');
      var info = OANDABroker.instrumentInfo(asset);
      var instrument = info ? info.instrument : asset.toUpperCase();
      var acctId = _accountId();
      return _api('/v3/accounts/' + acctId + '/positions/' + instrument + '/close', {
        method: 'PUT',
        body: JSON.stringify({ longUnits: 'ALL', shortUnits: 'ALL' })
      });
    },

    /** Get all open positions */
    getPositions: async function () {
      if (!_isRatesConnected()) return [];
      var acctId = _accountId();
      var d = await _api('/v3/accounts/' + acctId + '/openPositions');
      return d.positions || [];
    },

    /** Get account summary: NAV, balance, unrealized P&L */
    getAccount: async function () {
      if (!_isRatesConnected()) return null;
      var now = Date.now();
      if (_acctCache && (now - _acctFetchTs) < ACCT_TTL_MS) return _acctCache;
      var acctId = _accountId();
      var d = await _api('/v3/accounts/' + acctId + '/summary');
      var a = d.account;
      _acctCache = {
        nav:          parseFloat(a.NAV),
        balance:      parseFloat(a.balance),
        unrealizedPL: parseFloat(a.unrealizedPL),
        openTrades:   parseInt(a.openTradeCount, 10),
        currency:     a.currency
      };
      _acctFetchTs = now;
      return _acctCache;
    },

    /** Refresh account info and re-render card */
    _refreshAccount: async function () {
      try {
        await OANDABroker.getAccount();
        _acctFetchTs = 0;  // force next getAccount() to re-fetch
        _acctCache   = null;
        await OANDABroker.getAccount();
        _renderCard();
      } catch (e) {
        console.warn('[OANDA] Account refresh failed:', e.message);
      }
    },

    /** Show open positions in the console log */
    _showPositions: async function () {
      try {
        var positions = await OANDABroker.getPositions();
        if (!positions.length) {
          console.log('[OANDA] No open positions');
          return;
        }
        positions.forEach(function (p) {
          var side = parseFloat(p.long.units) > 0 ? 'LONG' : 'SHORT';
          var pl   = parseFloat(p.unrealizedPL);
          console.log('[OANDA POSITION]', p.instrument, side,
            'P/L: ' + (pl >= 0 ? '+' : '') + pl.toFixed(2));
        });
      } catch (e) {
        console.warn('[OANDA] Positions fetch failed:', e.message);
      }
    },

    /** Status summary for debugging */
    status: function () {
      var cfg = _ratesCfg();
      return {
        connected:    _isRatesConnected(),
        demo:         cfg.demo !== false,
        accountId:    cfg.accountId ? cfg.accountId.slice(0, 8) + '…' : '',
        nav:          _acctCache ? _acctCache.nav : null,
        unrealizedPL: _acctCache ? _acctCache.unrealizedPL : null,
        instruments:  Object.keys(OANDA_INSTRUMENTS).length
      };
    },

    renderCard: _renderCard
  };

  window.OANDABroker = OANDABroker;

  // Render card once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _renderCard);
  } else {
    setTimeout(_renderCard, 200);
  }

  // Also re-render when OANDA_RATES connects/disconnects
  // Poll every 5s to detect connection state changes
  setInterval(function () {
    var connected = _isRatesConnected();
    var card = document.getElementById('oandaBrokerCard');
    if (!card) return;
    var wasConnected = card.querySelector('.ee-status-connected') !== null;
    if (connected !== wasConnected) _renderCard();
  }, 5000);

})();
