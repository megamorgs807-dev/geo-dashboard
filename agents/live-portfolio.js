/* ═══════════════════════════════════════════════════════════════════════════
   LIVE PORTFOLIO PANEL v1
   Real-time positions, broker health, risk, session stats, events & rejected trades
   Renders into #livePortfolioInner — refreshes every 10 seconds
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var REFRESH_MS     = 10000;
  var GBP_USD_FALLBACK = 1.27;
  var _interval      = null;
  var _pausedByUser  = false;
  var _todayOpen     = new Date(); _todayOpen.setHours(0,0,0,0);
  var _maxDrawdown   = 0;
  var _peakEquity    = null;

  /* ── Currency helpers ──────────────────────────────────────────────────── */
  function _gbpUsd() {
    if (window.OANDA_RATES && OANDA_RATES.isConnected()) {
      var r = OANDA_RATES.getRate ? OANDA_RATES.getRate('GBPUSD') : null;
      if (r && r.mid && r.mid > 0) return r.mid;
    }
    return GBP_USD_FALLBACK;
  }

  function _fmtUsd(n) {
    if (n == null) return '—';
    var abs = Math.abs(n), s = n < 0 ? '-$' : '$';
    return s + abs.toFixed(abs < 100 ? 2 : 0);
  }

  function _fmtPct(n) {
    if (n == null) return '—';
    return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function _pnlColor(n) {
    if (!n || n === 0) return 'var(--dim)';
    return n > 0 ? '#00ff88' : '#ff4444';
  }

  function _timeSince(isoStr) {
    if (!isoStr) return '—';
    var ms = Date.now() - new Date(isoStr).getTime();
    var m  = Math.floor(ms / 60000);
    if (m < 60)  return m + 'm';
    var h  = Math.floor(m / 60);
    if (h < 24)  return h + 'h ' + (m % 60) + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }

  /* ── Data gathering ────────────────────────────────────────────────────── */
  function _getTrades() {
    try { return (window.EE && EE.getOpenTrades) ? EE.getOpenTrades() : []; } catch (e) { return []; }
  }

  function _getAllTrades() {
    try { return (window.EE && EE.getAllTrades) ? EE.getAllTrades() : []; } catch (e) { return []; }
  }

  function _getCfg() {
    try { return (window.EE && EE.getConfig) ? EE.getConfig() : {}; } catch (e) { return {}; }
  }

  function _getLivePrice(asset) {
    try { return (window.EE && EE.getLastPrice) ? EE.getLastPrice(asset) : null; } catch (e) { return null; }
  }

  function _getUnrealisedPnl() {
    try { return (window.EE && EE.unrealisedPnl) ? EE.unrealisedPnl() : []; } catch (e) { return []; }
  }

  function _getTodayTrades() {
    return _getAllTrades().filter(function (t) {
      return t.timestamp_close && new Date(t.timestamp_close) >= _todayOpen;
    });
  }

  function _totalEquityUsd() {
    // EE.virtual_balance is kept in sync with the sum of all connected broker
    // equities by _pollBrokerEquity (runs every 60s, first poll at 8s after load).
    // Use it directly — adding individual broker balances on top would double-count.
    var cfg = _getCfg();
    return cfg.virtual_balance || 0;
  }

  function _todayPnlUsd() {
    return _getTodayTrades().reduce(function (s, t) { return s + (parseFloat(t.pnl_usd) || 0); }, 0);
  }

  /* ── Asset → currencies (for event matching) ──────────────────────────── */
  var ASSET_CURRENCIES = {
    'EURUSD':'EUR,USD', 'EUR':'EUR,USD', 'GBPUSD':'GBP,USD', 'GBP':'GBP,USD',
    'USDJPY':'USD,JPY', 'JPY':'USD,JPY', 'USDCHF':'USD,CHF', 'CHF':'USD,CHF',
    'AUDUSD':'AUD,USD', 'AUD':'AUD,USD', 'USDCAD':'USD,CAD', 'CAD':'USD,CAD',
    'NZDUSD':'NZD,USD', 'NZD':'NZD,USD', 'GBPJPY':'GBP,JPY', 'EURJPY':'EUR,JPY',
    'XAU':'USD', 'GLD':'USD', 'XAG':'USD', 'SLV':'USD',
    'WTI':'USD', 'BRENT':'USD', 'OIL':'USD', 'NATGAS':'USD',
    'SPX':'USD', 'NAS':'USD', 'DOW':'USD', 'SPY':'USD', 'QQQ':'USD',
    'BTC':'USD', 'ETH':'USD'
  };

  function _assetCurrencies(asset) {
    return (ASSET_CURRENCIES[asset.toUpperCase()] || 'USD').split(',');
  }

  function _upcomingEventsForAsset(asset, hours) {
    if (!window.ECON_CALENDAR || !ECON_CALENDAR.upcoming) return [];
    var currencies = _assetCurrencies(asset);
    try {
      return ECON_CALENDAR.upcoming(hours || 8).filter(function (ev) {
        return currencies.indexOf(ev.country) !== -1 || currencies.indexOf('USD') !== -1;
      });
    } catch (e) { return []; }
  }

  /* ── Correlation detection ─────────────────────────────────────────────── */
  function _correlations(trades) {
    var warnings = [];
    var currencyExposure = {};
    trades.forEach(function (t) {
      var currencies = _assetCurrencies(t.asset);
      currencies.forEach(function (c) {
        if (!currencyExposure[c]) currencyExposure[c] = [];
        currencyExposure[c].push(t.asset);
      });
    });
    Object.keys(currencyExposure).forEach(function (c) {
      if (currencyExposure[c].length > 1) {
        warnings.push('⚠ Multiple ' + c + ' exposure: ' + currencyExposure[c].join(', '));
      }
    });
    return warnings;
  }

  /* ── Rejected/skipped signals ──────────────────────────────────────────── */
  function _getRejected() {
    try {
      var all = _getAllTrades();
      return all.filter(function (t) {
        return t.broker_status === 'SKIPPED' || t.broker_status === 'REJECTED' ||
               t.close_reason === 'BROKER_REJECTED' || t.status === 'CANCELLED';
      }).slice(-6).reverse();
    } catch (e) { return []; }
  }

  /* ── 7-day sparkline ───────────────────────────────────────────────────── */
  function _sparkline(days) {
    var cutoff = Date.now() - days * 86400000;
    var closed = _getAllTrades().filter(function (t) {
      return t.timestamp_close && new Date(t.timestamp_close).getTime() > cutoff && t.pnl_usd != null;
    }).sort(function (a, b) { return new Date(a.timestamp_close) - new Date(b.timestamp_close); });

    if (closed.length < 2) return '<span style="font-size:7px;color:var(--dim)">Not enough history yet</span>';

    var cumulative = 0;
    var points = closed.map(function (t) {
      cumulative += parseFloat(t.pnl_usd) || 0;
      return cumulative;
    });
    var min = Math.min.apply(null, points);
    var max = Math.max.apply(null, points);
    var range = max - min || 1;
    var w = 180, h = 30;
    var coords = points.map(function (v, i) {
      var x = (i / (points.length - 1)) * w;
      var y = h - ((v - min) / range) * h;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');

    var finalColor = cumulative >= 0 ? '#00ff88' : '#ff4444';
    return '<svg width="' + w + '" height="' + (h + 4) + '" style="overflow:visible">' +
      '<polyline points="' + coords + '" fill="none" stroke="' + finalColor + '" stroke-width="1.5"/>' +
      '<circle cx="' + (w) + '" cy="' + (h - ((cumulative - min) / range) * h).toFixed(1) + '" r="2" fill="' + finalColor + '"/>' +
      '</svg>';
  }

  /* ── TP/SL progress bar ────────────────────────────────────────────────── */
  function _progressBar(trade, livePrice) {
    if (!livePrice || !trade.take_profit || !trade.stop_loss) return '';
    var entry = trade.entry_price;
    var tp    = trade.take_profit;
    var sl    = trade.stop_loss;
    var totalRange = Math.abs(tp - sl);
    if (totalRange === 0) return '';

    var dist = trade.direction === 'LONG'
      ? livePrice - entry
      : entry - livePrice;
    var tpDist = Math.abs(tp - entry);
    var pct = Math.max(0, Math.min(100, (dist / tpDist) * 100));
    var color = pct > 75 ? '#00ff88' : pct > 40 ? '#ffcc00' : dist < 0 ? '#ff4444' : '#888';

    return '<div style="margin-top:3px;background:rgba(255,255,255,0.06);border-radius:2px;height:3px;width:100%">' +
      '<div style="width:' + pct.toFixed(0) + '%;height:3px;background:' + color + ';border-radius:2px;transition:width 0.5s"></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:6px;color:var(--dim);margin-top:1px">' +
      '<span>SL ' + sl.toFixed(sl < 10 ? 4 : 2) + '</span>' +
      '<span style="color:' + color + '">' + pct.toFixed(0) + '% to TP</span>' +
      '<span>TP ' + tp.toFixed(tp < 10 ? 4 : 2) + '</span>' +
      '</div>';
  }

  /* ── Main render ───────────────────────────────────────────────────────── */
  function render() {
    var el = document.getElementById('livePortfolioInner');
    if (!el) return;

    var trades   = _getTrades();
    var cfg      = _getCfg();
    var pnlArr   = _getUnrealisedPnl();
    var todayTr  = _getTodayTrades();
    var todayPnl = _todayPnlUsd();
    var totalEq  = _totalEquityUsd();
    var fx       = _gbpUsd();

    /* track max drawdown */
    if (_peakEquity === null) _peakEquity = totalEq;
    if (totalEq > _peakEquity) _peakEquity = totalEq;
    var drawdown = _peakEquity > 0 ? ((_peakEquity - totalEq) / _peakEquity * 100) : 0;
    if (drawdown > _maxDrawdown) _maxDrawdown = drawdown;

    /* session stats */
    var wins    = todayTr.filter(function (t) { return (parseFloat(t.pnl_usd) || 0) > 0; }).length;
    var losses  = todayTr.filter(function (t) { return (parseFloat(t.pnl_usd) || 0) < 0; }).length;
    var neutral = todayTr.length - wins - losses;
    var hitRate = todayTr.length > 0 ? ((wins / todayTr.length) * 100).toFixed(0) : '—';
    var bestTrade  = todayTr.sort(function (a, b) { return (b.pnl_usd || 0) - (a.pnl_usd || 0); })[0];
    var worstTrade = todayTr.sort(function (a, b) { return (a.pnl_usd || 0) - (b.pnl_usd || 0); })[0];

    /* unrealised P&L map */
    var pnlMap = {};
    pnlArr.forEach(function (p) { pnlMap[p.trade_id] = p; });

    /* total unrealised */
    var totalUnreal = pnlArr.reduce(function (s, p) { return s + (p.usd || 0); }, 0);

    /* risk deployed */
    var totalRisk = trades.reduce(function (s, t) { return s + (t.size_usd || 0); }, 0);
    var riskPct   = totalEq > 0 ? Math.min(100, (totalRisk / totalEq * 100)) : 0;

    /* correlations */
    var corrs = _correlations(trades);

    /* rejected signals */
    var rejected = _getRejected();

    /* upcoming events */
    var allEvents = [];
    trades.forEach(function (t) {
      _upcomingEventsForAsset(t.asset, 8).forEach(function (ev) {
        var key = ev.title;
        if (!allEvents.find(function (e) { return e.title === key; })) {
          allEvents.push({ ev: ev, asset: t.asset });
        }
      });
    });

    var html = '';

    /* ── 1. PORTFOLIO SUMMARY ─────────────────────────────────────────── */
    html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:6px;margin-bottom:8px;align-items:center">';

    /* total equity */
    html += '<div style="background:rgba(0,255,136,0.06);border:1px solid rgba(0,255,136,0.2);border-radius:4px;padding:6px 8px">' +
      '<div style="font-size:7px;color:var(--dim);margin-bottom:1px">' + ((window.EE && EE.getConfig && EE.getConfig().mode === 'LIVE') ? 'TOTAL LIVE EQUITY' : 'TOTAL DEMO EQUITY') + '</div>' +
      '<div style="font-size:14px;color:#00ff88;font-weight:bold">' + _fmtUsd(totalEq) + '</div>' +
      '<div style="font-size:7px;color:var(--dim)">USD equivalent</div>' +
      '</div>';

    /* today P&L */
    html += '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:4px;padding:6px 8px">' +
      '<div style="font-size:7px;color:var(--dim);margin-bottom:1px">TODAY\'S P&amp;L</div>' +
      '<div style="font-size:14px;color:' + _pnlColor(todayPnl) + ';font-weight:bold">' + _fmtUsd(todayPnl) + '</div>' +
      '<div style="font-size:7px;color:var(--dim)">Unrealised: <span style="color:' + _pnlColor(totalUnreal) + '">' + _fmtUsd(totalUnreal) + '</span></div>' +
      '</div>';

    /* open positions */
    html += '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:4px;padding:6px 8px">' +
      '<div style="font-size:7px;color:var(--dim);margin-bottom:1px">OPEN POSITIONS</div>' +
      '<div style="font-size:14px;color:var(--bright);font-weight:bold">' + trades.length + ' / ' + (cfg.max_open_trades || '—') + '</div>' +
      '<div style="font-size:7px;color:var(--dim)">Max drawdown: <span style="color:' + (_maxDrawdown > 5 ? '#ff4444' : 'var(--dim)') + '">' + _maxDrawdown.toFixed(1) + '%</span></div>' +
      '</div>';

    /* session stats */
    html += '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:4px;padding:6px 8px">' +
      '<div style="font-size:7px;color:var(--dim);margin-bottom:1px">SESSION STATS</div>' +
      '<div style="font-size:10px;color:var(--bright)">' +
        '<span style="color:#00ff88">' + wins + 'W</span> / ' +
        '<span style="color:#ff4444">' + losses + 'L</span>' +
        (neutral ? ' / <span style="color:var(--dim)">' + neutral + 'N</span>' : '') +
        '  <span style="color:var(--dim);font-size:8px">HR: ' + hitRate + (hitRate !== '—' ? '%' : '') + '</span>' +
      '</div>' +
      '<div style="font-size:7px;color:var(--dim)">' +
        (bestTrade ? 'Best: <span style="color:#00ff88">' + _fmtUsd(bestTrade.pnl_usd) + '</span>' : 'No closed trades') +
      '</div>' +
      '</div>';

    /* master pause */
    html += '<div style="text-align:center">' +
      '<button onclick="LP._togglePause()" style="font-size:8px;padding:4px 10px;cursor:pointer;border-radius:4px;font-family:inherit;' +
        (_pausedByUser
          ? 'border:1px solid #ff4444;background:rgba(255,68,68,0.15);color:#ff4444'
          : 'border:1px solid #ffcc00;background:rgba(255,204,0,0.08);color:#ffcc00') + '">' +
        (_pausedByUser ? '▶ RESUME' : '⏸ PAUSE') +
      '</button>' +
      '<div style="font-size:6px;color:var(--dim);margin-top:2px">Auto-execution</div>' +
      '</div>';

    html += '</div>';

    /* ── 2. BROKER HEALTH STRIP ──────────────────────────────────────── */
    html += '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">';

    function _brokerPill(name, connected, balStr, extra) {
      var dot = connected ? '●' : '○';
      var col = connected ? '#00ff88' : '#555';
      return '<div style="display:flex;align-items:center;gap:5px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:20px;padding:3px 8px;font-size:7px">' +
        '<span style="color:' + col + ';font-size:9px">' + dot + '</span>' +
        '<span style="color:var(--bright)">' + name + '</span>' +
        '<span style="color:var(--dim)">|</span>' +
        '<span style="color:' + (connected ? 'var(--bright)' : 'var(--dim)') + '">' + balStr + '</span>' +
        (extra ? '<span style="color:var(--dim);font-size:6px">' + extra + '</span>' : '') +
        '</div>';
    }

    var oSt  = window.OANDABroker  ? OANDABroker.status()  : {};
    var aSt  = window.AlpacaBroker ? AlpacaBroker.status() : {};
    var ttSt = window.TTBroker     ? TTBroker.status()     : {};

    // If OANDA is connected but account cache not yet populated, trigger a fetch
    // so subsequent renders (10s later) will have the real NAV value.
    if (oSt.connected && oSt.nav == null && window.OANDABroker && OANDABroker.getAccount) {
      OANDABroker.getAccount().catch(function () {});
    }

    html += _brokerPill('OANDA', oSt.connected,
      oSt.connected ? (oSt.nav != null ? '£' + oSt.nav.toFixed(0) : 'Loading…') : 'Disconnected',
      oSt.connected && oSt.nav != null ? '≈$' + (oSt.nav * fx).toFixed(0) : '');

    html += _brokerPill('Alpaca', aSt.connected,
      aSt.connected ? '$' + (aSt.equity || 0).toFixed(0) : 'Disconnected',
      aSt.connected ? 'BP: $' + (aSt.buyingPow || 0).toFixed(0) : '');

    html += _brokerPill('TickTrader', ttSt.connected,
      ttSt.connected ? (ttSt.currency || '') + ' ' + (ttSt.balance || 0) : 'Disconnected',
      ttSt.connected && !ttSt.balance ? 'Unfunded' : '');

    var hlConnected = window.HLFeed && HLFeed.isConnected && HLFeed.isConnected();
    html += _brokerPill('Hyperliquid', hlConnected, hlConnected ? 'Feed live' : 'Feed offline', 'Prices only');

    html += '</div>';

    /* ── 3. RISK GAUGE ───────────────────────────────────────────────── */
    html += '<div style="margin-bottom:8px">' +
      '<div style="display:flex;justify-content:space-between;font-size:7px;color:var(--dim);margin-bottom:2px">' +
      '<span>CAPITAL DEPLOYED  <b style="color:' + (riskPct > 80 ? '#ff4444' : riskPct > 50 ? '#ffcc00' : '#00ff88') + '">' + riskPct.toFixed(0) + '%</b></span>' +
      '<span>' + _fmtUsd(totalRisk) + ' at risk across ' + trades.length + ' positions</span>' +
      '</div>' +
      '<div style="background:rgba(255,255,255,0.06);border-radius:2px;height:5px">' +
      '<div style="width:' + riskPct.toFixed(0) + '%;height:5px;background:' +
        (riskPct > 80 ? '#ff4444' : riskPct > 50 ? '#ffcc00' : '#00ff88') +
        ';border-radius:2px;transition:width 0.5s"></div>' +
      '</div>' +
      '</div>';

    /* correlation warnings */
    if (corrs.length > 0) {
      html += '<div style="margin-bottom:6px">';
      corrs.forEach(function (w) {
        html += '<div style="font-size:7px;color:#ffcc00;background:rgba(255,204,0,0.07);border:1px solid rgba(255,204,0,0.2);border-radius:3px;padding:3px 6px;margin-bottom:2px">' + w + '</div>';
      });
      html += '</div>';
    }

    /* ── 4. OPEN POSITIONS ───────────────────────────────────────────── */
    if (trades.length === 0) {
      html += '<div style="font-size:8px;color:var(--dim);text-align:center;padding:12px;border:1px dashed var(--border);border-radius:4px;margin-bottom:8px">No open positions</div>';
    } else {
      html += '<div style="font-size:8px;color:var(--dim);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Open Positions</div>';
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px;margin-bottom:8px">';

      trades.forEach(function (t) {
        var pnlData   = pnlMap[t.trade_id] || {};
        var pnlUsd    = pnlData.usd || 0;
        var pnlPct    = pnlData.pct || 0;
        var livePrice = _getLivePrice(t.asset);
        var dirColor  = t.direction === 'LONG' ? '#00ff88' : '#ff4444';
        var evWarnings = _upcomingEventsForAsset(t.asset, 4);
        var venueColor = { OANDA:'#3399ff', ALPACA:'#00cc88', TICKTRADER:'#ffaa00', HL:'#cc88ff', SIMULATION:'#888' };

        html += '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:4px;padding:7px 8px;position:relative">';

        /* header row */
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">';
        html += '<div>' +
          '<span style="color:' + dirColor + ';font-size:10px;font-weight:bold">' + t.asset + '</span>' +
          '<span style="color:' + dirColor + ';font-size:7px;margin-left:4px;background:rgba(255,255,255,0.06);padding:0 3px;border-radius:2px">' + t.direction + '</span>' +
          '</div>';
        html += '<div style="display:flex;gap:3px;align-items:center">' +
          '<span style="font-size:6px;color:' + (venueColor[t.venue || t._venue] || '#888') + ';border:1px solid ' + (venueColor[t.venue || t._venue] || '#888') + ';border-radius:2px;padding:0 3px">' + (t.venue || t._venue || 'SIM') + '</span>' +
          '<button onclick="LP._confirmClose(\'' + t.trade_id + '\',\'' + t.asset + '\')" style="font-size:6px;padding:1px 4px;cursor:pointer;border:1px solid #ff4444;background:transparent;color:#ff4444;border-radius:2px;font-family:inherit">✕</button>' +
          '</div>';
        html += '</div>';

        /* P&L row */
        html += '<div style="display:flex;justify-content:space-between;margin-bottom:3px">';
        html += '<div style="font-size:11px;color:' + _pnlColor(pnlUsd) + ';font-weight:bold">' + _fmtUsd(pnlUsd) + '</div>';
        html += '<div style="font-size:8px;color:' + _pnlColor(pnlPct) + '">' + _fmtPct(pnlPct) + '</div>';
        html += '</div>';

        /* price row */
        html += '<div style="font-size:7px;color:var(--dim);margin-bottom:2px">' +
          'Entry: <b style="color:var(--bright)">' + (t.entry_price ? t.entry_price.toFixed(t.entry_price < 10 ? 4 : 2) : '—') + '</b>' +
          ' → Now: <b style="color:' + _pnlColor(pnlUsd) + '">' + (livePrice ? livePrice.toFixed(livePrice < 10 ? 4 : 2) : '—') + '</b>' +
          '</div>';

        /* TP/SL progress bar */
        if (livePrice) html += _progressBar(t, livePrice);

        /* meta row */
        html += '<div style="display:flex;justify-content:space-between;font-size:6px;color:var(--dim);margin-top:4px">';
        html += '<span>⏱ ' + _timeSince(t.timestamp_open) + '</span>';
        html += '<span>' + (t.reason ? t.reason.substring(0, 28) + (t.reason.length > 28 ? '…' : '') : '') + '</span>';
        html += '<span>Conf: ' + (t.confidence || '—') + (t.confidence ? '%' : '') + '</span>';
        html += '</div>';

        /* size */
        html += '<div style="font-size:6px;color:var(--dim);margin-top:2px">Size: ' + _fmtUsd(t.size_usd) + ' · ' + (t.mode || 'SIMULATION') + '</div>';

        /* event warning */
        if (evWarnings.length > 0) {
          var ev = evWarnings[0];
          var evMins = Math.round((new Date(ev.date) - Date.now()) / 60000);
          html += '<div style="font-size:6px;color:#ffcc00;background:rgba(255,204,0,0.07);border-radius:2px;padding:2px 4px;margin-top:4px">' +
            '⚡ ' + ev.title + ' in ' + (evMins < 60 ? evMins + 'm' : Math.round(evMins/60) + 'h') +
            '</div>';
        }

        html += '</div>'; /* end position card */
      });

      html += '</div>';
    }

    /* ── 5. UPCOMING ECONOMIC EVENTS ─────────────────────────────────── */
    var nextEvents = [];
    try {
      if (window.ECON_CALENDAR && ECON_CALENDAR.upcoming) {
        nextEvents = ECON_CALENDAR.upcoming(12).slice(0, 6);
      }
    } catch (e) {}

    if (nextEvents.length > 0) {
      html += '<div style="margin-bottom:8px">';
      html += '<div style="font-size:8px;color:var(--dim);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Upcoming Economic Events (12h)</div>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:4px">';
      nextEvents.forEach(function (ev) {
        var mins = Math.round((new Date(ev.date) - Date.now()) / 60000);
        var timeStr = mins < 60 ? mins + 'm' : Math.round(mins / 60) + 'h';
        var affectsOpen = trades.some(function (t) {
          return _assetCurrencies(t.asset).indexOf(ev.country) !== -1;
        });
        html += '<div style="font-size:7px;padding:2px 6px;border-radius:3px;border:1px solid ' +
          (affectsOpen ? 'rgba(255,204,0,0.4)' : 'var(--border)') + ';background:' +
          (affectsOpen ? 'rgba(255,204,0,0.06)' : 'rgba(255,255,255,0.02)') + ';color:' +
          (affectsOpen ? '#ffcc00' : 'var(--dim)') + '">' +
          ev.country + ' · ' + ev.title + ' <b>in ' + timeStr + '</b>' +
          (affectsOpen ? ' ⚡' : '') +
          '</div>';
      });
      html += '</div></div>';
    }

    /* ── 6. 7-DAY SPARKLINE ──────────────────────────────────────────── */
    html += '<div style="margin-bottom:8px;background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:4px;padding:6px 8px">';
    html += '<div style="font-size:7px;color:var(--dim);margin-bottom:4px">7-DAY CUMULATIVE P&amp;L</div>';
    html += _sparkline(7);
    html += '</div>';

    /* ── 7. REJECTED / SKIPPED SIGNALS ──────────────────────────────── */
    if (rejected.length > 0) {
      html += '<div style="margin-bottom:8px">';
      html += '<div style="font-size:8px;color:var(--dim);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Recently Blocked Signals</div>';
      rejected.forEach(function (t) {
        html += '<div style="font-size:7px;color:var(--dim);background:rgba(255,68,68,0.04);border:1px solid rgba(255,68,68,0.15);border-radius:3px;padding:3px 6px;margin-bottom:2px;display:flex;justify-content:space-between">' +
          '<span><b style="color:#ff8888">' + t.asset + '</b> ' + (t.direction || '') + ' — ' +
            (t.broker_error || t.close_reason || 'Blocked') + '</span>' +
          '<span style="color:var(--dim)">' + _timeSince(t.timestamp_close || t.timestamp_open) + ' ago</span>' +
          '</div>';
      });
      html += '</div>';
    }

    /* ── Footer timestamp ────────────────────────────────────────────── */
    html += '<div style="font-size:6px;color:var(--dim);text-align:right">Refreshed ' + new Date().toLocaleTimeString() + ' · auto every 10s</div>';

    el.innerHTML = html;
  }

  /* ── Public actions ────────────────────────────────────────────────────── */
  window.LP = {
    _togglePause: function () {
      _pausedByUser = !_pausedByUser;
      if (window.EE && EE.setEnabled) {
        EE.setEnabled(!_pausedByUser);
      } else {
        /* fallback: toggle via config */
        try {
          var cfg = EE.getConfig();
          cfg.enabled = !_pausedByUser;
        } catch (e) {}
      }
      render();
    },

    _confirmClose: function (tradeId, asset) {
      if (!confirm('Close ' + asset + ' position now?')) return;
      if (window.EE && EE.manualClose) {
        EE.manualClose(tradeId);
        setTimeout(render, 500);
      }
    }
  };

  /* ── Init ──────────────────────────────────────────────────────────────── */
  function init() {
    render();
    if (_interval) clearInterval(_interval);
    _interval = setInterval(render, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 2000); });
  } else {
    setTimeout(init, 2000);
  }

})();
