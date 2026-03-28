/* ═══════════════════════════════════════════════════════════════════════════
   ALPACA-BROKER v2 — Alpaca Markets adapter (paper + live)
   ═══════════════════════════════════════════════════════════════════════════
   Handles US stocks and ETFs not available on Hyperliquid.

   Paper trading URL : https://paper-api.alpaca.markets
   Live trading URL  : https://api.alpaca.markets
   Data API URL      : https://data.alpaca.markets

   Usage:
     AlpacaBroker.connect(apiKey, apiSecret, paperMode)
     AlpacaBroker.covers('NVDA')         → true/false
     AlpacaBroker.getPrice('NVDA')       → Promise<price>
     AlpacaBroker.placeOrder(sym, qty, 'buy')
     AlpacaBroker.closePosition('NVDA')
     AlpacaBroker.status()               → connection summary

   Exposed as window.AlpacaBroker
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var PAPER_BASE = 'https://paper-api.alpaca.markets';
  var LIVE_BASE  = 'https://api.alpaca.markets';
  var DATA_BASE  = 'https://data.alpaca.markets';
  var STORE_KEY  = 'alpaca_cfg_v1';

  /* ── Assets routed to Alpaca ─────────────────────────────────────────────
     These are US stocks/ETFs NOT available on Hyperliquid spot or perp.
     HLFeed.covers() is checked first — anything passing that stays on HL.
     Alpaca supports fractional shares, so qty can be < 1.               */
  var ALPACA_ASSETS = {
    /* ── Defense / Aerospace ─────────────────────────────────────── */
    'NVDA':  { sector: 'semis',   name: 'Nvidia' },
    'RTX':   { sector: 'defense', name: 'RTX Corp' },
    'NOC':   { sector: 'defense', name: 'Northrop Grumman' },
    'LMT':   { sector: 'defense', name: 'Lockheed Martin' },
    'BA':    { sector: 'defense', name: 'Boeing' },
    'GE':    { sector: 'defense', name: 'GE Aerospace' },
    'HII':   { sector: 'defense', name: 'Huntington Ingalls' },
    'LDOS':  { sector: 'defense', name: 'Leidos Holdings' },
    /* ── Technology ──────────────────────────────────────────────── */
    'COIN':  { sector: 'crypto',  name: 'Coinbase' },
    'ARM':   { sector: 'semis',   name: 'ARM Holdings' },
    'PLTR':  { sector: 'tech',    name: 'Palantir' },
    'MSTR':  { sector: 'crypto',  name: 'MicroStrategy' },
    'TSM':   { sector: 'semis',   name: 'TSMC' },
    'ASML':  { sector: 'semis',   name: 'ASML' },
    'AVGO':  { sector: 'semis',   name: 'Broadcom' },
    'ORCL':  { sector: 'tech',    name: 'Oracle' },
    'MU':    { sector: 'semis',   name: 'Micron' },
    'AMD':   { sector: 'semis',   name: 'AMD' },
    'INTC':  { sector: 'semis',   name: 'Intel' },
    'CRM':   { sector: 'tech',    name: 'Salesforce' },
    /* ── Energy ──────────────────────────────────────────────────── */
    'XOM':   { sector: 'energy',  name: 'ExxonMobil' },
    'CVX':   { sector: 'energy',  name: 'Chevron' },
    'XLE':   { sector: 'energy',  name: 'Energy Select ETF' },
    'OXY':   { sector: 'energy',  name: 'Occidental Petroleum' },
    'COP':   { sector: 'energy',  name: 'ConocoPhillips' },
    /* ── Finance ─────────────────────────────────────────────────── */
    'JPM':   { sector: 'finance', name: 'JPMorgan' },
    'GS':    { sector: 'finance', name: 'Goldman Sachs' },
    'BAC':   { sector: 'finance', name: 'Bank of America' },
    'MS':    { sector: 'finance', name: 'Morgan Stanley' },
    'V':     { sector: 'finance', name: 'Visa' },
    /* ── ETFs ────────────────────────────────────────────────────── */
    'TLT':   { sector: 'bonds',   name: 'iShares 20Y Treasury' },
    'VXX':   { sector: 'vol',     name: 'iPath VIX ETF' },
    'XAR':   { sector: 'defense', name: 'SPDR Aerospace & Defense' },
    'GDX':   { sector: 'mining',  name: 'VanEck Gold Miners' },
    'SMH':   { sector: 'semis',   name: 'VanEck Semiconductors' },
    'SOXX':  { sector: 'semis',   name: 'iShares Semiconductor ETF' },
    'FXI':   { sector: 'china',   name: 'iShares China ETF' },
    'EEM':   { sector: 'em',      name: 'iShares Emerging Markets' },
    'IWM':   { sector: 'equity',  name: 'Russell 2000 ETF' },
    'DIA':   { sector: 'equity',  name: 'Dow Jones ETF' },
    /* ── Commodity / Thematic ETFs (no-venue signals) ────────────────── */
    'WEAT':  { sector: 'agri',    name: 'Teucrium Wheat Fund' },
    'WHT':   { sector: 'agri',    name: 'Wheat ETF (WEAT alias)' },
    'CORN':  { sector: 'agri',    name: 'Teucrium Corn Fund' },
    'INDA':  { sector: 'em',      name: 'iShares India ETF' },
    'LIT':   { sector: 'energy',  name: 'Global X Lithium ETF' },
    'XME':   { sector: 'mining',  name: 'SPDR Metals & Mining ETF' },
    /* GLD and SLV intentionally NOT here — routed to OANDA as XAU_USD / XAG_USD
       CFDs (leverage + short/long both available). Alpaca only offers long-only ETFs. */
    /* Note: SPY, QQQ, AAPL, TSLA, META, MSFT, AMZN, GOOGL, HOOD
             still on HL spot tokens → HL handles those when HLBroker funded. */
    /* ── Crypto — routed here when HLBroker is unavailable ──────────── */
    'BTC':   { sector: 'crypto', name: 'Bitcoin',       alpacaSym: 'BTCUSD' },
    'ETH':   { sector: 'crypto', name: 'Ethereum',      alpacaSym: 'ETHUSD' },
    'SOL':   { sector: 'crypto', name: 'Solana',        alpacaSym: 'SOLUSD' },
    'XRP':   { sector: 'crypto', name: 'XRP',           alpacaSym: 'XRPUSD' },
    'DOGE':  { sector: 'crypto', name: 'Dogecoin',      alpacaSym: 'DOGEUSD' },
    'LTC':   { sector: 'crypto', name: 'Litecoin',      alpacaSym: 'LTCUSD' },
    'AVAX':  { sector: 'crypto', name: 'Avalanche',     alpacaSym: 'AVAXUSD' },
    'LINK':  { sector: 'crypto', name: 'Chainlink',     alpacaSym: 'LINKUSD' },
    'BCH':   { sector: 'crypto', name: 'Bitcoin Cash',  alpacaSym: 'BCHUSD' },
    'UNI':   { sector: 'crypto', name: 'Uniswap',       alpacaSym: 'UNIUSD' },
    'AAVE':  { sector: 'crypto', name: 'Aave',          alpacaSym: 'AAVEUSD' },
    'DOT':   { sector: 'crypto', name: 'Polkadot',      alpacaSym: 'DOTUSD' },
    'ADA':   { sector: 'crypto', name: 'Cardano',       alpacaSym: 'ADAUSD' },
    'BNB':   { sector: 'crypto', name: 'BNB',           alpacaSym: 'BNBUSD' },
    'SHIB':  { sector: 'crypto', name: 'Shiba Inu',     alpacaSym: 'SHIBUSD' }
  };

  /* ── Config state ────────────────────────────────────────────────────── */
  var _cfg = {
    apiKey:    '',
    apiSecret: '',
    paper:     true,
    connected: false,
    equity:    null,
    buyingPow: null
  };

  function _baseUrl() { return _cfg.paper ? PAPER_BASE : LIVE_BASE; }

  /* Convert internal asset name to Alpaca symbol (crypto needs USD suffix) */
  function _toAlpacaSymbol(asset) {
    var info = ALPACA_ASSETS[String(asset).toUpperCase()];
    return (info && info.alpacaSym) ? info.alpacaSym : String(asset).toUpperCase();
  }

  /* Crypto orders must use 'gtc' (markets open 24/7); stocks use 'day' */
  function _timeInForce(asset) {
    var info = ALPACA_ASSETS[String(asset).toUpperCase()];
    return (info && info.sector === 'crypto') ? 'gtc' : 'day';
  }

  function _headers() {
    return {
      'APCA-API-KEY-ID':     _cfg.apiKey,
      'APCA-API-SECRET-KEY': _cfg.apiSecret,
      'Content-Type':        'application/json'
    };
  }

  /* Generic fetch wrapper — throws on non-2xx.
     Detects 401/403 immediately and marks broker disconnected — no need to wait
     for the 5-min health-check poll to catch an expired or revoked key.         */
  async function _api(path, opts) {
    var url = _baseUrl() + path;
    var res = await fetch(url, Object.assign({ headers: _headers() }, opts || {}));
    if (!res.ok) {
      var txt = await res.text();
      if (res.status === 401 || res.status === 403) {
        _cfg.connected = false;
        console.warn('[Alpaca] ⚠ Auth failure (' + res.status + ') — broker marked disconnected. ' +
          'Check API key / secret and re-connect.', txt.substring(0, 100));
        try { if (typeof renderCard === 'function') renderCard(); } catch(e) {}
      }
      throw new Error('Alpaca ' + res.status + ': ' + txt.substring(0, 200));
    }
    return res.json();
  }

  function _loadCfg() {
    try {
      /* Credentials are stored in sessionStorage (not localStorage) so they are not
         accessible after the tab/browser closes — reduces XSS credential exposure.
         Migration: if sessionStorage is empty, check localStorage once and migrate,
         then delete the localStorage entry.                                         */
      var raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) {
        raw = localStorage.getItem(STORE_KEY);   // one-time migration from old storage
        if (raw) {
          sessionStorage.setItem(STORE_KEY, raw);
          localStorage.removeItem(STORE_KEY);    // remove plaintext credentials from localStorage
        }
      }
      var saved = JSON.parse(raw || '{}');
      if (saved.apiKey)                _cfg.apiKey    = saved.apiKey;
      if (saved.apiSecret)             _cfg.apiSecret = saved.apiSecret;
      if (saved.paper !== undefined)   _cfg.paper     = saved.paper;
      // Never persist connected=true — always re-verify on page load
    } catch (e) {}
  }

  function _saveCfg() {
    /* Store in sessionStorage only — credentials expire when the tab closes. */
    sessionStorage.setItem(STORE_KEY, JSON.stringify({
      apiKey:    _cfg.apiKey,
      apiSecret: _cfg.apiSecret,
      paper:     _cfg.paper
    }));
  }

  /* ── Render the Alpaca broker card in the dashboard ─────────────────── */
  function renderCard() {
    var card = document.getElementById('alpacaBrokerCard');
    if (!card) return;

    if (_cfg.connected) {
      card.innerHTML =
        '<div class="ee-broker-name" style="color:#00ff88">ALPACA ' +
          (_cfg.paper ? '<span style="color:#ffaa00;font-size:8px">PAPER</span>' :
                        '<span style="color:#ff4444;font-size:8px">LIVE</span>') +
        '</div>' +
        '<div class="ee-broker-assets">US stocks &amp; ETFs &middot; ' +
          Object.keys(ALPACA_ASSETS).length + ' assets covered</div>' +
        '<div style="font-size:8px;color:var(--dim);margin-bottom:4px">' +
          'Equity: <b style="color:var(--bright)">$' + (_cfg.equity !== null && _cfg.equity !== undefined ? _cfg.equity.toFixed(2) : '—') + '</b>' +
          ' &nbsp; Buying power: <b style="color:var(--bright)">$' +
          (_cfg.buyingPow !== null && _cfg.buyingPow !== undefined ? _cfg.buyingPow.toFixed(2) : '—') + '</b>' +
        '</div>' +
        '<button onclick="AlpacaBroker.disconnect();AlpacaBroker.renderCard()" ' +
          'style="font-size:8px;width:100%;padding:3px 0;border:1px solid #ff4444;' +
          'background:transparent;color:#ff4444;cursor:pointer;font-family:inherit;border-radius:2px">' +
          'Disconnect' +
        '</button>';
    } else {
      var hasKeys = _cfg.apiKey && _cfg.apiSecret;
      card.innerHTML =
        '<div class="ee-broker-name">Alpaca</div>' +
        '<div class="ee-broker-assets">US stocks &amp; ETFs &middot; Commission-free</div>' +
        '<div style="margin-bottom:4px">' +
          '<input id="alpacaKey" type="text" placeholder="API Key" value="' + (_cfg.apiKey || '') + '" ' +
            'style="width:100%;box-sizing:border-box;font-size:8px;padding:2px 4px;' +
            'background:var(--bg);border:1px solid var(--border);color:var(--bright);' +
            'font-family:inherit;border-radius:2px;margin-bottom:2px">' +
          '<input id="alpacaSecret" type="password" placeholder="API Secret" value="' + (_cfg.apiSecret || '') + '" ' +
            'style="width:100%;box-sizing:border-box;font-size:8px;padding:2px 4px;' +
            'background:var(--bg);border:1px solid var(--border);color:var(--bright);' +
            'font-family:inherit;border-radius:2px;margin-bottom:2px">' +
          '<label style="font-size:7px;color:var(--dim);cursor:pointer">' +
            '<input id="alpacaPaper" type="checkbox" ' + (_cfg.paper ? 'checked' : '') + ' ' +
              'style="margin-right:3px"> Paper trading mode' +
          '</label>' +
        '</div>' +
        '<button onclick="AlpacaBroker._connectFromUI()" ' +
          'style="font-size:8px;width:100%;padding:3px 0;border:1px solid var(--accent);' +
          'background:transparent;color:var(--accent);cursor:pointer;font-family:inherit;border-radius:2px">' +
          (hasKeys ? 'Reconnect' : 'Connect') +
        '</button>' +
        '<div id="alpacaStatus" style="font-size:7px;color:var(--dim);margin-top:2px;min-height:10px"></div>';
    }
  }

  /* ── Fill confirmation loop ──────────────────────────────────────────
     Polls GET /v2/orders/{orderId} every 3s after a placeOrder() call.
     • filled              → onFill(fillPrice, order)
     • cancelled/expired/rejected → onFail(reason)
     • timeout (30s)       → cancel order → onFail('timeout')
     Network errors keep retrying until the 30s wall clock expires.     */
  function _pollOrderFill(orderId, onFill, onFail) {
    var POLL_MS    = 3000;
    var TIMEOUT_MS = 30000;
    var _started   = Date.now();

    function _check() {
      if (Date.now() - _started >= TIMEOUT_MS) {
        // Cancel the dangling order, then surface the failure to EE
        fetch(_baseUrl() + '/v2/orders/' + orderId, { method: 'DELETE', headers: _headers() })
          .catch(function () {});
        onFail('timeout');
        return;
      }
      fetch(_baseUrl() + '/v2/orders/' + orderId, { headers: _headers() })
        .then(function (res) {
          if (!res.ok) throw new Error(res.status);
          return res.json();
        })
        .then(function (order) {
          var st = (order.status || '').toLowerCase();
          if (st === 'filled') {
            onFill(parseFloat(order.filled_avg_price || 0), order);
          } else if (st === 'cancelled' || st === 'expired' || st === 'rejected') {
            onFail(st);
          } else {
            // pending_new, new, accepted, partially_filled — keep polling
            setTimeout(_check, POLL_MS);
          }
        })
        .catch(function () {
          // Transient network error — keep polling until timeout
          setTimeout(_check, POLL_MS);
        });
    }

    setTimeout(_check, POLL_MS);
  }

  /* ── Public API ──────────────────────────────────────────────────────── */
  var AlpacaBroker = {
    name:    'ALPACA',
    version: 1,

    isConnected: function () { return _cfg.connected; },
    isPaper:     function () { return _cfg.paper; },

    /* Does this broker cover this asset? (checked after HLFeed.covers() fails) */
    covers: function (asset) {
      return Object.prototype.hasOwnProperty.call(
        ALPACA_ASSETS, String(asset).toUpperCase()
      );
    },

    /* Asset metadata */
    assetInfo: function (asset) {
      return ALPACA_ASSETS[String(asset).toUpperCase()] || null;
    },

    /* Full asset list */
    assets: function () { return Object.keys(ALPACA_ASSETS); },

    /* Connect with credentials */
    connect: async function (apiKey, apiSecret, paper) {
      _cfg.apiKey    = apiKey;
      _cfg.apiSecret = apiSecret;
      _cfg.paper     = paper !== false;
      try {
        var acct       = await _api('/v2/account');
        _cfg.connected   = true;
        _cfg.equity      = parseFloat(acct.equity);
        _cfg.buyingPow   = parseFloat(acct.buying_power);
        _cfg.connectedAt = Date.now();
        _saveCfg();
        renderCard();
        return { ok: true, account: acct };
      } catch (e) {
        _cfg.connected = false;
        return { ok: false, error: e.message };
      }
    },

    /* Called by the connect button in the card */
    _connectFromUI: async function () {
      var keyEl    = document.getElementById('alpacaKey');
      var secEl    = document.getElementById('alpacaSecret');
      var paperEl  = document.getElementById('alpacaPaper');
      var statusEl = document.getElementById('alpacaStatus');
      if (!keyEl || !secEl) return;
      if (statusEl) statusEl.textContent = 'Connecting…';
      var result = await AlpacaBroker.connect(
        keyEl.value.trim(),
        secEl.value.trim(),
        paperEl ? paperEl.checked : true
      );
      if (!result.ok && statusEl) {
        statusEl.style.color = '#ff4444';
        statusEl.textContent = result.error || 'Connection failed';
      }
    },

    disconnect: function () {
      _cfg.connected = false;
      _saveCfg();
    },

    renderCard: renderCard,

    /* Refresh account info from Alpaca */
    getAccount: async function () {
      var acct   = await _api('/v2/account');
      _cfg.equity    = parseFloat(acct.equity);
      _cfg.buyingPow = parseFloat(acct.buying_power);
      return acct;
    },

    /* Latest mid price — tries Alpaca data API, returns null on failure */
    getPrice: async function (symbol) {
      try {
        var url = DATA_BASE + '/v2/stocks/' + symbol.toUpperCase() + '/quotes/latest';
        var res = await fetch(url, { headers: _headers() });
        if (!res.ok) return null;
        var data = await res.json();
        var q = data.quote || (data.quotes && data.quotes[symbol.toUpperCase()]);
        if (!q) return null;
        var ap  = parseFloat(q.ap  || q.ask_price || 0);
        var bp  = parseFloat(q.bp  || q.bid_price || 0);
        var mid = (ap + bp) / 2;
        return mid > 0 ? mid : null;
      } catch (e) {
        return null;
      }
    },

    /* Place a market order
       side: 'buy' | 'sell'
       qty:  shares (fractional OK)
       opts.notional: use dollar amount instead of shares */
    placeOrder: async function (symbol, qty, side, opts) {
      var body = {
        symbol:        _toAlpacaSymbol(symbol),
        side:          side,
        type:          'market',
        time_in_force: _timeInForce(symbol)
      };
      if (opts && opts.notional) {
        body.notional = String(parseFloat(opts.notional).toFixed(2));
      } else {
        body.qty = String(Math.abs(parseFloat(qty)));
      }
      return _api('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
    },

    /* Place a market order and confirm fill via polling.
       onFill(fillPrice, order) called when status === 'filled'.
       onFail(reason)           called on cancel / reject / timeout.
       Returns the initial order object (id available immediately).      */
    placeOrderWithConfirmation: async function (symbol, qty, side, opts, onFill, onFail) {
      var body = {
        symbol:        _toAlpacaSymbol(symbol),
        side:          side,
        type:          'market',
        time_in_force: _timeInForce(symbol)
      };
      if (opts && opts.notional) {
        body.notional = String(parseFloat(opts.notional).toFixed(2));
      } else {
        body.qty = String(Math.abs(parseFloat(qty)));
      }
      var order = await _api('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
      _pollOrderFill(order.id, onFill, onFail);
      return order;
    },

    /* Close entire position */
    closePosition: async function (symbol) {
      var url = _baseUrl() + '/v2/positions/' + _toAlpacaSymbol(symbol);
      var res = await fetch(url, { method: 'DELETE', headers: _headers() });
      if (!res.ok && res.status !== 404) throw new Error('Alpaca close ' + res.status);
      return res.status === 404 ? null : res.json();
    },

    /* All open Alpaca positions */
    getPositions: async function () {
      return _api('/v2/positions');
    },

    /* Cancel an Alpaca order by order ID */
    cancelOrder: async function (orderId) {
      var url = _baseUrl() + '/v2/orders/' + orderId;
      await fetch(url, { method: 'DELETE', headers: _headers() });
    },

    /* Live check: is this symbol actively tradeable? */
    isAssetTradeable: async function (symbol) {
      try {
        var asset = await _api('/v2/assets/' + symbol.toUpperCase());
        return !!(asset.tradable && asset.status === 'active');
      } catch (e) {
        return false;
      }
    },

    /* Status summary for UI + standard agent interface (lastPoll, signals) */
    status: function () {
      return {
        lastPoll:   _cfg.connected ? (_cfg.connectedAt || 0) : 0,
        connected:  _cfg.connected,
        paper:      _cfg.paper,
        equity:     _cfg.equity,
        buyingPow:  _cfg.buyingPow,
        apiKeyHint: _cfg.apiKey ? _cfg.apiKey.substring(0, 6) + '…' : '',
        assetCount: Object.keys(ALPACA_ASSETS).length,
        note: _cfg.connected
          ? (_cfg.paper ? 'Paper' : 'Live') + ' · equity $' +
            (_cfg.equity !== null && _cfg.equity !== undefined ? _cfg.equity.toFixed(0) : '—') + ' · ' +
            Object.keys(ALPACA_ASSETS).length + ' assets'
          : 'Not connected'
      };
    },
    signals: function () { return []; },   /* Alpaca is execution-only, no trading signals */

    /* Resume a fill poll for an order that was placed before a page reload.
       Call this on startup for any trade stuck at broker_status='PENDING_FILL'. */
    resumeOrderPoll: function (orderId, onFill, onFail) {
      if (!orderId) return;
      _pollOrderFill(orderId, onFill, onFail);
    }
  };

  _loadCfg();
  window.AlpacaBroker = AlpacaBroker;

  // Auto-reconnect on startup if credentials are saved
  if (_cfg.apiKey && _cfg.apiSecret) {
    setTimeout(function () {
      AlpacaBroker.connect(_cfg.apiKey, _cfg.apiSecret, _cfg.paper)
        .catch(function (e) { console.warn('[Alpaca] auto-reconnect failed:', e.message); });
    }, 4000);  // 4s delay — let DOM settle before making auth requests
  }

  // Periodic auth health-check: detect expired/revoked API keys every 5 min
  setInterval(function () {
    if (!_cfg.connected || !_cfg.apiKey) return;
    AlpacaBroker.getAccount()
      .catch(function (e) {
        var msg = e && e.message ? e.message : '';
        if (msg.indexOf('403') !== -1 || msg.indexOf('401') !== -1 || msg.toLowerCase().indexOf('forbidden') !== -1) {
          _cfg.connected = false;
          console.warn('[Alpaca] Auth check failed — API key may be expired or revoked:', msg);
          renderCard();
        }
      });
  }, 5 * 60 * 1000);

  // Render card once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderCard);
  } else {
    setTimeout(renderCard, 0);
  }

})();
