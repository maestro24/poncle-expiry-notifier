"""Serialize scan results and history rows for the WebView UI.

These are internal, staff-facing tables (the list of customers to act on and the
record of who was handled), so they show the REAL customer name and phone: staff
need to identify and contact the customer whose contract expired.
"""
from __future__ import annotations

from typing import Any


def scanitem_to_ui(item: dict[str, Any]) -> dict[str, Any]:
    """One row of the main 'scan results' table."""
    return {
        "id": item.get("id"),
        "opendate": item.get("opendate") or "",
        "agency": item.get("agency") or "",
        "customer": item.get("customer") or "",
        "phone": item.get("phone") or "",
        "openhow": item.get("openhow") or "",          # 종류
        "telecom": item.get("telecom") or "",
        "model": item.get("model") or "",
        "expiry_date": item.get("expiry_date") or "",
        "milestone_offset": item.get("milestone_offset"),
        "plan": item.get("plan") or "",
        "staff": item.get("staff") or "",
        "already_sent": bool(item.get("already_sent")),
    }


def history_to_ui(rec: dict[str, Any]) -> dict[str, Any]:
    """One row of the 발송 이력 table:
    발송일시 · 개통일 · 거래처 · 고객명 · 개통번호 · 종류 · 통신사 · 모델명."""
    return {
        "id": rec.get("id"),
        "sent_at": rec.get("sent_at") or "",
        "opendate": rec.get("opendate") or "",
        "agency": rec.get("agency") or "",
        "customer": rec.get("customer") or "",
        "phone": rec.get("phone") or "",
        "openhow": rec.get("openhow") or "",
        "telecom": rec.get("telecom") or "",
        "model": rec.get("model") or "",
        "expiry_date": rec.get("expiry_date") or "",
        "channel": rec.get("channel") or "",
    }
