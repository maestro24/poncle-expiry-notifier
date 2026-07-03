"""Send (record) an alert for one due customer, triggered by "알림 보내기".

Behaviour is intentionally split:
  - ALWAYS record the send into sent_log (dedup + 발송 이력), so staff can track
    who has been handled.
  - ONLY dispatch to real channels (toast / webhook) when config.deliver_alerts
    is True. It defaults to False, so right now pressing the button records the
    send without actually notifying anywhere.
"""
from __future__ import annotations

from typing import Any

from . import db
from .notifier import Notifier, render_message
from .expiry import format_when


def send_alert(item: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    phone = str(item.get("phone", "")).strip()
    expiry = str(item.get("expiry_date", "")).strip()
    offset = int(item.get("milestone_offset", 0) or 0)
    if not phone or not expiry:
        return {"status": "error", "error": "invalid item"}

    if db.already_sent(phone, expiry, offset):
        return {"status": "already"}

    entry = {
        "phone": phone,
        "customer": item.get("customer", ""),
        "opendate": item.get("opendate", ""),
        "expiry_date": expiry,
        "milestone_offset": offset,
        "telecom": item.get("telecom", ""),
        "agency": item.get("agency", ""),
        "openhow": item.get("openhow", ""),
        "plan": item.get("plan", ""),
        "model": item.get("model", ""),
        "staff": item.get("staff", ""),
    }

    channel = "record-only"
    detail = "기록만 (실제 발송 비활성화)"
    if config.get("deliver_alerts", False):
        notifier = Notifier(config)
        when = format_when(offset, _safe_date(expiry))
        message = render_message(config.get("message_template", ""), entry, when)
        res = notifier.notify(message, entry)
        channel = ",".join(res.get("channels", [])) or "none"
        detail = res.get("detail", "")

    newly = db.record_sent(entry, channel)
    if not newly:
        return {"status": "already"}
    return {"status": "sent", "channel": channel, "detail": detail}


def _safe_date(iso: str):
    import datetime as _dt
    try:
        return _dt.date.fromisoformat(iso)
    except ValueError:
        return _dt.date.today()
