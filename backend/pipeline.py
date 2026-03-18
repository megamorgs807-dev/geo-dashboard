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

from config import CYCLE_SECONDS, UW_API_KEY
from event_store import get_store
from keyword_detector import dedupe_key
from uw_store import get_uw_store

# Import ingest modules (all are synchronous; we wrap them in run_in_executor)
from ingest.gdelt      import fetch_gdelt
from ingest.rss_feeds  import fetch_rss
from ingest.reddit     import fetch_reddit
from ingest.market_data import fetch_market_prices
from ingest.unusual_whales import (
    fetch_flow_alerts, fetch_darkpool, fetch_congress_trades,
    fetch_market_tide, fetch_iv_ranks,
)
# ── Runtime key overrides (set via dashboard without restart) ─────────────────
_uw_key_override:  str = ''

def set_uw_key(key: str) -> None:
    global _uw_key_override
    _uw_key_override = key.strip()
    print(f'[UW] API key {"set" if _uw_key_override else "cleared"} at runtime')

def _get_uw_key() -> str:
    return _uw_key_override or UW_API_KEY

# ── Per-feed status (updated on each successful / failed poll) ────────────────
_uw_feed_status: dict = {
    'flow':     {'last_ok': 0, 'count': 0, 'error': None},
    'darkpool': {'last_ok': 0, 'count': 0, 'error': None},
    'congress': {'last_ok': 0, 'count': 0, 'error': None},
    'tide':     {'last_ok': 0, 'count': 0, 'error': None},
    'iv':       {'last_ok': 0, 'count': 0, 'error': None},
}

def get_uw_feed_status() -> dict:
    return {k: dict(v) for k, v in _uw_feed_status.items()}

# Shared thread pool for synchronous network calls
_executor = ThreadPoolExecutor(max_workers=8)

# UW state — track last poll times and flow alert watermark
_uw_last_flow_ts    = 0   # ms — only fetch alerts newer than this
_uw_last_dp_cycle   = 0   # cycle number
_uw_last_cong_cycle = 0
_uw_last_iv_cycle   = 0
_uw_tide: dict      = {}  # latest tide snapshot (used by regime detector)

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
    Return a signal multiplier based on VIX level AND UW market tide.
    CRISIS regime amplifies signals; RISK_ON dampens them.
    Negative tide adds a further 5% amplification (institutional put buying = fear).
    """
    vix = (market.get('VIX') or {}).get('price')
    mult = 1.0
    if vix is not None:
        if vix >= 30:   mult = 1.20
        elif vix >= 20: mult = 1.10
        elif vix < 15:  mult = 0.90

    # Tide adjustment: strong put flow = additional risk-off signal
    if _uw_tide:
        tide_pct = _uw_tide.get('tide_pct', 0)
        if tide_pct < -30:   mult = min(1.35, mult + 0.10)  # strongly bearish tide
        elif tide_pct < -10: mult = min(1.25, mult + 0.05)  # bearish tide
        elif tide_pct > 30:  mult = max(0.85, mult - 0.05)  # bullish tide = dampen fear

    return mult


async def _ingest_uw() -> List[Dict]:
    """
    Fetch from Unusual Whales on a staggered schedule:
      Every cycle  (60s) → flow alerts (most time-sensitive)
      Every 5 cyc  (5min) → dark pool + market tide
      Every 30 cyc (30min) → congress trades
      Every 15 cyc (15min) → IV ranks
    Returns events ready to enter the main event pipeline.
    Returns [] if no UW key is configured.
    """
    global _uw_last_flow_ts, _uw_last_dp_cycle, _uw_last_cong_cycle, _uw_last_iv_cycle, _uw_tide

    _key = _get_uw_key()
    if not _key:
        return []

    uw_store = get_uw_store()
    events   = []
    _now_ms  = int(time.time() * 1000)

    # ── Flow alerts — every cycle ──────────────────────────────────────────
    try:
        alerts = await _run_sync(fetch_flow_alerts, _key, _uw_last_flow_ts or None)
        for evt in alerts:
            is_new = await _run_sync(uw_store.upsert_flow_alert, evt)
            if is_new:
                events.append(evt)
                _uw_last_flow_ts = max(_uw_last_flow_ts, evt.get('ts', 0))
        _uw_feed_status['flow']['last_ok'] = _now_ms
        _uw_feed_status['flow']['count']   = _uw_feed_status['flow']['count'] + len(alerts)
        _uw_feed_status['flow']['error']   = None
    except Exception as e:
        print(f'[UW] flow_alerts error: {e}')
        _uw_feed_status['flow']['error'] = str(e)

    # ── Dark pool + market tide — every 5 cycles ───────────────────────────
    if _cycle_n - _uw_last_dp_cycle >= 5 or _uw_last_dp_cycle == 0:
        _uw_last_dp_cycle = _cycle_n
        try:
            dp_evts = await _run_sync(fetch_darkpool, _key)
            for evt in dp_evts:
                is_new = await _run_sync(uw_store.upsert_darkpool, evt)
                if is_new:
                    events.append(evt)
            _uw_feed_status['darkpool']['last_ok'] = _now_ms
            _uw_feed_status['darkpool']['count']   = len(dp_evts)
            _uw_feed_status['darkpool']['error']   = None
        except Exception as e:
            print(f'[UW] darkpool error: {e}')
            _uw_feed_status['darkpool']['error'] = str(e)

        try:
            tide = await _run_sync(fetch_market_tide, _key)
            if tide:
                _uw_tide = tide
                await _run_sync(uw_store.upsert_tide, tide)
                _uw_feed_status['tide']['last_ok'] = _now_ms
                _uw_feed_status['tide']['error']   = None
        except Exception as e:
            print(f'[UW] market_tide error: {e}')
            _uw_feed_status['tide']['error'] = str(e)

    # ── IV ranks — every 15 cycles ─────────────────────────────────────────
    if _cycle_n - _uw_last_iv_cycle >= 15 or _uw_last_iv_cycle == 0:
        _uw_last_iv_cycle = _cycle_n
        try:
            iv_map = await _run_sync(fetch_iv_ranks, _key)
            if iv_map:
                await _run_sync(uw_store.upsert_iv_ranks, iv_map)
                _uw_feed_status['iv']['last_ok'] = _now_ms
                _uw_feed_status['iv']['count']   = len(iv_map)
                _uw_feed_status['iv']['error']   = None
        except Exception as e:
            print(f'[UW] iv_ranks error: {e}')
            _uw_feed_status['iv']['error'] = str(e)

    # ── Congress trades — every 30 cycles ──────────────────────────────────
    if _cycle_n - _uw_last_cong_cycle >= 30 or _uw_last_cong_cycle == 0:
        _uw_last_cong_cycle = _cycle_n
        try:
            cong_evts = await _run_sync(fetch_congress_trades, _key)
            for evt in cong_evts:
                is_new = await _run_sync(uw_store.upsert_congress, evt)
                if is_new:
                    events.append(evt)
            _uw_feed_status['congress']['last_ok'] = _now_ms
            _uw_feed_status['congress']['count']   = len(cong_evts)
            _uw_feed_status['congress']['error']   = None
        except Exception as e:
            print(f'[UW] congress error: {e}')
            _uw_feed_status['congress']['error'] = str(e)

    # Prune old data every 10 cycles
    if _cycle_n % 10 == 0:
        await _run_sync(uw_store.prune)

    return events


async def run_uw_poll() -> None:
    """Force an immediate full UW poll of all feeds."""
    global _uw_last_dp_cycle, _uw_last_cong_cycle, _uw_last_iv_cycle
    _uw_last_dp_cycle   = 0
    _uw_last_cong_cycle = 0
    _uw_last_iv_cycle   = 0
    await _ingest_uw()


async def _pipeline_cycle():
    """One complete pipeline run: fetch → deduplicate → store → broadcast."""
    global _cycle_n
    _cycle_n += 1

    store   = get_store()
    t_start = time.time()

    # GDELT is rate-limited to ~12 req/hour — only call every 5 cycles (~5 min)
    run_gdelt = (_cycle_n % 5 == 1)
    print(f'[PIPELINE] cycle {_cycle_n} starting… (GDELT: {"yes" if run_gdelt else "skip"})')

    # Run news ingestion, market data, and UW concurrently
    events_task  = asyncio.create_task(_ingest_events(run_gdelt=run_gdelt))
    market_task  = asyncio.create_task(_ingest_market())
    uw_task      = asyncio.create_task(_ingest_uw())

    events     = await events_task
    market     = await market_task
    uw_events  = await uw_task

    # Merge all smart-money events into the main event stream
    events.extend(uw_events)

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
