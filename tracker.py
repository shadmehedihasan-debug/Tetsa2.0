"""Small IoU tracker: gives each object a persistent id and remembers the last frames."""
from collections import deque
import config as C

def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / u if u > 0 else 0

class Track:
    def __init__(self, tid, d):
        self.id, self.label, self.box = tid, d["label"], d["box"]
        self.hist = deque([d["conf"]], maxlen=C.CONFIRM_WINDOW)
        self.miss, self.alerted = 0, False

    @property
    def conf(self): return self.hist[-1]
    @property
    def area(self): return (self.box[2] - self.box[0]) * (self.box[3] - self.box[1])
    @property
    def center(self): return ((self.box[0] + self.box[2]) / 2, (self.box[1] + self.box[3]) / 2)
    def hits(self): return sum(c >= C.CONFIRM_CONF for c in self.hist)
    def confirmed(self): return self.hits() >= C.CONFIRM_HITS

class Tracker:
    def __init__(self, min_iou=.3, max_miss=10):
        self.tracks, self.next_id, self.min_iou, self.max_miss = [], 1, min_iou, max_miss

    def update(self, dets):
        free = sorted(range(len(dets)), key=lambda i: -dets[i]["conf"])
        for t in self.tracks:
            best, bi = self.min_iou, None
            for i in free:
                if dets[i]["label"] == t.label:
                    v = iou(t.box, dets[i]["box"])
                    if v > best: best, bi = v, i
            if bi is None:
                t.hist.append(0.0); t.miss += 1
            else:
                free.remove(bi); t.box = dets[bi]["box"]; t.hist.append(dets[bi]["conf"]); t.miss = 0
        for i in free:
            self.tracks.append(Track(self.next_id, dets[i])); self.next_id += 1
        self.tracks = [t for t in self.tracks if t.miss <= self.max_miss]
        return self.tracks

def holder(weapon, persons):
    """The smallest person box that contains the weapon's centre, or None."""
    cx, cy = weapon.center
    inside = [p for p in persons if p.box[0] <= cx <= p.box[2] and p.box[1] <= cy <= p.box[3]]
    return min(inside, key=lambda p: p.area) if inside else None
