"""Poncle session handling (Approach A: reuse a real manual login).

The employee logs into Poncle once inside an embedded WebView window. We extract
that window's cookies and reuse them here with a plain requests.Session. No
password is ever stored or transmitted by us, and reCAPTCHA is satisfied by the
real browser login, not by us.

Cookies are cached to disk so an app restart keeps working until Poncle expires
the session, at which point the app flips to the 세션만료 state and asks the
employee to log in again.
"""
from __future__ import annotations

import datetime as _dt
import json
import threading
from typing import Any, Iterable

import requests

from .paths import COOKIES_PATH

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


class SessionExpired(Exception):
    """Raised when a request is answered by the login page instead of data."""


class SessionManager:
    """Holds the reused cookies and hands out a ready requests.Session."""

    def __init__(self, base_url: str = "https://m.poncle.co.kr") -> None:
        self.base_url = base_url.rstrip("/")
        self._lock = threading.RLock()
        self._cookies: dict[str, str] = {}
        self._saved_at: str | None = None
        self._load()

    # -- persistence --------------------------------------------------------
    def _load(self) -> None:
        try:
            data = json.loads(COOKIES_PATH.read_text(encoding="utf-8"))
            self._cookies = dict(data.get("cookies", {}))
            self._saved_at = data.get("saved_at")
        except (OSError, json.JSONDecodeError, AttributeError):
            self._cookies = {}
            self._saved_at = None

    def _persist(self) -> None:
        payload = {"cookies": self._cookies, "saved_at": self._saved_at}
        tmp = COOKIES_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(COOKIES_PATH)

    # -- cookie updates -----------------------------------------------------
    def set_cookies(self, cookies: dict[str, str]) -> None:
        """Replace the stored cookies (called after a fresh WebView login)."""
        with self._lock:
            # Keep only non-empty string values.
            self._cookies = {str(k): str(v) for k, v in cookies.items() if v}
            self._saved_at = _dt.datetime.now().isoformat(timespec="seconds")
            self._persist()

    def clear(self) -> None:
        with self._lock:
            self._cookies = {}
            self._saved_at = None
            try:
                COOKIES_PATH.unlink()
            except OSError:
                pass

    def has_cookies(self) -> bool:
        with self._lock:
            return bool(self._cookies)

    @property
    def saved_at(self) -> str | None:
        return self._saved_at

    # -- session ------------------------------------------------------------
    def build_session(self) -> requests.Session:
        with self._lock:
            s = requests.Session()
            s.headers.update({
                "User-Agent": _UA,
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": f"{self.base_url}/open/mobile",
                "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
            })
            for k, v in self._cookies.items():
                s.cookies.set(k, v, domain=_cookie_domain(self.base_url))
            return s

    def check(self, timeout: int = 15) -> bool:
        """Return True if the stored session can read data right now."""
        if not self.has_cookies():
            return False
        return self._probe(self._cookies, timeout)

    def check_cookies(self, cookies: dict[str, str], timeout: int = 15) -> bool:
        """Test an arbitrary cookie set (used while polling a fresh login) without
        persisting it."""
        clean = {str(k): str(v) for k, v in (cookies or {}).items() if v}
        if not clean:
            return False
        return self._probe(clean, timeout)

    def _probe(self, cookies: dict[str, str], timeout: int) -> bool:
        s = requests.Session()
        s.headers.update({
            "User-Agent": _UA,
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": f"{self.base_url}/open/mobile",
        })
        for k, v in cookies.items():
            s.cookies.set(k, v, domain=_cookie_domain(self.base_url))
        try:
            resp = s.get(
                f"{self.base_url}/open/listOpen",
                params=_probe_params(), timeout=timeout, allow_redirects=True,
            )
        except requests.RequestException:
            return False
        return _looks_like_data(resp)


def _cookie_domain(base_url: str) -> str:
    host = base_url.split("//", 1)[-1].split("/", 1)[0]
    return host


def _probe_params() -> dict[str, Any]:
    return {
        "start": "", "sort": "opendate", "by": "desc", "viewsum": 0,
        "sdate": "", "edate": "", "openhow": "", "cond": "", "agency": "",
        "member": "", "mgubun": "", "mmodel": "", "s": "customer-openphone",
        "q": "", "scale": 1,
    }


def _looks_like_data(resp: requests.Response) -> bool:
    """A valid data response is JSON with a 'list' array; the login page is HTML."""
    ctype = resp.headers.get("Content-Type", "")
    text = resp.text.lstrip()
    if resp.status_code != 200:
        return False
    if not text.startswith("{"):
        return False
    try:
        data = resp.json()
    except ValueError:
        return False
    return isinstance(data, dict) and "list" in data
