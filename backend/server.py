"""
GeoIntel Backend — FastAPI Server
Exposes SSE stream, REST endpoints, and static health check.
"""
import asyncio
import json
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, Set

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from sse_starlette.sse import EventSourceResponse

# Dashboard HTML lives one directory above the backend package
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DASHBOARD_HTML = os.path.join(_PROJECT_ROOT, 'geopolitical-dashboard.html')

from config import HOST, PORT, SSE_KEEPALIVE, UW_API_KEY
from event_store import get_store
from uw_store import get_uw_store
import trades_store
from ingest.worldbank import get_cache as get_wb_cache
from ingest.imf       import get_cache as get_imf_cache
from ingest.bis       import get_cache as get_bis_cache
from ingest.oecd      import get_cache as get_oecd_cache
from ingest.eurostat  import get_cache as get_eurostat_cache
from ingest.eia       import get_cache as get_eia_cache
from ingest.fao       import get_cache as get_fao_cache
from ingest.ocha      import get_cache as get_ocha_cache
from ingest.cot       import get_cache as get_cot_cache
from ingest.icg       import _seen_ids as _icg_seen  # just to confirm import works

# ── UW runtime key (set via POST /api/uw/key, persisted to uw_config.json) ───
_UW_CONFIG_FILE  = os.path.join(os.path.dirname(__file__), 'uw_config.json')
_uw_key_runtime: str = ''  # overrides UW_API_KEY if set

def _active_uw_key() -> str:
    return _uw_key_runtime or UW_API_KEY


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialise trades DB
    trades_store.init_db()
    # Start auto-backup thread (6 h interval)
    t = threading.Thread(target=trades_store.backup_loop, daemon=True)
    t.start()

    from pipeline import start_pipeline, set_broadcast_fns
    set_broadcast_fns(broadcast_event, broadcast_market)
    asyncio.create_task(start_pipeline())
    yield


app = FastAPI(title='GeoIntel Backend', version='1.0', lifespan=lifespan)

# CORS — allow local dev origins and the live GitHub Pages deployment.
# Extra origins can be added via the EXTRA_CORS_ORIGINS env var (comma-separated).
_extra = [o.strip() for o in os.getenv('EXTRA_CORS_ORIGINS', '').split(',') if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        'null',                                         # file:// pages (Chrome/Firefox)
        'http://localhost',
        # 'http://localhost:3008',                      # removed — no preview servers on this project
        'http://localhost:8080',                        # user's main dashboard link
        'http://localhost:8765',
        'http://127.0.0.1',
        'http://127.0.0.1:3008',
        'http://127.0.0.1:8080',
        'http://127.0.0.1:8765',
        'https://megamorgs807-dev.github.io',          # GitHub Pages live dashboard
    ] + _extra,
    allow_methods=['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allow_headers=['*'],
)

# ── In-memory broadcast queue set ────────────────────────────────────────────
# Each connected SSE client gets its own asyncio.Queue.
_clients: Set[asyncio.Queue] = set()
_market_cache: dict = {}          # Latest market prices, updated every cycle


def broadcast_event(evt: dict):
    """Called by pipeline to push a new event to all SSE clients."""
    msg = json.dumps(evt)
    dead = set()
    for q in _clients:
        try:
            q.put_nowait(('message', msg))
        except asyncio.QueueFull:
            dead.add(q)
    _clients.difference_update(dead)


def broadcast_market(prices: dict):
    """Called by pipeline to push updated market prices to all SSE clients."""
    global _market_cache
    _market_cache = prices
    msg = json.dumps(prices)
    dead = set()
    for q in _clients:
        try:
            q.put_nowait(('market', msg))
        except asyncio.QueueFull:
            dead.add(q)
    _clients.difference_update(dead)


# ── SSE stream endpoint ───────────────────────────────────────────────────────

@app.get('/stream')
async def stream(request: Request):
    """
    Server-Sent Events endpoint.
    The frontend connects here and receives real-time events and market data.
    """
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    _clients.add(queue)

    # Send current market prices immediately on connect
    if _market_cache:
        await queue.put(('market', json.dumps(_market_cache)))

    async def event_generator() -> AsyncIterator[dict]:
        try:
            while True:
                # Check if client disconnected
                if await request.is_disconnected():
                    break

                try:
                    # Wait for next message with keepalive timeout
                    event_type, data = await asyncio.wait_for(
                        queue.get(), timeout=SSE_KEEPALIVE
                    )
                    yield {'event': event_type, 'data': data}
                except asyncio.TimeoutError:
                    # Send keepalive comment to prevent browser timeout
                    yield {'comment': 'keepalive'}

        finally:
            _clients.discard(queue)

    return EventSourceResponse(event_generator())


# ── Dashboard static serve ────────────────────────────────────────────────────

@app.get('/')
async def serve_dashboard():
    """
    Serve the dashboard HTML directly from the backend so it runs on
    http://localhost:8765/ instead of file://  — no more CORS null-origin issues.
    """
    return FileResponse(_DASHBOARD_HTML, media_type='text/html')


# ── REST endpoints ────────────────────────────────────────────────────────────

@app.get('/api/events')
async def api_events(limit: int = 100):
    """Return recent events from the database."""
    store = get_store()
    events = await asyncio.get_event_loop().run_in_executor(
        None, store.get_recent, limit
    )
    return JSONResponse(content={'events': events, 'count': len(events)})


@app.get('/api/market')
async def api_market():
    """Return latest cached market prices."""
    return JSONResponse(content=_market_cache)


@app.get('/api/learning')
async def api_learning(limit: int = 200):
    """
    Return events enriched with learning metadata for the LRN panel.
    Includes computed metrics: signal distribution, region breakdown, top keywords.
    """
    store = get_store()
    events = await asyncio.get_event_loop().run_in_executor(
        None, store.get_recent, limit
    )

    # Compute learning metrics server-side
    total   = len(events)
    high    = sum(1 for e in events if e.get('signal', 0) >= 60)
    critical = sum(1 for e in events if e.get('signal', 0) >= 80)

    # Region breakdown
    regions: dict = {}
    for e in events:
        r = e.get('region', 'GLOBAL')
        if r and r != 'GLOBAL':
            regions[r] = regions.get(r, 0) + 1

    # Top regions by event count
    top_regions = sorted(regions.items(), key=lambda x: x[1], reverse=True)[:8]

    # Signal distribution buckets
    buckets = {'0-19': 0, '20-39': 0, '40-59': 0, '60-79': 0, '80-100': 0}
    for e in events:
        s = e.get('signal', 0)
        if   s < 20:  buckets['0-19']   += 1
        elif s < 40:  buckets['20-39']  += 1
        elif s < 60:  buckets['40-59']  += 1
        elif s < 80:  buckets['60-79']  += 1
        else:         buckets['80-100'] += 1

    # Keyword frequency across all events
    from collections import Counter
    kw_counter: Counter = Counter()
    for e in events:
        for kw in (e.get('keywords') or []):
            kw_counter[kw] += 1
    top_keywords = kw_counter.most_common(15)

    # Per-keyword corroboration signal for adaptive weight tuning.
    # A keyword reliably co-occurring with multi-source events (srcCount ≥ 2)
    # is well-calibrated; one firing mostly on single-source events may be noisy.
    kw_signals: dict = {}
    for kw, count in top_keywords:
        kw_evts = [e for e in events if kw in (e.get('keywords') or [])]
        corr    = sum(1 for e in kw_evts if e.get('srcCount', 1) >= 2)
        kw_signals[kw] = {
            'count':        count,
            'corroborated': corr,
            'corr_rate':    round(corr / count * 100) if count > 0 else 0,
        }

    # Asset frequency
    asset_counter: Counter = Counter()
    for e in events:
        for a in (e.get('assets') or []):
            asset_counter[a] += 1
    top_assets = asset_counter.most_common(10)

    # Source breakdown
    src_counter: Counter = Counter()
    for e in events:
        src_counter[e.get('source', '?')] += 1
    top_sources = src_counter.most_common(8)

    # Signal quality calibration — corroboration rate per bucket
    # "Predicted" = bucket midpoint (what we'd expect if scoring is accurate)
    # "Actual"    = % of events that got srcCount ≥ 2 (multi-source confirmed)
    calibration = {}
    for bk, lo, hi in [('20-39', 20, 39), ('40-59', 40, 59),
                        ('60-79', 60, 79), ('80-100', 80, 100)]:
        bk_evts = [e for e in events if lo <= e.get('signal', 0) <= hi]
        n    = len(bk_evts)
        corr = sum(1 for e in bk_evts if e.get('srcCount', 1) >= 2)
        calibration[bk] = {
            'total':     n,
            'rate':      round(corr / n * 100) if n > 0 else None,
            'predicted': (lo + hi + 1) // 2,
        }

    return JSONResponse(content={
        'metrics': {
            'total':     total,
            'high':      high,
            'critical':  critical,
            'low_noise': total - high,
        },
        'regions':      dict(top_regions),
        'signal_dist':  buckets,
        'top_keywords': dict(top_keywords),
        'top_assets':   dict(top_assets),
        'top_sources':  dict(top_sources),
        'calibration':      calibration,
        'keyword_signals':  kw_signals,
        'events':           events,
        'ts':           int(time.time() * 1000),
    })


@app.get('/api/status')
async def api_status():
    """Health check — frontend pings this before opening SSE."""
    store = get_store()
    count = await asyncio.get_event_loop().run_in_executor(None, store.count)
    return JSONResponse(content={
        'status':  'ok',
        'clients': len(_clients),
        'events':  count,
        'ts':      int(time.time() * 1000),
    })


@app.get('/api/sources')
async def api_sources():
    """Per-source feed status — last run, event count, error if any."""
    from pipeline import get_source_status
    return JSONResponse(content=get_source_status())


@app.get('/api/regime')
async def api_regime():
    """
    Classify the current macro market regime from live VIX, DXY, US10Y data.

    Regime labels:
      CRISIS        — VIX ≥ 30.  Market is pricing in extreme risk.
                      Existing safe-haven trades are crowded. New LONGs on
                      GLD/BTC are late entries; look for relief rallies.
      RISK_OFF      — VIX 20-30. Elevated fear, active flight to safety.
                      GLD, DXY, US10Y (lower yield) likely bid.
      TRANSITIONING — VIX 15-20. Uncertainty, trend unclear.
      RISK_ON       — VIX < 15.  Low fear, complacency. Equities and
                      risk assets favoured; GLD/BTC longs harder to sustain.

    Also computes per-asset directional bias based on regime + DXY + yield:
      bias = LONG | SHORT | NEUTRAL | CROWDED

    Returns the regime + asset biases so the frontend can gate trade signals.
    Missing data (market cache empty or tickers not yet loaded) returns
    regime=UNKNOWN so the frontend can display a waiting state gracefully.
    """
    m = _market_cache  # snapshot — avoid race with pipeline writes

    vix   = (m.get('VIX')   or {}).get('price')
    dxy   = (m.get('DXY')   or {}).get('price')
    us10y = (m.get('US10Y') or {}).get('price')

    # ── Regime classification ─────────────────────────────────────────────────
    if vix is None:
        regime      = 'UNKNOWN'
        regime_desc = 'VIX not yet loaded — waiting for market data cycle'
        regime_score = 0
    elif vix >= 30:
        regime       = 'CRISIS'
        regime_desc  = 'Extreme fear. Safe-haven trades are crowded. Fading longs on GLD/BTC.'
        regime_score = 100
    elif vix >= 20:
        regime       = 'RISK_OFF'
        regime_desc  = 'Elevated fear. Flight to safety active. GLD, DXY, Treasuries bid.'
        regime_score = 65
    elif vix >= 15:
        regime       = 'TRANSITIONING'
        regime_desc  = 'Mixed signals. Trend unclear — reduce position sizing.'
        regime_score = 35
    else:
        regime       = 'RISK_ON'
        regime_desc  = 'Low fear. Risk assets favoured. GLD/BTC safe-haven bids weaker.'
        regime_score = 10

    # ── Per-asset directional bias ────────────────────────────────────────────
    # Logic:
    #  GLD  — LONG in RISK_OFF/CRISIS unless price already spiked (crowded)
    #  BTC  — LONG in CRISIS (sanctions hedge) but SHORT in RISK_ON (risk-off outflows)
    #  WTI  — depends on regime; in CRISIS can go either way (demand destroy vs supply)
    #  LMT  — defence spending rises in RISK_OFF; CROWDED in prolonged CRISIS
    #  TSM  — SHORT in CRISIS/RISK_OFF (Taiwan risk, demand collapse)
    #  SPY  — SHORT in CRISIS/RISK_OFF, LONG in RISK_ON
    #  DXY  — LONG in RISK_OFF/CRISIS (safe-haven demand)

    def gld_bias():
        if regime == 'CRISIS':   return 'CROWDED'   # move already happened
        if regime == 'RISK_OFF': return 'LONG'
        return 'NEUTRAL'

    def btc_bias():
        if regime in ('CRISIS', 'RISK_OFF'): return 'LONG'   # sanctions hedge
        if regime == 'RISK_ON':              return 'NEUTRAL'
        return 'NEUTRAL'

    def wti_bias():
        if regime == 'CRISIS':   return 'NEUTRAL'   # supply vs demand unclear
        if regime == 'RISK_OFF': return 'LONG'       # supply-disruption premium
        return 'NEUTRAL'

    def lmt_bias():
        if regime in ('CRISIS', 'RISK_OFF'): return 'LONG'
        return 'NEUTRAL'

    def tsm_bias():
        if regime in ('CRISIS', 'RISK_OFF'): return 'SHORT'  # Taiwan risk + demand
        if regime == 'RISK_ON':              return 'LONG'
        return 'NEUTRAL'

    def spy_bias():
        if regime == 'CRISIS':        return 'SHORT'
        if regime == 'RISK_OFF':      return 'SHORT'
        if regime == 'TRANSITIONING': return 'NEUTRAL'
        return 'LONG'   # RISK_ON

    def dxy_bias():
        if regime in ('CRISIS', 'RISK_OFF'): return 'LONG'
        return 'NEUTRAL'

    asset_biases = {
        'GLD':   {'bias': gld_bias(),  'reason': 'Safe-haven demand vs crowded trade'},
        'BTC':   {'bias': btc_bias(),  'reason': 'Sanctions hedge / risk correlation'},
        'ETH':   {'bias': btc_bias(),  'reason': 'Follows BTC in macro events'},
        'WTI':   {'bias': wti_bias(),  'reason': 'Supply disruption vs demand destruction'},
        'BRENT': {'bias': wti_bias(),  'reason': 'Supply disruption vs demand destruction'},
        'GAS':   {'bias': wti_bias(),  'reason': 'Energy supply chain risk'},
        'LMT':   {'bias': lmt_bias(),  'reason': 'Defence spending rises in risk-off'},
        'TSM':   {'bias': tsm_bias(),  'reason': 'Taiwan risk + semi demand cycle'},
        'SPY':   {'bias': spy_bias(),  'reason': 'Broad equity risk appetite'},
        'WHT':   {'bias': 'NEUTRAL',   'reason': 'Commodity-specific supply factors'},
        'DXY':   {'bias': dxy_bias(),  'reason': 'Safe-haven currency demand'},
    }

    # ── DXY confirmation ──────────────────────────────────────────────────────
    # Rising DXY alongside RISK_OFF confirms the regime; contradicts RISK_ON
    dxy_chg = (m.get('DXY') or {}).get('chg24h')
    dxy_confirming = None
    if dxy_chg is not None:
        if regime in ('RISK_OFF', 'CRISIS') and dxy_chg > 0.3:
            dxy_confirming = True   # DXY rising confirms risk-off
        elif regime == 'RISK_ON' and dxy_chg < -0.3:
            dxy_confirming = True   # DXY falling confirms risk-on
        else:
            dxy_confirming = False  # regime and DXY diverging — caution

    # ── Yield signal ──────────────────────────────────────────────────────────
    # Falling 10yr yield = flight to quality, confirms risk-off
    yield_chg  = (m.get('US10Y') or {}).get('chg24h')
    yield_note = None
    if yield_chg is not None:
        if yield_chg < -0.05:
            yield_note = 'Yields falling — flight to quality confirmed'
        elif yield_chg > 0.05:
            yield_note = 'Yields rising — risk appetite or inflation concern'

    return JSONResponse(content={
        'regime':        regime,
        'regime_score':  regime_score,
        'regime_desc':   regime_desc,
        'vix':           vix,
        'dxy':           dxy,
        'us10y':         us10y,
        'dxy_chg24h':    dxy_chg,
        'yield_chg24h':  yield_chg,
        'dxy_confirming': dxy_confirming,
        'yield_note':    yield_note,
        'asset_biases':  asset_biases,
        'ts':            int(time.time() * 1000),
    })


@app.get('/api/uw/status')
async def uw_status():
    """UW integration status — key configured, data counts, latest tide, per-feed status."""
    from pipeline import get_uw_feed_status
    uw = get_uw_store()
    stats       = await asyncio.get_event_loop().run_in_executor(None, uw.stats)
    tide        = await asyncio.get_event_loop().run_in_executor(None, uw.get_latest_tide)
    iv_ranks    = await asyncio.get_event_loop().run_in_executor(None, uw.get_iv_ranks)
    feed_status = get_uw_feed_status()
    return JSONResponse(content={
        'key_configured': bool(_active_uw_key()),
        'stats':       stats,
        'tide':        tide,
        'iv_ranks':    iv_ranks,
        'feed_status': feed_status,
        'ts':          int(time.time() * 1000),
    })


@app.post('/api/uw/key')
async def uw_set_key(request: Request):
    """Accept UW API key entered via the dashboard — no backend restart needed."""
    global _uw_key_runtime
    body = await request.json()
    key  = (body.get('key') or '').strip()
    _uw_key_runtime = key
    # Tell the pipeline immediately
    from pipeline import set_uw_key
    set_uw_key(key)
    # Persist so it survives restarts
    try:
        with open(_UW_CONFIG_FILE, 'w') as f:
            json.dump({'uw_api_key': key}, f)
    except Exception as e:
        print(f'[UW] Could not persist key: {e}')
    return JSONResponse(content={'ok': True, 'configured': bool(key)})


@app.post('/api/uw/poll')
async def uw_poll_now():
    """Trigger an immediate full UW data fetch (forces all feeds regardless of schedule)."""
    from pipeline import run_uw_poll
    asyncio.create_task(run_uw_poll())
    return JSONResponse(content={'ok': True, 'ts': int(time.time() * 1000)})


@app.get('/api/uw/flow-alerts')
async def uw_flow_alerts(limit: int = 50, hours: int = 24):
    """Recent unusual options flow alerts (sorted newest first)."""
    uw = get_uw_store()
    data = await asyncio.get_event_loop().run_in_executor(
        None, lambda: uw.get_flow_alerts(limit=limit, hours=hours)
    )
    return JSONResponse(content={'data': data, 'count': len(data)})


@app.get('/api/uw/darkpool')
async def uw_darkpool(limit: int = 30, hours: int = 24):
    """Recent dark pool prints on tracked assets (> $2M)."""
    uw = get_uw_store()
    data = await asyncio.get_event_loop().run_in_executor(
        None, lambda: uw.get_darkpool(limit=limit, hours=hours)
    )
    return JSONResponse(content={'data': data, 'count': len(data)})


@app.get('/api/uw/congress')
async def uw_congress(limit: int = 20, days: int = 90):
    """Recent congressional trades in geopolitically relevant sectors."""
    uw = get_uw_store()
    data = await asyncio.get_event_loop().run_in_executor(
        None, lambda: uw.get_congress(limit=limit, days=days)
    )
    return JSONResponse(content={'data': data, 'count': len(data)})


@app.get('/api/uw/tide')
async def uw_tide(hours: int = 8):
    """Market tide time series — net call/put premium over last N hours."""
    uw = get_uw_store()
    data = await asyncio.get_event_loop().run_in_executor(
        None, lambda: uw.get_tide(hours=hours)
    )
    latest = data[-1] if data else None
    return JSONResponse(content={'data': data, 'latest': latest, 'count': len(data)})


@app.get('/api/uw/iv-ranks')
async def uw_iv_ranks():
    """Current IV rank (0–100) for all tracked tickers."""
    uw = get_uw_store()
    data = await asyncio.get_event_loop().run_in_executor(None, uw.get_iv_ranks)
    return JSONResponse(content={'data': data, 'ts': int(time.time() * 1000)})


@app.get('/api/correlation')
async def api_correlation():
    """
    Compute pairwise Pearson correlation on 24h price-change percentages
    accumulated across the last 30 pipeline cycles (~30 min of data).
    Returns the correlation matrix for WTI, GLD, DXY, BTC, VIX.
    """
    from pipeline import get_price_history
    history = get_price_history()
    assets  = ['WTI', 'GLD', 'DXY', 'BTC', 'VIX']

    if len(history) < 5:
        return JSONResponse(content={
            'ready':     False,
            'snapshots': len(history),
            'assets':    assets,
        })

    def pearson(ak: str, bk: str):
        pairs = [
            (snap.get(ak), snap.get(bk))
            for snap in history
            if snap.get(ak) is not None and snap.get(bk) is not None
        ]
        if len(pairs) < 3:
            return None
        n  = len(pairs)
        xs = [p[0] for p in pairs]
        ys = [p[1] for p in pairs]
        mx, my = sum(xs) / n, sum(ys) / n
        num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        sx  = sum((x - mx) ** 2 for x in xs) ** 0.5
        sy  = sum((y - my) ** 2 for y in ys) ** 0.5
        if sx == 0 or sy == 0:
            return None
        return round(num / (sx * sy), 2)

    matrix = {
        a: {b: (1.0 if a == b else pearson(a, b)) for b in assets}
        for a in assets
    }
    return JSONResponse(content={
        'ready':     True,
        'snapshots': len(history),
        'assets':    assets,
        'matrix':    matrix,
        'ts':        int(time.time() * 1000),
    })


# ── Macro data endpoints (World Bank + IMF) ───────────────────────────────────

@app.get('/api/worldbank')
async def api_worldbank():
    """
    Return cached World Bank macro indicators for conflict-relevant countries.
    Updated once at startup and every 6 hours by the pipeline.
    Keys per country: gdp_growth, inflation, ca_balance, govt_debt.
    """
    return JSONResponse(content=get_wb_cache())


@app.get('/api/imf')
async def api_imf():
    """
    Return cached IMF WEO forecast data for conflict-relevant countries.
    Updated once at startup and every 6 hours by the pipeline.
    Keys per country: gdp_growth, inflation (and *_year variants).
    """
    return JSONResponse(content=get_imf_cache())


@app.get('/api/bis')
async def api_bis():
    """BIS credit-to-GDP gap data. High gap = elevated financial crisis risk."""
    return JSONResponse(content=get_bis_cache())

@app.get('/api/oecd')
async def api_oecd():
    """OECD macro indicators (unemployment, CPI, GDP growth) for member countries."""
    return JSONResponse(content=get_oecd_cache())

@app.get('/api/eurostat')
async def api_eurostat():
    """Eurostat EU economic indicators (HICP inflation, unemployment, industrial production)."""
    return JSONResponse(content=get_eurostat_cache())

@app.get('/api/eia')
async def api_eia():
    """EIA energy data (crude stocks, natgas storage, production, prices)."""
    return JSONResponse(content=get_eia_cache())

@app.get('/api/fao')
async def api_fao():
    """FAO/World Bank food price indicators (CPI, food production index)."""
    return JSONResponse(content=get_fao_cache())

@app.get('/api/ocha')
async def api_ocha():
    """OCHA FTS humanitarian funding data."""
    return JSONResponse(content=get_ocha_cache())

@app.get('/api/cot')
async def api_cot():
    """CFTC Commitments of Traders — weekly speculative positioning for key futures markets."""
    return JSONResponse(content=get_cot_cache())


# ── EE Config sync (Smart Improvement 2) ─────────────────────────────────────
# Stores the latest EE risk config so it survives localStorage wipes (e.g. Chrome crash).

_EE_CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'ee_config_backup.json')
_ee_config_cache: dict = {}

# Load from disk on startup
try:
    with open(_EE_CONFIG_FILE) as f:
        _ee_config_cache = json.load(f)
except Exception:
    pass

@app.post('/api/config')
async def config_save(request: Request):
    """Save EE config to backend — called automatically when settings are updated."""
    global _ee_config_cache
    body = await request.json()
    _ee_config_cache = body
    try:
        with open(_EE_CONFIG_FILE, 'w') as f:
            json.dump(body, f, indent=2)
    except Exception as e:
        return JSONResponse(content={'ok': False, 'error': str(e)})
    return JSONResponse(content={'ok': True})

@app.get('/api/config')
async def config_load():
    """Return last saved EE config — used to restore settings after localStorage wipe."""
    return JSONResponse(content=_ee_config_cache or {})


# ── Trades API ────────────────────────────────────────────────────────────────

@app.get('/api/trades')
async def trades_list():
    """Return all trades from the SQLite database."""
    trades = await asyncio.get_event_loop().run_in_executor(None, trades_store.get_all)
    return JSONResponse(content={'trades': trades, 'count': len(trades)})


@app.post('/api/trades')
async def trades_create(request: Request):
    """Insert or replace a trade (upsert by trade_id)."""
    body = await request.json()
    if isinstance(body, list):
        # Bulk insert
        for trade in body:
            await asyncio.get_event_loop().run_in_executor(None, trades_store.upsert, trade)
        return JSONResponse(content={'ok': True, 'count': len(body)})
    else:
        await asyncio.get_event_loop().run_in_executor(None, trades_store.upsert, body)
        return JSONResponse(content={'ok': True, 'trade_id': body.get('trade_id')})


@app.patch('/api/trades/{trade_id}')
async def trades_patch(trade_id: str, request: Request):
    """Update specific fields on an existing trade (e.g. close a trade)."""
    updates = await request.json()
    ok = await asyncio.get_event_loop().run_in_executor(
        None, trades_store.patch, trade_id, updates
    )
    if not ok:
        return JSONResponse(content={'ok': False, 'error': 'not found'}, status_code=404)
    return JSONResponse(content={'ok': True, 'trade_id': trade_id})


@app.delete('/api/trades/{trade_id}')
async def trades_delete(trade_id: str):
    """Delete a trade record."""
    ok = await asyncio.get_event_loop().run_in_executor(
        None, trades_store.delete, trade_id
    )
    if not ok:
        return JSONResponse(content={'ok': False, 'error': 'not found'}, status_code=404)
    return JSONResponse(content={'ok': True, 'trade_id': trade_id})


@app.delete('/api/trades')
async def trades_delete_all(closed: bool = False):
    """Wipe trade records. ?closed=true deletes only CLOSED trades (session reset);
    without the flag, all records are deleted (full reset)."""
    if closed:
        n = await asyncio.get_event_loop().run_in_executor(None, trades_store.delete_closed)
    else:
        n = await asyncio.get_event_loop().run_in_executor(None, trades_store.delete_all)
    return JSONResponse(content={'ok': True, 'deleted': n})


@app.get('/api/trades/export')
async def trades_export():
    """Download all trades as a JSON file (also triggers a backup snapshot)."""
    trades = await asyncio.get_event_loop().run_in_executor(None, trades_store.export_json)
    payload = json.dumps(
        {'ts': int(time.time() * 1000), 'count': len(trades), 'trades': trades},
        indent=2
    )
    from fastapi.responses import Response
    return Response(
        content=payload,
        media_type='application/json',
        headers={'Content-Disposition': 'attachment; filename="ee_trades_export.json"'}
    )


@app.post('/api/trades/backup')
async def trades_backup():
    """Trigger an immediate backup to /backups/."""
    path, n = await asyncio.get_event_loop().run_in_executor(None, trades_store.do_backup)
    return JSONResponse(content={'ok': True, 'path': path, 'count': n})


# ── Hyperliquid broker endpoints ─────────────────────────────────────────────

import hl_broker as _hl

@app.post('/api/hl/connect')
async def hl_connect(request: Request):
    """Connect HL broker with wallet address + private key."""
    body    = await request.json()
    wallet  = (body.get('wallet') or '').strip()
    privkey = (body.get('privateKey') or '').strip()
    testnet = body.get('testnet', True)
    if not wallet or not privkey:
        return JSONResponse(content={'ok': False, 'error': 'wallet and privateKey required'})
    result = await asyncio.get_event_loop().run_in_executor(
        None, _hl.connect, wallet, privkey, testnet
    )
    return JSONResponse(content=result)


@app.get('/api/hl/account')
async def hl_account():
    """Get HL account equity, available margin, unrealised P&L."""
    result = await asyncio.get_event_loop().run_in_executor(None, _hl.get_account)
    return JSONResponse(content=result)


@app.post('/api/hl/order')
async def hl_order(request: Request):
    """Place a market order on HL. Body: {coin, side, sizeUsd, leverage}"""
    body     = await request.json()
    coin     = (body.get('coin') or '').upper().strip()
    side     = (body.get('side') or '').lower()
    size_usd = float(body.get('sizeUsd', 0))
    leverage = int(body.get('leverage', 1))
    if not coin or side not in ('buy', 'sell') or size_usd <= 0:
        return JSONResponse(content={'ok': False, 'error': 'coin, side (buy/sell), sizeUsd required'})
    result = await asyncio.get_event_loop().run_in_executor(
        None, _hl.place_order, coin, side == 'buy', size_usd, leverage
    )
    return JSONResponse(content=result)


@app.post('/api/hl/close')
async def hl_close(request: Request):
    """Close the full HL position for a coin. Body: {coin}"""
    body = await request.json()
    coin = (body.get('coin') or '').upper().strip()
    if not coin:
        return JSONResponse(content={'ok': False, 'error': 'coin required'})
    result = await asyncio.get_event_loop().run_in_executor(None, _hl.close_position, coin)
    return JSONResponse(content=result)


@app.get('/api/hl/positions')
async def hl_positions():
    """Get all open HL perp positions."""
    result = await asyncio.get_event_loop().run_in_executor(None, _hl.get_positions)
    return JSONResponse(content=result)


@app.get('/api/hl/status')
async def hl_status():
    """HL broker connection status."""
    connected = _hl._cfg.get('connected', False)
    wallet    = _hl._cfg.get('wallet', '')
    testnet   = _hl._cfg.get('testnet', True)
    result    = {'connected': connected, 'testnet': testnet,
                 'address': wallet, 'addressHint': wallet[:10] + '…' if wallet else ''}
    if connected:
        acct = await asyncio.get_event_loop().run_in_executor(None, _hl.get_account)
        result.update(acct)
    return JSONResponse(content=result)


@app.post('/api/hl/disconnect')
async def hl_disconnect():
    _hl.disconnect()
    return JSONResponse(content={'ok': True})


# ── Static asset fallback ─────────────────────────────────────────────────────
# MUST be last — serves JS/CSS from project root so the dashboard works at
# http://localhost:8765/ as well as http://localhost:8080/
from fastapi import HTTPException as _HTTPException

@app.get('/{filename:path}')
async def serve_asset(filename: str):
    """Serve any static file from the project root (JS, CSS, etc.)."""
    if not filename or '..' in filename:
        raise _HTTPException(status_code=404)
    path = os.path.join(_PROJECT_ROOT, filename)
    if os.path.isfile(path):
        return FileResponse(path)
    raise _HTTPException(status_code=404)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    import uvicorn
    uvicorn.run('server:app', host=HOST, port=PORT, log_level='info', reload=False)
