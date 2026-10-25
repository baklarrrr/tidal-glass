"""Regression tests for presses on Tidal Glass (run before every publish).

Serves nothing itself: start `python -m http.server 47611 --bind 127.0.0.1 --directory webapp` first.
The relay (ntfy.sh) is faked: the phone's state is fed in, and every command the page sends is
decrypted with the page's own code and checked.

Guards the 2026-10-25 bug: on the glasses a pinch moves the hand a little, and a pinch-and-drag
volume gesture turned Play into a volume change. A press must always be a press.

  python webapp/tests/press_test.py
"""
import json
import sys

from playwright.sync_api import sync_playwright

KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
URL = f"http://127.0.0.1:47611/index.html?test=1#t=tgpresstest&k={KEY}"
STATE = {"t": "state", "acc": True, "ses": True, "play": False, "buf": False, "ti": "Test song", "ar": "Test artist",
         "al": "Test album", "dur": 200000, "pos": 50000, "liked": False, "seek": True, "vol": "8/15", "q": [], "qa": -1}

failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", args=["--enable-spatial-navigation"])
    page = browser.new_context(viewport={"width": 600, "height": 600}).new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    sent = []

    def relay(route):
        req = route.request
        if req.method == "POST":
            sent.append(req.post_data)
        route.fulfill(status=200, body="", headers={"Access-Control-Allow-Origin": "*"})

    page.route("**/ntfy.sh/**", relay)
    page.goto(URL)
    page.wait_for_function("typeof key !== 'undefined' && key !== null")
    page.evaluate("s => { state = {...s, at: Date.now()}; lastHeard = Date.now(); renderNow(); }", STATE)

    def commands():
        """Decrypt everything sent so far with the page's own code; returns the command names."""
        out = []
        for body in sent:
            out.append(page.evaluate("async b => (await openMessage(b)).c", body))
        return out

    def reset():
        sent.clear()

    # 1. A press with hand movement (pointer moves 24 px between down and up) is still Play.
    reset()
    box = page.locator("#toggle").bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x, y - 24, steps=4)
    page.mouse.up()
    page.wait_for_timeout(600)
    c = commands()
    check("jittery press on Play sends play", "play" in c and "volSet" not in c, json.dumps(c))

    # 2. Pinch (Enter) on Play sends play; the confirmation resends once if Tidal does not start.
    reset()
    page.focus("#toggle")
    page.keyboard.press("Enter")
    page.wait_for_timeout(3000)
    c = commands()
    check("Enter on Play sends play, then one confirmation resend", c.count("play") == 2, json.dumps(c))

    # 3. Once Tidal reports playing, no resend.
    reset()
    page.focus("#toggle")
    page.keyboard.press("Enter")
    page.evaluate("s => { state = {...s, play: true, at: Date.now()}; renderNow(); }", STATE)
    page.wait_for_timeout(3000)
    c = commands()
    check("no resend once Tidal plays", c.count("play") == 1, json.dumps(c))

    # 4. Every other button sends its own command.
    page.evaluate("s => { state = {...s, play: false, at: Date.now()}; renderNow(); }", STATE)
    for button, expected in (("#next", "next"), ("#prev", "prev"), ("#like", "like")):
        reset()
        page.focus(button)
        page.keyboard.press("Enter")
        page.wait_for_timeout(500)
        c = commands()
        check(f"{button} sends {expected}", c == [expected], json.dumps(c))

    # 5. Volume buttons send one volSet after a burst.
    reset()
    page.focus("#volup")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    page.wait_for_timeout(800)
    c = commands()
    check("two volume-up presses send one volSet", c == ["volSet"], json.dumps(c))

    # 6. Moving focus sends nothing.
    reset()
    page.focus("#toggle")
    for k in ("ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"):
        page.keyboard.press(k)
    page.wait_for_timeout(500)
    check("moving focus sends nothing", commands() == [], json.dumps(commands()))

    check("no page errors", not errors, "; ".join(errors))
    browser.close()

print("ALL PASS" if not failures else f"{len(failures)} FAILED")
sys.exit(1 if failures else 0)
