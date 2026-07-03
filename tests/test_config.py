"""Unit tests for settings migration (channels removal + template upgrade)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.config import DEFAULTS, _OLD_DEFAULT_TEMPLATE, _migrate


class TestMigrate(unittest.TestCase):
    def test_channels_pruned(self):
        cfg = {"channels": {"desktop_toast": True}, "message_template": "hi"}
        out = _migrate(cfg)
        self.assertNotIn("channels", out)

    def test_old_default_template_upgraded(self):
        cfg = {"message_template": _OLD_DEFAULT_TEMPLATE}
        out = _migrate(cfg)
        self.assertEqual(out["message_template"], DEFAULTS["message_template"])

    def test_custom_template_preserved(self):
        custom = "안녕하세요 {customer}님, 직접 쓴 문구입니다."
        out = _migrate({"message_template": custom})
        self.assertEqual(out["message_template"], custom)

    def test_new_default_is_customer_facing(self):
        # sanity: the shipped default addresses the customer, not internal staff
        self.assertIn("{customer}", DEFAULTS["message_template"])
        self.assertNotIn("[약정만료]", DEFAULTS["message_template"])


if __name__ == "__main__":
    unittest.main()
