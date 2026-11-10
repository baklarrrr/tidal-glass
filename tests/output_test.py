"""Verify phone choice, foreground consent and offline TIDAL / Sound Lab entry.

Run with Python Playwright and installed Chrome. Pass --baseline DIR to replay the
previous release's wrong-phone bug using a saved pairing and a fake Android.
"""
import argparse
import contextlib
from functools import partial
import http.server
import json
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright

FAKE = """() => {
  window.sent = [];
  window.linksToAndroid = 0;
  const link = { connected: true, publish(topic, body) { window.sent.push(body); }, end() {} };
  Object.defineProperty(window, '__testLink', {get() { window.linksToAndroid++; return link; }});
  window.fakeAndroid = link;
  window.voiceTools = {};
  Object.defineProperty(document, 'modelContext', { value: {registerTool(t) {window.voiceTools[t.name] = t;}} });
}"""
PAIR = {"t": "offline-test-device", "k": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
STATE = {"t": "state", "acc": True, "ses": True, "ti": "Test track", "ar": "Test artist", "play": False,
         "dur": 200000, "pos": 1000, "seek": True, "vol": "5/15", "q": []}
MUTATIONS = ["play", "volSet", "next", "like", "skip", "seek", "libplay", "sndSet",
             "sndTest", "sndLoad", "sndSave", "futureAction"]


class SilentHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@contextlib.contextmanager
def server(root):
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), partial(SilentHandler, directory=root)) as srv:
        worker = threading.Thread(target=srv.serve_forever, daemon=True)
        worker.start()
        try:
            yield f"http://127.0.0.1:{srv.server_port}/"
        finally:
            srv.shutdown()
            worker.join()


def state(page, retained=False):
    page.evaluate("async ([s, retained]) => handle(await seal({...s, at:Date.now()}), retained)", [STATE, retained])


def try_commands(page):
    return page.evaluate("cs => Promise.all(cs.map(c => send(c)))", MUTATIONS)


def sent(page):
    return page.evaluate("async () => Promise.all(window.sent.map(async b => (await openMessage(b)).c))")


def select_android(page):
    page.locator("#useAndroid").click()
    page.locator("#confirmAndroid").click()
    page.wait_for_function("isAndroidVisit() && key !== null")


def context(browser):
    ctx = browser.new_context(viewport={"width":600,"height":600})
    ctx.add_init_script("(" + FAKE + ")()")
    def guard(ws):
        ws.close()
    ctx.route_web_socket("**/*", guard)
    return ctx


def seed(page, base):
    page.goto(base + "icon.svg")
    page.evaluate("p => localStorage.setItem('tg.pair',JSON.stringify(p))", PAIR)


def receipt(label):
    print("PASS", label, flush=True)


def upgrade_open_page(browser, baseline):
    # The old page has no listener for worker messages. A real worker update must
    # replace that document, otherwise its already-loaded controls remain active.
    current = Path(__file__).resolve().parents[1]
    served = [baseline]
    class UpgradeHandler(SilentHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=served[0], **kwargs)
    with http.server.ThreadingHTTPServer(("127.0.0.1",0), UpgradeHandler) as srv, context(browser) as ctx:
        worker = threading.Thread(target=srv.serve_forever, daemon=True)
        worker.start()
        try:
            base = f"http://127.0.0.1:{srv.server_port}/"
            page = ctx.new_page()
            seed(page, base)
            page.goto(base)
            page.wait_for_function("navigator.serviceWorker.controller !== null && typeof key !== 'undefined' && key !== null")
            page.evaluate("caches.open('quran-glass-v13').then(c => c.put('sibling-state',new Response('preserve')))")
            served[0] = current
            page.evaluate("navigator.serviceWorker.getRegistration().then(r => {r.update().catch(()=>{});})")
            page.locator("#useIphone").wait_for(state="visible", timeout=15000)
            assert page.evaluate("linksToAndroid === 0 && sent.length === 0")
            assert page.evaluate("caches.open('quran-glass-v13').then(c => c.match('sibling-state')).then(r => r.text())") == "preserve"
            receipt("an already-open old control page reloads safely on upgrade and preserves sibling caches")
        finally:
            srv.shutdown()
            worker.join()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--shots", type=Path)
    args = parser.parse_args()
    if args.shots:
        args.shots.mkdir(parents=True, exist_ok=True)

    def shot(page, name):
        if args.shots:
            page.screenshot(path=args.shots / (name + ".png"))

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome")
        try:
            if args.baseline:
                upgrade_open_page(browser, args.baseline)
                with server(args.baseline) as base, context(browser) as ctx:
                    page = ctx.new_page()
                    seed(page, base)
                    page.goto(base)
                    page.wait_for_function("key !== null && links.length === 1")
                    state(page, True)
                    page.locator("#toggle").click()
                    page.wait_for_function("sent.length > 0")
                    assert "play" in sent(page)
                    receipt("reproduced old release sending play to stored Android on a retained report")

            with server(Path(__file__).resolve().parents[1]) as base, context(browser) as ctx:
                page = ctx.new_page()
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                seed(page, base)
                page.goto(base)
                assert page.locator("#useIphone").is_visible()
                assert not page.locator("#now").is_visible()
                assert try_commands(page) == [False] * len(MUTATIONS)
                assert page.evaluate("linksToAndroid === 0 && sent.length === 0")
                shot(page, "01-choose-phone")
                receipt("stored Android does not select a phone or send any control before consent")
                page.locator("#useIphone").click()
                assert page.locator("#setupHint").inner_text().find("AirPlay & Bluetooth") >= 0
                assert not page.evaluate("Object.keys(voiceTools).length")
                assert not any(try_commands(page))
                assert page.evaluate("linksToAndroid === 0")
                shot(page, "02-iphone")
                page.reload()
                assert page.locator("#setupTitle").inner_text() == "iPhone playback"
                page.goto(base+"sound/")
                assert page.locator("#setupTitle").inner_text() == "Sound Lab on iPhone"
                assert "Android companion" in page.locator("#setupOption").inner_text()
                assert not any(try_commands(page))
                receipt("iPhone choice persists across Tidal and Sound Lab with zero Android transport")
                page.locator("#chooseAgain").click()
                page.locator("#useAndroid").click()
                shot(page, "03-confirm-android")
                assert not any(try_commands(page))
                page.locator("#confirmAndroid").click()
                page.wait_for_function("isAndroidVisit() && key !== null")
                state(page, True)
                assert not any(try_commands(page))
                page.evaluate("async s => handle(await seal({...s,at:Date.now()-600000}))", STATE)
                assert not any(try_commands(page))
                assert "sndTest" not in sent(page)
                state(page)
                assert page.evaluate("send('sndTest')")
                assert sent(page).count("sndTest") == 1
                receipt("Sound Lab enables Android only after explicit choice and a live authenticated report")
                page.goto(base)
                assert page.locator("#useAndroid").is_visible()
                select_android(page)
                state(page)
                assert page.locator("#stateText").inner_text() == "Paused"
                shot(page, "04-android-connected")
                page.locator("#toggle").click()
                assert page.locator("#stateText").inner_text() == "Play requested…"
                assert "play" in sent(page)
                shot(page, "05-android-requested")
                page.evaluate("""() => {
                  window.voiceAnswered = false;
                  window.pendingVoice = voiceTools.tidal_play.execute({}).then(answer => {window.voiceAnswered = true; return JSON.parse(answer);});
                }""")
                page.evaluate("async s => handle(await seal({...s,play:true,at:Date.now()}),true)", STATE)
                assert not page.evaluate("voiceAnswered")
                page.evaluate("""() => {
                  nudgeSeek(1); nudgeVolume(1); soundChanged();
                  const realSeal = window.seal;
                  window.seal = async (...args) => {await new Promise(resolve => setTimeout(resolve,100)); return realSeal(...args);};
                  window.pendingNext = send('next');
                  document.querySelector('.device-switch').click();
                  document.querySelector('#useIphone').click();
                }""")
                assert not page.evaluate("pendingNext")
                assert not page.evaluate("pendingVoice")["confirmed"]
                before = sent(page)
                page.evaluate("window.dispatchEvent(new Event('online'))")
                assert not any(try_commands(page))
                page.wait_for_timeout(2800)
                assert before == sent(page)
                assert not any(c in before for c in ("next","volSet","seek","sndSet"))
                assert page.evaluate("outbox.length === 0 && sentLately.length === 0")
                assert json.loads(page.evaluate("voiceTools.tidal_play.execute({})"))["error"]
                receipt("switch cancels pending encryption, play retry, seek, volume and sound; old voice tool blocked")
                page.locator("#chooseAgain").click()
                select_android(page)
                state(page)
                page.evaluate("""() => {
                  fakeAndroid.connected = false; linkChanged();
                }""")
                assert not any(try_commands(page))
                page.evaluate("fakeAndroid.connected = true; flushOutbox()")
                assert not any(try_commands(page))
                state(page, True)
                assert not any(try_commands(page))
                state(page)
                assert page.evaluate("send('next')")
                receipt("disconnected controls are discarded; reconnect and retained state cannot authorize replay")
                # Change the preference from Sound Lab, as occurs with two open launchers.
                other = ctx.new_page()
                other.goto(base+"sound/")
                other.locator("#useIphone").click()
                page.wait_for_function("!isAndroidVisit() && document.getElementById('setupTitle').textContent === 'iPhone playback'")
                assert not any(try_commands(page))
                receipt("switching phone in another launcher immediately revokes Android commands")
                other.close()
                page.locator("#chooseAgain").click()
                select_android(page)
                state(page)
                page.evaluate("window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
                assert not any(try_commands(page))
                assert page.locator("#useIphone").is_visible()
                receipt("returning from a suspended page requires a fresh foreground Android choice")
                page.wait_for_function("navigator.serviceWorker.controller !== null")
                ctx.set_offline(True)
                page.reload(wait_until="domcontentloaded")
                assert page.locator("#useIphone").is_visible()
                page.locator("#useIphone").click()
                page.goto(base+"sound/")
                assert page.locator("#setupTitle").inner_text() == "Sound Lab on iPhone"
                assert "Android companion" in page.locator("#setupOption").inner_text()
                assert not any(try_commands(page))
                receipt("offline cold reopen through both root and Sound Lab launcher serves safe iPhone mode")
                assert not errors, errors
        finally:
            browser.close()


if __name__ == "__main__":
    main()
