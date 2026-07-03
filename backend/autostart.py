"""Register / unregister the app in the Windows Startup folder.

Creates a .lnk that launches pythonw.exe app.py (pythonw = no console window).
Uses PowerShell's WScript.Shell to author the shortcut so no extra Python
dependency (pywin32) is required.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from .paths import app_dir, assets_dir

_SHORTCUT_NAME = "약정만료 알리미.lnk"


def _startup_dir() -> Path:
    appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def _shortcut_path() -> Path:
    return _startup_dir() / _SHORTCUT_NAME


def _pythonw() -> str:
    """Prefer pythonw.exe (no console) next to the running interpreter."""
    exe = Path(sys.executable)
    candidate = exe.with_name("pythonw.exe")
    return str(candidate if candidate.exists() else exe)


def is_enabled() -> bool:
    return _shortcut_path().exists()


def enable() -> bool:
    lnk = str(_shortcut_path())
    _startup_dir().mkdir(parents=True, exist_ok=True)

    if getattr(sys, "frozen", False):
        # Packaged build: launch the installed exe directly, no arguments.
        from .installer import installed_exe
        exe = installed_exe()
        target = str(exe if exe.exists() else Path(sys.executable))
        arguments = ""
        workdir = str(Path(target).parent)
        icon_line = f"$s.IconLocation = '{_ps_quote(target)},0'; "
    else:
        # Dev build: pythonw app.py
        target = _pythonw()
        script = str(app_dir() / "app.py")
        arguments = f'"{script}"'
        workdir = str(app_dir())
        icon = assets_dir() / "icon.ico"
        icon_line = f"$s.IconLocation = '{_ps_quote(str(icon))}'; " if icon.exists() else ""

    ps = (
        "$ws = New-Object -ComObject WScript.Shell; "
        f"$s = $ws.CreateShortcut('{_ps_quote(lnk)}'); "
        f"$s.TargetPath = '{_ps_quote(target)}'; "
        f"$s.Arguments = '{_ps_quote(arguments)}'; "
        f"$s.WorkingDirectory = '{_ps_quote(workdir)}'; "
        + icon_line
        + "$s.WindowStyle = 7; "   # minimized
        "$s.Save()"
    )
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            check=True, capture_output=True, timeout=30,
        )
        return is_enabled()
    except (subprocess.SubprocessError, OSError):
        return False


def disable() -> bool:
    try:
        _shortcut_path().unlink(missing_ok=True)
        return True
    except OSError:
        return False


def apply(enabled: bool) -> bool:
    """Make the on-disk state match `enabled`; return the resulting state."""
    if enabled:
        if not is_enabled():
            enable()
    else:
        if is_enabled():
            disable()
    return is_enabled()


def _ps_quote(value: str) -> str:
    # Single-quoted PowerShell string: escape embedded single quotes.
    return value.replace("'", "''")
