"""Telegram alerts. Failed sends stay marked unsent and are retried by flush()."""
import json
import requests
import config as C

class Telegram:
    configured = property(lambda self: bool(C.TELEGRAM_BOT_TOKEN and C.TELEGRAM_CHAT_ID))

    def _url(self, method): return f"https://api.telegram.org/bot{C.TELEGRAM_BOT_TOKEN}/{method}"

    def caption(self, inc):
        if inc["notify"] == "low":
            head = f"Low priority (agent: {inc['status']}, risk {inc['risk']}/10)"
        elif inc["source"] == "rules":
            head = f"UNVERIFIED ALERT (risk {inc['risk']}/10)"
        else:
            head = f"SECURITY ALERT (risk {inc['risk']}/10)"
        return (f"{head}\nTime: {inc['ts']}\nCamera: {inc['camera']}\n"
                f"Detected: possible {inc['label']} ({inc['conf']:.0%})\n"
                f"Summary: {inc['summary']}\nAutomatic detection - please review before acting.")[:1000]

    def send(self, inc, paths):
        """paths: existing image files. Returns True when Telegram accepted the message."""
        if not self.configured: return False
        try:
            cap, chat = self.caption(inc), C.TELEGRAM_CHAT_ID
            if not paths:
                r = requests.post(self._url("sendMessage"), data={"chat_id": chat, "text": cap}, timeout=15)
            elif len(paths) == 1:                      # sendMediaGroup needs at least 2 photos
                r = requests.post(self._url("sendPhoto"), data={"chat_id": chat, "caption": cap},
                                  files={"photo": (paths[0].name, paths[0].read_bytes(), "image/jpeg")}, timeout=30)
            else:
                media, files = [], {}
                for i, p in enumerate(paths):
                    files[f"p{i}"] = (p.name, p.read_bytes(), "image/jpeg")
                    media.append({"type": "photo", "media": f"attach://p{i}", **({"caption": cap} if i == 0 else {})})
                r = requests.post(self._url("sendMediaGroup"),
                                  data={"chat_id": chat, "media": json.dumps(media)}, files=files, timeout=30)
            if not r.ok: print("Telegram refused the message:", r.status_code, r.text[:200])
            return r.ok
        except Exception as e:
            print("Telegram error:", type(e).__name__)
            return False

    def deliver(self, store, iid):
        """Send one incident and, if Telegram accepts it, record how many photos went out."""
        inc, paths = store.get(iid), store.images(iid)
        if inc and self.send(inc, paths):
            store.mark_sent(iid); store.log_send(iid, inc["notify"], len(paths)); return True
        return False

    def flush(self, store):
        for inc in store.unsent():
            self.deliver(store, inc["id"])
