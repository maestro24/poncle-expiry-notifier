"""Load / save user settings as a JSON file, with defaults + validation.

Settings are intentionally file-based (no paid DB, per project decision).
Unknown keys from an older/newer file are preserved by merging over defaults.
"""
from __future__ import annotations

import copy
import json
import threading
from typing import Any

from .paths import CONFIG_PATH

_LOCK = threading.RLock()

# ---------------------------------------------------------------------------
# Default settings
# ---------------------------------------------------------------------------
DEFAULTS: dict[str, Any] = {
    "poncle_base_url": "https://m.poncle.co.kr",

    # Contract term is decided by 개통유형 (openhowx):
    #   기변 / 신규            -> default_term_months (standard, usually 24)
    #   그 외 (번호이동 / 유심신규 / 유심MNP ...) -> 거래처(agencytitle)마다 다름:
    #       agency_term_months[<거래처명>] if set, else nonstandard_term_months.
    # NOTE: 개통유형은 정확히 "기변"/"신규"일 때만 표준. "유심신규"는 "신규"를
    # 포함하지만 정확 매칭이라 비표준(6개월)으로 처리된다.
    "default_term_months": 24,       # 기변 / 신규
    "nonstandard_term_months": 6,    # 그 외 유형의 기본값
    # 거래처명 -> 개월수. 사용자가 설정에서 조정한 거래처만 담긴다(그 외는 위 기본값).
    "agency_term_months": {},

    # Which milestones to alert on, in days BEFORE expiry. 0 == on the expiry
    # day itself. e.g. [30, 7, 0] fires three separate alerts per customer.
    "notify_offsets_days": [0],

    # Daily scheduled run (24h HH:MM, local time).
    "run_time": "09:00",
    # Also run a scan a few seconds after the app launches / PC boots.
    "run_on_startup": True,

    # Register the app in the Windows startup folder so it launches at logon.
    "autostart_enabled": False,

    # Check GitHub Releases for a newer build on startup and prompt to install.
    "auto_check_updates": True,

    # Outbound message sent TO the customer. Two templates, chosen by 개통유형 the
    # same way the term is: 기변/신규 use message_template, everything else
    # (번호이동/유심신규/유심MNP) uses message_template_nonstandard.
    # Placeholders: {customer} {telecom} {model} {expiry} {opendate} {when}
    # (also available: {phone} {agency} {plan}).
    "message_template": (
        "안녕하세요 {customer}님. 사용 중이신 {telecom} 휴대폰({model})의 "
        "2년 약정이 {expiry}에 만료됩니다. 기기변경/요금제 상담 원하시면 "
        "편하게 연락 주세요."
    ),
    "message_template_nonstandard": (
        "안녕하세요 {customer}님. {telecom}({model}) 약정이 {expiry}에 "
        "만료됩니다. 재약정/번호이동/요금제 상담 원하시면 편하게 연락 주세요."
    ),

    # Master switch for ACTUALLY sending the message to customers. When False,
    # pressing "알림 보내기" still records the send into 발송 이력 (so staff can track
    # which customers have been handled) but nothing is sent. The delivery
    # transport (KDE Connect / QR / SMS) is not wired yet, so this stays off.
    "deliver_alerts": False,

    # Efficiency / safety knobs for scraping.
    "use_server_date_filter": True,   # ask Poncle to pre-filter by open date
    # Query each candidate open date as a +/- window (days) instead of a single
    # day. This absorbs the small day-clamp error from month arithmetic (e.g. a
    # leap-day / month-end opening whose expiry lands on a shorter month), so the
    # server filter never silently drops a due row. Client-side due_milestones
    # still matches exactly, so the window only widens the fetch, never the alerts.
    "date_window_days": 3,
    "scan_lookback_months": 40,       # hard bound for the full-scan fallback
    "page_size": 100,                 # rows per listOpen request
    "request_timeout_sec": 20,
}


def _deep_merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


# The old internal-alert default template, kept only to detect an un-customized
# older settings.json so we can upgrade it to the new customer-facing default.
_OLD_DEFAULT_TEMPLATE = (
    "[약정만료] {customer}님 ({phone}) 2년 약정 만료 {when}. "
    "개통 {opendate} · {telecom} · {agency}"
)


def _migrate(cfg: dict[str, Any]) -> dict[str, Any]:
    """Drop removed keys and upgrade un-customized old defaults in place."""
    # 'channels' (desktop toast / webhook) was removed with the internal-alert
    # model; a merged file may still carry it. It is never read, so prune it.
    cfg.pop("channels", None)
    # 'term_overrides' / 'skip_zero_term' were replaced by the 개통유형 + 거래처
    # term model (default_term_months / nonstandard_term_months / agency_term_months).
    cfg.pop("term_overrides", None)
    cfg.pop("skip_zero_term", None)
    # If the user never edited the old internal template, move them to the new
    # customer-facing default. A customized template is left untouched.
    if cfg.get("message_template") == _OLD_DEFAULT_TEMPLATE:
        cfg["message_template"] = DEFAULTS["message_template"]
    return cfg


def load() -> dict[str, Any]:
    """Return current settings (defaults merged with the on-disk file)."""
    with _LOCK:
        if not CONFIG_PATH.exists():
            save(DEFAULTS)
            return copy.deepcopy(DEFAULTS)
        try:
            raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError("settings.json is not an object")
            return _migrate(_deep_merge(DEFAULTS, raw))
        except (json.JSONDecodeError, ValueError, OSError):
            # Corrupt file: back it up and fall back to defaults rather than crash.
            try:
                CONFIG_PATH.rename(CONFIG_PATH.with_suffix(".corrupt.json"))
            except OSError:
                pass
            save(DEFAULTS)
            return copy.deepcopy(DEFAULTS)


def save(settings: dict[str, Any]) -> None:
    """Persist settings atomically."""
    with _LOCK:
        merged = _migrate(_deep_merge(DEFAULTS, settings))
        tmp = CONFIG_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(CONFIG_PATH)


def update(patch: dict[str, Any]) -> dict[str, Any]:
    """Merge `patch` into the saved settings and return the new full settings."""
    with _LOCK:
        current = load()
        new = _deep_merge(current, patch)
        save(new)
        return new
