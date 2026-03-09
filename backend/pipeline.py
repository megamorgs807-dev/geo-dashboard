"""
GeoIntel Backend — Pipeline Orchestrator
Runs every CYCLE_SECONDS, pulling from all ingest sources concurrently,
deduplicating via EventStore, and broadcasting new events via SSE.
"""
import asyncio
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict

from config import CYCLE_SECONDS
from event_store import get_store
from keyword_detector import dedupe_key

# Import ingest modules (all are synchronous; we wrap them in run_in_executor)
from ingest.gdelt      import fetch_gdelt
from ingest.rss_feeds  import fetch_rss
from ingest.reddit     import fetch_reddit
from ingest.market_data import fetch_market_prices

# Shared thread pool for synchronous network calls
_executor = ThreadPoolExecutor(max_workers=6)

# Reference to broadcast functions — set by server.py at startup
_broadcast_event  = None
_broadcast_market = None

# Cycle counter — used to throttle expensive / rate-limited sources
_cycle_n = 0

# GDELT adaptive backoff — incremented on 429, decremented each skipped cycle.
# When > 0, GDELT is skipped even on its scheduled cycle.
_gdelt_backoff = 0

# Rolling price-change history for correlation computation (last 30 cycles)
_price_history: deque = deque(maxlen=30)


def get_price_history() -> list:
    """Return a copy of the rolling price-change snapshot list."""
    return list(_price_history)


def set_broadcast_fns(event_fn, market_fn):
    """Called by server.py to wire up the SSE broadcast callbacks."""
    global _broadcast_event, _broadcast_market
    _broadcast_event  = event_fn
    _broadcast_market = market_fn


async def _run_sync(fn, *args):
    """Run a synchronous function in the thread pool without blocking the event loop."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, fn, *args)


async def _ingest_events(run_gdelt: bool = True) -> List[Dict]:
    """
    Fetch from all news sources concurrently.
    run_gdelt=False skips GDELT on most cycles (throttle).
    Adaptive backoff: if GDELT returned 429 last attempt, skip the next
    4 scheduled GDELT cycles (~20 min total pause) before retrying.
    return_exceptions=True ensures one failure doesn't abort the rest.
    """
    global _gdelt_backoff

    # Honour backoff even on scheduled cycles
    if run_gdelt and _gdelt_backoff > 0:
        _gdelt_backoff -= 1
        print(f'[PIPELINE] GDELT backoff active — {_gdelt_backoff} cycles remaining, skipping')
        run_gdelt = False

    tasks = [
        _run_sync(fetch_rss),
        _run_sync(fetch_reddit),
    ]
    if run_gdelt:
        tasks.append(_run_sync(fetch_gdelt))

    results = await asyncio.gather(*tasks, return_exceptions=True)
    events = []
    names  = ['RSS', 'Reddit'] + (['GDELT'] if run_gdelt else [])
    for name, r in zip(names, results):
        if isinstance(r, Exception):
            print(f'[PIPELINE] {name} raised: {r}')
            if name == 'GDELT' and '429' in str(r):
                _gdelt_backoff = 4  # skip next 4 scheduled GDELT cycles
                print(f'[PIPELINE] GDELT 429 — backoff set to 4 cycles')
        elif isinstance(r, list):
            events.extend(r)
    return events


async def _ingest_market() -> Dict:
    result = await _run_sync(fetch_market_prices)
    if isinstance(result, Exception):
        print(f'[PIPELINE] market data raised: {result}')
        return {}
    return result or {}


def _regime_multiplier(market: Dict) -> float:
    """
    Return a signal multiplier based on VIX level.
    CRISIS regime amplifies signals (same event = bigger deal during panic).
    RISK_ON dampens signals (markets are complacent, events matter less).
    """
    vix = (market.get('VIX') or {}).get('price')
    if vix is None:
        return 1.0
    if vix >= 30:
        return 1.20   # CRISIS — amplify
    if vix >= 20:
        return 1.10   # RISK_OFF
    if vix < 15:
        return 0.90   # RISK_ON — dampen
    return 1.0        # TRANSITIONING


async def _pipeline_cycle():
    """One complete pipeline run: fetch → deduplicate → store → broadcast."""
    global _cycle_n
    _cycle_n += 1

    store   = get_store()
    t_start = time.time()

    # GDELT is rate-limited to ~12 req/hour — only call every 5 cycles (~5 min)
    run_gdelt = (_cycle_n % 5 == 1)
    print(f'[PIPELINE] cycle {_cycle_n} starting… (GDELT: {"yes" if run_gdelt else "skip"})')

    # Run news ingestion and market data concurrently
    events_task = asyncio.create_task(_ingest_events(run_gdelt=run_gdelt))
    market_task = asyncio.create_task(_ingest_market())

    events = await events_task
    market = await market_task

    # Compute regime multiplier from live VIX
    mult = _regime_multiplier(market)
    regime_label = (
        'CRISIS'       if mult >= 1.20 else
        'RISK_OFF'     if mult >= 1.10 else
        'RISK_ON'      if mult <  1.00 else
        'NEUTRAL'
    )

    # Process and broadcast new events
    new_count    = 0
    corroborated = 0
    for evt in events:
        raw_signal = evt.get('signal', 0)
        if raw_signal < 20:
            continue

        # Apply regime multiplier before storing
        if mult != 1.0:
            evt['signal'] = min(100, max(0, round(raw_signal * mult)))

        result = await asyncio.get_event_loop().run_in_executor(
            _executor, store.insert, evt
        )

        if result is True:
            if _broadcast_event:
                _broadcast_event(evt)
            new_count += 1

        elif isinstance(result, dict):
            if _broadcast_event:
                _broadcast_event(result)
            corroborated += 1

        # result is False → exact duplicate, discard silently

    # Prune + decay old events every cycle
    await asyncio.get_event_loop().run_in_executor(_executor, store.prune)
    await asyncio.get_event_loop().run_in_executor(_executor, store.decay_old_events)

    # Store price-change snapshot for rolling correlation (chg24h per ticker)
    if market:
        snapshot = {k: (v.get('chg24h') if v else None) for k, v in market.items()}
        _price_history.append(snapshot)

    # Broadcast market prices
    if market and _broadcast_market:
        _broadcast_market(market)

    elapsed = time.time() - t_start
    print(
        f'[PIPELINE] cycle {_cycle_n} done in {elapsed:.1f}s — '
        f'{len(events)} fetched, {new_count} new, '
        f'{corroborated} corroborated, '
        f'regime: {regime_label} (×{mult}), '
        f'market tickers: {list(market.keys())}'
    )


async def start_pipeline():
    """
    Main pipeline loop — runs forever, once per CYCLE_SECONDS.
    Called as an asyncio task from server.py startup.
    """
    print(f'[PIPELINE] starting — cycle every {CYCLE_SECONDS}s')

    while True:
        try:
            await _pipeline_cycle()
        except Exception as e:
            print(f'[PIPELINE] unexpected error in cycle: {e}')

        await asyncio.sleep(CYCLE_SECONDS)
