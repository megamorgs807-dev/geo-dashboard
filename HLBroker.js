/* ═══════════════════════════════════════════════════════════════════════════
   HL-BROKER v1 — Hyperliquid perpetuals adapter (testnet + mainnet)
   ═══════════════════════════════════════════════════════════════════════════
   Routes crypto perp orders through the local backend (localhost:8765/api/hl/).
   The backend holds the private key and handles EIP-712 signing via the
   official hyperliquid-python-sdk.

   Covers all major HL perp coins including everything Alpaca handles as
   crypto fallback — when HLBroker is connected it takes priority.

   Usage:
     HLBroker.connect(wallet, privateKey, testnet)
     HLBroker.covers('BTC')          → true/false
     HLBroker.placeOrder('BTC', notional, 'buy', {leverage: 5})
     HLBroker.closePosition('BTC')
     HLBroker.getPositions()         → Promise<positions[]>
     HLBroker.status()               → connection summary
     HLBroker.renderCard()

   Exposed as window.HLBroker
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var BACKEND = 'http://localhost:8765';
  var STORE_KEY = 'hl_broker_ui_v1';

  /* ── HL perp assets — all coins available as perpetuals on Hyperliquid ── */
  var HL_ASSETS = {
    /* ── Major crypto ────────────────────────────────────────────────── */
    'BTC':       { name: 'Bitcoin' },
    'ETH':       { name: 'Ethereum' },
    'SOL':       { name: 'Solana' },
    'XRP':       { name: 'XRP' },
    'DOGE':      { name: 'Dogecoin' },
    'ADA':       { name: 'Cardano' },
    'AVAX':      { name: 'Avalanche' },
    'DOT':       { name: 'Polkadot' },
    'LINK':      { name: 'Chainlink' },
    'LTC':       { name: 'Litecoin' },
    'BCH':       { name: 'Bitcoin Cash' },
    'UNI':       { name: 'Uniswap' },
    'AAVE':      { name: 'Aave' },
    'BNB':       { name: 'BNB' },
    /* ── Layer 1 / Layer 2 ───────────────────────────────────────────── */
    'ATOM':      { name: 'Cosmos' },
    'NEAR':      { name: 'NEAR Protocol' },
    'SUI':       { name: 'Sui' },
    'APT':       { name: 'Aptos' },
    'ARB':       { name: 'Arbitrum' },
    'OP':        { name: 'Optimism' },
    'TRX':       { name: 'TRON' },
    'TON':       { name: 'Toncoin' },
    'ICP':       { name: 'Internet Computer' },
    'SEI':       { name: 'Sei' },
    'MATIC':     { name: 'Polygon' },
    'STX':       { name: 'Stacks' },
    'CFX':       { name: 'Conflux' },
    'FTM':       { name: 'Fantom' },
    'CANTO':     { name: 'Canto' },
    'MINA':      { name: 'Mina Protocol' },
    'CELO':      { name: 'Celo' },
    'IOTA':      { name: 'IOTA' },
    'NEO':       { name: 'NEO' },
    'ZEN':       { name: 'Horizen' },
    'BSV':       { name: 'Bitcoin SV' },
    'DASH':      { name: 'Dash' },
    'XMR':       { name: 'Monero' },
    'ZEC':       { name: 'Zcash' },
    'AR':        { name: 'Arweave' },
    'MNT':       { name: 'Mantle' },
    'BLAST':     { name: 'Blast' },
    'STRK':      { name: 'Starknet' },
    'ZK':        { name: 'ZKsync' },
    'SCR':       { name: 'Scroll' },
    'LINEA':     { name: 'Linea' },
    'POL':       { name: 'Polygon (POL)' },
    'S':         { name: 'Sonic' },
    'BERA':      { name: 'Berachain' },
    'MOVE':      { name: 'Movement' },
    'INIT':      { name: 'Initia' },
    'MON':       { name: 'Monad' },
    'MEGA':      { name: 'MegaETH' },
    'HEMI':      { name: 'Hemi' },
    'SOPH':      { name: 'Sophon' },
    '0G':        { name: '0G Labs' },
    'NIL':       { name: 'Nil Foundation' },
    'AZTEC':     { name: 'Aztec' },
    'ZORA':      { name: 'Zora' },
    /* ── DeFi ────────────────────────────────────────────────────────── */
    'MKR':       { name: 'MakerDAO' },
    'SNX':       { name: 'Synthetix' },
    'CRV':       { name: 'Curve' },
    'GMX':       { name: 'GMX' },
    'COMP':      { name: 'Compound' },
    'INJ':       { name: 'Injective' },
    'RUNE':      { name: 'THORChain' },
    'LDO':       { name: 'Lido DAO' },
    'PENDLE':    { name: 'Pendle' },
    'ZRO':       { name: 'LayerZero' },
    'BLUR':      { name: 'Blur' },
    'DYDX':      { name: 'dYdX' },
    'FXS':       { name: 'Frax Share' },
    'SUSHI':     { name: 'SushiSwap' },
    'CAKE':      { name: 'PancakeSwap' },
    'BNT':       { name: 'Bancor' },
    'UMA':       { name: 'UMA' },
    'STG':       { name: 'Stargate Finance' },
    'RDNT':      { name: 'Radiant Capital' },
    'AERO':      { name: 'Aerodrome Finance' },
    'MORPHO':    { name: 'Morpho' },
    'RESOLV':    { name: 'Resolv' },
    'SYRUP':     { name: 'Maple Finance Syrup' },
    'USUAL':     { name: 'Usual' },
    'SKY':       { name: 'Sky' },
    'ETHFI':     { name: 'Ether.fi' },
    'REZ':       { name: 'Renzo' },
    'LISTA':     { name: 'Lista DAO' },
    /* ── Layer 1 extended ────────────────────────────────────────────── */
    'ALGO':      { name: 'Algorand' },
    'XLM':       { name: 'Stellar' },
    'HBAR':      { name: 'Hedera' },
    'FIL':       { name: 'Filecoin' },
    'ETC':       { name: 'Ethereum Classic' },
    'KAS':       { name: 'Kaspa' },
    'POLYX':     { name: 'Polymesh' },
    'STRAX':     { name: 'Stratis' },
    'RSR':       { name: 'Reserve Rights' },
    'ORBS':      { name: 'Orbs' },
    'REQ':       { name: 'Request' },
    'BLZ':       { name: 'Bluzelle' },
    'LOOM':      { name: 'Loom Network' },
    'OGN':       { name: 'Origin Protocol' },
    'ARK':       { name: 'Ark' },
    'BADGER':    { name: 'Badger DAO' },
    'FLR':       { name: 'Flare' },
    'NTRN':      { name: 'Neutron' },
    'TIA':       { name: 'Celestia' },
    'DYM':       { name: 'Dymension' },
    'ZETA':      { name: 'ZetaChain' },
    'ALT':       { name: 'AltLayer' },
    'MANTA':     { name: 'Manta Network' },
    'OMNI':      { name: 'Omni Network' },
    'IO':        { name: 'io.net' },
    'SAGA':      { name: 'Saga' },
    'TNSR':      { name: 'Tensor' },
    'MERL':      { name: 'Merlin Chain' },
    'LAYER':     { name: 'Solayer' },
    'IP':        { name: 'Story Protocol' },
    'OM':        { name: 'MANTRA' },
    'W':         { name: 'Wormhole' },
    'NXPC':      { name: 'Nexapoint' },
    /* ── Gaming / metaverse ──────────────────────────────────────────── */
    'SAND':      { name: 'The Sandbox' },
    'IMX':       { name: 'Immutable X' },
    'GALA':      { name: 'Gala' },
    'ILV':       { name: 'Illuvium' },
    'YGG':       { name: 'Yield Guild Games' },
    'AXS':       { name: 'Axie Infinity' },
    'SUPER':     { name: 'SuperVerse' },
    'PIXEL':     { name: 'Pixels' },
    'XAI':       { name: 'XAI' },
    'MAVIA':     { name: 'Heroes of Mavia' },
    'BIGTIME':   { name: 'BigTime' },
    'DOOD':      { name: 'Doodles' },
    /* ── AI / infra ──────────────────────────────────────────────────── */
    'FET':       { name: 'Fetch.ai' },
    'TAO':       { name: 'Bittensor' },
    'RENDER':    { name: 'Render' },
    'RNDR':      { name: 'Render (RNDR)' },
    'ONDO':      { name: 'Ondo Finance' },
    'ENA':       { name: 'Ethena' },
    'EIGEN':     { name: 'EigenLayer' },
    'PYTH':      { name: 'Pyth Network' },
    'JUP':       { name: 'Jupiter' },
    'ENS':       { name: 'Ethereum Name Service' },
    'AI16Z':     { name: 'ai16z' },
    'AIXBT':     { name: 'AIXBT' },
    'ZEREBRO':   { name: 'Zerebro' },
    'GRIFFAIN':  { name: 'Griffain' },
    'VIRTUAL':   { name: 'Virtuals Protocol' },
    'AI':        { name: 'Sleepless AI' },
    'BIO':       { name: 'BIO Protocol' },
    'KAITO':     { name: 'Kaito' },
    'PROMPT':    { name: 'Prompt' },
    'VVV':       { name: 'Venice Token' },
    'LAUNCHCOIN':{ name: 'Launchcoin' },
    'AVNT':      { name: 'Avantis' },
    'APEX':      { name: 'ApeX Protocol' },
    /* ── Memes / trending ────────────────────────────────────────────── */
    'WIF':       { name: 'dogwifhat' },
    'PEPE':      { name: 'Pepe' },
    'BONK':      { name: 'Bonk' },
    'FLOKI':     { name: 'FLOKI' },
    'SHIB':      { name: 'Shiba Inu' },
    'TRUMP':     { name: 'TRUMP' },
    'WLD':       { name: 'Worldcoin' },
    'HYPE':      { name: 'Hyperliquid' },
    'PURR':      { name: 'Purr' },
    'FARTCOIN':  { name: 'Fartcoin' },
    'MELANIA':   { name: 'MELANIA' },
    'PNUT':      { name: 'Peanut the Squirrel' },
    'CHILLGUY':  { name: 'Chill Guy' },
    'MOODENG':   { name: 'Moo Deng' },
    'GOAT':      { name: 'Goat' },
    'POPCAT':    { name: 'Popcat' },
    'BRETT':     { name: 'Brett' },
    'TURBO':     { name: 'Turbo' },
    'NOT':       { name: 'Notcoin' },
    'MEME':      { name: 'Memecoin' },
    'ORDI':      { name: 'ORDI' },
    'PANDORA':   { name: 'Pandora' },
    'BOME':      { name: 'Book of Meme' },
    'MYRO':      { name: 'Myro' },
    'APE':       { name: 'ApeCoin' },
    'GMT':       { name: 'STEPN' },
    'BANANA':    { name: 'Banana Gun' },
    'HMSTR':     { name: 'Hamster Kombat' },
    'CATI':      { name: 'Catizen' },
    'MEW':       { name: 'cat in a dogs world' },
    'GRASS':     { name: 'Grass' },
    'PENGU':     { name: 'Pudgy Penguins' },
    'SPX':       { name: 'SPX6900' },
    'ANIME':     { name: 'Anime' },
    'VINE':      { name: 'Vine' },
    'JELLY':     { name: 'Jelly' },
    'TST':       { name: 'The Standard Token' },
    'BABY':      { name: 'Baby Doge' },
    'HYPER':     { name: 'Hyper' },
    'PUMP':      { name: 'Pump' },
    'FOGO':      { name: 'Fogo' },
    'YZY':       { name: 'Yeezy' },
    'WLFI':      { name: 'World Liberty Financial' },
    'DOOD':      { name: 'Doodles' },
    /* ── 1000x aliases (k-prefix = 1000 units) ──────────────────────── */
    'kPEPE':     { name: '1000PEPE' },
    'kSHIB':     { name: '1000SHIB' },
    'kBONK':     { name: '1000BONK' },
    'kFLOKI':    { name: '1000FLOKI' },
    'kDOGS':     { name: '1000DOGS' },
    'kNEIRO':    { name: '1000NEIRO' },
    'kLUNC':     { name: '1000LUNC' },
    /* ── Misc / smaller alts ─────────────────────────────────────────── */
    'TRB':       { name: 'Tellor' },
    'FTT':       { name: 'FTX Token' },
    'HPOS':      { name: 'Harry Potter Obama Sonic 10 Inu' },
    'RLB':       { name: 'Rollbit Coin' },
    'UNIBOT':    { name: 'Unibot' },
    'OX':        { name: 'Open Exchange Token' },
    'FRIEND':    { name: 'friend.tech' },
    'SHIA':      { name: 'Shia' },
    'CYBER':     { name: 'CyberConnect' },
    'NFTI':      { name: 'NFT Index' },
    'USTC':      { name: 'TerraClassicUSD' },
    'PEOPLE':    { name: 'ConstitutionDAO' },
    'JTO':       { name: 'Jito' },
    'ACE':       { name: 'Fusionist' },
    'MAV':       { name: 'Maverick Protocol' },
    'NEIROETH':  { name: 'NEIRO on ETH' },
    'HMSTR':     { name: 'Hamster Kombat' },
    'ME':        { name: 'Magic Eden' },
    'WCT':       { name: 'WalletConnect' },
    'MORPHO':    { name: 'Morpho' },
    'LIT':       { name: 'Litentry' },
    'ASTER':     { name: 'Aster' },
    'STBL':      { name: 'Stable' },
    'STABLE':    { name: 'Stable' },
    '2Z':        { name: '2Z' },
    'MET':       { name: 'Metaverse' },
    'CC':        { name: 'CC' },
    'SKR':       { name: 'Skr' },
    'PROVE':     { name: 'Proven' },
    'XPL':       { name: 'XPL' },
    'AVNT':      { name: 'Avantis' },
    'LINEA':     { name: 'Linea' },
    /* ── Commodities (HL xyz perps) ──────────────────────────────────── */
    'GAS':       { name: 'Natural Gas',          hlCoin: 'GAS'        },  // regular HL perp
    'NATGAS':    { name: 'Natural Gas (xyz)',     hlCoin: 'xyz:NATGAS' },  // xyz perp
    'PAXG':      { name: 'PAX Gold',             hlCoin: 'PAXG'       },
    'XAU':       { name: 'Gold (PAXG)',          hlCoin: 'PAXG'       }, // alias → PAXG perp
    'GOLD':      { name: 'Gold (xyz perp)',       hlCoin: 'xyz:GOLD'   }, // xyz perp
    'WTI':       { name: 'WTI Crude Oil (xyz)',  hlCoin: 'xyz:CL'     }, // HL xyz perp — API ticker is CL
    'WTIOIL':    { name: 'WTI Crude Oil (xyz)',  hlCoin: 'xyz:CL'     }, // alias (UI name on HL)
    'CL':        { name: 'WTI Crude Oil (xyz)',  hlCoin: 'xyz:CL'     }, // alias (API name)
    'CRUDE':     { name: 'WTI Crude Oil alias',  hlCoin: 'xyz:CL'     },
    'OIL':       { name: 'WTI Crude Oil alias',  hlCoin: 'xyz:CL'     },
    'BRENT':     { name: 'Brent Crude (xyz)',     hlCoin: 'xyz:BRENTOIL' }, // xyz perp
    'BRENTOIL':  { name: 'Brent Crude (xyz)',     hlCoin: 'xyz:BRENTOIL' }, // alias (UI name on HL)
    'SILVER':    { name: 'Silver (xyz perp)',     hlCoin: 'xyz:SILVER' }, // xyz perp
    'COPPER':    { name: 'Copper (xyz perp)',     hlCoin: 'xyz:COPPER' },
    'PLATINUM':  { name: 'Platinum (xyz perp)',   hlCoin: 'xyz:PLATINUM' },
    /* ── Forex (HL xyz perps) ────────────────────────────────────────── */
    'EUR':       { name: 'Euro (xyz perp)',       hlCoin: 'xyz:EUR'    },
    'JPY':       { name: 'Japanese Yen (xyz)',    hlCoin: 'xyz:JPY'    },
    /* ── Indices (HL xyz perps) ──────────────────────────────────────── */
    'SP500':     { name: 'S&P 500 (xyz perp)',    hlCoin: 'xyz:SP500'  },
    'XYZ100':    { name: 'XYZ100 Index (xyz)',    hlCoin: 'xyz:XYZ100' },
    /* ── Equity tokens (HL spot) ─────────────────────────────────────── */
    'SPY':       { name: 'S&P 500 token',    hlCoin: '@420' },
    'QQQ':       { name: 'Nasdaq token',     hlCoin: '@426' },
    'AAPL':      { name: 'Apple token',      hlCoin: '@413' },
    'TSLA':      { name: 'Tesla token',      hlCoin: '@407' },
    'META':      { name: 'Meta token',       hlCoin: '@422' },
    'MSFT':      { name: 'Microsoft token',  hlCoin: '@429' },
    'AMZN':      { name: 'Amazon token',     hlCoin: '@421' },
    'GOOGL':     { name: 'Google token',     hlCoin: '@412' },
    'NVDA':      { name: 'Nvidia token',     hlCoin: '@408' },
    'MSTR':      { name: 'MicroStrategy token', hlCoin: '@417' },
    'ORCL':      { name: 'Oracle token',     hlCoin: '@430' },
    'AVGO':      { name: 'Broadcom token',   hlCoin: '@431' },
    'MU':        { name: 'Micron token',     hlCoin: '@435' },
    'HOOD':      { name: 'Robinhood token',  hlCoin: '@415' },
    'CRCL':      { name: 'Circle token',     hlCoin: '@409' },
    'SPACEX':    { name: 'SpaceX token',     hlCoin: '@416' },
    'OPENAI':    { name: 'OpenAI token',     hlCoin: '@418' },
    /* ── HL spot commodity tokens ────────────────────────────────────── */
    'GLD':       { name: 'Gold token',   hlCoin: '@432' },
    'SLV':       { name: 'Silver token', hlCoin: '@411' },
    'XAG':       { name: 'Silver token', hlCoin: '@411' },  // spot token alias
  };

  /* Maps dashboard asset names to the actual HL coin ticker for order placement */
  function _hlCoin(asset) {
    var info = HL_ASSETS[String(asset).toUpperCase()];
    return (info && info.hlCoin) ? info.hlCoin : String(asset).toUpperCase();
  }

  /* ── State ───────────────────────────────────────────────────────────────── */
  var _cfg = {
    wallet:    '',
    testnet:   true,
    connected: false,
    equity:    null,
    available: null,
    unrealised: null
  };

  function _loadCfg() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (saved.wallet)            _cfg.wallet  = saved.wallet;
      if (saved.testnet !== undefined) _cfg.testnet = saved.testnet;
    } catch (e) {}
  }

  function _saveCfg() {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      wallet:  _cfg.wallet,
      testnet: _cfg.testnet
    }));
  }

  /* ── Backend API calls ───────────────────────────────────────────────────── */
  async function _post(path, body) {
    var res = await fetch(BACKEND + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      var txt = await res.text();
      throw new Error('HL backend ' + res.status + ': ' + txt.substring(0, 200));
    }
    return res.json();
  }

  async function _get(path) {
    var res = await fetch(BACKEND + path);
    if (!res.ok) throw new Error('HL backend ' + res.status);
    return res.json();
  }

  /* ── Render broker card ──────────────────────────────────────────────────── */
  function renderCard() {
    var card = document.getElementById('hlBrokerCard');
    if (!card) return;

    if (_cfg.connected) {
      card.innerHTML =
        '<div class="ee-broker-name" style="color:#00ff88">HYPERLIQUID ' +
          (_cfg.testnet
            ? '<span style="color:#ffaa00;font-size:8px">TESTNET</span>'
            : '<span style="color:#ff4444;font-size:8px">LIVE</span>') +
        '</div>' +
        '<div class="ee-broker-assets">Crypto perps &middot; up to 50× leverage &middot; ' +
          Object.keys(HL_ASSETS).length + ' assets</div>' +
        '<div style="font-size:8px;color:var(--dim);margin-bottom:4px">' +
          'Equity: <b style="color:var(--bright)">$' + (_cfg.equity !== null ? _cfg.equity.toFixed(2) : '—') + '</b>' +
          ' &nbsp; Available: <b style="color:var(--bright)">$' + (_cfg.available !== null ? _cfg.available.toFixed(2) : '—') + '</b>' +
          ' &nbsp; Unrealised: <b style="color:' + ((_cfg.unrealised || 0) >= 0 ? '#00ff88' : '#ff4444') + '">' +
            ((_cfg.unrealised !== null ? (_cfg.unrealised >= 0 ? '+' : '') + _cfg.unrealised.toFixed(2) : '—')) + '</b>' +
        '</div>' +
        '<div style="font-size:7px;color:var(--dim);margin-bottom:4px;word-break:break-all">' +
          _cfg.wallet.substring(0, 12) + '…' + _cfg.wallet.slice(-6) +
        '</div>' +
        '<button onclick="HLBroker.disconnect()" ' +
          'style="font-size:8px;width:100%;padding:3px 0;border:1px solid #ff4444;' +
          'background:transparent;color:#ff4444;cursor:pointer;font-family:inherit;border-radius:2px">' +
          'Disconnect' +
        '</button>';
    } else {
      card.innerHTML =
        '<div class="ee-broker-name">Hyperliquid</div>' +
        '<div class="ee-broker-assets">Crypto perps &middot; Up to 50× leverage</div>' +
        '<div style="margin-bottom:4px">' +
          '<input id="hlWallet" type="text" placeholder="Wallet address (0x…)" value="' + (_cfg.wallet || '') + '" ' +
            'style="width:100%;box-sizing:border-box;font-size:8px;padding:2px 4px;' +
            'background:var(--bg);border:1px solid var(--border);color:var(--bright);' +
            'font-family:inherit;border-radius:2px;margin-bottom:2px">' +
          '<input id="hlPrivKey" type="password" placeholder="Private key (stays local — never sent)" ' +
            'style="width:100%;box-sizing:border-box;font-size:8px;padding:2px 4px;' +
            'background:var(--bg);border:1px solid var(--border);color:var(--bright);' +
            'font-family:inherit;border-radius:2px;margin-bottom:2px">' +
          '<label style="font-size:7px;color:var(--dim);cursor:pointer">' +
            '<input id="hlTestnet" type="checkbox" ' + (_cfg.testnet ? 'checked' : '') + ' ' +
              'style="margin-right:3px"> Testnet mode' +
          '</label>' +
        '</div>' +
        '<button onclick="HLBroker._connectFromUI()" ' +
          'style="font-size:8px;width:100%;padding:3px 0;border:1px solid var(--accent);' +
          'background:transparent;color:var(--accent);cursor:pointer;font-family:inherit;border-radius:2px">' +
          (_cfg.wallet ? 'Reconnect' : 'Connect') +
        '</button>' +
        '<div style="font-size:7px;color:#888;margin-top:3px">' +
          'Key is sent only to localhost backend — never to any external server.' +
        '</div>' +
        '<div id="hlStatus" style="font-size:7px;color:var(--dim);margin-top:2px;min-height:10px"></div>';
    }
  }

  /* ── Fill poll — polls /api/hl/positions until the trade appears ─────────── */
  function _pollFill(coin, side, onFill, onFail) {
    var POLL_MS    = 3000;
    var TIMEOUT_MS = 45000;   // extended from 30s — HL position confirmation can lag under load
    var started    = Date.now();

    function _check() {
      if (Date.now() - started >= TIMEOUT_MS) {
        /* Position confirmation timed out. The order MAY have gone through on HL
           but the backend hasn't confirmed it yet. T1-A reconciliation will detect
           any untracked HL positions on the next cycle and flag them for review. */
        console.warn('[HLBroker] _pollFill timeout after ' + (TIMEOUT_MS / 1000) + 's for ' +
          coin + ' ' + side + ' — calling onFail. T1-A reconciliation will catch any dangling position.');
        onFail('timeout');
        return;
      }
      _get('/api/hl/positions')
        .then(function (data) {
          if (!data.ok) { setTimeout(_check, POLL_MS); return; }
          var pos = (data.positions || []).find(function (p) { return p.coin === coin; });
          if (pos) {
            onFill(pos.entryPx, pos);
          } else {
            setTimeout(_check, POLL_MS);
          }
        })
        .catch(function () { setTimeout(_check, POLL_MS); });
    }
    setTimeout(_check, POLL_MS);
  }

  /* ── Public API ──────────────────────────────────────────────────────────── */
  var HLBroker = {
    name:    'HL',
    version: 1,

    // isConnected: only return true if connected AND has confirmed positive balance.
    // A $0 testnet wallet (or unconfirmed equity) falls through to Alpaca.
    isConnected: function () {
      if (!_cfg.connected) return false;
      // Require confirmed positive equity before routing live orders here.
      // null = not yet fetched; 0 = unfunded. Both fall through to Alpaca.
      if (!_cfg.equity || _cfg.equity <= 0) return false;
      return true;
    },
    isTestnet:   function () { return _cfg.testnet; },

    covers: function (asset) {
      return Object.prototype.hasOwnProperty.call(HL_ASSETS, String(asset).toUpperCase());
    },

    assetInfo: function (asset) {
      return HL_ASSETS[String(asset).toUpperCase()] || null;
    },

    assets: function () { return Object.keys(HL_ASSETS); },

    connect: async function (wallet, privateKey, testnet) {
      _cfg.wallet  = wallet;
      _cfg.testnet = testnet !== false;
      try {
        var result = await _post('/api/hl/connect', {
          wallet: wallet, privateKey: privateKey, testnet: _cfg.testnet
        });
        if (result.ok) {
          _cfg.connected  = true;
          _cfg.equity     = result.equity;
          _cfg.available  = result.available;
          _cfg.unrealised = result.unrealised;
          _saveCfg();
          renderCard();
        }
        return result;
      } catch (e) {
        _cfg.connected = false;
        return { ok: false, error: e.message };
      }
    },

    _connectFromUI: async function () {
      var walletEl  = document.getElementById('hlWallet');
      var keyEl     = document.getElementById('hlPrivKey');
      var testnetEl = document.getElementById('hlTestnet');
      var statusEl  = document.getElementById('hlStatus');
      if (!walletEl || !keyEl) return;
      if (statusEl) { statusEl.textContent = 'Connecting…'; statusEl.style.color = 'var(--dim)'; }
      var result = await HLBroker.connect(
        walletEl.value.trim(),
        keyEl.value.trim(),
        testnetEl ? testnetEl.checked : true
      );
      if (!result.ok && statusEl) {
        statusEl.style.color = '#ff4444';
        statusEl.textContent = result.error || 'Connection failed';
      }
    },

    disconnect: async function () {
      try { await _post('/api/hl/disconnect', {}); } catch (e) {}
      _cfg.connected = false;
      _saveCfg();
      renderCard();
    },

    renderCard: renderCard,

    getAccount: async function () {
      var data = await _get('/api/hl/account');
      if (data.ok) {
        _cfg.equity     = data.equity;
        _cfg.available  = data.available;
        _cfg.unrealised = data.unrealised;
      }
      return data;
    },

    getPrice: async function (symbol) {
      /* Use HL feed if available, otherwise skip (EE uses its own prices) */
      try {
        if (window.HLFeed && HLFeed.getPrice) return HLFeed.getPrice(symbol);
      } catch (e) {}
      return null;
    },

    /* Place a market order.
       side: 'buy' | 'sell'
       qty: ignored — we use opts.notional (size in USD)
       opts.leverage: leverage multiplier (default 1) */
    placeOrder: async function (symbol, qty, side, opts) {
      var sizeUsd  = (opts && opts.notional) ? parseFloat(opts.notional) : 0;
      var leverage = (opts && opts.leverage) ? parseInt(opts.leverage) : 1;
      if (sizeUsd <= 0) return { ok: false, error: 'notional required' };
      return _post('/api/hl/order', {
        coin:     _hlCoin(symbol),
        side:     side,
        sizeUsd:  sizeUsd,
        leverage: leverage
      });
    },

    /* Place order with fill confirmation.
       onFill(fillPrice, position) — called when position appears on HL
       onFail(reason)              — called on timeout              */
    placeOrderWithConfirmation: async function (symbol, qty, side, opts, onFill, onFail) {
      var result = await HLBroker.placeOrder(symbol, qty, side, opts);
      if (!result || !result.ok) {
        if (onFail) onFail(result ? result.error : 'order failed');
        return result;
      }
      /* HL market orders fill nearly instantly — confirm via positions poll */
      if (result.fillPrice && result.fillPrice > 0) {
        /* SDK returned fill data directly */
        if (onFill) onFill(result.fillPrice, result);
      } else {
        _pollFill(_hlCoin(symbol), side, onFill, onFail);
      }
      return result;
    },

    closePosition: async function (symbol) {
      return _post('/api/hl/close', { coin: _hlCoin(symbol) });
    },

    /* Place a server-side trigger order (SL or TP) on HL.
       type: 'stop' for stop-loss, 'tp' for take-profit.
       side: 'buy' (to close a short) or 'sell' (to close a long).
       size: position size in asset units.
       triggerPx: price at which the order triggers as a market order. */
    placeTriggerOrder: async function (symbol, side, size, triggerPx, type) {
      return _post('/api/hl/trigger', {
        coin:      _hlCoin(symbol),
        side:      side,
        size:      size,
        triggerPx: triggerPx,
        type:      type || 'stop'
      });
    },

    /* Cancel all trigger orders for a symbol. */
    cancelTriggerOrders: async function (symbol) {
      return _post('/api/hl/cancel-triggers', { coin: _hlCoin(symbol) });
    },

    getPositions: async function () {
      return _get('/api/hl/positions');
    },

    /* Refresh account info and update card */
    refreshAccount: async function () {
      if (!_cfg.connected) return;
      var data = await HLBroker.getAccount().catch(function () { return null; });
      if (data && data.ok) renderCard();
    },

    /* Standard status() interface expected by the EE and dashboard */
    status: function () {
      return {
        lastPoll:    _cfg.connected ? Date.now() : 0,
        connected:   _cfg.connected,
        testnet:     _cfg.testnet,
        equity:      _cfg.equity,
        available:   _cfg.available,
        unrealised:  _cfg.unrealised,
        addressHint: _cfg.wallet ? _cfg.wallet.substring(0, 10) + '…' : '',
        assetCount:  Object.keys(HL_ASSETS).length,
        note: _cfg.connected
          ? (_cfg.testnet ? 'Testnet' : 'Live') + ' · equity $' +
            (_cfg.equity !== null ? _cfg.equity.toFixed(0) : '—') + ' · ' +
            Object.keys(HL_ASSETS).length + ' assets'
          : 'Not connected'
      };
    },
    signals: function () { return []; }  /* execution-only */
  };

  _loadCfg();
  window.HLBroker = HLBroker;

  /* Auto-check connection status on startup (no private key needed — backend holds it) */
  setTimeout(function () {
    _get('/api/hl/status')
      .then(function (data) {
        if (data.connected) {
          _cfg.connected  = true;
          _cfg.wallet     = data.address || _cfg.wallet;
          _cfg.testnet    = data.testnet;
          _cfg.equity     = data.equity   || null;
          _cfg.available  = data.available || null;
          _cfg.unrealised = data.unrealised || null;
          _saveCfg();
          renderCard();
          console.log('[HLBroker] Auto-connected —', _cfg.testnet ? 'testnet' : 'mainnet');
        }
      })
      .catch(function () {}); /* backend not running yet — ignore */
  }, 3500);

  /* Refresh account every 30s when connected */
  setInterval(function () {
    if (_cfg.connected) HLBroker.refreshAccount();
  }, 30000);

  /* Render card once DOM is ready */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderCard);
  } else {
    setTimeout(renderCard, 0);
  }

})();
