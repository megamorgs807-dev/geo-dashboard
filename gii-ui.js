/* GII UI — gii-ui.js v1
 * GII panel renderer — injects #giiWrap after #eeWrap
 * Depends on: window.GII, window.GII_AGENT_*
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
        var ciWidth = Math.round((r.ci[1] - r.ci[0]) * 100);
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
