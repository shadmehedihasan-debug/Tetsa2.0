"""All settings in one place. Values come from .env (see .env.example)."""
import os
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

def _s(k, d=""): return os.getenv(k, d).strip()
def _f(k, d): return float(_s(k, str(d)))
def _i(k, d): return int(_s(k, str(d)))

MODEL_PATH = ROOT / _s("MODEL_PATH", "models/threat_detector.onnx")
DATA_DIR = ROOT / "data"
FRONTEND_DIR = ROOT.parent / "frontend"

# camera and context given to the AI agent
CAMERA_NAME = _s("CAMERA_NAME", "Back Exit")
CAMERA_DESC = _s("CAMERA_DESC", "Monitors the back exit door.")
RESTRICTED_START = _i("RESTRICTED_START", 22)
RESTRICTED_END = _i("RESTRICTED_END", 6)
CAMERA_INDEX = _i("CAMERA_INDEX", 0)
VIDEO_PATH = _s("VIDEO_PATH", "demo.mp4")
START_SOURCE = _s("START_SOURCE", "live")  # live | video

# detector
WEAPON_NAMES = ["Gun", "Explosion", "Grenade", "Knife"]
MIN_CONF = {"Gun": .30, "Explosion": .40, "Grenade": .30, "Knife": .30, "Human": .40}
TRIGGERS = ("Gun", "Knife", "Grenade")  # Explosion is drawn but never alerts
NMS_IOU = .45

# threat logic
CANDIDATE_CONF = .35          # lock on and turn on the light
CONFIRM_CONF = .60            # a frame only counts as a hit above this
CONFIRM_HITS, CONFIRM_WINDOW = 5, 8   # 5 hits in the last 8 frames
COOLDOWN_S = 60
ALERT_MIN_RISK = 6
LOW_PRIORITY_SAFE = True      # still send a quiet message when the agent says Safe
BUZZER_MS = 3000
RETAIN_DAYS = 7

# turret / aiming
HFOV, VFOV = _f("HFOV", 60), _f("VFOV", 45)
PAN_SIGN, TILT_SIGN = _i("PAN_SIGN", 1), _i("TILT_SIGN", -1)   # flip if it moves the wrong way
PAN_LIM, TILT_LIM = (10, 170), (40, 140)
PATROL_LIM, PATROL_SPEED, IDLE_S = (30, 150), 12.0, 3.0
GAIN, DEAD_ZONE, MAX_STEP, LAG_S = .6, 2.0, 6.0, .15
SERIAL_PORT = _s("SERIAL_PORT")
BAUD = 115200

# services
GEMINI_API_KEY = _s("GEMINI_API_KEY")
GEMINI_MODEL = _s("GEMINI_MODEL", "gemini-2.5-flash")
AGENT_TIMEOUT = _f("AGENT_TIMEOUT", 8)
TELEGRAM_BOT_TOKEN = _s("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = _s("TELEGRAM_CHAT_ID")

def is_restricted(dt):
    h, a, b = dt.hour, RESTRICTED_START, RESTRICTED_END
    return (h >= a or h < b) if a > b else (a <= h < b)
