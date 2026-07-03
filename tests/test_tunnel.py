"""Unit tests for the Cloudflare tunnel URL parsing + binary path."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import tunnel


class TestParse(unittest.TestCase):
    def test_parses_trycloudflare_url(self):
        line = ("2026-07-04T00:00:00Z INF |  "
                "https://blue-cat-happy-tree.trycloudflare.com                       |")
        self.assertEqual(
            tunnel.parse_tunnel_url(line),
            "https://blue-cat-happy-tree.trycloudflare.com",
        )

    def test_no_url_returns_none(self):
        self.assertIsNone(tunnel.parse_tunnel_url("INF Starting tunnel..."))
        self.assertIsNone(tunnel.parse_tunnel_url(""))
        self.assertIsNone(tunnel.parse_tunnel_url(None))

    def test_ignores_other_https(self):
        self.assertIsNone(tunnel.parse_tunnel_url("see https://example.com for help"))

    def test_binary_path_is_in_data_dir(self):
        p = tunnel.binary_path()
        self.assertEqual(p.name, "cloudflared.exe")


if __name__ == "__main__":
    unittest.main()
