"""Challenge generation for the haptic-only accessible CAPTCHA.

A random pattern of short/long vibration pulses is generated server-side;
the user feels it (Vibration API) and types it back as S (short) / L (long).
"""
import random
from dataclasses import dataclass, field

_rng = random.SystemRandom()  # unpredictable challenge choices

# Milliseconds per pulse type and the silent gap between pulses.
# Slow and clearly distinguishable so the pattern is easy to follow by touch.
PULSE_MS = {"short": 250, "long": 700, "gap": 500}

MIN_PULSES = 4
MAX_PULSES = 5


@dataclass
class Challenge:
    mode: str = "haptic"
    prompt: str = ""
    answer: str = ""
    pattern: str | None = None
    meta: dict = field(default_factory=dict)


def make_haptic_challenge() -> Challenge:
    while True:
        n = _rng.randint(MIN_PULSES, MAX_PULSES)
        pattern = "".join(_rng.choice("SL") for _ in range(n))
        if "S" in pattern and "L" in pattern:   # avoid all-same patterns
            break
    prompt = (
        "Feel the vibration pattern, then type it using S for a short pulse "
        "and L for a long pulse. For example: SLS."
    )
    return Challenge(prompt=prompt, answer=pattern,
                     pattern=pattern, meta={"n": n})


def normalise(mode: str, text: str) -> str:
    text = (text or "")[:64]
    return "".join(c for c in text.upper() if c in "SL")