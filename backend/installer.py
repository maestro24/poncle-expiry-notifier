"""First-run self-installer for the packaged (PyInstaller) build.

Goal: the employee downloads ONE file (약정만료 알리미.exe) and double-clicks it.
No Python, no dependencies, no admin rights. On first launch the exe:
  1) copies itself into %LOCALAPPDATA%\\Programs\\약정만료 알리미\\
  2) creates a Desktop shortcut and a Start-Menu shortcut
  3) relaunches from the installed location (so the running copy is the stable one)

Subsequent launches (from the desktop icon) detect they are already the installed
copy, just make sure the shortcuts exist, and go straight to the GUI.

Only active when frozen; a normal `python app.py` dev run is a no-op.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

APP_NAME = "약정만료 알리미"


def is_frozen() -> bool:
    return getattr(sys, "frozen", False)


def install_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return Path(base) / "Programs" / APP_NAME


def installed_exe() -> Path:
    return install_dir() / f"{APP_NAME}.exe"


def ensure_installed() -> bool:
    """Install-on-first-run. Returns True if a new (installed) process was
    launched and THIS process should exit; False to continue into the GUI."""
    if not is_frozen():
        return False

    current = Path(sys.executable).resolve()
    target = installed_exe().resolve()

    if current == target:
        # We are the installed copy: just keep the shortcuts fresh.
        _make_shortcuts(target)
        return False

    # Fresh copy: install into LocalAppData\Programs, then relaunch from there.
    try:
        install_dir().mkdir(parents=True, exist_ok=True)
        shutil.copy2(current, target)
    except OSError:
        # Could not install (locked/permission). Fall back to running in place
        # and pointing the shortcut at wherever we are.
        _make_shortcuts(current)
        return False

    _make_shortcuts(target)
    try:
        subprocess.Popen([str(target)], cwd=str(target.parent), close_fds=True)
        return True
    except OSError:
        return False


def _make_shortcuts(exe: Path) -> None:
    """Create Desktop + Start-Menu shortcuts to `exe` (OneDrive-safe folders)."""
    exe_q = _ps_quote(str(exe))
    workdir_q = _ps_quote(str(exe.parent))
    name_q = _ps_quote(APP_NAME)
    ps = f"""
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
foreach ($dir in @($desktop, $programs)) {{
  if (-not (Test-Path $dir)) {{ New-Item -ItemType Directory -Path $dir -Force | Out-Null }}
  $lnk = Join-Path $dir '{name_q}.lnk'
  $s = $ws.CreateShortcut($lnk)
  $s.TargetPath = '{exe_q}'
  $s.WorkingDirectory = '{workdir_q}'
  $s.IconLocation = '{exe_q},0'
  $s.Save()
}}
"""
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            check=False, capture_output=True, timeout=30,
        )
    except (subprocess.SubprocessError, OSError):
        pass


def _ps_quote(value: str) -> str:
    return value.replace("'", "''")
