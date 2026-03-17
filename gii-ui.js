/* GII UI — gii-ui.js v6
 * GII panel renderer — injects #giiWrap after #eeWrap
 * Depends on: window.GII, window.GII_AGENT_*, window.GII_SCRAPER_MANAGER
 * Exposes: window.GII_UI
 */
(function () {
  'use strict';

  var RENDER_INTERVAL = 15000; // re-render every 15s
  var GII_COLOR       = '#e040fb';
  var GII_DIM         = 'rgba(224,64,251,0.18)';

  // ── inject styles ──────────────────────────────────────────────────────────

  function _injectStyles() {
    if (document.getElementById('gii-styles')) return;
    var s = document.createElement('style');
    s.id = 'gii-styles';
    s.textContent = [
      ':root { --gii: ' + GII_COLOR + '; --gii-dim: ' + GII_DIM + '; }',
      '#giiWrap { font-family: var(--font, "JetBrains Mono", monospace); font-size: 12px;',
      '  background: var(--bg, #0d0d0f); border: 1px solid var(--gii); border-radius: 8px;',
      '  margin: 8px 0; padding: 12px; color: var(--text, #e0e0e0); }',
      '#giiWrap h2 { color: var(--gii); margin: 0 0 8px 0; font-size: 13px; letter-spacing: 1px; }',
      '.gii-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }',
      '.gii-badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; }',
      '.gii-badge-gti { background: var(--gii); color: #000; }',
      '.gii-badge-normal { background: var(--green, #00e676); color: #000; }',
      '.gii-badge-moderate { background: var(--amber, #ffc107); color: #000; }',
      '.gii-badge-high { background: var(--red, #ff1744); color: #fff; }',
      '.gii-badge-extreme { background: #ff0000; color: #fff; animation: gii-pulse 1s infinite; }',
      '@keyframes gii-pulse { 0%,100%{opacity:1} 50%{opacity:0.6} }',
      '.gii-row { display: flex; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; align-items: flex-start; }',
      '.gii-card { background: var(--card-bg, rgba(255,255,255,0.04)); border: 1px solid rgba(224,64,251,0.25);',
      '  border-radius: 6px; padding: 10px; flex: 1; min-width: 180px; }',
      '.gii-card h3 { color: var(--gii); font-size: 11px; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px; }',
      '.gii-table { width: 100%; border-collapse: collapse; font-size: 11px; }',
      '.gii-table th { color: var(--gii); border-bottom: 1px solid rgba(224,64,251,0.3); padding: 3px 6px;',
      '  text-align: left; font-size: 10px; text-transform: uppercase; }',
      '.gii-table td { padding: 3px 6px; border-bottom: 1px solid rgba(255,255,255,0.05); vertical-align: top; }',
      '.gii-table tr:hover td { background: var(--gii-dim); }',
      '.gii-long { color: var(--green, #00e676); }',
      '.gii-short { color: var(--red, #ff1744); }',
      '.gii-neutral { color: var(--amber, #ffc107); }',
      '.gii-conf-bar { display: inline-block; height: 6px; border-radius: 3px; vertical-align: middle;',
      '  background: var(--gii); margin-left: 4px; }',
      '.gii-hormuz-active { color: var(--red, #ff1744); font-weight: 700; }',
      '.gii-hormuz-inactive { color: rgba(255,255,255,0.35); }',
      '.gii-section-title { color: var(--gii); font-size: 11px; text-transform: uppercase;',
      '  letter-spacing: 1px; margin: 8px 0 4px 0; border-bottom: 1px solid rgba(224,64,251,0.2); padding-bottom: 3px; }',
      'canvas.gii-canvas { border: 1px solid rgba(224,64,251,0.20); border-radius: 4px; display: block; }',
      '.gii-ci-bar { display: inline-block; height: 4px; background: rgba(224,64,251,0.35);',
      '  border-radius: 2px; vertical-align: middle; }',
      '.gii-post-hi { color: var(--red, #ff1744); } .gii-post-med { color: var(--amber, #ffc107); }',
      '.gii-post-lo  { color: var(--green, #00e676); }'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── build wrap ─────────────────────────────────────────────────────────────

  function _buildWrap() {
    if (document.getElementById('giiWrap')) return;
    var wrap = document.createElement('div');
    wrap.id = 'giiWrap';
    wrap.innerHTML = '<h2>⬡ GII — Geopolitical Intelligence Interface</h2><div id="giiContent"><p style="color:rgba(255,255,255,0.4)">Initialising…</p></div>';

    // Insert after #eeWrap
    var eeWrap = document.getElementById('eeWrap');
    if (eeWrap && eeWrap.parentNode) {
      eeWrap.parentNode.insertBefore(wrap, eeWrap.nextSibling);
    } else {
      // Fallback — append to body
      document.body.appendChild(wrap);
    }
  }

  // ── GTI arc gauge (canvas) ─────────────────────────────────────────────────

  function _drawGTIGauge(canvas, value, level) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    var cx = W / 2, cy = H * 0.58, r = Math.min(W, H) * 0.38;

    // Background arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Filled arc
    var pct = Math.max(0, Math.min(100, value)) / 100;
    var startAngle = Math.PI * 0.75;
    var endAngle   = startAngle + pct * (Math.PI * 1.5);
    var grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
    grad.addColorStop(0,   '#00e676');
    grad.addColorStop(0.4, '#ffc107');
    grad.addColorStop(0.7, '#ff1744');
    grad.addColorStop(1.0, '#ff0000');
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, endAngle);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 12;
    ctx.stroke();

    // Centre text
    ctx.fillStyle = '#e040fb';
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(value), cx, cy + 8);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '10px monospace';
    ctx.fillText('GTI', cx, cy + 22);
    ctx.fillStyle = level === 'EXTREME' ? '#ff0000' : level === 'HIGH' ? '#ff1744' : level === 'MODERATE' ? '#ffc107' : '#00e676';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(level, cx, cy - r * 0.30);
  }

  // ── GTI line chart (canvas) ────────────────────────────────────────────────

  function _drawGTIChart(canvas, history) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    if (!history || history.length < 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Accumulating history…', W / 2, H / 2);
      return;
    }

    var pad = { t: 6, b: 18, l: 28, r: 6 };
    var pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;

    // Grid lines
    [0, 30, 60, 80, 100].forEach(function (v) {
      var y = pad.t + ph * (1 - v / 100);
      ctx.beginPath();
      ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(v, pad.l - 3, y + 3);
    });

    // Line
    ctx.beginPath();
    history.forEach(function (pt, i) {
      var x = pad.l + (i / (history.length - 1)) * pw;
      var y = pad.t + ph * (1 - Math.max(0, Math.min(100, pt.value)) / 100);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = GII_COLOR;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Fill
    ctx.lineTo(pad.l + pw, pad.t + ph);
    ctx.lineTo(pad.l, pad.t + ph);
    ctx.closePath();
    ctx.fillStyle = 'rgba(224,64,251,0.12)';
    ctx.fill();
  }

  // ── render helpers ─────────────────────────────────────────────────────────

  function _biasClass(bias) {
    if (bias === 'long')    return 'gii-long';
    if (bias === 'short')   return 'gii-short';
    return 'gii-neutral';
  }

  function _posteriorClass(p) {
    if (p >= 0.60) return 'gii-post-hi';
    if (p >= 0.35) return 'gii-post-med';
    return 'gii-post-lo';
  }

  function _pct(v) { return (v * 100).toFixed(0) + '%'; }
  function _esc(s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // ── main render ────────────────────────────────────────────────────────────

  function render() {
    var GII = window.GII;
    var content = document.getElementById('giiContent');
    if (!content || !GII) return;

    var gtiObj   = GII.gti();
    var gti      = gtiObj.value;
    var gtiLevel = gtiObj.level;
    var signals  = GII.signals();
    var history  = GII.gtiHistory();
    var status   = GII.status();

    // ── header row ──
    var levelClass = 'gii-badge-' + gtiLevel.toLowerCase();
    var html = '<div class="gii-header">' +
      '<span class="gii-badge gii-badge-gti">GTI: ' + Math.round(gti) + '</span>' +
      '<span class="gii-badge ' + levelClass + '">' + gtiLevel + '</span>' +
      '<span style="color:rgba(255,255,255,0.5);font-size:11px">▲ ' + signals.length + ' signals</span>' +
      '<span style="color:rgba(255,255,255,0.5);font-size:11px">⬡ ' + status.agentCount + '/8 agents</span>' +
      (status.hormuzActive ? '<span class="gii-badge" style="background:#ff1744;color:#fff">HORMUZ PATTERN</span>' : '') +
      '</div>';

    // ── Row 1: gauge + chart + posteriors ──
    html += '<div class="gii-row">';

    // GTI Gauge card
    html += '<div class="gii-card" style="min-width:140px;max-width:160px">';
    html += '<h3>GTI Gauge</h3>';
    html += '<canvas id="giiGauge" class="gii-canvas" width="140" height="110"></canvas>';
    html += '</div>';

    // GTI Chart card
    html += '<div class="gii-card" style="flex:2;min-width:200px">';
    html += '<h3>60-Min GTI History</h3>';
    html += '<canvas id="giiChart" class="gii-canvas" width="340" height="100"></canvas>';
    html += '</div>';

    // Bayesian posteriors card
    var posteriorRegions = GII.status().posteriorRegions ? _getPosteriorRows() : [];
    html += '<div class="gii-card" style="flex:2;min-width:240px">';
    html += '<h3>Bayesian Posteriors</h3>';
    html += '<table class="gii-table"><thead><tr><th>Region</th><th>Prior</th><th>Post</th><th>CI</th></tr></thead><tbody>';
    if (posteriorRegions.length) {
      posteriorRegions.forEach(function (r) {
        var pClass = _posteriorClass(r.posterior);
        var ciWidth = (r.ci && r.ci.length >= 2) ? Math.round((r.ci[1] - r.ci[0]) * 100) : 0;
        html += '<tr><td>' + _esc(r.region.substring(0, 18)) + '</td>' +
          '<td>' + _pct(r.prior) + '</td>' +
          '<td class="' + pClass + '"><b>' + _pct(r.posterior) + '</b></td>' +
          '<td><span class="gii-ci-bar" style="width:' + ciWidth + 'px"></span> ±' + ciWidth + '%</td>' +
          '</tr>';
      });
    } else {
      html += '<tr><td colspan="4" style="color:rgba(255,255,255,0.3)">Accumulating…</td></tr>';
    }
    html += '</tbody></table></div>';
    html += '</div>'; // end row 1

    // ── Row 2: Agent signals ──
    html += '<p class="gii-section-title">Agent Signals</p>';
    html += '<div class="gii-card">';
    html += '<table class="gii-table"><thead><tr><th>Agent</th><th>Asset</th><th>Bias</th><th>Conf</th><th>Region</th><th>Reasoning</th></tr></thead><tbody>';

    var recentSigs = signals.slice(0, 20);
    if (recentSigs.length) {
      recentSigs.forEach(function (s) {
        var confPct = Math.round((s.confidence || 0) * 100);
        var barW = Math.round(confPct * 0.6);
        var agentAcc = _getAgentAccuracy(s._agentName, s.asset, s.bias);
        html += '<tr>' +
          '<td style="color:var(--gii)">' + _esc(s._agentName || s.source || '—') + '</td>' +
          '<td><b>' + _esc(s.asset || '—') + '</b></td>' +
          '<td class="' + _biasClass(s.bias) + '">' + (s.bias || '—').toUpperCase() + '</td>' +
          '<td>' + confPct + '%<span class="gii-conf-bar" style="width:' + barW + 'px"></span></td>' +
          '<td style="color:rgba(255,255,255,0.6)">' + _esc((s.region || '').substring(0, 16)) + '</td>' +
          '<td style="color:rgba(255,255,255,0.7)">' + _esc((s.reasoning || '').substring(0, 90)) +
          (agentAcc ? ' <span style="color:var(--gii)">[' + agentAcc + ']</span>' : '') + '</td>' +
          '</tr>';
      });
    } else {
      html += '<tr><td colspan="6" style="color:rgba(255,255,255,0.3)">No signals yet — waiting for cycle…</td></tr>';
    }
    html += '</tbody></table></div>';

    // ── Row 3: Polymarket mispricing ──
    html += '<p class="gii-section-title">Polymarket Mispricing Edges</p>';
    html += '<div class="gii-card">';
    var pmAgent = window.GII_AGENT_POLYMARKET;
    var mispricings = [];
    if (pmAgent && typeof pmAgent.mispricings === 'function') {
      try { mispricings = pmAgent.mispricings() || []; } catch (e) {}
    }
    if (mispricings.length) {
      html += '<table class="gii-table"><thead><tr><th>Region</th><th>AI Prob</th><th>PM Prob</th><th>Edge</th><th>Tradeable?</th><th>Market</th></tr></thead><tbody>';
      mispricings.slice(0, 12).forEach(function (m) {
        var edgeClass = m.edge > 0 ? 'gii-long' : 'gii-short';
        var tradeable = m.tradeable ? '<span class="gii-long">YES</span>' : (m.logOnly ? '<span style="color:rgba(255,255,255,0.4)">LOG</span>' : '—');
        html += '<tr>' +
          '<td>' + _esc((m.region || '').substring(0, 16)) + '</td>' +
          '<td>' + (m.aiProb * 100).toFixed(0) + '%</td>' +
          '<td>' + (m.pmYesProb * 100).toFixed(0) + '%</td>' +
          '<td class="' + edgeClass + '"><b>' + (m.edge > 0 ? '+' : '') + (m.edge * 100).toFixed(1) + '%</b></td>' +
          '<td>' + tradeable + '</td>' +
          '<td style="color:rgba(255,255,255,0.6)">' + _esc((m.label || '').substring(0, 50)) + '</td>' +
          '</tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<p style="color:rgba(255,255,255,0.3);margin:4px 0">No PM data yet — waiting for Polymarket agent…</p>';
    }
    html += '</div>';

    // ── Row 4: Hormuz pattern ──
    html += '<p class="gii-section-title">Pre-Event Pattern: Hormuz Crisis</p>';
    html += '<div class="gii-card"><div style="display:flex;gap:20px;flex-wrap:wrap">';
    var hormuzPattern = _getHormuzPattern();
    var hormuzChecks = [
      { key: 'tankerInsurance', label: 'War Risk Insurance (w:3)' },
      { key: 'aisRerouting',    label: 'AIS Rerouting (w:3)' },
      { key: 'navalMovement',   label: 'Naval Concentration (w:2)' },
      { key: 'irgcRhetoric',    label: 'IRGC Rhetoric (w:2)' }
    ];
    hormuzChecks.forEach(function (c) {
      var active = hormuzPattern[c.key];
      html += '<div class="' + (active ? 'gii-hormuz-active' : 'gii-hormuz-inactive') + '">' +
        (active ? '✓ ' : '○ ') + c.label + '</div>';
    });
    html += '</div>';
    html += '<div style="margin-top:6px;color:rgba(255,255,255,0.5)">Pattern score: <b style="color:var(--gii)">' +
      (hormuzPattern.totalScore || 0) + '</b>/10 (threshold: 3)' +
      (status.hormuzActive ? ' — <span class="gii-hormuz-active">ACTIVE</span>' : '') + '</div>';
    html += '</div>';

    // ── Row 5: GII portfolio stats ──
    html += '<p class="gii-section-title">GII Portfolio (Agent-Sourced Trades)</p>';
    html += '<div class="gii-card">';
    var fbData = GII.feedback();
    var totals = _computePortfolioStats(fbData);
    html += '<div style="display:flex;gap:24px;flex-wrap:wrap">' +
      '<div><span style="color:rgba(255,255,255,0.5)">Total trades:</span> <b>' + totals.total + '</b></div>' +
      '<div><span style="color:rgba(255,255,255,0.5)">Win rate:</span> <b class="' + (totals.winRate >= 0.5 ? 'gii-long' : 'gii-short') + '">' + (totals.winRate !== null ? (totals.winRate * 100).toFixed(0) + '%' : 'N/A') + '</b></div>' +
      '<div><span style="color:rgba(255,255,255,0.5)">Agents tracked:</span> <b>' + totals.agentCount + '</b></div>' +
      '</div>';
    html += '</div>';

    // ── Row 6: Per-agent performance breakdown ──
    html += '<p class="gii-section-title">Agent Performance (Self-Learning)</p>';
    html += '<div class="gii-card">';
    var reps = (typeof GII.agentReputations === 'function') ? GII.agentReputations() : {};
    var repKeys = Object.keys(reps);
    if (!repKeys.length) {
      html += '<div style="color:rgba(255,255,255,0.4);font-size:10px">No agent performance data yet — close trades to build history.</div>';
    } else {
      html += '<table style="width:100%;border-collapse:collapse;font-size:10px">' +
        '<thead><tr style="color:rgba(255,255,255,0.45);font-size:9px;text-align:left">' +
        '<th style="padding:3px 8px">Agent / Asset</th>' +
        '<th style="padding:3px 8px">Trades</th>' +
        '<th style="padding:3px 8px">Win Rate</th>' +
        '<th style="padding:3px 8px">FP Rate</th>' +
        '<th style="padding:3px 8px">Reputation</th>' +
        '</tr></thead><tbody>';
      // Sort by reputation desc
      repKeys.sort(function (a, b) {
        return ((reps[b].reputation || 0) - (reps[a].reputation || 0));
      });
      repKeys.slice(0, 20).forEach(function (key) {
        var r = reps[key];
        var wr = r.winRate !== null ? (r.winRate * 100).toFixed(0) + '%' : '—';
        var fpr = typeof r.fpr === 'number' ? (r.fpr * 100).toFixed(0) + '%' : '—';
        var rep = typeof r.reputation === 'number' ? (r.reputation * 100).toFixed(0) + '%' : '—';
        var wrCls = (r.winRate || 0) >= 0.6 ? 'gii-long' : (r.winRate || 0) < 0.4 ? 'gii-short' : '';
        var repCls = (r.reputation || 0) >= 0.6 ? 'gii-long' : (r.reputation || 0) < 0.4 ? 'gii-short' : '';
        // Format key: agentName_asset_bias
        var parts = key.split('_');
        var label = parts[0] + (parts.length > 2 ? ' / ' + parts[1] + ' ' + parts[2] : '');
        html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.06)">' +
          '<td style="padding:4px 8px">' + label + '</td>' +
          '<td style="padding:4px 8px">' + (r.total || 0).toFixed(1) + '</td>' +
          '<td style="padding:4px 8px" class="' + wrCls + '">' + wr + '</td>' +
          '<td style="padding:4px 8px">' + fpr + '</td>' +
          '<td style="padding:4px 8px" class="' + repCls + '">' + rep + '</td>' +
          '</tr>';
      });
      html += '</tbody></table>';
    }
    html += '</div>';

    // ── Row 7: Agent status panel ──
    var AGENT_DEFS = [
      { name: 'energy',        global: 'GII_AGENT_ENERGY'         },
      { name: 'conflict',      global: 'GII_AGENT_CONFLICT'       },
      { name: 'macro',         global: 'GII_AGENT_MACRO'          },
      { name: 'sanctions',     global: 'GII_AGENT_SANCTIONS'      },
      { name: 'maritime',      global: 'GII_AGENT_MARITIME'       },
      { name: 'social',        global: 'GII_AGENT_SOCIAL'         },
      { name: 'polymarket',    global: 'GII_AGENT_POLYMARKET'     },
      { name: 'regime',        global: 'GII_AGENT_REGIME'         },
      { name: 'satellite',     global: 'GII_AGENT_SATELLITE'      },
      { name: 'historical',    global: 'GII_AGENT_HISTORICAL'     },
      { name: 'liquidity',     global: 'GII_AGENT_LIQUIDITY'      },
      { name: 'calendar',      global: 'GII_AGENT_CALENDAR'       },
      { name: 'chokepoint',    global: 'GII_AGENT_CHOKEPOINT'     },
      { name: 'narrative',     global: 'GII_AGENT_NARRATIVE'      },
      { name: 'escalation',    global: 'GII_AGENT_ESCALATION'     },
      { name: 'scenario',      global: 'GII_AGENT_SCENARIO'       },
      { name: 'technicals',    global: 'GII_AGENT_TECHNICALS'     },
      { name: 'scalper',         global: 'GII_AGENT_SCALPER'         },
      { name: 'scalper-session', global: 'GII_AGENT_SCALPER_SESSION' },
      { name: 'optimizer',       global: 'GII_AGENT_OPTIMIZER'       },
      { name: 'smartmoney',      global: 'GII_AGENT_SMARTMONEY'      },
      { name: 'marketstructure', global: 'GII_AGENT_MARKETSTRUCTURE' },
      { name: 'deescalation ⚑', global: 'GII_AGENT_DEESCALATION'   },
      { name: 'risk ⚑',         global: 'GII_AGENT_RISK'           },
      { name: 'entry ✦',         global: 'GII_AGENT_ENTRY'           },
      { name: 'exit ✦',          global: 'GII_AGENT_EXIT'            },
      { name: 'manager ✦',       global: 'GII_AGENT_MANAGER'         }
    ];

    function _relTime(ts) {
      if (!ts) return '—';
      var sec = Math.round((Date.now() - ts) / 1000);
      if (sec < 5)    return 'now';
      if (sec < 60)   return sec + 's ago';
      if (sec < 3600) return Math.round(sec / 60) + 'm ago';
      return Math.round(sec / 3600) + 'h ago';
    }

    html += '<p class="gii-section-title">Agent Status</p>';
    html += '<div class="gii-card">';
    html += '<table class="gii-table" style="font-size:10px"><thead><tr>' +
      '<th>Agent</th><th>Status</th><th>Last Poll</th>' +
      '<th>Signals</th><th>Note</th>' +
      '</tr></thead><tbody>';

    var now = Date.now();
    var staleMs = 10 * 60 * 1000; // 10 min = stale
    AGENT_DEFS.forEach(function (def) {
      var agent = window[def.global];
      if (!agent) {
        html += '<tr>' +
          '<td style="color:rgba(255,255,255,0.4)">' + def.name + '</td>' +
          '<td><span style="color:rgba(255,255,255,0.3)">● MISSING</span></td>' +
          '<td colspan="3" style="color:rgba(255,255,255,0.25)">not loaded</td>' +
          '</tr>';
        return;
      }

      var st = {};
      try { st = agent.status() || {}; } catch (e) { st = { error: String(e) }; }

      var sigs = 0;
      try { sigs = (agent.signals() || []).length; } catch (e) {}

      var lastPoll = st.lastPoll || 0;
      var age = lastPoll ? (now - lastPoll) : Infinity;
      var statusDot, statusLabel;
      if (!lastPoll) {
        statusDot  = '○';
        statusLabel = '<span style="color:rgba(255,255,255,0.35)">○ PENDING</span>';
      } else if (st.error) {
        statusDot  = '●';
        statusLabel = '<span style="color:var(--red,#ff1744)">● ERROR</span>';
      } else if (age > staleMs) {
        statusDot  = '●';
        statusLabel = '<span style="color:var(--amber,#ffc107)">● STALE</span>';
      } else {
        statusDot  = '●';
        statusLabel = '<span style="color:var(--green,#00e676)">● OK</span>';
      }

      var noteText = st.error || st.note || '';
      if (noteText.length > 60) noteText = noteText.substring(0, 57) + '…';

      // Special case: scalper slot busy indicator
      if ((def.name === 'scalper' || def.name === 'scalper-session') && st.activeScalp) {
        noteText = '⚡ Active: ' + (st.activeScalp.asset || 'BTC') + ' ' + (st.activeScalp.bias || '').toUpperCase();
      }
      // Special case: entry agent — show approval stats
      if (def.global === 'GII_AGENT_ENTRY' && st.stats) {
        var eStats = st.stats;
        var passRate = eStats.submitted > 0 ? Math.round(eStats.approved / eStats.submitted * 100) : 0;
        noteText = eStats.approved + ' approved · ' + eStats.vetoed + ' vetoed · ' + passRate + '% pass · queue: ' + (st.queueDepth || 0);
      }
      // Special case: exit agent — show close/trail stats
      if (def.global === 'GII_AGENT_EXIT' && st.stats) {
        var xStats = st.stats;
        noteText = xStats.closed + ' closed · ' + xStats.tightened + ' trailing · ' + xStats.extended + ' TP extended · checked: ' + xStats.checked;
      }
      // Special case: manager — show active alert count
      if (def.global === 'GII_AGENT_MANAGER') {
        try {
          var mgrAlerts = GII_AGENT_MANAGER.alerts();
          noteText = mgrAlerts.length === 0 ? 'No active alerts' : mgrAlerts.length + ' active alert' + (mgrAlerts.length !== 1 ? 's' : '');
        } catch (e) {}
      }

      html += '<tr>' +
        '<td style="color:var(--gii)">' + def.name + '</td>' +
        '<td>' + statusLabel + '</td>' +
        '<td style="color:rgba(255,255,255,0.6)">' + _relTime(lastPoll) + '</td>' +
        '<td style="text-align:center">' + (sigs > 0 ? '<b style="color:var(--green,#00e676)">' + sigs + '</b>' : '<span style="color:rgba(255,255,255,0.3)">0</span>') + '</td>' +
        '<td style="color:rgba(255,255,255,0.5);max-width:200px;overflow:hidden">' + _esc(noteText) + '</td>' +
        '</tr>';
    });

    // Summary row
    var loaded  = AGENT_DEFS.filter(function (d) { return !!window[d.global]; }).length;
    var healthy = AGENT_DEFS.filter(function (d) {
      var a = window[d.global];
      if (!a) return false;
      try {
        var s = a.status() || {};
        return !s.error && s.lastPoll && (now - s.lastPoll) < staleMs;
      } catch (e) { return false; }
    }).length;
    html += '<tr style="border-top:1px solid rgba(224,64,251,0.3)">' +
      '<td colspan="2" style="color:var(--gii);font-weight:700;padding-top:6px">' +
        loaded + '/' + AGENT_DEFS.length + ' loaded</td>' +
      '<td colspan="3" style="color:rgba(255,255,255,0.5);padding-top:6px">' +
        healthy + ' healthy · ' + (loaded - healthy) + ' pending/stale</td>' +
      '</tr>';
    html += '</tbody></table>';
    html += '</div>';

    // ── System Health panel (from GII_AGENT_MANAGER) ──
    html += _renderHealthPanel();

    // ── Scraper Manager panel ──
    html += _renderScraperManager();

    // Inject
    content.innerHTML = html;

    // Draw canvases
    var gauge = document.getElementById('giiGauge');
    if (gauge) _drawGTIGauge(gauge, gti, gtiLevel);

    var chart = document.getElementById('giiChart');
    if (chart) _drawGTIChart(chart, history);
  }

  // ── data helpers ───────────────────────────────────────────────────────────

  function _getPosteriorRows() {
    var GII = window.GII;
    if (!GII) return [];
    var st = GII.status();
    if (!st || !st.posteriorRegions) return [];

    // Reconstruct from GII.posterior for each known region
    var IC = window.__IC;
    var regions = [];
    if (IC && IC.regionStates) {
      Object.keys(IC.regionStates).forEach(function (r) {
        var p = GII.posterior(r);
        if (p) regions.push(p);
      });
    }
    // Also include GLOBAL
    var gGlobal = GII.posterior('GLOBAL');
    if (gGlobal) regions.push(gGlobal);

    // Sort by posterior desc
    regions.sort(function (a, b) { return b.posterior - a.posterior; });
    return regions.slice(0, 10);
  }

  function _getHormuzPattern() {
    var maritime = window.GII_AGENT_MARITIME;
    if (!maritime) return { tankerInsurance: false, aisRerouting: false, navalMovement: false, irgcRhetoric: false, totalScore: 0 };
    try { return maritime.getHormuzPattern(); } catch (e) {
      return { tankerInsurance: false, aisRerouting: false, navalMovement: false, irgcRhetoric: false, totalScore: 0 };
    }
  }

  function _getAgentAccuracy(agentName, asset, bias) {
    var GII = window.GII;
    if (!GII) return null;
    var fb = GII.feedback();
    var key = agentName + '_' + (asset || '') + '_' + (bias || '');
    var entry = fb[key];
    if (!entry || !entry.total) return null;
    return (entry.winRate * 100).toFixed(0) + '% acc (' + entry.total + ')';
  }

  function _computePortfolioStats(feedback) {
    var total = 0, correct = 0, agentSet = {};
    Object.keys(feedback).forEach(function (key) {
      var parts = key.split('_');
      if (parts.length >= 1) agentSet[parts[0]] = true;
      var fb = feedback[key];
      if (fb) { total += fb.total || 0; correct += fb.correct || 0; }
    });
    return {
      total: total,
      correct: correct,
      winRate: total > 0 ? correct / total : null,
      agentCount: Object.keys(agentSet).length
    };
  }

  // ── public API ─────────────────────────────────────────────────────────────

  window.GII_UI = {
    render: render
  };

  // ── init ───────────────────────────────────────────────────────────────────

  // ── Scraper Manager panel ───────────────────────────────────────────────

  function _renderScraperManager() {
    var sm = window.GII_SCRAPER_MANAGER;
    var html = '<p class="gii-section-title">Dynamic Scraper Manager</p>';
    html += '<div class="gii-card">';

    if (!sm) {
      html += '<span style="color:rgba(255,255,255,0.3)">Scraper manager not loaded yet…</span></div>';
      return html;
    }

    var st, volt, scr;
    try { st   = sm.status()     || {}; } catch (e) { st = {}; }
    try { volt = sm.volatility() || {}; } catch (e) { volt = {}; }
    try { scr  = sm.scrapers()   || []; } catch (e) { scr = []; }

    var active   = scr.filter(function (s) { return !s.retired; });
    var retired  = scr.filter(function (s) { return  s.retired; });
    var lastPoll = st.lastPoll || 0;
    var ageText  = lastPoll
      ? (function () {
          var sec = Math.round((Date.now() - lastPoll) / 1000);
          if (sec < 5)    return 'just now';
          if (sec < 60)   return sec + 's ago';
          if (sec < 3600) return Math.round(sec / 60) + 'm ago';
          return Math.round(sec / 3600) + 'h ago';
        })()
      : 'pending first scan';

    // Summary bar
    html += '<div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:10px;align-items:center">';
    html += '<div><span style="color:rgba(255,255,255,0.45)">Active scrapers:</span> ' +
            '<b style="color:var(--green,' + (active.length > 0 ? '#00e676' : '#666') + ')">' +
            active.length + ' / ' + (st.maxActive || 5) + '</b></div>';
    html += '<div><span style="color:rgba(255,255,255,0.45)">Watchlist:</span> ' +
            '<b>' + (st.watchlist || 9) + ' assets</b></div>';
    html += '<div><span style="color:rgba(255,255,255,0.45)">Total spawned:</span> ' +
            '<b>' + (st.totalSpawned || 0) + '</b></div>';
    html += '<div><span style="color:rgba(255,255,255,0.45)">Total signals:</span> ' +
            '<b>' + (st.totalSignals || 0) + '</b></div>';
    html += '<div><span style="color:rgba(255,255,255,0.45)">Scan:</span> ' +
            '<b style="color:rgba(255,255,255,0.7)">' + ageText + '</b></div>';
    html += '</div>';

    // Volatility bar chart
    var voltKeys = Object.keys(volt);
    if (voltKeys.length) {
      html += '<div style="margin-bottom:10px">';
      html += '<div style="color:rgba(255,255,255,0.45);font-size:10px;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px">Volatility (15-min Δ%)</div>';
      html += '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end">';
      var watchThresholds = {
        XAU: 0.4, WTI: 0.5, SILVER: 0.5, ETH: 1.0,
        SOL: 1.2, XRP: 1.2, NVDA: 0.6, TSLA: 0.8, SPY: 0.3
      };
      voltKeys.forEach(function (asset) {
        var v = volt[asset] || 0;
        var thresh = watchThresholds[asset] || 0.5;
        var spiking = v >= thresh;
        var barPct  = Math.min(100, Math.round((v / (thresh * 3)) * 100));
        var barCol  = spiking ? 'var(--red,#ff1744)' : v > thresh * 0.6 ? 'var(--amber,#ffc107)' : 'rgba(255,255,255,0.25)';
        var hasInst = active.some(function (s) { return s.asset === asset; });
        html += '<div style="display:flex;flex-direction:column;align-items:center;gap:2px;min-width:36px">';
        // Bar
        html += '<div style="width:28px;height:40px;background:rgba(255,255,255,0.06);' +
                'border-radius:3px;position:relative;overflow:hidden">';
        html += '<div style="position:absolute;bottom:0;left:0;right:0;height:' + barPct + '%;' +
                'background:' + barCol + ';border-radius:2px;transition:height 0.4s"></div>';
        html += '</div>';
        // Value label
        html += '<div style="font-size:9px;color:' + (spiking ? 'var(--red,#ff1744)' : 'rgba(255,255,255,0.5)') + ';font-weight:' + (spiking ? '700' : '400') + '">' +
                v.toFixed(2) + '%</div>';
        // Ticker + optional ⚡
        html += '<div style="font-size:9px;color:' + (hasInst ? 'var(--gii)' : 'rgba(255,255,255,0.45)') + ';font-weight:700">' +
                (hasInst ? '⚡' : '') + asset + '</div>';
        html += '</div>';
      });
      html += '</div>';
      html += '<div style="font-size:9px;color:rgba(255,255,255,0.3);margin-top:4px">⚡ = active scraper running · bars turn red when spike threshold met</div>';
      html += '</div>';
    } else {
      html += '<div style="color:rgba(255,255,255,0.35);font-size:10px;margin-bottom:10px">Volatility data pending first scan (≈2 min after page load)…</div>';
    }

    // Active instances table
    if (active.length) {
      html += '<div style="margin-bottom:8px">';
      html += '<div style="color:rgba(255,255,255,0.45);font-size:10px;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px">Active Scraper Instances</div>';
      html += '<table class="gii-table" style="font-size:10px"><thead><tr>' +
              '<th>Asset</th><th>Sector</th><th>Spawn Reason</th><th>Signals</th>' +
              '<th>Last Poll</th><th>Score</th><th>Slot</th>' +
              '</tr></thead><tbody>';
      active.forEach(function (inst) {
        var age = inst.lastPollAt
          ? (function () {
              var s = Math.round((Date.now() - inst.lastPollAt) / 1000);
              if (s < 60) return s + 's';
              return Math.round(s / 60) + 'm';
            })()
          : '—';
        var scoreCol = (inst.score || 0) >= 0.6 ? 'var(--green,#00e676)'
                     : (inst.score || 0) >= 0.35 ? 'var(--amber,#ffc107)' : 'var(--red,#ff1744)';
        var slotBadge = inst.activeSlot
          ? '<span style="color:var(--amber,#ffc107)">⚡ ' + (inst.activeSlot.bias || 'LIVE').toUpperCase() + '</span>'
          : '<span style="color:rgba(255,255,255,0.3)">free</span>';
        html += '<tr>' +
          '<td style="color:var(--gii);font-weight:700">' + _esc(inst.asset) + '</td>' +
          '<td style="color:rgba(255,255,255,0.6)">' + _esc(inst.sector || '—') + '</td>' +
          '<td style="color:rgba(255,255,255,0.5);max-width:140px;overflow:hidden">' + _esc((inst.spawnReason || '').substring(0, 30)) + '</td>' +
          '<td style="text-align:center">' + (inst.signalCount > 0 ? '<b style="color:var(--green,#00e676)">' + inst.signalCount + '</b>' : '<span style="color:rgba(255,255,255,0.3)">0</span>') + '</td>' +
          '<td style="color:rgba(255,255,255,0.5)">' + age + ' ago</td>' +
          '<td style="color:' + scoreCol + ';font-weight:700">' + ((inst.score || 0) * 100).toFixed(0) + '</td>' +
          '<td>' + slotBadge + '</td>' +
          '</tr>';
      });
      html += '</tbody></table></div>';
    } else if (lastPoll) {
      html += '<div style="color:rgba(255,255,255,0.35);font-size:10px;margin-bottom:8px">' +
              'No active scrapers — waiting for a volatility spike on any watched asset.</div>';
    }

    // Retired instances (compact summary)
    if (retired.length) {
      html += '<div style="border-top:1px solid rgba(255,255,255,0.07);padding-top:8px;margin-top:4px">';
      html += '<div style="color:rgba(255,255,255,0.3);font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Recently Retired</div>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
      retired.slice(-8).reverse().forEach(function (inst) {
        var col = (inst.score || 0) >= 0.5 ? 'rgba(255,255,255,0.4)' : 'var(--red,#ff1744)';
        html += '<span style="font-size:9px;color:' + col + ';background:rgba(255,255,255,0.04);' +
                'border-radius:3px;padding:1px 5px" title="' + _esc(inst.retiredReason || '') + '">' +
                _esc(inst.asset) + ' · ' + (inst.signalCount || 0) + ' sigs</span>';
      });
      html += '</div></div>';
    }

    html += '</div>';
    return html;
  }

  // ── Health panel renderer ───────────────────────────────────────────────

  function _renderHealthPanel() {
    var mgr = window.GII_AGENT_MANAGER;
    var html = '<p class="gii-section-title">System Health</p>';
    html += '<div class="gii-card">';

    if (!mgr) {
      html += '<span style="color:rgba(255,255,255,0.3)">Manager agent not loaded yet…</span>';
      html += '</div>';
      return html;
    }

    var st      = mgr.status();
    var alerts  = mgr.alerts();
    var report  = mgr.healthReport();

    /* Overall status badge */
    var ovColour = st.overallHealth === 'ok'    ? 'var(--green)'
                 : st.overallHealth === 'warn'   ? 'var(--amber)'
                 : st.overallHealth === 'error'  ? 'var(--red)'
                 : 'rgba(255,255,255,0.3)';
    var ovLabel  = st.overallHealth === 'ok'    ? '● ALL SYSTEMS OK'
                 : st.overallHealth === 'warn'   ? '▲ ' + st.warnings + ' WARNING' + (st.warnings !== 1 ? 'S' : '')
                 : st.overallHealth === 'error'  ? '✖ ' + st.errors + ' ERROR' + (st.errors !== 1 ? 'S' : '')
                 : '○ PENDING FIRST CHECK';

    html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">';
    html += '<span style="color:' + ovColour + ';font-weight:700;letter-spacing:1px">' + ovLabel + '</span>';
    if (st.lastCheck) {
      var ageMin = Math.round((Date.now() - st.lastCheck) / 60000);
      html += '<span style="color:rgba(255,255,255,0.3);font-size:10px">last check ' +
              (ageMin < 1 ? 'just now' : ageMin + 'min ago') + ' · ' + st.checkCount + ' runs</span>';
    }
    html += '</div>';

    /* Per-agent dot grid */
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">';
    var agentNames = Object.keys(report.agents);
    if (agentNames.length === 0) {
      html += '<span style="color:rgba(255,255,255,0.3);font-size:10px">Waiting for first health check…</span>';
    } else {
      agentNames.forEach(function (name) {
        var h   = report.agents[name];
        var col = h.status === 'ok'    ? 'var(--green)'
                : h.status === 'warn'  ? 'var(--amber)'
                : h.status === 'error' ? 'var(--red)'
                : 'rgba(255,255,255,0.3)';
        var shortName = name.replace('GII_AGENT_', '').replace('_SESSION', '-SES').toLowerCase();
        html += '<span title="' + _esc(h.message) + '" style="' +
                'display:inline-flex;align-items:center;gap:4px;' +
                'background:rgba(255,255,255,0.05);border-radius:3px;padding:2px 6px;' +
                'font-size:10px;cursor:default">' +
                '<span style="color:' + col + '">●</span>' +
                '<span style="color:rgba(255,255,255,0.7)">' + shortName + '</span>' +
                '</span>';
      });
    }
    html += '</div>';

    /* Active alerts list */
    if (alerts.length) {
      html += '<div style="border-top:1px solid rgba(255,255,255,0.07);padding-top:8px">';
      alerts.slice(0, 8).forEach(function (a) {
        var col = a.severity === 'error' ? 'var(--red)' : 'var(--amber)';
        var icon = a.severity === 'error' ? '✖' : '▲';
        html += '<div style="display:flex;gap:8px;margin-bottom:4px;font-size:10px">' +
                '<span style="color:' + col + ';flex-shrink:0">' + icon + '</span>' +
                '<span style="color:rgba(255,255,255,0.5);flex-shrink:0">' + a.time + '</span>' +
                '<span style="color:rgba(255,255,255,0.4);flex-shrink:0">' +
                  a.agent.replace('GII_AGENT_', '').toLowerCase() + '</span>' +
                '<span style="color:rgba(255,255,255,0.8)">' + _esc(a.message) + '</span>' +
                '</div>';
      });
      if (alerts.length > 8) {
        html += '<div style="color:rgba(255,255,255,0.3);font-size:10px">+ ' +
                (alerts.length - 8) + ' more alerts</div>';
      }
      html += '</div>';
    } else if (st.checkCount > 0) {
      html += '<div style="color:rgba(255,255,255,0.3);font-size:10px;border-top:1px solid rgba(255,255,255,0.07);padding-top:6px">' +
              'No active alerts</div>';
    }

    /* Entry / Exit agent stats row */
    var entrySt = window.GII_AGENT_ENTRY ? (function(){try{return GII_AGENT_ENTRY.status();}catch(e){return null;}})() : null;
    var exitSt  = window.GII_AGENT_EXIT  ? (function(){try{return GII_AGENT_EXIT.status();}catch(e){return null;}})()  : null;
    if (entrySt || exitSt) {
      html += '<div style="display:flex;gap:16px;border-top:1px solid rgba(255,255,255,0.07);padding-top:8px;margin-top:6px;flex-wrap:wrap">';
      if (entrySt) {
        var eStats = entrySt.stats || {};
        var approvalRate = eStats.submitted > 0 ? Math.round((eStats.approved / eStats.submitted) * 100) : 0;
        html += '<div style="font-size:10px">' +
                '<span style="color:rgba(255,255,255,0.4)">ENTRY</span> ' +
                '<span style="color:var(--green)">' + (eStats.approved||0) + ' approved</span> · ' +
                '<span style="color:rgba(255,255,255,0.4)">' + (eStats.rejected||0) + ' filtered</span> · ' +
                '<span style="color:rgba(255,255,255,0.4)">' + (eStats.vetoed||0) + ' vetoed</span> · ' +
                '<span style="color:var(--amber)">' + approvalRate + '% pass rate</span>' +
                '</div>';
      }
      if (exitSt) {
        var xStats = exitSt.stats || {};
        html += '<div style="font-size:10px">' +
                '<span style="color:rgba(255,255,255,0.4)">EXIT</span> ' +
                '<span style="color:var(--red)">' + (xStats.closed||0) + ' closed</span> · ' +
                '<span style="color:var(--amber)">' + (xStats.tightened||0) + ' trailing</span> · ' +
                '<span style="color:var(--green)">' + (xStats.extended||0) + ' TP extended</span>' +
                '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  window.addEventListener('load', function () {
    setTimeout(function () {
      _injectStyles();
      _buildWrap();
      // Initial render after GII core has had time to run one cycle
      setTimeout(render, 8000);
      setInterval(render, RENDER_INTERVAL);
    }, 7500);
  });

})();
