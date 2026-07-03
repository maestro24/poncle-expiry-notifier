"""Render the outbound customer message from the template.

This app sends a message TO the customer (their 2-year contract is expiring), so
there are no internal notification channels (toast / webhook) here. The actual
delivery transport (KDE Connect / QR / SMS) is wired separately; this module only
turns the template + a due row into the final text.
"""
from __future__ import annotations

from typing import Any

from .expiry import is_standard_open_type


def template_for_row(config: dict[str, Any], row: dict[str, Any]) -> str:
    """Pick the message template by 개통유형: 기변/신규 -> message_template,
    그 외 (번호이동/유심 등) -> message_template_nonstandard (falls back to the
    standard template if the non-standard one is empty)."""
    standard = config.get("message_template", "")
    if is_standard_open_type(row.get("openhowx", "")):
        return standard
    return config.get("message_template_nonstandard", "") or standard


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
