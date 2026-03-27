/* Macro Cross-Asset Agent — macro-cross-agent.js v1
 *
 * Generates trading signals from macro cross-asset relationships:
 *
 *   1. EUR/USD → DXY proxy signals (USD strength / weakness)
 *      Reads from window.OANDA_RATES if connected; skipped gracefully if not.
 *
 *   2. Gold / Equity divergence
 *      GLD up + SPY flat/down → risk-off → SPY SHORT
 *      GLD down + SPY up      → risk-on  → BTC LONG, SOL LONG
 *
 *   3. Crypto risk-on / risk-off
 *      BTC big move + SPY flat → crypto-specific momentum signal
 *      SPY big move + BTC flat → equity-specific; ignore crypto
 *
 *   4. Gold / Silver ratio
 *      GLD up but SLV lagging → SLV LONG
 *      SLV surging but GLD flat → GLD LONG
 *
 * Data:
 *   EUR/USD  : OANDA_RATES.getRate('EURUSD') → {mid, bid, ask} or null
 *   All other assets : HLFeed.getPrice(asset), checked with HLFeed.isAvailable()
 *
 * Price history: sample every 5 minutes, keep last 24 per asset (2 hours).
 * 1-hour return uses the sample from 12 steps back (idx = length - 1 - 12).
 *
 * Scan interval : 5 minutes. First scan 20 seconds after load.
 * Cooldown      : 2 hours per asset + direction.
 *
 * Exposes: window.GII_AGENT_MACRO_CROSS
 */
(function () {
  'use strict';

  // ── constants ────────────────────────────────────────────────────────────────

  var POLL_MS        = 5  * 60 * 1000;       // 5-minute scan + sample interval
  var INIT_DELAY_MS  = 20 * 1000;            // first scan after 20 seconds
  var MAX_SAMPLES    = 24;                   // 24 × 5min = 2h history per asset
  var RETURN_IDX     = 12;                   // 12 samples back = 1-hour return
  var COOLDOWN_MS    = 2 * 60 * 60 * 1000;  // 2-hour cooldown per asset+direction
  var MAX_SIGNALS    = 50;                   // cap internal signal list

  // Assets tracked by HLFeed
  var HL_ASSETS = ['GLD', 'SLV', 'SPY', 'QQQ', 'BTC', 'SOL'];

  // OANDA assets tracked in addition to HLFeed
  var OANDA_ASSETS = ['XAU_USD', 'XAG_USD', 'BCO_USD', 'WTICO_USD', 'SPX500_USD', 'NAS100_USD',
                      'EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD'];

  // ── private state ────────────────────────────────────────────────────────────

  var _priceHistory = {};  // { asset: [{price, ts}, …] }
  var _fxHistory    = [];  // [{mid, ts}, …]   — EUR/USD from OANDA
  var _signals      = [];  // emitted signals this session (most-recent first)
  var _cooldowns    = {};  // 'ASSET_BIAS' → timestamp
  var _scanCount    = 0;
  var _signalCount  = 0;
  var _lastPoll     = 0;
  var _online       = false;

  // ── price history helpers ─────────────────────────────────────────────────

  function _recordHL(asset, price) {
    if (!_priceHistory[asset]) _priceHistory[asset] = [];
    _priceHistory[asset].push({ price: price, ts: Date.now() });
    if (_priceHistory[asset].length > MAX_SAMPLES) _priceHistory[asset].shift();
  }

  function _recordFX(mid) {
    _fxHistory.push({ mid: mid, ts: Date.now() });
    if (_fxHistory.length > MAX_SAMPLES) _fxHistory.shift();
  }

  // Return 1-hour % return for an HLFeed asset, or null if not enough history.
  function _hlReturn(asset) {
    var h = _priceHistory[asset];
    if (!h || h.length < RETURN_IDX + 1) return null;
    var older  = h[h.length - 1 - RETURN_IDX].price;
    var latest = h[h.length - 1].price;
    if (!older || older === 0) return null;
    return (latest - older) / older * 100;
  }

  // Return 1-hour % return for EUR/USD from _fxHistory, or null.
  function _fxReturn() {
    if (_fxHistory.length < RETURN_IDX + 1) return null;
    var older  = _fxHistory[_fxHistory.length - 1 - RETURN_IDX].mid;
    var latest = _fxHistory[_fxHistory.length - 1].mid;
    if (!older || older === 0) return null;
    return (latest - older) / older * 100;
  }

  // ── cooldown helpers ──────────────────────────────────────────────────────

  function _cdKey(asset, bias) {
    return asset + '_' + bias;
  }

  function _onCooldown(asset, bias) {
    var last = _cooldowns[_cdKey(asset, bias)];
    return last && (Date.now() - last) < COOLDOWN_MS;
  }

  function _setCooldown(asset, bias) {
    _cooldowns[_cdKey(asset, bias)] = Date.now();
  }

  // ── signal builder ────────────────────────────────────────────────────────

  function _mkSig(asset, bias, conf, reasoning, sector, extraKeys) {
    var keys = ['macro-cross'].concat(extraKeys || []);
    return {
      source       : 'macro-cross',
      asset        : asset,
      bias         : bias,
      confidence   : Math.round(conf * 100) / 100,
      reasoning    : reasoning,
      region       : 'GLOBAL',
      sector       : sector,
      evidenceKeys : keys,
      timestamp    : Date.now()
    };
  }

  function _tryEmit(batch, asset, bias, conf, reasoning, sector, extraKeys) {
    // Tradeable check — accept HL or OANDA assets
    var hlOk    = window.HLFeed && typeof HLFeed.isAvailable === 'function' && HLFeed.isAvailable(asset);
    var oandaOk = window.OANDA_RATES && typeof OANDA_RATES.isConnected === 'function' &&
                  OANDA_RATES.isConnected() && !!OANDA_RATES.getRate(asset);
    if (!hlOk && !oandaOk) return;
    // Cooldown check
    if (_onCooldown(asset, bias)) return;
    var sig = _mkSig(asset, bias, conf, reasoning, sector, extraKeys);
    batch.push(sig);
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
    _setCooldown(asset, bias);
    _signalCount++;
    console.log('[MACRO-X] Signal: ' + asset + ' ' + bias +
                ' conf=' + sig.confidence + ' | ' + reasoning);
  }

  // ── signal modules ────────────────────────────────────────────────────────

  // 1. EUR/USD → DXY proxy
  function _scanFX(batch) {
    var eurusdRet = _fxReturn();
    if (eurusdRet === null) return;

    var retFmt = eurusdRet.toFixed(2) + '%';

    if (eurusdRet < -0.4) {
      // EUR/USD down → USD strengthening → risk-off
      var usdCtx = 'EUR/USD ' + retFmt + ' (1h) — DXY strengthening, risk-off';
      _tryEmit(batch, 'SPY', 'SHORT', 0.67,
        usdCtx + ' → equities under pressure',
        'equity', ['fx', 'equity']);
      _tryEmit(batch, 'QQQ', 'SHORT', 0.66,
        usdCtx + ' → tech equities under pressure',
        'equity', ['fx', 'equity']);
      _tryEmit(batch, 'GLD', 'LONG', 0.66,
        usdCtx + ' → safe-haven demand for gold',
        'precious', ['fx', 'precious']);
      _tryEmit(batch, 'BTC', 'SHORT', 0.65,
        usdCtx + ' → crypto risk-off outflows',
        'crypto', ['fx', 'crypto']);

    } else if (eurusdRet > 0.4) {
      // EUR/USD up → USD weakening → risk-on
      var weakCtx = 'EUR/USD +' + retFmt + ' (1h) — USD weakening, risk-on';
      _tryEmit(batch, 'GLD', 'LONG', 0.70,
        weakCtx + ' → weaker USD supports gold',
        'precious', ['fx', 'precious']);
      _tryEmit(batch, 'BTC', 'LONG', 0.67,
        weakCtx + ' → crypto benefits from USD weakness',
        'crypto', ['fx', 'crypto']);
      _tryEmit(batch, 'SPY', 'LONG', 0.65,
        weakCtx + ' → risk-on equity tailwind',
        'equity', ['fx', 'equity']);
    }
  }

  // 2. Gold / Equity divergence
  function _scanGoldEquity(batch) {
    var gldRet = _hlReturn('GLD');
    var spyRet = _hlReturn('SPY');
    if (gldRet === null || spyRet === null) return;

    var gldFmt = (gldRet >= 0 ? '+' : '') + gldRet.toFixed(2) + '%';
    var spyFmt = (spyRet >= 0 ? '+' : '') + spyRet.toFixed(2) + '%';

    if (gldRet > 1.0 && spyRet <= 0) {
      // GLD up >1% AND SPY flat/down → risk-off confirmed
      _tryEmit(batch, 'SPY', 'SHORT', 0.68,
        'GLD ' + gldFmt + ' (1h) with SPY ' + spyFmt +
        ' — gold/equity divergence confirms risk-off',
        'equity', ['gold-equity', 'equity', 'precious']);
    } else if (gldRet < -1.0 && spyRet > 0.5) {
      // GLD down >1% AND SPY up >0.5% → risk-on
      var riskOnCtx = 'GLD ' + gldFmt + ' with SPY ' + spyFmt +
                      ' (1h) — gold/equity divergence signals risk-on';
      _tryEmit(batch, 'BTC', 'LONG', 0.67,
        riskOnCtx, 'crypto', ['gold-equity', 'crypto', 'precious']);
      _tryEmit(batch, 'SOL', 'LONG', 0.67,
        riskOnCtx, 'crypto', ['gold-equity', 'crypto', 'precious']);
    }
  }

  // 3. Crypto risk-on / risk-off
  function _scanCryptoRiskMode(batch) {
    var btcRet = _hlReturn('BTC');
    var spyRet = _hlReturn('SPY');
    if (btcRet === null || spyRet === null) return;

    var btcFmt = (btcRet >= 0 ? '+' : '') + btcRet.toFixed(2) + '%';
    var spyFmt = (spyRet >= 0 ? '+' : '') + spyRet.toFixed(2) + '%';

    var btcAbs = Math.abs(btcRet);
    var spyAbs = Math.abs(spyRet);

    // BTC big move, SPY flat → crypto-specific momentum
    if (btcAbs > 2.0 && spyAbs < 0.3) {
      var btcBias = btcRet > 0 ? 'LONG' : 'SHORT';
      _tryEmit(batch, 'BTC', btcBias, 0.66,
        'BTC ' + btcFmt + ' (1h) while SPY ' + spyFmt +
        ' — crypto-specific move, momentum signal',
        'crypto', ['crypto-regime', 'crypto']);
    }
    // SPY big move, BTC flat → equity-specific; no crypto signal generated
  }

  // 4b. Gold (OANDA XAU_USD) / Silver (OANDA XAG_USD) — using live OANDA prices
  function _scanGoldSilverOanda(batch) {
    var xauRet = _hlReturn('XAU_USD');
    var xagRet = _hlReturn('XAG_USD');
    if (xauRet === null || xagRet === null) return;
    var xauFmt = (xauRet >= 0 ? '+' : '') + xauRet.toFixed(2) + '%';
    var xagFmt = (xagRet >= 0 ? '+' : '') + xagRet.toFixed(2) + '%';
    if (xauRet > 0.8 && xagRet < 0.2) {
      _tryEmit(batch, 'XAG_USD', 'LONG', 0.68,
        'XAU ' + xauFmt + ' (1h) but XAG only ' + xagFmt + ' — silver lagging gold rally',
        'precious', ['gold-silver', 'precious']);
    } else if (xagRet > 1.5 && xauRet < 0.4) {
      _tryEmit(batch, 'XAU_USD', 'LONG', 0.67,
        'XAG ' + xagFmt + ' leading with XAU only ' + xauFmt + ' — gold catch-up expected',
        'precious', ['gold-silver', 'precious']);
    }
  }

  // 5. Oil / Equity divergence — Brent vs SPX500
  function _scanOilEquity(batch) {
    var broRet = _hlReturn('BCO_USD');
    var spxRet = _hlReturn('SPX500_USD');
    if (broRet === null || spxRet === null) return;
    var broFmt = (broRet >= 0 ? '+' : '') + broRet.toFixed(2) + '%';
    var spxFmt = (spxRet >= 0 ? '+' : '') + spxRet.toFixed(2) + '%';
    if (broRet > 1.5 && spxRet > 0) {
      // Oil up strongly while equities also up → energy stocks should follow
      _tryEmit(batch, 'XLE', 'LONG', 0.65,
        'Brent ' + broFmt + ' with SPX ' + spxFmt + ' (1h) — energy sector bullish',
        'energy', ['oil-equity', 'energy']);
    } else if (broRet > 2.0 && spxRet < -0.5) {
      // Oil surging but equities falling → stagflation signal
      _tryEmit(batch, 'XAU_USD', 'LONG', 0.70,
        'Brent ' + broFmt + ' vs SPX ' + spxFmt + ' — stagflation hedge, gold long',
        'precious', ['oil-equity', 'stagflation', 'precious']);
      _tryEmit(batch, 'SPX500_USD', 'SHORT', 0.66,
        'Brent ' + broFmt + ' squeezing margins vs SPX ' + spxFmt,
        'equity', ['oil-equity', 'stagflation', 'equity']);
    } else if (broRet < -2.0 && spxRet > 0.5) {
      // Oil falling, equities rising → growth optimism, risk-on
      _tryEmit(batch, 'NAS100_USD', 'LONG', 0.65,
        'Brent ' + broFmt + ' (lower input costs) with SPX ' + spxFmt + ' — tech risk-on',
        'equity', ['oil-equity', 'equity']);
    }
  }

  // 6. USD/JPY risk barometer
  function _scanUsdJpy(batch) {
    var jpyRet = _hlReturn('USD_JPY');
    var xauRet = _hlReturn('XAU_USD');
    if (jpyRet === null) return;
    var jpyFmt = (jpyRet >= 0 ? '+' : '') + jpyRet.toFixed(2) + '%';
    // USD/JPY falling = JPY strengthening = risk-off
    if (jpyRet < -0.4) {
      _tryEmit(batch, 'XAU_USD', 'LONG', 0.68,
        'USD/JPY ' + jpyFmt + ' (1h) — yen strength signals risk-off, gold safe-haven bid',
        'precious', ['jpy-risk', 'precious']);
      _tryEmit(batch, 'BTC', 'SHORT', 0.64,
        'USD/JPY ' + jpyFmt + ' — yen risk-off proxy, crypto outflows likely',
        'crypto', ['jpy-risk', 'crypto']);
    } else if (jpyRet > 0.4) {
      // USD/JPY rising = USD strength / risk-on
      if (xauRet !== null && xauRet < -0.3) {
        _tryEmit(batch, 'BTC', 'LONG', 0.65,
          'USD/JPY ' + jpyFmt + ' (risk-on) with gold soft — crypto risk-on rotation',
          'crypto', ['jpy-risk', 'crypto']);
      }
    }
  }

  // 4. Gold / Silver ratio (percentage-based)
  function _scanGoldSilver(batch) {
    var gldRet = _hlReturn('GLD');
    var slvRet = _hlReturn('SLV');
    if (gldRet === null || slvRet === null) return;

    var gldFmt = (gldRet >= 0 ? '+' : '') + gldRet.toFixed(2) + '%';
    var slvFmt = (slvRet >= 0 ? '+' : '') + slvRet.toFixed(2) + '%';

    if (gldRet > 1.0 && slvRet < 0.3) {
      // Gold up strongly but silver lagging → silver should catch up
      _tryEmit(batch, 'SLV', 'LONG', 0.69,
        'GLD ' + gldFmt + ' (1h) but SLV only ' + slvFmt +
        ' — silver lagging gold rally, catch-up expected',
        'precious', ['gold-silver', 'precious']);
    } else if (slvRet > 2.0 && gldRet < 0.5) {
      // Silver surging but gold lagging → gold should follow
      _tryEmit(batch, 'GLD', 'LONG', 0.67,
        'SLV ' + slvFmt + ' (1h) leading with GLD only ' + gldFmt +
        ' — silver leading gold, mean-reversion to gold expected',
        'precious', ['gold-silver', 'precious']);
    }
  }

  // ── sample collection ─────────────────────────────────────────────────────

  function _collectSamples() {
    var i, asset, priceData, price;

    // HLFeed assets
    if (window.HLFeed) {
      for (i = 0; i < HL_ASSETS.length; i++) {
        asset = HL_ASSETS[i];
        if (typeof HLFeed.isAvailable !== 'function' || !HLFeed.isAvailable(asset)) continue;
        try {
          priceData = (typeof HLFeed.getPrice === 'function') ? HLFeed.getPrice(asset) : null;
        } catch (e) { continue; }
        if (!priceData) continue;
        // HLFeed.getPrice may return a number or an object with a .price property
        price = (typeof priceData === 'object') ? priceData.price : priceData;
        if (!price || isNaN(price) || price <= 0) continue;
        _recordHL(asset, price);
      }
    }

    // OANDA assets — forex, metals, energy, indices
    if (window.OANDA_RATES &&
        typeof OANDA_RATES.isConnected === 'function' &&
        OANDA_RATES.isConnected()) {
      try {
        // Keep legacy EUR/USD in _fxHistory for backward compatibility
        var fxRate = OANDA_RATES.getRate('EUR_USD') || OANDA_RATES.getRate('EURUSD');
        if (fxRate && fxRate.mid && fxRate.mid > 0) _recordFX(fxRate.mid);

        // Record all OANDA assets into the shared _priceHistory
        for (var oi = 0; oi < OANDA_ASSETS.length; oi++) {
          var sym = OANDA_ASSETS[oi];
          var r   = OANDA_RATES.getRate(sym);
          if (r && r.mid && r.mid > 0) _recordHL(sym, r.mid);
        }
      } catch (e) {
        console.warn('[MACRO-X] OANDA_RATES error: ' + (e.message || String(e)));
      }
    }
  }

  // ── main scan ─────────────────────────────────────────────────────────────

  function _scan() {
    _scanCount++;
    _lastPoll = Date.now();
    _online   = true;

    // Always collect fresh samples at scan time
    _collectSamples();

    var batch = [];

    // 1. EUR/USD FX signals (skipped gracefully if OANDA not connected)
    var oandaOk = window.OANDA_RATES &&
                  typeof OANDA_RATES.isConnected === 'function' &&
                  OANDA_RATES.isConnected();
    if (oandaOk) {
      _scanFX(batch);
    }

    // 2. Gold / Equity divergence
    _scanGoldEquity(batch);

    // 3. Crypto risk mode
    _scanCryptoRiskMode(batch);

    // 4. Gold / Silver ratio (HLFeed ETFs)
    _scanGoldSilver(batch);

    // 4b. Gold / Silver via OANDA live prices
    if (oandaOk) _scanGoldSilverOanda(batch);

    // 5. Oil / Equity divergence (OANDA)
    if (oandaOk) _scanOilEquity(batch);

    // 6. USD/JPY risk barometer (OANDA)
    if (oandaOk) _scanUsdJpy(batch);

    // Forward to Execution Engine
    if (batch.length && window.EE && typeof EE.onSignals === 'function') {
      try {
        EE.onSignals(batch);
      } catch (e) {
        console.warn('[MACRO-X] EE.onSignals() error: ' + (e.message || String(e)));
      }
    }

    var fxSamples = _fxHistory.length;
    var hlSamples = _priceHistory['GLD'] ? _priceHistory['GLD'].length : 0;
    console.log('[MACRO-X] Scan #' + _scanCount +
                ' | FX samples=' + fxSamples +
                ' | GLD samples=' + hlSamples +
                ' | signals this scan=' + batch.length +
                ' | total=' + _signalCount +
                (oandaOk ? '' : ' | OANDA offline'));
  }

  // ── init ──────────────────────────────────────────────────────────────────

  function _init() {
    console.log('[MACRO-X] Macro cross-asset agent initialising' +
                ' — first scan in ' + (INIT_DELAY_MS / 1000) + 's');

    // Start collecting samples immediately so history builds before first scan
    _collectSamples();
    setInterval(_collectSamples, POLL_MS);

    setTimeout(function () {
      _scan();
      setInterval(_scan, POLL_MS);
    }, INIT_DELAY_MS);
  }

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_AGENT_MACRO_CROSS = {

    status: function () {
      var oandaOk = !!(window.OANDA_RATES &&
                       typeof OANDA_RATES.isConnected === 'function' &&
                       OANDA_RATES.isConnected());
      var hlReady = 0;
      for (var i = 0; i < HL_ASSETS.length; i++) {
        var h = _priceHistory[HL_ASSETS[i]];
        if (h && h.length >= RETURN_IDX + 1) hlReady++;
      }
      return {
        lastPoll       : _lastPoll || null,
        online         : _online,
        oandaConnected : oandaOk,
        signalCount    : _signalCount,
        scanCount      : _scanCount,
        fxSamples      : _fxHistory.length,
        hlAssetsReady  : hlReady + '/' + HL_ASSETS.length,
        note           : _scanCount
          ? (hlReady + '/' + HL_ASSETS.length + ' HL assets ready' +
             (oandaOk
               ? ' · OANDA connected (' + _fxHistory.length + ' FX samples)'
               : ' · OANDA not connected (FX signals paused)'))
          : 'warming up — first scan in ~' + (INIT_DELAY_MS / 1000) + 's'
      };
    },

    signals: function () {
      return _signals.slice();
    },

    scan: function () {
      _scan();
    }
  };

  window.addEventListener('load', _init);

}());
