import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import sender, db

CFG_ON = {"deliver_alerts": True, "message_template": "STD {customer}",
          "message_template_nonstandard": "NON {customer}"}
CFG_OFF = {"deliver_alerts": False}
ITEM = {"phone": "010-1234-5678", "customer": "김철수", "openhow": "번호이동",
        "expiry_date": "2026-07-03", "milestone_offset": 0, "id": "x1"}


class FakeLink:
    def __init__(self, connected):
        self._c = connected
        self.sent = []
    def is_connected(self):
        return self._c
    def queue_message(self, phone, text):
        self.sent.append((phone, text))


class TestSender(unittest.TestCase):
    def setUp(self):
        db.init()

    def _item(self, **kw):
        d = dict(ITEM); d.update(kw); return d

    def test_deliver_off_records_only(self):
        res = sender.send_alert(self._item(id="off1", phone="010-1111-0001"), CFG_OFF, None)
        self.assertEqual(res["status"], "sent")
        self.assertEqual(res["channel"], "record-only")

    def test_deliver_on_connected_queues_nonstandard_template(self):
        link = FakeLink(True)
        res = sender.send_alert(self._item(id="on1", phone="010-1111-0002"), CFG_ON, link)
        self.assertEqual(res["status"], "sent")
        self.assertEqual(res["channel"], "phone")
        self.assertEqual(len(link.sent), 1)
        phone, text = link.sent[0]
        self.assertEqual(phone, "010-1111-0002")
        self.assertTrue(text.startswith("NON "))   # 번호이동 -> nonstandard template

    def test_deliver_on_not_connected_errors_no_record(self):
        link = FakeLink(False)
        res = sender.send_alert(self._item(id="on2", phone="010-1111-0003"), CFG_ON, link)
        self.assertEqual(res["status"], "error")
        self.assertFalse(db.already_sent("010-1111-0003", "2026-07-03", 0))
