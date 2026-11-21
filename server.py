#!/usr/bin/env python3
"""Fieldroom local survey service. All sessions and responses stay in SQLite."""

import argparse
import datetime as dt
import io
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import socket
import sqlite3
import subprocess
import sys
from contextlib import closing, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import segno

ROOT = Path(__file__).resolve().parent
DEFAULT_DB = ROOT / "data" / "fieldroom.sqlite3"


def token():
    return secrets.token_urlsafe(24)


def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class Problem(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def require(condition, message, status=400):
    if not condition:
        raise Problem(status, message)


def short(value, name, limit=200):
    require(
        isinstance(value, str) and len(value.strip()) > 0 and len(value) <= limit,
        f"{name}不能为空且最多 {limit} 字",
    )
    return value.strip()


@contextmanager
def connection(path, *, write=False):
    db = sqlite3.connect(path, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "Fieldroom/1"

    def log_message(self, *_args):
        # Access URLs, request bodies and headers may carry room capabilities.
        pass

    def send_payload(self, status, data=b"", mime="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def dispatch(self, method):
        try:
            url = urlsplit(self.path)
            data = {}
            if method == "POST":
                origin = self.headers.get("Origin")
                require(
                    not origin or urlsplit(origin).netloc == self.headers.get("Host"),
                    "请求来源与现场服务不一致",
                    403,
                )
                require(self.headers.get_content_type() == "application/json", "需要 JSON 请求", 415)
                length = int(self.headers.get("Content-Length", "0"))
                require(0 < length <= 2_000_000, "请求内容大小无效", 413)
                data = json.loads(self.rfile.read(length))
                require(isinstance(data, dict), "需要 JSON 对象")
            result = handle(self, method, url.path, parse_qs(url.query), data)
            if result is not None:
                self.send_payload(200, dump(result).encode())
        except Problem as exc:
            self.send_payload(exc.status, dump({"error": str(exc)}).encode())
        except (ValueError, TypeError, KeyError, OverflowError):
            self.send_payload(400, dump({"error": "输入格式有误，请检查后重试"}).encode())
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            # Keep request secrets and user data out of logs.
            print(f"Service error: {type(exc).__name__}", file=sys.stderr)
            self.send_payload(500, dump({"error": "现场服务暂时不可用，请重试"}).encode())


class FieldServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128


def lan_host():
    # A VPN can own the default route while wireless peers use the Wi-Fi IP.
    if sys.platform == "darwin":
        try:
            ports = subprocess.check_output(
                ["/usr/sbin/networksetup", "-listallhardwareports"],
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=2,
            )
            wifi = re.search(r"Hardware Port: (?:Wi-Fi|AirPort)\nDevice: (\w+)", ports)
            if wifi:
                candidate = subprocess.check_output(
                    ["/usr/sbin/ipconfig", "getifaddr", wifi[1]],
                    text=True,
                    stderr=subprocess.DEVNULL,
                    timeout=2,
                ).strip()
                ip = ipaddress.IPv4Address(candidate)
                if not (ip.is_unspecified or ip.is_loopback or ip.is_multicast):
                    return str(ip)
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
            udp.connect(("192.0.2.1", 9))
            return udp.getsockname()[0]
    except OSError:
        return "127.0.0.1"


SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms (
 id TEXT PRIMARY KEY, admin TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
 sealed INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 1,
 live TEXT
);
CREATE TABLE IF NOT EXISTS forms (
 id TEXT PRIMARY KEY, room TEXT NOT NULL REFERENCES rooms(id), position INTEGER NOT NULL,
 title TEXT NOT NULL, opened INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
 questions TEXT NOT NULL, UNIQUE(room,position)
);
CREATE TABLE IF NOT EXISTS players (
 id TEXT PRIMARY KEY, room TEXT NOT NULL REFERENCES rooms(id), position INTEGER NOT NULL,
 name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, device TEXT UNIQUE,
 rev INTEGER NOT NULL DEFAULT 1, UNIQUE(room,position)
);
CREATE TABLE IF NOT EXISTS submissions (
 player TEXT NOT NULL REFERENCES players(id), form TEXT NOT NULL REFERENCES forms(id),
 at TEXT NOT NULL, PRIMARY KEY(player,form)
);
CREATE TABLE IF NOT EXISTS answers (
 player TEXT NOT NULL REFERENCES players(id), qid TEXT NOT NULL, value TEXT NOT NULL,
 snapshot TEXT NOT NULL, PRIMARY KEY(player,qid)
);
CREATE TABLE IF NOT EXISTS history (
 id INTEGER PRIMARY KEY, player TEXT NOT NULL REFERENCES players(id), form TEXT NOT NULL,
 qid TEXT NOT NULL, snapshot TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS history_player ON history(player,id);
CREATE INDEX IF NOT EXISTS history_question ON history(player,qid,id);
CREATE TABLE IF NOT EXISTS notes (
 player TEXT NOT NULL REFERENCES players(id), id TEXT NOT NULL, text TEXT NOT NULL,
 submitted INTEGER NOT NULL, PRIMARY KEY(player,id)
);
CREATE TABLE IF NOT EXISTS supplements (
 id INTEGER PRIMARY KEY, player TEXT NOT NULL REFERENCES players(id), qid TEXT NOT NULL,
 label TEXT NOT NULL, score TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS supplements_player ON supplements(player,id);
CREATE TABLE IF NOT EXISTS receipts (
 actor TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY(actor,request_id)
);
"""


def initialize(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(SCHEMA)
    path.chmod(0o600)


def identifier():
    return secrets.token_hex(10)


def question(label, kind, options=None, required=True):
    return dict(id=identifier(), label=label, type=kind, options=options or [], required=required)


def create_room(db, data):
    title = short(data.get("title"), "场次名称", 100)
    count = data.get("count", 6)
    require(type(count) is int and 1 <= count <= 200, "玩家人数需为 1 至 200")
    room, admin = identifier(), token()
    db.execute("INSERT INTO rooms(id,admin,title) VALUES(?,?,?)", (room, admin, title))
    forms = [
        (
            "初次体验",
            [
                question("你有多愿意再玩一局？", "rating"),
                question("第一局中，你最留意哪个环节？", "choice", ["探索地图", "收集道具", "完成挑战"]),
            ],
        ),
        (
            "深入体验",
            [
                question("第二局的操作有多顺手？", "rating"),
                question("哪一步最需要提示？", "text", required=False),
            ],
        ),
        (
            "体验回顾",
            [
                question("你最想再次体验哪个环节？", "choice", ["探索地图", "收集道具", "完成挑战"]),
                question("如果可以改一个地方，你会改什么？", "text", required=False),
            ],
        ),
    ]
    for pos, (name, questions) in enumerate(forms):
        db.execute(
            "INSERT INTO forms(id,room,position,title,questions) VALUES(?,?,?,?,?)",
            (identifier(), room, pos, name, dump(questions)),
        )
    for pos in range(count):
        name = chr(65 + pos) if pos < 26 else str(pos + 1)
        db.execute(
            "INSERT INTO players(id,room,position,name,code) VALUES(?,?,?,?,?)",
            (identifier(), room, pos, "玩家 " + name, token()),
        )
    return {"admin": admin}


def room_forms(db, room, opened_only=False):
    sql = "SELECT * FROM forms WHERE room=?" + (" AND opened=1" if opened_only else "")
    return [
        dict(
            id=r["id"],
            title=r["title"],
            open=bool(r["opened"]),
            version=r["version"],
            questions=json.loads(r["questions"]),
        )
        for r in db.execute(sql + " ORDER BY position", (room,))
    ]


def find_form(db, room, fid):
    form = db.execute("SELECT * FROM forms WHERE room=? AND id=?", (room, fid)).fetchone()
    require(form, "找不到该问卷", 404)
    return form


def find_question(db, room, qid):
    for form in room_forms(db, room):
        for q in form["questions"]:
            if q["id"] == qid:
                return form, q
    raise Problem(404, "找不到该题，问卷可能已更新")


def changed(db, room, player=None):
    db.execute("UPDATE rooms SET rev=rev+1 WHERE id=?", (room,))
    if player is None:
        db.execute("UPDATE players SET rev=rev+1 WHERE room=?", (room,))
    else:
        db.execute("UPDATE players SET rev=rev+1 WHERE id=?", (player,))


def submissions(db, player):
    return [
        r[0] for r in db.execute("SELECT form FROM submissions WHERE player=? ORDER BY at", (player,))
    ]


def player_record(db, player, *, include_history=False, before_history=None):
    answers = {}
    snapshots = []
    for row in db.execute("SELECT qid,value,snapshot FROM answers WHERE player=?", (player,)):
        qid, value = row["qid"], row["value"]
        answers[qid] = value
        q = json.loads(row["snapshot"])
        if "form" not in q:
            # Read records created before form IDs were included in snapshots.
            prev = db.execute(
                "SELECT form FROM history WHERE player=? AND qid=? ORDER BY id DESC LIMIT 1",
                (player, qid),
            ).fetchone()
            if prev:
                q.update(form=prev["form"], submitted=True)
        if q.get("submitted"):
            snapshots.append(dict(**q, qid=qid, value=value))
    notes = [
        dict(id=r["id"], text=r["text"], submitted=bool(r["submitted"]))
        for r in db.execute("SELECT * FROM notes WHERE player=? ORDER BY rowid", (player,))
    ]
    result = dict(answers=answers, submitted=submissions(db, player), notes=notes, snapshots=snapshots)
    if include_history:
        sql = "SELECT * FROM history WHERE player=?"
        params = [player]
        if before_history is not None:
            sql += " AND id<?"
            params.append(before_history)
        page = db.execute(sql + " ORDER BY id DESC LIMIT 51", params).fetchall()
        history = []
        for r in page[:50]:
            q = json.loads(r["snapshot"])
            history.append(
                dict(
                    id=r["id"],
                    qid=r["qid"],
                    form=r["form"],
                    label=q["label"],
                    question=q,
                    value=r["value"],
                    at=r["at"],
                )
            )
        result["history"] = history
        result["nextHistory"] = history[-1]["id"] if len(page) > 50 else None
        result["supplements"] = [
            dict(r)
            for r in db.execute(
                "SELECT qid,label,score,reason,at FROM supplements WHERE player=? ORDER BY id", (player,)
            )
        ]
    return result


def managed_player(db, room, player):
    row = db.execute("SELECT * FROM players WHERE room=? AND id=?", (room, player)).fetchone()
    require(row, "找不到该玩家", 404)
    return row


def manage_state(db, room, base):
    by_player = {}
    for r in db.execute(
        "SELECT s.player,s.form FROM players p JOIN submissions s ON s.player=p.id WHERE p.room=?",
        (room["id"],),
    ):
        by_player.setdefault(r["player"], []).append(r["form"])
    players = [
        dict(id=p["id"], name=p["name"], code=p["code"], submitted=by_player.get(p["id"], []))
        for p in db.execute("SELECT * FROM players WHERE room=? ORDER BY position", (room["id"],))
    ]
    return dict(
        id=room["id"],
        title=room["title"],
        sealed=bool(room["sealed"]),
        rev=room["rev"],
        forms=room_forms(db, room["id"]),
        players=players,
        live=json.loads(room["live"] or "null"),
        base=base,
    )


def play_state(db, room, player):
    data = player_record(db, player["id"])
    forms = room_forms(db, room["id"], True)
    live = json.loads(room["live"] or "null")
    event = None
    if live and player["id"] in live["players"]:
        form, q = find_question(db, room["id"], live["qid"])
        original = (
            db.execute(
                "SELECT value,snapshot FROM answers WHERE player=? AND qid=?", (player["id"], q["id"])
            ).fetchone()
            if form["id"] in data["submitted"]
            else None
        )
        event = dict(
            qid=q["id"],
            label=json.loads(original["snapshot"])["label"] if original else q["label"],
            form=form["id"],
            value=(original["value"] or None) if original else None,
        )
    return dict(
        **data,
        id=player["id"],
        name=player["name"],
        title=room["title"],
        sealed=bool(room["sealed"]),
        rev=player["rev"],
        forms=forms,
        live=event,
    )


def validate_questions(questions, previous):
    require(isinstance(questions, list) and 1 <= len(questions) <= 200, "每份问卷需要 1 至 200 道题")
    existing = {q["id"] for q in previous}
    seen = set()
    result = []
    for item in questions:
        require(isinstance(item, dict), "题目格式无效")
        qid = item.get("id") or identifier()
        require(not item.get("id") or qid in existing, "请刷新后再编辑题目", 409)
        require(qid not in seen, "问卷中有重复的题目编号")
        seen.add(qid)
        label = short(item.get("label"), "题干", 2000)
        kind = item.get("type")
        require(kind in ("rating", "choice", "text"), "未知题型")
        options = []
        if kind == "choice":
            values = item.get("options")
            require(isinstance(values, list) and 2 <= len(values) <= 100, "选择题需要 2 至 100 个选项")
            options = [short(v, "选项", 500) for v in values]
            require(len(set(options)) == len(options), "选项不可重复")
        required = item.get("required", True)
        require(type(required) is bool, "请指定题目是否必答")
        result.append(dict(id=qid, label=label, type=kind, options=options, required=required))
    return result


def manage_action(db, room, body):
    rid = room["id"]
    op = body.get("op")
    require(not room["sealed"] or op in ("seal", "reopen"), "场次已封存，请先重新开放", 409)
    if op in ("seal", "reopen"):
        sealed = op == "seal"
        require(not sealed or room["live"] is None, "请先结束访谈，再封存场次", 409)
        if bool(room["sealed"]) == sealed:
            return
        db.execute("UPDATE rooms SET sealed=?,live=NULL WHERE id=?", (sealed, rid))
    elif op == "end":
        if room["live"] is None:
            return
        db.execute("UPDATE rooms SET live=NULL WHERE id=?", (rid,))
    elif op == "open":
        form = find_form(db, rid, body.get("form"))
        if form["opened"]:
            return
        previous = db.execute(
            "SELECT 1 FROM forms WHERE room=? AND position<? AND opened=0", (rid, form["position"])
        ).fetchone()
        require(not previous, "请按顺序开放问卷", 409)
        db.execute("UPDATE forms SET opened=1 WHERE id=?", (form["id"],))
    elif op == "form":
        form = find_form(db, rid, body.get("form"))
        version = body.get("expectedVersion")
        if version is not None:
            require(version == form["version"], "其他人已修改这份问卷，请刷新后重试", 409)
        elif body.get("expectedRev") is not None:
            require(body["expectedRev"] == room["rev"], "场次已有更新，请刷新后重试", 409)
        title = short(body.get("title"), "问卷名称", 200)
        questions = validate_questions(body.get("questions"), json.loads(form["questions"]))
        live = json.loads(room["live"] or "null")
        if live and any(q["id"] == live["qid"] for q in json.loads(form["questions"])):
            if not any(q["id"] == live["qid"] for q in questions):
                db.execute("UPDATE rooms SET live=NULL WHERE id=?", (rid,))
        db.execute(
            "UPDATE forms SET title=?,questions=?,version=version+1 WHERE id=?",
            (title, dump(questions), form["id"]),
        )
    elif op == "show":
        _, q = find_question(db, rid, body.get("qid"))
        ids = body.get("players")
        require(isinstance(ids, list) and 1 <= len(ids) <= 6, "每次访谈请选择 1 至 6 位玩家")
        require(len(ids) == len(set(ids)), "请勿重复选择受访者")
        for pid in ids:
            managed_player(db, rid, pid)
        db.execute("UPDATE rooms SET live=? WHERE id=?", (dump(dict(qid=q["id"], players=ids)), rid))
    elif op == "supplement":
        pid = managed_player(db, rid, body.get("player"))["id"]
        _, q = find_question(db, rid, body.get("qid"))
        reason = short(body.get("reason"), "访谈补充", 20000)
        score = body.get("score", "")
        require(
            score == "" or (q["type"] == "rating" and score in ("1", "2", "3", "4", "5")),
            "补充评分超出范围",
        )
        db.execute(
            "INSERT INTO supplements(player,qid,label,score,reason,at) VALUES(?,?,?,?,?,?)",
            (pid, q["id"], q["label"], score, reason, timestamp()),
        )
        # Only researchers see supplements; player screens need not refresh.
        db.execute("UPDATE rooms SET rev=rev+1 WHERE id=?", (rid,))
        return
    else:
        raise Problem(400, "未知操作")
    changed(db, rid)


def check_value(q, value, final):
    require(isinstance(value, str) and len(value) <= 20000, "答案需为不超过 20000 字的文字")
    if not value.strip():
        require(not final or not q["required"], f"请先回答「{q['label']}」")
    elif q["type"] == "rating":
        require(value in ("1", "2", "3", "4", "5"), "请选择 1 至 5 分")
    elif q["type"] == "choice":
        require(value in q["options"], f"请重选「{q['label']}」的有效选项")


def snapshot(form, q, submitted):
    return dict(
        **q,
        form=form["id"],
        formTitle=form["title"],
        formVersion=form["version"],
        submitted=bool(submitted),
    )


def record_history(db, pid, fid, q, value, at):
    db.execute(
        "INSERT INTO history(player,form,qid,snapshot,value,at) VALUES(?,?,?,?,?,?)",
        (pid, fid, q["id"], dump(q), value, at),
    )


def play_action(db, room, player, body):
    require(not room["sealed"], "场次已封存，仅供回看", 409)
    rid, pid, op = room["id"], player["id"], body.get("op")
    if op == "answer":
        form, q = find_question(db, rid, body.get("qid"))
        require(form["open"], "这份问卷尚未开放", 409)
        version = body.get("expectedVersion")
        require(version is None or version == form["version"], "题目已更新，请重新查看", 409)
        submitted = db.execute(
            "SELECT 1 FROM submissions WHERE player=? AND form=?", (pid, form["id"])
        ).fetchone()
        value = body.get("value")
        check_value(q, value, bool(submitted))
        s = snapshot(form, q, submitted)
        old = db.execute(
            "SELECT value,snapshot FROM answers WHERE player=? AND qid=?", (pid, q["id"])
        ).fetchone()
        if old and value == old["value"] and dump(s) == old["snapshot"]:
            return
        db.execute(
            "INSERT INTO answers(player,qid,value,snapshot) VALUES(?,?,?,?) "
            "ON CONFLICT(player,qid) DO UPDATE SET value=excluded.value,snapshot=excluded.snapshot",
            (pid, q["id"], value, dump(s)),
        )
        if submitted:
            record_history(db, pid, form["id"], s, value, timestamp())
    elif op == "submit":
        form = find_form(db, rid, body.get("form"))
        require(form["opened"], "这份问卷尚未开放", 409)
        if db.execute(
            "SELECT 1 FROM submissions WHERE player=? AND form=?", (pid, form["id"])
        ).fetchone():
            return
        version = body.get("expectedVersion")
        require(version is None or version == form["version"], "问卷已更新，请重新查看后交卷", 409)
        answers = {
            r["qid"]: r["value"]
            for r in db.execute("SELECT qid,value FROM answers WHERE player=?", (pid,))
        }
        at = timestamp()
        for q in json.loads(form["questions"]):
            value = answers.get(q["id"], "")
            check_value(q, value, True)
            s = snapshot(form, q, True)
            record_history(db, pid, form["id"], s, value, at)
            db.execute(
                "INSERT INTO answers(player,qid,value,snapshot) VALUES(?,?,?,?) "
                "ON CONFLICT(player,qid) DO UPDATE SET snapshot=excluded.snapshot",
                (pid, q["id"], value, dump(s)),
            )
        db.execute("INSERT INTO submissions VALUES(?,?,?)", (pid, form["id"], at))
    elif op == "note":
        note_id = short(body.get("id"), "记录编号", 128)
        value = body.get("text")
        submitted = body.get("submitted")
        require(isinstance(value, str) and len(value) <= 20000, "体验问题限 20000 字")
        require(type(submitted) is bool, "体验问题状态无效")
        require(not submitted or value.strip(), "请先填写体验问题")
        prev = db.execute(
            "SELECT text,submitted FROM notes WHERE player=? AND id=?", (pid, note_id)
        ).fetchone()
        if prev and bool(prev["submitted"]) == submitted and prev["text"] == value:
            return
        require(not prev or not prev["submitted"] or submitted, "已提交的体验问题不能恢复为草稿", 409)
        db.execute(
            "INSERT INTO notes(player,id,text,submitted) VALUES(?,?,?,?) "
            "ON CONFLICT(player,id) DO UPDATE SET text=excluded.text,submitted=excluded.submitted",
            (pid, note_id, value, submitted),
        )
    else:
        raise Problem(400, "未知操作")
    changed(db, rid, pid)


def mutate_once(db, actor, body, fn):
    request_id = body.get("requestId")
    if request_id is not None:
        short(request_id, "操作编号", 128)
        if db.execute(
            "SELECT 1 FROM receipts WHERE actor=? AND request_id=?", (actor, request_id)
        ).fetchone():
            return {"ok": True}
    fn()
    if request_id is not None:
        db.execute("INSERT INTO receipts VALUES(?,?)", (actor, request_id))
    return {"ok": True}


def handle(h, method, path, query, body):
    server = h.server
    if method == "GET" and path == "/api/base":
        return {"base": server.base}
    if not path.startswith("/api/"):
        require(method == "GET", "请求方式无效", 405)
        if path in ("/", "/manage", "/play", "/join"):
            asset = ROOT / "static" / "index.html"
        else:
            require(path.startswith("/static/"), "页面不存在", 404)
            asset = (ROOT / path.lstrip("/")).resolve()
            require(asset.is_relative_to(ROOT / "static"), "页面不存在", 404)
        require(asset.is_file(), "页面不存在", 404)
        mime = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
        h.send_payload(200, asset.read_bytes(), mime)
        return
    key = h.headers.get("Authorization", "").removeprefix("Bearer ")
    with connection(server.db, write=(method == "POST" and path != "/api/manage/qr")) as db:
        if method == "POST" and path == "/api/create":
            return create_room(db, body)
        if method == "POST" and path == "/api/claim":
            player = db.execute("SELECT * FROM players WHERE code=?", (body.get("code"),)).fetchone()
            require(player, "玩家卡无效，请重新扫码", 401)
            device = token()
            db.execute("UPDATE players SET device=? WHERE id=?", (device, player["id"]))
            # Obsolete leases are checked before any replay receipt or write.
            if player["device"]:
                db.execute("DELETE FROM receipts WHERE actor=?", (player["device"],))
            return {"device": device}
        require(bool(key), "需要有效的入场链接", 401)
        if path == "/api/rev" and method == "GET":
            row = db.execute(
                "SELECT rev FROM rooms WHERE admin=? UNION ALL SELECT rev FROM players WHERE device=?",
                (key, key),
            ).fetchone()
            require(row, "本设备已退出，请重新扫码", 401)
            return {"rev": row["rev"]}
        if path.startswith("/api/manage"):
            room = db.execute("SELECT * FROM rooms WHERE admin=?", (key,)).fetchone()
            require(room, "管理链接无效", 401)
            if path == "/api/manage" and method == "GET":
                return manage_state(db, room, server.base)
            if path == "/api/manage/player" and method == "GET":
                pid = managed_player(db, room["id"], query.get("id", [None])[0])["id"]
                before = query.get("beforeHistory", [""])[0]
                return player_record(
                    db, pid, include_history=True, before_history=int(before) if before else None
                )
            if path == "/api/manage/action" and method == "POST":
                return mutate_once(db, key, body, lambda: manage_action(db, room, body))
            if path == "/api/manage/qr" and method == "POST":
                p = managed_player(db, room["id"], body.get("player"))
                buffer = io.BytesIO()
                segno.make_qr(server.base + "/play#" + p["code"], error="m").save(
                    buffer, kind="svg", scale=5, xmldecl=False, svgns=True
                )
                return {"svg": buffer.getvalue().decode()}
        elif path.startswith("/api/play"):
            player = db.execute("SELECT * FROM players WHERE device=?", (key,)).fetchone()
            require(player, "本设备已退出，请重新扫码", 401)
            room = db.execute("SELECT * FROM rooms WHERE id=?", (player["room"],)).fetchone()
            if path == "/api/play" and method == "GET":
                return play_state(db, room, player)
            if path == "/api/play/action" and method == "POST":
                return mutate_once(db, key, body, lambda: play_action(db, room, player, body))
        raise Problem(404, "接口不存在")


def share_base(bind_host, port):
    explicit = os.environ.get("FIELDROOM_BASE_URL", "").strip().rstrip("/")
    if explicit:
        return explicit
    address = lan_host() if bind_host == "0.0.0.0" else bind_host
    return f"http://{address}:{port}"


def main():
    parser = argparse.ArgumentParser(description="本地线下游戏用研问卷平台")
    parser.add_argument("--host", default="0.0.0.0", help="默认在局域网提供服务")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()
    os.umask(0o077)
    initialize(args.db)
    server = FieldServer((args.host, args.port), Handler)
    server.db = args.db
    server.base = share_base(args.host, server.server_port)
    print(f"Fieldroom: {server.base}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
