// security.js — patrol, threat confirmation and alert events on top of PanTiltTracker.
//
// Flow:  patrol (idle sweep) -> candidate threat: lock on + start confirming
//        -> confirmed (enough strong frames) -> ONE 'threat' event, then a cooldown.
// The event says "possible <object>": a person must review it. Nothing here acts on its own.

const _PT = (typeof PanTiltTracker !== 'undefined') ? PanTiltTracker : require('./tracker.js').PanTiltTracker;

class SecurityMonitor {
  constructor(options = {}) {
    const o = options;
    this.cfg = {
      threatLabels: ['Gun', 'Knife', 'Grenade'],
      personLabel: 'Human',
      personMinScore: 0.4,
      candidateScore: 0.35,    // at/above this: stop patrolling and lock on to the object
      confirmScore: 0.6,       // a frame counts as a "hit" at/above this
      windowSize: 8,           // look at the last N updates...
      confirmHits: 5,          // ...and need this many hits before alerting
      cooldownMs: 60000,       // quiet period after an alert
      idleMs: 3000,            // no target for this long -> start patrolling
      personHeightM: 1.7,      // used only for the rough distance estimate
      ...o,
      patrol: { enabled: true, speedDps: 12, panMin: 30, panMax: 150, tilt: 90, ...(o.patrol || {}) },
    };
    this.tracker = new _PT({ labels: [this.cfg.personLabel], minScore: this.cfg.personMinScore, ...(o.tracker || {}) });
    this.reset();
  }

  reset() {
    this.tracker.reset();
    this.window = [];
    this.lastAlertAt = -Infinity;
    this.idleSince = null;
    this.lastTs = null;
    this.dir = 1;
  }

  // Rough distance to a PERSON from box height (pinhole model, assumes the whole body is visible).
  // Expect 20-30% error. Not meaningful for weapons.
  estimateDistance(box, H) {
    const frac = (box.y2 - box.y1) / H;
    if (frac < 0.05) return null;
    const v = this.tracker.cfg.vfov * Math.PI / 180;
    return Math.round(10 * this.cfg.personHeightM / (2 * Math.tan(v / 2) * frac)) / 10;
  }

  // The person most likely holding the object: smallest person box containing most of the object box.
  _personFor(obj, dets) {
    const c = this.cfg, area = b => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
    let best = null;
    for (const p of dets) {
      if (p.label !== c.personLabel || p.score < c.personMinScore) continue;
      const ix = Math.max(0, Math.min(p.x2, obj.x2) - Math.max(p.x1, obj.x1));
      const iy = Math.max(0, Math.min(p.y2, obj.y2) - Math.max(p.y1, obj.y1));
      if (ix * iy / Math.max(1, area(obj)) >= 0.5 && (!best || area(p) < area(best))) best = p;
    }
    return best;
  }

  _patrol(dt, now) {
    const p = this.cfg.patrol, tr = this.tracker;
    if (tr.pan >= p.panMax) this.dir = -1; else if (tr.pan <= p.panMin) this.dir = 1;
    const step = 20 * dt;                                            // ease tilt back to the patrol angle
    tr.setAngles(tr.pan + this.dir * p.speedDps * dt, tr.tilt + Math.max(-step, Math.min(step, p.tilt - tr.tilt)), now);
  }

  // Returns { pan, tilt, mode, locked, target, distanceM, events[] }
  // mode: patrol | idle | tracking | confirming | alerted
  update(dets, W, H, now = Date.now(), captureTime = now) {
    const c = this.cfg, tr = this.tracker;
    if (this.idleSince === null) this.idleSince = now;
    const dt = this.lastTs === null ? 0 : Math.min(0.5, (now - this.lastTs) / 1000);
    this.lastTs = now;

    const threats = dets.filter(d => c.threatLabels.includes(d.label) && d.score >= c.candidateScore);
    const best = threats.reduce((a, b) => (!a || b.score > a.score ? b : a), null);

    // Priority: a possible threat object first, otherwise follow the nearest/largest person.
    tr.cfg.labels = best ? c.threatLabels : [c.personLabel];
    tr.cfg.minScore = best ? c.candidateScore : c.personMinScore;
    const st = tr.update(dets, W, H, now, captureTime);

    const strong = !!best && best.score >= c.confirmScore;
    this.window.push(strong);
    if (this.window.length > c.windowSize) this.window.shift();
    const hits = this.window.filter(Boolean).length;

    const events = [];
    if (strong && hits >= c.confirmHits && now - this.lastAlertAt > c.cooldownMs) {
      const person = this._personFor(best, dets);
      events.push({ type: 'threat', label: best.label, score: best.score, box: best, person,
                    distanceM: person ? this.estimateDistance(person, H) : null, time: now });
      this.lastAlertAt = now;
      this.window = [];
    }

    const recent = now - this.lastAlertAt < c.cooldownMs;
    let mode = 'idle';
    if (st.target) { this.idleSince = now; mode = best ? (recent ? 'alerted' : 'confirming') : 'tracking'; }
    else if (c.patrol.enabled && now - this.idleSince > c.idleMs) { this._patrol(dt, now); mode = 'patrol'; }

    const isPerson = st.target && st.target.label === c.personLabel;
    return { pan: tr.pan, tilt: tr.tilt, mode, locked: tr.locked, target: st.target,
             distanceM: isPerson ? this.estimateDistance(st.target, H) : null, events };
  }
}

if (typeof module !== 'undefined') module.exports = { SecurityMonitor };
