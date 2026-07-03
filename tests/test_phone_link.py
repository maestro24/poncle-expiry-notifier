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
