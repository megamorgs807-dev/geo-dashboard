"""
GeoIntel Backend — ReliefWeb Ingester
Fetches humanitarian crisis reports from OCHA's ReliefWeb API (free, no auth).

Reports cover: conflict, displacement, humanitarian response, natural disasters.
Provides structured, UN-quality source data alongside GDELT/RSS.
API docs: https://apidoc.rwlabs.org/
"""
import requests
from typing import List, Dict

from keyword_detector import build_event


RELIEFWEB_URL = 'https://api.reliefweb.int/v1/reports'


def fetch_reliefweb() -> List[Dict]:
    """
    Fetch up to 20 recent humanitarian reports from ReliefWeb.
    Returns a list of event dicts ready for EventStore.
    """
    params = {
        'appname':          'geodash',
        'limit':            20,
        'preset':           'latest',
        'fields[include][]': ['title', 'body-html', 'source', 'date', 'country'],
    }

    try:
        r = requests.get(RELIEFWEB_URL, params=params, timeout=10)
        r.raise_for_status()
        data = r.json().get('data', [])
    except Exception as e:
        print(f'[RELIEFWEB] fetch error: {e}')
        return []

    events = []
    for item in data:
        f      = item.get('fields', {})
        title  = (f.get('title') or '').strip()
        body   = (f.get('body-html') or '')[:500]   # truncate — just for keyword detection

        if not title:
            continue

        # Source label: prefer named source org, fall back to 'RELIEFWEB'
        sources = f.get('source', [])
        if isinstance(sources, list) and sources:
            src_name = sources[0].get('name', 'RELIEFWEB')
            # Shorten to max 8 chars, uppercase
            src = src_name.split(' ')[0].upper()[:8]
        else:
            src = 'RELIEFWEB'

        evt = build_event(title=title, desc=body, source=src)
        events.append(evt)

    print(f'[RELIEFWEB] fetched {len(events)} reports')
    return events
