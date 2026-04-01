"""
Hyperliquid Broker — order placement + account management.

Uses the official hyperliquid-python-sdk for signing/order placement.
Workaround: pre-filters spot_meta to avoid SDK crash on testnet (token index
out of range bug in hyperliquid-python-sdk v0.22.0).
Read operations (account state, prices) use direct HTTP to avoid the same crash.
"""
import json
import os
import threading
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

# Serialize concurrent order placements — prevents race where two signals both
# pass the margin pre-check before either has committed margin on HL.
_order_lock = threading.Lock()

# Cache of per-asset size decimals: {'BTC': 5, 'SOL': 2, 'DOGE': 0, ...}
_sz_decimals: dict = {}

# Minimum notional USD for any order (HL enforces $10; we add a buffer).
_MIN_ORDER_USD = 11.0


def _load_sz_decimals():
    """Fetch and cache HL per-asset szDecimals so order sizes are rounded correctly.
    Loads both the standard perp universe and the xyz builder-deployed DEX
    (xyz:AAPL, xyz:GOOGL etc.) which has separate szDecimals per asset.
    """
    global _sz_decimals
    try:
        meta = requests.post(_url() + '/info', json={'type': 'meta'}, timeout=10).json()
        _sz_decimals = {a['name']: int(a.get('szDecimals', 5))
                        for a in meta.get('universe', [])
                        if 'name' in a}
        # Also load xyz DEX asset decimals (xyz:AAPL=3, xyz:INTC=2, xyz:EUR=1 etc.)
        xyz_meta = requests.post(_url() + '/info', json={'type': 'meta', 'dex': 'xyz'}, timeout=10).json()
        _sz_decimals.update({a['name']: int(a.get('szDecimals', 3))
                             for a in xyz_meta.get('universe', [])
                             if 'name' in a})
        print(f'[HLBroker] Loaded szDecimals: {len(_sz_decimals)} assets '
              f'({sum(1 for k in _sz_decimals if k.startswith("xyz:"))} xyz: perps)')
    except Exception as e:
        print(f'[HLBroker] Could not load szDecimals: {e}')


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
    """Build Exchange object using pre-filtered spot_meta to avoid SDK crash.
    perp_dexs=['', 'xyz'] tells the SDK to also load the xyz builder-deployed
    perp DEX (xyz:AAPL, xyz:GOOGL, xyz:CL etc.) at asset-index offset 110000.
    Without this the SDK has no entry in coin_to_asset for xyz: coins and
    raises KeyError when market_open() is called for them.
    """
    acct      = eth_account.Account.from_key(private_key)
    raw_spot  = requests.post(_url() + '/info', json={'type': 'spotMeta'}, timeout=10).json()
    safe_spot = _safe_spot_meta(raw_spot)
    return Exchange(acct, _url(), account_address=wallet,
                    spot_meta=safe_spot, perp_dexs=['', 'xyz'])


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
        # Agent/API wallets legitimately have a different address from the main account.
        # The SDK signs orders with `acct` (API wallet) but queries/attributes them to
        # `wallet` (main account) via account_address=wallet. No address match required.

        _cfg.update({'wallet': wallet, 'private_key': private_key, 'testnet': testnet})

        # Verify connection with a direct account state fetch
        state      = _info_post({'type': 'clearinghouseState', 'user': wallet})
        ms         = state.get('marginSummary', {})
        perp_eq    = float(ms.get('accountValue', 0))
        spot_usdc  = _spot_usdc(wallet)          # free (unheld) spot only
        equity     = perp_eq + spot_usdc
        # available = free margin for new positions = equity minus margin already in use
        margin_used = float(ms.get('totalMarginUsed', 0))
        available   = max(0.0, equity - margin_used)
        unrealised = float(ms.get('totalUnrealizedPnl', 0))

        # Build Exchange with patched spot_meta
        _exchange = _build_exchange(private_key, wallet)

        _cfg['connected'] = True
        save_config()
        _load_sz_decimals()  # cache per-asset size precision

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


def _portfolio_total(wallet: str = '') -> float:
    """Return current total portfolio value (perp + spot tokens + USDC) via
    the HL portfolio endpoint, which prices all holdings at current market rates.
    Falls back to 0.0 on error.
    """
    try:
        addr = wallet or _cfg.get('wallet', '')
        port = _info_post({'type': 'portfolio', 'user': addr})
        for section in port:
            if section[0] == 'day':
                hist = section[1].get('accountValueHistory', [])
                if hist:
                    return float(hist[-1][1])
    except Exception:
        pass
    return 0.0


# Keep old name as alias so nothing else breaks
def _spot_usdc(wallet: str = '') -> float:
    return _portfolio_total(wallet)


def get_account() -> dict:
    if not _cfg.get('wallet'):
        return {'ok': False, 'error': 'Not connected'}
    try:
        state       = _info_post({'type': 'clearinghouseState', 'user': _cfg['wallet']})
        ms          = state.get('marginSummary', {})
        margin_used = float(ms.get('totalMarginUsed', 0))
        unrealised  = float(ms.get('totalUnrealizedPnl', 0))
        # Total portfolio = perp equity + spot tokens + USDC at current market prices
        equity      = _portfolio_total()
        available   = max(0.0, equity - margin_used)
        return {
            'ok':        True,
            'equity':    equity,
            'available': available,
            'unrealised': unrealised,
        }
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def place_order(coin: str, is_buy: bool, size_usd: float, leverage: int = 1) -> dict:
    if not _exchange:
        return {'ok': False, 'error': 'Not connected'}

    with _order_lock:  # serialise — prevents concurrent orders both passing margin check
        return _place_order_locked(coin, is_buy, size_usd, leverage)


def _place_order_locked(coin: str, is_buy: bool, size_usd: float, leverage: int = 1) -> dict:
    try:
        # Get current mid price — xyz: perps are not in allMids, use l2Book instead
        if coin.startswith('xyz:'):
            book   = _info_post({'type': 'l2Book', 'coin': coin, 'nSigFigs': 5})
            levels = book.get('levels', [])
            if not levels or len(levels) < 2 or not levels[0] or not levels[1]:
                return {'ok': False, 'error': f'No l2Book price for {coin}'}
            price = (float(levels[0][0]['px']) + float(levels[1][0]['px'])) / 2
        else:
            mids  = _info_post({'type': 'allMids'})
            price = float(mids.get(coin, 0))
        if not price:
            return {'ok': False, 'error': f'No mid price for {coin}'}

        # Cap order size to free margin (equity minus margin already in use).
        # Re-fetched inside the lock so concurrent orders see updated margin state.
        state       = _info_post({'type': 'clearinghouseState', 'user': _cfg['wallet']})
        ms_         = state.get('marginSummary', {})
        equity_     = float(ms_.get('accountValue', 0)) + _spot_usdc()
        margin_used_= float(ms_.get('totalMarginUsed', 0))
        available   = max(0.0, equity_ - margin_used_)
        lev       = min(max(int(leverage), 1), 50)
        max_notional = available * lev * 0.95  # 5% buffer for fees/slippage
        if max_notional <= 0:
            return {'ok': False, 'error': f'Insufficient balance: ${available:.2f} available'}
        if size_usd > max_notional:
            size_usd = round(max_notional, 2)
        # Enforce HL minimum notional ($10 + buffer)
        if size_usd < _MIN_ORDER_USD:
            return {'ok': False, 'error': f'Order too small: ${size_usd:.2f} < ${_MIN_ORDER_USD} minimum'}

        # Always set leverage before placing — resets any stale leverage on the account
        try:
            _exchange.update_leverage(lev, coin, is_cross=True)
        except Exception:
            pass  # non-fatal

        # Coin quantity = full notional ÷ price, rounded to HL's required decimal places
        decimals = _sz_decimals.get(coin, 5)
        sz = round(size_usd / price, decimals)
        if sz <= 0:
            return {'ok': False, 'error': f'Calculated size {sz} too small'}

        result = _exchange.market_open(coin, is_buy, sz)

        if result and result.get('status') == 'ok':
            statuses = (result.get('response', {}).get('data', {}) or {}).get('statuses', [])
            first    = statuses[0] if statuses else {}
            # Check for order-level error (e.g. insufficient margin, bad size)
            if 'error' in first:
                return {'ok': False, 'error': first['error']}
            filled  = first.get('filled', {})
            fill_px = float(filled.get('avgPx') or 0)
            fill_sz = float(filled.get('totalSz') or 0)
            if fill_px <= 0 or fill_sz <= 0:
                return {'ok': False, 'error': f'Order not filled — HL response: {first}'}
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


def place_trigger_order(coin: str, is_buy: bool, sz: float, trigger_px: float,
                        order_type: str = 'stop') -> dict:
    """Place a server-side trigger (stop-loss or take-profit) order on HL.

    order_type: 'stop' for stop-loss, 'tp' for take-profit.
    is_buy: True to buy (closing a short), False to sell (closing a long).
    sz: position size in asset units (must match open position size).
    trigger_px: price at which the order triggers.
    """
    if not _exchange:
        return {'ok': False, 'error': 'Not connected'}
    try:
        # HL trigger orders use the order API with trigger-specific parameters.
        # We use the exchange's raw order endpoint for trigger orders.
        decimals = _sz_decimals.get(coin, 5)
        sz_rounded = round(abs(sz), decimals)
        if sz_rounded <= 0:
            return {'ok': False, 'error': f'Size too small after rounding: {sz}'}

        # Build the trigger order via the SDK
        # HL API: order type for triggers is {trigger: {triggerPx, isMarket, tpsl}}
        # tpsl: 'sl' for stop-loss, 'tp' for take-profit
        tpsl = 'sl' if order_type == 'stop' else 'tp'
        order_result = _exchange.order(
            coin,
            is_buy,
            sz_rounded,
            trigger_px,  # limit price (ignored for market trigger)
            {'trigger': {'triggerPx': trigger_px, 'isMarket': True, 'tpsl': tpsl}},
            reduce_only=True
        )

        if order_result and order_result.get('status') == 'ok':
            statuses = (order_result.get('response', {}).get('data', {}) or {}).get('statuses', [])
            first = statuses[0] if statuses else {}
            if 'error' in first:
                return {'ok': False, 'error': first['error']}
            resting = first.get('resting', {})
            oid = resting.get('oid', None)
            return {'ok': True, 'coin': coin, 'type': tpsl, 'triggerPx': trigger_px, 'oid': oid}

        return {'ok': False, 'error': str(order_result)}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def cancel_trigger_orders(coin: str) -> dict:
    """Cancel all open trigger orders for a coin."""
    if not _exchange:
        return {'ok': False, 'error': 'Not connected'}
    try:
        # Use frontendOpenOrders which includes isTrigger and orderType fields
        open_orders = _info_post({
            'type': 'frontendOpenOrders',
            'user': _cfg['wallet']
        })
        cancelled = 0
        for order in open_orders:
            if order.get('coin') == coin and order.get('isTrigger', False):
                try:
                    _exchange.cancel(coin, order['oid'])
                    cancelled += 1
                except Exception:
                    pass
        return {'ok': True, 'cancelled': cancelled}
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
        _load_sz_decimals()
        print(f"[HLBroker] Auto-connected {'testnet' if _cfg['testnet'] else 'mainnet'} — {_cfg['wallet'][:10]}…")
    except Exception as e:
        print(f'[HLBroker] Auto-reconnect failed: {e}')
