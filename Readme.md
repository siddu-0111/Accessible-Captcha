# Haptic-only accessible CAPTCHA

A single-channel vibration CAPTCHA for blind, low-vision and deaf-blind users.
No images, no audio — just a slow, clear pattern of short and long pulses that
the user types back.

## Run it locally

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py                      # http://127.0.0.1:5000
python -m unittest tests.test_security -v