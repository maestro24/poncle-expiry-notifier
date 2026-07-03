"""Unit tests for the self-update version comparison."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.updater import _parse, is_newer


class TestVersionCompare(unittest.TestCase):
    def test_parse_strips_v_prefix_and_suffixes(self):
        self.assertEqual(_parse("v1.3.0"), (1, 3, 0))
        self.assertEqual(_parse("1.3.0"), (1, 3, 0))
        self.assertEqual(_parse("v1.3.0-beta"), (1, 3, 0))
        self.assertEqual(_parse("1.3.0+build7"), (1, 3, 0))

    def test_parse_bad_segments_become_zero(self):
        self.assertEqual(_parse("1.x.2"), (1, 0, 2))
        self.assertEqual(_parse(""), (0,))

    def test_is_newer_true(self):
        self.assertTrue(is_newer("1.3.0", "1.2.0"))
        self.assertTrue(is_newer("v1.2.1", "1.2.0"))
        self.assertTrue(is_newer("2.0.0", "1.9.9"))

    def test_is_newer_false_for_same_or_older(self):
        self.assertFalse(is_newer("1.2.0", "1.2.0"))
        self.assertFalse(is_newer("1.1.0", "1.2.0"))
        self.assertFalse(is_newer("v1.2.0", "1.2.0"))

    def test_shorter_version_ordering(self):
        # (1, 2) < (1, 2, 1)  -> tuple comparison handles missing patch
        self.assertTrue(is_newer("1.2.1", "1.2"))
        self.assertFalse(is_newer("1.2", "1.2.1"))


if __name__ == "__main__":
    unittest.main()
