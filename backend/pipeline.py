"""
GeoIntel Backend — Pipeline Orchestrator
Runs every CYCLE_SECONDS, pulling from all ingest sources concurrently,
deduplicating via EventStore, and broadcasting new events via SSE.
"""
import asyncio
import time
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


def set_broadcast_fns(event_fn, market_fn):
    """Called by server.py to wire up the SSE broadcast callbacks."""
    global _broadcast_event, _broadcast_market
    _broadcast_event  = event_fn
    _broadcast_market = market_fn


async def _run_sync(fn, *args):
    """Run a synchronous function in the thread pool without blocking the event loop."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, fn, *args)


async def _ingest_events() -> List[Dict]:
    """
    Fetch from all news sources concurrently.
    return_exceptions=True ensures one failure doesn't abort the rest.
    """
    results = await asyncio.gather(
        _run_sync(fetch_gdelt),
        _run_sync(fetch_rss),
        _run_sync(fetch_reddit),
        return_exceptions=True,
    )
    events = []
    names  = ['GDELT', 'RSS', 'Reddit']
    for name, r in zip(names, results):
        if isinstance(r, Exception):
            print(f'[PIPELINE] {name} raised: {r}')
        elif isinstance(r, list):
            events.extend(r)
    return events


async def _ingest_market() -> Dict:
    result = await _run_sync(fetch_market_prices)
    if isinstance(result, Exception):
        print(f'[PIPELINE] market data raised: {result}')
        return {}
    return result or {}


async def _pipeline_cycle():
    """One complete pipeline run: fetch → deduplicate → store → broadcast."""
    store   = get_store()
    t_start = time.time()
    print(f'[PIPELINE] cycle starting...')

    # Run news ingestion and market data concurrently
    events_task = asyncio.create_task(_ingest_events())
    market_task = asyncio.create_task(_ingest_market())

    events = await events_task
    market = await market_task

    # Process and broadcast new events
    new_count   = 0
    corroborated = 0
    for evt in events:
        # Score filter — skip noise below signal 20
        if evt.get('signal', 0) < 20:
            continue

        result = await asyncio.get_event_loop().run_in_executor(
            _executor, store.insert, evt
        )

        if result is True:
            # Brand-new event — broadcast as-is
            if _broadcast_event:
                _broadcast_event(evt)
            new_count += 1

        elif isinstance(result, dict):
            # Existing event corroborated by a new source — re-broadcast
            # the enriched version so the dashboard updates src_count + signal
            if _broadcast_event:
                _broadcast_event(result)
            corroborated += 1

        # result is False → exact duplicate, discard silently

    # Prune database
    await asyncio.get_event_loop().run_in_executor(_executor, store.prune)

    # Broadcast market prices
    if market and _broadcast_market:
        _broadcast_market(market)

    elapsed = time.time() - t_start
    print(
        f'[PIPELINE] cycle done in {elapsed:.1f}s — '
        f'{len(events)} fetched, {new_count} new, '
        f'{corroborated} corroborated, '
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
