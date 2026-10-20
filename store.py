"""Incidents (SQLite) and their photos (data/incidents/<id>/). Old ones are deleted automatically."""
import csv, io, shutil, sqlite3, threading, time
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
        self.db.executescript((C.ROOT / "schema.sql").read_text(encoding="utf-8"))
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
        return [dict(r) for r in self._q(
            "SELECT i.*, COALESCE((SELECT SUM(photos) FROM telegram_log t WHERE t.incident_id=i.id),0) AS photos_sent "
            "FROM incidents i ORDER BY i.id DESC LIMIT ?", n)]

    def log_send(self, iid, kind, photos):
        """History row for every message Telegram accepted. Kept after the photos are auto-deleted."""
        self._q("INSERT INTO telegram_log(ts,incident_id,kind,photos) VALUES(?,?,?,?)",
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"), iid, kind, photos)

    def history(self, n=50):
        return [dict(r) for r in self._q("SELECT * FROM telegram_log ORDER BY id DESC LIMIT ?", n)]

    def stats(self):
        msgs, photos, last = self._q("SELECT COUNT(*), COALESCE(SUM(photos),0), MAX(ts) FROM telegram_log").fetchone()
        pending = self._q("SELECT COUNT(*) FROM incidents WHERE sent=0 AND notify!='none'").fetchone()[0]
        return {"messages_sent": msgs, "photos_sent": photos, "last_sent": last, "waiting_to_send": pending}

    def unsent(self):
        return [dict(r) for r in self._q("SELECT * FROM incidents WHERE sent=0 AND notify!='none'")]

    def mark_sent(self, iid): self._q("UPDATE incidents SET sent=1 WHERE id=?", iid)

    def images(self, iid):
        d = C.DATA_DIR / "incidents" / str(iid)
        return [d / f"{k}.jpg" for k in KINDS if (d / f"{k}.jpg").exists()]

    def export_csv(self):
        """Every incident with its Telegram photo count, as CSV text (opens in Excel)."""
        out = io.StringIO(); w = csv.writer(out)
        w.writerow(["id", "time", "camera", "object", "confidence", "status", "risk", "source",
                    "sent_to_telegram", "telegram_photos_sent", "summary"])
        for r in self._q("SELECT i.*, COALESCE((SELECT SUM(photos) FROM telegram_log t WHERE t.incident_id=i.id),0) AS ph "
                         "FROM incidents i ORDER BY i.id"):
            w.writerow([r["id"], r["ts"], r["camera"], r["label"], f"{r['conf']:.2f}", r["status"], r["risk"],
                        r["source"], "yes" if r["ph"] else "no", r["ph"], r["summary"]])
        return out.getvalue()

    def cleanup(self):
        cut = (datetime.now() - timedelta(days=C.RETAIN_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
        for r in self._q("SELECT id FROM incidents WHERE ts<?", cut).fetchall():
            shutil.rmtree(C.DATA_DIR / "incidents" / str(r["id"]), ignore_errors=True)
        self._q("DELETE FROM incidents WHERE ts<?", cut)

    def wipe(self):
        self._q("DELETE FROM incidents")
        self._q("DELETE FROM telegram_log")
        shutil.rmtree(C.DATA_DIR / "incidents", ignore_errors=True)
        (C.DATA_DIR / "incidents").mkdir(exist_ok=True)
