"""The scan orchestrator: fetch -> compute expiry -> build a "due list".

The scan NO LONGER sends anything. It produces the list of customers whose
contract is due today (per the configured milestones), flags which ones have
already been alerted (from sent_log), and hands the list to the UI. Sending an
alert is a separate, explicit per-row action (see backend/sender.py), triggered
by the staff pressing "알림 보내기".

Dedup is unchanged: sent_log with UNIQUE(phone, expiry_date, milestone_offset)
means the list marks already-handled customers so they are not alerted twice.
"""
from __future__ import annotations

import datetime as _dt
import threading
import traceback
from typing import Any, Callable

from . import config as config_mod
from . import db
from .expiry import candidate_open_dates, due_milestones
from .poncle_client import PoncleClient
from .session import SessionExpired, SessionManager

# UI state strings (must match the frontend).
STATE_IDLE = "idle"
STATE_SCANNING = "scanning"
STATE_SESSION_EXPIRED = "session_expired"
STATE_ERROR = "error"

ResultsCb = Callable[[list[dict[str, Any]]], None]
StateCb = Callable[[str], None]


def _noop(*_a: Any, **_k: Any) -> None:
    return None


class Scanner:
    def __init__(
        self,
        session_mgr: SessionManager,
        on_results: ResultsCb = _noop,
        on_state: StateCb = _noop,
    ) -> None:
        self.sm = session_mgr
        self.on_results = on_results
        self.on_state = on_state
        self._run_lock = threading.Lock()
        self.results: list[dict[str, Any]] = []

    # -- helpers ------------------------------------------------------------
    def _state(self, state: str) -> None:
        try:
            self.on_state(state)
        except Exception:
            pass

    def _emit_results(self) -> None:
        try:
            self.on_results(self.results)
        except Exception:
            pass

    def is_running(self) -> bool:
        return self._run_lock.locked()

    # -- main ---------------------------------------------------------------
    def run(self, *, trigger: str = "manual") -> dict[str, Any]:
        if not self._run_lock.acquire(blocking=False):
            return {"status": "busy"}
        try:
            return self._run_locked(trigger)
        finally:
            self._run_lock.release()

    def _run_locked(self, trigger: str) -> dict[str, Any]:
        cfg = config_mod.load()
        today = _dt.date.today()
        summary = {"status": "ok", "targets": 0, "sent": 0, "pending": 0, "trigger": trigger}

        self._state(STATE_SCANNING)

        if not self.sm.check(timeout=int(cfg.get("request_timeout_sec", 20))):
            self._state(STATE_SESSION_EXPIRED)
            summary["status"] = "session_expired"
            db.set_meta("last_run_at", _now())
            return summary

        client = PoncleClient(self.sm, cfg)
        dates = candidate_open_dates(cfg, today)
        try:
            rows = client.fetch_candidates(dates)
        except SessionExpired:
            self._state(STATE_SESSION_EXPIRED)
            summary["status"] = "session_expired"
            return summary
        except Exception as e:
            self._state(STATE_ERROR)
            summary["status"] = "error"
            summary["error"] = str(e)
            return summary

        results: list[dict[str, Any]] = []
        for row in rows:
            for offset, expiry in due_milestones(row, cfg, today):
                item = _entry_from_row(row, offset, expiry)
                item["already_sent"] = db.already_sent(
                    item["phone"], item["expiry_date"], offset)
                item["id"] = f"{item['phone']}|{item['expiry_date']}|{offset}"
                results.append(item)

        # newest opening first, unsent before sent
        results.sort(key=lambda r: (r["already_sent"], r.get("opendate", "")), reverse=False)

        self.results = results
        summary["targets"] = len(results)
        summary["sent"] = sum(1 for r in results if r["already_sent"])
        summary["pending"] = sum(1 for r in results if not r["already_sent"])

        db.set_meta("last_run_at", _now())
        self._emit_results()
        self._state(STATE_IDLE)
        return summary


def _now() -> str:
    return _dt.datetime.now().isoformat(timespec="seconds")


def _entry_from_row(row: dict[str, Any], offset: int, expiry: _dt.date) -> dict[str, Any]:
    return {
        "phone": str(row.get("openphone", "")).strip(),
        "customer": str(row.get("customer", "")).strip(),
        "opendate": str(row.get("opendate", "")).strip(),
        "expiry_date": expiry.isoformat(),
        "milestone_offset": int(offset),
        "telecom": str(row.get("telecomx", "") or row.get("telecom", "")).strip(),
        "agency": str(row.get("agencytitle", "")).strip(),
        "openhow": str(row.get("openhowx", "")).strip(),      # 종류 (기변/번호이동/유심MNP…)
        "plan": str(row.get("plan", "")).strip(),
        "model": str(row.get("model", "")).strip(),
        "staff": str(row.get("membername", "") or row.get("username", "")).strip(),
    }
