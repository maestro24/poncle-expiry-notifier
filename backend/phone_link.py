"""Local phone link: serve a one-page phone client over the LAN and hand it the
next customer SMS command to open in the phone's Messages app. HTTP short-polling,
stdlib only. Plain HTTP on a trusted LAN by design (see the phone-link spec)."""
from __future__ import annotations

import json as _json
import re as _re
import secrets
import socket
import threading
import time
import urllib.parse
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional


def new_token() -> str:
    return secrets.token_hex(16)


def lan_ip() -> str:
    """Best-guess primary LAN IPv4 (the interface that routes to the internet)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return "127.0.0.1"
    finally:
        s.close()


def build_sms_uri(phone: str, text: str) -> str:
    digits = _re.sub(r"\D", "", phone or "")
    body = urllib.parse.quote(text or "", safe="")
    return f"sms:{digits}?body={body}"


class CommandQueue:
    def __init__(self) -> None:
        self._items: "deque[dict]" = deque()

    def put(self, phone: str, text: str) -> None:
        self._items.append({"phone": phone, "text": text})

    def pop(self) -> Optional[dict]:
        return self._items.popleft() if self._items else None


_HEARTBEAT_WINDOW_SEC = 5.0

_PHONE_PAGE = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>약정만료 알리미 - 폰 연결</title>
<style>
 body{font-family:-apple-system,'Malgun Gothic',sans-serif;margin:0;padding:32px 20px;
      background:#F4F4F5;color:#18181B;text-align:center}
 .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:middle}
 .on{background:#16A34A}.off{background:#DC2626}
 h1{font-size:18px;margin:8px 0 4px}.sub{color:#71717A;font-size:13px}
 .last{margin-top:24px;padding:14px;border:1px solid #E4E4E7;border-radius:12px;background:#fff;
       font-size:13px;color:#52525B;min-height:20px}
</style></head><body>
<h1><span id="dot" class="dot off"></span><span id="stat">연결 중...</span></h1>
<p class="sub">이 화면을 켜 두면 PC에서 보낸 문자가 자동으로 문자앱에 채워집니다.</p>
<div class="last" id="last">대기 중</div>
<script>
 var T="__TOKEN__";
 function setStat(ok){document.getElementById('dot').className='dot '+(ok?'on':'off');
   document.getElementById('stat').textContent=ok?'연결됨':'연결 끊김';}
 function poll(){
   fetch('/pending?token='+T,{cache:'no-store'})
     .then(function(r){return r.json();})
     .then(function(j){setStat(true);
       if(j&&j.phone){
         document.getElementById('last').textContent='전송: '+j.phone;
         location.href='sms:'+j.phone.replace(/\\D/g,'')+'?body='+encodeURIComponent(j.text||'');
       }})
     .catch(function(){setStat(false);})
     .then(function(){setTimeout(poll,1000);});
 }
 poll();
</script></body></html>"""


class PhoneLink:
    def __init__(self) -> None:
        self.token = new_token()
        self.port = 0
        self._ip = "127.0.0.1"
        self._queue = CommandQueue()
        self._server: Optional[ThreadingHTTPServer] = None
        self._last_poll = 0.0
        self._lock = threading.Lock()

    # -- lifecycle ----------------------------------------------------------
    def start(self) -> bool:
        link = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_a):  # silence stdout logging
                pass

            def do_GET(self):
                link._handle_get(self)

        try:
            self._server = ThreadingHTTPServer(("0.0.0.0", 0), Handler)
        except OSError:
            self._server = None
            return False
        self.port = self._server.server_address[1]
        self._ip = lan_ip()
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        return True

    def stop(self) -> None:
        if self._server is not None:
            try:
                self._server.shutdown()
                self._server.server_close()
            except Exception:
                pass
            self._server = None

    # -- public state -------------------------------------------------------
    def queue_message(self, phone: str, text: str) -> None:
        with self._lock:
            self._queue.put(phone, text)

    def is_connected(self) -> bool:
        return (time.time() - self._last_poll) < _HEARTBEAT_WINDOW_SEC

    def connect_url(self) -> Optional[str]:
        if self._server is None:
            return None
        return f"http://{self._ip}:{self.port}/p/{self.token}"

    # -- request handling ---------------------------------------------------
    def _handle_get(self, h: BaseHTTPRequestHandler) -> None:
        parsed = urllib.parse.urlparse(h.path)
        path = parsed.path
        if path == f"/p/{self.token}":
            page = _PHONE_PAGE.replace("__TOKEN__", self.token)
            self._respond(h, 200, "text/html; charset=utf-8", page.encode("utf-8"))
            return
        if path == "/pending":
            qs = urllib.parse.parse_qs(parsed.query)
            if qs.get("token", [""])[0] != self.token:
                self._respond(h, 403, "application/json", b'{"error":"forbidden"}')
                return
            self._last_poll = time.time()
            with self._lock:
                cmd = self._queue.pop()
            body = _json.dumps(cmd or {}, ensure_ascii=False).encode("utf-8")
            self._respond(h, 200, "application/json; charset=utf-8", body)
            return
        self._respond(h, 404, "text/plain", b"not found")

    @staticmethod
    def _respond(h: BaseHTTPRequestHandler, code: int, ctype: str, body: bytes) -> None:
        h.send_response(code)
        h.send_header("Content-Type", ctype)
        h.send_header("Content-Length", str(len(body)))
        h.send_header("Cache-Control", "no-store")
        h.end_headers()
        h.wfile.write(body)
