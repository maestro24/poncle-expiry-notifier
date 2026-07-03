"""Unit tests for the contract-expiry math (the correctness core)."""
import datetime as dt
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.expiry import (add_months, candidate_open_dates, compute_expiry,
                            due_milestones, parse_opendate, resolve_term_months)

CFG = {"default_term_months": 24, "term_overrides": [], "skip_zero_term": True,
       "notify_offsets_days": [0]}


class TestParse(unittest.TestCase):
    def test_two_digit_year(self):
        self.assertEqual(parse_opendate("24-06-15"), dt.date(2024, 6, 15))

    def test_four_digit_year(self):
        self.assertEqual(parse_opendate("2024-06-15"), dt.date(2024, 6, 15))

    def test_bad(self):
        self.assertIsNone(parse_opendate(""))
        self.assertIsNone(parse_opendate("nope"))
        self.assertIsNone(parse_opendate("24-13-40"))


class TestAddMonths(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(add_months(dt.date(2024, 6, 15), 24), dt.date(2026, 6, 15))

    def test_leap_clamp(self):
        # Jan 31 + 1 month -> Feb 29 (2024 is a leap year)
        self.assertEqual(add_months(dt.date(2024, 1, 31), 1), dt.date(2024, 2, 29))

    def test_year_boundary(self):
        self.assertEqual(add_months(dt.date(2024, 12, 31), 2), dt.date(2025, 2, 28))

    def test_negative(self):
        self.assertEqual(add_months(dt.date(2026, 6, 15), -24), dt.date(2024, 6, 15))


class TestExpiry(unittest.TestCase):
    def test_core_example(self):
        # The user's example: opened 24-06-15 -> 2yr expiry 26-06-15
        row = {"opendate": "24-06-15"}
        self.assertEqual(compute_expiry(row, CFG), dt.date(2026, 6, 15))

    def test_due_today_dday(self):
        row = {"opendate": "24-06-15"}
        due = due_milestones(row, CFG, dt.date(2026, 6, 15))
        self.assertEqual(due, [(0, dt.date(2026, 6, 15))])

    def test_not_due_other_days(self):
        row = {"opendate": "24-06-15"}
        self.assertEqual(due_milestones(row, CFG, dt.date(2026, 6, 14)), [])
        self.assertEqual(due_milestones(row, CFG, dt.date(2026, 6, 16)), [])

    def test_d7_and_dday(self):
        cfg = dict(CFG, notify_offsets_days=[0, 7])
        row = {"opendate": "24-06-15"}
        # D-7 fires 7 days before expiry
        self.assertEqual(due_milestones(row, cfg, dt.date(2026, 6, 8)), [(7, dt.date(2026, 6, 15))])
        self.assertEqual(due_milestones(row, cfg, dt.date(2026, 6, 15)), [(0, dt.date(2026, 6, 15))])


class TestOverrides(unittest.TestCase):
    def test_zero_term_skipped(self):
        cfg = dict(CFG, term_overrides=[{"field": "openhowx", "match": "유심", "term_months": 0}])
        row = {"opendate": "24-06-15", "openhowx": "유심MNP"}
        self.assertIsNone(compute_expiry(row, cfg))
        self.assertEqual(due_milestones(row, cfg, dt.date(2026, 6, 15)), [])

    def test_override_term(self):
        cfg = dict(CFG, term_overrides=[{"field": "telecomx", "match": "알뜰", "term_months": 12}])
        row = {"opendate": "24-06-15", "telecomx": "U+알뜰모바일"}
        self.assertEqual(compute_expiry(row, cfg), dt.date(2025, 6, 15))

    def test_resolve_default(self):
        self.assertEqual(resolve_term_months({"openhowx": "기변"}, CFG), 24)


class TestCandidateDates(unittest.TestCase):
    def test_dday_candidate(self):
        today = dt.date(2026, 6, 15)
        # opendate = today - 24 months = 2024-06-15
        self.assertIn(dt.date(2024, 6, 15), candidate_open_dates(CFG, today))

    def test_multi_offset_and_terms(self):
        cfg = dict(CFG, notify_offsets_days=[0, 7],
                   term_overrides=[{"field": "x", "match": "y", "term_months": 12}])
        today = dt.date(2026, 6, 15)
        cands = candidate_open_dates(cfg, today)
        # 24-month D-day
        self.assertIn(dt.date(2024, 6, 15), cands)
        # 24-month D-7  -> expiry 2026-06-22 -> open 2024-06-22
        self.assertIn(dt.date(2024, 6, 22), cands)
        # 12-month D-day -> open 2025-06-15
        self.assertIn(dt.date(2025, 6, 15), cands)


class TestWindowCoverage(unittest.TestCase):
    """Regression: the day-clamp error must be absorbed by the +/- date window so
    the server-date-filter path never silently drops a due row (review finding #1/#3)."""

    WINDOW = 3

    def _covered(self, opendate, term, offset):
        cfg = dict(CFG, default_term_months=term, notify_offsets_days=[offset])
        expiry = compute_expiry({"opendate": opendate.isoformat()}, cfg)
        today = expiry - dt.timedelta(days=offset)
        # sanity: the row really is due today
        self.assertTrue(due_milestones({"opendate": opendate.isoformat()}, cfg, today))
        cands = candidate_open_dates(cfg, today)
        # the true opendate must fall within some candidate's +/- WINDOW
        return any(abs((c - opendate).days) <= self.WINDOW for c in cands)

    def test_leap_day_open_term24(self):
        self.assertTrue(self._covered(dt.date(2024, 2, 29), 24, 0))

    def test_month_end_open_term1(self):
        self.assertTrue(self._covered(dt.date(2024, 8, 31), 1, 0))

    def test_month_end_open_term30(self):
        self.assertTrue(self._covered(dt.date(2023, 12, 31), 30, 0))

    def test_plain_mid_month_still_covered(self):
        self.assertTrue(self._covered(dt.date(2024, 6, 15), 24, 0))

    def test_many_month_ends(self):
        # every month-end opening with a 1-month term should be covered
        for m in range(1, 13):
            import calendar
            last = calendar.monthrange(2024, m)[1]
            self.assertTrue(self._covered(dt.date(2024, m, last), 1, 0),
                            f"month {m} end not covered")


if __name__ == "__main__":
    unittest.main()
