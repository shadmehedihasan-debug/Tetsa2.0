"""Aiming logic and the USB-serial link to the ESP32 (P<pan>,T<tilt> / L0|L1 / B<ms> / R0|R1)."""
import threading, time
import config as C

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    serial = None

clamp = lambda v, lo, hi: max(lo, min(hi, v))

class Aimer:
    """Turns the target's position in the frame into pan/tilt angles; sweeps when idle."""
    def __init__(self):
        self.pan = self.tilt = 90.0
        self.last_target, self.dir, self.hold_until, self.last_t = time.time(), 1, 0.0, time.time()

    def center(self): self.pan = self.tilt = 90.0

    @property
    def idle_s(self): return time.time() - self.last_target

    def step(self, box, W, H, patrol=True):
        now = time.time(); dt = min(now - self.last_t, .5); self.last_t = now
        if box:
            self.last_target = now
            if now < self.hold_until: return        # frame is from before the last move finished
            ex = ((box[0] + box[2]) / 2 / W - .5) * C.HFOV
            ey = ((box[1] + box[3]) / 2 / H - .5) * C.VFOV
            moved = False
            if abs(ex) > C.DEAD_ZONE:
                self.pan += clamp(C.PAN_SIGN * C.GAIN * ex, -C.MAX_STEP, C.MAX_STEP); moved = True
            if abs(ey) > C.DEAD_ZONE:
                self.tilt += clamp(C.TILT_SIGN * C.GAIN * ey, -C.MAX_STEP, C.MAX_STEP); moved = True
            if moved: self.hold_until = now + C.LAG_S
        elif patrol and self.idle_s > C.IDLE_S:
            self.pan += self.dir * C.PATROL_SPEED * dt
            if not C.PATROL_LIM[0] <= self.pan <= C.PATROL_LIM[1]: self.dir *= -1
            self.tilt += clamp(90 - self.tilt, -2 * dt, 2 * dt)
        self.pan = clamp(self.pan, *C.PAN_LIM); self.tilt = clamp(self.tilt, *C.TILT_LIM)

class Turret:
    def __init__(self):
        self.ser, self.light, self.pan, self.tilt = None, False, 90.0, 90.0
        self._buzz = 0
        threading.Thread(target=self._run, daemon=True).start()

    ok = property(lambda self: self.ser is not None)

    def set(self, pan, tilt, light): self.pan, self.tilt, self.light = pan, tilt, light
    def buzz(self, ms): self._buzz = ms

    def _find(self):
        if C.SERIAL_PORT: return C.SERIAL_PORT
        for p in list_ports.comports():
            if any(k in (p.description or "") for k in ("CP210", "CH340", "USB Serial", "USB-SERIAL", "Silicon Labs")):
                return p.device
        return None

    def _run(self):
        while True:
            try:
                if self.ser is None:
                    port = self._find() if serial else None
                    if port: self.ser = serial.Serial(port, C.BAUD, timeout=.1); time.sleep(2)
                if self.ser:
                    msg = f"P{self.pan:.0f},T{self.tilt:.0f}\nL{int(self.light)}\n"
                    if self._buzz: msg += f"B{self._buzz}\n"; self._buzz = 0
                    self.ser.write(msg.encode())       # sent 5x a second; the ESP32 shuts outputs off if it stops
            except Exception:
                try: self.ser.close()
                except Exception: pass
                self.ser = None
            time.sleep(.2)
