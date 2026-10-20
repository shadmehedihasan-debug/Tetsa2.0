"""The AI agent: looks at the photos plus context and decides Alert or Safe.
Uses Gemini Flash. If it is offline, slow or returns bad JSON, simple rules decide instead
and the incident is marked unverified, so an alert is never silently dropped."""
import base64, json
import requests
import config as C

PROMPT = """You are an autonomous physical-security analyst reviewing one snapshot from a camera.
Camera: {camera} - {desc}
Local time: {time}. Restricted hours (nobody should be here): {restricted}.
The detector reported a possible {label} ({conf:.0%} confidence). A person {holder} the object.
Images, in order: full scene, close-up of the detected object{person_img}.

Judge from what you actually see, using the context. Examples: an umbrella, tool, phone, toy or
kitchen item in normal use is Safe; a real-looking weapon held or carried, especially during
restricted hours or aimed at someone, is an Alert. If you cannot tell, say so and lean toward Alert.
Reply with JSON only: {{"status": "Alert" or "Safe", "risk_score": 1-10, "summary": "two sentences: what you see and why"}}"""

def fallback(ctx, why):
    base = {"Gun": 7, "Grenade": 7, "Knife": 6}.get(ctx["label"], 5)
    risk = min(10, base + (2 if ctx["restricted_now"] else 0) + (1 if ctx["has_person"] else 0))
    note = f"Automatic rule-based check ({why}); not reviewed by the AI agent. "
    return {"status": "Alert", "risk": risk, "source": "rules", "verified": False,
            "summary": note + f"Possible {ctx['label']} at {ctx['camera']}"
                       + (" during restricted hours." if ctx["restricted_now"] else ".")}

class Agent:
    configured = property(lambda self: bool(C.GEMINI_API_KEY))

    def assess(self, ctx, jpegs):
        if not self.configured:
            return fallback(ctx, "no Gemini key")
        text = PROMPT.format(camera=ctx["camera"], desc=C.CAMERA_DESC, time=ctx["time"],
                             restricted="yes, now" if ctx["restricted_now"] else
                             f"{C.RESTRICTED_START}:00-{C.RESTRICTED_END}:00, not now",
                             label=ctx["label"], conf=ctx["conf"],
                             holder="is holding or near" if ctx["has_person"] else "was not found near",
                             person_img=", close-up of the person" if len(jpegs) > 2 else "")
        parts = [{"text": text}] + [{"inline_data": {"mime_type": "image/jpeg",
                 "data": base64.b64encode(j).decode()}} for j in jpegs]
        try:
            r = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{C.GEMINI_MODEL}:generateContent",
                headers={"x-goog-api-key": C.GEMINI_API_KEY},
                json={"contents": [{"parts": parts}],
                      "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2}},
                timeout=C.AGENT_TIMEOUT)
            r.raise_for_status()
            data = json.loads(r.json()["candidates"][0]["content"]["parts"][0]["text"])
            status = "Alert" if str(data["status"]).lower().startswith("alert") else "Safe"
            risk = max(1, min(10, int(data["risk_score"])))
            return {"status": status, "risk": risk, "source": "gemini", "verified": True,
                    "summary": str(data["summary"])[:400]}
        except Exception as e:
            return fallback(ctx, type(e).__name__)
