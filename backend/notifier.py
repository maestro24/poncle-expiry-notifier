"""Deliver the internal alert ("customer OOO's 2-yr contract expired").

The alert is for US / internal staff, not the customer, so there is no marketing
consent or carrier SMS involved. Channels are pluggable:

  in_app         - always available; the alert lands in the live log + history
                   (this IS the primary internal surface, so an alert is
                   considered delivered as long as in_app is on).
  desktop_toast  - native Windows toast, best effort.
  webhook        - optional Slack / Discord / KakaoWork / generic incoming webhook.

Adding a new channel = add a method and wire it in `notify()`. Nothing else in
the app needs to change.
"""
from __future__ import annotations

from typing import Any

import requests

from .masking import mask_name, mask_phone

# Native Windows toast is optional; degrade gracefully if unavailable.
try:  # pragma: no cover - platform dependent
    from windows_toasts import Toast, WindowsToaster
    _TOASTER: "WindowsToaster | None" = WindowsToaster("약정만료 알리미")
except Exception:  # ImportError on non-Windows, or COM init failure
    _TOASTER = None


class Notifier:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config

    # -- channels -----------------------------------------------------------
    def _toast(self, title: str, message: str) -> tuple[bool, str]:
        if _TOASTER is None:
            return False, "toast unavailable"
        try:
            t = Toast()
            t.text_fields = [title, message]
            _TOASTER.show_toast(t)
            return True, "toast ok"
        except Exception as e:  # pragma: no cover
            return False, f"toast error: {e}"

    def _webhook(self, message: str, entry: dict[str, Any]) -> tuple[bool, str]:
        wh = (self.config.get("channels", {}) or {}).get("webhook", {}) or {}
        if not wh.get("enabled") or not wh.get("url"):
            return False, "webhook disabled"
        kind = (wh.get("type") or "generic").lower()
        if kind == "slack":
            payload = {"text": message}
        elif kind == "discord":
            payload = {"content": message}
        elif kind == "kakaowork":
            payload = {"text": message}
        else:
            # Generic automation endpoint: send the rendered message plus a
            # structured object, but mask name/phone so raw customer PII is not
            # dumped off-device beyond what the message itself already contains.
            payload = {"text": message, "entry": _safe_entry(entry)}
        try:
            r = requests.post(wh["url"], json=payload, timeout=15)
            if 200 <= r.status_code < 300:
                return True, "webhook ok"
            return False, f"webhook http {r.status_code}"
        except requests.RequestException as e:
            return False, f"webhook error: {e}"

    # -- public -------------------------------------------------------------
    def notify(self, message: str, entry: dict[str, Any]) -> dict[str, Any]:
        """Dispatch to every enabled channel. Returns:
        {ok: bool, channels: [str], detail: str}
        ok is True if the alert reached at least one internal surface.
        """
        channels = self.config.get("channels", {}) or {}
        delivered: list[str] = []
        notes: list[str] = []

        in_app = bool(channels.get("in_app", True))
        if in_app:
            delivered.append("in_app")

        if channels.get("desktop_toast", True):
            ok, note = self._toast("약정 만료 알림", message)
            notes.append(note)
            if ok:
                delivered.append("toast")

        ok, note = self._webhook(message, entry)
        if (channels.get("webhook", {}) or {}).get("enabled"):
            notes.append(note)
            if ok:
                delivered.append("webhook")

        return {
            "ok": len(delivered) > 0,
            "channels": delivered,
            "detail": "; ".join(notes) if notes else "in_app",
        }


def _safe_entry(entry: dict[str, Any]) -> dict[str, Any]:
    """A copy of the entry with name/phone masked, for off-device webhook payloads."""
    safe = dict(entry)
    safe["customer"] = mask_name(entry.get("customer"))
    safe["phone"] = mask_phone(entry.get("phone"))
    return safe


def render_message(template: str, entry: dict[str, Any], when: str) -> str:
    """Fill the message template. Missing placeholders degrade to ''."""
    class _Safe(dict):
        def __missing__(self, key: str) -> str:  # noqa: D401
            return ""

    values = _Safe(
        customer=entry.get("customer", ""),
        phone=entry.get("phone", ""),
        expiry=entry.get("expiry_date", ""),
        opendate=entry.get("opendate", ""),
        telecom=entry.get("telecom", ""),
        agency=entry.get("agency", ""),
        plan=entry.get("plan", ""),
        model=entry.get("model", ""),
        staff=entry.get("staff", ""),
        offset=entry.get("milestone_offset", 0),
        when=when,
    )
    try:
        return template.format_map(values)
    except (KeyError, IndexError, ValueError):
        return template
