"""Regression tests for presses on Tidal Glass (run before every publish).

Serves nothing itself: start `python -m http.server 47611 --bind 127.0.0.1 --directory webapp` first.
The link to the phone (two MQTT brokers) is replaced by a fake one: the phone's state is fed in,
and every command the page sends is decrypted with the page's own code and checked.

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
    # The page uses this instead of the brokers; it records what would have been published.
    page.add_init_script("""
      window.__sent = [];
      window.__testLink = { connected: true, publish(t, body) { window.__sent.push(body); }, end() {} };
    """)
    page.route("**/broker.*/**", lambda route: route.abort())
    page.goto(URL)
    page.wait_for_function("typeof key !== 'undefined' && key !== null")
    page.evaluate("s => { state = {...s, at: Date.now()}; lastHeard = Date.now(); renderNow(); }", STATE)

    def commands():
        """Decrypt everything sent so far with the page's own code; returns the command names."""
        return page.evaluate("async () => Promise.all(window.__sent.map(async b => (await openMessage(b)).c))")

    def reset():
        page.evaluate("window.__sent.length = 0")

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

    # 7. A press while the link is down is kept and goes out the moment it reconnects.
    reset()
    page.evaluate("window.__testLink.connected = false")
    page.focus("#next")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    held = commands()
    page.evaluate("window.__testLink.connected = true; flushOutbox()")
    page.wait_for_timeout(300)
    c = commands()
    check("a press while offline is sent on reconnect", held == [] and c == ["next"], json.dumps([held, c]))

    # 8b. An older state (a broker that missed updates) never replaces a newer one; a newer one does.
    titles = page.evaluate("""async s => {
      const base = state.at;
      await handle(await seal({...s, ti: 'Older copy', at: base - 5000}));
      const afterOld = state.ti;
      await handle(await seal({...s, ti: 'Newer state', at: base + 5000}));
      return [afterOld, state.ti];
    }""", STATE)
    check("older state is ignored, newer state applies", titles == ["Test song", "Newer state"], json.dumps(titles))

    # 9. Tidal closed on the phone: the screen says so, Play starts it, and no "play again" nagging.
    reset()
    page.evaluate("s => { state = {t: 'state', acc: true, ses: false, play: false, buf: false, pos: 0, at: Date.now(), vol: s.vol, q: [], qa: -1}; renderNow(); }", STATE)
    closed_title = page.evaluate("[$('title').textContent, $('artist').textContent, $('stateText').textContent]")
    page.focus("#toggle")
    page.keyboard.press("Enter")
    page.wait_for_timeout(3000)
    c = commands()
    starting = page.evaluate("[stateLine(), document.getElementById('toast').hidden]")
    check("closed Tidal: says so, Play sends one play, shows 'Starting Tidal'",
          closed_title[0] == "Tidal is closed" and "Press Play" in closed_title[1] and c == ["play"]
          and starting[0] == "Starting Tidal…", json.dumps([closed_title, c, starting]))
    page.evaluate("async s => { await handle(await seal({...s, at: Date.now() + 1000, play: true})); }", STATE)
    after = page.evaluate("[stateLine(), startingSince]")
    check("once Tidal is up, the screen shows the song", after == ["Playing", 0], json.dumps(after))

    # 10. Calm: after 15 s untouched the page dims; the first pinch wakes it AND still presses.
    reset()
    page.evaluate("s => { state = {...s, play: true, at: Date.now()}; renderNow(); }", STATE)
    page.focus("#toggle")
    page.evaluate("lastInputAt = Date.now() - 20000; checkCalm();")
    calm = page.evaluate("document.body.classList.contains('calm')")
    page.keyboard.press("Enter")
    page.wait_for_timeout(500)
    woke = page.evaluate("document.body.classList.contains('calm')")
    c = commands()
    check("calm after 15 s; a pinch wakes it and still pauses", calm and not woke and c == ["pause"], json.dumps([calm, woke, c]))

    # 11. A silent phone is not shown as live (Director review, 2026-10-25, R2).
    page.evaluate("s => { state = {...s, play: true, at: Date.now()}; renderNow(); }", STATE)
    page.evaluate("pendingSince = Date.now() - 8000; renderNow();")
    silent = page.evaluate("[stateLine(), $('dot').classList.contains('live')]")
    page.evaluate("pendingSince = 0; renderNow();")
    check("a phone that does not answer says so and the live dot goes out", silent == ["Your phone is not answering", False], json.dumps(silent))

    # 12. Tidal does not start: the headline says so; after 40 s back to closed, never "not answering" (R1).
    page.evaluate("s => { state = {t: 'state', acc: true, ses: false, play: false, buf: false, pos: 0, at: Date.now(), vol: s.vol, q: [], qa: -1}; startingSince = Date.now() - 20000; pendingSince = Date.now() - 20000; renderNow(); }", STATE)
    failed = page.evaluate("[$('title').textContent, $('artist').textContent, stateLine()]")
    page.evaluate("startingSince = Date.now() - 41000; stateLine(); renderNow();")
    after40 = page.evaluate("[$('title').textContent, stateLine(), pendingSince]")
    check("a failed start is in the headline, then clears without a false 'not answering'",
          failed[0] == "Tidal didn't start" and "then press Play" in failed[1] and failed[2] == "Phone connected"
          and after40 == ["Tidal is closed", "Phone connected", 0], json.dumps([failed, after40]))

    # 13. Calm never dims a warning (R11).
    page.evaluate("s => { state = {...s, play: true, at: Date.now()}; startingSince = 0; renderNow(); }", STATE)
    page.evaluate("pendingSince = Date.now() - 8000; lastInputAt = Date.now() - 20000; checkCalm();")
    calm_on_warning = page.evaluate("document.body.classList.contains('calm')")
    page.evaluate("pendingSince = 0; checkCalm();")
    check("calm stays off while a warning shows", calm_on_warning is False, json.dumps(calm_on_warning))
    page.evaluate("wakeUp()")

    # 14. Hidden: a press waits; the link is not reopened behind the wearer's back (R4).
    reset()
    page.evaluate("Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'}); document.dispatchEvent(new Event('visibilitychange'));")
    page.wait_for_timeout(600)
    page.evaluate("send('next')")
    page.wait_for_timeout(300)
    hidden = page.evaluate("[links.length, outbox.length, window.__sent.length]")
    page.evaluate("Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'visible'}); document.dispatchEvent(new Event('visibilitychange'));")
    page.wait_for_timeout(300)
    shown_again = commands()
    check("hidden: no reopen, the press waits and goes out when shown", hidden == [0, 1, 0] and "next" in shown_again, json.dumps([hidden, shown_again]))

    # 15. Battery: the glasses' own reading first, a bolt when charging, an old phone report hidden (R5).
    page.evaluate("browserBattery = {level: 0.62, charging: true}; drawBattery();")
    own = page.evaluate("(() => { const b = document.querySelector('#gbat'); return [b.hidden, b.textContent.trim(), getComputedStyle(b.querySelector('.gbat-bolt')).display]; })()")
    page.evaluate("s => { browserBattery = null; state = {...s, gb: 40, at: Date.now() - 31 * 60 * 1000}; drawBattery(); }", STATE)
    old = page.evaluate("document.querySelector('#gbat').hidden")
    check("battery: own reading with a bolt; a phone report over 30 min old is hidden",
          own[0] is False and own[1] == "62%" and own[2] != "none" and old is True, json.dumps([own, old]))

    # 16. Sound Lab (Director review R8-R10): actions wait for the phone, notes stay in the header.
    sp = browser.new_context(viewport={"width": 600, "height": 600}).new_page()
    sp.on("pageerror", lambda e: errors.append(str(e)))
    sp.add_init_script("window.__sent = []; window.__testLink = { connected: true, publish(t, body) { window.__sent.push(body); }, end() {} };")
    sp.goto(URL.replace("index.html?test=1", "index.html?app=sound&test=1"))
    sp.wait_for_function("typeof key !== 'undefined' && key !== null")
    SND = {"t": "snd", "at": 1, "s": {"on": True, "preset": "Open-ear", "bass": 2, "mids": 0, "treble": 1, "clarity": 3, "loud": 2, "bal": 0, "bands": [0] * 10},
           "presets": {"Flat": [0] * 10, "Open-ear": [3, 3, 2, 1, 0, 0, 1, 2, 2, 1]}, "status": "Shaping Tidal", "active": True, "w": {},
           "slots": [{"n": 1, "label": ""}, {"n": 2, "label": ""}, {"n": 3, "label": ""}]}
    sp.evaluate("async m => { await handle(await seal(m)); }", SND)
    sp.wait_for_timeout(200)
    sp.focus("#sndPower")
    sp.keyboard.press("Enter")
    sp.wait_for_timeout(100)
    turning = sp.evaluate("$('sndStateText').textContent")
    sp.evaluate("async m => { await handle(await seal({...m, at: 2, s: {...m.s, on: false}, status: 'Off'})); }", SND)
    sp.wait_for_timeout(100)
    confirmed = sp.evaluate("$('sndStateText').textContent")
    check("Sound Lab Off: 'Turning off…' until the phone confirms", turning == "Turning off…" and confirmed == "Off · Tidal plays as normal", json.dumps([turning, confirmed]))
    sp.evaluate("expectSound('Saving to Sound 1…', () => false); sndPending.at = Date.now() - 8000; renderSoundStatus();")
    late = sp.evaluate("$('sndStateText').textContent")
    sp.evaluate("sndPending = null; renderSoundStatus();")
    check("Sound Lab: no confirmation in 7 s says so", late == "Your phone did not confirm. Try again.", json.dumps(late))
    sp.evaluate("soundNote('Back to flat')")
    note = sp.evaluate("[$('sndStateText').textContent, $('toast').hidden]")
    check("Sound Lab notes sit in the header, not over the controls", note == ["Back to flat", True], json.dumps(note))
    sp.evaluate("sndNote = null; linkDownSince = Date.now() - 6000; renderSoundStatus();")
    recon = sp.evaluate("$('sndStateText').textContent")
    check("Sound Lab says Reconnecting… when the link is down", recon == "Reconnecting…", json.dumps(recon))
    sp.close()

    # 8. The old link's daily-limit message is gone for good.
    source = page.evaluate("fetch('app.js').then(r => r.text())")
    check("no daily-limit message left", "busy for today" not in source and "ntfy.sh" not in source)

    check("no page errors", not errors, "; ".join(errors))
    browser.close()

print("ALL PASS" if not failures else f"{len(failures)} FAILED")
sys.exit(1 if failures else 0)
