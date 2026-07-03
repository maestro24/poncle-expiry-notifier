# Phone Link (QR + HTTP polling) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send the customer message from the owner's own phone: the PC app hosts a tiny local web server, the phone connects once by scanning a QR, and each "알림 보내기" opens the phone's SMS app pre-filled.

**Architecture:** A new `backend/phone_link.py` runs a stdlib `ThreadingHTTPServer` on a background thread bound to an auto-assigned free port. It serves a one-page phone client and a `/pending` poll endpoint gated by a session token. `sender.send_alert` queues a rendered message when `deliver_alerts` is on and the phone is connected; the phone polls, receives it, and opens `sms:<num>?body=<text>`.

**Tech Stack:** Python stdlib (`http.server`, `socket`, `secrets`, `threading`, `time`), `qrcode` (new dep, uses existing Pillow), existing pywebview frontend.

## Global Constraints

- Python 3.10+ (tested 3.12); Windows desktop app, frozen with PyInstaller via the committed `약정만료 알리미.spec`.
- App data dir helpers: `backend/paths.py` (`data_dir()`, `frontend_dir()`). Do not read the user's real data in tests — `tests/__init__.py` redirects `LOCALAPPDATA` to a temp dir.
- Tests run with: `.\.venv\Scripts\python.exe -m unittest discover -s tests -t . -p "test_*.py"` (the `-t .` package mode matters — see `tests/__init__.py`).
- Hono/Next patterns do NOT apply here; this is a Python + pywebview app.
- Never log customer phone/name at INFO. Plain HTTP is intentional (LAN-only, trusted WiFi) per the design spec.
- Commit messages: Conventional Commits (`feat`/`fix`/`test`/`docs`, scope optional).

---

### Task 1: phone_link helpers (token, LAN IP, free port, command queue)

**Files:**
- Create: `backend/phone_link.py`
- Test: `tests/test_phone_link.py`

**Interfaces:**
- Produces:
  - `new_token() -> str` — 32 hex chars.
  - `lan_ip() -> str` — best-guess LAN IPv4.
  - `build_sms_uri(phone: str, text: str) -> str` — `"sms:<digits>?body=<url-encoded>"`.
  - `class CommandQueue` with `put(phone: str, text: str) -> None` and `pop() -> dict | None` (FIFO, returns `{"phone":..., "text":...}` or `None`).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_phone_link.py
import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import phone_link as pl


class TestHelpers(unittest.TestCase):
    def test_token_is_32_hex(self):
        t = pl.new_token()
        self.assertEqual(len(t), 32)
        int(t, 16)  # raises if not hex
        self.assertNotEqual(t, pl.new_token())

    def test_sms_uri_encodes_body_and_strips_phone(self):
        uri = pl.build_sms_uri("010-1234-5678", "안녕 & 반가워")
        self.assertTrue(uri.startswith("sms:01012345678?body="))
        self.assertIn("%26", uri)      # & encoded
        self.assertNotIn(" ", uri)     # space encoded

    def test_lan_ip_returns_ipv4(self):
        ip = pl.lan_ip()
        parts = ip.split(".")
        self.assertEqual(len(parts), 4)
        self.assertTrue(all(p.isdigit() for p in parts))


class TestQueue(unittest.TestCase):
    def test_fifo_and_empty(self):
        q = pl.CommandQueue()
        self.assertIsNone(q.pop())
        q.put("01011112222", "first")
        q.put("01033334444", "second")
        self.assertEqual(q.pop(), {"phone": "01011112222", "text": "first"})
        self.assertEqual(q.pop(), {"phone": "01033334444", "text": "second"})
        self.assertIsNone(q.pop())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe -m unittest tests.test_phone_link -v`
Expected: FAIL (`ModuleNotFoundError: backend.phone_link`).

- [ ] **Step 3: Write minimal implementation**

```python
# backend/phone_link.py
"""Local phone link: serve a one-page phone client over the LAN and hand it the
next customer SMS command to open in the phone's Messages app. HTTP short-polling,
stdlib only. Plain HTTP on a trusted LAN by design (see the phone-link spec)."""
from __future__ import annotations

import re as _re
import secrets
import socket
import urllib.parse
from collections import deque
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.\.venv\Scripts\python.exe -m unittest tests.test_phone_link -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/phone_link.py tests/test_phone_link.py
git commit -m "feat(phone): token/LAN-IP/sms-uri/queue helpers"
```

---

### Task 2: PhoneLink server (serve page + /pending, start/stop, is_connected)

**Files:**
- Modify: `backend/phone_link.py`
- Test: `tests/test_phone_link.py`

**Interfaces:**
- Produces `class PhoneLink`:
  - `start() -> bool` — bind + serve on a bg thread; `True` if available, `False` if bind failed.
  - `stop() -> None`
  - `queue_message(phone: str, text: str) -> None`
  - `is_connected() -> bool` — a `/pending` poll arrived within the last 5s.
  - `connect_url() -> str | None` — `http://<ip>:<port>/p/<token>` or `None` if unavailable.
  - `port` (int, 0 if not started), `token` (str).
- Endpoints: `GET /p/<token>` → phone HTML (Task 3 fills the body; for now a placeholder page string is fine); `GET /pending?token=<token>` → JSON `{}` or `{"phone","text"}`, and records the heartbeat.

- [ ] **Step 1: Write the failing test**

```python
# add to tests/test_phone_link.py
import json, time, urllib.request

class TestServer(unittest.TestCase):
    def setUp(self):
        self.link = pl.PhoneLink()
        self.assertTrue(self.link.start())
        self.base = f"http://127.0.0.1:{self.link.port}"

    def tearDown(self):
        self.link.stop()

    def _get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=3) as r:
            return r.status, r.read().decode()

    def test_pending_empty_then_queued(self):
        tok = self.link.token
        st, body = self._get(f"/pending?token={tok}")
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(body), {})
        self.link.queue_message("010-1234-5678", "hi")
        _, body2 = self._get(f"/pending?token={tok}")
        self.assertEqual(json.loads(body2), {"phone": "010-1234-5678", "text": "hi"})
        # popped: next poll is empty again
        _, body3 = self._get(f"/pending?token={tok}")
        self.assertEqual(json.loads(body3), {})

    def test_pending_bad_token_is_403(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self._get("/pending?token=nope")
        self.assertEqual(cm.exception.code, 403)

    def test_is_connected_tracks_poll(self):
        self.assertFalse(self.link.is_connected())
        self._get(f"/pending?token={self.link.token}")
        self.assertTrue(self.link.is_connected())

    def test_connect_url_shape(self):
        url = self.link.connect_url()
        self.assertRegex(url, r"^http://[\d.]+:\d+/p/[0-9a-f]{32}$")
```

Add `import urllib.error` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe -m unittest tests.test_phone_link.TestServer -v`
Expected: FAIL (`AttributeError: module ... has no attribute 'PhoneLink'`).

- [ ] **Step 3: Write minimal implementation**

Append to `backend/phone_link.py`:

```python
import json as _json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_HEARTBEAT_WINDOW_SEC = 5.0

# Filled in Task 3; a valid page so the server works standalone until then.
_PHONE_PAGE = "<!doctype html><meta charset=utf-8><title>폰 연결</title><body>연결됨</body>"


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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.\.venv\Scripts\python.exe -m unittest tests.test_phone_link.TestServer -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/phone_link.py tests/test_phone_link.py
git commit -m "feat(phone): local HTTP server with /pending poll + heartbeat"
```

---

### Task 3: Phone page (HTML/JS: poll + open sms + status)

**Files:**
- Modify: `backend/phone_link.py` (replace `_PHONE_PAGE`)
- Test: `tests/test_phone_link.py`

**Interfaces:**
- Consumes: `GET /p/<token>` from Task 2. The page's `__TOKEN__` placeholder is replaced with the real token by `_handle_get`.
- Produces: served HTML containing the token and the `sms:` navigation logic.

- [ ] **Step 1: Write the failing test**

```python
# add to tests/test_phone_link.py (inside TestServer)
    def test_phone_page_has_token_and_poll(self):
        st, body = self._get(f"/p/{self.link.token}")
        self.assertEqual(st, 200)
        self.assertIn(self.link.token, body)     # token injected
        self.assertIn("/pending?token=", body)   # polls the endpoint
        self.assertIn("sms:", body)              # opens the SMS app
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe -m unittest tests.test_phone_link.TestServer.test_phone_page_has_token_and_poll -v`
Expected: FAIL (`sms:` / `/pending?token=` not in the placeholder page).

- [ ] **Step 3: Write minimal implementation**

Replace `_PHONE_PAGE` in `backend/phone_link.py`:

```python
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
```

Note: the server already substitutes `__TOKEN__`; the `sms:` here is a redundant client-side build (the server sends a plain phone/text, the page constructs the URI). Keep the digit-strip (`replace(/\\D/g,'')`) so formatting like `010-1234-5678` still works.

- [ ] **Step 4: Run test to verify it passes**

Run: `.\.venv\Scripts\python.exe -m unittest tests.test_phone_link.TestServer -v`
Expected: PASS (all TestServer tests).

- [ ] **Step 5: Commit**

```bash
git add backend/phone_link.py tests/test_phone_link.py
git commit -m "feat(phone): phone client page (poll + open sms + status)"
```

---

### Task 4: QR data URL (add qrcode dependency)

**Files:**
- Modify: `backend/phone_link.py` (add `qr_data_url`)
- Modify: `requirements.txt`
- Modify: `약정만료 알리미.spec`
- Test: `tests/test_phone_link.py`

**Interfaces:**
- Produces `PhoneLink.qr_data_url() -> str | None` — `data:image/png;base64,...` of `connect_url()`, or `None` if unavailable.

- [ ] **Step 1: Install the dependency**

Run: `.\.venv\Scripts\python.exe -m pip install qrcode==7.4.2`
Then add to `requirements.txt`:
```
qrcode==7.4.2          # QR for phone-link pairing (uses Pillow, already present)
```

- [ ] **Step 2: Write the failing test**

```python
# add to tests/test_phone_link.py (inside TestServer)
    def test_qr_data_url(self):
        d = self.link.qr_data_url()
        self.assertTrue(d.startswith("data:image/png;base64,"))
        self.assertGreater(len(d), 200)
```

- [ ] **Step 3: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe -m unittest tests.test_phone_link.TestServer.test_qr_data_url -v`
Expected: FAIL (`AttributeError: 'PhoneLink' object has no attribute 'qr_data_url'`).

- [ ] **Step 4: Write minimal implementation**

Add to `PhoneLink` in `backend/phone_link.py`:

```python
    def qr_data_url(self) -> Optional[str]:
        url = self.connect_url()
        if not url:
            return None
        import base64
        import io
        import qrcode
        img = qrcode.make(url)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return "data:image/png;base64," + b64
```

- [ ] **Step 5: Run test to verify it passes**

Run: `.\.venv\Scripts\python.exe -m unittest tests.test_phone_link.TestServer.test_qr_data_url -v`
Expected: PASS.

- [ ] **Step 6: Add qrcode to the PyInstaller spec**

In `약정만료 알리미.spec`, add `"qrcode"` to `hiddenimports`:
```python
hiddenimports = ["clr_loader", "qrcode"]
```

- [ ] **Step 7: Commit**

```bash
git add backend/phone_link.py requirements.txt "약정만료 알리미.spec" tests/test_phone_link.py
git commit -m "feat(phone): QR data URL for pairing + qrcode dep"
```

---

### Task 5: sender wiring (queue on send, template by open type, not-connected guard)

**Files:**
- Modify: `backend/notifier.py` (`template_for_row` reads `openhow` too)
- Modify: `backend/sender.py`
- Test: `tests/test_sender.py` (new)

**Interfaces:**
- Consumes: `PhoneLink.is_connected()`, `PhoneLink.queue_message()` (Task 2); `notifier.template_for_row`, `notifier.render_message`, `expiry.format_when`.
- Produces: `sender.send_alert(item, config, phone_link=None) -> dict`. New behavior:
  - `deliver_alerts` on + `phone_link` connected → render + `queue_message` + record channel `"phone"` → `{"status":"sent","channel":"phone"}`.
  - `deliver_alerts` on + not connected → `{"status":"error","error":"폰이 연결되지 않았습니다. QR을 스캔해 연결하세요."}` and NO record.
  - `deliver_alerts` off → record channel `"record-only"` (unchanged).

- [ ] **Step 1: Fix template_for_row to accept the UI field**

In `backend/notifier.py`, change `template_for_row` to read either key (UI items carry `openhow`, raw rows carry `openhowx`):

```python
def template_for_row(config: dict[str, Any], row: dict[str, Any]) -> str:
    standard = config.get("message_template", "")
    open_type = row.get("openhowx") or row.get("openhow") or ""
    if is_standard_open_type(open_type):
        return standard
    return config.get("message_template_nonstandard", "") or standard
```

- [ ] **Step 2: Write the failing test**

```python
# tests/test_sender.py
import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import sender, db

CFG_ON = {"deliver_alerts": True, "message_template": "STD {customer}",
          "message_template_nonstandard": "NON {customer}"}
CFG_OFF = {"deliver_alerts": False}
ITEM = {"phone": "010-1234-5678", "customer": "김철수", "openhow": "번호이동",
        "expiry_date": "2026-07-03", "milestone_offset": 0, "id": "x1"}


class FakeLink:
    def __init__(self, connected):
        self._c = connected
        self.sent = []
    def is_connected(self):
        return self._c
    def queue_message(self, phone, text):
        self.sent.append((phone, text))


class TestSender(unittest.TestCase):
    def setUp(self):
        db.init()

    def _item(self, **kw):
        d = dict(ITEM); d.update(kw); return d

    def test_deliver_off_records_only(self):
        res = sender.send_alert(self._item(id="off1"), CFG_OFF, None)
        self.assertEqual(res["status"], "sent")
        self.assertEqual(res["channel"], "record-only")

    def test_deliver_on_connected_queues_nonstandard_template(self):
        link = FakeLink(True)
        res = sender.send_alert(self._item(id="on1"), CFG_ON, link)
        self.assertEqual(res["status"], "sent")
        self.assertEqual(res["channel"], "phone")
        self.assertEqual(len(link.sent), 1)
        phone, text = link.sent[0]
        self.assertEqual(phone, "010-1234-5678")
        self.assertTrue(text.startswith("NON "))   # 번호이동 -> nonstandard template

    def test_deliver_on_not_connected_errors_no_record(self):
        link = FakeLink(False)
        res = sender.send_alert(self._item(id="on2"), CFG_ON, link)
        self.assertEqual(res["status"], "error")
        self.assertFalse(db.already_sent("010-1234-5678", "2026-07-03", 0))
```

- [ ] **Step 3: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe -m unittest tests.test_sender -v`
Expected: FAIL (`send_alert() takes 2 positional args` / channel not `phone`).

- [ ] **Step 4: Write minimal implementation**

Rewrite `backend/sender.py`:

```python
"""Send (record) an outbound customer message for one due row, from "알림 보내기"."""
from __future__ import annotations

from typing import Any

from . import db
from .expiry import format_when
from .notifier import render_message, template_for_row


def send_alert(item: dict[str, Any], config: dict[str, Any],
               phone_link: Any = None) -> dict[str, Any]:
    phone = str(item.get("phone", "")).strip()
    expiry = str(item.get("expiry_date", "")).strip()
    offset = int(item.get("milestone_offset", 0) or 0)
    if not phone or not expiry:
        return {"status": "error", "error": "invalid item"}

    if db.already_sent(phone, expiry, offset):
        return {"status": "already"}

    deliver = bool(config.get("deliver_alerts", False))
    if deliver:
        if phone_link is None or not phone_link.is_connected():
            return {"status": "error",
                    "error": "폰이 연결되지 않았습니다. QR을 스캔해 연결하세요."}
        when = format_when(offset, _safe_date(expiry))
        text = render_message(template_for_row(config, item), _entry(item), when)
        phone_link.queue_message(phone, text)
        channel = "phone"
    else:
        channel = "record-only"

    newly = db.record_sent(_entry(item), channel)
    if not newly:
        return {"status": "already"}
    return {"status": "sent", "channel": channel}


def _entry(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "phone": str(item.get("phone", "")).strip(),
        "customer": item.get("customer", ""),
        "opendate": item.get("opendate", ""),
        "expiry_date": str(item.get("expiry_date", "")).strip(),
        "milestone_offset": int(item.get("milestone_offset", 0) or 0),
        "telecom": item.get("telecom", ""),
        "agency": item.get("agency", ""),
        "openhow": item.get("openhow", ""),
        "plan": item.get("plan", ""),
        "model": item.get("model", ""),
        "staff": item.get("staff", ""),
    }


def _safe_date(iso: str):
    import datetime as _dt
    try:
        return _dt.date.fromisoformat(iso)
    except ValueError:
        return _dt.date.today()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `.\.venv\Scripts\python.exe -m unittest tests.test_sender -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/sender.py backend/notifier.py tests/test_sender.py
git commit -m "feat(phone): queue SMS on send when phone connected; guard when not"
```

---

### Task 6: app + api wiring (start/stop PhoneLink, expose status/QR)

**Files:**
- Modify: `app.py`
- Modify: `backend/api.py`

**Interfaces:**
- Consumes: `PhoneLink` (Tasks 2/4), `sender.send_alert(item, config, phone_link)` (Task 5).
- Produces:
  - `App.phone_link: PhoneLink`, started in `on_start`, stopped in `quit`.
  - `Api.get_phone_status() -> {"available": bool, "connected": bool, "qr": str|None}`.
  - `Api.send_alert` passes `self._app.phone_link` to `sender.send_alert`.
  - `App.status_dict()` gains `"phone"` = `{"available","connected"}` so the main screen can poll it.

- [ ] **Step 1: Wire PhoneLink into App**

In `app.py`, add the import and instance:
```python
from backend.phone_link import PhoneLink
```
In `App.__init__` (after `self.api = Api(self)`):
```python
        self.phone_link = PhoneLink()
```
In `App.on_start`, after the tray starts, add:
```python
        try:
            self.phone_link.start()
        except Exception:
            pass
```
In `App.quit`, before/after the tray stop, add:
```python
        try:
            self.phone_link.stop()
        except Exception:
            pass
```
In `App.status_dict()`, add a `phone` key to the returned dict:
```python
            "phone": {
                "available": self.phone_link.connect_url() is not None,
                "connected": self.phone_link.is_connected(),
            },
```

- [ ] **Step 2: Add api methods**

In `backend/api.py`, add to the updates/section:
```python
    def get_phone_status(self) -> dict[str, Any]:
        pl = self._app.phone_link
        return {
            "available": pl.connect_url() is not None,
            "connected": pl.is_connected(),
            "qr": pl.qr_data_url(),
        }
```
And change `send_alert` to pass the link:
```python
    def send_alert(self, item: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(item, dict):
            return {"status": "error", "error": "invalid item"}
        res = sender.send_alert(item, config_mod.load(), self._app.phone_link)
        if res.get("status") in ("sent", "already"):
            self._app.mark_result_sent(item.get("id"))
        return res
```

- [ ] **Step 3: Verify import + boot (no GUI)**

Run:
```bash
.\.venv\Scripts\python.exe -c "import app; from backend.api import Api; print('ok')"
```
Expected: `ok` (no import errors).

- [ ] **Step 4: Run the whole suite**

Run: `.\.venv\Scripts\python.exe -m unittest discover -s tests -t . -p "test_*.py"`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add app.py backend/api.py
git commit -m "feat(phone): start/stop PhoneLink + expose phone status/QR to UI"
```

---

### Task 7: frontend "폰 연결" card (QR + status + not-connected feedback)

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`
- Modify: `frontend/styles.css`

**Interfaces:**
- Consumes: `api.get_phone_status()` (Task 6) and the existing `sendAlert` path (its `res.error` already surfaces via `alert(msg)`).
- Produces: a collapsible "폰 연결" card on the main view showing the QR + a 연결됨/대기중 pill; polled every 3s while visible.

- [ ] **Step 1: Add the card markup**

In `frontend/index.html`, inside `#view-main`, right after the `session-banner` div, add:
```html
    <div id="phone-card" class="phone-card hidden">
      <div class="phone-info">
        <b>폰 연결</b>
        <span class="phone-pill" id="phone-pill"><span class="dot"></span><span id="phone-stat">대기중</span></span>
        <p class="hint">폰 카메라로 QR을 스캔해 연결하세요. 같은 Wi-Fi여야 합니다. 연결 후 “알림 보내기”를 누르면 폰 문자앱에 자동으로 채워집니다.</p>
      </div>
      <img id="phone-qr" class="phone-qr" alt="연결 QR" />
    </div>
```

- [ ] **Step 2: Add the polling + render logic**

In `frontend/app.js`, add near the other render helpers:
```js
let PHONE_TIMER = null;
async function refreshPhoneStatus() {
  const st = await call("get_phone_status");
  const card = $("#phone-card");
  if (!st || !st.available) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  if (st.qr) $("#phone-qr").src = st.qr;
  const on = !!st.connected;
  $("#phone-pill").className = "phone-pill " + (on ? "is-on" : "");
  $("#phone-stat").textContent = on ? "연결됨" : "대기중";
}
function startPhonePolling() {
  refreshPhoneStatus();
  if (PHONE_TIMER) clearInterval(PHONE_TIMER);
  PHONE_TIMER = setInterval(refreshPhoneStatus, 3000);
}
```
In `runInit()` (after the bootstrap render), call `startPhonePolling();`.
Add mock support in `mock()`:
```js
  if (method === "get_phone_status") return { available: false, connected: false, qr: null };
```

- [ ] **Step 3: Add styles**

In `frontend/styles.css` append:
```css
.phone-card{display:flex;gap:16px;align-items:center;justify-content:space-between;
  background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);
  padding:14px 16px;margin-bottom:16px}
.phone-info{display:flex;flex-direction:column;gap:6px}
.phone-info b{font-size:14px}
.phone-pill{display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border-radius:999px;
  background:var(--skip-bg);border:1px solid var(--border);font-size:12px;font-weight:600;
  color:var(--skip-ink);width:fit-content}
.phone-pill .dot{width:8px;height:8px;border-radius:50%;background:var(--muted-2)}
.phone-pill.is-on{background:var(--ok-bg);border-color:var(--ok-border);color:var(--ok)}
.phone-pill.is-on .dot{background:var(--ok)}
.phone-qr{width:120px;height:120px;flex:0 0 120px;border-radius:10px;background:#fff;
  border:1px solid var(--border)}
```

- [ ] **Step 4: Sanity-check the JS parses**

Run: `node --check frontend/app.js`
Expected: no output (valid).

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/app.js frontend/styles.css
git commit -m "feat(phone): 폰 연결 card with QR + live connection status"
```

---

### Task 8: build + real-phone end-to-end verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-03-phone-link-qr-design.md` (mark verified) — optional.

- [ ] **Step 1: Full check**

Run:
```bash
.\.venv\Scripts\python.exe -m unittest discover -s tests -t . -p "test_*.py"
node --check frontend/app.js
```
Expected: all tests PASS, JS valid.

- [ ] **Step 2: Rebuild the exe**

Run: `.\.venv\Scripts\python.exe build.py`
Expected: `Built: dist/약정만료 알리미.exe`.

- [ ] **Step 3: Install + launch**

Copy `dist/약정만료 알리미.exe` over `%LOCALAPPDATA%\Programs\약정만료 알리미\약정만료 알리미.exe`, launch it. On first launch Windows Firewall may prompt — allow on Private networks (needed for the phone to reach the server).

- [ ] **Step 4: Manual E2E with the real phone**

  1. Main screen shows the "폰 연결" card with a QR and 대기중.
  2. Scan the QR with the phone camera (same Wi-Fi). Browser opens the page → 연결됨 appears on both the phone and the PC card within ~3s.
  3. In 설정 turn ON "고객에게 실제로 문자를 전송합니다".
  4. Click "알림 보내기" on a row → within ~1s the phone opens its Messages app with the number + message pre-filled.
  5. Tap send on the phone. Confirm the row flips to 발송됨 and 발송 이력 records it.
  6. With deliver ON but phone disconnected (close the phone page), click 알림 보내기 → the app shows "폰이 연결되지 않았습니다..." and does NOT record.

- [ ] **Step 5: Commit any doc updates**

```bash
git add docs/superpowers/specs/2026-07-03-phone-link-qr-design.md
git commit -m "docs: mark phone-link verified end-to-end"
```

---

## Self-Review

- **Spec coverage:** server + free port + LAN IP (T1/T2), token gating (T2), phone page + sms open (T3), QR (T4), send wiring + not-connected guard + template-by-type (T5), start/stop + status exposure (T6), 폰 연결 UI (T7), firewall note + real-phone E2E (T8). deliver_alerts redefinition covered in T5. Plain-HTTP/LAN + record-at-enqueue honored in T5. All spec sections map to a task.
- **Placeholders:** none — every code step shows full code; the Task 2 placeholder page is intentional and replaced in Task 3.
- **Type consistency:** `PhoneLink.is_connected/queue_message/connect_url/qr_data_url/token/port` used consistently across T2, T4, T5 (via FakeLink), T6. `send_alert(item, config, phone_link)` signature consistent T5↔T6. `template_for_row(config, row)` reads `openhow`/`openhowx` (T5) matching UI item fields.
