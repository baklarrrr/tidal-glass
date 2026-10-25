"""Link tests for Tidal Glass (run before every publish, beside press_test.py).

The MQTT library is replaced by a fake whose brokers connect only when the test says so, and what the
page publishes on each is recorded. Guards Bakar's 2026-10-25 lag report: from home only shiftr.io
could be reached, and the glasses waited 5 s before even trying it.

1. All three brokers open together; none waits as a spare.
2. A hello sent while only a broker without the phone was up also reaches a broker that connects
   later. It is the same message, so the phone, which ignores a message it has already had, acts once.
3. A press goes out once on every connected broker.
4. A closed link forgets what it sent: a reopened page never sends old presses again.

Serves nothing itself: start `python -m http.server 47611 --bind 127.0.0.1 --directory webapp` first.
  python webapp/tests/link_test.py [base_url]   (default http://127.0.0.1:47611/)
"""
import json
import sys

from playwright.sync_api import sync_playwright

KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:47611/").rstrip("/") + "/"
URL = f"{BASE}index.html?test=1#t=tglinktest&k={KEY}"
# Served in place of vendor/mqtt.min.js.
FAKE_MQTT = """
window.__clients = [];
window.mqtt = { connect(url, opts) {
  const h = {};
  const c = { url, opts, connected: false, sent: [],
    on(ev, fn) { (h[ev] = h[ev] || []).push(fn); return c; },
    once(ev, fn) { const w = (...a) => { h[ev] = (h[ev] || []).filter((f) => f !== w); fn(...a); }; return c.on(ev, w); },
    subscribe() {}, publish(t, body) { c.sent.push(body); }, end() { c.connected = false; },
    fire(ev, ...a) {
      if (ev === 'connect') c.connected = true;
      if (ev === 'close' || ev === 'offline') c.connected = false;
      (h[ev] || []).slice().forEach((f) => f(...a));
    } };
  window.__clients.push(c);
  return c;
} };
"""

failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def guard(name, fn):
    try:
        fn()
    except Exception as e:  # noqa: BLE001 - reported as a failure of this check
        check(name, False, f"{type(e).__name__}: {str(e).splitlines()[0][:160]}")


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    page = browser.new_context(viewport={"width": 600, "height": 600}).new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/vendor/mqtt.min.js", lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE_MQTT))
    page.goto(URL)
    page.wait_for_function("typeof key !== 'undefined' && key !== null && window.__clients && window.__clients.length > 0")
    page.wait_for_timeout(400)

    def hosts():
        return page.evaluate("window.__clients.map((c) => new URL(c.url).hostname)")

    def commands(i):
        """What broker i was given, decrypted with the page's own code: command names in order."""
        return page.evaluate("async (i) => Promise.all(window.__clients[i].sent.map(async (b) => (await openMessage(b)).c))", i)

    def fire(i, ev):
        page.evaluate("([i, ev]) => window.__clients[i].fire(ev)", [i, ev])

    NAME1 = "all three brokers open together"
    def t1():
        h = hosts()
        check(NAME1, sorted(h) == ["broker.emqx.io", "broker.hivemq.com", "public.cloud.shiftr.io"], json.dumps(h))
    guard(NAME1, t1)

    NAME2 = "a hello sent on the first broker also reaches one that connects later, as the same message"
    def t2():
        h = hosts()
        hive, shiftr = h.index("broker.hivemq.com"), h.index("public.cloud.shiftr.io")
        fire(hive, "connect")          # a broker the phone is not on connects first and takes the hello
        page.wait_for_timeout(300)
        fire(shiftr, "connect")        # the phone's broker connects a moment later
        page.wait_for_timeout(200)
        same = page.evaluate("([a, b]) => window.__clients[b].sent.includes(window.__clients[a].sent[0])", [hive, shiftr])
        check(NAME2, commands(hive)[:1] == ["hello"] and "hello" in commands(shiftr) and same,
              json.dumps([commands(hive), commands(shiftr), same]))
    guard(NAME2, t2)

    NAME3 = "a press goes out once on every connected broker"
    def t3():
        h = hosts()
        hive, shiftr, emqx = h.index("broker.hivemq.com"), h.index("public.cloud.shiftr.io"), h.index("broker.emqx.io")
        page.evaluate("send('next')")
        page.wait_for_timeout(200)
        a, b, c = commands(hive), commands(shiftr), commands(emqx)
        check(NAME3, a.count("next") == 1 and b.count("next") == 1 and c == [], json.dumps([a, b, c]))
    guard(NAME3, t3)

    NAME4 = "a closed link forgets what it sent; the reopened one never resends old presses"
    def t4():
        before = page.evaluate("window.__clients.length")
        page.evaluate("closeLink(); openLink();")
        page.wait_for_timeout(100)
        h = page.evaluate("window.__clients.slice(%d).map((c) => new URL(c.url).hostname)" % before)
        fresh = before + h.index("public.cloud.shiftr.io")
        fire(fresh, "connect")
        page.wait_for_timeout(200)
        got = commands(fresh)
        check(NAME4, len(h) == 3 and "next" not in got, json.dumps([h, got]))
    guard(NAME4, t4)

    check("no page errors", not errors, "; ".join(errors))
    browser.close()

print("ALL PASS" if not failures else f"{len(failures)} FAILED")
sys.exit(1 if failures else 0)
