"""Security tests: replay, expiry, brute force, rate limiting, guessing baseline.

Run from the project root (the folder containing app.py):
    python -m unittest tests.test_security -v
"""
import os
import random
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import generator                       # noqa: E402
from app import create_app              # noqa: E402


def make(**over):
    cfg = dict(TESTING=True,
               LOG_PATH=os.path.join(tempfile.mkdtemp(), "e.jsonl"),
               CHALLENGES_PER_MIN=10**6,
               FAILS_PER_5MIN=10**6)
    cfg.update(over)
    app = create_app(cfg)
    return app, app.test_client()


def new(client):
    return client.post("/api/challenge", json={}).get_json()


def verify(client, token, answer):
    return client.post("/api/verify",
                       json={"token": token, "answer": answer}).get_json()


class SecurityTests(unittest.TestCase):
    def test_correct_answer_passes(self):
        app, c = make()
        ch = new(c)
        self.assertTrue(verify(c, ch["token"],
                               app.store[ch["token"]]["plain"])["ok"])

    def test_normalisation(self):
        app, c = make()
        ch = new(c)
        ans = app.store[ch["token"]]["plain"]
        self.assertTrue(verify(c, ch["token"], " " + ans.lower() + " ")["ok"])

    def test_replay_after_success_rejected(self):
        app, c = make()
        ch = new(c)
        ans = app.store[ch["token"]]["plain"]
        self.assertTrue(verify(c, ch["token"], ans)["ok"])
        self.assertFalse(verify(c, ch["token"], ans)["ok"])

    def test_single_attempt_after_wrong(self):
        app, c = make()
        ch = new(c)
        ans = app.store[ch["token"]]["plain"]
        self.assertFalse(verify(c, ch["token"], "ZZZZ")["ok"])
        # token already consumed
        self.assertFalse(verify(c, ch["token"], ans)["ok"])

    def test_expiry(self):
        app, c = make(TTL=1)
        ch = new(c)
        ans = app.store[ch["token"]]["plain"]
        time.sleep(1.2)
        self.assertEqual(verify(c, ch["token"], ans)["reason"], "expired")

    def test_forged_token(self):
        _, c = make()
        self.assertFalse(verify(c, "forged", "SLSL")["ok"])

    def test_answer_only_leaks_via_pattern_field(self):
        """The verify response never carries the answer; the pattern *is*
        sent in the challenge response (needed to drive navigator.vibrate),
        which is the documented trade-off."""
        app, c = make()
        ch = new(c)
        ans = app.store[ch["token"]]["plain"]
        redacted = {k: v for k, v in ch.items() if k != "pattern"}
        self.assertNotIn(ans, str(redacted))
        self.assertEqual(ch["pattern"], ans)

    def test_challenge_rate_limit(self):
        _, c = make(CHALLENGES_PER_MIN=5)
        codes = [c.post("/api/challenge", json={}).status_code
                 for _ in range(8)]
        self.assertEqual(codes[:5], [200] * 5)
        self.assertTrue(all(x == 429 for x in codes[5:]))

    def test_lockout_after_failures(self):
        _, c = make(FAILS_PER_5MIN=3)
        for _ in range(3):
            verify(c, new(c)["token"], "ZZZZ")
        r = c.post("/api/challenge", json={})
        self.assertEqual(r.status_code, 429)
        self.assertIn("Retry-After", r.headers)

    def test_pattern_has_both_symbols(self):
        for _ in range(500):
            p = generator.make_haptic_challenge().pattern
            self.assertIn("S", p)
            self.assertIn("L", p)
            self.assertTrue(generator.MIN_PULSES <= len(p)
                            <= generator.MAX_PULSES)

    def test_random_guess_rate(self):
        """Sanity check on pattern entropy, NOT a security guarantee.
        The real brute-force defence is the rate limiter + one-shot tokens."""
        rng = random.Random(1)
        N = 20000
        hits = 0
        for _ in range(N):
            ans = generator.make_haptic_challenge().answer
            hits += "".join(rng.choice("SL")
                            for _ in range(len(ans))) == ans
        rate = hits / N
        print(f"\n  blind-guess success (haptic): {rate:.3%}")
        self.assertLess(rate, 0.06)


if __name__ == "__main__":
    unittest.main(verbosity=2)