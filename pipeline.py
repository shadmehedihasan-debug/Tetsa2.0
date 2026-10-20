"""Ties it together: camera -> detector -> tracker -> threat logic -> turret, agent, alerts."""
import threading, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import cv2
import config as C
from agent import Agent
from alerts import Telegram
from camera import Camera
from store import Store
from tracker import Tracker, holder
from turret import Aimer, Turret

GREEN, RED, AMBER = (80, 200, 90), (60, 60, 230), (0, 170, 255)

def jpeg(img, q=80):
    return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])[1].tobytes()

def crop(frame, box, pad=.2, min_side=96):
    h, w = frame.shape[:2]
    bw, bh = box[2] - box[0], box[3] - box[1]
    x1, y1 = int(max(0, box[0] - bw * pad)), int(max(0, box[1] - bh * pad))
    x2, y2 = int(min(w, box[2] + bw * pad)), int(min(h, box[3] + bh * pad))
    c = frame[y1:y2, x1:x2]
    return jpeg(c) if c.size and min(c.shape[:2]) >= 8 else None

class Pipeline:
    def __init__(self):
        self.cam, self.tracker, self.aimer, self.turret = Camera(), Tracker(), Aimer(), Turret()
        self.agent, self.tg, self.store = Agent(), Telegram(), Store()
        self.pool = ThreadPoolExecutor(max_workers=2)
        self.det, self.error, self.running = None, "", False
        self.armed, self.muted, self.patrol, self.light_manual = True, False, True, False
        self.mode, self.fps, self.counts, self.last_alert = "starting", 0.0, {}, {}
        self.jpeg, self.cond = None, threading.Condition()

    def start(self):
        self.running = True
        threading.Thread(target=self._loop, daemon=True).start()
        threading.Thread(target=self._housekeeping, daemon=True).start()

    # ---------- main loop ----------
    def _loop(self):
        try:
            from detector import Detector
            self.det = Detector()
        except Exception as e:
            self.error = f"Model not loaded: {e}"
        while self.running:
            frame = self.cam.read()
            if frame is None:
                self.mode = "no camera"; time.sleep(.2); continue
            t0 = time.time()
            H, W = frame.shape[:2]
            tracks = self.tracker.update(self.det(frame) if self.det else [])
            live = [t for t in tracks if t.miss == 0]
            persons = [t for t in live if t.label == "Human"]
            weapons = [t for t in live if t.label in C.TRIGGERS]
            cands = [w for w in weapons if w.conf >= C.CANDIDATE_CONF]
            confirmed = [w for w in weapons if w.confirmed()]

            target = None
            if confirmed or cands:
                w = confirmed[0] if confirmed else max(cands, key=lambda x: x.conf)
                target = holder(w, persons) or w
            elif persons:
                target = max(persons, key=lambda p: p.area)
            self.aimer.step(target.box if target else None, W, H, self.patrol)

            self.mode = ("confirmed" if confirmed else "candidate" if cands else "tracking" if persons
                         else "patrol" if self.patrol and self.aimer.idle_s > C.IDLE_S else "idle")
            light = self.light_manual or (self.armed and bool(cands or confirmed))
            self.turret.set(self.aimer.pan, self.aimer.tilt, light)

            now = time.time()
            for w in confirmed:
                if not w.alerted:
                    w.alerted = True
                    if now - self.last_alert.get(w.label, 0) > C.COOLDOWN_S:
                        self.last_alert[w.label] = now
                        self.raise_incident(frame.copy(), w.label, w.conf, w.box, holder(w, persons))

            self.counts = {}
            for t in live:
                self.counts[t.label] = self.counts.get(t.label, 0) + 1
                col = GREEN if t.label == "Human" else RED if t.confirmed() else AMBER
                b = [int(v) for v in t.box]
                cv2.rectangle(frame, b[:2], b[2:], col, 2)
                cv2.putText(frame, f"{t.label} {t.conf:.2f}", (b[0], max(14, b[1] - 6)),
                            cv2.FONT_HERSHEY_SIMPLEX, .55, col, 2)
            with self.cond:
                self.jpeg = jpeg(frame, 70); self.cond.notify_all()
            self.fps = .8 * self.fps + .2 / max(time.time() - t0, 1e-3)

    # ---------- incidents ----------
    def raise_incident(self, frame, label, conf, box, person=None, test=False):
        h, w = frame.shape[:2]
        s = min(1, 960 / w)
        scene = jpeg(cv2.resize(frame, None, fx=s, fy=s) if s < 1 else frame)
        imgs = [scene, crop(frame, box), crop(frame, person.box, .1) if person else None]
        iid = self.store.create(label, conf, imgs)
        ctx = {"camera": C.CAMERA_NAME, "label": label, "conf": conf, "has_person": person is not None,
               "time": datetime.now().strftime("%A %H:%M"), "restricted_now": C.is_restricted(datetime.now())}
        self.pool.submit(self._judge, iid, ctx, [i for i in imgs if i], test)
        return iid

    def _judge(self, iid, ctx, imgs, test):
        v = ({"status": "Alert", "risk": 7, "source": "test", "summary": "Test alert from the dashboard."}
             if test else self.agent.assess(ctx, imgs))
        loud = v["status"] == "Alert" and v["risk"] >= C.ALERT_MIN_RISK
        notify = "alert" if loud else "low" if (v["status"] == "Alert" or C.LOW_PRIORITY_SAFE) else "none"
        if loud and self.armed and not self.muted:
            self.turret.buzz(C.BUZZER_MS)
        self.store.finish(iid, v, notify, sent=notify == "none")
        if notify != "none":
            self.tg.deliver(self.store, iid)

    def test_alert(self):
        frame = self.cam.read()
        if frame is None: return None
        H, W = frame.shape[:2]
        return self.raise_incident(frame, "Test", 1.0, (W * .4, H * .3, W * .6, H * .7), test=True)

    def _housekeeping(self):
        n = 0
        while self.running:
            time.sleep(20); n += 1
            self.tg.flush(self.store)                     # retry alerts that could not be sent
            if n % 180 == 0: self.store.cleanup()

    def state(self):
        return {"mode": self.mode, "fps": round(self.fps, 1), "source": self.cam.mode,
                "pan": round(self.aimer.pan), "tilt": round(self.aimer.tilt),
                "turret": self.turret.ok, "camera": self.cam.ok, "agent": self.agent.configured,
                "telegram": self.tg.configured, "armed": self.armed, "muted": self.muted,
                "patrol": self.patrol, "light": self.turret.light, "counts": self.counts,
                "restricted": C.is_restricted(datetime.now()), "error": self.error,
                "camera_name": C.CAMERA_NAME}
