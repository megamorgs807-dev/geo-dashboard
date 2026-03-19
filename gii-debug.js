/* GII Debug Panel — gii-debug.js v1
 *
 * Standalone monitoring panel — additive only, modifies nothing existing.
 * Injects a collapsible panel below #giiWrap showing:
 *   • Agent health grid  — last poll, signal count, errors per agent
 *   • System status      — GTI, cycle, posteriors, convergence, meta score
 *   • Activity log       — intercepts [GII *] console messages in real time
 *
 * Auto-refreshes every 10s. Collapsed by default.
 * Exposes: window.GII_DEBUG (for console inspection)
 */
(function () {
  'use strict';

  var REFRESH_MS   = 10000;
  var MAX_LOG_ROWS = 80;
  var PANEL_ID     = 'giiDebugWrap';

  // All 32 known agents (signal agents + opposition agents + coordination layer + infrastructure)
  // ✦ = coordination  ⚑ = opposition  ⬡ = infrastructure (no Bayesian contribution)
  var KNOWN_AGENTS = [
    { key: 'GII_AGENT_ENERGY',           label: 'energy'          },
    { key: 'GII_AGENT_CONFLICT',         label: 'conflict'        },
    { key: 'GII_AGENT_MACRO',            label: 'macro'           },
    { key: 'GII_AGENT_SANCTIONS',        label: 'sanctions'       },
    { key: 'GII_AGENT_MARITIME',         label: 'maritime'        },
    { key: 'GII_AGENT_SOCIAL',           label: 'social'          },
    { key: 'GII_AGENT_POLYMARKET',       label: 'polymarket'      },
    { key: 'GII_AGENT_REGIME',           label: 'regime'          },
    { key: 'GII_AGENT_SATELLITE',        label: 'satellite'       },
    { key: 'GII_AGENT_HISTORICAL',       label: 'historical'      },
    { key: 'GII_AGENT_LIQUIDITY',        label: 'liquidity'       },
    { key: 'GII_AGENT_CALENDAR',         label: 'calendar'        },
    { key: 'GII_AGENT_CHOKEPOINT',       label: 'chokepoint'      },
    { key: 'GII_AGENT_NARRATIVE',        label: 'narrative'       },
    { key: 'GII_AGENT_ESCALATION',       label: 'escalation'      },
    { key: 'GII_AGENT_SCENARIO',         label: 'scenario'        },
    { key: 'GII_AGENT_TECHNICALS',       label: 'technicals'      },
    { key: 'GII_AGENT_SCALPER',          label: 'scalper'         },
    { key: 'GII_AGENT_SCALPER_SESSION',  label: 'scalper-ses'     },
    { key: 'GII_AGENT_OPTIMIZER',        label: 'optimizer'       },
    { key: 'GII_AGENT_SMARTMONEY',       label: 'smartmoney'      },
    { key: 'GII_AGENT_MARKETSTRUCTURE',  label: 'mktstructure'    },
    { key: 'GII_AGENT_DEESCALATION',     label: 'deescalation ⚑'  },
    { key: 'GII_AGENT_RISK',             label: 'risk ⚑'          },
    { key: 'GII_AGENT_ENTRY',            label: 'entry ✦'         },
    { key: 'GII_AGENT_EXIT',             label: 'exit ✦'          },
    { key: 'GII_AGENT_MANAGER',          label: 'manager ✦'       },
    { key: 'GII_AGENT_PORTFOLIO',        label: 'portfolio ⬡'     },
    { key: 'GII_ROUTING',                label: 'routing ⬡'       },
    { key: 'GII_SCRAPER_MANAGER',        label: 'scraper-mgr ⬡'   },
    { key: 'UWIntel',                    label: 'uw-intel ⬡'      },
    { key: 'AlpacaBroker',               label: 'alpaca ⬡'        }
  ];

  // ── activity log ──────────────────────────────────────────────────────────
  // Intercept console methods to capture [GII *] prefixed messages

  var _log = [];   // [{ ts, level, msg }]

  function _tap(level, orig) {
    return function () {
      orig.apply(console, arguments);
      var msg = Array.prototype.slice.call(arguments).join(' ');
      if (msg.indexOf('[GII') !== -1 || msg.indexOf('[EE]') !== -1) {
        _log.push({ ts: Date.now(), level: level, msg: msg });
        if (_log.length > MAX_LOG_ROWS) _log.shift();
      }
    };
  }

  // Patch console once
  try {
    console.log   = _tap('log',  console.log);
    console.info  = _tap('info', console.info);
    console.warn  = _tap('warn', console.warn);
    console.error = _tap('err',  console.error);
  } catch (e) {}

  // ── helpers ───────────────────────────────────────────────────────────────

  function _ago(ts) {
    if (!ts) return '—';
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 60)   return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  function _esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function _agentStatus(agentKey) {
    var agent = window[agentKey];
    if (!agent) return { loaded: false };
    try {
      var st = agent.status() || {};
      var sigs = agent.signals() || [];
      var now = Date.now();
      var lastPoll = st.lastPoll || 0;
      var age = lastPoll ? now - lastPoll : Infinity;
      var hasError = !!(st.error);
      var health = hasError ? 'err'
                 : age > 600000 ? 'warn'   // >10 min since last poll
                 : age > 120000 ? 'ok-old' // >2 min
                 : 'ok';
      return {
        loaded:   true,
        health:   health,
        lastPoll: lastPoll,
        signals:  sigs.length,
        error:    st.error || null,
        note:     st.note  || null,
        phase:    st.phase || null
      };
    } catch (e) {
      return { loaded: true, health: 'err', error: String(e.message || e) };
    }
  }

  // ── CSS ───────────────────────────────────────────────────────────────────

  function _injectStyles() {
    if (document.getElementById('gii-debug-styles')) return;
    var s = document.createElement('style');
    s.id = 'gii-debug-styles';
    s.textContent = [
      '#' + PANEL_ID + ' { font-family: monospace; font-size: 12px; color: #c9d1d9;',
      '  background: #0d1117; border-top: 1px solid #30363d;',
      '  margin-top: 8px; padding: 0; }',

      '#giiDebugHeader { display:flex; align-items:center; justify-content:space-between;',
      '  padding: 8px 14px; background: #161b22; border-bottom: 1px solid #30363d;',
      '  cursor: pointer; user-select: none; }',
      '#giiDebugHeader:hover { background: #1c2128; }',
      '#giiDebugTitle { font-size: 11px; font-weight: 700; letter-spacing: 1px;',
      '  color: #8b949e; text-transform: uppercase; }',
      '#giiDebugToggle { font-size: 11px; color: #58a6ff; cursor:pointer; }',

      '#giiDebugBody { padding: 12px 14px; display: none; }',
      '#giiDebugBody.open { display: block; }',

      '.gii-dbg-section { margin-bottom: 16px; }',
      '.gii-dbg-section-title { font-size: 10px; font-weight:700; letter-spacing:1.5px;',
      '  text-transform:uppercase; color:#8b949e; border-bottom:1px solid #21262d;',
      '  padding-bottom:4px; margin-bottom:8px; }',

      '.gii-dbg-grid { display: flex; flex-wrap: wrap; gap: 5px; }',
      '.gii-dbg-agent { display:flex; align-items:center; gap:4px;',
      '  background:#161b22; border:1px solid #30363d; border-radius:4px;',
      '  padding: 4px 8px; font-size: 11px; min-width: 130px; }',
      '.gii-dbg-agent .dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }',
      '.dot-ok      { background: #3fb950; }',
      '.dot-ok-old  { background: #d29922; }',
      '.dot-warn    { background: #d29922; }',
      '.dot-err     { background: #f85149; }',
      '.dot-off     { background: #484f58; }',
      '.gii-dbg-agent .name { color:#e6edf3; font-weight:600; }',
      '.gii-dbg-agent .detail { color:#8b949e; margin-left:auto; font-size:10px; }',

      '.gii-dbg-stats { display:flex; flex-wrap:wrap; gap:12px; }',
      '.gii-dbg-stat { background:#161b22; border:1px solid #30363d; border-radius:4px;',
      '  padding:6px 12px; }',
      '.gii-dbg-stat .lbl { font-size:10px; color:#8b949e; text-transform:uppercase; letter-spacing:0.5px; }',
      '.gii-dbg-stat .val { font-size:16px; font-weight:700; color:#e6edf3; margin-top:2px; }',
      '.gii-dbg-stat .val.green { color:#3fb950; }',
      '.gii-dbg-stat .val.amber { color:#d29922; }',
      '.gii-dbg-stat .val.red   { color:#f85149; }',

      '#giiDebugLog { background:#010409; border:1px solid #21262d; border-radius:4px;',
      '  padding:8px; max-height:200px; overflow-y:auto; }',
      '.gii-log-row { padding:1px 0; border-bottom:1px solid #0d1117; white-space:pre-wrap; word-break:break-all; }',
      '.gii-log-row .ts { color:#484f58; margin-right:6px; }',
      '.gii-log-row.info  .msg { color:#79c0ff; }',
      '.gii-log-row.warn  .msg { color:#e3b341; }',
      '.gii-log-row.err   .msg { color:#f85149; }',
      '.gii-log-row.log   .msg { color:#8b949e; }',

      '#giiDebugRefresh { font-size:10px; color:#484f58; float:right; }'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── build HTML ────────────────────────────────────────────────────────────

  function _renderAgentGrid() {
    var html = '<div class="gii-dbg-section">';
    html += '<div class="gii-dbg-section-title">Agent Health</div>';
    html += '<div class="gii-dbg-grid">';

    var healthy = 0, errored = 0, offline = 0;

    KNOWN_AGENTS.forEach(function (a) {
      var st = _agentStatus(a.key);
      var dotClass, title;

      if (!st.loaded) {
        dotClass = 'dot-off'; offline++;
        title = 'Not loaded';
      } else if (st.health === 'err') {
        dotClass = 'dot-err'; errored++;
        title = st.error || 'Error';
      } else if (st.health === 'warn' || st.health === 'ok-old') {
        dotClass = 'dot-warn';
        healthy++;
        title = 'Last poll: ' + _ago(st.lastPoll);
      } else {
        dotClass = 'dot-ok'; healthy++;
        title = 'OK — ' + _ago(st.lastPoll);
      }

      var detail = st.loaded
        ? (st.phase ? st.phase.slice(0, 18) : _ago(st.lastPoll))
        : 'offline';

      var sigBadge = (st.loaded && st.signals > 0)
        ? ' <span style="color:#3fb950">+' + st.signals + '</span>' : '';

      html += '<div class="gii-dbg-agent" title="' + _esc(title) + '">';
      html += '<span class="dot ' + dotClass + '"></span>';
      html += '<span class="name">' + _esc(a.label) + sigBadge + '</span>';
      html += '<span class="detail">' + _esc(detail) + '</span>';
      html += '</div>';
    });

    html += '</div>';
    html += '<div style="font-size:10px;color:#8b949e;margin-top:6px;">';
    html += '✅ ' + healthy + ' healthy &nbsp; ⚠️ ' + errored + ' errors &nbsp; ⬛ ' + offline + ' offline';
    html += '</div>';
    html += '</div>';
    return { html: html, healthy: healthy, errored: errored };
  }

  function _renderSystemStats() {
    var html = '<div class="gii-dbg-section">';
    html += '<div class="gii-dbg-section-title">System Status</div>';
    html += '<div class="gii-dbg-stats">';

    var gii = window.GII;

    // GTI
    var gti = 0, gtiLevel = 'N/A';
    try { gti = gii.gti(); gtiLevel = gii.status().gtiLevel || ''; } catch (e) {}
    var gtiColor = gti >= 80 ? 'red' : gti >= 60 ? 'amber' : 'green';
    html += '<div class="gii-dbg-stat"><div class="lbl">GTI</div><div class="val ' + gtiColor + '">' + gti + '</div></div>';

    // Total signals
    var totalSigs = 0;
    try { totalSigs = (gii.signals() || []).length; } catch (e) {}
    html += '<div class="gii-dbg-stat"><div class="lbl">Signals</div><div class="val">' + totalSigs + '</div></div>';

    // Posteriors
    var posteriorCount = 0;
    try {
      var ps = gii.posteriors ? gii.posteriors() : gii.status().posteriorCount;
      posteriorCount = typeof ps === 'object' ? Object.keys(ps).length : (ps || 0);
    } catch (e) {}
    html += '<div class="gii-dbg-stat"><div class="lbl">Posteriors</div><div class="val">' + posteriorCount + '</div></div>';

    // Meta coordination score
    var metaScore = '—';
    try {
      var ms = GII_META.status();
      if (ms) metaScore = Math.round(ms.coordinationScore * 100) + '%';
    } catch (e) {}
    html += '<div class="gii-dbg-stat"><div class="lbl">Coordination</div><div class="val">' + metaScore + '</div></div>';

    // Convergence
    var convLevel = '—';
    try {
      var st = gii.status();
      if (st && st.convergence) {
        var keys = Object.keys(st.convergence);
        convLevel = keys.length > 0 ? keys.length + ' regions' : 'none';
      }
    } catch (e) {}
    html += '<div class="gii-dbg-stat"><div class="lbl">Convergence</div><div class="val">' + _esc(convLevel) + '</div></div>';

    // Last cycle
    var lastCycle = '—';
    try { var lst = gii.status(); if (lst && lst.lastCycle) lastCycle = _ago(lst.lastCycle); } catch (e) {}
    html += '<div class="gii-dbg-stat"><div class="lbl">Last Cycle</div><div class="val" style="font-size:13px">' + lastCycle + '</div></div>';

    // Conflicts
    var conflictCount = 0;
    try { conflictCount = (GII_META.conflicts() || []).length; } catch (e) {}
    var confColor = conflictCount > 0 ? 'amber' : 'green';
    html += '<div class="gii-dbg-stat"><div class="lbl">Conflicts</div><div class="val ' + confColor + '">' + conflictCount + '</div></div>';

    html += '</div></div>';
    return html;
  }

  function _renderLog() {
    var html = '<div class="gii-dbg-section">';
    html += '<div class="gii-dbg-section-title">Activity Log <span id="giiDebugRefresh">↻ ' + new Date().toLocaleTimeString() + '</span></div>';
    html += '<div id="giiDebugLog">';

    if (!_log.length) {
      html += '<div style="color:#484f58;font-size:11px;padding:4px;">No activity yet — agents log here as they poll.</div>';
    } else {
      // Show most recent first
      var rows = _log.slice().reverse();
      rows.forEach(function (entry) {
        var t = new Date(entry.ts);
        var ts = t.toLocaleTimeString();
        html += '<div class="gii-log-row ' + _esc(entry.level) + '">';
        html += '<span class="ts">' + ts + '</span>';
        html += '<span class="msg">' + _esc(entry.msg) + '</span>';
        html += '</div>';
      });
    }

    html += '</div></div>';
    return html;
  }

  // ── full render ───────────────────────────────────────────────────────────

  function render() {
    var body = document.getElementById('giiDebugBody');
    if (!body || !body.classList.contains('open')) return;  // don't render if collapsed

    var agentResult = _renderAgentGrid();
    var statsHtml   = _renderSystemStats();
    var logHtml     = _renderLog();

    body.innerHTML = agentResult.html + statsHtml + logHtml;
  }

  // ── inject DOM ────────────────────────────────────────────────────────────

  function _inject() {
    if (document.getElementById(PANEL_ID)) return;

    var wrap = document.createElement('div');
    wrap.id = PANEL_ID;

    wrap.innerHTML = [
      '<div id="giiDebugHeader" onclick="document.getElementById(\'giiDebugBody\').classList.toggle(\'open\');this.querySelector(\'#giiDebugToggle\').textContent=document.getElementById(\'giiDebugBody\').classList.contains(\'open\')?\'▲ collapse\':\'▼ expand\'">',
      '  <span id="giiDebugTitle">🔧 GII Debug Panel — ' + KNOWN_AGENTS.length + ' agents</span>',
      '  <span id="giiDebugToggle">▼ expand</span>',
      '</div>',
      '<div id="giiDebugBody"></div>'
    ].join('');

    // Insert after #giiWrap if it exists, otherwise append to body
    var giiWrap = document.getElementById('giiWrap');
    if (giiWrap && giiWrap.parentNode) {
      giiWrap.parentNode.insertBefore(wrap, giiWrap.nextSibling);
    } else {
      document.body.appendChild(wrap);
    }
  }

  // ── init ──────────────────────────────────────────────────────────────────

  window.addEventListener('load', function () {
    _injectStyles();

    // Wait for gii-ui.js to inject #giiWrap — use MutationObserver for instant reaction,
    // fall back to a 15s timeout if something goes wrong.
    function _startDebug() {
      _inject();
      render();
      setInterval(render, REFRESH_MS);
    }

    if (document.getElementById('giiWrap')) {
      // Already present (unlikely at load but handle it)
      _startDebug();
    } else if (typeof MutationObserver !== 'undefined') {
      var _obs = new MutationObserver(function (mutations, obs) {
        if (document.getElementById('giiWrap') || document.getElementById(PANEL_ID)) {
          obs.disconnect();
          _startDebug();
        }
      });
      _obs.observe(document.body, { childList: true, subtree: true });
      // Safety fallback: give up waiting after 15s and inject anyway
      setTimeout(function () {
        if (!document.getElementById(PANEL_ID)) {
          _obs.disconnect();
          _startDebug();
        }
      }, 15000);
    } else {
      // No MutationObserver support — fall back to old-style delay
      setTimeout(_startDebug, 9500);
    }
  });

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_DEBUG = {
    log:    function () { return _log.slice(); },
    render: render,
    agents: function () {
      var out = {};
      KNOWN_AGENTS.forEach(function (a) { out[a.label] = _agentStatus(a.key); });
      return out;
    }
  };

})();
