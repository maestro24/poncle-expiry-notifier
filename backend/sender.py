"""Send (record) an outbound customer message for one due row, from "알림 보내기".

Behaviour is intentionally split:
  - ALWAYS record the send into sent_log (dedup + 발송 이력), so staff can track
    which customers have been handled.
  - When config.deliver_alerts is True, this is ALSO where the real customer
    message would be dispatched. The delivery transport (KDE Connect / QR / SMS)
    is not wired yet, so for now it still only records (marked "pending"). It
    defaults to False, so pressing the button just records the send.
"""
from __future__ import annotations

from typing import Any

from . import db


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
        # 실제 고객 문자 발송(KDE Connect / QR / SMS) 연동 예정 위치.
        # 방식이 아직 연결되지 않아 지금은 기록만 하고 pending으로 표시한다.
        channel = "pending"
        detail = "문자 전송 방식 미연결 (기록만)"

    newly = db.record_sent(entry, channel)
    if not newly:
        return {"status": "already"}
    return {"status": "sent", "channel": channel, "detail": detail}
