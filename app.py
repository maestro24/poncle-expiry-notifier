"""약정만료 알리미 - entry point + desktop controller.

Wires together the WebView UI (frontend/), the system tray, the daily scheduler,
and the Poncle scraper. Run with:  pythonw app.py  (or python app.py to see logs)
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import webbrowser
from typing import Any

import webview  # pywebview

from backend import config as config_mod
from backend import autostart, db, updater
from backend.api import Api
from backend.paths import assets_dir, frontend_dir
from backend.scan import STATE_IDLE, STATE_SESSION_EXPIRED, Scanner
from backend.scheduler import Scheduler
from backend.session import SessionManager

WINDOW_TITLE = "약정만료 알리미"

# Kept alive for the whole process so the single-instance mutex stays held.
_SINGLE_INSTANCE_HANDLE = None


class App:
    def __init__(self) -> None:
        db.init()
        _ensure_icon()

        self.cfg = config_mod.load()
        self.session_mgr = SessionManager(self.cfg.get("poncle_base_url", "https://m.poncle.co.kr"))
        self.scanner = Scanner(
            self.session_mgr, on_results=self.push_results, on_state=self.push_state
        )
        self.scheduler = Scheduler(self.scanner)

        self.api = Api(self)
        self.window: Any = None
        self.login_window: Any = None
        self._login_polling = False
        self._state = STATE_IDLE
        self._tray_icon: Any = None
        self._quitting = False
        self._maximized = False

    # ------------------------------------------------------------------ UI push
    def _eval(self, expr: str) -> None:
        """Run JS in the main window, swallowing errors when it isn't ready."""
        w = self.window
        if w is None:
            return
        try:
            w.evaluate_js(expr)
        except Exception:
            pass

    def push_results(self, results: list[dict[str, Any]]) -> None:
        from backend.ui_serialize import scanitem_to_ui
        payload = json.dumps([scanitem_to_ui(r) for r in results], ensure_ascii=False)
        self._eval(f"window.__onResults && window.__onResults({payload})")
        self.push_status()

    def mark_result_sent(self, item_id: str | None) -> None:
        """Flip a scan-result row to already-sent after 알림 보내기 succeeds."""
        if not item_id:
            return
        for r in self.scanner.results:
            if r.get("id") == item_id:
                r["already_sent"] = True
                break
        self.push_status()

    def push_state(self, state: str) -> None:
        self._state = state
        self._eval(f"window.__onState && window.__onState({json.dumps(state)})")
        self.push_status()

    def push_status(self) -> None:
        payload = json.dumps(self.status_dict(), ensure_ascii=False)
        self._eval(f"window.__onStatus && window.__onStatus({payload})")

    # ------------------------------------------------------------------ status
    def status_dict(self) -> dict[str, Any]:
        results = self.scanner.results
        sent = sum(1 for r in results if r.get("already_sent"))
        counts = {
            "targets": len(results),
            "sent": sent,
            "pending": len(results) - sent,
        }
        return {
            "state": self._state,
            "last_run_at": db.get_meta("last_run_at"),
            "next_run_at": self.scheduler.next_run_iso() or db.get_meta("next_run_at"),
            "has_session": self.session_mgr.has_cookies(),
            "session_saved_at": self.session_mgr.saved_at,
            "counts": counts,
            "version": _version(),
        }

    # ------------------------------------------------------------------ actions
    def recheck_session(self) -> None:
        ok = self.session_mgr.check()
        self.push_state(STATE_IDLE if ok else STATE_SESSION_EXPIRED)

    def apply_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        old = config_mod.load()
        new = config_mod.update(patch)
        self.cfg = new
        if new.get("run_time") != old.get("run_time"):
            self.scheduler.reschedule(new.get("run_time", "09:00"))
        if new.get("autostart_enabled") != old.get("autostart_enabled"):
            # autostart.apply shells out to PowerShell (can be slow on some PCs);
            # run it off the API thread so the Save button returns immediately.
            threading.Thread(
                target=autostart.apply, args=(bool(new.get("autostart_enabled")),),
                daemon=True,
            ).start()
        self.push_status()
        return new

    def open_poncle_site(self) -> None:
        self.start_login_flow()

    # ------------------------------------------------------------------ login flow
    def start_login_flow(self) -> None:
        """Open a real Poncle window for the employee to log into, then harvest
        the session cookies (Approach A). We never see or type the password."""
        if self.login_window is not None:
            try:
                self.login_window.show()
                return
            except Exception:
                self.login_window = None

        base = self.session_mgr.base_url
        try:
            self.login_window = webview.create_window(
                "폰클 로그인", url=f"{base}/open/mobile",
                width=1180, height=820, min_size=(900, 640),
            )
        except Exception:
            return
        try:
            self.login_window.events.closed += self._on_login_closed
        except Exception:
            pass
        self._login_polling = True
        threading.Thread(target=self._poll_login, daemon=True).start()

    def _on_login_closed(self) -> None:
        self.login_window = None
        self._login_polling = False

    def _poll_login(self) -> None:
        deadline = time.time() + 15 * 60  # give the employee up to 15 minutes
        while self._login_polling and time.time() < deadline:
            time.sleep(2.5)
            win = self.login_window
            if win is None:
                break
            cookies = _extract_cookies(win)
            if cookies and self.session_mgr.check_cookies(cookies):
                self.session_mgr.set_cookies(cookies)
                self._login_polling = False
                self.push_state(STATE_IDLE)
                try:
                    if self.login_window is not None:
                        self.login_window.destroy()
                except Exception:
                    pass
                self.login_window = None
                # Session is live now: run a scan so the list fills immediately.
                threading.Thread(
                    target=self.scanner.run, kwargs={"trigger": "post-login"}, daemon=True
                ).start()
                return

    # ------------------------------------------------------------------ window/tray
    def window_minimize(self) -> None:
        try:
            self.window.minimize()
        except Exception:
            pass

    def window_toggle_maximize(self) -> None:
        try:
            if self._maximized:
                self.window.restore()
            else:
                self.window.maximize()
            self._maximized = not self._maximized
        except Exception:
            pass

    def hide_to_tray(self) -> None:
        try:
            self.window.hide()
        except Exception:
            pass

    def show_window(self) -> None:
        try:
            self.window.show()
            self.window.restore()
        except Exception:
            pass

    def quit(self) -> None:
        if self._quitting:
            return
        self._quitting = True
        # Stop any background thread from pushing JS into a window being torn down.
        self.window = None
        try:
            self.scheduler.shutdown()
        except Exception:
            pass
        try:
            if self._tray_icon is not None:
                self._tray_icon.stop()
        except Exception:
            pass
        try:
            for w in list(webview.windows):
                w.destroy()
        except Exception:
            pass

    # ------------------------------------------------------------------ startup
    def on_start(self) -> None:
        """Called by pywebview once the GUI is up and the window exists."""
        try:
            self.scheduler.start()
        except Exception:
            pass
        try:
            self._start_tray()
        except Exception:
            pass
        threading.Thread(target=self._initial_probe, daemon=True).start()
        threading.Thread(target=self._check_update_startup, daemon=True).start()

    def _initial_probe(self) -> None:
        time.sleep(0.5)
        ok = self.session_mgr.check() if self.session_mgr.has_cookies() else False
        self.push_state(STATE_IDLE if ok else STATE_SESSION_EXPIRED)
        self.push_status()

    # ------------------------------------------------------------------ updates
    def _check_update_startup(self) -> None:
        """Background: if a newer release exists, prompt the user in the UI."""
        if not updater.can_update():
            return
        if not config_mod.load().get("auto_check_updates", True):
            return
        time.sleep(3.0)  # let the first paint + bootstrap settle
        try:
            info = updater.check()
        except Exception:
            return
        if info and info.get("available"):
            self._push_update(info)

    def _push_update(self, info: dict[str, Any]) -> None:
        self._eval(f"window.__onUpdate && window.__onUpdate({json.dumps(info, ensure_ascii=False)})")

    def check_update_now(self) -> dict[str, Any]:
        """Manual check (from Settings). Returns info even when already up to date."""
        info = updater.check()
        if not info:
            return {"status": "error"}
        return {"status": "ok", **info}

    def apply_update(self) -> None:
        """Download + stage the swap on a thread, then quit so the helper runs."""
        def _run() -> None:
            info = updater.check()
            if not info or not info.get("available") or not info.get("url"):
                self._eval("window.__onUpdateError && window.__onUpdateError('업데이트 정보를 찾을 수 없습니다.')")
                return
            try:
                updater.download_and_stage(info["url"])
            except Exception as e:
                err = json.dumps("다운로드 실패: " + str(e), ensure_ascii=False)
                self._eval(f"window.__onUpdateError && window.__onUpdateError({err})")
                return
            time.sleep(0.5)  # let the helper begin its retry loop before we release the exe lock
            self.quit()

        threading.Thread(target=_run, daemon=True).start()

    def _start_tray(self) -> None:
        try:
            import pystray
            from PIL import Image
        except Exception:
            return

        image = Image.open(assets_dir() / "icon.png")

        def _show(icon, item):
            self.show_window()

        def _scan(icon, item):
            if not self.scanner.is_running():
                threading.Thread(target=self.scanner.run,
                                 kwargs={"trigger": "tray"}, daemon=True).start()

        def _quit(icon, item):
            self.quit()

        menu = pystray.Menu(
            pystray.MenuItem("창 열기", _show, default=True),
            pystray.MenuItem("지금 스캔", _scan),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("종료", _quit),
        )
        self._tray_icon = pystray.Icon("poncle_expiry", image, WINDOW_TITLE, menu)
        threading.Thread(target=self._tray_icon.run, daemon=True).start()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _version() -> str:
    from backend import __version__
    return __version__


def _extract_cookies(window: Any) -> dict[str, str]:
    """Read cookies from a pywebview window across pywebview versions.

    Newer pywebview returns a list of http.cookies.SimpleCookie; some return
    http.cookiejar.Cookie objects. Handle both.
    """
    try:
        raw = window.get_cookies()
    except Exception:
        return {}
    out: dict[str, str] = {}
    for c in raw or []:
        try:
            if hasattr(c, "items"):          # SimpleCookie -> name: Morsel
                for name, morsel in c.items():
                    val = getattr(morsel, "value", None)
                    if val:
                        out[name] = val
            elif hasattr(c, "name"):         # cookiejar.Cookie
                if c.value:
                    out[c.name] = c.value
        except Exception:
            continue
    return out


def _ensure_icon() -> None:
    """Generate a simple shield tray/app icon (png + ico) if missing."""
    png = assets_dir() / "icon.png"
    ico = assets_dir() / "icon.ico"
    if png.exists() and ico.exists():
        return
    try:
        from PIL import Image, ImageDraw
    except Exception:
        return
    assets_dir().mkdir(parents=True, exist_ok=True)
    size = 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Rounded dark square
    d.rounded_rectangle([16, 16, size - 16, size - 16], radius=52, fill=(24, 24, 27, 255))
    # Shield
    cx = size // 2
    shield = [(cx, 60), (196, 92), (196, 150),
              (cx, 208), (60, 150), (60, 92)]
    d.polygon(shield, fill=(34, 197, 94, 255))
    # Check mark
    d.line([(108, 138), (128, 160), (162, 110)], fill=(255, 255, 255, 255), width=16, joint="curve")
    img.save(png)
    img.save(ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def _acquire_single_instance() -> bool:
    """Return True if we are the only instance; False if another already holds the
    lock (the caller should exit). A named Windows mutex enforces one running copy,
    which also keeps the exe under a single lock so the update swap can complete."""
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        global _SINGLE_INSTANCE_HANDLE
        _SINGLE_INSTANCE_HANDLE = kernel32.CreateMutexW(None, False, "PoncleExpiryNotifier_singleton")
        ERROR_ALREADY_EXISTS = 183
        return kernel32.GetLastError() != ERROR_ALREADY_EXISTS
    except Exception:
        return True  # never block startup on a guard failure


def _fatal_message(text: str) -> None:
    """Show a native message box (no WebView needed) and also print it."""
    print(text)
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, text, WINDOW_TITLE, 0x10)  # MB_ICONERROR
    except Exception:
        pass


def _selftest() -> int:
    """Boot everything except the GUI event loop; used to validate the frozen exe
    on a machine without a display. Writes a marker and returns an exit code."""
    marker = os.path.join(os.environ.get("TEMP", "."), "poncle_selftest.txt")
    try:
        app = App()
        _ = app.status_dict()
        webview.create_window(WINDOW_TITLE, url=str(frontend_dir() / "index.html"),
                              js_api=app.api, frameless=True)
        with open(marker, "w", encoding="utf-8") as f:
            f.write("SELFTEST_OK")
        return 0
    except Exception as e:
        try:
            with open(marker, "w", encoding="utf-8") as f:
                f.write(f"SELFTEST_FAIL: {e}")
        except OSError:
            pass
        return 1


def main() -> None:
    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())

    # Packaged build: install-on-first-run (copy to Programs + desktop icon),
    # then relaunch from the installed location.
    from backend import installer
    if installer.ensure_installed():
        return

    # Only one running copy: a second launch exits immediately. This also protects
    # the update swap, which needs the exe held by a single process to unlock.
    if not _acquire_single_instance():
        return

    app = App()
    index = frontend_dir() / "index.html"
    app.window = webview.create_window(
        WINDOW_TITLE,
        url=str(index),
        js_api=app.api,
        width=1240, height=880, min_size=(1040, 720),
        frameless=True, easy_drag=False,
        background_color="#F4F4F5",
    )
    try:
        # http_server=True serves the local frontend over pywebview's internal HTTP
        # server instead of file://, which fixes the JS<->Python bridge not being
        # injected under the EdgeChromium (WebView2) backend in packaged builds.
        webview.start(app.on_start, gui="edgechromium", http_server=True, debug=False)
    except Exception as e:
        # The most common cause on a bare Windows image is a missing WebView2
        # runtime. Fail loudly with guidance instead of a silent dead process.
        _fatal_message(
            "창을 띄우지 못했습니다.\n\n"
            "Microsoft Edge WebView2 런타임이 설치되어 있는지 확인해 주세요.\n"
            "(검색: 'Microsoft Edge WebView2 Runtime' 설치)\n\n"
            f"오류: {e}"
        )
    # webview.start blocks until all windows close; ensure clean shutdown.
    app.quit()


if __name__ == "__main__":
    main()
