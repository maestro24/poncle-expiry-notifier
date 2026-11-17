"""Poncle /open/listOpen search-field selection.

Poncle retired s="customer-openphone"; an unknown `s` is silently ignored by
the server, so any non-empty q would return the whole table. The PC app only
sends empty-q list/probe requests, so these tests pin s="all" and make sure the
retired value never reaches a request again.
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.poncle_client import PoncleClient
from backend.session import SessionManager, _probe_params

RETIRED = "customer-openphone"
# The `s` values Poncle's list form offers today; anything else is ignored.
ALLOWED_SEARCH_FIELDS = {
    "all", "openphones", "openphone", "customer", "mserial", "userial",
    "memo1", "memo2", "memo3", "transfer-customer", "transfer-openphone",
}
DEFAULT_SEARCH = ("all", "")


class _FakeResp:
    status_code = 200
    headers = {"Content-Type": "application/json"}

    def __init__(self, payload):
        import json
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class _RecordingSession:
    def __init__(self):
        self.calls = []

    def get(self, url, params=None, **kwargs):
        self.calls.append(dict(params or {}))
        return _FakeResp({"total": 0, "list": []})


class _FakeSM:
    base_url = "https://example.invalid"

    def __init__(self):
        self.session = _RecordingSession()

    def build_session(self):
        return self.session


class TestNoRetiredFieldInRequests(unittest.TestCase):
    def assert_clean(self, params):
        self.assertNotIn(RETIRED, [str(v) for v in params.values()])
        self.assertIn(params["s"], ALLOWED_SEARCH_FIELDS)

    def test_client_default_params(self):
        sm = _FakeSM()
        p = PoncleClient(sm, {})._params(start=0, scale=10)
        self.assert_clean(p)
        self.assertEqual((p["s"], p["q"]), DEFAULT_SEARCH)

    def test_probe_params(self):
        p = _probe_params()
        self.assert_clean(p)
        self.assertEqual((p["s"], p["q"]), DEFAULT_SEARCH)

    def test_every_client_request_is_clean(self):
        import datetime as dt
        sm = _FakeSM()
        client = PoncleClient(sm, {"page_size": 5, "use_server_date_filter": True})
        client.fetch_candidates([dt.date(2024, 6, 15), dt.date(2024, 7, 1)])
        self.assertTrue(sm.session.calls)
        for params in sm.session.calls:
            self.assert_clean(params)

    def test_session_probe_request_is_clean(self):
        sm = SessionManager.__new__(SessionManager)
        sm.base_url = "https://example.invalid"
        seen = []

        def fake_get(self_, url, params=None, **kwargs):
            seen.append(dict(params or {}))
            return _FakeResp({"list": []})

        with mock.patch("backend.session.requests.Session.get", fake_get):
            self.assertTrue(sm._probe({"PHPSESSID": "x"}, timeout=1))
        self.assertEqual(len(seen), 1)
        self.assert_clean(seen[0])


if __name__ == "__main__":
    unittest.main()
