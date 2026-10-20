# Tetsa

```
backend/   Python: camera, detector, tracker, AI agent (Gemini), Telegram, ESP32 link, web server
frontend/  index.html: intro page + dashboard (served by the backend)
firmware/  esp32_turret/esp32_turret.ino
```

## Run
1. `cd backend`, then `py -m pip install -r requirements.txt`
2. Copy `threat_detector.onnx` into `backend/models/`
3. Copy `.env.example` to `.env` and fill in your keys (never share this file)
4. For the recorded-video backup, put an `.mp4` at `backend/demo.mp4`
5. `py main.py`, then open http://localhost:8000
6. Flash `firmware/esp32_turret/esp32_turret.ino` with the Arduino IDE (library: ESP32Servo)

## Demo (no phone, no ESP32)
Open `http://localhost:8000/demo.html`, or press **Demo** on the intro page. The laptop camera replaces the phone (`DEMO_CAMERA_INDEX` in `.env`), a virtual turret on the page replaces the ESP32, and the laptop speaker replaces the buzzer. The AI agent, Telegram alerts, history and photos work exactly as in the real setup.

## Tuning
- Camera moves the wrong way: set `PAN_SIGN=-1` or `TILT_SIGN=1` in `.env`
- Overshoots: lower `GAIN` or raise `LAG_S` in `config.py`
- Photos and Telegram history: every incident's photos are in `backend/data/incidents/<id>/`; every Telegram message is logged with its photo count (`/api/history`). Photos are deleted after `RETAIN_DAYS` (default 7, set in `.env`); the counts stay until you press Reset
- Database: `backend/data/tetsa.db` (SQLite, created on first run from `backend/schema.sql`). Open it with DB Browser for SQLite, or press "Download history (CSV)" on the dashboard
- Phone not found: try `CAMERA_INDEX=1` or `2`
- Wrong model name for Gemini: set `GEMINI_MODEL` in `.env`
