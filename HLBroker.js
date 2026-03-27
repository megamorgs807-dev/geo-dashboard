/* ═══════════════════════════════════════════════════════════════════════════
   HL-BROKER v1 — Hyperliquid perpetuals adapter (testnet + mainnet)
   ═══════════════════════════════════════════════════════════════════════════
   Routes crypto perp orders through the local backend (localhost:8765/api/hl/).
   The backend holds the private key and handles EIP-712 signing via the
   official hyperliquid-python-sdk.

   Covers all major HL perp coins including everything Alpaca handles as
   crypto fallback — when HLBroker is connected it takes priority.

   Usage:
     HLBroker.connect(wallet, privateKey, testnet)
     HLBroker.covers('BTC')          → true/false
     HLBroker.placeOrder('BTC', notional, 'buy', {leverage: 5})
     HLBroker.closePosition('BTC')
     HLBroker.getPositions()         → Promise<positions[]>
     HLBroker.status()               → connection summary
     HLBroker.renderCard()

   Exposed as window.HLBroker
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var BACKEND = 'http://localhost:8765';
  var STORE_KEY = 'hl_broker_ui_v1';

  /* ── HL perp assets — all coins available as perpetuals on Hyperliquid ── */
  var HL_ASSETS = {
    /* ── Major crypto ────────────────────────────────────────────────── */
    'BTC':       { name: 'Bitcoin' },
    'ETH':       { name: 'Ethereum' },
    'SOL':       { name: 'Solana' },
    'XRP':       { name: 'XRP' },
    'DOGE':      { name: 'Dogecoin' },
    'ADA':       { name: 'Cardano' },
    'AVAX':      { name: 'Avalanche' },
    'DOT':       { name: 'Polkadot' },
    'LINK':      { name: 'Chainlink' },
    'LTC':       { name: 'Litecoin' },
    'BCH':       { name: 'Bitcoin Cash' },
    'UNI':       { name: 'Uniswap' },
    'AAVE':      { name: 'Aave' },
    'BNB':       { name: 'BNB' },
    /* ── Layer 1 / Layer 2 ───────────────────────────────────────────── */
    'ATOM':      { name: 'Cosmos' },
    'NEAR':      { name: 'NEAR Protocol' },
    'SUI':       { name: 'Sui' },
    'APT':       { name: 'Aptos' },
    'ARB':       { name: 'Arbitrum' },
    'OP':        { name: 'Optimism' },
    'TRX':       { name: 'TRON' },
    'TON':       { name: 'Toncoin' },
    'ICP':       { name: 'Internet Computer' },
    'SEI':       { name: 'Sei' },
    /* ── DeFi ────────────────────────────────────────────────────────── */
    'MKR':       { name: 'MakerDAO' },
    'SNX':       { name: 'Synthetix' },
    'CRV':       { name: 'Curve' },
    'GMX':       { name: 'GMX' },
    'COMP':      { name: 'Compound' },
    'INJ':       { name: 'Injective' },
    'RUNE':      { name: 'THORChain' },
    /* ── Memes / trending ────────────────────────────────────────────── */
    'WIF':       { name: 'dogwifhat' },
    'PEPE':      { name: 'Pepe' },
    'BONK':      { name: 'Bonk' },
    'TRUMP':     { name: 'TRUMP' },
    'WLD':       { name: 'Worldcoin' },
    'HYPE':      { name: 'Hyperliquid' },
    /* ── AI / tech ───────────────────────────────────────────────────── */
    'TAO':       { name: 'Bittensor' },
    'RENDER':    { name: 'Render' },
    'ONDO':      { name: 'Ondo Finance' },
    'ENA':       { name: 'Ethena' },
    'EIGEN':     { name: 'EigenLayer' },
    'TIA':       { name: 'Celestia' },
    'PYTH':      { name: 'Pyth Network' },
    'JUP':       { name: 'Jupiter' },
    /* ── Equity tokens (HL spot) ─────────────────────────────────────── */
    'SPY':       { name: 'S&P 500 token' },
    'QQQ':       { name: 'Nasdaq token' },
    'AAPL':      { name: 'Apple token' },
    'TSLA':      { name: 'Tesla token' },
    'META':      { name: 'Meta token' },
    'MSFT':      { name: 'Microsoft token' },
    'AMZN':      { name: 'Amazon token' },
    'GOOGL':     { name: 'Google token' },
    // GLD and SLV removed — no mid price on HL testnet or mainnet perps
  };

  /* ── State ───────────────────────────────────────────────────────────────── */
  var _cfg = {
    wallet:    '',
    testnet:   true,
    connected: false,
    equity:    null,
    available: null,
    unrealised: null
  };

  function _loadCfg() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (saved.wallet)            _cfg.wallet  = saved.wallet;
      if (saved.testnet !== undefined) _cfg.testnet = saved.testnet;
    } catch (e) {}
  }

  function _saveCfg() {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      wallet:  _cfg.wallet,
      testnet: _cfg.testnet
    }));
  }

  /* ── Backend API calls ───────────────────────────────────────────────────── */
  async function _post(path, body) {
    var res = await fetch(BACKEND + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      var txt = await res.text();
      throw new Error('HL backend ' + res.status + ': ' + txt.substring(0, 200));
    }
    return res.json();
  }

  async function _get(path) {
    var res = await fetch(BACKEND + path);
    if (!res.ok) throw new Error('HL backend ' + res.status);
    return res.json();
  }

  /* ── Render broker card ──────────────────────────────────────────────────── */
  function renderCard() {
    var card = document.getElementById('hlBrokerCard');
    if (!card) return;

    if (_cfg.connected) {
      card.innerHTML =
        '<div class="ee-broker-name" style="color:#00ff88">HYPERLIQUID ' +
          (_cfg.testnet
            ? '<span style="color:#ffaa00;font-size:8px">TESTNET</span>'
            : '<span style="color:#ff4444;font-size:8px">LIVE</span>') +
        '</div>' +
        '<div class="ee-broker-assets">Crypto perps &middot; up to 50× leverage &middot; ' +
          Object.keys(HL_ASSETS).length + ' assets</div>' +
        '<div style="font-size:8px;color:var(--dim);margin-bottom:4px">' +
          'Equity: <b style="color:var(--bright)">$' + (_cfg.equity !== null ? _cfg.equity.toFixed(2) : '—') + '</b>' +
          ' &nbsp; Available: <b style="color:var(--bright)">$' + (_cfg.available !== null ? _cfg.available.toFixed(2) : '—') + '</b>' +
          ' &nbsp; Unrealised: <b style="color:' + ((_cfg.unrealised || 0) >= 0 ? '#00ff88' : '#ff4444') + '">' +
            ((_cfg.unrealised !== null ? (_cfg.unrealised >= 0 ? '+' : '') + _cfg.unrealised.toFixed(2) : '—')) + '</b>' +
        '</div>' +
        '<div style="font-size:7px;color:var(--dim);margin-bottom:4px;word-break:break-all">' +
          _cfg.wallet.substring(0, 12) + '…' + _cfg.wallet.slice(-6) +
        '</div>' +
        '<button onclick="HLBroker.disconnect()" ' +
          'style="font-size:8px;width:100%;padding:3px 0;border:1px solid #ff4444;' +
          'background:transparent;color:#ff4444;cursor:pointer;font-family:inherit;border-radius:2px">' +
          'Disconnect' +
        '</button>';
    } else {
      card.innerHTML =
        '<div class="ee-broker-name">Hyperliquid</div>' +
        '<div class="ee-broker-assets">Crypto perps &middot; Up to 50× leverage</div>' +
        '<div style="margin-bottom:4px">' +
          '<input id="hlWallet" type="text" placeholder="Wallet address (0x…)" value="' + (_cfg.wallet || '') + '" ' +
            'style="width:100%;box-sizing:border-box;font-size:8px;padding:2px 4px;' +
            'background:var(--bg);border:1px solid var(--border);color:var(--bright);' +
            'font-family:inherit;border-radius:2px;margin-bottom:2px">' +
          '<input id="hlPrivKey" type="password" placeholder="Private key (stays local — never sent)" ' +
            'style="width:100%;box-sizing:border-box;font-size:8px;padding:2px 4px;' +
            'background:var(--bg);border:1px solid var(--border);color:var(--bright);' +
            'font-family:inherit;border-radius:2px;margin-bottom:2px">' +
          '<label style="font-size:7px;color:var(--dim);cursor:pointer">' +
            '<input id="hlTestnet" type="checkbox" ' + (_cfg.testnet ? 'checked' : '') + ' ' +
              'style="margin-right:3px"> Testnet mode' +
          '</label>' +
        '</div>' +
        '<button onclick="HLBroker._connectFromUI()" ' +
          'style="font-size:8px;width:100%;padding:3px 0;border:1px solid var(--accent);' +
          'background:transparent;color:var(--accent);cursor:pointer;font-family:inherit;border-radius:2px">' +
          (_cfg.wallet ? 'Reconnect' : 'Connect') +
        '</button>' +
        '<div style="font-size:7px;color:#888;margin-top:3px">' +
          'Key is sent only to localhost backend — never to any external server.' +
        '</div>' +
        '<div id="hlStatus" style="font-size:7px;color:var(--dim);margin-top:2px;min-height:10px"></div>';
    }
  }

  /* ── Fill poll — polls /api/hl/positions until the trade appears ─────────── */
  function _pollFill(coin, side, onFill, onFail) {
    var POLL_MS    = 3000;
    var TIMEOUT_MS = 30000;
    var started    = Date.now();

    function _check() {
      if (Date.now() - started >= TIMEOUT_MS) { onFail('timeout'); return; }
      _get('/api/hl/positions')
        .then(function (data) {
          if (!data.ok) { setTimeout(_check, POLL_MS); return; }
          var pos = (data.positions || []).find(function (p) { return p.coin === coin; });
          if (pos) {
            onFill(pos.entryPx, pos);
          } else {
            setTimeout(_check, POLL_MS);
          }
        })
        .catch(function () { setTimeout(_check, POLL_MS); });
    }
    setTimeout(_check, POLL_MS);
  }

  /* ── Public API ──────────────────────────────────────────────────────────── */
  var HLBroker = {
    name:    'HL',
    version: 1,

    isConnected: function () { return _cfg.connected; },
    isTestnet:   function () { return _cfg.testnet; },

    covers: function (asset) {
      return Object.prototype.hasOwnProperty.call(HL_ASSETS, String(asset).toUpperCase());
    },

    assetInfo: function (asset) {
      return HL_ASSETS[String(asset).toUpperCase()] || null;
    },

    assets: function () { return Object.keys(HL_ASSETS); },

    connect: async function (wallet, privateKey, testnet) {
      _cfg.wallet  = wallet;
      _cfg.testnet = testnet !== false;
      try {
        var result = await _post('/api/hl/connect', {
          wallet: wallet, privateKey: privateKey, testnet: _cfg.testnet
        });
        if (result.ok) {
          _cfg.connected  = true;
          _cfg.equity     = result.equity;
          _cfg.available  = result.available;
          _cfg.unrealised = result.unrealised;
          _saveCfg();
          renderCard();
        }
        return result;
      } catch (e) {
        _cfg.connected = false;
        return { ok: false, error: e.message };
      }
    },

    _connectFromUI: async function () {
      var walletEl  = document.getElementById('hlWallet');
      var keyEl     = document.getElementById('hlPrivKey');
      var testnetEl = document.getElementById('hlTestnet');
      var statusEl  = document.getElementById('hlStatus');
      if (!walletEl || !keyEl) return;
      if (statusEl) { statusEl.textContent = 'Connecting…'; statusEl.style.color = 'var(--dim)'; }
      var result = await HLBroker.connect(
        walletEl.value.trim(),
        keyEl.value.trim(),
        testnetEl ? testnetEl.checked : true
      );
      if (!result.ok && statusEl) {
        statusEl.style.color = '#ff4444';
        statusEl.textContent = result.error || 'Connection failed';
      }
    },

    disconnect: async function () {
      try { await _post('/api/hl/disconnect', {}); } catch (e) {}
      _cfg.connected = false;
      _saveCfg();
      renderCard();
    },

    renderCard: renderCard,

    getAccount: async function () {
      var data = await _get('/api/hl/account');
      if (data.ok) {
        _cfg.equity     = data.equity;
        _cfg.available  = data.available;
        _cfg.unrealised = data.unrealised;
      }
      return data;
    },

    getPrice: async function (symbol) {
      /* Use HL feed if available, otherwise skip (EE uses its own prices) */
      try {
        if (window.HLFeed && HLFeed.getPrice) return HLFeed.getPrice(symbol);
      } catch (e) {}
      return null;
    },

    /* Place a market order.
       side: 'buy' | 'sell'
       qty: ignored — we use opts.notional (size in USD)
       opts.leverage: leverage multiplier (default 1) */
    placeOrder: async function (symbol, qty, side, opts) {
      var sizeUsd  = (opts && opts.notional) ? parseFloat(opts.notional) : 0;
      var leverage = (opts && opts.leverage) ? parseInt(opts.leverage) : 1;
      if (sizeUsd <= 0) return { ok: false, error: 'notional required' };
      return _post('/api/hl/order', {
        coin:     String(symbol).toUpperCase(),
        side:     side,
        sizeUsd:  sizeUsd,
        leverage: leverage
      });
    },

    /* Place order with fill confirmation.
       onFill(fillPrice, position) — called when position appears on HL
       onFail(reason)              — called on timeout              */
    placeOrderWithConfirmation: async function (symbol, qty, side, opts, onFill, onFail) {
      var result = await HLBroker.placeOrder(symbol, qty, side, opts);
      if (!result || !result.ok) {
        if (onFail) onFail(result ? result.error : 'order failed');
        return result;
      }
      /* HL market orders fill nearly instantly — confirm via positions poll */
      if (result.fillPrice && result.fillPrice > 0) {
        /* SDK returned fill data directly */
        if (onFill) onFill(result.fillPrice, result);
      } else {
        _pollFill(String(symbol).toUpperCase(), side, onFill, onFail);
      }
      return result;
    },

    closePosition: async function (symbol) {
      return _post('/api/hl/close', { coin: String(symbol).toUpperCase() });
    },

    getPositions: async function () {
      return _get('/api/hl/positions');
    },

    /* Refresh account info and update card */
    refreshAccount: async function () {
      if (!_cfg.connected) return;
      var data = await HLBroker.getAccount().catch(function () { return null; });
      if (data && data.ok) renderCard();
    },

    /* Standard status() interface expected by the EE and dashboard */
    status: function () {
      return {
        lastPoll:    _cfg.connected ? Date.now() : 0,
        connected:   _cfg.connected,
        testnet:     _cfg.testnet,
        equity:      _cfg.equity,
        available:   _cfg.available,
        unrealised:  _cfg.unrealised,
        addressHint: _cfg.wallet ? _cfg.wallet.substring(0, 10) + '…' : '',
        assetCount:  Object.keys(HL_ASSETS).length,
        note: _cfg.connected
          ? (_cfg.testnet ? 'Testnet' : 'Live') + ' · equity $' +
            (_cfg.equity !== null ? _cfg.equity.toFixed(0) : '—') + ' · ' +
            Object.keys(HL_ASSETS).length + ' assets'
          : 'Not connected'
      };
    },
    signals: function () { return []; }  /* execution-only */
  };

  _loadCfg();
  window.HLBroker = HLBroker;

  /* Auto-check connection status on startup (no private key needed — backend holds it) */
  setTimeout(function () {
    _get('/api/hl/status')
      .then(function (data) {
        if (data.connected) {
          _cfg.connected  = true;
          _cfg.wallet     = data.address || _cfg.wallet;
          _cfg.testnet    = data.testnet;
          _cfg.equity     = data.equity   || null;
          _cfg.available  = data.available || null;
          _cfg.unrealised = data.unrealised || null;
          _saveCfg();
          renderCard();
          console.log('[HLBroker] Auto-connected —', _cfg.testnet ? 'testnet' : 'mainnet');
        }
      })
      .catch(function () {}); /* backend not running yet — ignore */
  }, 3500);

  /* Refresh account every 30s when connected */
  setInterval(function () {
    if (_cfg.connected) HLBroker.refreshAccount();
  }, 30000);

  /* Render card once DOM is ready */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderCard);
  } else {
    setTimeout(renderCard, 0);
  }

})();
