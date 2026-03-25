/**
 * OANDA Rates Agent — Real-time FX pricing via OANDA v20 REST API
 *
 * This is a DATA SOURCE agent, not a trading broker.
 * It polls OANDA for live bid/ask FX rates and exposes them as
 * window.OANDA_RATES for use by executionEngine.js (replacing Frankfurter.app).
 *
 * Requirements:
 *   - Free OANDA demo account: https://www.oanda.com/register/#demo
 *   - Personal access token from: My Account → Manage API Access
 *
 * Usage:
 *   OANDA_RATES.connect(token, isDemoAccount)  — connect and start polling
 *   OANDA_RATES.getRate('EURUSD')              — returns {bid, ask, mid, spread}
 *   OANDA_RATES.isConnected()                  — true when live data flowing
 */
(function() {
  'use strict';

  var CFG_KEY     = 'oanda_rates_cfg_v1';
  var DEMO_URL    = 'https://api-fxpractice.oanda.com';
  var LIVE_URL    = 'https://api-fxtrade.oanda.com';
  var POLL_MS     = 30000;  // 30-second poll interval
  var INSTRUMENTS = 'EUR_USD,GBP_USD,USD_JPY,USD_CHF,AUD_USD,USD_CAD,NZD_USD,GBP_JPY,EUR_JPY,EUR_GBP';

  var _cfg = { token: '', accountId: '', demo: true, connected: false };
  var _rates = {};    // { 'EUR_USD': { bid, ask, mid, spread, tradeable, ts } }
  var _interval = null;
  var _lastPollTs = 0;
  var _errMsg = '';

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function _baseUrl() { return _cfg.demo ? DEMO_URL : LIVE_URL; }

  function _headers() {
    return {
      'Authorization': 'Bearer ' + _cfg.token,
      'Content-Type':  'application/json'
    };
  }

  // Convert 'EURUSD' → 'EUR_USD' (both 6-char and already-underscore forms)
  function _toKey(pair) {
    if (!pair) return '';
    pair = pair.toUpperCase().replace('/', '');
    return pair.length === 6 ? pair.slice(0, 3) + '_' + pair.slice(3) : pair;
  }

  // ── Polling ─────────────────────────────────────────────────────────────────

  function _poll() {
    if (!_cfg.connected || !_cfg.token || !_cfg.accountId) return;

    fetch(
      _baseUrl() + '/v3/accounts/' + _cfg.accountId + '/pricing?instruments=' + INSTRUMENTS,
      { headers: _headers() }
    )
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(d) {
      var now = Date.now();
      (d.prices || []).forEach(function(p) {
        var bid = parseFloat(p.bids && p.bids[0] ? p.bids[0].price : 0);
        var ask = parseFloat(p.asks && p.asks[0] ? p.asks[0].price : 0);
        _rates[p.instrument] = {
          bid:       bid,
          ask:       ask,
          mid:       (bid + ask) / 2,
          spread:    Math.round((ask - bid) * 100000) / 10,   // pips (5dp pairs)
          tradeable: p.tradeable,
          ts:        now
        };
      });
      _lastPollTs = now;
      _errMsg = '';
      _renderCard();
    })
    .catch(function(e) {
      _errMsg = e.message || 'poll error';
      _renderCard();
    });
  }

  // ── Card rendering ──────────────────────────────────────────────────────────

  function _renderCard() {
    var el = document.getElementById('oandaRatesCard');
    if (!el) return;

    if (!_cfg.connected) {
      el.innerHTML =
        '<div class="ee-broker-header">' +
          '<span class="ee-broker-icon">📡</span>' +
          '<span class="ee-broker-name">OANDA RATES</span>' +
          '<span class="ee-broker-status ee-status-disconnected">DISCONNECTED</span>' +
        '</div>' +
        '<div class="ee-broker-body" style="padding:8px 10px">' +
          '<p style="margin:0 0 6px;font-size:11px;color:#aaa">' +
            'Real-time FX rates via OANDA v20 API.<br>' +
            'Replaces Frankfurter (ECB once-daily) with live streaming prices.' +
          '</p>' +
          '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
            '<input id="oandaTokenInput" type="password" placeholder="Personal Access Token" ' +
              'style="flex:1;min-width:150px;background:#1a1a2e;border:1px solid #444;color:#eee;' +
              'padding:4px 7px;border-radius:3px;font-size:11px" />' +
            '<label style="font-size:11px;color:#aaa;white-space:nowrap">' +
              '<input id="oandaDemoCheck" type="checkbox" checked style="margin-right:4px" />Demo' +
            '</label>' +
            '<button onclick="OANDA_RATES.connectFromCard()" ' +
              'style="background:#0066cc;color:#fff;border:none;padding:4px 10px;' +
              'border-radius:3px;font-size:11px;cursor:pointer">Connect</button>' +
          '</div>' +
          (_errMsg ? '<div style="color:#f66;font-size:10px;margin-top:4px">' + _errMsg + '</div>' : '') +
          '<div style="margin-top:6px;font-size:10px;color:#666">' +
            'Get a free token: oanda.com → Open Demo Account → Manage API Access' +
          '</div>' +
        '</div>';
    } else {
      var eur = _rates['EUR_USD'];
      var gbp = _rates['GBP_USD'];
      var jpy = _rates['USD_JPY'];
      var age = _lastPollTs ? Math.round((Date.now() - _lastPollTs) / 1000) : null;

      el.innerHTML =
        '<div class="ee-broker-header">' +
          '<span class="ee-broker-icon">📡</span>' +
          '<span class="ee-broker-name">OANDA RATES</span>' +
          '<span class="ee-broker-status ee-status-connected">' +
            (_cfg.demo ? 'DEMO ✓' : 'LIVE ✓') +
          '</span>' +
        '</div>' +
        '<div class="ee-broker-body" style="padding:6px 10px">' +
          '<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px">' +
            _rateChip('EUR/USD', eur) +
            _rateChip('GBP/USD', gbp) +
            _rateChip('USD/JPY', jpy) +
          '</div>' +
          '<div style="margin-top:5px;font-size:10px;color:#666;display:flex;justify-content:space-between">' +
            '<span>' + Object.keys(_rates).length + ' pairs live</span>' +
            '<span>' + (age !== null ? 'updated ' + age + 's ago' : 'waiting…') + '</span>' +
            '<button onclick="OANDA_RATES.disconnect()" ' +
              'style="background:none;border:1px solid #444;color:#aaa;padding:1px 6px;' +
              'border-radius:3px;font-size:10px;cursor:pointer">Disconnect</button>' +
          '</div>' +
        '</div>';
    }
  }

  function _rateChip(label, rate) {
    if (!rate) return '<span style="color:#555">' + label + ': —</span>';
    return '<span><span style="color:#aaa">' + label + '</span> ' +
      '<span style="color:#4af">' + rate.mid.toFixed(label.indexOf('JPY') >= 0 ? 3 : 5) + '</span>' +
      '</span>';
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  window.OANDA_RATES = {

    isConnected: function() { return _cfg.connected; },

    /**
     * Look up a live rate.
     * Returns null if no rate is found OR if the rate is older than 5 minutes
     * (prevents stale oil/FX prices from triggering false correlation signals).
     * @param {string} pair  e.g. 'EURUSD', 'EUR_USD', or 'EUR/USD'
     * @returns {{ bid, ask, mid, spread, tradeable, ts } | null}
     */
    getRate: function(pair) {
      var r = _rates[_toKey(pair)];
      if (!r) return null;
      if (r.ts && (Date.now() - r.ts) > 300000) return null;  // >5 min stale
      return r;
    },

    /** Return all currently-known rates. */
    getAllRates: function() { return Object.assign({}, _rates); },

    /**
     * Connect to OANDA with a personal access token.
     * @param {string}  token  Personal access token from My Account → Manage API Access
     * @param {boolean} demo   true = demo account (fxpractice), false = live (fxtrade)
     * @returns {Promise}
     */
    connect: function(token, demo) {
      _cfg.token = (token || '').trim();
      _cfg.demo  = (demo !== false);
      _errMsg    = '';

      return fetch(_baseUrl() + '/v3/accounts', { headers: _headers() })
        .then(function(r) {
          if (!r.ok) throw new Error('Auth failed — HTTP ' + r.status);
          return r.json();
        })
        .then(function(d) {
          var accounts = d.accounts || [];
          if (!accounts.length) throw new Error('No accounts found for this token');
          _cfg.accountId = accounts[0].id;
          _cfg.connected = true;
          _saveConfig();
          if (_interval) clearInterval(_interval);
          _interval = setInterval(_poll, POLL_MS);
          _poll();   // immediate first poll
        })
        .catch(function(e) {
          _cfg.connected = false;
          _errMsg = e.message || 'Connection failed';
          _renderCard();
          throw e;
        });
    },

    /** Called by the Connect button inside the card. */
    connectFromCard: function() {
      var tokenEl = document.getElementById('oandaTokenInput');
      var demoEl  = document.getElementById('oandaDemoCheck');
      var token   = tokenEl ? tokenEl.value.trim() : '';
      var demo    = demoEl  ? demoEl.checked : true;
      if (!token) { alert('Please enter your OANDA Personal Access Token'); return; }
      window.OANDA_RATES.connect(token, demo)
        .catch(function(e) { console.warn('[OANDA] connect failed:', e.message); });
    },

    disconnect: function() {
      _cfg.connected = false;
      _cfg.token     = '';
      _cfg.accountId = '';
      _rates         = {};
      if (_interval) { clearInterval(_interval); _interval = null; }
      _saveConfig();
      _renderCard();
    },

    renderCard: _renderCard,

    /** Expose current config type for debugging. */
    status: function() {
      return {
        connected:  _cfg.connected,
        demo:       _cfg.demo,
        accountId:  _cfg.accountId ? _cfg.accountId.slice(0, 8) + '…' : '',
        pairsLive:  Object.keys(_rates).length,
        lastPollTs: _lastPollTs,
        error:      _errMsg || null,
      };
    }
  };

  // ── Persistence ──────────────────────────────────────────────────────────────

  function _saveConfig() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(_cfg)); } catch(e) {}
  }

  // Restore saved config on page load — re-verify token before polling
  try {
    var saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
    if (saved.token && saved.accountId) {
      _cfg = Object.assign(_cfg, saved);
      _cfg.connected = false; // assume disconnected until verified
      // Re-verify token is still valid before resuming
      fetch(_baseUrl() + '/v3/accounts', { headers: _headers() })
        .then(function(r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function() {
          _cfg.connected = true;
          if (_interval) clearInterval(_interval);
          _interval = setInterval(_poll, POLL_MS);
          _poll();
          _renderCard();
        })
        .catch(function(e) {
          _cfg.connected = false;
          _errMsg = 'Token check failed — re-enter token: ' + (e.message || '');
          _renderCard();
        });
    }
  } catch(e) {}

  // Render the card once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _renderCard);
  } else {
    // Small delay so the card container is definitely in the DOM
    setTimeout(_renderCard, 100);
  }

})();
