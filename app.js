// app.js - the demo page: camera, detection loop, alert flow, virtual turret, saved history (this browser only).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const video = $('video'), overlay = $('overlay'), octx = overlay.getContext('2d');
  const det = new Detector(), tracker = new Tracker(), aimer = new Aimer();
  const KEY = 'tetsa_demo_incidents', MODEL = 'model/threat_detector.onnx', KEEP = 8;
  let incidents = []; try { incidents = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) {}
  let mode = 'starting', fps = 0, counts = {}, lastAlert = {}, buzzUntil = 0, light = false, ac = null;
  const cap = document.createElement('canvas'), capx = cap.getContext('2d');

  const say = (t) => { $('msg').hidden = false; $('msg').firstElementChild.textContent = t; };
  const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };
  function persist() {
    incidents = incidents.slice(0, KEEP);
    while (incidents.length) { try { localStorage.setItem(KEY, JSON.stringify(incidents)); return; } catch (e) { incidents.pop(); } }
  }

  // ---------- images ----------
  function grab() { cap.width = video.videoWidth; cap.height = video.videoHeight; capx.drawImage(video, 0, 0); return cap; }
  function jpg(c, maxW, q) {
    if (c.width > maxW) { const o = document.createElement('canvas'); o.width = maxW; o.height = Math.round(c.height * maxW / c.width); o.getContext('2d').drawImage(c, 0, 0, o.width, o.height); c = o; }
    return c.toDataURL('image/jpeg', q).split(',')[1];
  }
  function cropJpg(c, b, pad, maxSide) {
    const bw = b[2] - b[0], bh = b[3] - b[1], x1 = Math.max(0, b[0] - bw * pad), y1 = Math.max(0, b[1] - bh * pad);
    const x2 = Math.min(c.width, b[2] + bw * pad), y2 = Math.min(c.height, b[3] + bh * pad), w = x2 - x1, h = y2 - y1;
    if (w < 8 || h < 8) return null;
    const s = Math.min(1, maxSide / Math.max(w, h)), o = document.createElement('canvas');
    o.width = Math.round(w * s); o.height = Math.round(h * s);
    o.getContext('2d').drawImage(c, x1, y1, w, h, 0, 0, o.width, o.height);
    return o.toDataURL('image/jpeg', .7).split(',')[1];
  }

  // ---------- incidents ----------
  function rulesLocal(label, restricted, hasPerson) {
    const risk = Math.min(10, ({ Gun: 7, Grenade: 7, Knife: 6 }[label] || 5) + (restricted ? 2 : 0) + (hasPerson ? 1 : 0));
    return { status: 'Alert', risk, source: 'rules', summary: 'Automatic rule-based check (AI agent unreachable); not reviewed by the AI agent. Possible ' + label + (restricted ? ' during restricted hours.' : '.') };
  }
  async function raise(label, conf, box, person, test) {
    const c = grab(), imgs = [jpg(c, 800, .7), cropJpg(c, box, .2, 320), person ? cropJpg(c, person.box, .1, 320) : null].filter(Boolean);
    const inc = { id: Date.now(), ts: stamp(), label, conf, status: 'Analysing', risk: 0, summary: 'The AI agent is reviewing this.', source: '', notify: 'none', photos_sent: 0, note: '', images: imgs };
    incidents.unshift(inc); render();
    const now = new Date(), restricted = $('c-night').checked || now.getHours() >= 22 || now.getHours() < 6;
    let v = test ? { status: 'Alert', risk: 7, source: 'test', summary: 'Test alert from the demo page.' }
      : await post('/api/assess', { label, conf, hasPerson: !!person, restricted, time: now.toLocaleString([], { weekday: 'long', hour: '2-digit', minute: '2-digit' }), images: imgs }).catch(() => null);
    if (!v || !v.status) v = rulesLocal(label, restricted, !!person);
    const loud = v.status === 'Alert' && v.risk >= 6;
    Object.assign(inc, { status: v.status, risk: v.risk, summary: v.summary, source: v.source, notify: loud ? 'alert' : 'low', rules: v.rules || [] });
    if (loud && $('c-armed').checked && !$('c-muted').checked) buzz(3000);
    render();
    if ($('c-tg').checked) {
      const r = await post('/api/alert', { label, conf, status: v.status, risk: v.risk, summary: v.summary, source: v.source, low: !loud, ts: inc.ts, images: imgs }).catch(() => null);
      if (r && r.ok) inc.photos_sent = r.photos; else inc.note = (r && r.reason) || 'could not reach the server';
    } else inc.note = 'Telegram is off';
    persist(); render();
  }

  function buzz(ms) {
    buzzUntil = Date.now() + ms;
    if (!ac) return;
    const o = ac.createOscillator(), g = ac.createGain(); g.gain.value = .08; o.type = 'square'; o.frequency.value = 880;
    o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + ms / 1000);
  }

  // ---------- detection loop ----------
  function frame(dets, W, H) {
    const tracks = tracker.update(dets), live = tracks.filter((t) => t.miss === 0);
    const persons = live.filter((t) => t.label === 'Human'), weapons = live.filter((t) => TRIGGERS.includes(t.label));
    const cands = weapons.filter((w) => lastConf(w) >= CFG.cand), sure = weapons.filter(confirmed);
    const patrol = $('c-patrol').checked, armed = $('c-armed').checked;
    let target = null;
    if (sure.length || cands.length) { const w = sure[0] || cands.sort((a, b) => lastConf(b) - lastConf(a))[0]; target = holder(w, persons) || w; }
    else if (persons.length) target = persons.sort((a, b) => area(b.box) - area(a.box))[0];
    aimer.step(target ? target.box : null, W, H, patrol);
    mode = sure.length ? 'confirmed' : cands.length ? 'candidate' : persons.length ? 'tracking' : (patrol && aimer.idle > CFG.idle) ? 'patrol' : 'idle';
    light = armed && (cands.length > 0 || sure.length > 0);
    const now = Date.now();
    for (const w of sure) if (!w.alerted) { w.alerted = true; if (now - (lastAlert[w.label] || 0) > 60000) { lastAlert[w.label] = now; raise(w.label, lastConf(w), w.box, holder(w, persons), false); } }
    counts = {}; if (overlay.width !== W) { overlay.width = W; overlay.height = H; }
    octx.clearRect(0, 0, W, H);
    const lw = Math.max(3, W / 240), fs = Math.max(14, W / 48);
    octx.lineWidth = lw; octx.font = 'bold ' + fs + 'px sans-serif'; octx.textBaseline = 'middle';
    for (const t of live) {                       // one square box with a label for EVERY detected object
      counts[t.label] = (counts[t.label] || 0) + 1;
      const col = t.label === 'Human' ? '#22c55e' : t.label === 'Explosion' ? '#a855f7' : confirmed(t) ? '#ef4444' : '#f59e0b';
      const b = t.box, bw = b[2] - b[0], bh = b[3] - b[1];
      octx.fillStyle = col + '26'; octx.fillRect(b[0], b[1], bw, bh);          // light tint inside the box
      octx.strokeStyle = col; octx.strokeRect(b[0], b[1], bw, bh);
      const text = t.label + ' ' + Math.round(lastConf(t) * 100) + '%', tw = octx.measureText(text).width + 12, th = fs + 8;
      const ly = b[1] - th >= 0 ? b[1] - th : b[1];                              // label tab above the box (inside if no room)
      octx.fillStyle = col; octx.fillRect(b[0] - lw / 2, ly, tw, th);
      octx.fillStyle = '#fff'; octx.fillText(text, b[0] + 6, ly + th / 2 + 1);
    }
  }
  async function loop() {
    const t0 = performance.now();
    try {
      const W = video.videoWidth, H = video.videoHeight;
      if (W && !document.hidden) { frame(await det.run(video, W, H), W, H); fps = .8 * fps + .2 * 1000 / Math.max(performance.now() - t0, 1); }
    } catch (e) { mode = 'error'; console.error(e); }
    setTimeout(loop, document.hidden ? 500 : 0);
  }

  // ---------- screen ----------
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function ui() {
    const a = aimer.pan * Math.PI / 180;
    $('needle').setAttribute('x2', 110 - 88 * Math.cos(a)); $('needle').setAttribute('y2', 110 - 88 * Math.sin(a));
    $('tiltmark').setAttribute('y', 10 + (aimer.tilt - 40) - 3);
    $('angles').textContent = 'pan ' + Math.round(aimer.pan) + '\u00b0, tilt ' + Math.round(aimer.tilt) + '\u00b0';
    $('lamp').classList.toggle('on', light); $('lamptxt').textContent = light ? 'Spotlight on' : 'Spotlight off';
    const buzzing = Date.now() < buzzUntil;
    $('buzztxt').textContent = buzzing ? 'Buzzer sounding' : 'Buzzer silent'; $('stage').classList.toggle('alarm', buzzing);
    const c = Object.keys(counts).map((k) => counts[k] + ' ' + k).join(', ') || 'nothing detected';
    $('stats').textContent = 'Mode: ' + mode + '  |  ' + fps.toFixed(1) + ' fps  |  Back Exit  |  ' + c;
    const sent = incidents.reduce((n, i) => n + (i.photos_sent || 0), 0), msgs = incidents.filter((i) => i.photos_sent).length;
    $('tgstats').textContent = 'Telegram: ' + msgs + ' messages, ' + sent + ' photos sent from this browser';
  }
  function render() {
    $('empty').hidden = incidents.length > 0;
    const ul = $('incidents'); ul.textContent = '';
    incidents.forEach((i) => {
      const li = el('li'), img = el('img'), box = el('div'), top = el('div', 'top'), more = el('div');
      img.src = 'data:image/jpeg;base64,' + (i.images[1] || i.images[0]); img.alt = 'Detected ' + i.label; img.style.cursor = 'pointer'; img.title = 'Show all photos';
      more.hidden = true; more.style.gridColumn = '1 / -1';
      i.images.forEach((s) => { const p = el('img'); p.src = 'data:image/jpeg;base64,' + s; p.alt = 'Saved photo'; p.style.cssText = 'width:100%;height:auto;margin-top:6px'; more.appendChild(p); });
      img.addEventListener('click', () => { more.hidden = !more.hidden; });
      top.appendChild(el('span', '', 'Possible ' + i.label + ' (' + Math.round(i.conf * 100) + '%)'));
      top.appendChild(el('span', 'badge-r' + (i.risk >= 8 ? ' hi' : i.risk >= 6 ? ' mid' : ''), i.status === 'Analysing' ? 'Analysing' : i.status + ' ' + i.risk + '/10'));
      box.appendChild(top);
      box.appendChild(el('p', 'when', i.ts + '  |  Back Exit' + (i.source === 'rules' ? '  |  unverified' : '') +
        (i.notify === 'none' ? '' : i.photos_sent ? '  |  Telegram: ' + i.photos_sent + ' photos sent' : '  |  not sent to Telegram' + (i.note ? ' (' + i.note + ')' : ''))));
      box.appendChild(el('p', 'sum', i.summary));
      if (i.rules && i.rules.length) box.appendChild(el('p', 'when', 'Rules used: ' + i.rules.join('; ')));
      li.appendChild(img); li.appendChild(box); li.appendChild(more); ul.appendChild(li);
    });
  }

  // ---------- controls ----------
  document.addEventListener('click', () => { if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)(); }, { once: true });
  $('b-test').addEventListener('click', () => {
    if (!video.videoWidth) return alert('The camera is not ready yet.');
    const W = video.videoWidth, H = video.videoHeight; raise('Test', 1, [W * .4, H * .3, W * .6, H * .7], null, true);
  });
  $('csv').addEventListener('click', (e) => {
    e.preventDefault();
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const rows = [['id', 'time', 'camera', 'object', 'confidence', 'status', 'risk', 'source', 'telegram_photos_sent', 'summary'].join(',')]
      .concat(incidents.map((i) => [i.id, i.ts, 'Back Exit', i.label, i.conf.toFixed(2), i.status, i.risk, i.source, i.photos_sent || 0, q(i.summary)].join(',')));
    const a = el('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + rows.join('\n')], { type: 'text/csv' })); a.download = 'tetsa_demo_history.csv'; a.click();
  });
  $('reset').addEventListener('click', (e) => {
    e.preventDefault();
    if (confirm('Delete the incidents and photos saved in this browser?')) { incidents = []; localStorage.removeItem(KEY); render(); }
  });

  // ---------- start: camera first, then the detector ----------
  (async () => {
    render(); setInterval(ui, 250);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
      video.srcObject = s; await new Promise((r) => { video.onloadedmetadata = r; }); await video.play();
    } catch (e) {
      say(e && e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow the camera for this site in your browser, then reload.' : 'No camera was found, or another app is using it.');
      return;
    }
    say('Loading the detector (about 24 MB the first time)...');
    try { await det.load(MODEL); } catch (e) { say('Could not load the detector: ' + e.message); return; }
    $('msg').hidden = true; loop();
  })();
})();
