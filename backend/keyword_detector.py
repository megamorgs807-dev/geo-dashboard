"""
GeoIntel Backend — Keyword Detector
Mirrors the frontend's SEV, GEO, MKTMAP, and REGIONS tables exactly
so backend-scored events rank consistently with frontend-ingested events.

V9: Added negation filter.
  Problem: "Iran DENIES nuclear weapon" scored identically to "Iran LAUNCHES
  nuclear strike" because keyword matching is context-blind.
  Fix: Before matching a severity keyword, check if a negation word appears
  within a short window before it in the text. If so, halve that keyword's
  effective weight.
"""
import re
from typing import List, Dict, Tuple

# ── Negation window ──────────────────────────────────────────────────────────
# Words that negate or heavily qualify a following keyword.
# We check within _NEGATION_WINDOW characters before each keyword match.
_NEGATION_WORDS = (
    'no ', 'not ', "n't ", 'deny ', 'denies ', 'denied ', 'denying ',
    'reject ', 'rejects ', 'rejected ', 'rejecting ',
    'avoid ', 'avoids ', 'avoided ', 'preventing ', 'prevent ',
    'halt ', 'halts ', 'halted ', 'pause ', 'paused ',
    'false ', 'fake ', 'hoax ', 'rumor ', 'rumour ', 'unconfirmed ',
    'alleged ', 'reportedly ', 'claims to ', 'claim of ',
    'warns against ', 'warns of ', 'warning against ',
    'threat of ', 'fear of ', 'risk of ',   # risk-framing (not actual event)
    'rule out ', 'rules out ', 'ruled out ',
    'ceasefire in ', 'end to ', 'end the ',
    'condemn ', 'condemns ', 'condemned ',
)
_NEGATION_WINDOW = 60  # characters to look back before the keyword


def _is_negated(text: str, keyword: str, match_pos: int) -> bool:
    """
    Return True if the keyword at match_pos appears to be negated.
    Looks back _NEGATION_WINDOW characters for any negation word.
    """
    window_start = max(0, match_pos - _NEGATION_WINDOW)
    window = text[window_start:match_pos]
    return any(neg in window for neg in _NEGATION_WORDS)


def _negation_multiplier(text: str, keyword: str) -> float:
    """
    Return 1.0 if the keyword is used assertively, 0.4 if negated.
    Only applies the penalty on the first occurrence found.
    """
    pos = text.find(keyword)
    if pos == -1:
        return 1.0  # keyword not found — won't be used in scoring anyway
    return 0.4 if _is_negated(text, keyword, pos) else 1.0

# ── Severity keywords (mirrors frontend SEV table) ──────────────────────────
SEV: Dict[str, float] = {
    'nuclear war':           0.99,
    'nuclear strike':        0.98,
    'world war':             0.98,
    'nuclear weapon':        0.95,
    'all-out war':           0.92,
    'full-scale war':        0.92,
    'full-scale invasion':   0.91,
    'assassination':         0.90,
    'invasion':              0.90,
    'full-scale':            0.88,
    'coup':                  0.88,
    'ballistic missile':     0.88,
    'nuclear':               0.85,
    'missile strike':        0.85,
    'airstrike':             0.85,
    'air strike':            0.85,
    'mobilization':          0.85,
    'mobilisation':          0.85,
    'terrorist attack':      0.83,
    'bombing':               0.83,
    'war':                   0.82,
    'drone strike':          0.82,
    'rocket attack':         0.80,
    'naval confrontation':   0.80,
    'battle':                0.80,
    'troop movement':        0.80,
    'blockade':              0.78,
    'border clash':          0.78,
    'troops':                0.72,
    'missile':               0.75,
    'military exercise':     0.68,
    'sanctions':             0.65,
    'sanction':              0.65,
    'cyber attack':          0.65,
    'energy disruption':     0.65,
    'airspace':              0.62,
    'naval exercise':        0.62,
    'military':              0.60,
    'deploy':                0.58,
    'ceasefire':             0.28,
    'peace talks':           0.22,
    'negotiations':          0.20,
    'deescalation':          0.18,
    'de-escalation':         0.18,
}

# ── Geographic importance keywords (mirrors frontend GEO table) ──────────────
GEO: Dict[str, float] = {
    'strait':        0.90,
    'airspace':      0.85,
    'border':        0.80,
    'naval':         0.80,
    'maritime':      0.75,
    'corridor':      0.70,
    'territory':     0.70,
    'pipeline':      0.70,
    'front line':    0.85,
    'frontline':     0.85,
    'port':          0.60,
    'base':          0.60,
    'capital':       0.50,
    'region':        0.40,
}

# ── Market sensitivity map (mirrors frontend MKTMAP) ─────────────────────────
MKTMAP: Dict[str, List[str]] = {
    'oil':            ['WTI', 'BRENT'],
    'petroleum':      ['WTI', 'BRENT'],
    'crude':          ['WTI', 'BRENT'],
    'opec':           ['WTI', 'BRENT'],
    'aramco':         ['WTI', 'BRENT'],
    'pipeline':       ['WTI', 'BRENT'],
    'hormuz':         ['WTI', 'BRENT', 'GLD'],
    'strait of hormuz': ['WTI', 'BRENT', 'GLD'],
    'red sea':        ['WTI', 'BRENT'],
    'houthi':         ['WTI', 'BRENT'],
    'gold':           ['GLD', 'BTC'],
    'safe haven':     ['GLD', 'BTC'],
    'inflation':      ['GLD', 'BTC'],
    'sanction':       ['BTC', 'GLD'],
    'swift':          ['BTC', 'GLD'],
    'dollar':         ['GLD', 'BTC'],
    'nuclear':        ['GLD', 'LMT'],
    'missile':        ['GLD', 'LMT'],
    'military':       ['LMT', 'GLD'],
    'defense':        ['LMT'],
    'arms':           ['LMT'],
    'lockheed':       ['LMT'],
    'taiwan':         ['TSM', 'GLD', 'LMT'],
    'taipei':         ['TSM', 'GLD'],
    'semiconductor':  ['TSM'],
    'chip':           ['TSM'],
    'tsmc':           ['TSM'],
    'china':          ['GLD', 'SPY', 'TSM'],
    'beijing':        ['GLD', 'SPY'],
    'trade war':      ['GLD', 'SPY'],
    'tariff':         ['GLD', 'SPY'],
    'ukraine':        ['WTI', 'BRENT', 'GLD', 'WHT'],
    'wheat':          ['WHT'],
    'grain':          ['WHT'],
    'food':           ['WHT'],
    'russia':         ['WTI', 'BRENT', 'GLD', 'WHT', 'GAS'],
    'kremlin':        ['WTI', 'BRENT', 'GLD'],
    'gas':            ['GAS', 'WTI'],
    'natural gas':    ['GAS'],
    'iran':           ['WTI', 'BRENT', 'GLD', 'LMT'],
    'tehran':         ['WTI', 'GLD'],
    'middle east':    ['WTI', 'GLD'],
    'israel':         ['WTI', 'GLD', 'LMT'],
    'gaza':           ['WTI', 'GLD'],
    'bitcoin':        ['BTC'],
    'ethereum':       ['ETH'],
    'crypto':         ['BTC', 'ETH'],
    'fed':            ['GLD', 'SPY'],
    'federal reserve': ['GLD', 'SPY'],
    'interest rate':  ['GLD', 'SPY'],
    'recession':      ['GLD', 'SPY'],
    'market crash':   ['GLD', 'BTC'],
    'north korea':    ['GLD', 'LMT'],
    'pyongyang':      ['GLD', 'LMT'],
    'india':          ['GLD', 'WTI'],
    'kashmir':        ['GLD', 'WTI'],
    'pakistan':       ['GLD'],
    'korea':          ['GLD', 'LMT'],
}

# ── Region extraction (ordered list — first match wins) ─────────────────────
# Each entry: (keyword, canonical_region)
REGION_PATTERNS: List[Tuple[str, str]] = [
    ('hormuz',             'IRAN'),
    ('irgc',               'IRAN'),
    ('revolutionary guard','IRAN'),
    ('iran',               'IRAN'),
    ('tehran',             'IRAN'),
    ('persian gulf',       'IRAN'),
    ('west bank',          'ISRAEL'),
    ('hezbollah',          'ISRAEL'),
    ('hamas',              'ISRAEL'),
    ('gaza',               'ISRAEL'),
    ('tel aviv',           'ISRAEL'),
    ('jerusalem',          'ISRAEL'),
    ('israel',             'ISRAEL'),
    ('zaporizhzhia',       'UKRAINE'),
    ('donbas',             'UKRAINE'),
    ('donbass',            'UKRAINE'),
    ('crimea',             'UKRAINE'),
    ('kharkiv',            'UKRAINE'),
    ('kherson',            'UKRAINE'),
    ('odessa',             'UKRAINE'),
    ('kyiv',               'UKRAINE'),
    ('ukraine',            'UKRAINE'),
    ('kremlin',            'RUSSIA'),
    ('putin',              'RUSSIA'),
    ('moscow',             'RUSSIA'),
    ('russia',             'RUSSIA'),
    ('russian',            'RUSSIA'),
    ('taiwan strait',      'TAIWAN'),
    ('tsmc',               'TAIWAN'),
    ('taipei',             'TAIWAN'),
    ('taiwan',             'TAIWAN'),
    ('south china sea',    'CHINA'),
    ('pla',                'CHINA'),
    ('xi jinping',         'CHINA'),
    ('beijing',            'CHINA'),
    ('china',              'CHINA'),
    ('chinese',            'CHINA'),
    ('dprk',               'KOREA'),
    ('north korea',        'KOREA'),
    ('pyongyang',          'KOREA'),
    ('kim jong',           'KOREA'),
    ('islamabad',          'PAKISTAN'),
    ('isi',                'PAKISTAN'),
    ('pakistan',           'PAKISTAN'),
    ('kashmir',            'INDIA'),
    ('new delhi',          'INDIA'),
    ('modi',               'INDIA'),
    ('india',              'INDIA'),
    ('riyadh',             'SAUDI'),
    ('aramco',             'SAUDI'),
    ('bin salman',         'SAUDI'),
    ('saudi',              'SAUDI'),
    ('sanaa',              'YEMEN'),
    ('houthi',             'YEMEN'),
    ('yemen',              'YEMEN'),
    ('damascus',           'SYRIA'),
    ('syria',              'SYRIA'),
    ('syrian',             'SYRIA'),
    ('baghdad',            'IRAQ'),
    ('iraq',               'IRAQ'),
    ('iraqi',              'IRAQ'),
    ('kabul',              'AFGHAN'),
    ('taliban',            'AFGHAN'),
    ('afghanistan',        'AFGHAN'),
    ('transnistria',       'BALKANS'),
    ('moldova',            'BALKANS'),
    ('kosovo',             'BALKANS'),
    ('serbia',             'BALKANS'),
    ('balkans',            'BALKANS'),
    ('nagorno',            'CAUCASUS'),
    ('azerbaijan',         'CAUCASUS'),
    ('armenia',            'CAUCASUS'),
    ('caucasus',           'CAUCASUS'),
    ('pentagon',           'NATO'),
    ('nato',               'NATO'),
    ('white house',        'NATO'),
    ('state department',   'NATO'),
    ('svalbard',           'ARCTIC'),
    ('arctic',             'ARCTIC'),
]


def dedupe_key(title: str) -> str:
    """Matches frontend's dedupeKey() exactly."""
    return re.sub(r'[^a-z0-9]', '', title.lower())[:48]


def extract_region(text: str) -> str:
    """Return first matching region or 'GLOBAL'."""
    tl = text.lower()
    for keyword, region in REGION_PATTERNS:
        if keyword in tl:
            return region
    return 'GLOBAL'


def extract_assets(text: str) -> List[str]:
    """Return deduplicated list of affected tickers."""
    tl = text.lower()
    seen = []
    result = []
    for keyword, tickers in MKTMAP.items():
        if keyword in tl:
            for t in tickers:
                if t not in seen:
                    seen.append(t)
                    result.append(t)
    return result


def extract_keywords(text: str) -> List[str]:
    """Return all severity keywords found in text."""
    tl = text.lower()
    return [kw for kw in SEV if kw in tl]


def score_event(
    title: str,
    desc: str = '',
    src_count: int = 1,
    social_v: float = 0.0,
) -> int:
    """
    Compute 0-100 signal score.
      s1 = max severity weight × 25 × negation_mult  (0-25)
      s2 = severity-weighted kw sum × 5, cap 20       (0-20)
      s3 = srcCount × 4, cap 15                       (0-15)
      s4 = socialV × 15, cap 15                       (0-15)
      s5 = max geo weight × 15                        (0-15)
      s6 = asset count × 2, cap 10                    (0-10)
    Total capped at 100.

    V9: s1 and s2 are now negation-aware.
    Keywords preceded by negation words within _NEGATION_WINDOW chars
    are multiplied by 0.4 (heavy but not zero — negation framing still
    indicates the topic is relevant, just not confirmed).
    """
    text = (title + ' ' + desc).lower()

    # s1 — severity (negation-aware)
    max_sev = 0.0
    for k in SEV:
        if k in text:
            effective = SEV[k] * _negation_multiplier(text, k)
            if effective > max_sev:
                max_sev = effective
    s1 = max_sev * 25

    # s2 — keyword quality (severity-weighted × negation-aware, matches frontend V9.5)
    # High-sev keywords (nuclear=1.0 → +5) outweigh low-sev (tension=0.3 → +1.5).
    kw_sev_sum = sum(
        SEV[k] * _negation_multiplier(text, k)
        for k in SEV if k in text
    )
    s2 = min(20.0, kw_sev_sum * 5)

    # s3 — source corroboration
    s3 = min(15.0, src_count * 4)

    # s4 — social velocity
    s4 = min(15.0, social_v * 15)

    # s5 — geographic importance
    max_geo = max((GEO[k] for k in GEO if k in text), default=0.0)
    s5 = max_geo * 15

    # s6 — market sensitivity
    assets = extract_assets(text)
    s6 = min(10.0, len(assets) * 2)

    return min(100, int(s1 + s2 + s3 + s4 + s5 + s6))


def build_event(
    title: str,
    desc: str,
    source: str,
    src_count: int = 1,
    social_v: float = 0.0,
    ts: int = None,
) -> dict:
    """
    Build a complete event dict ready for SSE broadcast and DB storage.
    Matches the shape expected by the frontend IC.events array.
    """
    import time as _time
    ts = ts or int(_time.time() * 1000)

    # Format time as HH:MM (matches frontend .time field)
    import datetime
    dt = datetime.datetime.fromtimestamp(ts / 1000)
    time_str = dt.strftime('%H:%M')

    text = title + ' ' + desc

    return {
        'title':    title[:90],
        'desc':     desc[:200],
        'source':   source,
        'ts':       ts,
        'time':     time_str,
        'region':   extract_region(text),
        'keywords': extract_keywords(text),
        'assets':   extract_assets(text),
        'signal':   score_event(title, desc, src_count, social_v),
        'srcCount': src_count,
        'socialV':  round(social_v, 3),
    }
