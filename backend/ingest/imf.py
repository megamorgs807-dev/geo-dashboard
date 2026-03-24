"""
GeoIntel Backend — IMF DataMapper Ingester
Fetches World Economic Outlook (WEO) forecast indicators for conflict-relevant countries.
Provides forward-looking GDP growth and inflation projections.

API: https://www.imf.org/external/datamapper/api/v1/ (free, no auth)
"""
import requests
from typing import Dict


# WEO indicator codes → friendly key names
IMF_INDICATORS: Dict[str, str] = {
    'gdp_growth': 'NGDP_RPCH',   # Real GDP growth (%)
    'inflation':  'PCPIPCH',      # CPI inflation (%)
}

# Countries of geopolitical interest (IMF ISO-3 codes)
IMF_COUNTRIES = ['IRN', 'UKR', 'RUS', 'CHN', 'ISR', 'SDN', 'PAK', 'ETH', 'PRK', 'SYR']

# In-memory cache — updated by fetch_imf(), read by get_cache()
_cache: Dict[str, Dict] = {}


def fetch_imf() -> Dict[str, Dict]:
    """
    Fetch the latest WEO forecast values for each indicator+country.
    Uses the most recent year available (IMF typically has 1-2 year forecasts).
    Results are stored in _cache and returned.
    Called once at startup + every 6h.
    """
    result: Dict[str, Dict] = {}

    for key, indicator in IMF_INDICATORS.items():
        url = f'https://www.imf.org/external/datamapper/api/v1/{indicator}'
        try:
            r    = requests.get(url, timeout=15)
            r.raise_for_status()
            data = r.json().get('values', {}).get(indicator, {})

            for iso in IMF_COUNTRIES:
                if iso not in result:
                    result[iso] = {}
                years = data.get(iso, {})
                if years:
                    # Take the latest year with a non-null value
                    latest_year = max(years.keys())
                    val = years[latest_year]
                    if val is not None:
                        result[iso][key]      = round(float(val), 2)
                        result[iso][f'{key}_year'] = latest_year

        except Exception as e:
            print(f'[IMF] {key} ({indicator}) error: {e}')

    _cache.update(result)
    country_count = sum(1 for v in result.values() if v)
    print(f'[IMF] fetched WEO data for {country_count}/{len(IMF_COUNTRIES)} countries')
    return _cache


def get_cache() -> Dict[str, Dict]:
    """Return the current cached IMF data (may be empty before first fetch)."""
    return _cache
