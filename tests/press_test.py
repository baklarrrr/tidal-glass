"""Regression tests for presses on Tidal Glass (run before every publish).

Serves nothing itself: start `python -m http.server 47611 --bind 127.0.0.1 --directory webapp` first.
The link to the phone (two MQTT brokers) is replaced by a fake one: the phone's state is fed in,
and every command the page sends is decrypted with the page's own code and checked.

Guards the 2026-10-25 bug: on the glasses a pinch moves the hand a little, and a pinch-and-drag
volume gesture turned Play into a volume change. A press must always be a press.
Also guards the Photographer review fixes of 2026-10-25 (checks 17 onwards): confirmations in the
name line, list swipes, Sound Lab focus, calm and its empty state, and the calm cover cap. Each of
those runs on its own, so an older build reports every one that fails instead of stopping at the first.
Swipes use Chrome's spatial navigation (as the glasses move focus); the glasses' own browser may differ.

  python webapp/tests/press_test.py [base_url]   (default http://127.0.0.1:47611/)
"""
import io
import json
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:47611/").rstrip("/") + "/"
URL = f"{BASE}index.html?test=1#t=tgpresstest&k={KEY}"
STATE = {"t": "state", "acc": True, "ses": True, "play": False, "buf": False, "ti": "Test song", "ar": "Test artist",
         "al": "Test album", "dur": 200000, "pos": 50000, "liked": False, "seek": True, "vol": "8/15", "q": [], "qa": -1}
# A library page as the phone sends it (pages of 10); more than fits on screen.
LIB = {"t": "lib", "id": None, "title": "Library", "page": 0, "more": True,
       "items": [{"id": f"r{i}", "ti": f"Song {i + 1}", "su": "Artist", "b": False, "p": True} for i in range(10)]}
ACTIVE = "(() => { const a = document.activeElement; const t = a.querySelector && a.querySelector('.ti'); return t ? t.textContent : a.id; })()"
LINK = "window.__sent = []; window.__testLink = { connected: true, publish(t, body) { window.__sent.push(body); }, end() {} };"

failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def guard(name, fn):
    """Runs one check; a missing element or function counts as that check failing, not the whole run."""
    try:
        fn()
    except Exception as e:  # noqa: BLE001 - reported as a failure of this check
        check(name, False, f"{type(e).__name__}: {str(e).splitlines()[0][:160]}")


def cover(rgb):
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), rgb).save(buf, "JPEG", quality=90)
    return buf.getvalue()


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", args=["--enable-spatial-navigation"])
    page = browser.new_context(viewport={"width": 600, "height": 600}).new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    # The page uses this instead of the brokers; it records what would have been published.
    page.add_init_script(LINK)
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
    # Since the 2026-10-25 review the headline says it (the top line stays about the link).
    starting = page.evaluate("[$('title').textContent, $('artist').textContent, stateLine()]")
    check("closed Tidal: says so, Play sends one play, the headline says 'Starting Tidal…'",
          closed_title[0] == "Tidal is closed" and "Press Play" in closed_title[1] and c == ["play"]
          and starting[0] == "Starting Tidal…" and starting[2] == "Phone connected", json.dumps([closed_title, c, starting]))
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

    # 12. Tidal does not start (R1; Director recheck 2026-10-25): if the phone answered after the press,
    # the headline says Tidal didn't start; if the phone has said nothing since, it says the phone is not
    # answering (never blaming Tidal). Either stays until the next press.
    CLOSED = "s => { state = {t: 'state', acc: true, ses: false, play: false, buf: false, pos: 0, at: Date.now(), vol: s.vol, q: [], qa: -1}; "
    page.evaluate(CLOSED + "startingSince = Date.now() - 20000; heardLive = Date.now() - 13000; pendingSince = 0; renderNow(); }", STATE)
    failed = page.evaluate("[$('title').textContent, $('artist').textContent, stateLine()]")
    page.evaluate("startingSince = Date.now() - 41000; heardLive = Date.now() - 34000; renderNow();")
    after40 = page.evaluate("[$('title').textContent, stateLine()]")
    page.evaluate(CLOSED + "startingSince = Date.now() - 20000; heardLive = Date.now() - 60000; pendingSince = Date.now() - 20000; renderNow(); }", STATE)
    silent = page.evaluate("[$('title').textContent, stateLine(), document.querySelector('.topline .state').classList.contains('warn')]")
    page.evaluate("press('volUp')")
    page.wait_for_timeout(100)
    cleared = page.evaluate("[$('title').textContent, startingSince]")
    page.evaluate("pendingSince = 0; heardLive = Date.now(); renderNow();")
    check("a failed start: Tidal blamed only after the phone answered, the phone blamed when it is silent, kept until the next press",
          failed[0] == "Tidal didn't start" and "then press Play" in failed[1] and failed[2] == "Phone connected"
          and after40 == ["Tidal didn't start", "Phone connected"]
          and silent == ["Your phone is not answering", "Your phone is not answering", True]
          and cleared == ["Tidal is closed", 0], json.dumps([failed, after40, silent, cleared]))

    # 27. A broker's stored copy is not the phone answering (Director recheck 2026-10-25): on a fresh
    # visit it shows, but not as live; without a live answer the warning comes, in the warning style, the
    # dot goes out and the rest is dimmed; the same message arriving live (from another broker) counts.
    page.evaluate("s => { heardLive = 0; pendingSince = Date.now(); state = null; }", STATE)
    page.evaluate("async s => { window.__stored = await seal({...s, play: true, at: Date.now() + 30000}); await handle(window.__stored, true); }", STATE)
    stored = page.evaluate("[stateLine(), $('dot').classList.contains('live'), $('title').textContent]")
    page.evaluate("pendingSince = Date.now() - 8000; renderStateLine();")
    warned = page.evaluate("[stateLine(), $('dot').classList.contains('live'), document.querySelector('.topline .state').classList.contains('warn'), document.body.classList.contains('stale'), getComputedStyle(document.querySelector('.topline .state')).fontWeight]")
    page.evaluate("async () => { await handle(window.__stored, false); }")
    live = page.evaluate("[stateLine(), $('dot').classList.contains('live'), document.body.classList.contains('stale'), pendingSince]")
    check("a stored copy shows but is not live; no answer warns plainly; the same message live counts",
          stored == ["Checking your phone…", False, STATE["ti"]] and warned == ["Your phone is not answering", False, True, True, "600"]
          and live[0] == "Playing" and live[1] is True and live[2] is False and live[3] == 0, json.dumps([stored, warned, live]))
    page.evaluate("renderNow()")

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
    page.evaluate("browserBattery = null; drawBattery();")

    # 17. Confirmations share the name line under the controls: one line, cut with "…", over nothing
    # (Photographer review 2026-10-25, T31). The overlay toast no longer exists.
    long_title = "Lose Yourself to Dance (feat. Pharrell Williams) [Extended Club Mix, 2013 Remaster]"[:80]

    def t17():
        page.evaluate("s => { state = {...s, at: Date.now()}; pendingSince = 0; startingSince = 0; renderNow(); }", STATE)
        page.focus("#next")
        page.wait_for_timeout(300)
        page.keyboard.press("Enter")
        page.evaluate("async s => { await handle(await seal({...s, ti: s.lt, at: Date.now() + 2000})); }", {**STATE, "lt": long_title})
        page.wait_for_timeout(300)
        line = page.evaluate("""() => {
          const n = $('notice'); const r = n.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(n);
          const lines = new Set([...range.getClientRects()].map((q) => Math.round(q.top))).size;
          const over = [...document.querySelectorAll('#now button, #now .words, #seek')].some((el) => { const q = el.getBoundingClientRect();
            return q.width && !(q.right <= r.left || q.left >= r.right || q.bottom <= r.top || q.top >= r.bottom); });
          return [n.classList.contains('on'), n.textContent, lines, n.scrollWidth > n.clientWidth, $('tip').classList.contains('on'), over,
            !!document.getElementById('toast'), r.bottom <= 600]; }""")
        check(NAME17, line[0] and line[1] == long_title and line[2] == 1 and line[3] and not line[4] and not line[5]
              and not line[6] and line[7], json.dumps(line))
    NAME17 = "a long new title is confirmed on one line in the name line, cut with …, over nothing"
    guard(NAME17, t17)

    # 18. Like: the confirmation replaces the button's name while it shows, so the two never disagree (T32).
    NAME18 = "Like: 'Added to My Collection' shows in place of the button's name"

    def t18():
        page.wait_for_timeout(2300)
        page.evaluate("s => { state = {...s, liked: false, at: Date.now() + 2500}; pendingSince = 0; renderNow(); }", STATE)
        page.focus("#like")
        page.wait_for_timeout(450)
        page.keyboard.press("Enter")
        page.evaluate("async s => { await handle(await seal({...s, liked: true, at: Date.now() + 5000})); }", STATE)
        page.wait_for_timeout(300)
        like = page.evaluate("[$('notice').classList.contains('on'), $('notice').textContent, $('tip').classList.contains('on')]")
        check(NAME18, like == [True, "Added to My Collection", False], json.dumps(like))
    guard(NAME18, t18)

    # 19. Library: every swipe down moves exactly one row, also below the fold, Down from the last row
    # reaches More and Up from More returns to the last row (T62, W3).
    NAME19 = "library: one row per swipe, then More, and Up from More is the last row"
    names = [it["ti"] for it in LIB["items"]]

    def t19():
        page.wait_for_timeout(2300)
        page.evaluate("s => { state = {...s, liked: false, at: Date.now() + 6000}; pendingSince = 0; renderNow(); }", STATE)
        page.focus("#library")
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        page.evaluate("async m => { await handle(await seal(m)); }", LIB)
        page.wait_for_timeout(300)
        walk = [page.evaluate(ACTIVE)]
        for _ in range(10):
            page.keyboard.press("ArrowDown")
            page.wait_for_timeout(150)
            walk.append(page.evaluate(ACTIVE))
        page.keyboard.press("ArrowUp")
        page.wait_for_timeout(150)
        walk.append(page.evaluate(ACTIVE))
        check(NAME19, walk == names + ["more", names[-1]], json.dumps(walk))
    guard(NAME19, t19)

    # 19b. A swipe down past More stays on More; it never jumps back to the top (Director and
    # Photographer rechecks 2026-10-25, W5).
    NAME19B = "library: Down from More stays on More"

    # No row is left cut by the top edge of a list, after reaching More or swiping past it.
    CUT = """(id => { const box = document.getElementById(id); const b = box.getBoundingClientRect();
      return [...box.querySelectorAll('.srow, li')].filter((x) => { const q = x.getBoundingClientRect();
        return q.top < b.top - 0.5 && q.bottom > b.top + 0.5; }).length; })"""

    def t19b():
        page.focus("#more")
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(150)
        cut = page.evaluate(CUT + "('items')")
        check(NAME19B, page.evaluate(ACTIVE) == "more" and cut == 0, json.dumps([page.evaluate(ACTIVE), cut]))
    guard(NAME19B, t19b)

    # 20. Choosing a song there: back on Now Playing, "Playing …" holds the line against the Library
    # button's name, which shows once the confirmation ends.
    NAME20 = "library pick: 'Playing …' shows on Now Playing, then the focused button's name"

    def t20():
        page.focus("#items li:nth-child(2) button")
        page.keyboard.press("Enter")
        page.wait_for_timeout(600)
        back = page.evaluate("[view.screen, $('notice').classList.contains('on'), $('notice').textContent, $('tip').classList.contains('on'), document.activeElement.id]")
        page.wait_for_timeout(2300)
        later = page.evaluate("[$('notice').classList.contains('on'), $('tip').classList.contains('on'), $('tip').textContent]")
        check(NAME20, back == ["now", True, f"Playing {names[1]}", False, "library"] and later == [False, True, "Your Tidal library"],
              json.dumps([back, later]))
    guard(NAME20, t20)
    page.evaluate("history.state && history.state.screen !== 'now' && history.back()")
    page.wait_for_timeout(300)

    # 25. Calm: a focused liked heart keeps a focus ring brighter than every other ring, and a low
    # battery chip stays at full brightness (Photographer review 2026-10-25, items 2 and 3).
    NAME25 = "calm: the focused liked heart has the brightest ring; the 10% chip stays at full brightness"

    def t25():
        page.evaluate("s => { state = {...s, liked: true, gb: 10, at: Date.now() + 9000}; pendingSince = 0; renderNow(); }", STATE)
        page.focus("#like")
        page.wait_for_timeout(200)
        page.evaluate("lastInputAt = Date.now() - 20000; checkCalm();")
        page.wait_for_timeout(1200)
        rings = page.evaluate("""() => { const b = (id) => getComputedStyle(document.getElementById(id)).borderTopColor;
          return [document.body.classList.contains('calm'), b('like'), b('toggle'), b('next'), b('queue'),
            getComputedStyle($('gbat')).opacity, getComputedStyle($('gbat')).color, getComputedStyle(document.querySelector('.topline .state')).opacity]; }""")
        page.evaluate("wakeUp()")
        check(NAME25, rings[0] and rings[1] == "rgba(47, 216, 236, 0.45)" and rings[2] == rings[3] == rings[4] == "rgba(255, 255, 255, 0.16)"
              and rings[5] == "1" and rings[6] == "rgb(255, 176, 138)" and rings[7] == "0.6", json.dumps(rings))
    guard(NAME25, t25)

    # 26. Calm cover cap: a pale cover dims further than 50% in calm; a cover from a server without CORS
    # still shows, with the fixed cap (item 10). A cover of typical brightness keeps 50%.
    NAME26 = "calm cover cap: pale cover below 50%, mid cover at 50%, a no-CORS cover still shows at 40%"
    page.route("https://art.test/pale.jpg", lambda r: r.fulfill(status=200, body=cover((240, 236, 228)), headers={"Content-Type": "image/jpeg", "Access-Control-Allow-Origin": "*"}))
    page.route("https://art.test/mid.jpg", lambda r: r.fulfill(status=200, body=cover((120, 100, 110)), headers={"Content-Type": "image/jpeg", "Access-Control-Allow-Origin": "*"}))
    # A server that does not allow this page to read its images. (Playwright adds an allowing header to
    # the responses it fakes when there is none, so this one names another site instead.)
    page.route("https://art.test/plain.jpg", lambda r: r.fulfill(status=200, body=cover((240, 236, 228)), headers={"Content-Type": "image/jpeg", "Access-Control-Allow-Origin": "https://another-site.example"}))

    def t26():
        caps = []
        for i, url in enumerate(("https://art.test/pale.jpg", "https://art.test/mid.jpg", "https://art.test/plain.jpg")):
            page.evaluate("([s, u, t]) => { state = {...s, art: u, at: Date.now() + t}; pendingSince = 0; renderNow(); }", [STATE, url, 10000 + i * 1000])
            page.wait_for_function("() => { const a = document.getElementById('art'); return a.complete && !a.hidden && a.naturalWidth > 0; }", timeout=5000)
            page.wait_for_timeout(100)
            caps.append(page.evaluate("[$('artwrap').style.getPropertyValue('--calm-art'), $('art').getAttribute('crossorigin')]"))
        check(NAME26, float(caps[0][0] or 1) < 0.4 and caps[0][1] == "anonymous" and caps[1][0] == "0.500"
              and caps[2] == ["0.400", None], json.dumps(caps))
    guard(NAME26, t26)
    page.evaluate("s => { state = {...s, at: Date.now() + 20000}; renderNow(); }", STATE)

    # 16. Sound Lab (Director review R8-R10): actions wait for the phone, notes stay in the header.
    sp = browser.new_context(viewport={"width": 600, "height": 600}).new_page()
    sp.on("pageerror", lambda e: errors.append(str(e)))
    sp.add_init_script(LINK)
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
    # The overlay toast is gone for good (2026-10-25), so "no toast" is now "no toast element".
    note = sp.evaluate("[$('sndStateText').textContent, !document.getElementById('toast')]")
    check("Sound Lab notes sit in the header, not over the controls", note == ["Back to flat", True], json.dumps(note))
    sp.evaluate("sndNote = null; linkDownSince = Date.now() - 6000; renderSoundStatus();")
    recon = sp.evaluate("$('sndStateText').textContent")
    check("Sound Lab says Reconnecting… when the link is down", recon == "Reconnecting…", json.dumps(recon))
    sp.evaluate("linkDownSince = 0; sndPending = null; renderSoundStatus();")

    # 21. Sound Lab: one swipe down from On/Off lands on Preset, never on the list itself (W1 step00);
    # Up from Preset is On/Off again, so comparing stays one swipe away.
    NAME21 = "Sound Lab: Down from On/Off is Preset, Up from Preset is On/Off"

    def t21():
        sp.evaluate("async m => { await handle(await seal({...m, at: 3})); }", SND)
        sp.focus("#sndPower")
        sp.keyboard.press("ArrowDown")
        sp.wait_for_timeout(200)
        down = sp.evaluate("document.activeElement.id")
        sp.keyboard.press("ArrowUp")
        sp.wait_for_timeout(200)
        up = sp.evaluate("document.activeElement.id")
        check(NAME21, [down, up] == ["srow-preset", "sndPower"], json.dumps([down, up]))
    guard(NAME21, t21)

    # 22. Sound Lab: every swipe down moves one row; the actions are one to five swipes from Preset.
    NAME22 = "Sound Lab: one row per swipe; Fine-tune, My sounds, Test, Reset follow On/Off"

    def t22():
        sp.focus("#srow-preset")
        rows = []
        for _ in range(6):
            sp.keyboard.press("ArrowDown")
            sp.wait_for_timeout(150)
            rows.append(sp.evaluate("document.activeElement.id"))
        sp.focus("#srow-preset")
        sp.keyboard.press("ArrowUp")
        tools = []
        for _ in range(4):
            sp.keyboard.press("ArrowRight")
            sp.wait_for_timeout(120)
            tools.append(sp.evaluate("document.activeElement.id"))
        check(NAME22, rows == ["srow-bass", "srow-mids", "srow-treble", "srow-clarity", "srow-loud", "srow-bal"]
              and tools == ["sndFine", "sndSlots", "sndTest", "sndReset"], json.dumps([rows, tools]))
    guard(NAME22, t22)

    # 30. Sound Lab: a swipe down past Balance does nothing: focus stays, the list does not scroll by
    # itself, and no row is left cut at the top (Photographer recheck 2026-10-25, W1 step 08).
    NAME30 = "Sound Lab: Down from Balance stays put, with no half row at the top"

    def t30():
        # Reached the way the glasses reach it: by swiping down from Preset.
        sp.focus("#srow-preset")
        for _ in range(6):
            sp.keyboard.press("ArrowDown")
            sp.wait_for_timeout(150)
        before = sp.evaluate("$('sndRows').scrollTop")
        for _ in range(2):
            sp.keyboard.press("ArrowDown")
            sp.wait_for_timeout(150)
        after = sp.evaluate("[document.activeElement.id, $('sndRows').scrollTop]")
        cut = sp.evaluate("""(() => { const box = $('sndRows'); const b = box.getBoundingClientRect();
          return [...box.querySelectorAll('.srow')].filter((x) => { const q = x.getBoundingClientRect();
            return q.top < b.top - 0.5 && q.bottom > b.top + 0.5; }).length; })()""")
        check(NAME30, after == ["srow-bal", before] and cut == 0, json.dumps([before, after, cut]))
    guard(NAME30, t30)

    # 23. Calm in Sound Lab: 15 s untouched dims it; the first swipe wakes it and still changes the value;
    # no calm while the header shows a warning (no confirmation, not answering, reconnecting).
    NAME23 = "Sound Lab calm: dims after 15 s, a swipe wakes it and still acts, never over a warning"

    def t23():
        sp.focus("#srow-bass")
        sp.evaluate("window.__sent.length = 0; lastInputAt = Date.now() - 20000; checkCalm();")
        calm = sp.evaluate("document.body.classList.contains('calm')")
        bass_before = sp.evaluate("snd.s.bass")
        sp.keyboard.press("ArrowRight")
        sp.wait_for_timeout(450)
        woke = sp.evaluate("[document.body.classList.contains('calm'), snd.s.bass]")
        sent = sp.evaluate("async () => Promise.all(window.__sent.map(async b => (await openMessage(b)).c))")
        warns = []
        for setup in ("sndPending = {doing: 'Saving…', check: () => false, at: Date.now() - 8000};",
                      "sndPending = null; pendingSince = Date.now() - 8000;",
                      "pendingSince = 0; linkDownSince = Date.now() - 6000;"):
            sp.evaluate(setup + " renderSoundStatus(); lastInputAt = Date.now() - 20000; checkCalm();")
            warns.append(sp.evaluate("[$('sndStateText').textContent, document.body.classList.contains('calm')]"))
        sp.evaluate("linkDownSince = 0; sndPending = null; renderSoundStatus(); wakeUp();")
        check(NAME23, calm and woke == [False, bass_before + 1] and "sndSet" in sent and all(w[1] is False for w in warns),
              json.dumps([calm, woke, sent, warns]))
    guard(NAME23, t23)

    # 28. Sound Lab from its own icon asks the phone once, then every 3 minutes, not every 5 s, so a
    # silent phone is said to be silent; the warning uses the warning style (Director recheck 2026-10-25).
    NAME28 = "Sound Lab: asks every 3 minutes, so a silent phone shows as not answering, in the warning style"

    def t28():
        # As at launch from the icon: never asked yet. The next tick asks once; before the fix it asked
        # again every 5 s for ever.
        sp.evaluate("window.__sent.length = 0; pendingSince = 0; sndPending = null; sndNote = null; lastHello = 0; sndAsked = 0;")
        sp.wait_for_timeout(11500)
        asks = sp.evaluate("async () => (await Promise.all(window.__sent.map(async b => (await openMessage(b)).c))).filter(c => c === 'snd').length")
        sp.evaluate("pendingSince = Date.now() - 8000; renderSoundStatus();")
        st = sp.evaluate("[$('sndStateText').textContent, document.querySelector('.soundhead .state').classList.contains('warn'), $('sndDot').classList.contains('live')]")
        sp.evaluate("pendingSince = 0; renderSoundStatus();")
        check(NAME28, asks == 1 and st == ["Your phone is not answering", True, False], json.dumps([asks, st]))
    guard(NAME28, t28)

    # 29. Sound Lab: an Off the phone never confirms goes back to what the phone last reported, so the
    # header and switch never claim it later (Director recheck 2026-10-25, S05r).
    NAME29 = "Sound Lab: an unconfirmed Off returns to the phone's last report, never claimed later"

    def t29():
        sp.evaluate("async m => { await handle(await seal({...m, at: 10})); }", SND)
        sp.wait_for_timeout(100)
        sp.focus("#sndPower")
        sp.keyboard.press("Enter")
        sp.wait_for_timeout(100)
        asked = sp.evaluate("[snd.s.on, $('sndStateText').textContent]")
        sp.evaluate("sndPending.at = Date.now() - 13000; renderSoundStatus(); pendingSince = 0; renderSoundStatus();")
        later = sp.evaluate("[snd.s.on, $('sndPower').getAttribute('aria-pressed'), $('sndStateText').textContent]")
        check(NAME29, asked == [False, "Turning off…"] and later == [True, "true", "Shaping Tidal"], json.dumps([asked, later]))
    guard(NAME29, t29)
    sp.close()

    # 24. Sound Lab with nothing from the phone yet: no made-up sliders, no On/Off that does nothing; when
    # the sound arrives the controls show and Preset has focus, so the next swipe works.
    NAME24 = "Sound Lab without data shows an honest empty state, then Preset when the sound arrives"
    sq = browser.new_context(viewport={"width": 600, "height": 600}).new_page()
    sq.on("pageerror", lambda e: errors.append(str(e)))
    sq.add_init_script(LINK)
    sq.goto(URL.replace("index.html?test=1", "index.html?app=sound&test=1"))
    sq.wait_for_function("typeof key !== 'undefined' && key !== null")
    sq.wait_for_timeout(300)

    def t24():
        vis = "id => { const el = document.getElementById(id); return !!(el && el.getClientRects().length); }"
        empty = [sq.evaluate(vis, i) for i in ("sndEmpty", "sndRows", "sndPower", "curve")]
        sq.evaluate("async m => { await handle(await seal(m)); }", SND)
        sq.wait_for_timeout(200)
        filled = [sq.evaluate(vis, i) for i in ("sndEmpty", "sndRows", "sndPower")] + [sq.evaluate("document.activeElement.id")]
        check(NAME24, empty == [True, False, False, False] and filled == [False, True, True, "srow-preset"], json.dumps([empty, filled]))
    guard(NAME24, t24)
    sq.close()

    # 8. The old link's daily-limit message is gone for good.
    source = page.evaluate("fetch('app.js').then(r => r.text())")
    check("no daily-limit message left", "busy for today" not in source and "ntfy.sh" not in source)

    check("no page errors", not errors, "; ".join(errors))
    browser.close()

print("ALL PASS" if not failures else f"{len(failures)} FAILED")
sys.exit(1 if failures else 0)
