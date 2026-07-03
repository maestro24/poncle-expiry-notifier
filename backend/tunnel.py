"""Optional remote access via Cloudflare Quick Tunnel (cloudflared).

When the local LAN path is not usable (PC on Ethernet, phone on LTE / a different
network), this exposes the local phone-link server through a Cloudflare Quick
Tunnel so the phone can reach it from anywhere. Free, no account, no domain.

- The cloudflared binary is downloaded on first use and cached in data_dir.
- `Tunnel.start(port)` spawns `cloudflared tunnel --url http://127.0.0.1:<port>`
  and parses the public `https://<random>.trycloudflare.com` URL from its output.
- The URL is random per run — fine, because the QR is regenerated each session.
- The tunnel is outbound, so no inbound firewall rule is needed, and it adds TLS.

Security note: enabling remote exposes the token-gated endpoints to the public
internet (behind the random URL). Customer data still requires the 128-bit token,
and the traffic is HTTPS to Cloudflare's edge. See the phone-link design spec.
"""
from __future__ import annotations

import re
import subprocess
import threading
import urllib.request
from pathlib import Path
from typing import Optional

from .paths import data_dir

# Official Windows build of cloudflared (amd64).
_DOWNLOAD_URL = (
    "https://github.com/cloudflare/cloudflared/releases/latest/download/"
    "cloudflared-windows-amd64.exe"
)
_MIN_BINARY_BYTES = 5_000_000  # a real cloudflared build is ~40MB
_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

# CreateProcess flags: no console window for the child.
_CREATE_NO_WINDOW = 0x08000000


def binary_path() -> Path:
    return data_dir() / "cloudflared.exe"


def parse_tunnel_url(text: str) -> Optional[str]:
    """Extract the trycloudflare URL from a line of cloudflared output."""
    m = _URL_RE.search(text or "")
    return m.group(0) if m else None


def ensure_binary() -> Path:
    """Return the cached cloudflared path, downloading it on first use."""
    dst = binary_path()
    if dst.exists() and dst.stat().st_size >= _MIN_BINARY_BYTES:
        return dst
    tmp = dst.with_suffix(".part")
    req = urllib.request.Request(_DOWNLOAD_URL, headers={"User-Agent": "PoncleExpiryNotifier"})
    with urllib.request.urlopen(req, timeout=180) as resp, open(tmp, "wb") as f:
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            f.write(chunk)
    if tmp.stat().st_size < _MIN_BINARY_BYTES:
        tmp.unlink(missing_ok=True)
        raise OSError("cloudflared download too small; aborting")
    tmp.replace(dst)
    return dst


class Tunnel:
    """Manages one cloudflared quick tunnel for the local phone-link port."""

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._url: Optional[str] = None
        self._lock = threading.Lock()
        self.error: Optional[str] = None

    def start(self, local_port: int) -> None:
        """Download cloudflared if needed, spawn the tunnel, and read its output
        on a background thread until the public URL appears. Non-blocking on the
        URL: poll `public_url()` / `is_ready()`."""
        if self._proc is not None:
            return
        exe = ensure_binary()
        self._proc = subprocess.Popen(
            [str(exe), "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{local_port}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=_CREATE_NO_WINDOW,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        threading.Thread(target=self._read_output, daemon=True).start()

    def _read_output(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        for line in proc.stdout:
            url = parse_tunnel_url(line)
            if url:
                with self._lock:
                    self._url = url
                # keep draining so the pipe never blocks cloudflared
        # process ended
        with self._lock:
            self._url = None

    def public_url(self) -> Optional[str]:
        with self._lock:
            return self._url

    def is_ready(self) -> bool:
        return self.public_url() is not None

    def stop(self) -> None:
        proc = self._proc
        self._proc = None
        with self._lock:
            self._url = None
        if proc is not None:
            try:
                proc.terminate()
            except Exception:
                pass
