"""Filesystem locations for user data (config, database, cookies, logs).

All mutable state lives under %LOCALAPPDATA%\\PoncleExpiryNotifier so the app
directory itself can stay read-only (e.g. installed under Program Files).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def data_dir() -> Path:
    """Per-user writable directory for all app state. Created on first access."""
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    d = Path(base) / "PoncleExpiryNotifier"
    d.mkdir(parents=True, exist_ok=True)
    return d


def app_dir() -> Path:
    """Directory holding the bundled resources (frontend/, assets/).

    When frozen by PyInstaller (onefile), resources are unpacked to sys._MEIPASS;
    for a onedir build they sit next to the exe. In dev it's the project root.
    """
    if getattr(sys, "frozen", False):
        base = getattr(sys, "_MEIPASS", None)
        return Path(base) if base else Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def frontend_dir() -> Path:
    return app_dir() / "frontend"


def assets_dir() -> Path:
    return app_dir() / "assets"


CONFIG_PATH = data_dir() / "settings.json"
DB_PATH = data_dir() / "notifier.db"
COOKIES_PATH = data_dir() / "session_cookies.json"
LOG_PATH = data_dir() / "app.log"
