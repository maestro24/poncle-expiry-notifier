import json, os, sys, time, unittest, urllib.error, urllib.request
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import phone_link as pl


class _FakeTunnel:
    def __init__(self, url):
        self._url = url
        self.error = None
    def public_url(self):
        return self._url
    def is_ready(self):
        return self._url is not None
    def stop(self):
        pass


class TestRemote(unittest.TestCase):
    def setUp(self):
        self.link = pl.PhoneLink()
        self.assertTrue(self.link.start())

    def tearDown(self):
        self.link.stop()

    def test_connect_url_lan_when_no_tunnel(self):
        url = self.link.connect_url()
        self.assertTrue(url.startswith("http://"))
        self.assertIn(f"/p/{self.link.token}", url)

    def test_connect_url_uses_tunnel_when_ready(self):
        self.link._tunnel = _FakeTunnel("https://foo-bar.trycloudflare.com")
        self.assertEqual(
            self.link.connect_url(),
            f"https://foo-bar.trycloudflare.com/p/{self.link.token}",
        )
        st = self.link.remote_status()
        self.assertTrue(st["enabled"])
        self.assertTrue(st["ready"])

    def test_connect_url_none_when_tunnel_not_ready(self):
        self.link._tunnel = _FakeTunnel(None)  # enabled, not ready
        self.assertIsNone(self.link.connect_url())
        self.assertFalse(self.link.remote_status()["ready"])


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

    def test_phone_page_has_token_and_poll(self):
        st, body = self._get(f"/p/{self.link.token}")
        self.assertEqual(st, 200)
        self.assertIn(self.link.token, body)     # token injected
        self.assertIn("/pending?token=", body)   # polls the endpoint
        self.assertIn("sms:", body)              # opens the SMS app

    def test_qr_data_url(self):
        d = self.link.qr_data_url()
        self.assertTrue(d.startswith("data:image/png;base64,"))
        self.assertGreater(len(d), 200)
