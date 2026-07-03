"""Contract-expiry math over raw Poncle rows.

A Poncle row (from /open/listOpen) has, among others:
    opendate  : "26-07-02"  (yy-mm-dd, Korea local date the line was opened)
    openhowx  : "기변" | "번호이동" | "유심MNP" | ...
    telecomx  : "SK텔레콤" | "U+알뜰모바일" | ...
    plan, agencytitle, customer, openphone, model, membername, ...

Expiry = opendate + term_months. term_months comes from 개통유형: 기변/신규 use
default_term_months (24); every other type uses the row's 거래처 term from
agency_term_months, or nonstandard_term_months (6) if that 거래처 has no override.

The public entry point is `due_milestones(row, config, today)` which returns the
list of (offset_days, expiry_date) milestones that fall on `today`. Everything is
computed client-side so correctness never depends on the server date filter.
"""
from __future__ import annotations

import datetime as _dt
import html as _html
import re as _re
from typing import Any, Iterable

# 개통유형(openhowx)이 정확히 이 값이면 표준 약정(기변/신규). "유심신규"는 "신규"를
# 포함하지만 정확 매칭이라 여기 안 걸리고 비표준(거래처 기준)으로 처리된다.
STANDARD_OPEN_TYPES = frozenset({"기변", "신규"})


def parse_opendate(value: str) -> _dt.date | None:
    """Parse Poncle's 'yy-mm-dd' (also tolerates 'yyyy-mm-dd')."""
    value = (value or "").strip()
    if not value:
        return None
    parts = value.split("-")
    if len(parts) != 3:
        return None
    try:
        y, m, d = (int(p) for p in parts)
    except ValueError:
        return None
    if y < 100:                      # two-digit year -> 2000+yy
        y += 2000
    try:
        return _dt.date(y, m, d)
    except ValueError:
        return None


def add_months(d: _dt.date, months: int) -> _dt.date:
    """Add `months` calendar months, clamping the day to the target month end.

    e.g. add_months(2024-01-31, 1) -> 2024-02-29.
    """
    total = (d.year * 12 + (d.month - 1)) + months
    year, month = divmod(total, 12)
    month += 1
    # Clamp day to the last valid day of the resulting month.
    if month == 12:
        next_month_first = _dt.date(year + 1, 1, 1)
    else:
        next_month_first = _dt.date(year, month + 1, 1)
    last_day = (next_month_first - _dt.timedelta(days=1)).day
    return _dt.date(year, month, min(d.day, last_day))


def _field(row: dict[str, Any], name: str) -> str:
    return str(row.get(name, "") or "")


def normalize_agency(name: str) -> str:
    """Normalize a 거래처 name for matching: unescape HTML entities (PS&amp;M ->
    PS&M), collapse whitespace, casefold. Applied to both the config key and the
    scanned row so minor spacing/case/encoding differences still match."""
    s = _html.unescape(str(name or ""))
    s = _re.sub(r"\s+", " ", s).strip().lower()
    return s


def is_standard_open_type(openhow: str) -> bool:
    """True for 기변/신규 (표준 약정 + 표준 문자). 정확 매칭이라 유심신규는 False."""
    return str(openhow or "").strip() in STANDARD_OPEN_TYPES


def resolve_term_months(row: dict[str, Any], config: dict[str, Any]) -> int:
    """개통유형 기변/신규 -> 표준 약정. 그 외 -> 거래처별 값(없으면 비표준 기본)."""
    if is_standard_open_type(_field(row, "openhowx")):
        return int(config.get("default_term_months", 24))

    agency = normalize_agency(_field(row, "agencytitle"))
    overrides = config.get("agency_term_months", {}) or {}
    for name, months in overrides.items():
        if normalize_agency(name) == agency:
            try:
                return int(months)
            except (TypeError, ValueError):
                break
    return int(config.get("nonstandard_term_months", 6))


def compute_expiry(row: dict[str, Any], config: dict[str, Any]) -> _dt.date | None:
    """Return the expiry date, or None if the row has no computable/relevant term."""
    open_d = parse_opendate(_field(row, "opendate"))
    if open_d is None:
        return None
    term = resolve_term_months(row, config)
    if term <= 0:
        return None
    return add_months(open_d, term)


def normalized_offsets(config: dict[str, Any]) -> list[int]:
    """Sorted, de-duplicated, non-negative notify offsets (days before expiry)."""
    seen: set[int] = set()
    for v in config.get("notify_offsets_days", [0]) or [0]:
        try:
            n = int(v)
        except (TypeError, ValueError):
            continue
        if n >= 0:
            seen.add(n)
    return sorted(seen) or [0]


def due_milestones(
    row: dict[str, Any], config: dict[str, Any], today: _dt.date
) -> list[tuple[int, _dt.date]]:
    """Milestones for this row that land exactly on `today`.

    Returns a list of (offset_days, expiry_date). A milestone fires when
    today == expiry - offset_days.
    """
    expiry = compute_expiry(row, config)
    if expiry is None:
        return []
    out: list[tuple[int, _dt.date]] = []
    for offset in normalized_offsets(config):
        if today == expiry - _dt.timedelta(days=offset):
            out.append((offset, expiry))
    return out


def candidate_open_dates(
    config: dict[str, Any], today: _dt.date
) -> list[_dt.date]:
    """Open dates that could produce a milestone today, used to narrow the
    server-side date filter. For every (offset, term) pair,
        expiry = today + offset  and  opendate = expiry - term.
    Includes the default term and every override term.
    """
    terms: set[int] = {
        int(config.get("default_term_months", 24)),
        int(config.get("nonstandard_term_months", 6)),
    }
    for months in (config.get("agency_term_months", {}) or {}).values():
        try:
            terms.add(int(months))
        except (TypeError, ValueError):
            continue
    dates: set[_dt.date] = set()
    for offset in normalized_offsets(config):
        expiry = today + _dt.timedelta(days=offset)
        for term in terms:
            if term <= 0:
                continue
            dates.add(add_months(expiry, -term))
    return sorted(dates)


def format_when(offset_days: int, expiry: _dt.date) -> str:
    """Human phrase for the alert text, e.g. '오늘(2026-06-15)' / 'D-7 (2026-06-15)'."""
    iso = expiry.isoformat()
    if offset_days == 0:
        return f"오늘 {iso}"
    return f"D-{offset_days} ({iso})"
