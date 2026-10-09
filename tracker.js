// tracker.js — turns detections into pan/tilt servo angles, and sends them over Bluetooth LE.
//
//   PanTiltTracker : pure logic (no browser APIs), so it can be tested in Node.
//   BleLink        : Web Bluetooth link to the ESP32 sketch (Nordic UART service).
//
// Angle convention (defaults): servo angle UP = camera pans RIGHT / tilts UP.
// If your servos are mounted the other way, flip `invert` for that axis.

class PanTiltTracker {
  constructor(options = {}) {
    const o = options;
    this.cfg = {
      labels: ['Human'],      // which detection labels to follow
      minScore: 0.4,          // ignore weaker detections
      aimY: 0.5,              // 0 = top of the box, 1 = bottom (0.35 aims at a person's upper body)
      hfov: 60, vfov: 45,     // camera field of view in degrees: measure/tune for your phone
      gain: 0.8,              // fraction of the remaining angle corrected per update (lower = calmer)
      deadzone: 0.06,         // target this close to the centre (fraction of half-frame) = hold still
      smoothing: 0.7,         // 1 = no smoothing, lower = smoother but laggier
      maxStep: 6,             // max degrees moved per update
      lostMs: 1500,           // after this long without a target, report "not locked"
      actuatorLag: 150,       // ms from sending a command until the camera really points there
      ...o,
      pan:  { min: 10, max: 170, center: 90, invert: false, ...(o.pan  || {}) },
      tilt: { min: 40, max: 140, center: 90, invert: false, ...(o.tilt || {}) },
    };
    this.reset();
  }

  reset() {
    this.pan = this.cfg.pan.center;
    this.tilt = this.cfg.tilt.center;
    this.hist = [{ t: -Infinity, pan: this.pan, tilt: this.tilt }];   // commands we issued, with times
    this.wantPan = null;
    this.wantTilt = null;
    this.last = null;        // last followed target centre {x, y}
    this.lastSeen = -Infinity;
    this.locked = false;
  }

  _clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // Error inside the deadzone -> 0, outside -> shrunk by the deadzone (no sudden jump at the edge).
  _soft(e) {
    const dz = this.cfg.deadzone;
    return Math.abs(e) <= dz ? 0 : Math.sign(e) * (Math.abs(e) - dz);
  }

  // The servo angle the camera really had at time t (commands take `actuatorLag` ms to take effect).
  _angleAt(t) {
    const te = t - this.cfg.actuatorLag;
    for (let i = this.hist.length - 1; i >= 0; i--) if (this.hist[i].t <= te) return this.hist[i];
    return this.hist[0];
  }

  _pick(dets, W) {
    const c = this.cfg;
    const cands = dets.filter(d => c.labels.includes(d.label) && d.score >= c.minScore);
    if (!cands.length) return null;
    const area = d => (d.x2 - d.x1) * (d.y2 - d.y1);
    if (this.last) {   // stick with the previous target if one is still close to where it was
      const dist = d => Math.hypot((d.x1 + d.x2) / 2 - this.last.x, (d.y1 + d.y2) / 2 - this.last.y);
      const nearest = cands.reduce((a, b) => (dist(a) <= dist(b) ? a : b));
      if (dist(nearest) < 0.25 * W) return nearest;
    }
    return cands.reduce((a, b) => (area(a) >= area(b) ? a : b));
  }

  // dets: output of detect() (boxes in image pixels), W,H: image size,
  // now: time the result arrived (ms), captureTime: time the frame was grabbed (ms).
  // Detection takes time, so the frame is older than `now`; using captureTime avoids overshoot.
  update(dets, W, H, now = Date.now(), captureTime = now) {
    const c = this.cfg;
    const t = this._pick(dets, W);

    if (!t) {                                   // nothing to follow: hold position
      if (now - this.lastSeen > c.lostMs) { this.locked = false; this.last = null; }
      return this.state(null);
    }

    const cx = (t.x1 + t.x2) / 2;
    const cy = t.y1 + c.aimY * (t.y2 - t.y1);
    const ex = (cx - W / 2) / (W / 2);          // -1 (left edge) .. +1 (right edge)
    const ey = (cy - H / 2) / (H / 2);          // -1 (top edge)  .. +1 (bottom edge)

    // Absolute angle that would centre the target = angle the camera had in that frame + the error.
    const base = this._angleAt(captureTime);
    const sp = c.pan.invert ? -1 : 1;
    const st = c.tilt.invert ? -1 : 1;
    const wantPan  = Math.abs(ex) <= c.deadzone ? this.pan  : base.pan  + sp * (c.hfov / 2) * this._soft(ex);
    const wantTilt = Math.abs(ey) <= c.deadzone ? this.tilt : base.tilt - st * (c.vfov / 2) * this._soft(ey);

    if (!this.locked) { this.wantPan = wantPan; this.wantTilt = wantTilt; }
    else {
      this.wantPan  = c.smoothing * wantPan  + (1 - c.smoothing) * this.wantPan;
      this.wantTilt = c.smoothing * wantTilt + (1 - c.smoothing) * this.wantTilt;
    }
    this.locked = true;
    this.lastSeen = now;
    this.last = { x: cx, y: cy };

    const dPan  = this._clamp(c.gain * (this.wantPan  - this.pan),  -c.maxStep, c.maxStep);
    const dTilt = this._clamp(c.gain * (this.wantTilt - this.tilt), -c.maxStep, c.maxStep);
    const newPan  = this._clamp(this.pan  + dPan,  c.pan.min,  c.pan.max);
    const newTilt = this._clamp(this.tilt + dTilt, c.tilt.min, c.tilt.max);

    if (newPan !== this.pan || newTilt !== this.tilt) {
      this.pan = newPan;
      this.tilt = newTilt;
      this.hist.push({ t: now, pan: newPan, tilt: newTilt });
      while (this.hist.length > 1 && this.hist[1].t < now - 3000) this.hist.shift();
    }
    return this.state(t);
  }

  // Used by patrol mode: move the camera directly and record it so latency compensation stays correct.
  setAngles(pan, tilt, now = Date.now()) {
    this.pan = this._clamp(pan, this.cfg.pan.min, this.cfg.pan.max);
    this.tilt = this._clamp(tilt, this.cfg.tilt.min, this.cfg.tilt.max);
    this.hist.push({ t: now, pan: this.pan, tilt: this.tilt });
    while (this.hist.length > 1 && this.hist[1].t < now - 3000) this.hist.shift();
  }

  state(target) {
    return { pan: this.pan, tilt: this.tilt, locked: this.locked, target };
  }
}

// ---------------------------------------------------------------------------------------------
// Bluetooth LE link (Web Bluetooth). Needs HTTPS (or localhost) and Chrome on Android/desktop.
// connect() must be called from a click/tap handler.
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';   // phone -> ESP32

class BleLink {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.rx = null;
    this.busy = false;
    this.lastSent = '';
    this.lastTime = 0;
  }

  get connected() { return !!(this.rx && this.device && this.device.gatt.connected); }

  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not available (use Chrome on Android, over HTTPS)');
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [NUS_SERVICE] }] });
    this.device.addEventListener('gattserverdisconnected', () => { this.rx = null; this.onStatus('Bluetooth disconnected'); });
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    this.rx = await service.getCharacteristic(NUS_RX);
    this.onStatus('Bluetooth connected: ' + (this.device.name || 'device'));
  }

  disconnect() { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); }

  // One-off commands (L1, B0, R1 ...). Waits for the link instead of dropping the command.
  async command(line) {
    if (!this.connected) return;
    for (let i = 0; this.busy && i < 100; i++) await new Promise(r => setTimeout(r, 10));
    this.busy = true;
    try {
      const data = new TextEncoder().encode(line + '\n');
      if (this.rx.writeValueWithoutResponse) await this.rx.writeValueWithoutResponse(data);
      else await this.rx.writeValue(data);
      this.lastTime = Date.now();
    } catch (e) { this.onStatus('Command failed: ' + e.message); }
    finally { this.busy = false; }
  }

  // Sends "P<pan>,T<tilt>\n". Skips repeats, but re-sends every 300 ms as a keep-alive for the failsafe.
  async send(pan, tilt) {
    if (!this.connected || this.busy) return;
    const line = `P${Math.round(pan)},T${Math.round(tilt)}\n`;
    const now = Date.now();
    if (line === this.lastSent && now - this.lastTime < 300) return;
    this.busy = true;
    try {
      const data = new TextEncoder().encode(line);
      if (this.rx.writeValueWithoutResponse) await this.rx.writeValueWithoutResponse(data);
      else await this.rx.writeValue(data);
      this.lastSent = line;
      this.lastTime = now;
    } catch (e) {
      this.onStatus('Send failed: ' + e.message);
    } finally {
      this.busy = false;
    }
  }
}

if (typeof module !== 'undefined') module.exports = { PanTiltTracker, BleLink };
