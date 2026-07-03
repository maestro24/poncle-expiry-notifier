"""Render the outbound customer message from the template.

This app sends a message TO the customer (their 2-year contract is expiring), so
there are no internal notification channels (toast / webhook) here. The actual
delivery transport (KDE Connect / QR / SMS) is wired separately; this module only
turns the template + a due row into the final text.
"""
from __future__ import annotations

from typing import Any


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
