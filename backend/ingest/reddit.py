"""
GeoIntel Backend — Reddit Ingester
Fetches top/new posts from geopolitical subreddits via Reddit's JSON API.
No OAuth needed for read-only public access.
"""
import requests
import time
from typing import List, Dict

from config import REDDIT_SUBS, REDDIT_UA
from keyword_detector import build_event, extract_keywords

# Reddit rate-limit: ~60 requests/min unauthenticated.
# We batch all subs in one pass per cycle.
_last_call: float = 0.0
_MIN_INTERVAL = 2.0  # seconds between requests


def fetch_reddit() -> List[Dict]:
    """
    Fetch top posts (sorted by new) from all configured subreddits.
    Returns event dicts for entries that contain severity keywords.
    """
    events = []
    for sub in REDDIT_SUBS:
        events.extend(_fetch_sub(sub))
    print(f'[REDDIT] total geo-relevant posts: {len(events)}')
    return events


def _fetch_sub(sub: str) -> List[Dict]:
    global _last_call

    # Polite rate-limiting
    elapsed = time.time() - _last_call
    if elapsed < _MIN_INTERVAL:
        time.sleep(_MIN_INTERVAL - elapsed)
    _last_call = time.time()

    url = f'https://www.reddit.com/r/{sub}/new.json?limit=10'
    headers = {
        'User-Agent': REDDIT_UA,
        'Accept': 'application/json',
    }

    try:
        resp = requests.get(url, headers=headers, timeout=10)
        if resp.status_code == 429:
            print(f'[REDDIT] r/{sub} rate-limited — skipping')
            return []
        if resp.status_code == 403:
            print(f'[REDDIT] r/{sub} forbidden (private?) — skipping')
            return []
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f'[REDDIT] r/{sub} error: {e}')
        return []

    posts = data.get('data', {}).get('children', [])
    events = []
    for post in posts:
        p = post.get('data', {})
        title    = (p.get('title') or '').strip()
        selftext = (p.get('selftext') or '')[:200].strip()
        score    = p.get('score', 0)
        ups      = p.get('ups', 0)

        if not title:
            continue

        combined = (title + ' ' + selftext).lower()
        if not _is_relevant(combined):
            continue

        # Normalise upvote score → socialV using log scale.
        # Linear cap at 5000 meant anything significant was always maxed at 1.0.
        # log10 scale: 10 ups→0.25, 100→0.50, 1000→0.75, 10000→1.0
        import math
        social_v = min(1.0, math.log10(ups + 1) / 4.0) if ups > 0 else 0.0

        evt = build_event(
            title=title,
            desc=selftext,
            source=f'r/{sub}',
            social_v=social_v,
        )
        events.append(evt)

    print(f'[REDDIT] r/{sub}: {len(events)} relevant posts')
    return events


def _is_relevant(text: str) -> bool:
    return bool(extract_keywords(text))
