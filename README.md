# Tetsa web demo (separate from the main system)

Anyone who opens the link gets the page, which asks for their own camera and starts automatically.
The detector runs in their browser. Two small serverless functions call Gemini (the AI agent) and
Telegram (your bot), so your keys stay on the server.

```
index.html, style.css, engine.js, app.js   the page (camera, detector, virtual turret, history)
api/assess.js    AI agent: Gemini looks at the photos and returns Alert/Safe, risk, summary (rules if it fails)
api/alert.js     sends the alert and photos to your Telegram chat
model/           put threat_detector.onnx here  (model/threat_detector.onnx)
```

## Deploy on Vercel
1. Copy `threat_detector.onnx` into `demo/model/`.
2. In Vercel, create or open the project and set its **Root Directory** to `demo`, then deploy.
3. Project Settings -> Environment Variables: `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
   (optional: `GEMINI_MODEL`, and `DEMO_ALERTS=off` to stop all Telegram sending). Redeploy after adding them.
4. Open the link in Chrome or Edge on a laptop and allow the camera.

## Notes
- Camera needs https (Vercel gives that) or localhost. Nothing is installed by the judge.
- Each judge's history and photos are saved only in their own browser (last 8 incidents), not on your server.
- Public limits: 12 AI checks and 4 Telegram alerts per visitor per 10 minutes, 40 alerts per hour in total
  (best effort, per server instance). Turn Telegram off with `DEMO_ALERTS=off` if it gets abused.
- Judges' camera photos go to Gemini and to your Telegram only when a threat is confirmed and the
  "Send alerts to Telegram" box is ticked. The page says so. Avoid keeping those photos longer than needed.
- The detector runs on the judge's laptop CPU, so expect a few frames per second.
