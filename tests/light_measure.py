"""How much light Tidal Glass puts on the additive display, normal vs calm.

Renders 600x600 frames and measures, per frame: mean linear light (what an additive display emits,
relative to an all-white frame), and the share of pixels lit above 5%. Saves the frames for inspection.

  Now Playing with a typical album cover (synthetic, mean sRGB value about 0.52) and with a pale one
  (the Photographer's worst case, 2026-10-25), each at rest and in calm;
  Sound Lab with the phone's usual sound, at rest and in calm.

Usage: light_measure.py [out_dir] [base_url]   (base_url default http://127.0.0.1:47611/; serve webapp/ there)
A build without calm on a screen reports that screen's calm frame as "no calm" instead of a number.
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
BASE = (sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:47611/").rstrip("/") + "/"


def data_url(img):
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def cover_typical():
    # Album-art-like brightness: warm gradient, a bright shape, soft texture.
    px = np.zeros((640, 640, 3), np.float32)
    yy, xx = np.mgrid[0:640, 0:640] / 640.0
    px[..., 0] = 0.25 + 0.55 * xx
    px[..., 1] = 0.18 + 0.35 * yy
    px[..., 2] = 0.35 + 0.30 * (1 - xx)
    img = Image.fromarray((np.clip(px, 0, 1) * 255).astype(np.uint8))
    ImageDraw.Draw(img).ellipse((180, 140, 470, 430), fill=(245, 225, 190))
    return img.filter(ImageFilter.GaussianBlur(2))


def cover_pale():
    # A pale, mostly white sleeve: the worst case for light.
    px = np.zeros((640, 640, 3), np.float32)
    yy, xx = np.mgrid[0:640, 0:640] / 640.0
    px[..., 0] = 0.93 + 0.05 * xx
    px[..., 1] = 0.91 + 0.05 * yy
    px[..., 2] = 0.88 + 0.06 * (1 - xx)
    img = Image.fromarray((np.clip(px, 0, 1) * 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    d.ellipse((220, 180, 420, 380), fill=(250, 196, 205))
    d.rectangle((60, 560, 580, 584), fill=(40, 40, 46))
    return img.filter(ImageFilter.GaussianBlur(1.5))


typical = cover_typical()
print(f"typical cover mean sRGB value: {np.asarray(typical, np.float32).mean() / 255:.2f}")
COVERS = {"typical": data_url(typical), "pale": data_url(cover_pale())}

KEY = "A" * 43
STATE = {"t": "state", "acc": True, "ses": True, "play": True, "buf": False, "ti": "Midnight City",
         "ar": "M83", "al": "Hurry Up, We're Dreaming", "dur": 243000, "pos": 61000, "liked": True,
         "seek": True, "vol": "9/15", "q": [], "qa": -1, "gb": 62}
SND = {"t": "snd", "s": {"on": True, "preset": "Open-ear", "bass": 2, "mids": 0, "treble": 1, "clarity": 3, "loud": 2,
                         "bal": 0, "bands": [0, 0, 0, 0, 0, 2, 0, -1, 0, 0]},
       "status": "Shaping Tidal", "active": True,
       "slots": [{"n": 1, "label": "Open-ear"}, {"n": 2, "label": ""}, {"n": 3, "label": ""}],
       "presets": {"Flat": [0] * 10, "Open-ear": [-5, -2, 2, 2.5, 1, 0, 1, 2, 1, 0]},
       "w": {"bass": [1, 1, 0.7, 0.3, 0, 0, 0, 0, 0, 0], "treble": [0, 0, 0, 0, 0, 0, 0.3, 0.7, 1, 1]},
       "freqs": ["32", "64", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"]}
LINK = "window.__sent=[]; window.__testLink={connected:true, publish(t,b){window.__sent.push(b)}, end(){}};"
CALM = "lastInputAt = Date.now() - 20000; checkCalm(); document.body.classList.contains('calm')"


def light(png: bytes):
    a = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"), np.float32) / 255
    lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)  # sRGB -> linear light
    lum = lin @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    return round(float(lum.mean()), 4), round(float((lum > 0.05).mean()), 3)


def shoot(pg, name):
    shot = pg.screenshot()
    (out / f"{name}.png").write_bytes(shot)
    return light(shot)


rows = {}
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", args=["--enable-spatial-navigation"])
    ctx = b.new_context(viewport={"width": 600, "height": 600}, service_workers="block")
    pg = ctx.new_page()
    pg.add_init_script(LINK)
    pg.goto(f"{BASE}index.html#t=lighttest&k={KEY}")
    pg.wait_for_function("typeof key !== 'undefined' && key !== null")
    for cover, art in COVERS.items():
        pg.evaluate("s => { state = {...s, at: Date.now()}; lastHeard = Date.now(); pendingSince = 0; renderNow(); }", dict(STATE, art=art))
        pg.wait_for_function("document.getElementById('art').complete && !document.getElementById('art').hidden")
        pg.evaluate("wakeUp(); document.getElementById('toggle').focus()")
        pg.wait_for_timeout(2600)  # the button's name has gone again
        rows[f"now_{cover}_normal"] = shoot(pg, f"now-{cover}-normal")
        calm = pg.evaluate(CALM)
        pg.wait_for_timeout(1300)  # let the ease into calm finish
        rows[f"now_{cover}_calm"] = shoot(pg, f"now-{cover}-calm") if calm else "no calm"
    # Waking: one swipe restores at once and still moves focus.
    before = pg.evaluate("document.activeElement.id")
    pg.keyboard.press("ArrowRight")
    pg.wait_for_timeout(100)
    woke = pg.evaluate("[document.body.classList.contains('calm'), document.activeElement.id]")

    sp = ctx.new_page()
    sp.add_init_script(LINK)
    sp.goto(f"{BASE}index.html?app=sound#t=lighttest&k={KEY}")
    sp.wait_for_function("typeof key !== 'undefined' && key !== null")
    sp.evaluate("async m => { await handle(await seal({...m, at: Date.now()})); }", SND)
    sp.evaluate("async s => { await handle(await seal({...s, at: Date.now()})); }", STATE)
    sp.evaluate("wakeUp(); document.getElementById('srow-preset').focus()")
    sp.wait_for_timeout(600)
    rows["sound_normal"] = shoot(sp, "sound-normal")
    calm = sp.evaluate(CALM)
    sp.wait_for_timeout(1300)
    rows["sound_calm"] = shoot(sp, "sound-calm") if calm else "no calm"
    b.close()


def fmt(v):
    return v if isinstance(v, str) else {"meanLight": v[0], "litShare": v[1]}


report = {k: fmt(v) for k, v in rows.items()}
for screen in ("now_typical", "now_pale", "sound"):
    n, c = rows[f"{screen}_normal"], rows[f"{screen}_calm"]
    report[f"{screen}_lightSaved"] = f"{(1 - c[0] / n[0]) * 100:.0f}%" if not isinstance(c, str) else "no calm"
report["wake"] = {"focusBefore": before, "calmAfterSwipe": woke[0], "focusAfterSwipe": woke[1]}
report["base"] = BASE
print(json.dumps(report, indent=1))
