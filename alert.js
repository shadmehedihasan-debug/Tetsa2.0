// Sends one alert (caption + up to 3 photos) to the Tetsa team's Telegram chat.
// Bot token and chat id live in Vercel environment variables, never in the page.
const { ip, limited, imagesOk, LABELS } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat || process.env.DEMO_ALERTS === 'off') return res.json({ ok: false, reason: 'Telegram alerts are switched off for this demo' });
  const b = req.body || {};
  if (![...LABELS, 'Test'].includes(b.label) || !['Alert', 'Safe'].includes(b.status) || !imagesOk(b.images))
    return res.status(400).json({ error: 'bad request' });
  if (limited('alert' + ip(req), 4, 10 * 60 * 1000) || limited('alert-all', 40, 60 * 60 * 1000))
    return res.json({ ok: false, reason: 'demo rate limit reached, try again in a few minutes' });

  const risk = Math.max(1, Math.min(10, parseInt(b.risk, 10) || 1));
  const head = b.low ? `Low priority (agent: ${b.status}, risk ${risk}/10)`
    : b.source === 'test' ? 'TEST ALERT'
    : b.source === 'rules' ? `UNVERIFIED ALERT (risk ${risk}/10)` : `SECURITY ALERT (risk ${risk}/10)`;
  const caption = `[DEMO] ${head}\nTime: ${String(b.ts || '').slice(0, 30)}\nCamera: Back Exit\n` +
    `Detected: possible ${b.label} (${Math.round((Number(b.conf) || 0) * 100)}%)\nSummary: ${String(b.summary || '').slice(0, 300)}\n` +
    'Automatic detection - please review before acting.';
  try {
    const fd = new FormData();
    fd.append('chat_id', chat);
    fd.append('media', JSON.stringify(b.images.map((_, i) => ({ type: 'photo', media: `attach://p${i}`, ...(i === 0 ? { caption } : {}) }))));
    b.images.forEach((s, i) => fd.append(`p${i}`, new Blob([Buffer.from(s, 'base64')], { type: 'image/jpeg' }), `p${i}.jpg`));
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: 'POST', body: fd });
    return res.json(r.ok ? { ok: true, photos: b.images.length } : { ok: false, reason: 'Telegram refused the message' });
  } catch (e) { return res.json({ ok: false, reason: 'could not reach Telegram' }); }
};
