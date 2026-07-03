"""Send (record) an outbound customer message for one due row, from "알림 보내기"."""
from __future__ import annotations

from typing import Any

from . import db
from .expiry import format_when
from .notifier import render_message, template_for_row


def send_alert(item: dict[str, Any], config: dict[str, Any],
               phone_link: Any = None) -> dict[str, Any]:
    phone = str(item.get("phone", "")).strip()
    expiry = str(item.get("expiry_date", "")).strip()
    offset = int(item.get("milestone_offset", 0) or 0)
    if not phone or not expiry:
        return {"status": "error", "error": "invalid item"}

    if db.already_sent(phone, expiry, offset):
        return {"status": "already"}

    deliver = bool(config.get("deliver_alerts", False))
    if deliver:
        if phone_link is None or not phone_link.is_connected():
            return {"status": "error",
                    "error": "폰이 연결되지 않았습니다. QR을 스캔해 연결하세요."}
        when = format_when(offset, _safe_date(expiry))
        text = render_message(template_for_row(config, item), _entry(item), when)
        phone_link.queue_message(phone, text)
        channel = "phone"
    else:
        channel = "record-only"

    newly = db.record_sent(_entry(item), channel)
    if not newly:
        return {"status": "already"}
    return {"status": "sent", "channel": channel}


def _entry(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "phone": str(item.get("phone", "")).strip(),
        "customer": item.get("customer", ""),
        "opendate": item.get("opendate", ""),
        "expiry_date": str(item.get("expiry_date", "")).strip(),
        "milestone_offset": int(item.get("milestone_offset", 0) or 0),
        "telecom": item.get("telecom", ""),
        "agency": item.get("agency", ""),
        "openhow": item.get("openhow", ""),
        "plan": item.get("plan", ""),
        "model": item.get("model", ""),
        "staff": item.get("staff", ""),
    }


def _safe_date(iso: str):
    import datetime as _dt
    try:
        return _dt.date.fromisoformat(iso)
    except ValueError:
        return _dt.date.today()
