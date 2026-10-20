"""Web server: live video, state, incidents, controls, and the dashboard page itself."""
import time
from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import config as C
from pipeline import Pipeline

app = FastAPI(title="Tetsa")
pipe = Pipeline()

@app.on_event("startup")
def _start(): pipe.start()

@app.get("/api/health")
def health():
    return {"camera": pipe.cam.ok, "turret": pipe.turret.ok, "agent": pipe.agent.configured, "error": pipe.error}

@app.get("/api/state")
def state(): return pipe.state()

@app.get("/api/incidents")
def incidents(): return pipe.store.recent()

@app.get("/incidents/{iid}/{kind}")
def evidence(iid: int, kind: str):
    if kind not in ("scene", "object", "person"): raise HTTPException(404)
    p = C.DATA_DIR / "incidents" / str(iid) / f"{kind}.jpg"
    if not p.exists(): raise HTTPException(404)
    return FileResponse(p, media_type="image/jpeg")

@app.get("/video")
def video():
    def gen():
        last = None
        while True:
            with pipe.cond:
                pipe.cond.wait(timeout=2)
                f = pipe.jpeg
            if f is not None and f is not last:
                last = f
                yield b"--f\r\nContent-Type: image/jpeg\r\n\r\n" + f + b"\r\n"
    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=f")

@app.post("/api/source")
def source(body: dict = Body(...)):
    pipe.cam.switch(body.get("mode")); return pipe.state()

@app.post("/api/control")
def control(body: dict = Body(...)):
    for k, attr in (("armed", "armed"), ("muted", "muted"), ("patrol", "patrol"), ("light", "light_manual")):
        if k in body: setattr(pipe, attr, bool(body[k]))
    return pipe.state()

@app.post("/api/center")
def center(): pipe.aimer.center(); return pipe.state()

@app.post("/api/test-alert")
def test_alert():
    iid = pipe.test_alert()
    if iid is None: raise HTTPException(503, "No camera frame yet")
    return {"id": iid}

@app.post("/api/reset")
def reset(): pipe.store.wipe(); return {"ok": True}

app.mount("/", StaticFiles(directory=C.FRONTEND_DIR, html=True), name="frontend")
