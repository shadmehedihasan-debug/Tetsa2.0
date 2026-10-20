"""Incidents (SQLite) and their photos (data/incidents/<id>/). Old ones are deleted automatically."""
import shutil, sqlite3, threading, time
from datetime import datetime, timedelta
import config as C

KINDS = ("scene", "object", "person")

class Store:
    def __init__(self):
        C.DATA_DIR.mkdir(exist_ok=True)
        (C.DATA_DIR / "incidents").mkdir(exist_ok=True)
        self.db = sqlite3.connect(C.DATA_DIR / "tetsa.db", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        self.db.execute("""CREATE TABLE IF NOT EXISTS incidents(id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, camera TEXT, label TEXT, conf REAL, status TEXT, risk INTEGER, summary TEXT,
            source TEXT, notify TEXT DEFAULT 'none', sent INTEGER DEFAULT 1)""")
        self.cleanup()

    def _q(self, sql, *a):
        with self.lock:
            cur = self.db.execute(sql, a); self.db.commit(); return cur

    def create(self, label, conf, jpegs):
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        iid = self._q("INSERT INTO incidents(ts,camera,label,conf,status,risk,summary,source) VALUES(?,?,?,?,?,?,?,?)",
                      ts, C.CAMERA_NAME, label, conf, "Analysing", 0, "The AI agent is reviewing this.", "").lastrowid
        d = C.DATA_DIR / "incidents" / str(iid); d.mkdir(parents=True, exist_ok=True)
        for kind, j in zip(KINDS, jpegs):
            if j: (d / f"{kind}.jpg").write_bytes(j)
        return iid

    def finish(self, iid, v, notify, sent):
        self._q("UPDATE incidents SET status=?,risk=?,summary=?,source=?,notify=?,sent=? WHERE id=?",
                v["status"], v["risk"], v["summary"], v["source"], notify, int(sent), iid)

    def get(self, iid):
        r = self._q("SELECT * FROM incidents WHERE id=?", iid).fetchone()
        return dict(r) if r else None

    def recent(self, n=30):
        return [dict(r) for r in self._q("SELECT * FROM incidents ORDER BY id DESC LIMIT ?", n)]

    def unsent(self):
        return [dict(r) for r in self._q("SELECT * FROM incidents WHERE sent=0 AND notify!='none'")]

    def mark_sent(self, iid): self._q("UPDATE incidents SET sent=1 WHERE id=?", iid)

    def images(self, iid):
        d = C.DATA_DIR / "incidents" / str(iid)
        return [d / f"{k}.jpg" for k in KINDS if (d / f"{k}.jpg").exists()]

    def cleanup(self):
        cut = (datetime.now() - timedelta(days=C.RETAIN_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
        for r in self._q("SELECT id FROM incidents WHERE ts<?", cut).fetchall():
            shutil.rmtree(C.DATA_DIR / "incidents" / str(r["id"]), ignore_errors=True)
        self._q("DELETE FROM incidents WHERE ts<?", cut)

    def wipe(self):
        self._q("DELETE FROM incidents")
        shutil.rmtree(C.DATA_DIR / "incidents", ignore_errors=True)
        (C.DATA_DIR / "incidents").mkdir(exist_ok=True)
