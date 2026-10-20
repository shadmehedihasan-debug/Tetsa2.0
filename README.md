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

## Tuning
- Camera moves the wrong way: set `PAN_SIGN=-1` or `TILT_SIGN=1` in `.env`
- Overshoots: lower `GAIN` or raise `LAG_S` in `config.py`
- Phone not found: try `CAMERA_INDEX=1` or `2`
- Wrong model name for Gemini: set `GEMINI_MODEL` in `.env`
