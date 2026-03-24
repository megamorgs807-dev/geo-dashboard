"""
GeoIntel Backend — World Bank Macro Ingester
Fetches GDP growth, inflation, current account balance, and government debt
for conflict-relevant countries. Updated once daily on startup.

API: https://api.worldbank.org/v2/ (free, no auth)
"""
import requests
from typing import Dict, Optional


# Countries of geopolitical interest (World Bank ISO-3 codes)
WB_COUNTRIES = ['IRN', 'UKR', 'RUS', 'CHN', 'ISR', 'SDN', 'PAK', 'ETH', 'PRK', 'SYR']

# Indicator codes → friendly key names
WB_INDICATORS: Dict[str, str] = {
    'gdp_growth': 'NY.GDP.MKTP.KD.ZG',   # GDP growth (annual %)
    'inflation':  'FP.CPI.TOTL.ZG',       # CPI inflation (annual %)
    'ca_balance': 'BN.CAB.XOKA.GD.ZS',   # Current account balance (% of GDP)
    'govt_debt':  'GC.DOD.TOTL.GD.ZS',   # Central govt debt (% of GDP)
}

# In-memory cache — updated by fetch_worldbank(), read by get_cache()
_cache: Dict[str, Dict] = {}


def fetch_worldbank() -> Dict[str, Dict]:
    """
    Fetch most-recent-value for each indicator+country pair.
    Results are stored in _cache and returned.
    Takes ~40 requests but each is fast; called once at startup + every 6h.
    """
    result: Dict[str, Dict] = {}

    for iso in WB_COUNTRIES:
        result[iso] = {}
        for key, indicator in WB_INDICATORS.items():
            url = f'https://api.worldbank.org/v2/country/{iso}/indicator/{indicator}'
            try:
                r = requests.get(url, params={'format': 'json', 'mrv': 1}, timeout=10)
                rows = r.json()
                # World Bank returns [metadata_obj, [data_rows]]
                if rows and len(rows) > 1 and rows[1]:
                    value = rows[1][0].get('value')
                    if value is not None:
                        result[iso][key] = round(float(value), 2)
            except Exception as e:
                print(f'[WORLDBANK] {iso}/{key} error: {e}')

    _cache.update(result)
    country_count = sum(1 for v in result.values() if v)
    print(f'[WORLDBANK] fetched data for {country_count}/{len(WB_COUNTRIES)} countries')
    return _cache


def get_cache() -> Dict[str, Dict]:
    """Return the current cached World Bank data (may be empty before first fetch)."""
    return _cache
