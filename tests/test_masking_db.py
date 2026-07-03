"""Tests for PII masking and the SQLite dedup/store."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# App data is redirected to a temp dir in tests/__init__.py (before any backend
# import), so db/config tests never touch the user's real data.
from backend.masking import mask_name, mask_phone  # noqa: E402


class TestMasking(unittest.TestCase):
    def test_phone(self):
        self.assertEqual(mask_phone("010-3479-7780"), "010-34**-**80")
        self.assertEqual(mask_phone("01034797780"), "010-34**-**80")

    def test_name_korean(self):
        self.assertEqual(mask_name("김수현"), "김*현")
        self.assertEqual(mask_name("홍길"), "홍*")
        self.assertEqual(mask_name("박지훈"), "박*훈")

    def test_name_roman(self):
        self.assertEqual(mask_name("LI CHANGJI"), "L* C*")

    def test_empty(self):
        self.assertEqual(mask_name(""), "-")
        self.assertEqual(mask_phone(""), "-")


class TestDb(unittest.TestCase):
    def setUp(self):
        # Fresh import each time is overkill; db uses module-level path already set.
        from backend import db
        self.db = db
        db.init()

    def test_dedup(self):
        entry = {"phone": "010-1111-2222", "customer": "테스트", "opendate": "24-06-15",
                 "expiry_date": "2026-06-15", "milestone_offset": 0, "telecom": "SKT"}
        self.assertFalse(self.db.already_sent("010-1111-2222", "2026-06-15", 0))
        self.assertTrue(self.db.record_sent(entry, "in_app"))     # newly inserted
        self.assertTrue(self.db.already_sent("010-1111-2222", "2026-06-15", 0))
        self.assertFalse(self.db.record_sent(entry, "in_app"))    # duplicate ignored

    def test_dedup_per_milestone(self):
        entry = {"phone": "010-3333-4444", "expiry_date": "2026-06-15", "milestone_offset": 0}
        self.assertTrue(self.db.record_sent(entry, "in_app"))
        entry7 = dict(entry, milestone_offset=7)
        # Different milestone -> allowed once
        self.assertFalse(self.db.already_sent("010-3333-4444", "2026-06-15", 7))
        self.assertTrue(self.db.record_sent(entry7, "in_app"))

    def test_events_and_counts(self):
        self.db.add_event("sent", customer="A", phone="010-0000-0000")
        self.db.add_event("skipped", customer="B")
        counts = self.db.today_counts()
        self.assertGreaterEqual(counts["sent"], 1)
        self.assertGreaterEqual(counts["targets"], 2)


if __name__ == "__main__":
    unittest.main()
