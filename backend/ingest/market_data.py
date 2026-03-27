"""
GeoIntel Backend — Market Data Ingester
Fetches live prices for:
  • Crypto        — CoinGecko (free, no key)
  • Commodities / equities — Stooq (free, no key, no rate limit)
  • VIX           — Stooq VX.F (front-month VIX futures — good proxy)
  • US10Y yield   — US Treasury FiscalData API (official, free, no key)

Replaced Yahoo Finance (v7/v8) which returns 429 too aggressively.
"""
import csv
import io
import datetime
import requests
from typing import Dict, Any

from config import COINGECKO_URL, BROWSER_HEADERS


# ── Stooq symbol map: our ticker → Stooq symbol ──────────────────────────────
# NOTE: VIX is intentionally excluded from Stooq — we use CBOE CDN directly
# (see _fetch_cboe_vix_term). VX.F (VIX futures) on Stooq gets stuck at the
# expired-contract price after each monthly roll, causing false RISK_OFF reads.
STOOQ_SYMBOLS: Dict[str, str] = {
    'WTI':   'CL.F',    # WTI Crude Oil (front-month futures)
    'BRENT': 'BR.F',    # Brent Crude Oil Futures
    'GLD':   'GLD.US',  # SPDR Gold Shares ETF (correct ~$417 price, not Gold Futures ~$4456)
    'WHT':   'ZW.F',    # Wheat Futures
    'GAS':   'NG.F',    # Natural Gas Futures
    'LMT':   'LMT.US',  # Lockheed Martin
    'TSM':   'TSM.US',  # Taiwan Semiconductor
    'SPY':   'SPY.US',  # S&P 500 ETF
    'DXY':   'DX.F',    # US Dollar Index Futures
}

# US Treasury daily yield curve — 10-Year column
_TREASURY_URL = (
    'https://home.treasury.gov/resource-center/data-chart-center/'
    'interest-rates/daily-treasury-rates.csv/{year}/all'
    '?type=daily_treasury_yield_curve'
    '&field_tdr_date_value_month={ym}'
    '&data-chart-center-interest-rates=Separate'
    '&download_data_type=CSV'
)

# Stooq real-time quote endpoint (no rate limit, no key required)
# Returns CSV: Symbol,Date,Time,Open,High,Low,Close,Volume
_STOOQ_BASE = 'https://stooq.com/q/l/?s={symbol}&f=sd2t2ohlcv&h&e=csv'



# ── Caches — Stooq is rate-limited (~200 req/day per IP) so refresh every 10 min
_stooq_cache:    Dict[str, Dict[str, Any]] = {}
_stooq_last_ts:  float = 0.0
_STOOQ_TTL_SECS: float = 600.0   # 10 minutes

_crypto_cache:   Dict[str, Dict[str, Any]] = {}
_crypto_last_ts: float = 0.0
_CRYPTO_TTL_SECS: float = 120.0  # 2 minutes (CoinGecko free tier = 30 req/min)


def fetch_market_prices() -> Dict[str, Dict[str, Any]]:
    """
    Returns a dict keyed by our internal ticker symbols, e.g.:
    {
      'BTC':   {'price': 85000.0, 'chg24h': 2.34},
      'VIX':   {'price': 18.5,   'chg24h': -0.80},
      'US10Y': {'price': 4.15,   'chg24h': -0.03},
      ...
    }
    """
    prices: Dict[str, Dict[str, Any]] = {}
    prices.update(_fetch_crypto_cached())
    prices.update(_fetch_stooq_cached())
    prices.update(_fetch_us10y())
    prices.update(_fetch_cboe_vix_term())
    return prices


# ── Cached wrappers ───────────────────────────────────────────────────────────

def _fetch_crypto_cached() -> Dict[str, Dict[str, Any]]:
    global _crypto_cache, _crypto_last_ts
    if _crypto_cache and (datetime.datetime.now().timestamp() - _crypto_last_ts) < _CRYPTO_TTL_SECS:
        return _crypto_cache
    result = _fetch_crypto()
    if result:
        _crypto_cache   = result
        _crypto_last_ts = datetime.datetime.now().timestamp()
    return result or _crypto_cache


def _fetch_stooq_cached() -> Dict[str, Dict[str, Any]]:
    global _stooq_cache, _stooq_last_ts
    if _stooq_cache and (datetime.datetime.now().timestamp() - _stooq_last_ts) < _STOOQ_TTL_SECS:
        print(f'[MARKET] Stooq: serving cache ({len(_stooq_cache)} tickers)')
        return _stooq_cache
    result = _fetch_stooq()
    if result:
        # Merge with old cache: preserve stale prices for tickers missing from the fresh
        # result (e.g. WTI/Brent returning N/D during a futures contract roll period).
        merged = dict(_stooq_cache)
        for ticker, data in result.items():
            data.pop('stale', None)   # clear any previous staleness flag
            merged[ticker] = data
        for ticker in list(merged.keys()):
            if ticker not in result:
                merged[ticker] = dict(merged[ticker])
                merged[ticker]['stale'] = True
                print(f'[MARKET] Stooq: {ticker} missing from refresh — keeping stale price')
        _stooq_cache   = merged
        _stooq_last_ts = datetime.datetime.now().timestamp()
    return result or _stooq_cache


# ── CoinGecko (BTC, ETH) ─────────────────────────────────────────────────────

def _fetch_crypto() -> Dict[str, Dict[str, Any]]:
    try:
        resp = requests.get(COINGECKO_URL, timeout=10)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f'[MARKET] CoinGecko error: {e}')
        return {}

    result = {}
    mapping = {'bitcoin': 'BTC', 'ethereum': 'ETH'}
    for coin_id, ticker in mapping.items():
        if coin_id not in data:
            continue
        c = data[coin_id]
        result[ticker] = {
            'price':  c.get('usd'),
            'chg24h': c.get('usd_24h_change'),
            'chg1h':  c.get('usd_1h_change'),
        }

    print(f'[MARKET] CoinGecko: {list(result.keys())}')
    return result


# ── Stooq (commodities, equities, VIX, DXY) ──────────────────────────────────

def _stooq_price(symbol: str) -> Dict[str, Any]:
    """
    Fetch the current Stooq quote for `symbol`.
    CSV columns: Symbol, Date, Time, Open, High, Low, Close, Volume
    Uses intraday (Open→Close) as a proxy for 24h change.
    Returns {'price': float, 'chg24h': float} or {} on failure.
    """
    url = _STOOQ_BASE.format(symbol=symbol.lower())
    try:
        resp = requests.get(url, headers=BROWSER_HEADERS, timeout=10)
        resp.raise_for_status()
        rows = list(csv.reader(io.StringIO(resp.text)))
    except Exception as e:
        print(f'[MARKET] Stooq {symbol} error: {e}')
        return {}

    # rows[0] = header, rows[1] = quote row
    data_rows = [r for r in rows[1:] if r and len(r) >= 7 and 'N/D' not in r]
    if not data_rows:
        return {}

    row = data_rows[0]
    try:
        # Columns: 0=Symbol,1=Date,2=Time,3=Open,4=High,5=Low,6=Close,7=Volume
        open_  = float(row[3])
        close  = float(row[6])
    except (IndexError, ValueError):
        return {}

    chg24h = None
    if open_ and open_ != close:
        chg24h = round((close - open_) / open_ * 100, 2)

    return {'price': round(close, 4), 'chg24h': chg24h}


def _fetch_stooq() -> Dict[str, Dict[str, Any]]:
    result = {}
    for our_ticker, stooq_sym in STOOQ_SYMBOLS.items():
        d = _stooq_price(stooq_sym)
        if d:
            result[our_ticker] = d

    print(f'[MARKET] Stooq: {list(result.keys())}')
    return result


# ── US Treasury 10-Year Yield ─────────────────────────────────────────────────

def _fetch_us10y() -> Dict[str, Dict[str, Any]]:
    """
    Pull the official daily 10-Year yield from the US Treasury website.
    Returns {'US10Y': {'price': 4.15, 'chg24h': -0.03}} or {}.
    """
    now = datetime.date.today()
    # Try current month; fall back to previous if early in month
    for delta_months in (0, -1):
        year  = now.year  + (now.month + delta_months - 1) // 12
        month = (now.month + delta_months - 1) % 12 + 1
        ym    = f'{year}{month:02d}'
        url   = _TREASURY_URL.format(year=year, ym=ym)
        try:
            resp = requests.get(url, headers=BROWSER_HEADERS, timeout=10)
            resp.raise_for_status()
            rows = list(csv.reader(io.StringIO(resp.text)))
        except Exception as e:
            print(f'[MARKET] Treasury US10Y error: {e}')
            continue

        # rows[0] = headers, rows[1] = latest date, rows[2] = previous date
        data_rows = [r for r in rows[1:] if r and len(r) > 12]
        if not data_rows:
            continue

        # Find '10 Yr' column index
        headers = rows[0]
        try:
            idx = headers.index('10 Yr')
        except ValueError:
            print('[MARKET] Treasury: 10 Yr column not found')
            return {}

        try:
            yield_today = float(data_rows[0][idx])
        except (IndexError, ValueError):
            continue

        chg24h = None
        if len(data_rows) >= 2:
            try:
                yield_prev = float(data_rows[1][idx])
                chg24h = round(yield_today - yield_prev, 3)  # yield points, not %
            except (IndexError, ValueError):
                pass

        print(f'[MARKET] US10Y: {yield_today}% (chg24h {chg24h})')
        return {'US10Y': {'price': yield_today, 'chg24h': chg24h}}

    return {}


# ── CBOE VIX term structure (VIX9D, VIX3M) ────────────────────────────────────
# Source: CBOE's own CDN — free, no key, delayed ~15min
_CBOE_BASE   = 'https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/{sym}.json'
_cboe_cache: Dict[str, Dict[str, Any]] = {}
_cboe_last_ts: float = 0.0
_CBOE_TTL: float = 600.0   # 10 minutes


def _fetch_cboe_vix_term() -> Dict[str, Dict[str, Any]]:
    global _cboe_cache, _cboe_last_ts
    now = datetime.datetime.now().timestamp()
    if _cboe_cache and (now - _cboe_last_ts) < _CBOE_TTL:
        return _cboe_cache

    result: Dict[str, Dict[str, Any]] = {}
    # VIX = spot CBOE VIX index (_VIX).  VX.F (Stooq futures) was removed because
    # it freezes at the expired-contract price after each monthly roll, causing
    # wildly incorrect readings (e.g. 96.3 when real VIX was 27.4).
    for ticker, sym in [('VIX', '_VIX'), ('VIX9D', '_VIX9D'), ('VIX3M', '_VIX3M')]:
        try:
            url  = _CBOE_BASE.format(sym=sym)
            resp = requests.get(url, timeout=10, headers=BROWSER_HEADERS)
            resp.raise_for_status()
            data   = resp.json()
            series = data.get('data', [])
            if not series:
                continue
            latest = series[-1]
            close  = float(latest.get('close', 0))
            prev   = float(series[-2].get('close', 0)) if len(series) >= 2 else None
            chg24h = round(close - prev, 2) if prev else None
            # Sanity bounds — real VIX all-time high is ~89.5 (March 2020);
            # reject anything above 90 as a bad data point
            if close > 90:
                print(f'[MARKET] CBOE {ticker}: price {close} rejected — exceeds realistic maximum (ATH ~89.5)')
                continue
            result[ticker] = {'price': round(close, 2), 'chg24h': chg24h}
        except Exception as e:
            print(f'[MARKET] CBOE {ticker} error: {e}')

    if result:
        _cboe_cache   = result
        _cboe_last_ts = now
        print(f'[MARKET] CBOE VIX term: {result}')
    return result or _cboe_cache
