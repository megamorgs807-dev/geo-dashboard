"""
Hyperliquid Broker — order placement + account management.

Uses the official hyperliquid-python-sdk for signing/order placement.
Workaround: pre-filters spot_meta to avoid SDK crash on testnet (token index
out of range bug in hyperliquid-python-sdk v0.22.0).
Read operations (account state, prices) use direct HTTP to avoid the same crash.
"""
import json
import os
import requests
from typing import Optional

try:
    import eth_account
    from hyperliquid.exchange import Exchange
    from hyperliquid.utils import constants
    _SDK = True
except ImportError:
    _SDK = False
    print('[HLBroker] hyperliquid-python-sdk not installed — HL trading disabled')

_CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'hl_config.json')

_cfg: dict = {
    'wallet':      '',
    'private_key': '',
    'testnet':     True,
    'connected':   False,
}

_exchange: Optional[object] = None


def _url() -> str:
    return constants.TESTNET_API_URL if _cfg['testnet'] else constants.MAINNET_API_URL


def _info_post(payload: dict) -> dict:
    """Direct HTTP POST to /info — avoids the SDK Info class which crashes on testnet."""
    r = requests.post(_url() + '/info', json=payload, timeout=10)
    r.raise_for_status()
    return r.json()


def _safe_spot_meta(raw_spot_meta: dict) -> dict:
    """
    Filter spot universe to only pairs where both token indices exist in tokens[].
    Fixes IndexError: list index out of range in hyperliquid-python-sdk v0.22.0 on testnet.
    """
    tokens = raw_spot_meta.get('tokens', [])
    n = len(tokens)
    safe_universe = [
        u for u in raw_spot_meta.get('universe', [])
        if len(u.get('tokens', [])) >= 2
        and u['tokens'][0] < n
        and u['tokens'][1] < n
    ]
    return {'tokens': tokens, 'universe': safe_universe}


def _build_exchange(private_key: str, wallet: str) -> object:
    """Build Exchange object using pre-filtered spot_meta to avoid SDK crash."""
    acct      = eth_account.Account.from_key(private_key)
    raw_spot  = requests.post(_url() + '/info', json={'type': 'spotMeta'}, timeout=10).json()
    safe_spot = _safe_spot_meta(raw_spot)
    return Exchange(acct, _url(), account_address=wallet, spot_meta=safe_spot)


def load_config():
    global _cfg
    try:
        with open(_CONFIG_FILE) as f:
            saved = json.load(f)
            for k in ('wallet', 'private_key', 'testnet'):
                if k in saved:
                    _cfg[k] = saved[k]
    except Exception:
        pass


def save_config():
    try:
        with open(_CONFIG_FILE, 'w') as f:
            json.dump({k: _cfg[k] for k in ('wallet', 'private_key', 'testnet')}, f)
    except Exception as e:
        print(f'[HLBroker] Could not save config: {e}')


def connect(wallet: str, private_key: str, testnet: bool = True) -> dict:
    global _exchange, _cfg

    if not _SDK:
        return {'ok': False, 'error': 'hyperliquid-python-sdk not installed'}

    try:
        acct = eth_account.Account.from_key(private_key)
        if acct.address.lower() != wallet.lower():
            return {'ok': False, 'error': 'Private key does not match wallet address'}

        _cfg.update({'wallet': wallet, 'private_key': private_key, 'testnet': testnet})

        # Verify connection with a direct account state fetch
        state      = _info_post({'type': 'clearinghouseState', 'user': wallet})
        ms         = state.get('marginSummary', {})
        equity     = float(ms.get('accountValue', 0))
        available  = float(state.get('withdrawable', 0))
        unrealised = float(ms.get('totalUnrealizedPnl', 0))

        # Build Exchange with patched spot_meta
        _exchange = _build_exchange(private_key, wallet)

        _cfg['connected'] = True
        save_config()

        return {
            'ok':        True,
            'equity':    equity,
            'available': available,
            'unrealised': unrealised,
            'testnet':   testnet,
            'address':   wallet,
        }

    except Exception as e:
        _cfg['connected'] = False
        return {'ok': False, 'error': str(e)}


def disconnect():
    global _exchange
    _exchange = None
    _cfg['connected'] = False


def get_account() -> dict:
    if not _cfg.get('wallet'):
        return {'ok': False, 'error': 'Not connected'}
    try:
        state      = _info_post({'type': 'clearinghouseState', 'user': _cfg['wallet']})
        ms         = state.get('marginSummary', {})
        return {
            'ok':        True,
            'equity':    float(ms.get('accountValue', 0)),
            'available': float(state.get('withdrawable', 0)),
            'unrealised': float(ms.get('totalUnrealizedPnl', 0)),
        }
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def place_order(coin: str, is_buy: bool, size_usd: float, leverage: int = 1) -> dict:
    if not _exchange:
        return {'ok': False, 'error': 'Not connected'}

    try:
        # Get current mid price
        mids  = _info_post({'type': 'allMids'})
        price = float(mids.get(coin, 0))
        if not price:
            return {'ok': False, 'error': f'No mid price for {coin}'}

        # Set leverage (cross-margin) before placing order
        lev = min(max(int(leverage), 1), 50)
        if lev > 1:
            try:
                _exchange.update_leverage(lev, coin, is_cross=True)
            except Exception:
                pass  # non-fatal

        # Coin quantity = full notional ÷ price (HL uses leverage for margin calc)
        sz = round(size_usd / price, 5)
        if sz <= 0:
            return {'ok': False, 'error': f'Calculated size {sz} too small'}

        result = _exchange.market_open(coin, is_buy, sz)

        if result and result.get('status') == 'ok':
            statuses = (result.get('response', {}).get('data', {}) or {}).get('statuses', [])
            filled   = (statuses[0] if statuses else {}).get('filled', {})
            fill_px  = float(filled.get('avgPx', price))
            fill_sz  = float(filled.get('totalSz', sz))
            return {
                'ok':        True,
                'fillPrice': fill_px,
                'fillSize':  fill_sz,
                'notional':  fill_px * fill_sz,
                'side':      'buy' if is_buy else 'sell',
                'coin':      coin,
                'leverage':  lev,
            }

        return {'ok': False, 'error': str(result)}

    except Exception as e:
        return {'ok': False, 'error': str(e)}


def close_position(coin: str) -> dict:
    if not _exchange:
        return {'ok': False, 'error': 'Not connected'}
    try:
        result = _exchange.market_close(coin)
        if result and result.get('status') == 'ok':
            return {'ok': True, 'coin': coin}
        return {'ok': False, 'error': str(result)}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def get_positions() -> dict:
    if not _cfg.get('wallet'):
        return {'ok': False, 'error': 'Not connected'}
    try:
        state     = _info_post({'type': 'clearinghouseState', 'user': _cfg['wallet']})
        positions = []
        for p in state.get('assetPositions', []):
            pos = p.get('position', {})
            szi = float(pos.get('szi', 0))
            if szi:
                positions.append({
                    'coin':          pos.get('coin'),
                    'size':          szi,
                    'side':          'long' if szi > 0 else 'short',
                    'entryPx':       float(pos.get('entryPx', 0)),
                    'unrealizedPnl': float(pos.get('unrealizedPnl', 0)),
                    'leverage':      pos.get('leverage', {}),
                })
        return {'ok': True, 'positions': positions}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


# Auto-reconnect on import if config is saved
load_config()
if _SDK and _cfg.get('wallet') and _cfg.get('private_key'):
    try:
        _exchange = _build_exchange(_cfg['private_key'], _cfg['wallet'])
        _cfg['connected'] = True
        print(f"[HLBroker] Auto-connected {'testnet' if _cfg['testnet'] else 'mainnet'} — {_cfg['wallet'][:10]}…")
    except Exception as e:
        print(f'[HLBroker] Auto-reconnect failed: {e}')
