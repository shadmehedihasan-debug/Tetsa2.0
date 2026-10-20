"""Runs threat_detector.onnx (two heads: weapon_out [1,8,8400], human_out [1,84,8400])."""
import cv2
import numpy as np
import onnxruntime as ort
import config as C

SIZE = 640

def decode_head(out, names, nclass):
    """out: (4+K, N). Returns boxes (cx,cy,w,h), class ids, confs above per-class minimums."""
    o = out[0] if out.ndim == 3 else out
    sc = o[4:4 + nclass]
    cls, conf = sc.argmax(0), sc.max(0)
    thr = np.array([C.MIN_CONF[n] for n in names], dtype=np.float32)
    keep = conf >= thr[cls]
    return o[:4, keep].T, cls[keep], conf[keep]

def nms(boxes, cls, conf, names):
    res = []
    for c in np.unique(cls):
        idx = np.where(cls == c)[0]
        b = boxes[idx]
        xywh = np.stack([b[:, 0] - b[:, 2] / 2, b[:, 1] - b[:, 3] / 2, b[:, 2], b[:, 3]], 1)
        k = cv2.dnn.NMSBoxes(xywh.tolist(), conf[idx].tolist(), 0.0, C.NMS_IOU)
        for j in np.array(k).flatten():
            res.append((names[c], float(conf[idx][j]), b[j]))
    return res

class Detector:
    def __init__(self, path=C.MODEL_PATH):
        self.sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        self.inp = self.sess.get_inputs()[0].name
        self.outs = [o.name for o in self.sess.get_outputs()]
        for need in ("weapon_out", "human_out"):
            if need not in self.outs:
                raise RuntimeError(f"Model has no '{need}' output (found {self.outs}). Use threat_detector.onnx.")

    def __call__(self, frame):
        h, w = frame.shape[:2]
        r = min(SIZE / h, SIZE / w)
        nw, nh = round(w * r), round(h * r)
        dx, dy = (SIZE - nw) // 2, (SIZE - nh) // 2
        canvas = np.full((SIZE, SIZE, 3), 114, np.uint8)
        canvas[dy:dy + nh, dx:dx + nw] = cv2.resize(frame, (nw, nh))
        x = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255
        out = dict(zip(self.outs, self.sess.run(None, {self.inp: x})))
        found = []
        for key, names, k in (("weapon_out", C.WEAPON_NAMES, 4), ("human_out", ["Human"], 1)):
            b, c, s = decode_head(out[key], names, k)
            found += nms(b, c, s, names) if len(s) else []
        dets = []
        for label, conf, (cx, cy, bw, bh) in found:
            x1, y1 = (cx - bw / 2 - dx) / r, (cy - bh / 2 - dy) / r
            x2, y2 = (cx + bw / 2 - dx) / r, (cy + bh / 2 - dy) / r
            box = (max(0, x1), max(0, y1), min(w - 1, x2), min(h - 1, y2))
            if box[2] > box[0] and box[3] > box[1]:
                dets.append({"label": label, "conf": conf, "box": box})
        return dets
