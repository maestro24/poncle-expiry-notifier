"""Local SQLite storage (no paid DB).

Two concerns kept deliberately separate:

  sent_log  - SUCCESSFUL alerts only. This is the dedup source of truth.
              UNIQUE(phone, expiry_date, milestone_offset) means each customer is
              alerted at most once per milestone under normal operation. We insert
              a row the instant an alert succeeds and commit immediately, so a
              crash mid-run does not lose "already sent" facts. (Delivery is
              at-least-once: because the send happens before the commit, a crash in
              the tiny window between them can re-send that one alert next run. See
              scan.py.) Failures are intentionally NOT inserted -> they retry next run.

  events    - append-only audit of every attempt (sent / skipped / failed / errors
              / scan start-end). Powers the live log and the 발송 이력 조회 screen.

  meta      - tiny key/value store (last_run_at, next_run_at, ...).

All methods are safe to call from multiple threads: sqlite3 connection is opened
per-call with a short busy timeout.
"""
from __future__ import annotations

import datetime as _dt
import sqlite3
import threading
from contextlib import contextmanager
from typing import Any, Iterator

from .paths import DB_PATH

_LOCK = threading.Lock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sent_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    phone           TEXT NOT NULL,
    customer        TEXT,
    opendate        TEXT,
    expiry_date     TEXT NOT NULL,
    milestone_offset INTEGER NOT NULL,
    telecom         TEXT,
    agency          TEXT,
    plan            TEXT,
    model           TEXT,
    openhow         TEXT,
    staff           TEXT,
    channel         TEXT,
    sent_at         TEXT NOT NULL,
    UNIQUE(phone, expiry_date, milestone_offset)
);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    kind        TEXT NOT NULL,           -- sent | skipped | failed | scan | error
    customer    TEXT,
    phone       TEXT,
    opendate    TEXT,
    expiry_date TEXT,
    milestone_offset INTEGER,
    telecom     TEXT,
    detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


def _now_iso() -> str:
    return _dt.datetime.now().isoformat(timespec="seconds")


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout=15000;")
        yield conn
        conn.commit()
    finally:
        conn.close()


def init() -> None:
    with _LOCK, _connect() as conn:
        conn.executescript(_SCHEMA)
        _migrate(conn)


def _migrate(conn: sqlite3.Connection) -> None:
    """Add columns introduced after a DB was first created (SQLite has no
    ADD COLUMN IF NOT EXISTS, so check pragma table_info first)."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(sent_log)").fetchall()}
    if "openhow" not in cols:
        conn.execute("ALTER TABLE sent_log ADD COLUMN openhow TEXT")


# ---------------------------------------------------------------------------
# Dedup (sent_log)
# ---------------------------------------------------------------------------
def already_sent(phone: str, expiry_date: str, milestone_offset: int) -> bool:
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM sent_log WHERE phone=? AND expiry_date=? AND milestone_offset=?",
            (phone, expiry_date, milestone_offset),
        ).fetchone()
        return row is not None


def record_sent(entry: dict[str, Any], channel: str) -> bool:
    """Insert into sent_log (dedup) atomically. Returns True if newly inserted,
    False if it was already there (another milestone/run beat us to it)."""
    with _LOCK, _connect() as conn:
        cur = conn.execute(
            """INSERT OR IGNORE INTO sent_log
               (phone, customer, opendate, expiry_date, milestone_offset,
                telecom, agency, plan, model, openhow, staff, channel, sent_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                entry.get("phone"),
                entry.get("customer"),
                entry.get("opendate"),
                entry.get("expiry_date"),
                int(entry.get("milestone_offset", 0)),
                entry.get("telecom"),
                entry.get("agency"),
                entry.get("plan"),
                entry.get("model"),
                entry.get("openhow"),
                entry.get("staff"),
                channel,
                _now_iso(),
            ),
        )
        return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Audit / display (events)
# ---------------------------------------------------------------------------
def add_event(
    kind: str,
    *,
    customer: str | None = None,
    phone: str | None = None,
    opendate: str | None = None,
    expiry_date: str | None = None,
    milestone_offset: int | None = None,
    telecom: str | None = None,
    detail: str | None = None,
) -> dict[str, Any]:
    ts = _now_iso()
    with _LOCK, _connect() as conn:
        cur = conn.execute(
            """INSERT INTO events
               (ts, kind, customer, phone, opendate, expiry_date,
                milestone_offset, telecom, detail)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (ts, kind, customer, phone, opendate, expiry_date,
             milestone_offset, telecom, detail),
        )
        rid = cur.lastrowid
    return {
        "id": rid, "ts": ts, "kind": kind, "customer": customer, "phone": phone,
        "opendate": opendate, "expiry_date": expiry_date,
        "milestone_offset": milestone_offset, "telecom": telecom, "detail": detail,
    }


def recent_events(limit: int = 200) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM events ORDER BY id DESC LIMIT ?", (int(limit),)
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def today_counts() -> dict[str, int]:
    """Counts of today's events by kind (for the summary cards)."""
    today = _dt.date.today().isoformat()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT kind, COUNT(*) c FROM events WHERE substr(ts,1,10)=? GROUP BY kind",
            (today,),
        ).fetchall()
    counts = {r["kind"]: r["c"] for r in rows}
    return {
        "targets": counts.get("sent", 0) + counts.get("skipped", 0) + counts.get("failed", 0),
        "sent": counts.get("sent", 0),
        "skipped": counts.get("skipped", 0),
        "failed": counts.get("failed", 0),
    }


def search_history(
    query: str = "", start: str = "", end: str = "", limit: int = 500
) -> list[dict[str, Any]]:
    """History screen: successful sends, optionally filtered by text / date range.

    query matches customer or phone. start/end are ISO dates (inclusive) on sent_at.
    """
    sql = "SELECT * FROM sent_log WHERE 1=1"
    args: list[Any] = []
    if query:
        sql += " AND (customer LIKE ? OR phone LIKE ?)"
        args += [f"%{query}%", f"%{query}%"]
    if start:
        sql += " AND substr(sent_at,1,10) >= ?"
        args.append(start)
    if end:
        sql += " AND substr(sent_at,1,10) <= ?"
        args.append(end)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(int(limit))
    with _connect() as conn:
        rows = conn.execute(sql, args).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# meta key/value
# ---------------------------------------------------------------------------
def set_meta(key: str, value: str) -> None:
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def get_meta(key: str, default: str | None = None) -> str | None:
    with _connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default
