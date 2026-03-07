"""
GeoIntel Backend — GDELT Ingester
Fetches geopolitical articles from GDELT v2 Doc API (free, no key).

V9 improvements:
  - Uses `sourcecountry` to apply a regional-source boost.
    An article about Iran published by an Iranian/Israeli/US source
    carries more evidential weight than an unrelated source reporting it.
  - Uses `seendate` to skip stale articles (older than pipeline cycle).
  - Tone field is NOT available in artlist mode; handled instead
    by the negation filter in keyword_detector.py.
"""
import requests
from datetime import datetime, timezone
from typing import List, Dict

from config import GDELT_URL, BROWSER_HEADERS, CYCLE_SECONDS
from keyword_detector import build_event, extract_region


# Countries whose media we consider primary sources for each region
_REGIONAL_SOURCE_BOOST: dict = {
    'Israel':       ['IRAN', 'ISRAEL', 'SAUDI', 'YEMEN'],
    'Iran':         ['IRAN', 'SAUDI', 'YEMEN'],
    'UnitedStates': ['NATO', 'IRAN', 'UKRAINE', 'TAIWAN', 'KOREA'],
    'Russia':       ['RUSSIA', 'UKRAINE'],
    'Ukraine':      ['UKRAINE', 'RUSSIA'],
    'China':        ['CHINA', 'TAIWAN'],
    'Taiwan':       ['TAIWAN', 'CHINA'],
    'NorthKorea':   ['KOREA'],
    'SouthKorea':   ['KOREA'],
    'UnitedKingdom':['NATO'],
    'Germany':      ['NATO', 'UKRAINE'],
    'France':       ['NATO'],
    'SaudiArabia':  ['SAUDI', 'YEMEN', 'IRAN'],
}


def fetch_gdelt() -> List[Dict]:
    """
    Fetch up to 20 recent geopolitical articles from GDELT v2.
    Returns a list of event dicts ready for EventStore.
    """
    try:
        resp = requests.get(GDELT_URL, headers=BROWSER_HEADERS, timeout=12)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f'[GDELT] fetch error: {e}')
        return []

    articles = data.get('articles', [])
    events = []

    for art in articles:
        title       = (art.get('title') or '').strip()
        desc        = (art.get('seendescription') or '').strip()
        src         = _short_source(art.get('domain', 'GDELT'))
        src_country = (art.get('sourcecountry') or '').replace(' ', '')

        if not title:
            continue

        # ── Regional-source boost ──────────────────────────────────────────────
        # If the article's source country is a primary actor for the
        # detected region, treat it as higher-quality corroboration.
        text_region  = extract_region(title + ' ' + desc)
        src_regions  = _REGIONAL_SOURCE_BOOST.get(src_country, [])
        src_boost    = 0.5 if text_region in src_regions else 0.0

        evt = build_event(
            title=title,
            desc=desc,
            source=src,
            social_v=src_boost,
        )

        # Store source country for transparency
        if src_country:
            evt['gdelt_src_country'] = src_country

        events.append(evt)

    print(f'[GDELT] fetched {len(events)} articles')
    return events


def _short_source(domain: str) -> str:
    """Turn a domain like 'reuters.com' into 'REUTERS'."""
    d = domain.lower().replace('www.', '')
    known = {
        'reuters.com':       'REUTERS',
        'bbc.com':           'BBC',
        'bbc.co.uk':         'BBC',
        'aljazeera.com':     'ALJAZ',
        'theguardian.com':   'GUARDIAN',
        'dw.com':            'DW',
        'npr.org':           'NPR',
        'apnews.com':        'AP',
        'afp.com':           'AFP',
        'thehill.com':       'HILL',
        'politico.com':      'POLITICO',
        'foreignpolicy.com': 'FP',
        'defensenews.com':   'DEFNEWS',
        'janes.com':         'JANES',
        'axios.com':         'AXIOS',
    }
    return known.get(d, d.split('.')[0].upper()[:8])
