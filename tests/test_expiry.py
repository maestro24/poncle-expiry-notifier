"""Unit tests for the contract-expiry math (the correctness core)."""
import datetime as dt
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.expiry import (add_months, candidate_open_dates, compute_expiry,
                            due_milestones, is_standard_open_type, parse_opendate,
                            resolve_term_months)
from backend.notifier import template_for_row

CFG = {"default_term_months": 24, "nonstandard_term_months": 6,
       "agency_term_months": {}, "notify_offsets_days": [0]}

# A standard (기변) row resolves to the 24-month default term.
STD = {"openhowx": "기변"}


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
        # 기변 opened 24-06-15 -> 2yr expiry 26-06-15
        row = {"opendate": "24-06-15", **STD}
        self.assertEqual(compute_expiry(row, CFG), dt.date(2026, 6, 15))

    def test_due_today_dday(self):
        row = {"opendate": "24-06-15", **STD}
        due = due_milestones(row, CFG, dt.date(2026, 6, 15))
        self.assertEqual(due, [(0, dt.date(2026, 6, 15))])

    def test_not_due_other_days(self):
        row = {"opendate": "24-06-15", **STD}
        self.assertEqual(due_milestones(row, CFG, dt.date(2026, 6, 14)), [])
        self.assertEqual(due_milestones(row, CFG, dt.date(2026, 6, 16)), [])

    def test_d7_and_dday(self):
        cfg = dict(CFG, notify_offsets_days=[0, 7])
        row = {"opendate": "24-06-15", **STD}
        self.assertEqual(due_milestones(row, cfg, dt.date(2026, 6, 8)), [(7, dt.date(2026, 6, 15))])
        self.assertEqual(due_milestones(row, cfg, dt.date(2026, 6, 15)), [(0, dt.date(2026, 6, 15))])


class TestTermResolution(unittest.TestCase):
    def test_standard_types_use_default(self):
        self.assertEqual(resolve_term_months({"openhowx": "기변"}, CFG), 24)
        self.assertEqual(resolve_term_months({"openhowx": "신규"}, CFG), 24)

    def test_nonstandard_uses_nonstandard_default(self):
        self.assertEqual(resolve_term_months({"openhowx": "번호이동"}, CFG), 6)
        self.assertEqual(resolve_term_months({"openhowx": "유심MNP"}, CFG), 6)

    def test_usim_new_is_nonstandard(self):
        # "유심신규" contains "신규" but exact match keeps it non-standard (6).
        self.assertEqual(resolve_term_months({"openhowx": "유심신규"}, CFG), 6)

    def test_agency_override(self):
        cfg = dict(CFG, agency_term_months={"CD대리점": 12})
        row = {"opendate": "24-06-15", "openhowx": "번호이동", "agencytitle": "CD대리점"}
        self.assertEqual(resolve_term_months(row, cfg), 12)
        self.assertEqual(compute_expiry(row, cfg), dt.date(2025, 6, 15))

    def test_agency_override_ignored_for_standard_type(self):
        # 기변 stays 24 even at an agency with an override.
        cfg = dict(CFG, agency_term_months={"CD대리점": 12})
        row = {"openhowx": "기변", "agencytitle": "CD대리점"}
        self.assertEqual(resolve_term_months(row, cfg), 24)

    def test_agency_name_normalization(self):
        # config key "PS&M" must match a scanned "PS&amp;M" (HTML-entity encoded).
        cfg = dict(CFG, agency_term_months={"PS&M": 9})
        row = {"openhowx": "번호이동", "agencytitle": "PS&amp;M"}
        self.assertEqual(resolve_term_months(row, cfg), 9)

    def test_zero_term_skipped(self):
        cfg = dict(CFG, agency_term_months={"CD대리점": 0})
        row = {"opendate": "24-06-15", "openhowx": "번호이동", "agencytitle": "CD대리점"}
        self.assertIsNone(compute_expiry(row, cfg))


class TestOpenTypeClassification(unittest.TestCase):
    def test_standard(self):
        self.assertTrue(is_standard_open_type("기변"))
        self.assertTrue(is_standard_open_type("신규"))

    def test_nonstandard(self):
        for t in ("번호이동", "유심신규", "유심MNP", ""):
            self.assertFalse(is_standard_open_type(t))


class TestTemplateSelection(unittest.TestCase):
    CFG = {"message_template": "STD", "message_template_nonstandard": "NON"}

    def test_standard_types_use_standard_template(self):
        self.assertEqual(template_for_row(self.CFG, {"openhowx": "기변"}), "STD")
        self.assertEqual(template_for_row(self.CFG, {"openhowx": "신규"}), "STD")

    def test_nonstandard_types_use_nonstandard_template(self):
        self.assertEqual(template_for_row(self.CFG, {"openhowx": "번호이동"}), "NON")
        self.assertEqual(template_for_row(self.CFG, {"openhowx": "유심MNP"}), "NON")
        self.assertEqual(template_for_row(self.CFG, {"openhowx": "유심신규"}), "NON")

    def test_empty_nonstandard_falls_back_to_standard(self):
        cfg = {"message_template": "STD", "message_template_nonstandard": ""}
        self.assertEqual(template_for_row(cfg, {"openhowx": "번호이동"}), "STD")


class TestCandidateDates(unittest.TestCase):
    def test_dday_candidate(self):
        today = dt.date(2026, 6, 15)
        # opendate = today - 24 months = 2024-06-15
        self.assertIn(dt.date(2024, 6, 15), candidate_open_dates(CFG, today))

    def test_multi_offset_and_terms(self):
        cfg = dict(CFG, notify_offsets_days=[0, 7], agency_term_months={"X": 12})
        today = dt.date(2026, 6, 15)
        cands = candidate_open_dates(cfg, today)
        self.assertIn(dt.date(2024, 6, 15), cands)   # 24-month D-day
        self.assertIn(dt.date(2024, 6, 22), cands)   # 24-month D-7
        self.assertIn(dt.date(2025, 6, 15), cands)   # 12-month D-day (agency override)
        self.assertIn(dt.date(2025, 12, 15), cands)  # 6-month D-day (nonstandard default)


class TestWindowCoverage(unittest.TestCase):
    """Regression: the day-clamp error must be absorbed by the +/- date window so
    the server-date-filter path never silently drops a due row (review finding #1/#3)."""

    WINDOW = 3

    def _covered(self, opendate, term, offset):
        cfg = dict(CFG, default_term_months=term, notify_offsets_days=[offset])
        row = {"opendate": opendate.isoformat(), **STD}
        expiry = compute_expiry(row, cfg)
        today = expiry - dt.timedelta(days=offset)
        self.assertTrue(due_milestones(row, cfg, today))
        cands = candidate_open_dates(cfg, today)
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
        import calendar
        for m in range(1, 13):
            last = calendar.monthrange(2024, m)[1]
            self.assertTrue(self._covered(dt.date(2024, m, last), 1, 0),
                            f"month {m} end not covered")


if __name__ == "__main__":
    unittest.main()
