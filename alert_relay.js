// alert_relay.js — Cloudflare Worker that forwards alerts (text + photos) to a Telegram chat.
// It keeps your bot token OFF the phone page.
//
// Setup (about 10 minutes):
//   1. In Telegram, talk to @BotFather -> /newbot -> copy the BOT TOKEN.
//   2. Add the bot to the headquarters chat (or message it), then get the chat id
//      (open https://api.telegram.org/bot<TOKEN>/getUpdates after sending a message).
//   3. Cloudflare dashboard -> Workers -> Create -> paste this file -> Deploy.
//   4. Worker Settings -> Variables (as secrets): BOT_TOKEN, CHAT_ID, API_KEY (any long random string).
//   5. Put the Worker URL in ALERT_URL and the same API_KEY in ALERT_KEY at the top of index.html.
//
// Note: ALERT_KEY sits in the page, so anyone who can open the page can read it. It only stops random
// internet spam. Keep the page URL private (or put it behind Cloudflare Access).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'x-api-key',
};
const reply = (body, status = 200) => new Response(body, { status, headers: CORS });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return reply(null, 204);
    if (req.method !== 'POST') return reply('POST only', 405);
    if (env.API_KEY && req.headers.get('x-api-key') !== env.API_KEY) return reply('forbidden', 403);

    const inc = await req.formData();
    const caption = String(inc.get('caption') || 'Alert').slice(0, 1000);
    const files = ['snapshot', 'object', 'person'].map(k => [k, inc.get(k)]).filter(([, f]) => f && f.size);
    const out = new FormData();
    out.append('chat_id', env.CHAT_ID);

    let method;
    if (files.length === 0) {
      method = 'sendMessage';
      out.append('text', caption);
    } else if (files.length === 1) {
      method = 'sendPhoto';
      out.append('caption', caption);
      out.append('photo', files[0][1], 'photo.jpg');
    } else {
      method = 'sendMediaGroup';
      out.append('media', JSON.stringify(files.map(([k], i) =>
        ({ type: 'photo', media: 'attach://' + k, ...(i === 0 ? { caption } : {}) }))));
      for (const [k, f] of files) out.append(k, f, k + '.jpg');
    }
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', body: out });
    return reply(await r.text(), r.status);
  },
};
