// Shared helpers for the two serverless functions. Files starting with _ are not public routes.
const hits = new Map();

function ip(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

// Best-effort limit (kept in memory of one server instance): true when `id` used its quota.
function limited(id, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(id) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) { hits.set(id, list); return true; }
  list.push(now); hits.set(id, list); return false;
}

// 1-3 base64 JPEG strings, each under ~500 KB.
function imagesOk(list) {
  return Array.isArray(list) && list.length >= 1 && list.length <= 3 &&
    list.every((s) => typeof s === 'string' && s.length < 700000 && /^[A-Za-z0-9+/=]+$/.test(s));
}

module.exports = { ip, limited, imagesOk, LABELS: ['Gun', 'Knife', 'Grenade'], CAMERA: 'Back Exit',
  DESC: 'Monitors the back exit door. Nobody should be here at night.' };
