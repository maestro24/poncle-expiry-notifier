"""Build a single self-contained Windows exe with PyInstaller.

Output: dist/약정만료 알리미.exe  (no Python needed on the target PC).

Usage:
    pip install pyinstaller
    python build.py
"""
from __future__ import annotations

import os
import sys

APP_NAME = "약정만료 알리미"


def main() -> int:
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    # Make sure the icon exists before PyInstaller embeds it.
    sys.path.insert(0, os.getcwd())
    from app import _ensure_icon
    _ensure_icon()

    import PyInstaller.__main__

    sep = ";" if os.name == "nt" else ":"
    args = [
        "--noconfirm", "--clean",
        "--onefile",           # one distributable .exe
        "--windowed",          # no console window (GUI app)
        f"--name={APP_NAME}",
        f"--icon=assets/icon.ico",
        f"--add-data=frontend{sep}frontend",
        f"--add-data=assets{sep}assets",
        # pywebview (+ its Edge WebView2 backend), tray, toasts: pull everything.
        "--collect-all=webview",
        "--collect-all=pystray",
        "--collect-all=windows_toasts",
        "--collect-all=winsdk",
        "--collect-submodules=apscheduler",
        "--hidden-import=clr_loader",
        "app.py",
    ]
    print("PyInstaller args:", " ".join(args))
    PyInstaller.__main__.run(args)
    print(f"\nBuilt: dist/{APP_NAME}.exe")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
