"""JS API exposed to the WebView frontend as `window.pywebview.api.*`.

Thin adapter: validates/serializes and delegates to the App controller. Every
method returns plain JSON-able data. Long-running work (scan) runs on a
background thread so the UI never blocks.
"""
from __future__ import annotations

import threading
from typing import Any

from . import config as config_mod
from . import db
from . import sender
from .ui_serialize import history_to_ui, scanitem_to_ui


class Api:
    def __init__(self, app: Any) -> None:
        self._app = app

    # -- bootstrap / status -------------------------------------------------
    def get_bootstrap(self) -> dict[str, Any]:
        return {
            "status": self._app.status_dict(),
            "settings": config_mod.load(),
            "results": [scanitem_to_ui(r) for r in self._app.scanner.results],
        }

    def get_status(self) -> dict[str, Any]:
        return self._app.status_dict()

    def get_scan_results(self) -> list[dict[str, Any]]:
        return [scanitem_to_ui(r) for r in self._app.scanner.results]

    # -- actions ------------------------------------------------------------
    def run_scan_now(self) -> dict[str, Any]:
        if self._app.scanner.is_running():
            return {"status": "busy"}
        threading.Thread(
            target=self._app.scanner.run, kwargs={"trigger": "manual"}, daemon=True
        ).start()
        return {"status": "started"}

    def send_alert(self, item: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(item, dict):
            return {"status": "error", "error": "invalid item"}
        res = sender.send_alert(item, config_mod.load(), self._app.phone_link)
        # Reflect the new sent state back into the in-memory scan results.
        if res.get("status") in ("sent", "already"):
            self._app.mark_result_sent(item.get("id"))
        return res

    def recheck_session(self) -> dict[str, Any]:
        threading.Thread(target=self._app.recheck_session, daemon=True).start()
        return {"status": "checking"}

    def open_login(self) -> dict[str, Any]:
        self._app.start_login_flow()
        return {"status": "opened"}

    # -- settings -----------------------------------------------------------
    def get_settings(self) -> dict[str, Any]:
        return config_mod.load()

    def save_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(patch, dict):
            return {"status": "error", "error": "invalid payload"}
        new_cfg = self._app.apply_settings(patch)
        return {"status": "ok", "settings": new_cfg}

    # -- updates ------------------------------------------------------------
    def check_update(self) -> dict[str, Any]:
        return self._app.check_update_now()

    def apply_update(self) -> dict[str, Any]:
        self._app.apply_update()
        return {"status": "downloading"}

    # -- phone link -----------------------------------------------------------
    def get_phone_status(self) -> dict[str, Any]:
        pl = self._app.phone_link
        return {
            "available": pl.connect_url() is not None,
            "connected": pl.is_connected(),
            "qr": pl.qr_data_url(),
        }

    # -- history ------------------------------------------------------------
    def get_history(self, query: str = "", start: str = "", end: str = "") -> list[dict[str, Any]]:
        rows = db.search_history(query=query or "", start=start or "", end=end or "", limit=1000)
        return [history_to_ui(r) for r in rows]

    # -- window / lifecycle -------------------------------------------------
    def window_minimize(self) -> None:
        self._app.window_minimize()

    def window_toggle_maximize(self) -> None:
        self._app.window_toggle_maximize()

    def window_hide(self) -> None:
        self._app.hide_to_tray()

    def app_quit(self) -> None:
        self._app.quit()
