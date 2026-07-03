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

    # Build from the committed .spec (NOT raw CLI flags): the spec filters out the
    # api-ms-win-core-* OS API-set stubs that a Windows Server build host bundles
    # and that break python312.dll loading on client Windows. See the spec header.
    spec = f"{APP_NAME}.spec"
    print("Building from spec:", spec)
    PyInstaller.__main__.run(["--noconfirm", "--clean", spec])
    print(f"\nBuilt: dist/{APP_NAME}.exe")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
