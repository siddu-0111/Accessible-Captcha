"""Flask server for the haptic-only accessible CAPTCHA.

Issues challenges and verifies answers once.

Production entrypoint:
    gunicorn -w 1 -b 0.0.0.0:$PORT app:app

IMPORTANT: challenge store, HMAC key and rate limiters live in-process, so
run with a SINGLE worker. If you need multiple workers, move state to Redis.
"""
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from collections import defaultdict, deque

from flask import Flask, jsonify, request, send_from_directory

import generator

HERE = os.path.dirname(os.path.abspath(__file__))


class SlidingWindow:
    """Per-key sliding-window rate limiter (in-process)."""

    def __init__(self, limit: int, seconds: int):
        self.limit, self.seconds = limit, seconds
        self.hits = defaultdict(deque)
        self.lock = threading.Lock()

    def _prune(self, key, now):
        q = self.hits[key]
        while q and now - q[0] > self.seconds:
            q.popleft()
        return q

    def blocked(self, key) -> int:
        """Seconds until allowed again, or 0 if under the limit."""
        with self.lock:
            now = time.time()
            q = self._prune(key, now)
            if len(q) >= self.limit:
                return int(self.seconds - (now - q[0])) + 1
            return 0

    def record(self, key):
        with self.lock:
            self.hits[key].append(time.time())

    def hit(self, key) -> int:
        # blocked() and record() take the lock separately, so two concurrent
        # requests can both observe "under limit" and both record. Fine at
        # these thresholds; make it atomic (or use Redis) if you need strict
        # enforcement.
        retry = self.blocked(key)
        if not retry:
            self.record(key)
        return retry


def create_app(config=None):
    cfg = dict(
        TTL=120,                    # seconds a challenge stays valid
        CHALLENGES_PER_MIN=15,      # per IP
        FAILS_PER_5MIN=10,          # per IP, then temporary block
        LOG_PATH=os.path.join(HERE, "logs", "events.jsonl"),
        TRUST_PROXY=False,          # set True only when behind a proxy you control
        TESTING=False,
    )
    cfg.update(config or {})
    app = Flask(__name__,
                static_folder=os.path.join(HERE, "static"),
                static_url_path="/static")
    app.config.update(cfg)

    # Per-process HMAC key + challenge store. See module docstring.
    key = secrets.token_bytes(32)
    store, lock = {}, threading.Lock()
    app.store = store
    challenge_limit = SlidingWindow(cfg["CHALLENGES_PER_MIN"], 60)
    fail_limit = SlidingWindow(cfg["FAILS_PER_5MIN"], 300)
    os.makedirs(os.path.dirname(cfg["LOG_PATH"]), exist_ok=True)

    def ip():
        if cfg["TRUST_PROXY"]:
            fwd = request.headers.get("X-Forwarded-For", "")
            if fwd:
                return fwd.split(",")[0].strip() or "unknown"
        return request.remote_addr or "unknown"

    def log(event, **kw):
        row = {"ts": round(time.time(), 3), "event": event,
               "ip": hashlib.sha256(ip().encode()).hexdigest()[:10], **kw}
        with open(cfg["LOG_PATH"], "a") as f:
            f.write(json.dumps(row) + "\n")

    def sweep():
        now = time.time()
        for t in [t for t, r in store.items() if now > r["expires"]]:
            store.pop(t, None)

    def digest(salt: bytes, answer: str) -> str:
        return hmac.new(key, salt + answer.encode(), hashlib.sha256).hexdigest()

    def too_many(retry):
        r = jsonify(error="rate_limited",
                    message="Too many attempts. Please wait and try again.")
        r.status_code = 429
        r.headers["Retry-After"] = str(retry)
        return r

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/healthz")
    def healthz():
        return jsonify(ok=True)

    @app.post("/api/challenge")
    def challenge():
        retry = fail_limit.blocked(ip()) or challenge_limit.hit(ip())
        if retry:
            log("rate_limited")
            return too_many(retry)
        ch = generator.make_haptic_challenge()
        token = secrets.token_urlsafe(24)
        salt = secrets.token_bytes(8)
        rec = dict(salt=salt, hash=digest(salt, ch.answer),
                   issued=time.time(), expires=time.time() + cfg["TTL"],
                   ip=ip())
        if cfg["TESTING"]:
            rec["plain"], rec["meta"] = ch.answer, ch.meta
        with lock:
            sweep()
            store[token] = rec
        log("issued")
        return jsonify(token=token, mode="haptic", prompt=ch.prompt,
                       pattern=ch.pattern, pulse_ms=generator.PULSE_MS,
                       expires_in=cfg["TTL"])

    @app.post("/api/verify")
    def verify():
        body = request.get_json(silent=True) or {}
        token = str(body.get("token", ""))
        with lock:
            rec = store.pop(token, None)  # one attempt: consumed either way
        if not rec or rec["ip"] != ip():
            log("verify", ok=False, reason="unknown_or_used")
            fail_limit.record(ip())
            return jsonify(ok=False, reason="unknown_or_used")
        elapsed = time.time() - rec["issued"]
        meta = dict(server_s=round(elapsed, 2), replays=body.get("replays"))
        if time.time() > rec["expires"]:
            log("verify", ok=False, reason="expired", **meta)
            return jsonify(ok=False, reason="expired")
        answer = generator.normalise("haptic", str(body.get("answer", "")))
        ok = hmac.compare_digest(digest(rec["salt"], answer), rec["hash"])
        if not ok:
            fail_limit.record(ip())
        log("verify", ok=ok, reason="ok" if ok else "wrong", **meta)
        return jsonify(ok=ok, reason="ok" if ok else "wrong")

    return app


app = create_app()  # gunicorn target: `gunicorn app:app`

if __name__ == "__main__":
    app.run(host="0.0.0.0",
            port=int(os.environ.get("PORT", 5000)),
            debug=False)