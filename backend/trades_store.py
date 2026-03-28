"""
Trades Store — SQLite persistence for EE paper and live trades.
Separate from events.db so the two databases don't interfere.
"""
import json
import os
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

_DB_PATH    = os.path.join(os.path.dirname(__file__), 'trades.db')
_BACKUP_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'backups')
_lock       = threading.Lock()

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS trades (
    trade_id        TEXT PRIMARY KEY,
    signal_id       TEXT,
    timestamp_open  TEXT NOT NULL,
    timestamp_close TEXT,
    asset           TEXT NOT NULL,
    direction       TEXT NOT NULL,
    confidence      REAL,
    entry_price     REAL,
    stop_loss       REAL,
    take_profit     REAL,
    close_price     REAL,
    units           REAL,
    size_usd        REAL,
    mode            TEXT DEFAULT 'SIMULATION',
    status          TEXT DEFAULT 'OPEN',
    pnl_pct         REAL,
    pnl_usd         REAL,
    close_reason    TEXT,
    region          TEXT,
    reason          TEXT,
    broker          TEXT DEFAULT 'SIMULATION',
    broker_order_id   TEXT,
    broker_status     TEXT,
    broker_fill_price REAL,
    broker_error      TEXT,
    extra             TEXT
)
"""


def _get_conn() -> sqlite3.Connection:
    return sqlite3.connect(_DB_PATH, check_same_thread=False)


def init_db():
    """Create trades table if it doesn't exist, and migrate any missing columns."""
    with _lock:
        with _get_conn() as conn:
            conn.execute(_CREATE_TABLE)
            # Migrate: add columns that didn't exist in older DB files
            existing = {row[1] for row in conn.execute("PRAGMA table_info(trades)")}
            migrations = [
                ("broker_fill_price", "REAL"),
                ("broker_error",      "TEXT"),
            ]
            for col, col_type in migrations:
                if col not in existing:
                    conn.execute(f"ALTER TABLE trades ADD COLUMN {col} {col_type}")
            conn.commit()


# ── Known columns (matches CREATE TABLE above, minus 'extra') ────────────────
_COLS = [
    'trade_id', 'signal_id', 'timestamp_open', 'timestamp_close',
    'asset', 'direction', 'confidence', 'entry_price', 'stop_loss',
    'take_profit', 'close_price', 'units', 'size_usd', 'mode',
    'status', 'pnl_pct', 'pnl_usd', 'close_reason', 'region',
    'reason', 'broker', 'broker_order_id', 'broker_status', 'broker_fill_price', 'broker_error',
]

_PATCH_ALLOWED = {
    'status', 'close_price', 'timestamp_close', 'pnl_pct', 'pnl_usd',
    'close_reason', 'broker_order_id', 'broker_status', 'broker_fill_price',
    'confidence', 'stop_loss', 'take_profit', 'entry_price', 'broker_error',
}


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    extra_raw = d.pop('extra', None)
    if extra_raw:
        try:
            d.update(json.loads(extra_raw))
        except Exception:
            pass
    return d


def get_all() -> list:
    with _lock:
        with _get_conn() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT * FROM trades ORDER BY timestamp_open DESC"
            ).fetchall()
            return [_row_to_dict(r) for r in rows]


def upsert(trade: dict) -> None:
    """Insert or replace a full trade record.

    Safety guard: if the trade already exists as CLOSED in the DB and the incoming
    record has status=OPEN, the write is silently ignored.  This prevents a stale
    open-POST (fired on trade creation) from arriving after the close-PATCH and
    rolling the trade back to OPEN in the database.
    """
    trade_id = trade.get('trade_id')
    if trade_id and trade.get('status') == 'OPEN':
        with _lock:
            with _get_conn() as conn:
                row = conn.execute(
                    "SELECT status FROM trades WHERE trade_id = ?", [trade_id]
                ).fetchone()
                if row and row[0] == 'CLOSED':
                    return   # Never downgrade CLOSED → OPEN

    known_set = set(_COLS)
    extra     = {k: v for k, v in trade.items() if k not in known_set}
    values    = {c: trade.get(c) for c in _COLS}
    values['extra'] = json.dumps(extra) if extra else None

    all_cols  = _COLS + ['extra']
    col_names = ', '.join(all_cols)
    placeholders = ', '.join(['?' for _ in all_cols])

    with _lock:
        with _get_conn() as conn:
            conn.execute(
                f"INSERT OR REPLACE INTO trades ({col_names}) VALUES ({placeholders})",
                [values[c] for c in all_cols]
            )
            conn.commit()


def patch(trade_id: str, updates: dict) -> bool:
    """Update specific fields on an existing trade."""
    safe = {k: v for k, v in updates.items() if k in _PATCH_ALLOWED}
    if not safe:
        return False
    set_clause = ', '.join(f"{k} = ?" for k in safe)
    with _lock:
        with _get_conn() as conn:
            cur = conn.execute(
                f"UPDATE trades SET {set_clause} WHERE trade_id = ?",
                list(safe.values()) + [trade_id]
            )
            conn.commit()
            return cur.rowcount > 0


def delete(trade_id: str) -> bool:
    with _lock:
        with _get_conn() as conn:
            cur = conn.execute("DELETE FROM trades WHERE trade_id = ?", [trade_id])
            conn.commit()
            return cur.rowcount > 0


def delete_all() -> int:
    """Delete every trade record. Returns number of rows deleted."""
    with _lock:
        with _get_conn() as conn:
            cur = conn.execute("DELETE FROM trades")
            conn.commit()
            return cur.rowcount


def delete_closed() -> int:
    """Delete only CLOSED trades. OPEN trades are preserved."""
    with _lock:
        with _get_conn() as conn:
            cur = conn.execute("DELETE FROM trades WHERE status != 'OPEN'")
            conn.commit()
            return cur.rowcount


def count() -> int:
    with _lock:
        with _get_conn() as conn:
            return conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0]


def export_json() -> list:
    """Return all trades as a list of dicts, suitable for JSON serialisation."""
    return get_all()


def do_backup() -> tuple:
    """Write a timestamped JSON backup. Returns (path, trade_count)."""
    Path(_BACKUP_DIR).mkdir(parents=True, exist_ok=True)
    trades = export_json()
    ts     = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    path   = os.path.join(_BACKUP_DIR, f'trades_backup_{ts}.json')
    with open(path, 'w') as fh:
        json.dump({'ts': ts, 'count': len(trades), 'trades': trades}, fh, indent=2)
    return path, len(trades)


def backup_loop(interval_s: int = 21600):
    """Background thread: auto-backup every interval_s seconds (default 6 h)."""
    while True:
        time.sleep(interval_s)
        try:
            path, n = do_backup()
            print(f'[trades] Auto-backup: {n} trade(s) → {path}')
        except Exception as exc:
            print(f'[trades] Backup error: {exc}')
