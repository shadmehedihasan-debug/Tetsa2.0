"""Frame source: the phone/webcam (live) or a recorded video file (backup for the demo)."""
import threading, time
import cv2
import config as C

class Camera:
    def __init__(self):
        self.mode, self.cap, self.lock = C.START_SOURCE, None, threading.Lock()
        self.index = C.CAMERA_INDEX
        self.ok, self._last = False, 0.0

    def switch(self, mode):
        if mode in ("live", "video"):
            with self.lock:
                self.mode = mode
                self._release()

    def _release(self):
        if self.cap: self.cap.release()
        self.cap, self.ok = None, False

    def _open(self):
        if self.mode == "live":
            cap = cv2.VideoCapture(self.index, cv2.CAP_DSHOW)
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        else:
            cap = cv2.VideoCapture(str(C.VIDEO_PATH))
        self.cap = cap if cap.isOpened() else None
        if not self.cap: cap.release()

    def read(self):
        with self.lock:
            if self.cap is None:
                self._open()
                if self.cap is None:
                    self.ok = False; time.sleep(1); return None
            ok, frame = self.cap.read()
            if not ok and self.mode == "video":        # loop the recording
                self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0); ok, frame = self.cap.read()
            if not ok:
                self._release(); return None
            if self.mode == "video":                   # play at real speed
                fps = self.cap.get(cv2.CAP_PROP_FPS) or 25
                wait = 1 / fps - (time.time() - self._last)
                if wait > 0: time.sleep(wait)
                self._last = time.time()
            self.ok = True
            return frame
