"""Local phone link: serve a one-page phone client over the LAN and hand it the
next customer SMS command to open in the phone's Messages app. HTTP short-polling,
stdlib only. Plain HTTP on a trusted LAN by design (see the phone-link spec)."""
from __future__ import annotations

import re as _re
import secrets
import socket
import urllib.parse
from collections import deque
from typing import Optional


def new_token() -> str:
    return secrets.token_hex(16)


def lan_ip() -> str:
    """Best-guess primary LAN IPv4 (the interface that routes to the internet)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return "127.0.0.1"
    finally:
        s.close()


def build_sms_uri(phone: str, text: str) -> str:
    digits = _re.sub(r"\D", "", phone or "")
    body = urllib.parse.quote(text or "", safe="")
    return f"sms:{digits}?body={body}"


class CommandQueue:
    def __init__(self) -> None:
        self._items: "deque[dict]" = deque()

    def put(self, phone: str, text: str) -> None:
        self._items.append({"phone": phone, "text": text})

    def pop(self) -> Optional[dict]:
        return self._items.popleft() if self._items else None
