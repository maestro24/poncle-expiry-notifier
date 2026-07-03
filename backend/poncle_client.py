"""Read open-line rows from Poncle's /open/listOpen JSON endpoint.

This is a pure data-access layer: it authenticates via SessionManager's cookies,
pages through rows, and yields raw dicts. All contract math and matching happen
in expiry.py / scan.py against these raw rows, so this module never needs to know
what "expiry" means.
"""
from __future__ import annotations

import datetime as _dt
from typing import Any, Iterable, Iterator

import requests

from .expiry import parse_opendate
from .session import SessionExpired, SessionManager, _looks_like_data


class PoncleClient:
    def __init__(self, session_mgr: SessionManager, config: dict[str, Any]) -> None:
        self.sm = session_mgr
        self.config = config
        self.base_url = session_mgr.base_url

    # -- low level ----------------------------------------------------------
    def _params(self, *, start: int, scale: int, sdate: str = "", edate: str = "") -> dict[str, Any]:
        return {
            "start": start, "sort": "opendate", "by": "desc", "viewsum": 0,
            "sdate": sdate, "edate": edate, "openhow": "", "cond": "", "agency": "",
            "member": "", "mgubun": "", "mmodel": "", "s": "customer-openphone",
            "q": "", "scale": scale,
        }

    def _get(self, session: requests.Session, params: dict[str, Any]) -> dict[str, Any]:
        timeout = int(self.config.get("request_timeout_sec", 20))
        try:
            resp = session.get(
                f"{self.base_url}/open/listOpen", params=params,
                timeout=timeout, allow_redirects=True,
            )
        except requests.RequestException as e:
            raise ConnectionError(f"Poncle request failed: {e}") from e
        if not _looks_like_data(resp):
            raise SessionExpired("listOpen did not return data (session likely expired)")
        data = resp.json()
        rows = data.get("list") or []
        total_raw = data.get("total") or 0
        try:
            total = int(str(total_raw).replace(",", ""))
        except ValueError:
            total = len(rows)
        return {"total": total, "list": rows}

    # -- strategies ---------------------------------------------------------
    def fetch_by_open_dates(self, dates: Iterable[_dt.date]) -> list[dict[str, Any]]:
        """Query each candidate open date as a small +/- day window.

        Why a window and not an exact day: expiry is opendate + N months with the
        day clamped to the target month's end, so the reverse (candidate opendate
        = expiry - N months) is NOT an exact inverse for month-end / leap-day
        openings and can be off by a few days. A window absorbs that error; the
        caller's client-side due_milestones then matches exactly.

        Falls back to a full scan (via _FilterIneffective) if the server appears
        to ignore the filter (returns far too many rows) OR silently returns zero
        rows across every window (which is indistinguishable from a broken/unknown
        date format, and for an active store 24 months ago is implausibly empty).
        """
        session = self.sm.build_session()
        scale = int(self.config.get("page_size", 100))
        window = max(0, int(self.config.get("date_window_days", 3)))
        collected: dict[str, dict[str, Any]] = {}
        grand_total = 0
        for d in dates:
            sdate = (d - _dt.timedelta(days=window)).isoformat()
            edate = (d + _dt.timedelta(days=window)).isoformat()
            first = self._get(session, self._params(start=0, scale=scale, sdate=sdate, edate=edate))
            total = first["total"]
            grand_total += total
            if total > scale * 8:
                # A few-day window should never hold hundreds of lines -> the
                # server is ignoring the filter; a full scan is more reliable.
                raise _FilterIneffective(total)
            for r in first["list"]:
                _accumulate(collected, r)
            start = scale
            while start < total:
                pg = self._get(session, self._params(start=start, scale=scale, sdate=sdate, edate=edate))
                for r in pg["list"]:
                    _accumulate(collected, r)
                if not pg["list"]:
                    break
                start += scale
        if grand_total == 0:
            # Zero rows for every ~24-month-old window is suspicious (likely the
            # filter format was not understood). Fall back rather than silently
            # miss every due customer.
            raise _FilterIneffective(0)
        return list(collected.values())

    def fetch_recent(self, earliest: _dt.date) -> list[dict[str, Any]]:
        """Full-scan fallback: page rows sorted by opendate desc and stop once we
        pass `earliest`. Correct regardless of server filter behaviour.
        """
        session = self.sm.build_session()
        scale = int(self.config.get("page_size", 100))
        lookback_months = int(self.config.get("scan_lookback_months", 40))
        hard_floor = _months_ago(_dt.date.today(), lookback_months)
        floor = max(earliest, hard_floor)

        collected: dict[str, dict[str, Any]] = {}
        start = 0
        # Absolute safety cap on requests (protects against pathological data).
        max_pages = 2000
        for _ in range(max_pages):
            pg = self._get(session, self._params(start=start, scale=scale))
            rows = pg["list"]
            if not rows:
                break
            passed_floor = False
            for r in rows:
                od = parse_opendate(str(r.get("opendate", "")))
                if od is not None and od < floor:
                    passed_floor = True
                    continue
                _accumulate(collected, r)
            if passed_floor:
                break                       # rows are desc-sorted: nothing older matters
            start += scale
            if start >= pg["total"]:
                break
        return list(collected.values())

    # -- public -------------------------------------------------------------
    def fetch_candidates(self, candidate_dates: list[_dt.date]) -> list[dict[str, Any]]:
        """Return the rows worth evaluating for today's milestones.

        Uses the server date filter when enabled and effective; otherwise falls
        back to a bounded full scan. Either way the caller re-checks each row
        client-side, so this only affects efficiency, never correctness.
        """
        if not candidate_dates:
            return []
        window = max(0, int(self.config.get("date_window_days", 3)))
        earliest = min(candidate_dates) - _dt.timedelta(days=window)
        if self.config.get("use_server_date_filter", True):
            try:
                return self.fetch_by_open_dates(candidate_dates)
            except _FilterIneffective:
                pass                        # fall through to full scan
        return self.fetch_recent(earliest)


class _FilterIneffective(Exception):
    """Server date filter looks unreliable (too many rows, or zero across all
    windows) -> fall back to a bounded full scan."""

    def __init__(self, total: int) -> None:
        super().__init__(f"date filter unreliable (grand_total={total})")
        self.total = total


def row_key(row: dict[str, Any]) -> str:
    """Stable identity for a row (Poncle's line idx if present, else phone+date)."""
    idx = str(row.get("idx", "")).strip()
    if idx:
        return f"idx:{idx}"
    return f"pd:{row.get('openphone','')}|{row.get('opendate','')}"


def _accumulate(store: dict[str, dict[str, Any]], row: dict[str, Any]) -> None:
    store[row_key(row)] = row


def _months_ago(d: _dt.date, months: int) -> _dt.date:
    total = (d.year * 12 + (d.month - 1)) - months
    year, month = divmod(total, 12)
    month += 1
    # Clamp day.
    if month == 12:
        nxt = _dt.date(year + 1, 1, 1)
    else:
        nxt = _dt.date(year, month + 1, 1)
    last = (nxt - _dt.timedelta(days=1)).day
    return _dt.date(year, month, min(d.day, last))
