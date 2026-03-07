"""
GeoIntel Backend — Configuration
All tunable constants in one place.
"""
import os

# ── Server ──────────────────────────────────────────────────────────────────
HOST            = '0.0.0.0'
PORT            = 8765
CYCLE_SECONDS   = 60          # pipeline polling interval
MAX_EVENTS_DB   = 5000        # SQLite rows to keep
SSE_KEEPALIVE   = 25          # seconds between SSE heartbeats

# ── Storage ─────────────────────────────────────────────────────────────────
DB_PATH         = os.path.join(os.path.dirname(__file__), 'events.db')

# ── Optional API keys (set via environment variables) ───────────────────────
ALPHA_VANTAGE_KEY = os.getenv('AV_KEY', '')          # free key from alphavantage.co
NEWS_API_KEY      = os.getenv('NEWS_API_KEY', '')    # newsapi.org (optional)

# ── GDELT ───────────────────────────────────────────────────────────────────
GDELT_URL = (
    'https://api.gdeltproject.org/api/v2/doc/doc'
    '?query=(military+OR+sanctions+OR+nuclear+OR+missile+OR+troops+OR+war'
    '+OR+invasion+OR+airstrike+OR+conflict)'
    '+sourcelang:English'
    '&mode=artlist&maxrecords=20&format=json&sort=DateDesc&timespan=1h'
)

# ── RSS Feeds ────────────────────────────────────────────────────────────────
RSS_FEEDS = [
    ('https://feeds.bbci.co.uk/news/world/rss.xml',           'BBC'),
    ('https://feeds.reuters.com/reuters/worldNews',            'REUTERS'),
    ('https://www.aljazeera.com/xml/rss/all.xml',              'ALJAZ'),
    ('https://www.theguardian.com/world/rss',                  'GUARDIAN'),
    ('https://rss.dw.com/xml/rss-en-world',                    'DW'),
    ('https://feeds.npr.org/1004/rss.xml',                     'NPR'),
    ('https://www.globalsecurity.org/rss/newslinks.rss',       'GLOBSEC'),
]

# ── Reddit ───────────────────────────────────────────────────────────────────
REDDIT_SUBS = [
    'geopolitics',
    'worldnews',
    'CredibleDefense',
    'UkraineWarVideoReport',
    'europe',
]
REDDIT_UA = 'GeoDash/1.0 (contact: geodash@localhost)'

# ── Market data ──────────────────────────────────────────────────────────────
COINGECKO_URL = (
    'https://api.coingecko.com/api/v3/simple/price'
    '?ids=bitcoin,ethereum'
    '&vs_currencies=usd'
    '&include_24hr_change=true'
    '&include_1hr_change=true'
    '&precision=2'
)

# Yahoo Finance unofficial endpoint (no key required)
YAHOO_QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols={symbols}'

# Ticker → Yahoo Finance symbol mapping
YAHOO_SYMBOLS = {
    'WTI':   'CL=F',    # WTI Crude Oil Futures
    'BRENT': 'BZ=F',    # Brent Crude Oil Futures
    'GLD':   'GC=F',    # Gold Futures
    'WHT':   'ZW=F',    # Wheat Futures
    'GAS':   'NG=F',    # Natural Gas Futures
    'LMT':   'LMT',     # Lockheed Martin
    'TSM':   'TSM',     # Taiwan Semiconductor
    'SPY':   'SPY',     # S&P 500 ETF
    # ── Macro fear / regime indicators ───────────────────────────────────────
    'VIX':   '^VIX',     # CBOE Volatility Index — fear gauge
    'DXY':   'DX-Y.NYB', # US Dollar Index — safe-haven flows
    'US10Y': '^TNX',     # 10-Year Treasury Yield — risk-off signal
}

# HTTP headers for requests that require a browser-like UA
BROWSER_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/120.0.0.0 Safari/537.36'
    ),
    'Accept': 'application/json, text/html, */*',
}
