"""Self-update via GitHub Releases (public repo, anonymous download).

Checks the latest published release, compares its version with the running build,
downloads the new onefile exe and swaps it into the installed location using a
detached helper batch that waits for this process to exit first.

Why no token: release assets on a PUBLIC repo are anonymously downloadable, so
the shipped exe never has to embed a credential.

Why no SmartScreen on update: files written by Python carry no Mark-of-the-Web
(that tag is only attached by browsers/mail clients). The relaunched exe is
therefore trusted. Only the very first hand-delivered install can raise a prompt.
"""
from __future__ import annotations

import json
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Any, Optional

from . import __version__
from .installer import APP_NAME, installed_exe, is_frozen
from .paths import data_dir

# Public repo that hosts the release assets (version.json is the release itself).
GITHUB_REPO = "maestro24/poncle-expiry-notifier"
_API_LATEST = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
_CHECK_TIMEOUT = 15
_DOWNLOAD_TIMEOUT = 180
_MIN_EXE_BYTES = 1_000_000  # a real onefile build is ~20MB; guard against a truncated/HTML body

# CreateProcess flags: run the helper fully detached with no console window.
_DETACHED_PROCESS = 0x00000008
_CREATE_NO_WINDOW = 0x08000000


def can_update() -> bool:
    """Self-update only applies to the installed, frozen copy (dev runs are a no-op)."""
    if not is_frozen():
        return False
    try:
        return Path(sys.executable).resolve() == installed_exe().resolve()
    except OSError:
        return False


def _parse(v: str) -> tuple[int, ...]:
    """Loose semver parse: 'v1.3.0', '1.3.0-beta+build' -> (1, 3, 0)."""
    core = (v or "").strip().lstrip("vV").split("+")[0].split("-")[0]
    out: list[int] = []
    for part in core.split("."):
        try:
            out.append(int(part))
        except ValueError:
            out.append(0)
    return tuple(out) or (0,)


def is_newer(remote: str, local: str) -> bool:
    return _parse(remote) > _parse(local)


def check() -> Optional[dict[str, Any]]:
    """Query the latest release. Returns update info or None on any failure.

    Shape: {available, version, current, notes, url}  (url = the .exe asset).
    'available' is True only when a downloadable exe exists AND it is newer.
    """
    try:
        req = urllib.request.Request(
            _API_LATEST,
            headers={"Accept": "application/vnd.github+json", "User-Agent": APP_NAME},
        )
        with urllib.request.urlopen(req, timeout=_CHECK_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None

    tag = data.get("tag_name") or data.get("name") or ""
    version = tag.strip().lstrip("vV")
    if not version:
        return None

    exe_url = None
    for asset in data.get("assets") or []:
        if (asset.get("name") or "").lower().endswith(".exe"):
            exe_url = asset.get("browser_download_url")
            break

    return {
        "available": bool(exe_url) and is_newer(version, __version__),
        "version": version,
        "current": __version__,
        "notes": (data.get("body") or "").strip(),
        "url": exe_url,
    }


def _download(url: str) -> Path:
    updir = data_dir() / "update"
    updir.mkdir(parents=True, exist_ok=True)
    dst = updir / f"{APP_NAME}.new.exe"
    req = urllib.request.Request(url, headers={"User-Agent": APP_NAME})
    with urllib.request.urlopen(req, timeout=_DOWNLOAD_TIMEOUT) as resp, open(dst, "wb") as f:
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            f.write(chunk)
    if dst.stat().st_size < _MIN_EXE_BYTES:
        dst.unlink(missing_ok=True)
        raise OSError("downloaded file too small; aborting swap")
    return dst


def _spawn_swap(new_exe: Path, target: Path) -> None:
    """Write and launch a detached helper that waits for `target` to unlock (this
    process exiting), moves the new build over it, relaunches, then self-deletes."""
    bat = data_dir() / "update" / "apply_update.bat"
    script = (
        "@echo off\r\n"
        "setlocal\r\n"
        ":retry\r\n"
        f'move /y "{new_exe}" "{target}" >nul 2>&1\r\n'
        "if errorlevel 1 (\r\n"
        "  ping 127.0.0.1 -n 2 >nul\r\n"
        "  goto retry\r\n"
        ")\r\n"
        f'start "" "{target}"\r\n'
        'del "%~f0"\r\n'
    )
    bat.write_text(script, encoding="ascii")
    subprocess.Popen(
        ["cmd", "/c", str(bat)],
        creationflags=_DETACHED_PROCESS | _CREATE_NO_WINDOW,
        close_fds=True,
    )


def download_and_stage(url: str) -> Path:
    """Download the new exe and launch the swap helper. Returns the staged path.

    The helper is already looping (it can't overwrite the running exe yet); the
    caller MUST quit the app so the helper's next `move` succeeds and relaunches."""
    new_exe = _download(url)
    _spawn_swap(new_exe, installed_exe().resolve())
    return new_exe
