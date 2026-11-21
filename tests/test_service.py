"""Run with python -m unittest discover -s tests in the project environment."""

import concurrent.futures
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import server


class ShareAddressTests(unittest.TestCase):
    hardware = "Hardware Port: Ethernet\nDevice: en0\n\nHardware Port: Wi-Fi\nDevice: en1\n"

    def test_mac_uses_wireless_address_when_default_route_uses_vpn(self):
        with (
            patch.object(server.sys, "platform", "darwin"),
            patch.object(
                server.subprocess, "check_output", side_effect=[self.hardware, "192.168.1.100\n"]
            ) as command,
            patch.object(server.socket, "socket") as udp,
        ):
            self.assertEqual(server.lan_host(), "192.168.1.100")
            self.assertEqual(command.call_args.args[0], ["/usr/sbin/ipconfig", "getifaddr", "en1"])
            udp.assert_not_called()

    def test_missing_or_invalid_wireless_address_falls_back_to_route(self):
        for ports, values in [
            ("Hardware Port: Ethernet\nDevice: en0\n", []),
            (self.hardware, [""]),
            (self.hardware, ["127.0.0.1"]),
        ]:
            with (
                self.subTest(ports=ports, values=values),
                patch.object(server.sys, "platform", "darwin"),
                patch.object(server.subprocess, "check_output", side_effect=[ports, *values]),
                patch.object(server.socket, "socket") as udp,
            ):
                udp.return_value.__enter__.return_value.getsockname.return_value = ("192.168.1.2", 12345)
                self.assertEqual(server.lan_host(), "192.168.1.2")

    def test_explicit_share_base_and_loopback_do_not_probe_interfaces(self):
        with (
            patch.dict(server.os.environ, {"FIELDROOM_BASE_URL": "http://fieldroom.local:8765/"}),
            patch.object(server, "lan_host") as probe,
        ):
            self.assertEqual(server.share_base("0.0.0.0", 8765), "http://fieldroom.local:8765")
            probe.assert_not_called()
        with (
            patch.dict(server.os.environ, {"FIELDROOM_BASE_URL": ""}),
            patch.object(server, "lan_host") as probe,
        ):
            self.assertEqual(server.share_base("127.0.0.1", 8765), "http://127.0.0.1:8765")
            probe.assert_not_called()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.db = Path(self.directory.name) / "local.sqlite3"
        server.initialize(self.db)
        httpd = server.FieldServer(("127.0.0.1", 0), server.Handler)
        self.base = f"http://127.0.0.1:{httpd.server_port}"
        httpd.base, httpd.db = self.base, self.db
        worker = threading.Thread(
            target=httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        worker.start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        self.admin = self.call("/api/create", {"title": "虚构的游戏研究", "count": 6})["admin"]
        self.state = self.call("/api/manage", key=self.admin)
        self.cards = self.state["players"]
        self.form = self.state["forms"][0]
        self.rating, self.choice = self.form["questions"]
        self.key = self.claim(self.cards[0])

    def call(self, route, body=None, key=None):
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = "Bearer " + key
        request = urllib.request.Request(
            self.base + route, json.dumps(body).encode() if body is not None else None, headers=headers
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            exc.close()
            raise

    def claim(self, card):
        return self.call("/api/claim", {"code": card["code"]})["device"]

    def manage(self, **body):
        return self.call("/api/manage/action", body, self.admin)

    def play(self, **body):
        return self.call("/api/play/action", body, self.key)

    def detail(self, query=""):
        return self.call("/api/manage/player?id=" + self.cards[0]["id"] + query, key=self.admin)

    def submitted(self):
        self.manage(op="open", form=self.form["id"])
        self.play(op="answer", qid=self.rating["id"], value="2")
        self.play(op="answer", qid=self.choice["id"], value=self.choice["options"][0])
        self.play(op="submit", form=self.form["id"])

    def test_takeover_invalidates_stale_writes_even_after_reopen(self):
        self.submitted()
        self.play(op="note", id="stable-note", text="虚构草稿", submitted=False)
        self.manage(op="show", qid=self.rating["id"], players=[self.cards[0]["id"]])
        other_key = self.claim(self.cards[1])
        self.assertIsNone(self.call("/api/play", key=other_key)["live"])
        replacement = self.claim(self.cards[0])
        recovered = self.call("/api/play", key=replacement)
        self.assertEqual(recovered["live"]["value"], "2")
        self.assertEqual(recovered["notes"][0]["text"], "虚构草稿")
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.play(op="answer", qid=self.rating["id"], value="5")
        self.assertEqual(error.exception.code, 401)
        self.key = replacement
        with self.assertRaises(urllib.error.HTTPError):
            self.manage(op="seal")
        self.manage(op="end")
        self.manage(op="seal")
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.play(op="answer", qid=self.rating["id"], value="5")
        self.assertEqual(error.exception.code, 409)
        self.manage(op="reopen")
        self.play(op="answer", qid=self.rating["id"], value="3")
        self.assertEqual(self.detail()["answers"][self.rating["id"]], "3")

    def test_submission_snapshots_supplements_and_concurrent_retries(self):
        self.submitted()
        self.manage(
            op="supplement",
            player=self.cards[0]["id"],
            qid=self.rating["id"],
            score="4",
            reason="第二局更熟练",
        )
        self.assertEqual(self.detail()["answers"][self.rating["id"]], "2")
        updated = [{**self.rating, "label": "你现在有多愿意继续？"}, self.choice]
        self.manage(op="form", form=self.form["id"], title="新版", questions=updated, expectedVersion=1)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.manage(
                op="form", form=self.form["id"], title="过时编辑", questions=updated, expectedVersion=1
            )
        self.assertEqual(error.exception.code, 409)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(
                pool.map(
                    lambda _: self.play(
                        op="answer", qid=self.rating["id"], value="3", requestId="retry"
                    ),
                    range(6),
                )
            )
        self.assertTrue(all(result["ok"] for result in results))
        detail = self.detail()
        changes = [record for record in detail["history"] if record["qid"] == self.rating["id"]]
        self.assertEqual(
            [(r["label"], r["value"]) for r in changes],
            [(updated[0]["label"], "3"), (self.rating["label"], "2")],
        )
        self.assertEqual(len(detail["supplements"]), 1)

    def test_removed_question_remains_in_submitted_player_snapshot(self):
        self.submitted()
        self.manage(
            op="form",
            form=self.form["id"],
            title="初次体验（调整）",
            questions=[self.choice],
            expectedVersion=1,
        )
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.play(
                op="answer", qid=self.choice["id"], value=self.choice["options"][1], expectedVersion=1
            )
        self.assertEqual(error.exception.code, 409)
        data = self.call("/api/play", key=self.key)
        current = [q["id"] for q in data["forms"][0]["questions"]]
        self.assertNotIn(self.rating["id"], current)
        original = next(q for q in data["snapshots"] if q["qid"] == self.rating["id"])
        self.assertEqual(
            (original["form"], original["label"], original["value"]),
            (self.form["id"], self.rating["label"], "2"),
        )

    def test_different_sessions_have_independent_rosters_and_live_questions(self):
        other_admin = self.call("/api/create", {"title": "另一场虚构测试", "count": 1})["admin"]
        other = self.call("/api/manage", key=other_admin)
        other_player = other["players"][0]["id"]
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.manage(op="show", qid=self.rating["id"], players=[other_player])
        self.assertEqual(error.exception.code, 404)
        self.assertIsNone(self.call("/api/manage", key=self.admin)["live"])
        self.assertIsNone(self.call("/api/manage", key=other_admin)["live"])

    def test_unsubmitted_player_qr_and_validation(self):
        self.manage(op="open", form=self.form["id"])
        self.play(op="answer", qid=self.rating["id"], value="4")
        with self.assertRaises(urllib.error.HTTPError):
            self.play(op="submit", form=self.form["id"])
        with self.assertRaises(urllib.error.HTTPError):
            self.play(op="answer", qid=self.rating["id"], value="6")
        self.manage(op="show", qid=self.rating["id"], players=[self.cards[0]["id"]])
        self.assertIsNone(self.call("/api/play", key=self.key)["live"]["value"])
        qr = self.call("/api/manage/qr", {"player": self.cards[0]["id"]}, self.admin)
        self.assertIn("<svg", qr["svg"])
        self.assertNotIn("http://127.0.0.1:", qr["svg"])

    def test_two_active_groups_have_scoped_answers_revisions_and_end(self):
        self.submitted()
        second_key = self.claim(self.cards[1])
        third_key = self.claim(self.cards[2])
        first, second = (card["id"] for card in self.cards[:2])
        a = self.manage(op="show", interview=None, qid=self.rating["id"], players=[first])["interview"]
        before = self.call("/api/rev", key=self.key)
        other_rev = self.call("/api/rev", key=third_key)
        b = self.manage(op="show", interview=None, qid=self.choice["id"], players=[second])["interview"]
        self.assertEqual(self.call("/api/rev", key=self.key), before)
        self.assertEqual(self.call("/api/rev", key=third_key), other_rev)
        self.assertEqual(self.call("/api/play", key=self.key)["live"]["value"], "2")
        self.assertEqual(self.call("/api/play", key=second_key)["live"]["interviewId"], b)
        self.assertIsNone(self.call("/api/play", key=second_key)["live"]["value"])
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.manage(op="end")
        self.assertEqual(error.exception.code, 409)
        for pid in [first, second]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.manage(
                    op="supplement", interview=b, player=pid, qid=self.rating["id"], reason="过时的补充"
                )
            self.assertEqual(error.exception.code, 409)
        self.manage(
            op="supplement", interview=a, player=first, qid=self.rating["id"], reason="原评分的原因"
        )
        self.assertEqual(self.detail()["supplements"][0]["interview"], a)
        self.manage(op="form", form=self.form["id"], title="新版", questions=[self.choice])
        self.assertIsNone(self.call("/api/play", key=self.key)["live"])
        self.assertEqual(self.call("/api/play", key=second_key)["live"]["interviewId"], b)
        for command in [
            dict(op="end", interview=a),
            dict(op="show", interview=a, qid=self.choice["id"], players=[first]),
            dict(op="supplement", interview=a, player=first, qid=self.rating["id"], reason="已结束"),
            dict(op="seal"),
        ]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.manage(**command)
            self.assertEqual(error.exception.code, 409)
        self.manage(op="end", interview=b)
        self.manage(op="seal")
        self.assertTrue(self.call("/api/manage", key=self.admin)["sealed"])

    def test_concurrent_group_claim_and_idempotent_creation(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.manage(op="show", interview=None, qid=self.rating["id"], players=[self.cards[0]["id"]])
        self.assertEqual(error.exception.code, 409)
        self.manage(op="open", form=self.form["id"])
        barrier = threading.Barrier(2)
        target = self.cards[0]["id"]

        def start(q):
            barrier.wait(timeout=5)
            try:
                return self.manage(
                    op="show",
                    interview=None,
                    qid=q["id"],
                    players=[target],
                    requestId="start-" + q["id"],
                )
            except urllib.error.HTTPError as error:
                return error.code

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(start, [self.rating, self.choice]))
        self.assertEqual(sum(r == 409 for r in results), 1)
        groups = self.call("/api/manage", key=self.admin)["interviews"]
        self.assertEqual(len(groups), 1)
        group = groups[0]
        retried = self.manage(
            op="show",
            interview=None,
            qid=group["qid"],
            players=[target],
            requestId="start-" + group["qid"],
        )
        self.assertEqual(retried, {"ok": True, "interview": group["id"]})
        b = self.manage(op="show", interview=None, qid=self.choice["id"], players=[self.cards[1]["id"]])[
            "interview"
        ]
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.manage(op="show", interview=b, qid=self.choice["id"], players=[target])
        self.assertEqual(error.exception.code, 409)
        self.assertEqual(
            [g["players"] for g in self.call("/api/manage", key=self.admin)["interviews"]],
            [[target], [self.cards[1]["id"]]],
        )

    def test_old_database_active_interview_and_receipt_survive_upgrade(self):
        self.submitted()
        old_live = dict(qid=self.rating["id"], players=[self.cards[0]["id"]])
        with server.connection(self.db, write=True) as db:
            db.execute("UPDATE rooms SET live=? WHERE admin=?", (server.dump(old_live), self.admin))
            db.execute("DROP TABLE receipts")
            db.execute(
                "CREATE TABLE receipts (actor TEXT NOT NULL,request_id TEXT NOT NULL, PRIMARY KEY(actor,request_id))"
            )
            db.execute("INSERT INTO receipts VALUES(?,?)", (self.key, "old-write"))
            db.execute("DROP TABLE supplements")
            db.execute(
                "CREATE TABLE supplements (id INTEGER PRIMARY KEY,player TEXT NOT NULL REFERENCES players(id),qid TEXT NOT NULL,label TEXT NOT NULL,score TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL)"
            )
            db.execute(
                "INSERT INTO supplements(player,qid,label,score,reason,at) VALUES(?,?,?,?,?,?)",
                (
                    self.cards[0]["id"],
                    self.rating["id"],
                    self.rating["label"],
                    "4",
                    "旧版访谈记录",
                    server.timestamp(),
                ),
            )
        server.initialize(self.db)
        group = self.call("/api/manage", key=self.admin)["interviews"][0]
        self.assertEqual(self.call("/api/play", key=self.key)["live"]["interviewId"], group["id"])
        self.assertEqual(self.detail()["supplements"][0]["reason"], "旧版访谈记录")
        self.assertIsNone(self.detail()["supplements"][0]["interview"])
        self.play(op="answer", qid=self.rating["id"], value="5", requestId="old-write")
        self.assertEqual(self.detail()["answers"][self.rating["id"]], "2")
        server.initialize(self.db)
        self.assertEqual(self.call("/api/manage", key=self.admin)["interviews"][0]["id"], group["id"])
        self.manage(op="show", interview=None, qid=self.choice["id"], players=[self.cards[1]["id"]])
        self.manage(op="show", interview=group["id"], qid=self.choice["id"], players=old_live["players"])
        self.assertEqual(len(self.call("/api/manage", key=self.admin)["interviews"]), 2)

    def test_long_history_is_indexed_paged_and_excluded_from_player_reads(self):
        self.submitted()
        with server.connection(self.db, write=True) as db:
            row = db.execute("SELECT player,form,qid,snapshot,value,at FROM history LIMIT 1").fetchone()
            db.executemany(
                "INSERT INTO history(player,form,qid,snapshot,value,at) VALUES(?,?,?,?,?,?)",
                (tuple(row) for _ in range(10000)),
            )
            plan = db.execute(
                "EXPLAIN QUERY PLAN SELECT * FROM history WHERE player=? AND id<? ORDER BY id DESC LIMIT 51",
                (row["player"], 5000),
            ).fetchall()
            self.assertIn("history_player", " ".join(p["detail"] for p in plan))
        first = self.detail()
        second = self.detail("&beforeHistory=" + str(first["nextHistory"]))
        self.assertEqual(len(first["history"]), 50)
        self.assertEqual(len(second["history"]), 50)
        self.assertLess(second["history"][0]["id"], first["history"][-1]["id"])
        self.assertNotIn("history", self.call("/api/play", key=self.key))


if __name__ == "__main__":
    unittest.main()
