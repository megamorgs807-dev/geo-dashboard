"""
GeoIntel Backend — FastAPI Server
Exposes SSE stream, REST endpoints, and static health check.
"""
import asyncio
import json
import time
from typing import AsyncIterator, Set

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from sse_starlette.sse import EventSourceResponse

from config import HOST, PORT, SSE_KEEPALIVE
from event_store import get_store

app = FastAPI(title='GeoIntel Backend', version='1.0')

# CORS — allow any origin because the dashboard opens as a local file://
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['GET'],
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
async def stream(request):
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
        'events':       events,
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


# ── Entry point ───────────────────────────────────────────────────────────────

@app.on_event('startup')
async def startup():
    from pipeline import start_pipeline, set_broadcast_fns
    set_broadcast_fns(broadcast_event, broadcast_market)
    asyncio.create_task(start_pipeline())


if __name__ == '__main__':
    import uvicorn
    uvicorn.run('server:app', host=HOST, port=PORT, log_level='info', reload=False)
