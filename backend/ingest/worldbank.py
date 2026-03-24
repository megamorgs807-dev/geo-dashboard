"""
GeoIntel Backend — World Bank Macro Ingester
Fetches GDP growth, inflation, current account balance, and government debt
for conflict-relevant countries. Updated once daily on startup.

API: https://api.worldbank.org/v2/ (free, no auth)

Uses the multi-country bulk endpoint to fetch each indicator across all 10
countries in a single request (instead of 40 sequential requests).
"""
import requests
from typing import Dict


# Countries of geopolitical interest (World Bank ISO-3 codes)
# PRK (North Korea) and SYR (Syria) excluded — World Bank has no reliable recent data
WB_COUNTRIES = ['IRN', 'UKR', 'RUS', 'CHN', 'ISR', 'SDN', 'PAK', 'ETH']

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
    Fetch most-recent-value for each indicator across all countries.
    Uses the bulk endpoint: /v2/country/{a;b;c}/indicator/{id} to pull
    all 10 countries in a single request per indicator (4 requests total).
    Results are stored in _cache and returned.
    """
    result: Dict[str, Dict] = {iso: {} for iso in WB_COUNTRIES}
    country_codes = ';'.join(WB_COUNTRIES)   # e.g. 'IRN;UKR;RUS;CHN;...'

    for key, indicator in WB_INDICATORS.items():
        url = f'https://api.worldbank.org/v2/country/{country_codes}/indicator/{indicator}'
        try:
            r = requests.get(
                url,
                params={'format': 'json', 'mrv': 1, 'per_page': 50},
                timeout=30,
            )
            r.raise_for_status()
            rows = r.json()
            # World Bank returns [metadata_obj, [data_rows]]
            if rows and len(rows) > 1 and rows[1]:
                for row in rows[1]:
                    iso = (row.get('countryiso3code') or '').upper()
                    val = row.get('value')
                    if iso in result and val is not None:
                        result[iso][key] = round(float(val), 2)
        except Exception as e:
            print(f'[WORLDBANK] {key} bulk fetch error: {e}')

    _cache.update(result)
    country_count = sum(1 for v in result.values() if v)
    print(f'[WORLDBANK] fetched data for {country_count}/{len(WB_COUNTRIES)} countries')
    return _cache


def get_cache() -> Dict[str, Dict]:
    """Return the current cached World Bank data (may be empty before first fetch)."""
    return _cache
