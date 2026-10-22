// Retrieval for the AI agent: chunks = the site rules in _policies.js.
// Hybrid search: BM25 keyword ranking + Gemini embedding similarity, merged with reciprocal rank fusion.
// The index lives in memory of the running function. If embeddings fail, keyword search alone still works.
const POLICIES = require('./_policies');

const EMB_MODEL = 'gemini-embedding-001', EMB_DIM = 768;
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/' + EMB_MODEL;
const STOP = new Set('a an and are as at be by for from has in is it its of on or that the this to was were with not never any'.split(' '));

const tok = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
const norm = (v) => { const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1; return v.map((x) => x / n); };
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

// ---- keyword side (BM25) ----
const docs = POLICIES.map((p) => tok(p.title + ' ' + p.text));
const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length;
const df = new Map();
docs.forEach((d) => new Set(d).forEach((w) => df.set(w, (df.get(w) || 0) + 1)));
function bm25(query) {
  const q = tok(query), k1 = 1.5, b = .75;
  return docs.map((d) => {
    const tf = new Map(); d.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
    return q.reduce((s, w) => {
      if (!tf.has(w)) return s;
      const idf = Math.log(1 + (docs.length - df.get(w) + .5) / (df.get(w) + .5)), f = tf.get(w);
      return s + idf * f * (k1 + 1) / (f + k1 * (1 - b + b * d.length / avg));
    }, 0);
  });
}

// ---- vector side ----
async function post(url, key, body, ms) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
let index = null, failedAt = 0;       // index: promise of the chunk vectors
function vectors(key, ms) {
  if (index) return index;
  if (Date.now() - failedAt < 60000) return Promise.resolve(null);
  index = post(BASE + ':batchEmbedContents', key, { requests: POLICIES.map((p) => ({
      model: 'models/' + EMB_MODEL, taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: EMB_DIM,
      content: { parts: [{ text: p.title + '. ' + p.text }] } })) }, ms)
    .then((d) => d.embeddings.map((e) => norm(e.values)))
    .catch(() => { index = null; failedAt = Date.now(); return null; });
  return index;
}

// Fuse several rankings: each item scores 1/(60+rank) per list.
function fuse(lists) {
  const score = new Map();
  lists.forEach((scores) => scores.map((s, i) => [s, i]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0])
    .forEach(([, i], rank) => score.set(i, (score.get(i) || 0) + 1 / (60 + rank))));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
}

// Returns { rules: [{id,title,text}], mode: 'hybrid' | 'keyword' }
async function retrieve(key, query, top = 3, ms = 2500) {
  const lists = [bm25(query)];
  let mode = 'keyword';
  try {
    const vecs = key ? await vectors(key, ms) : null;
    if (vecs) {
      const q = await post(BASE + ':embedContent', key, { model: 'models/' + EMB_MODEL, taskType: 'RETRIEVAL_QUERY',
        outputDimensionality: EMB_DIM, content: { parts: [{ text: query }] } }, ms);
      const qv = norm(q.embedding.values);
      lists.push(vecs.map((v) => dot(v, qv))); mode = 'hybrid';
    }
  } catch (e) { /* keyword results only */ }
  const order = fuse(lists).slice(0, top);
  return { rules: order.map((i) => POLICIES[i]), mode };
}

module.exports = { retrieve, bm25, fuse, POLICIES };
