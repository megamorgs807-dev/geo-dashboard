"""
GeoIntel Backend — Event Store
Thread-safe SQLite wrapper for event persistence and deduplication.

V9: Source corroboration via keyword + region matching.

Problem: srcCount was always 1 because BBC/Reuters write the same event
with completely different vocabularies. Jaccard word-similarity fails
because synonyms ("missiles" vs "attack", "US" vs "American") make
identical stories look unrelated.

Solution: Two events are treated as the "same story" if:
  1. Same region (IRAN, UKRAINE, TAIWAN, etc.) — pre-filtered in SQL
  2. Shared at least 1 high-severity keyword (SEV weight ≥ 0.70)
  3. Both appeared within a 90-minute window

When matched, the existing event's src_count is incremented, its source
list is extended, and it is re-scored with the higher src_count.
Pipeline re-broadcasts the enriched event so the dashboard updates live.
"""
import json
import sqlite3
import threading
import time
from typing import List, Dict, Optional, Union

from config import DB_PATH, MAX_EVENTS_DB
from keyword_detector import dedupe_key, score_event, SEV

# Keywords considered "high confidence" for corroboration matching
_HIGH_SEV_THRESHOLD       = 0.70
_HIGH_SEV_KEYWORDS        = frozenset(k for k, v in SEV.items() if v >= _HIGH_SEV_THRESHOLD)

# Max age of an event to be eligible for corroboration (ms)
_CORROBORATION_WINDOW_MS  = 90 * 60 * 1000   # 90 minutes


def _shared_high_keywords(kws_a: list, kws_b: list) -> set:
    """Return the set of high-severity keywords shared between two events."""
    return (set(kws_a) & set(kws_b)) & _HIGH_SEV_KEYWORDS


class EventStore:
    def __init__(self, db_path: str = DB_PATH):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self):
        with self._lock:
            self._conn.execute("""
                CREATE TABLE IF NOT EXISTS events (
                    dedup_key   TEXT PRIMARY KEY,
                    title       TEXT NOT NULL,
                    desc        TEXT,
                    source      TEXT,
                    ts          INTEGER NOT NULL,
                    time        TEXT,
                    region      TEXT,
                    keywords    TEXT,
                    assets      TEXT,
                    signal      INTEGER,
                    src_count   INTEGER DEFAULT 1,
                    social_v    REAL    DEFAULT 0.0
                )
            """)
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_ts ON events (ts DESC)"
            )
            self._conn.commit()

    def insert(self, evt: Dict) -> Union[bool, Dict]:
        """
        Insert or corroborate an event.

        Returns:
          True   → new event inserted
          False  → exact duplicate (same dedup key), skipped
          dict   → existing event corroborated; dict is the enriched event
                   ready to re-broadcast with updated src_count + signal
        """
        key      = dedupe_key(evt.get('title', ''))
        region   = evt.get('region', 'GLOBAL')
        new_src  = evt.get('source', '?')
        now_ms   = evt.get('ts', int(time.time() * 1000))
        new_kws  = evt.get('keywords', [])
        cutoff   = now_ms - _CORROBORATION_WINDOW_MS

        with self._lock:
            # ── Exact dedup check ──────────────────────────────────────────────
            existing = self._conn.execute(
                "SELECT dedup_key FROM events WHERE dedup_key = ?", (key,)
            ).fetchone()
            if existing:
                return False  # exact duplicate

            # ── Corroboration check (skip GLOBAL — too broad) ──────────────────
            best_row    = None
            best_shared = set()

            if region != 'GLOBAL' and new_kws:
                candidates = self._conn.execute(
                    """
                    SELECT dedup_key, title, source, src_count, signal,
                           social_v, keywords, assets, region, ts, time, desc
                    FROM   events
                    WHERE  region = ? AND ts >= ?
                    ORDER  BY ts DESC
                    LIMIT  20
                    """,
                    (region, cutoff),
                ).fetchall()

                for row in candidates:
                    existing_kws = json.loads(row['keywords'] or '[]')
                    shared = _shared_high_keywords(new_kws, existing_kws)
                    if len(shared) >= 1 and len(shared) > len(best_shared):
                        best_shared = shared
                        best_row    = row

            if best_row:
                # ── Corroboration: update existing event ───────────────────────
                old_src_count = best_row['src_count']
                new_src_count = old_src_count + 1

                # Merge source names (comma-separated, max 5 unique)
                old_sources = best_row['source'] or ''
                src_list    = [s.strip() for s in old_sources.split(',') if s.strip()]
                if new_src not in src_list:
                    src_list.append(new_src)
                merged_src = ', '.join(src_list[:5])

                # Re-score with higher src_count
                new_signal = score_event(
                    title=best_row['title'],
                    desc=best_row['desc'] or '',
                    src_count=new_src_count,
                    social_v=best_row['social_v'],
                )

                self._conn.execute(
                    """
                    UPDATE events
                    SET    src_count = ?,
                           source    = ?,
                           signal    = ?
                    WHERE  dedup_key = ?
                    """,
                    (new_src_count, merged_src, new_signal, best_row['dedup_key']),
                )
                self._conn.commit()

                # Build enriched event dict for re-broadcast
                enriched              = dict(best_row)
                enriched['src_count'] = new_src_count
                enriched['srcCount']  = new_src_count
                enriched['source']    = merged_src
                enriched['signal']    = new_signal
                enriched['keywords']  = json.loads(enriched.get('keywords') or '[]')
                enriched['assets']    = json.loads(enriched.get('assets')   or '[]')
                enriched['socialV']   = enriched.pop('social_v', 0.0)
                enriched.pop('dedup_key', None)

                print(
                    f'[STORE] corroborated "{best_row["title"][:48]}" '
                    f'src {old_src_count}→{new_src_count} '
                    f'signal {best_row["signal"]}→{new_signal} '
                    f'shared_kws={best_shared} +{new_src}'
                )
                return enriched

            # ── New event: normal insert ───────────────────────────────────────
            cur = self._conn.execute(
                """
                INSERT OR IGNORE INTO events
                    (dedup_key, title, desc, source, ts, time,
                     region, keywords, assets, signal, src_count, social_v)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    key,
                    evt.get('title', '')[:90],
                    evt.get('desc', '')[:200],
                    new_src,
                    now_ms,
                    evt.get('time', ''),
                    region,
                    json.dumps(evt.get('keywords', [])),
                    json.dumps(evt.get('assets', [])),
                    evt.get('signal', 0),
                    evt.get('srcCount', 1),
                    evt.get('socialV', 0.0),
                ),
            )
            self._conn.commit()
            return cur.rowcount > 0

    def get_recent(self, limit: int = 100) -> List[Dict]:
        """Return the most recent events as dicts, newest first."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM events ORDER BY ts DESC LIMIT ?", (limit,)
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d['keywords'] = json.loads(d.get('keywords') or '[]')
            d['assets']   = json.loads(d.get('assets')   or '[]')
            d['srcCount'] = d.pop('src_count', 1)
            d['socialV']  = d.pop('social_v', 0.0)
            d.pop('dedup_key', None)
            result.append(d)
        return result

    def prune(self, max_rows: int = MAX_EVENTS_DB):
        """Delete oldest rows beyond max_rows to keep the DB lean."""
        with self._lock:
            self._conn.execute("""
                DELETE FROM events
                WHERE dedup_key IN (
                    SELECT dedup_key FROM events
                    ORDER BY ts DESC
                    LIMIT -1 OFFSET ?
                )
            """, (max_rows,))
            self._conn.commit()

    def count(self) -> int:
        with self._lock:
            return self._conn.execute(
                "SELECT COUNT(*) FROM events"
            ).fetchone()[0]


# Module-level singleton
_store: Optional[EventStore] = None


def get_store() -> EventStore:
    global _store
    if _store is None:
        _store = EventStore()
    return _store
