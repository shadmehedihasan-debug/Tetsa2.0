// The AI agent: sends the photos plus context to Gemini and returns {status, risk, summary, source}.
// If Gemini is missing, slow, rate-limited or returns bad JSON, simple rules decide instead ("rules" = unverified).
const { ip, limited, imagesOk, LABELS, CAMERA, DESC } = require('./_lib');

function rules(c, why) {
  const base = { Gun: 7, Grenade: 7, Knife: 6 }[c.label] || 5;
  const risk = Math.min(10, base + (c.restricted ? 2 : 0) + (c.hasPerson ? 1 : 0));
  return { status: 'Alert', risk, source: 'rules', verified: false,
    summary: `Automatic rule-based check (${why}); not reviewed by the AI agent. Possible ${c.label} at ${CAMERA}` +
      (c.restricted ? ' during restricted hours.' : '.') };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = req.body || {};
  if (!LABELS.includes(b.label) || !imagesOk(b.images)) return res.status(400).json({ error: 'bad request' });
  const c = { label: b.label, conf: Number(b.conf) || 0, hasPerson: !!b.hasPerson, restricted: !!b.restricted,
    time: String(b.time || '').slice(0, 40) };
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.json(rules(c, 'no Gemini key'));
  if (limited('assess' + ip(req), 12, 10 * 60 * 1000)) return res.json(rules(c, 'demo rate limit'));

  const text = `You are an autonomous physical-security analyst reviewing one snapshot from a camera.
Camera: ${CAMERA} - ${DESC}
Local time: ${c.time}. Restricted hours (nobody should be here): ${c.restricted ? 'yes, now' : '22:00-06:00, not now'}.
The detector reported a possible ${c.label} (${Math.round(c.conf * 100)}% confidence). A person ${c.hasPerson ? 'is holding or near' : 'was not found near'} the object.
Images, in order: full scene, close-up of the detected object${b.images.length > 2 ? ', close-up of the person' : ''}.

Judge from what you actually see, using the context. Examples: an umbrella, tool, phone, toy or kitchen item in normal use is Safe; a real-looking weapon held or carried, especially during restricted hours or aimed at someone, is an Alert. If you cannot tell, say so and lean toward Alert.
Reply with JSON only: {"status": "Alert" or "Safe", "risk_score": 1-10, "summary": "two sentences: what you see and why"}`;
  const parts = [{ text }, ...b.images.map((data) => ({ inline_data: { mime_type: 'image/jpeg', data } }))];

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = JSON.parse((await r.json()).candidates[0].content.parts[0].text);
    return res.json({ status: /^alert/i.test(String(d.status)) ? 'Alert' : 'Safe',
      risk: Math.max(1, Math.min(10, parseInt(d.risk_score, 10) || 5)), source: 'gemini', verified: true,
      summary: String(d.summary || '').slice(0, 400) });
  } catch (e) {
    return res.json(rules(c, e.name === 'AbortError' ? 'timeout' : 'agent error'));
  } finally { clearTimeout(timer); }
};
