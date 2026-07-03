"""Daily scheduling on top of the Scanner.

Design decision (per the user): the app runs from the Windows startup folder, so
it launches at logon. On launch it optionally runs one scan immediately, and it
also runs every day at the configured HH:MM in case the PC stays on across days.
Dedup guarantees the extra runs never double-send.
"""
from __future__ import annotations

import datetime as _dt
import threading
from typing import Any

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from . import config as config_mod
from . import db
from .scan import Scanner

_DAILY_JOB_ID = "daily_scan"


class Scheduler:
    def __init__(self, scanner: Scanner) -> None:
        self.scanner = scanner
        self._sched = BackgroundScheduler(daemon=True)
        self._started = False

    def start(self) -> None:
        if self._started:
            return
        cfg = config_mod.load()
        self._schedule_daily(cfg.get("run_time", "09:00"))
        self._sched.start()
        self._started = True
        db.set_meta("next_run_at", self.next_run_iso() or "")
        if cfg.get("run_on_startup", True):
            # Fire shortly after launch so the UI has time to wire up callbacks.
            self._sched.add_job(
                self._run, "date",
                run_date=_dt.datetime.now() + _dt.timedelta(seconds=8),
                id="startup_scan", replace_existing=True,
            )

    def _schedule_daily(self, run_time: str) -> None:
        hour, minute = _parse_hhmm(run_time)
        self._sched.add_job(
            self._run, CronTrigger(hour=hour, minute=minute),
            id=_DAILY_JOB_ID, replace_existing=True, misfire_grace_time=3600,
        )

    def _run(self) -> None:
        self.scanner.run(trigger="scheduled")
        db.set_meta("next_run_at", self.next_run_iso() or "")

    def reschedule(self, run_time: str) -> None:
        if not self._started:
            return
        self._schedule_daily(run_time)
        db.set_meta("next_run_at", self.next_run_iso() or "")

    def next_run_iso(self) -> str | None:
        job = self._sched.get_job(_DAILY_JOB_ID)
        if job and job.next_run_time:
            return job.next_run_time.replace(tzinfo=None).isoformat(timespec="seconds")
        return None

    def shutdown(self) -> None:
        if self._started:
            self._sched.shutdown(wait=False)
            self._started = False


def _parse_hhmm(value: str) -> tuple[int, int]:
    try:
        h, m = value.strip().split(":")
        hour, minute = int(h), int(m)
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return hour, minute
    except (ValueError, AttributeError):
        pass
    return 9, 0
