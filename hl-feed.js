/* ══════════════════════════════════════════════════════════════════════════════
   HL-FEED v3 — Hyperliquid Real-Time Price Feed (Primary Source)
   ══════════════════════════════════════════════════════════════════════════════
   Connects to Hyperliquid's WebSocket (wss://api.hyperliquid.xyz/ws) and
   subscribes to allMids — streaming mid-prices for 300+ trading pairs including
   Gold, Silver, WTI/Brent crude (speculative), BTC/ETH/SOL, and 150+ US equities.

   v3 changes vs v2:
   ─ All dead named equity/commodity entries (CL, BRENTOIL, GOLD, NVDA…) removed
   ─ Replaced with @N spot token pair-index format (e.g. @247=TSLA, @251=AAPL)
     discovered via HL spotMeta endpoint — these actually stream in allMids
   ─ Now covers: BTC ETH SOL XRP BNB ADA (crypto perps) + TSLA AAPL AMZN META
     QQQ MSFT GOOGL HOOD SPY SLV GLD (HL spot equity/ETF tokens)
   ─ (v2) _hlPrices store, highest-priority source, HL fee model, richer API

   Public API: window.HLFeed
     .getPrice(eeName)   → { price, ts, ageSec, fresh, hlTicker } | null
     .covers(eeName)     → true if HL has this asset (regardless of WS state)
     .isAvailable(eeName)→ true if covered AND fresh price exists (< 30s old)
     .costs(eeName)      → HL cost object for sector | null if not HL-covered
     .coverage()         → sorted array of all EE asset names HL covers
     .status()           → { connected, lastTs, lastUpdate, pairsReceived, injected, errors }
     .tickers()          → { 'CL': '73.50', ... } last raw HL prices
     .restart()          → force reconnect

   @N spot tokens: HL lists equity/ETF/commodity spot tokens by pair-index in
   allMids (e.g. @247=TSLA, @251=AAPL). Prices are in fractional token units
   (not real USD). TA direction signals remain valid; stop/target values are in
   token units consistent with EE's HL spot trading. Never fall back to TD/AV
   for @N assets — incompatible price scale.
   GLD (@259) and SLV (@248) are HL spot ETF tokens, now included.
   ══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var HL_WS_URL     = 'wss://api.hyperliquid.xyz/ws';
  var HL_FRESH_MS   = 30000;    // price < 30s old = "fresh" (WS actively streaming)
  var RECONNECT_MS  = 12000;    // gap between reconnect attempts
  var MAX_ERRORS    = 10;       // suppress parse error logs after this many

  /* ── HL ticker/pair-index → EE asset name mapping ──────────────────────────
     Crypto perps use named tickers (e.g. 'BTC') — these match allMids keys.
     Equity/ETF spot tokens use @N pair-index from:
       POST /info {type:'spotMeta'} → universe[].index → '@N' key in allMids.
     Verified Mar 2026: spotMeta max pair index = 300. @263-@289 are the NEW
     full-USD-price equity tokens (TSLA at ~$246, META at ~$620, MSFT ~$399).
     Old fractional @247-@272 range (FI, MMOVE, RISK…) removed — wrong prices.
     Array order matters: first name is the "canonical" EE name for display.
     Not on HL spot (flagged by HL gate): LMT, RTX, NOC, TSM, ASML, XLE,
     SMH, SOXX, TLT, XOM, GDX, CORN, WHEAT, DAL, UAL.
     NVDA has a registered spot token (@408) but no confirmed active trading pair.
     WTI and BRENT are speculatively added — user-confirmed present on HL.  */
  var HL_MAP = {
    /* ── Crypto perps — named tickers present in allMids ───────────────── */
    'BTC':        ['BTC', 'BITCOIN'],
    'ETH':        ['ETH', 'ETHEREUM'],
    'SOL':        ['SOL'],
    'XRP':        ['XRP'],
    'BNB':        ['BNB'],
    'ADA':        ['ADA'],
    'DOGE':       ['DOGE'],
    'AVAX':       ['AVAX'],
    'DOT':        ['DOT'],
    'LINK':       ['LINK'],
    'LTC':        ['LTC'],
    'UNI':        ['UNI'],
    'AAVE':       ['AAVE'],
    'INJ':        ['INJ'],
    'SUI':        ['SUI'],
    'APT':        ['APT'],
    'TIA':        ['TIA'],
    'TON':        ['TON'],
    'NEAR':       ['NEAR'],
    'FIL':        ['FIL'],
    'ARB':        ['ARB'],
    'OP':         ['OP'],
    'ATOM':       ['ATOM'],
    'HYPE':       ['HYPE'],
    'WIF':        ['WIF'],
    'PEPE':       ['kPEPE', 'PEPE'],
    'BONK':       ['kBONK', 'BONK'],
    'FLOKI':      ['kFLOKI', 'FLOKI'],
    'SHIB':       ['kSHIB', 'SHIB'],
    'TAO':        ['TAO'],
    'RENDER':     ['RENDER', 'RNDR'],
    'FET':        ['FET'],
    'IMX':        ['IMX'],
    'SAND':       ['SAND'],
    'ALGO':       ['ALGO'],
    'XLM':        ['XLM'],
    'HBAR':       ['HBAR'],
    'ICP':        ['ICP'],
    'ETC':        ['ETC'],
    'BCH':        ['BCH'],
    'TRX':        ['TRX'],
    'SEI':        ['SEI'],
    'RUNE':       ['RUNE'],
    'ONDO':       ['ONDO'],
    'PENDLE':     ['PENDLE'],
    'JUP':        ['JUP'],
    'ENS':        ['ENS'],
    'MKR':        ['MKR'],
    'COMP':       ['COMP'],
    'SNX':        ['SNX'],
    'LDO':        ['LDO'],
    'ZRO':        ['ZRO'],
    'BLUR':       ['BLUR'],
    'GMX':        ['GMX'],
    'TRUMP':      ['TRUMP'],
    'WLD':        ['WLD'],
    'ENA':        ['ENA'],
    'EIGEN':      ['EIGEN'],
    'PYTH':       ['PYTH'],
    'CRV':        ['CRV'],
    /* Layer 1 / 2 extended */
    'MATIC':      ['MATIC'],
    'STX':        ['STX'],
    'CFX':        ['CFX'],
    'FTM':        ['FTM'],
    'MNT':        ['MNT'],
    'BLAST':      ['BLAST'],
    'STRK':       ['STRK'],
    'ZK':         ['ZK'],
    'SCR':        ['SCR'],
    'LINEA':      ['LINEA'],
    'POL':        ['POL'],
    'S':          ['S'],
    'BERA':       ['BERA'],
    'MOVE':       ['MOVE'],
    'INIT':       ['INIT'],
    'MON':        ['MON'],
    'MEGA':       ['MEGA'],
    'HEMI':       ['HEMI'],
    'SOPH':       ['SOPH'],
    '0G':         ['0G'],
    'NIL':        ['NIL'],
    'AZTEC':      ['AZTEC'],
    'ZORA':       ['ZORA'],
    'W':          ['W'],
    'STRAX':      ['STRAX'],
    /* DeFi extended */
    'DYDX':       ['DYDX'],
    'FXS':        ['FXS'],
    'SUSHI':      ['SUSHI'],
    'CAKE':       ['CAKE'],
    'BNT':        ['BNT'],
    'UMA':        ['UMA'],
    'STG':        ['STG'],
    'RDNT':       ['RDNT'],
    'AERO':       ['AERO'],
    'MORPHO':     ['MORPHO'],
    'RESOLV':     ['RESOLV'],
    'SYRUP':      ['SYRUP'],
    'USUAL':      ['USUAL'],
    'SKY':        ['SKY'],
    'ETHFI':      ['ETHFI'],
    'REZ':        ['REZ'],
    'LISTA':      ['LISTA'],
    /* Gaming / metaverse */
    'GALA':       ['GALA'],
    'AXS':        ['AXS'],
    'YGG':        ['YGG'],
    'SUPER':      ['SUPER'],
    'XAI':        ['XAI'],
    'MAVIA':      ['MAVIA'],
    'BIGTIME':    ['BIGTIME'],
    'PIXEL':      ['PIXEL'],
    'DOOD':       ['DOOD'],
    /* AI / tech */
    'AI16Z':      ['AI16Z'],
    'AIXBT':      ['AIXBT'],
    'ZEREBRO':    ['ZEREBRO'],
    'GRIFFAIN':   ['GRIFFAIN'],
    'VIRTUAL':    ['VIRTUAL'],
    'AI':         ['AI'],
    'BIO':        ['BIO'],
    'KAITO':      ['KAITO'],
    'PROMPT':     ['PROMPT'],
    'VVV':        ['VVV'],
    'LAUNCHCOIN': ['LAUNCHCOIN'],
    'AVNT':       ['AVNT'],
    'APEX':       ['APEX'],
    /* Memes / trending */
    'FARTCOIN':   ['FARTCOIN'],
    'MELANIA':    ['MELANIA'],
    'PNUT':       ['PNUT'],
    'CHILLGUY':   ['CHILLGUY'],
    'MOODENG':    ['MOODENG'],
    'GOAT':       ['GOAT'],
    'POPCAT':     ['POPCAT'],
    'BRETT':      ['BRETT'],
    'TURBO':      ['TURBO'],
    'NOT':        ['NOT'],
    'MEME':       ['MEME'],
    'ORDI':       ['ORDI'],
    'BOME':       ['BOME'],
    'APE':        ['APE'],
    'GMT':        ['GMT'],
    'BANANA':     ['BANANA'],
    'HMSTR':      ['HMSTR'],
    'MEW':        ['MEW'],
    'GRASS':      ['GRASS'],
    'PENGU':      ['PENGU'],
    'SPX':        ['SPX'],
    'ANIME':      ['ANIME'],
    'VINE':       ['VINE'],
    'JELLY':      ['JELLY'],
    'PURR':       ['PURR'],
    'TST':        ['TST'],
    'BABY':       ['BABY'],
    'HYPER':      ['HYPER'],
    'PUMP':       ['PUMP'],
    'FOGO':       ['FOGO'],
    'YZY':        ['YZY'],
    'WLFI':       ['WLFI'],
    'WCT':        ['WCT'],
    /* 1000x aliases */
    'kNEIRO':     ['kNEIRO'],
    'kDOGS':      ['kDOGS'],
    'kLUNC':      ['kLUNC'],
    /* Misc alts */
    'TRB':        ['TRB'],
    'FTT':        ['FTT'],
    'KAS':        ['KAS'],
    'BSV':        ['BSV'],
    'MINA':       ['MINA'],
    'POLYX':      ['POLYX'],
    'NEO':        ['NEO'],
    'ZEN':        ['ZEN'],
    'ILV':        ['ILV'],
    'RSR':        ['RSR'],
    'JTO':        ['JTO'],
    'NTRN':       ['NTRN'],
    'ACE':        ['ACE'],
    'MAV':        ['MAV'],
    'PEOPLE':     ['PEOPLE'],
    'MANTA':      ['MANTA'],
    'ALT':        ['ALT'],
    'ZETA':       ['ZETA'],
    'DYM':        ['DYM'],
    'SAGA':       ['SAGA'],
    'MERL':       ['MERL'],
    'LAYER':      ['LAYER'],
    'IP':         ['IP'],
    'OM':         ['OM'],
    'NXPC':       ['NXPC'],
    'IO':         ['IO'],
    'TNSR':       ['TNSR'],
    'OMNI':       ['OMNI'],
    'ZEC':        ['ZEC'],
    'XMR':        ['XMR'],
    'DASH':       ['DASH'],
    'AR':         ['AR'],
    'LIT':        ['LIT'],
    'ASTER':      ['ASTER'],
    'STBL':       ['STBL'],
    'STABLE':     ['STABLE'],
    '2Z':         ['2Z'],
    'CC':         ['CC'],
    'SKR':        ['SKR'],
    'PROVE':      ['PROVE'],
    'XPL':        ['XPL'],
    'MET':        ['MET'],
    'CELO':       ['CELO'],
    'IOTA':       ['IOTA'],
    'ME':         ['ME'],
    'NEIROETH':   ['NEIROETH'],
    'CATI':       ['CATI'],
    'HPOS':       ['HPOS'],
    'BLZ':        ['BLZ'],
    'CYBER':      ['CYBER'],
    'ARK':        ['ARK'],
    'BADGER':     ['BADGER'],
    'ORBS':       ['ORBS'],
    'USTC':       ['USTC'],
    'FRIEND':     ['FRIEND'],
    'SHIA':       ['SHIA'],
    'SKY':        ['SKY'],
    'AERO':       ['AERO'],

    /* ── Commodity perps (regular HL) ───────────────────────────────────── */
    'GAS':        ['GAS'],               // Natural gas perp; allMids key = GAS
    'PAXG':       ['PAXG', 'XAU'],       // PAX Gold perp

    /* ── xyz perps — NOT in allMids; prices polled via REST (10s interval)
       API format: xyz:COINNAME for l2Book / order placement.
       See XYZ_ASSETS map and _pollXyzPrices() below.                      */
    'xyz:BRENTOIL': ['BRENT', 'BRENTOIL'],
    'xyz:CL':       ['WTI', 'WTIOIL', 'CRUDE', 'OIL', 'CL'],
    'xyz:SILVER':   ['SILVER'],
    'xyz:GOLD':     ['GOLD'],
    'xyz:NATGAS':   ['NATGAS'],
    'xyz:SP500':    ['SP500'],
    'xyz:XYZ100':   ['XYZ100'],
    'xyz:EUR':      ['EUR'],
    'xyz:JPY':      ['JPY'],
    'xyz:COPPER':   ['COPPER'],
    'xyz:PLATINUM': ['PLATINUM'],

    /* ── HL spot equity/ETF tokens — @N pair-index (Apr 2026 spotMeta)
       Prices stream in allMids as '@N' keys.
       Indices verified via POST /info {type:'spotMeta'}.                   */
    '@407':  ['TSLA'],
    '@408':  ['NVDA'],
    '@409':  ['CRCL'],
    '@411':  ['SLV', 'XAG'],
    '@412':  ['GOOGL'],
    '@413':  ['AAPL'],
    '@415':  ['HOOD'],
    '@416':  ['SPACEX'],
    '@417':  ['MSTR'],
    '@418':  ['OPENAI'],
    '@420':  ['SPY'],
    '@421':  ['AMZN'],
    '@422':  ['META'],
    '@426':  ['QQQ'],
    '@429':  ['MSFT'],
    '@430':  ['ORCL'],
    '@431':  ['AVGO'],
    '@432':  ['GLD'],
    '@435':  ['MU']
  };

  /* ── HL-accurate cost model for paper-trading simulation ───────────────────
     Source: Hyperliquid fee schedule (March 2026)
       Taker (market/SL orders): 0.05%  = 0.0005
       Maker (limit/TP orders):  0.02%  = 0.0002
       We use taker rate as the per-side commission (conservative; most
       entries and SL exits are market orders on a perp DEX).
     Spreads are tighter than traditional CFD because HL runs an on-chain
     order book with active market makers.
     Funding: HL perpetuals use ~1h intervals. We store as 8h-equivalent
     (÷8 from 8h traditional rate) for compatibility with EE funding logic. */
  var HL_TRADING_COSTS = {
    crypto:    { spread: 0.0002, slippage: 0.0001, commission: 0.0005, funding8h: 0.0001  },
    energy:    { spread: 0.0003, slippage: 0.0002, commission: 0.0005, funding8h: 0.00005 },
    precious:  { spread: 0.0002, slippage: 0.0001, commission: 0.0005, funding8h: 0.00005 },
    commodity: { spread: 0.0003, slippage: 0.0002, commission: 0.0005, funding8h: 0.00005 },
    equity:    { spread: 0.0002, slippage: 0.0001, commission: 0.0005, funding8h: 0       },
    forex:     { spread: 0.0001, slippage: 0.0001, commission: 0.0005, funding8h: 0       },
    def:       { spread: 0.0003, slippage: 0.0002, commission: 0.0005, funding8h: 0       }
  };

  /* ── Sector classification for HL cost lookup ───────────────────────────────
     Maps every EE asset name that HL covers → cost sector key.               */
  var HL_SECTOR = {
    /* Major crypto */
    'BTC': 'crypto', 'BITCOIN': 'crypto', 'ETH': 'crypto', 'ETHEREUM': 'crypto',
    'SOL': 'crypto', 'XRP': 'crypto', 'BNB': 'crypto', 'ADA': 'crypto',
    'DOGE': 'crypto', 'AVAX': 'crypto', 'DOT': 'crypto', 'LINK': 'crypto',
    'LTC': 'crypto', 'UNI': 'crypto', 'AAVE': 'crypto', 'INJ': 'crypto',
    'SUI': 'crypto', 'APT': 'crypto', 'TIA': 'crypto', 'TON': 'crypto',
    'NEAR': 'crypto', 'FIL': 'crypto', 'ARB': 'crypto', 'OP': 'crypto',
    'ATOM': 'crypto', 'HYPE': 'crypto', 'WIF': 'crypto', 'PEPE': 'crypto',
    'BONK': 'crypto', 'FLOKI': 'crypto', 'SHIB': 'crypto', 'TAO': 'crypto',
    'RENDER': 'crypto', 'RNDR': 'crypto', 'FET': 'crypto', 'IMX': 'crypto',
    'SAND': 'crypto', 'ALGO': 'crypto', 'XLM': 'crypto', 'HBAR': 'crypto',
    'ICP': 'crypto', 'ETC': 'crypto', 'BCH': 'crypto', 'TRX': 'crypto',
    'SEI': 'crypto', 'RUNE': 'crypto', 'ONDO': 'crypto', 'PENDLE': 'crypto',
    'JUP': 'crypto', 'ENS': 'crypto', 'MKR': 'crypto', 'COMP': 'crypto',
    'SNX': 'crypto', 'LDO': 'crypto', 'ZRO': 'crypto', 'BLUR': 'crypto',
    'GMX': 'crypto', 'kPEPE': 'crypto', 'kBONK': 'crypto', 'kFLOKI': 'crypto',
    'kSHIB': 'crypto', 'TRUMP': 'crypto', 'WLD': 'crypto', 'ENA': 'crypto',
    'EIGEN': 'crypto', 'PYTH': 'crypto', 'CRV': 'crypto',
    /* Extended crypto */
    'MATIC': 'crypto', 'STX': 'crypto', 'CFX': 'crypto', 'FTM': 'crypto',
    'MNT': 'crypto', 'BLAST': 'crypto', 'STRK': 'crypto', 'ZK': 'crypto',
    'SCR': 'crypto', 'LINEA': 'crypto', 'POL': 'crypto', 'S': 'crypto',
    'BERA': 'crypto', 'MOVE': 'crypto', 'INIT': 'crypto', 'MON': 'crypto',
    'MEGA': 'crypto', 'HEMI': 'crypto', 'SOPH': 'crypto', '0G': 'crypto',
    'NIL': 'crypto', 'AZTEC': 'crypto', 'ZORA': 'crypto', 'W': 'crypto',
    'STRAX': 'crypto', 'DYDX': 'crypto', 'FXS': 'crypto', 'SUSHI': 'crypto',
    'CAKE': 'crypto', 'BNT': 'crypto', 'UMA': 'crypto', 'STG': 'crypto',
    'RDNT': 'crypto', 'AERO': 'crypto', 'MORPHO': 'crypto', 'RESOLV': 'crypto',
    'SYRUP': 'crypto', 'USUAL': 'crypto', 'SKY': 'crypto', 'ETHFI': 'crypto',
    'REZ': 'crypto', 'LISTA': 'crypto', 'GALA': 'crypto', 'AXS': 'crypto',
    'YGG': 'crypto', 'SUPER': 'crypto', 'XAI': 'crypto', 'MAVIA': 'crypto',
    'BIGTIME': 'crypto', 'PIXEL': 'crypto', 'DOOD': 'crypto',
    'AI16Z': 'crypto', 'AIXBT': 'crypto', 'ZEREBRO': 'crypto', 'GRIFFAIN': 'crypto',
    'VIRTUAL': 'crypto', 'AI': 'crypto', 'BIO': 'crypto', 'KAITO': 'crypto',
    'PROMPT': 'crypto', 'VVV': 'crypto', 'LAUNCHCOIN': 'crypto', 'AVNT': 'crypto',
    'APEX': 'crypto', 'FARTCOIN': 'crypto', 'MELANIA': 'crypto', 'PNUT': 'crypto',
    'CHILLGUY': 'crypto', 'MOODENG': 'crypto', 'GOAT': 'crypto', 'POPCAT': 'crypto',
    'BRETT': 'crypto', 'TURBO': 'crypto', 'NOT': 'crypto', 'MEME': 'crypto',
    'ORDI': 'crypto', 'BOME': 'crypto', 'APE': 'crypto', 'GMT': 'crypto',
    'BANANA': 'crypto', 'HMSTR': 'crypto', 'MEW': 'crypto', 'GRASS': 'crypto',
    'PENGU': 'crypto', 'SPX': 'crypto', 'ANIME': 'crypto', 'VINE': 'crypto',
    'JELLY': 'crypto', 'PURR': 'crypto', 'TST': 'crypto', 'BABY': 'crypto',
    'HYPER': 'crypto', 'PUMP': 'crypto', 'FOGO': 'crypto', 'YZY': 'crypto',
    'WLFI': 'crypto', 'WCT': 'crypto', 'kNEIRO': 'crypto', 'kDOGS': 'crypto',
    'kLUNC': 'crypto', 'TRB': 'crypto', 'FTT': 'crypto', 'KAS': 'crypto',
    'BSV': 'crypto', 'MINA': 'crypto', 'POLYX': 'crypto', 'NEO': 'crypto',
    'ZEN': 'crypto', 'ILV': 'crypto', 'RSR': 'crypto', 'JTO': 'crypto',
    'NTRN': 'crypto', 'ACE': 'crypto', 'MAV': 'crypto', 'PEOPLE': 'crypto',
    'MANTA': 'crypto', 'ALT': 'crypto', 'ZETA': 'crypto', 'DYM': 'crypto',
    'SAGA': 'crypto', 'MERL': 'crypto', 'LAYER': 'crypto', 'IP': 'crypto',
    'OM': 'crypto', 'NXPC': 'crypto', 'IO': 'crypto', 'TNSR': 'crypto',
    'OMNI': 'crypto', 'ZEC': 'crypto', 'XMR': 'crypto', 'DASH': 'crypto',
    'AR': 'crypto', 'LIT': 'crypto', 'ASTER': 'crypto', 'STBL': 'crypto',
    'STABLE': 'crypto', '2Z': 'crypto', 'CC': 'crypto', 'SKR': 'crypto',
    'PROVE': 'crypto', 'XPL': 'crypto', 'MET': 'crypto', 'CELO': 'crypto',
    'IOTA': 'crypto', 'ME': 'crypto', 'NEIROETH': 'crypto', 'CATI': 'crypto',
    'HPOS': 'crypto', 'BLZ': 'crypto', 'CYBER': 'crypto', 'ARK': 'crypto',
    'BADGER': 'crypto', 'ORBS': 'crypto', 'USTC': 'crypto', 'FRIEND': 'crypto',
    'SHIA': 'crypto',
    /* Spot equity/ETF tokens */
    'TSLA': 'equity', 'NVDA': 'equity', 'CRCL': 'equity', 'GOOGL': 'equity',
    'AAPL': 'equity', 'HOOD': 'equity', 'SPY': 'equity', 'AMZN': 'equity',
    'META': 'equity', 'QQQ': 'equity', 'MSFT': 'equity', 'ORCL': 'equity',
    'AVGO': 'equity', 'MU': 'equity', 'MSTR': 'equity', 'SPACEX': 'equity',
    'OPENAI': 'equity', 'SP500': 'equity',
    /* Spot precious metals */
    'SLV': 'precious', 'XAG': 'precious', 'GLD': 'precious',
    'PAXG': 'precious', 'XAU': 'precious',
    /* xyz commodity perps */
    'SILVER': 'precious', 'GOLD': 'precious', 'PLATINUM': 'precious',
    'WTI': 'energy', 'WTIOIL': 'energy', 'CRUDE': 'energy', 'OIL': 'energy',
    'CL': 'energy', 'BRENT': 'energy', 'BRENTOIL': 'energy',
    'GAS': 'energy', 'NATGAS': 'energy', 'COPPER': 'commodity',
    /* xyz forex/indices */
    'EUR': 'forex', 'JPY': 'forex', 'XYZ100': 'equity'
  };

  /* ── Build static coverage set and reverse-map at init ─────────────────────
     _hlCoveredAssets: { 'BTC': true, 'WTI': true, ... }
     _eeToHL:          { 'BTC': 'BTC', 'WTI': 'WTI', 'CRUDE': 'WTI', ... }  */
  var _hlCoveredAssets = {};
  var _eeToHL          = {};
  Object.keys(HL_MAP).forEach(function (hlTicker) {
    HL_MAP[hlTicker].forEach(function (eeName) {
      _hlCoveredAssets[eeName] = true;
      _eeToHL[eeName]          = hlTicker;
    });
  });

  /* ── State ──────────────────────────────────────────────────────────────────
     _hlPrices: per-EE-asset, updated on every allMids message.               */
  var _ws                = null;
  var _connected         = false;
  var _lastTs            = null;
  var _reconnectTs       = null;  // timestamp of most recent successful reconnection
  var _pairsReceived     = 0;
  var _injected          = 0;
  var _errors            = 0;
  var _reconnectTimer    = null;
  var _reconnectAttempts = 0;   // consecutive failures — drives exponential backoff
  var _lastRawPrices  = {};   // { 'CL': '73.50', ... } for HLFeed.tickers()
  var _hlPrices       = {};   // { 'WTI': { price: 73.5, ts: ..., hlTicker: 'CL' }, ... }
  var _eeReady        = false;

  /* ── xyz perp REST polling ─────────────────────────────────────────────────
     xyz perps (BRENTOIL, CL, SILVER, GOLD, etc.) are NOT in allMids WS.
     We poll l2Book every 10s and inject mid-prices the same way WS does.   */
  var XYZ_ASSETS = HL_MAP['xyz:BRENTOIL'] ? (function () {
    var m = {};
    Object.keys(HL_MAP).forEach(function (k) {
      if (k.slice(0, 4) === 'xyz:') m[k] = HL_MAP[k];
    });
    return m;
  }()) : {};

  var _xyzPollTimer = null;

  function _pollXyzPrices() {
    if (!_eeReady && !_checkEE()) return;
    Object.keys(XYZ_ASSETS).forEach(function (coin) {
      fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'l2Book', coin: coin, nSigFigs: 5 })
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.levels || !data.levels[0] || !data.levels[0].length ||
            !data.levels[1] || !data.levels[1].length) return;
        var bid = parseFloat(data.levels[0][0].px);
        var ask = parseFloat(data.levels[1][0].px);
        if (!isFinite(bid) || !isFinite(ask) || bid <= 0) return;
        var mid = (bid + ask) / 2;
        var now = Date.now();
        _lastRawPrices[coin] = String(mid);
        XYZ_ASSETS[coin].forEach(function (eeName) {
          _hlPrices[eeName] = { price: mid, ts: now, hlTicker: coin };
          EE.injectPrice(eeName, mid);
          _injected++;
        });
      })
      .catch(function () {});
    });
  }

  /* ── EE availability check ──────────────────────────────────────────────── */
  function _checkEE() {
    if (window.EE && typeof window.EE.injectPrice === 'function') {
      _eeReady = true;
      return true;
    }
    return false;
  }

  /* ── WebSocket connection ───────────────────────────────────────────────── */
  function _connect() {
    if (_ws && (_ws.readyState === WebSocket.CONNECTING ||
                _ws.readyState === WebSocket.OPEN)) return;
    if (typeof WebSocket === 'undefined') return;
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }

    try {
      _ws = new WebSocket(HL_WS_URL);

      _ws.onopen = function () {
        _connected         = true;
        _errors            = 0;
        _reconnectAttempts = 0;   // reset backoff on successful connection
        _reconnectTs       = Date.now();  // track reconnect time for price cooldown
        _ws.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'allMids' }
        }));
        _log('HL WebSocket connected — allMids subscribed (primary price source active)');
      };

      _ws.onmessage = function (evt) {
        try {
          var msg = JSON.parse(evt.data);
          if (!msg || msg.channel !== 'allMids' || !msg.data || !msg.data.mids) return;

          var mids = msg.data.mids;   // { 'CL': '73.50', 'GOLD': '3185.20', ... }
          _lastTs        = Date.now();
          _pairsReceived = Object.keys(mids).length;

          if (!_eeReady && !_checkEE()) return;

          Object.keys(HL_MAP).forEach(function (hlTicker) {
            var rawStr = mids[hlTicker];
            if (rawStr === undefined || rawStr === null) return;
            var price = parseFloat(rawStr);
            if (!isFinite(price) || price <= 0) return;

            /* Store raw for tickers() snapshot */
            _lastRawPrices[hlTicker] = rawStr;

            /* Store parsed price per EE asset name */
            HL_MAP[hlTicker].forEach(function (eeName) {
              _hlPrices[eeName] = { price: price, ts: _lastTs, hlTicker: hlTicker };
              /* Also push into EE's general price cache via injectPrice() */
              EE.injectPrice(eeName, price);
              _injected++;
            });
          });

        } catch (e) {
          _errors++;
          if (_errors <= MAX_ERRORS) {
            _log('Parse error: ' + (e.message || String(e)), true);
          }
        }
      };

      _ws.onclose = function () {
        _connected = false;
        _reconnectAttempts++;
        /* Exponential backoff: 12s → 24s → 48s → 60s cap, ±20% jitter.
           Prevents hammering the API during outages or auth failures.    */
        var base    = Math.min(60000, RECONNECT_MS * Math.pow(2, _reconnectAttempts - 1));
        var jitter  = base * 0.2 * (Math.random() * 2 - 1);   // ±20%
        var delay   = Math.round(base + jitter);
        _log('HL WebSocket closed — reconnecting in ' + (delay / 1000).toFixed(1) +
             's (attempt ' + _reconnectAttempts + ')');
        _reconnectTimer = setTimeout(_connect, delay);
      };

      _ws.onerror = function () {
        _connected = false;
        /* onclose fires after onerror — reconnect and backoff handled there */
      };

    } catch (e) {
      _log('WebSocket unavailable: ' + (e.message || String(e)), true);
      _reconnectAttempts++;
      var _errBase  = Math.min(60000, RECONNECT_MS * Math.pow(2, _reconnectAttempts));
      var _errDelay = Math.round(_errBase * (0.8 + Math.random() * 0.4));
      _reconnectTimer = setTimeout(_connect, _errDelay);
    }
  }

  /* ── Minimal logger ─────────────────────────────────────────────────────── */
  function _log(msg, isWarn) {
    if (typeof console === 'undefined') return;
    var prefix = '[HL-Feed] ';
    if (isWarn) console.warn(prefix + msg);
    else        console.log(prefix + msg);
  }

  /* ════════════════════════════════════════════════════════════════════════════
     PUBLIC API — window.HLFeed
     ════════════════════════════════════════════════════════════════════════════ */
  window.HLFeed = {

    /* ── Price lookup ───────────────────────────────────────────────────────
       Returns the most recent HL price for an EE asset name.
       fresh = price age < HL_FRESH_MS (30s) — WS is actively streaming.
       Returns null if asset is not HL-covered or no price received yet.    */
    getPrice: function (eeName) {
      var entry = _hlPrices[eeName ? eeName.toUpperCase() : ''];
      if (!entry) return null;
      var ageSec = Math.round((Date.now() - entry.ts) / 1000);
      return {
        price:    entry.price,
        ts:       entry.ts,
        ageSec:   ageSec,
        fresh:    (Date.now() - entry.ts) < HL_FRESH_MS,
        hlTicker: entry.hlTicker
      };
    },

    /* ── Asset coverage ─────────────────────────────────────────────────────
       Returns true if this asset is mapped in HL_MAP regardless of WS state.
       Used by _getCosts() — always use HL fee model for HL-covered assets.  */
    covers: function (eeName) {
      return !!_hlCoveredAssets[eeName ? eeName.toUpperCase() : ''];
    },

    /* ── Live availability ──────────────────────────────────────────────────
       Returns true if covered AND a fresh price (< 30s) exists.
       Used by buildTrade() to set price_source = 'HYPERLIQUID'.            */
    isAvailable: function (eeName) {
      var tok = eeName ? eeName.toUpperCase() : '';
      if (!_hlCoveredAssets[tok]) return false;
      var entry = _hlPrices[tok];
      return !!(entry && (Date.now() - entry.ts) < HL_FRESH_MS);
    },

    /* ── Cost model ─────────────────────────────────────────────────────────
       Returns HL perpetual fee structure for the asset's sector.
       Returns null if asset is not HL-covered (caller falls back to
       existing TRADING_COSTS sector lookup).                               */
    costs: function (eeName) {
      var tok    = eeName ? eeName.toUpperCase() : '';
      var sector = HL_SECTOR[tok];
      if (!sector) return null;
      return HL_TRADING_COSTS[sector] || HL_TRADING_COSTS.def;
    },

    /* ── Coverage list ──────────────────────────────────────────────────────
       Returns sorted array of all EE asset names HL covers.
       Useful for console inspection: HLFeed.coverage()                     */
    coverage: function () {
      return Object.keys(_hlCoveredAssets).sort();
    },

    /* ── Status ─────────────────────────────────────────────────────────── */
    status: function () {
      return {
        connected:     _connected,
        lastTs:        _lastTs,
        reconnectTs:   _reconnectTs,
        lastUpdate:    _lastTs
          ? Math.round((Date.now() - _lastTs) / 1000) + 's ago'
          : 'never',
        pairsReceived: _pairsReceived,
        injected:      _injected,
        errors:        _errors,
        coveredAssets: Object.keys(_hlCoveredAssets).length,
        freshPrices:   Object.keys(_hlPrices).filter(function (k) {
          return _hlPrices[k] && (Date.now() - _hlPrices[k].ts) < HL_FRESH_MS;
        }).length
      };
    },

    /* ── Raw ticker snapshot ────────────────────────────────────────────── */
    tickers: function () {
      return Object.assign({}, _lastRawPrices);
    },

    /* ── Force reconnect ────────────────────────────────────────────────── */
    restart: function () {
      if (_ws) { try { _ws.close(); } catch (e) {} }
      _connected = false;
      _connect();
    }
  };

  /* ── Structured asset registry — console: HL_ASSET_REGISTRY.table() ────── */
  window.HL_ASSET_REGISTRY = (function () {
    var ENTRIES = [
      /* Crypto perps */
      { eeName:'BTC',   hlTicker:'BTC',   assetClass:'crypto',   region:'GLOBAL', sector:'crypto',   onHL:true, fullPrice:true,  notes:'BTC perpetual' },
      { eeName:'ETH',   hlTicker:'ETH',   assetClass:'crypto',   region:'GLOBAL', sector:'crypto',   onHL:true, fullPrice:true,  notes:'ETH perpetual' },
      { eeName:'SOL',   hlTicker:'SOL',   assetClass:'crypto',   region:'GLOBAL', sector:'crypto',   onHL:true, fullPrice:true,  notes:'' },
      { eeName:'XRP',   hlTicker:'XRP',   assetClass:'crypto',   region:'GLOBAL', sector:'crypto',   onHL:true, fullPrice:true,  notes:'' },
      { eeName:'BNB',   hlTicker:'BNB',   assetClass:'crypto',   region:'GLOBAL', sector:'crypto',   onHL:true, fullPrice:true,  notes:'' },
      { eeName:'ADA',   hlTicker:'ADA',   assetClass:'crypto',   region:'GLOBAL', sector:'crypto',   onHL:true, fullPrice:true,  notes:'' },
      /* HL spot equity/ETF tokens — @N indices verified Apr 2026 via spotMeta */
      { eeName:'CRCL',   hlTicker:'@409', assetClass:'equity',   region:'US',     sector:'fintech',  onHL:true, fullPrice:true,  notes:'Circle pre-IPO' },
      { eeName:'TSLA',   hlTicker:'@407', assetClass:'equity',   region:'US',     sector:'ev',       onHL:true, fullPrice:true,  notes:'Tesla (Wagyu.xyz)' },
      { eeName:'NVDA',   hlTicker:'@408', assetClass:'equity',   region:'US',     sector:'semis',    onHL:true, fullPrice:true,  notes:'Nvidia (Wagyu.xyz)' },
      { eeName:'SLV',    hlTicker:'@411', assetClass:'precious', region:'GLOBAL', sector:'precious', onHL:true, fullPrice:true,  notes:'Silver spot token' },
      { eeName:'GOOGL',  hlTicker:'@412', assetClass:'equity',   region:'US',     sector:'tech',     onHL:true, fullPrice:true,  notes:'Alphabet' },
      { eeName:'AAPL',   hlTicker:'@413', assetClass:'equity',   region:'US',     sector:'tech',     onHL:true, fullPrice:true,  notes:'Apple' },
      { eeName:'HOOD',   hlTicker:'@415', assetClass:'equity',   region:'US',     sector:'fintech',  onHL:true, fullPrice:true,  notes:'Robinhood' },
      { eeName:'SPACEX', hlTicker:'@416', assetClass:'equity',   region:'US',     sector:'space',    onHL:true, fullPrice:true,  notes:'SpaceX (Wagyu.xyz)' },
      { eeName:'MSTR',   hlTicker:'@417', assetClass:'equity',   region:'US',     sector:'crypto',   onHL:true, fullPrice:true,  notes:'MicroStrategy' },
      { eeName:'OPENAI', hlTicker:'@418', assetClass:'equity',   region:'US',     sector:'ai',       onHL:true, fullPrice:true,  notes:'OpenAI (Wagyu.xyz)' },
      { eeName:'SPY',    hlTicker:'@420', assetClass:'equity',   region:'US',     sector:'index',    onHL:true, fullPrice:true,  notes:'S&P 500 ETF token' },
      { eeName:'AMZN',   hlTicker:'@421', assetClass:'equity',   region:'US',     sector:'tech',     onHL:true, fullPrice:true,  notes:'Amazon' },
      { eeName:'META',   hlTicker:'@422', assetClass:'equity',   region:'US',     sector:'tech',     onHL:true, fullPrice:true,  notes:'Meta' },
      { eeName:'QQQ',    hlTicker:'@426', assetClass:'equity',   region:'US',     sector:'index',    onHL:true, fullPrice:true,  notes:'Nasdaq 100 ETF token' },
      { eeName:'MSFT',   hlTicker:'@429', assetClass:'equity',   region:'US',     sector:'tech',     onHL:true, fullPrice:true,  notes:'Microsoft' },
      { eeName:'ORCL',   hlTicker:'@430', assetClass:'equity',   region:'US',     sector:'tech',     onHL:true, fullPrice:true,  notes:'Oracle' },
      { eeName:'AVGO',   hlTicker:'@431', assetClass:'equity',   region:'US',     sector:'semis',    onHL:true, fullPrice:true,  notes:'Broadcom' },
      { eeName:'GLD',    hlTicker:'@432', assetClass:'precious', region:'GLOBAL', sector:'precious', onHL:true, fullPrice:true,  notes:'Gold ETF token' },
      { eeName:'MU',     hlTicker:'@435', assetClass:'equity',   region:'US',     sector:'semis',    onHL:true, fullPrice:true,  notes:'Micron' },
      /* Commodity / forex xyz perps — polled via REST */
      { eeName:'GAS',      hlTicker:'GAS',          assetClass:'commodity', region:'GLOBAL', sector:'energy',    onHL:true, fullPrice:true, notes:'Natural gas perp' },
      { eeName:'WTI',      hlTicker:'xyz:CL',       assetClass:'commodity', region:'GLOBAL', sector:'energy',    onHL:true, fullPrice:true, notes:'WTI crude — xyz perp, API ticker CL' },
      { eeName:'BRENT',    hlTicker:'xyz:BRENTOIL', assetClass:'commodity', region:'GLOBAL', sector:'energy',    onHL:true, fullPrice:true, notes:'Brent crude — xyz perp' },
      { eeName:'SILVER',   hlTicker:'xyz:SILVER',   assetClass:'precious',  region:'GLOBAL', sector:'precious',  onHL:true, fullPrice:true, notes:'Silver — xyz perp' },
      { eeName:'GOLD',     hlTicker:'xyz:GOLD',     assetClass:'precious',  region:'GLOBAL', sector:'precious',  onHL:true, fullPrice:true, notes:'Gold — xyz perp' },
      { eeName:'NATGAS',   hlTicker:'xyz:NATGAS',   assetClass:'commodity', region:'GLOBAL', sector:'energy',    onHL:true, fullPrice:true, notes:'Nat gas — xyz perp' },
      { eeName:'COPPER',   hlTicker:'xyz:COPPER',   assetClass:'commodity', region:'GLOBAL', sector:'commodity', onHL:true, fullPrice:true, notes:'Copper — xyz perp' },
      { eeName:'PLATINUM', hlTicker:'xyz:PLATINUM', assetClass:'precious',  region:'GLOBAL', sector:'precious',  onHL:true, fullPrice:true, notes:'Platinum — xyz perp' },
      { eeName:'EUR',      hlTicker:'xyz:EUR',      assetClass:'forex',     region:'EU',     sector:'forex',     onHL:true, fullPrice:true, notes:'Euro — xyz perp' },
      { eeName:'JPY',      hlTicker:'xyz:JPY',      assetClass:'forex',     region:'ASIA',   sector:'forex',     onHL:true, fullPrice:true, notes:'Yen — xyz perp' },
      { eeName:'SP500',    hlTicker:'xyz:SP500',    assetClass:'equity',    region:'US',     sector:'index',     onHL:true, fullPrice:true, notes:'S&P 500 — xyz perp' },
      { eeName:'XYZ100',   hlTicker:'xyz:XYZ100',   assetClass:'equity',    region:'GLOBAL', sector:'index',     onHL:true, fullPrice:true, notes:'XYZ100 index — xyz perp' },
      { eeName:'LMT',   hlTicker:null, assetClass:'equity', region:'US', sector:'defense', onHL:false, fullPrice:false, notes:'No HL listing' },
      { eeName:'RTX',   hlTicker:null, assetClass:'equity', region:'US', sector:'defense', onHL:false, fullPrice:false, notes:'No HL listing' },
      { eeName:'TSM',   hlTicker:null, assetClass:'equity', region:'TAIWAN', sector:'semis', onHL:false, fullPrice:false, notes:'No HL listing' },
      { eeName:'TLT',   hlTicker:null, assetClass:'equity', region:'US', sector:'bonds', onHL:false, fullPrice:false, notes:'No HL listing' },
    ];
    return {
      all:      function () { return ENTRIES.slice(); },
      onHL:     function () { return ENTRIES.filter(function(e){ return e.onHL; }); },
      notOnHL:  function () { return ENTRIES.filter(function(e){ return !e.onHL; }); },
      find:     function (ee) { return ENTRIES.find(function(e){ return e.eeName === ee.toUpperCase(); }) || null; },
      table:    function () {
        var w = ['eeName','hlTicker','assetClass','sector','onHL','notes'];
        var rows = ENTRIES.map(function(e){
          return [e.eeName, e.hlTicker||'—', e.assetClass, e.sector, e.onHL?'✓':'✗', e.notes];
        });
        console.table(rows.reduce(function(o,r){ o[r[0]]={hlTicker:r[1],class:r[2],sector:r[3],onHL:r[4],notes:r[5]}; return o; }, {}));
      }
    };
  }());

  /* ── Boot: start 6s after page load to avoid clash with IC 4s bootstrap ── */
  window.addEventListener('load', function () {
    setTimeout(function () {
      _checkEE();
      _connect();
      /* Start xyz perp REST poll — immediate first fetch, then every 10s */
      _pollXyzPrices();
      _xyzPollTimer = setInterval(_pollXyzPrices, 10000);
    }, 6000);
  });

}());
