// engine.js - runs in the browser: detector (onnxruntime-web), tracker, threat confirmation, virtual turret aim.
const WEAPONS = ['Gun', 'Explosion', 'Grenade', 'Knife'], TRIGGERS = ['Gun', 'Knife', 'Grenade'];
const MIN_CONF = { Gun: .30, Explosion: .40, Grenade: .30, Knife: .30, Human: .40 };
const CFG = { cand: .35, conf: .60, hits: 5, win: 8, hfov: 60, vfov: 45, idle: 3, speed: 12 };
const SIZE = 640, ANCHORS = 8400;

function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = ix * iy, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
}
function nms(dets) {
  dets.sort((a, b) => b.conf - a.conf);
  const keep = [];
  for (const d of dets) if (!keep.some((k) => k.label === d.label && iou(k.b, d.b) > .45)) keep.push(d);
  return keep;
}

class Detector {
  async load(url) {
    this.sess = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
    for (const n of ['weapon_out', 'human_out'])
      if (!this.sess.outputNames.includes(n)) throw new Error('This is not threat_detector.onnx (missing ' + n + ')');
    const cv = document.createElement('canvas'); cv.width = cv.height = SIZE;
    this.cx = cv.getContext('2d', { willReadFrequently: true });
  }
  head(data, names, nCls, out) {
    for (let i = 0; i < ANCHORS; i++) {
      let best = 0, bs = 0;
      for (let c = 0; c < nCls; c++) { const s = data[(4 + c) * ANCHORS + i]; if (s > bs) { bs = s; best = c; } }
      if (bs < MIN_CONF[names[best]]) continue;
      const cx = data[i], cy = data[ANCHORS + i], w = data[2 * ANCHORS + i], h = data[3 * ANCHORS + i];
      out.push({ label: names[best], conf: bs, b: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2] });
    }
  }
  async run(src, w, h) {           // src: video (or canvas) of size w x h
    const r = Math.min(SIZE / w, SIZE / h), nw = Math.round(w * r), nh = Math.round(h * r);
    const dx = (SIZE - nw) >> 1, dy = (SIZE - nh) >> 1, c = this.cx;
    c.fillStyle = 'rgb(114,114,114)'; c.fillRect(0, 0, SIZE, SIZE); c.drawImage(src, dx, dy, nw, nh);
    const px = c.getImageData(0, 0, SIZE, SIZE).data, A = SIZE * SIZE, t = new Float32Array(3 * A);
    for (let i = 0; i < A; i++) { t[i] = px[4 * i] / 255; t[A + i] = px[4 * i + 1] / 255; t[2 * A + i] = px[4 * i + 2] / 255; }
    const out = await this.sess.run({ [this.sess.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, SIZE, SIZE]) });
    const raw = [];
    this.head(out.weapon_out.data, WEAPONS, 4, raw);
    this.head(out.human_out.data, ['Human'], 1, raw);
    const cl = (v, m) => Math.max(0, Math.min(m, v));
    return nms(raw).map((d) => ({ label: d.label, conf: d.conf, box: [cl((d.b[0] - dx) / r, w), cl((d.b[1] - dy) / r, h), cl((d.b[2] - dx) / r, w), cl((d.b[3] - dy) / r, h)] }))
      .filter((d) => d.box[2] > d.box[0] && d.box[3] > d.box[1]);
  }
}

const lastConf = (t) => t.hist[t.hist.length - 1];
const confirmed = (t) => t.hist.filter((c) => c >= CFG.conf).length >= CFG.hits;
const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

class Tracker {
  constructor() { this.tracks = []; this.next = 1; }
  update(dets) {
    const free = dets.map((_, i) => i).sort((a, b) => dets[b].conf - dets[a].conf);
    for (const t of this.tracks) {
      let best = .3, bi = -1;
      for (const i of free) if (dets[i].label === t.label) { const v = iou(t.box, dets[i].box); if (v > best) { best = v; bi = i; } }
      if (bi < 0) { t.hist.push(0); t.miss++; }
      else { free.splice(free.indexOf(bi), 1); t.box = dets[bi].box; t.hist.push(dets[bi].conf); t.miss = 0; }
      if (t.hist.length > CFG.win) t.hist.shift();
    }
    for (const i of free) this.tracks.push({ id: this.next++, label: dets[i].label, box: dets[i].box, hist: [dets[i].conf], miss: 0, alerted: false });
    this.tracks = this.tracks.filter((t) => t.miss <= 10);
    return this.tracks;
  }
}
function holder(w, persons) {       // smallest person box containing the weapon's centre
  const [cx, cy] = centre(w.box);
  return persons.filter((p) => p.box[0] <= cx && cx <= p.box[2] && p.box[1] <= cy && cy <= p.box[3]).sort((a, b) => area(a.box) - area(b.box))[0] || null;
}

// Virtual turret: shows where a real pan-tilt head would point (no hardware in the demo).
class Aimer {
  constructor() { this.pan = this.tilt = 90; this.dir = 1; this.last = this.lastTarget = performance.now(); }
  get idle() { return (performance.now() - this.lastTarget) / 1000; }
  step(box, W, H, patrol) {
    const now = performance.now(), dt = Math.min((now - this.last) / 1000, .5); this.last = now;
    if (box) {
      this.lastTarget = now;
      const ex = ((box[0] + box[2]) / 2 / W - .5) * CFG.hfov, ey = ((box[1] + box[3]) / 2 / H - .5) * CFG.vfov;
      this.pan += .35 * (90 + ex - this.pan); this.tilt += .35 * (90 - ey - this.tilt);
    } else if (patrol && this.idle > CFG.idle) {
      this.pan += this.dir * CFG.speed * dt;
      if (this.pan < 30 || this.pan > 150) this.dir *= -1;
      this.tilt += (90 - this.tilt) * Math.min(1, dt);
    }
    this.pan = Math.max(10, Math.min(170, this.pan)); this.tilt = Math.max(40, Math.min(140, this.tilt));
  }
}

if (typeof module !== 'undefined') module.exports = { Detector, Tracker, Aimer, holder, confirmed, lastConf, nms, iou, CFG, TRIGGERS };
