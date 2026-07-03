# Phone Link (QR + HTTP polling) — Design

**Date:** 2026-07-03
**Status:** Approved (core), pending spec review
**Goal:** Let "알림 보내기" send the customer message from the owner's own phone. The
PC app hosts a tiny local web server; the phone connects once by scanning a QR;
each send opens the phone's SMS app pre-filled (number + body). The employee taps
send. Message goes out from the owner's real number.

## Why this approach

- The phone's browser opening `sms:<number>?body=<text>` pre-fills both number and
  body (verified on the owner's Android). No app install on the phone, no KDE
  Connect, no SMS API, no cost.
- Manual per-row flow (employee clicks 알림 보내기, then sends on the phone). No
  bulk queue. Chosen transport is **HTTP short-polling** — simplest, stdlib-only,
  ~1s latency which is invisible in a manual flow.
- Rejected: QR-per-message (scan every message), WebSocket (two-way overkill for a
  one-way manual trigger), SSE (instant push not needed here).

## Architecture

```
[PC app (pywebview)]
 ├─ backend/phone_link.py            # new module (server + queue + token + IP)
 │    · stdlib ThreadingHTTPServer bound to 0.0.0.0:<auto free port>, bg thread
 │    · serves the phone page + command endpoints
 │    · interface: start() / stop() / queue_message(phone, text)
 │                 / is_connected() / connect_url() / qr_data_url()
 ├─ main-screen "폰 연결" card: QR image + status (대기중 / 연결됨)
 └─ send_alert(): deliver ON + phone connected -> queue_message()

[phone browser]  <- scans QR -> http://<PC-LAN-IP>:<port>/p/<token>
 · page JS polls GET /pending?token=T every ~1s
 · on command -> location.href = "sms:" + number + "?body=" + encodeURIComponent(text)
 · shows 연결됨 + last-sent line; heartbeats via the poll
```

## Components (each independent + testable)

1. **`backend/phone_link.py`** — the server, command queue, session token, and LAN
   IP detection. `App` starts it on launch and stops it on quit.
   - Auto-selects a free port (bind to port 0, read assigned port).
   - Token: `crypto.randomHex` (32 hex chars), embedded in the QR URL path.
   - LAN IP: UDP socket trick (`connect(("8.8.8.8", 80))` then `getsockname()`),
     falls back to hostname resolution.
   - Command queue: in-memory `collections.deque` of `{id, phone, text}` per token.
   - `is_connected()`: a poll (heartbeat) arrived within the last ~5s.
2. **Phone page** — one HTML/JS document served by `phone_link` at `/p/<token>`.
   Polls, opens `sms:`, renders 연결됨 + the last message. No framework.
3. **QR** — `qrcode` library (new dependency; Pillow already present) renders the
   `connect_url()` to a PNG, returned to the app UI as a data URL.
4. **Wire-in** — `sender.send_alert()` calls `phone_link.queue_message()` when
   `deliver_alerts` is on and the phone is connected. History recording stays.

## Data flow (one send)

1. Employee clicks 알림 보내기 on a row.
2. `api.send_alert` -> `sender.send_alert(item, config)`.
3. If `deliver_alerts` on AND phone connected: pick template with
   `notifier.template_for_row`, render with `render_message`, then
   `phone_link.queue_message(phone, text)` and record the send (channel `phone`).
4. Phone poll `GET /pending?token=T` returns `{phone, text}`; page opens
   `sms:` pre-filled; employee taps send in the SMS app.
5. There is no carrier delivery confirmation, so the send is recorded at enqueue
   time (step 3), consistent with the current dedup/history behavior.

## Connection model

- One phone, one token per app session. QR encodes `http://<LAN-IP>:<port>/p/<token>`.
- Phone opening the page begins polling; each poll refreshes a "last seen" stamp.
- `연결됨` shows while a poll arrived within ~5s; otherwise `대기중`.

## Port / IP

- Free port auto-selected at bind time and embedded in the QR (no fixed-port
  conflicts; QR is per session).
- LAN IP via the UDP-socket trick; on failure fall back to hostname, and surface a
  clear message if no routable LAN IP is found.

## Security

- Token in the URL path gates `/pending` and `/connect`: only a device that scanned
  the QR can receive commands or customer data.
- Plain HTTP, LAN-only, trusted-shop-WiFi assumption. Customer name + number travel
  over the local network in clear text. TLS is intentionally omitted: a self-signed
  cert triggers phone browser warnings and adds setup friction for no real gain on a
  trusted LAN. Documented as a known limitation.
- Windows Firewall prompts once (Private network) on first bind; if denied, the
  phone cannot connect — the UI explains how to allow it.

### Remote mode (Cloudflare quick tunnel) — added 2026-07-04

For when PC and phone are not on the same LAN (PC on Ethernet, phone on LTE). A
toggle brings up a Cloudflare quick tunnel (`cloudflared`) exposing the same
token-gated server over a random `https://<random>.trycloudflare.com` URL.

- The 128-bit session token is the sole gate and is enforced with a constant-time
  compare on BOTH routes (`/p/<token>`, `/pending?token=`); no route returns the
  page or customer data without it. The tunnel targets only `127.0.0.1:<phone-port>`.
- `cloudflared` is downloaded from a PINNED release tag and verified by SHA-256
  before it is executed (rejects a substituted/tampered binary).
- Privacy: when remote is ON, customer name + phone transit Cloudflare's edge
  (TLS to the edge, but Cloudflare terminates it). This is disclosed in the toggle
  hint; local mode (same LAN) keeps data off the internet and is the default.
- The tunnel is outbound, so no inbound firewall rule is needed.

## Error handling

- deliver ON + phone NOT connected + 알림 보내기 -> do not send, do not record;
  warn "폰이 연결되지 않았습니다. QR을 스캔해 연결하세요." Retryable.
- deliver OFF -> existing record-only behavior (no phone).
- Server bind failure -> phone_link disabled, rest of app works, UI shows
  "폰 연결 사용 불가".
- Phone poll failure (server down / network) -> page shows "연결 끊김" + auto-retry.

## Testing

- Unit: token generation, queue enqueue/dequeue, LAN IP detection (socket mocked),
  `sms:` URI building, template selection (already covered).
- Integration: start the server, poll `GET /pending` from localhost via urllib,
  assert a queued command is delivered exactly once.
- Phone page JS: manual verification on the real phone.

## YAGNI / out of scope

- One phone, one token. No bulk "send all" queue.
- No carrier delivery confirmation (impossible); record at enqueue.
- No TLS, no auth beyond the session token.

## New dependency

- `qrcode` (pure Python, uses the existing Pillow). Add to `requirements.txt` and
  the PyInstaller spec (`collect_all` not needed; a normal import + hidden import if
  required).
