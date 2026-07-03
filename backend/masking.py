"""Mask customer PII for on-screen display (the live log & history show masked
names/phones, matching the design: 김*수 / 010-31**-**49).

Masking is display-only. Full values are still stored in the local DB so the
alert message can address the real customer.
"""
from __future__ import annotations

import re


def mask_name(name: str | None) -> str:
    name = (name or "").strip()
    if not name:
        return "-"
    # Roman names (e.g. "LI CHANGJI"): keep first token initial + last token.
    if re.search(r"[A-Za-z]", name):
        parts = name.split()
        if len(parts) >= 2:
            return f"{parts[0][0]}* {parts[-1][0]}*".upper()
        if len(name) <= 2:
            return name[0] + "*"
        return name[0] + "*" * (len(name) - 2) + name[-1]
    # Korean names: keep first & last char, star the middle.
    if len(name) == 1:
        return name
    if len(name) == 2:
        return name[0] + "*"
    return name[0] + "*" * (len(name) - 2) + name[-1]


def mask_phone(phone: str | None) -> str:
    """010-3479-7780 -> 010-34**-**80  (matches the mock design pattern)."""
    phone = (phone or "").strip()
    digits = re.sub(r"\D", "", phone)
    if len(digits) < 10:
        return phone or "-"
    if len(digits) == 11:          # 010 XXXX YYYY
        a, b, c = digits[:3], digits[3:7], digits[7:]
        return f"{a}-{b[:2]}**-**{c[2:]}"
    # 10-digit fallback (010 XXX YYYY)
    a, b, c = digits[:3], digits[3:6], digits[6:]
    return f"{a}-{b[:1]}**-**{c[2:]}"
