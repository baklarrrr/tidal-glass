"""How much light Tidal Glass puts on the additive display, normal vs calm.

Renders Now Playing at 600x600 with a typical album cover (synthetic, mean sRGB value about 0.52) and
measures, per frame: mean linear light (what an additive display emits, relative to an all-white
frame), and the share of pixels lit above 5%. Saves the frames for inspection.

Usage: light_measure.py [out_dir]
"""
import base64
import io
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from playwright.sync_api import sync_playwright

out = Path(sys.argv[1] if len(sys.argv) > 1 else "light")
out.mkdir(parents=True, exist_ok=True)

# A cover with album-art-like brightness: warm gradient, a bright shape, soft texture.
img = Image.new("RGB", (640, 640))
px = np.zeros((640, 640, 3), np.float32)
yy, xx = np.mgrid[0:640, 0:640] / 640.0
px[..., 0] = 0.25 + 0.55 * xx
px[..., 1] = 0.18 + 0.35 * yy
px[..., 2] = 0.35 + 0.30 * (1 - xx)
img = Image.fromarray((np.clip(px, 0, 1) * 255).astype(np.uint8))
d = ImageDraw.Draw(img)
d.ellipse((180, 140, 470, 430), fill=(245, 225, 190))
img = img.filter(ImageFilter.GaussianBlur(2))
buf = io.BytesIO()
img.save(buf, "JPEG", quality=88)
art = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
srgb = np.asarray(img, np.float32) / 255
print(f"cover mean sRGB value: {srgb.mean():.2f}")

KEY = "A" * 43
STATE = {"t": "state", "acc": True, "ses": True, "play": True, "buf": False, "ti": "Midnight City",
         "ar": "M83", "al": "Hurry Up, We're Dreaming", "dur": 243000, "pos": 61000, "liked": True,
         "seek": True, "vol": "9/15", "q": [], "qa": -1, "gb": 62, "art": art}


def light(png: bytes):
    a = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"), np.float32) / 255
    lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)  # sRGB -> linear light
    lum = lin @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    return float(lum.mean()), float((lum > 0.05).mean())


rows = {}
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", args=["--enable-spatial-navigation"])
    pg = b.new_context(viewport={"width": 600, "height": 600}).new_page()
    pg.add_init_script("window.__sent=[]; window.__testLink={connected:true, publish(t,b){window.__sent.push(b)}, end(){}};")
    pg.goto(f"http://127.0.0.1:47611/index.html#t=lighttest&k={KEY}")
    pg.wait_for_function("typeof key !== 'undefined' && key !== null")
    pg.evaluate("s => { state = {...s, at: Date.now()}; lastHeard = Date.now(); renderNow(); }", STATE)
    pg.wait_for_function("document.getElementById('art').complete && !document.getElementById('art').hidden")
    pg.focus("#toggle")
    pg.wait_for_timeout(400)
    for name in ("normal", "calm"):
        if name == "calm":
            pg.evaluate("lastInputAt = Date.now() - 20000; checkCalm();")
            pg.wait_for_timeout(1300)  # let the ease into calm finish
        shot = pg.screenshot()
        (out / f"now-{name}.png").write_bytes(shot)
        rows[name] = light(shot)
    # Waking: one swipe restores at once and still moves focus.
    before = pg.evaluate("document.activeElement.id")
    pg.keyboard.press("ArrowRight")
    pg.wait_for_timeout(100)
    woke = pg.evaluate("[document.body.classList.contains('calm'), document.activeElement.id]")
    b.close()

n, c = rows["normal"], rows["calm"]
print(json.dumps({"normal": {"meanLight": round(n[0], 4), "litShare": round(n[1], 3)},
                  "calm": {"meanLight": round(c[0], 4), "litShare": round(c[1], 3)},
                  "lightSaved": f"{(1 - c[0] / n[0]) * 100:.0f}%",
                  "wake": {"focusBefore": before, "calmAfterSwipe": woke[0], "focusAfterSwipe": woke[1]}}, indent=1))
