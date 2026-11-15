"""TIDAL library on the glasses with an iPhone: sign-in, menu, paging, Back, playback labels, failures.

TIDAL itself is never contacted: tests/tidal_mock.py answers for login.tidal.com, auth.tidal.com and
openapi.tidal.com through Playwright route interception. This proves the app against the documented
shapes; it does not prove a real TIDAL account, the real glasses, or protected playback.

Every check runs on its own and reports PASS or FAIL, so one failure does not hide the rest.
  python tests/tidal_test.py
"""
import json
import sys
import time
from pathlib import Path
from shutil import copytree, ignore_patterns
from tempfile import TemporaryDirectory

from playwright.sync_api import sync_playwright

import output_test
from output_test import BRIDGE, server
from tidal_mock import CLIENT_ID, MockTidal, sign_in

ROOT = Path(__file__).resolve().parents[1]
SCOPES = "user.read collection.read playlists.read search.read playback"
results = []


def check(label, fn):
    try:
        fn()
        results.append(True)
        print("PASS %d %s" % (len(results), label), flush=True)
    except Exception as e:  # noqa: BLE001 - every failure is reported, none stops the run
        results.append(False)
        print("FAIL %d %s\n     %s" % (len(results), label, str(e).splitlines()[0] if str(e) else repr(e)), flush=True)


def focused(page):
    return page.evaluate("document.activeElement && (document.activeElement.dataset.id || document.activeElement.id)")


def key(page, name, times=1):
    for _ in range(times):
        page.keyboard.press(name)
        page.wait_for_timeout(40)


def titles(page):
    return page.locator("#items .ti").all_inner_texts()


def text(page, sel):
    return page.locator(sel).inner_text()


def open_menu(page, name):
    page.locator(f'#items button[data-id="menu:{name}"]').click()


def wait_rows(page, n):
    page.wait_for_function("n => document.querySelectorAll('#items button.art').length === n", arg=n)


def wait_text(page, sel, value):
    page.wait_for_function("([s, v]) => document.querySelector(s).textContent === v", arg=[sel, value])


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", args=["--enable-spatial-navigation", "--autoplay-policy=no-user-gesture-required"])
        errors = []

        def new_context(mock=None, android=False, **extra):
            ctx = output_test.context(browser) if android else browser.new_context(
                viewport={"width": 600, "height": 600}, service_workers="block", **extra)
            if not android:
                ctx.route_web_socket("**/*", lambda ws: ws.close())
            if mock:
                mock.install(ctx)
            ctx.on("page", lambda p: p.on("pageerror", lambda e: errors.append(str(e))))
            return ctx

        try:
            with server(ROOT) as base:
                # ---- no client ID: the app with an empty tidal-config.js --------------------------
                with new_context() as ctx:
                    ctx.route("**/tidal-config.js", lambda r: r.fulfill(content_type="text/javascript", body="window.TIDAL_CLIENT_ID = '';"))
                    page = ctx.new_page()
                    asked = []
                    page.on("request", lambda r: asked.append(r.url))
                    page.goto(base)

                    def no_client_id():
                        assert text(page, "#setupTitle") == "TIDAL on iPhone"
                        assert text(page, "#setupNeed").startswith("TIDAL needs one sign-in to set up")
                        assert "tap the right temple" in text(page, "#setupOption")
                        assert not page.locator("#signIn").is_visible() and not page.locator("#signOut").is_visible()
                        assert not page.evaluate("TidalAPI.configured() || TidalAPI.signedIn()")
                        page.wait_for_timeout(300)
                        assert not [u for u in asked if "tidal.com" in u], asked
                    check("no client ID: a calm first screen says TIDAL needs one sign-in, shows what works today, contacts nothing", no_client_id)

                    def no_client_id_with_answer():
                        page.goto(base + "?code=stray&state=stray")
                        page.wait_for_timeout(300)
                        assert text(page, "#setupTitle") == "TIDAL on iPhone" and not page.locator("#signIn").is_visible()
                        assert not [u for u in asked if "auth.tidal.com" in u]
                    check("no client ID: a stray sign-in answer in the address is ignored", no_client_id_with_answer)

                # ---- sign-in ------------------------------------------------------------------------------
                mock = MockTidal(base)
                with new_context(mock) as ctx:
                    page = ctx.new_page()
                    page.goto(base)

                    def signed_out():
                        page.locator("#signIn").wait_for()
                        assert text(page, "#signIn") == "Sign in to TIDAL" and focused(page) == "signIn"
                        assert "Sign in once" in text(page, "#setupNeed")
                        assert "tap the right temple" in text(page, "#setupOption")
                        assert not mock.log and not mock.logins and not mock.token_posts
                    check("client ID present, signed out: one focused Sign in to TIDAL button; nothing asked of TIDAL yet", signed_out)

                    def round_trip():
                        page.keyboard.press("Enter")
                        page.locator('#items button[data-id="menu:tracks"]').wait_for()
                        q = mock.logins[-1]
                        assert q["scope"] == SCOPES and q["redirect_uri"] == base and q["client_id"] == CLIENT_ID
                        assert q["response_type"] == "code" and q["code_challenge_method"] == "S256"
                        form = mock.token_posts[-1]
                        assert form["grant_type"] == "authorization_code" and len(form["code_verifier"]) >= 43
                        assert "client_secret" not in form
                        assert page.url == base, page.url
                        saved = json.loads(page.evaluate("localStorage.getItem('tg.tidal.auth.v1')"))
                        assert saved["a"] == "access-1" and saved["r"] == "refresh-1"
                        assert page.evaluate("sessionStorage.getItem('tg.tidal.pkce.v1')") is None
                    check("sign-in round trip: PKCE request, code exchanged with its verifier and no secret, address cleaned, tokens stored", round_trip)

                    def tokens_not_in_addresses():
                        page.wait_for_function("!!JSON.parse(localStorage.getItem('tg.tidal.auth.v1')).uid")
                        seen = json.dumps([c[1:] for c in mock.log]) + page.url + json.dumps(mock.logins)
                        assert "access-" not in seen and "refresh-" not in seen
                        assert page.evaluate("JSON.stringify(history.state)").find("access-") < 0
                    check("tokens travel only in the Authorization header and the token form, never in an address or history", tokens_not_in_addresses)

                    def menu():
                        assert titles(page) == ["My tracks", "Playlists", "Albums", "Artists", "Search", "Help and sign out"]
                        assert text(page, "#listTitle") == "Library" and focused(page) == "menu:tracks"
                        key(page, "ArrowDown")
                        assert focused(page) == "menu:playlists"
                        key(page, "ArrowDown", 2)
                        assert focused(page) == "menu:artists"
                        key(page, "ArrowUp", 3)
                        assert focused(page) == "menu:tracks"
                        box = page.locator("#items").bounding_box()
                        last = page.locator('#items button[data-id="menu:help"]').bounding_box()
                        assert last["y"] + last["height"] <= box["y"] + box["height"] and last["y"] + last["height"] < 600
                    check("Library menu: six rows on one screen, swipes move the focus up and down", menu)

                    def tidal_marks():
                        link = page.locator("#listTidal")
                        assert link.is_visible() and link.inner_text().strip() == "Open in TIDAL"
                        assert link.get_attribute("href").startswith("https://tidal.com/")
                        assert page.locator("#listTidal .tidal-logo").is_visible()
                    check("the TIDAL logo and an Open in TIDAL link are on the Library", tidal_marks)

                    def first_page():
                        key(page, "Enter")
                        wait_rows(page, 20)
                        assert text(page, "#listTitle") == "My tracks" and text(page, "#crumb") == "Library"
                        assert focused(page) == "tracks:t1"
                        page.wait_for_function("document.querySelectorAll('#items .thumb.has-art').length === 20")
                        assert page.locator('#items button[data-id="tracks:t1"] .su').inner_text() == "Khruangbin · 2:30"
                        assert focused(page) == "tracks:t1", "details arriving must not move the focus"
                        assert page.locator("#more").is_visible() and text(page, "#listNote") == ""
                    check("My tracks: first page of 20 with title, artist, duration and artwork; focus stays on the first row", first_page)

                    def arrows():
                        key(page, "ArrowDown", 5)
                        assert focused(page) == "tracks:t6"
                        visible = page.evaluate("""() => { const b = document.getElementById('items').getBoundingClientRect();
                          const r = document.activeElement.getBoundingClientRect(); return r.top >= b.top && r.bottom <= b.bottom; }""")
                        assert visible
                        page.wait_for_timeout(300)
                        style = page.evaluate("""() => { const c = getComputedStyle(document.activeElement);
                          return [c.borderTopColor, c.boxShadow]; }""")
                        assert style[0] == "rgb(47, 216, 236)" and style[1] != "none", style
                        key(page, "ArrowUp", 2)
                        assert focused(page) == "tracks:t4"
                    check("list rows: swipes move one row at a time, the focused row is whole on screen with a cyan ring", arrows)

                    def ellipsis():
                        row = page.locator('#items button[data-id="tracks:t13"]')
                        row.focus()
                        m = row.evaluate("""b => { const t = b.querySelector('.ti'); const c = getComputedStyle(t); const r = b.getBoundingClientRect();
                          return [t.scrollWidth > t.clientWidth, c.textOverflow, c.whiteSpace, r.right <= 600, t.getBoundingClientRect().right <= r.right]; }""")
                        assert m == [True, "ellipsis", "nowrap", True, True], m
                        s = page.locator('#items button[data-id="tracks:t14"] .su').evaluate(
                            "t => [t.scrollWidth > t.clientWidth, getComputedStyle(t).textOverflow]")
                        assert s == [True, "ellipsis"], s
                    check("a long title and a long artist line end in an ellipsis inside the row, never clipped or wrapped", ellipsis)

                    def paging():
                        page.locator('#items button[data-id="tracks:t20"]').focus()
                        key(page, "ArrowDown")
                        assert focused(page) == "more"
                        key(page, "Enter")
                        wait_rows(page, 40)
                        page.wait_for_function("document.activeElement.dataset.id === 'tracks:t21'")
                        page.locator('#items button[data-id="tracks:t40"]').focus()
                        key(page, "ArrowDown")
                        key(page, "Enter")
                        wait_rows(page, 45)
                        assert not page.locator("#more").is_visible()
                        assert focused(page) == "tracks:t41"
                        cursors = [c[2].get("page[cursor]") for c in mock.calls("/userCollectionTracks/")]
                        assert cursors == [None, ["20"], ["40"]], cursors
                        assert all(len([x for v in c[2]["filter[id]"] for x in v.split(",")]) <= 20 for c in mock.calls("/tracks"))
                    check("paging: More loads the next page in place (20, 40, 45), focus lands on the first new row, then More goes away", paging)

                    def back_levels():
                        page.locator('#items button[data-id="tracks:t5"]').focus()
                        key(page, "Enter")
                        page.locator("#now").wait_for()
                        assert text(page, "#title") == "My Friend the Forest" and not page.locator("#list").is_visible()
                        page.go_back()
                        page.locator("#list").wait_for()
                        assert text(page, "#listTitle") == "My tracks" and focused(page) == "tracks:t5"
                        assert len(titles(page)) == 45
                        key(page, "ArrowLeft")
                        page.wait_for_function("document.getElementById('listTitle').textContent === 'Library'")
                        assert focused(page) == "menu:tracks"
                    check("Back goes one level up each time: song, then its list on the same row, then the Library on My tracks", back_levels)

                    def deep_back():
                        open_menu(page, "artists")
                        wait_rows(page, 5)
                        page.locator('#items button[data-id="artists:a2"]').click()
                        page.wait_for_function("document.getElementById('listTitle').textContent === 'Nils Frahm'")
                        assert text(page, "#crumb") == "Library › Artists"
                        wait_rows(page, 1)
                        key(page, "ArrowRight")
                        page.wait_for_function("document.getElementById('listTitle').textContent === 'All Melody'")
                        wait_rows(page, 9)
                        key(page, "Enter")
                        page.locator("#now").wait_for()
                        assert page.evaluate("history.state.tl.length") == 5
                        for want in ("All Melody", "Nils Frahm", "Artists", "Library"):
                            key(page, "Escape")
                            page.wait_for_function("t => !document.getElementById('list').hidden && document.getElementById('listTitle').textContent === t", arg=want)
                        assert focused(page) == "menu:artists"
                    check("four levels deep (Artists, artist, album, song): Back returns through each one in order", deep_back)

                    def preview():
                        open_menu(page, "tracks")
                        wait_rows(page, 45)
                        page.locator('#items button[data-id="tracks:t1"]').focus()
                        key(page, "Enter")
                        wait_text(page, "#toggleLabel", "Preview 30 s")
                        assert page.locator("#toggleLabel").is_visible() and focused(page) == "toggle"
                        assert text(page, "#tplayNote") == "TIDAL lets other apps play previews only."
                        assert text(page, "#tplayHint") == "Full songs play from the TIDAL app on your phone."
                        assert text(page, "#title") == "Time (You and I)" and text(page, "#artist") == "Khruangbin"
                        assert text(page, "#album") == "Mordechai · 2:30"
                        page.locator("#artwrap.has-art").wait_for()
                        assert page.locator("#nowTidalLink").get_attribute("href") == "https://tidal.com/track/t1"
                        assert page.locator("#nowTidal .tidal-logo").is_visible() and text(page, "#nowTidalLink") == "Open in TIDAL"
                        for hidden in (".device-switch", "#like", "#soundBtn", "#voldown", "#library"):
                            assert not page.locator("#now " + hidden).first.is_visible(), hidden
                        m = mock.calls("/trackManifests/t1")[-1][2]
                        assert m["usage"] == ["PLAYBACK"] and "formats" in m and "manifestType" in m
                    check("a preview-only song: the button says Preview 30 s, one line says why, with artwork, title, artist, album, duration and TIDAL link", preview)

                    def preview_plays():
                        key(page, "Enter")
                        wait_text(page, "#stateText", "Playing a preview")
                        assert text(page, "#toggleLabel") == "Pause preview"
                        page.wait_for_function("document.getElementById('elapsed').textContent >= '0:01'")
                        assert page.locator("#seek").evaluate("e => !e.classList.contains('disabled') && e.tabIndex === 0")
                        key(page, "Enter")
                        page.wait_for_function("document.getElementById('toggleLabel').textContent === 'Preview 30 s'")
                        assert page.locator("#dot").evaluate("e => !e.classList.contains('live')")
                    check("pressing Preview plays it in the page with the progress bar; pressing again pauses", preview_plays)

                    def full():
                        page.locator("#next").click()
                        wait_text(page, "#stateText", "Ready to play")
                        assert text(page, "#title") == "So We Won't Forget"
                        assert not page.locator("#toggleLabel").is_visible() and page.locator("#toggle").get_attribute("aria-label") == "Play"
                        assert text(page, "#tplayNote") == "" and text(page, "#tplayHint") == ""
                        page.locator("#toggle").click()
                        wait_text(page, "#stateText", "Playing")
                        assert page.locator("#toggle").get_attribute("aria-label") == "Pause"
                        page.locator("#toggle").click()
                        wait_text(page, "#stateText", "Paused")
                    check("a song TIDAL answers FULL with a playable file: plain Play and Pause, no preview wording", full)

                    def phone_only():
                        page.locator("#next").click()
                        wait_text(page, "#stateText", "Plays from your phone")
                        assert text(page, "#title") == "Pelota"
                        assert not page.locator("#toggle").is_visible()
                        assert text(page, "#tplayNote") == "Play this in TIDAL on your iPhone"
                        assert "tap the right temple" in text(page, "#tplayHint")
                        assert focused(page) in ("next", "prev")
                        assert page.evaluate("history.state.tl.length") == 3, "Next and Previous must not add levels"
                    check("a protected song nothing in the page can play: no Play button, Play this in TIDAL on your iPhone, the temple-tap hint", phone_only)

                    def refresh():
                        page.go_back()
                        key(page, "Escape")
                        page.wait_for_function("document.getElementById('listTitle').textContent === 'Library'")
                        mock.expire_tokens()
                        before = len(mock.token_posts)
                        open_menu(page, "albums")
                        wait_rows(page, 5)
                        posts = mock.token_posts[before:]
                        assert [p["grant_type"] for p in posts] == ["refresh_token"] and posts[0]["refresh_token"] == "refresh-1"
                        saved = json.loads(page.evaluate("localStorage.getItem('tg.tidal.auth.v1')"))
                        assert saved["a"] == "access-2" and saved["r"] == "refresh-1"
                        assert page.locator('#items button[data-id="albums:b5"] .su').inner_text().startswith("The Cinematic Orchestra")
                    check("an expired token: one silent refresh, the request repeats, the list shows; the refresh token is kept", refresh)

                    def slow_down():
                        key(page, "Escape")
                        mock.slow_down = 1
                        start = time.time()
                        open_menu(page, "playlists")
                        wait_rows(page, 3)
                        assert time.time() - start >= 0.9, "Retry-After: 1 was not respected"
                        assert text(page, "#listNote") == ""
                        assert titles(page)[1] == "Deep focus for long edits and renders"
                        page.wait_for_function("document.querySelectorAll('#items .thumb.has-art').length === 3")
                        assert page.locator('#items button[data-id="playlists:p-uuid-2"] .su').inner_text() == "34 tracks"
                    check("429: waits as long as Retry-After says, then loads; rows TIDAL only named are fetched by id", slow_down)

                    def auth_lost_keeps_place():
                        page.locator('#items button[data-id="playlists:p-uuid-2"]').click()
                        wait_rows(page, 20)
                        mock.expire_tokens()
                        mock.refresh_ok = False
                        page.locator("#more").click()
                        page.locator("#signIn").wait_for()
                        assert "Your place in the menu is kept" in text(page, "#setupNeed")
                        assert page.evaluate("localStorage.getItem('tg.tidal.auth.v1')") is None
                        assert not page.locator("#list").is_visible() and focused(page) == "signIn"
                        mock.refresh_ok = True
                        key(page, "Enter")
                        page.wait_for_function("!document.getElementById('list').hidden && document.getElementById('listTitle').textContent === 'Deep focus for long edits and renders'")
                        assert text(page, "#crumb") == "Library › Playlists"
                        wait_rows(page, 20)
                        key(page, "Escape")
                        wait_text(page, "#listTitle", "Playlists")
                        key(page, "Escape")
                        wait_text(page, "#listTitle", "Library")
                    check("a sign-in TIDAL will not renew: back to Sign in with one calm line, and after signing in the menu is where it was", auth_lost_keeps_place)

                    def server_errors():
                        mock.fail_5xx = 2
                        open_menu(page, "search")
                        assert focused(page) == "searchBox"
                        page.keyboard.type("all")
                        key(page, "Enter")
                        page.wait_for_function("document.querySelectorAll('#items button.art').length >= 2", timeout=10000)
                        kinds = page.evaluate("[...document.querySelectorAll('#items button')].map(b => b.dataset.id.split(':')[0])")
                        assert "tracks" in kinds and "albums" in kinds, kinds
                        assert text(page, "#listTitle") == "all" and text(page, "#crumb") == "Library › Search"
                        key(page, "Escape")
                        page.wait_for_function("!document.getElementById('searchRow').hidden")
                        key(page, "Escape")
                        wait_text(page, "#listTitle", "Library")
                        assert focused(page) == "menu:search"
                    check("two 503 answers are retried quietly; Search shows songs and albums and Back steps out through the search box", server_errors)

                    def offline_saved():
                        mock.offline = True
                        page.reload()
                        page.locator('#items button[data-id="menu:tracks"]').wait_for()
                        key(page, "Enter")
                        wait_rows(page, 40)  # the saved copy holds the first 40 titles
                        assert titles(page)[0] == "Time (You and I)"
                        page.wait_for_function("document.getElementById('listNote').textContent.startsWith('Saved list from')", timeout=15000)
                        assert "No connection" in text(page, "#listNote")
                        mock.offline = False  # no event: the app's own timer must try again
                        page.wait_for_function("document.getElementById('listNote').textContent === ''", timeout=15000)
                        page.locator("#items .thumb.has-art").first.wait_for()
                    check("no connection: the saved titles open at once, one line says Saved list from <time>, and it retries by itself", offline_saved)

                    def offline_no_copy():
                        key(page, "Escape")
                        mock.offline = True
                        page.evaluate("localStorage.removeItem('tg.tidal.lists.v1')")
                        page.reload()
                        page.locator('#items button[data-id="menu:artists"]').click()
                        wait_text(page, "#listNote", "Loading…")
                        page.wait_for_function("document.getElementById('listNote').textContent === 'No connection. Trying again…'", timeout=15000)
                        assert page.locator("#list").is_visible() and text(page, "#listTitle") == "Artists"
                        mock.offline = False
                        page.evaluate("window.dispatchEvent(new Event('online'))")
                        wait_rows(page, 5)
                        assert text(page, "#listNote") == ""
                    check("no connection and nothing saved: one calm line, never a blank screen, and the list arrives when the connection does", offline_no_copy)

                    def saved_is_titles_only():
                        raw = page.evaluate("localStorage.getItem('tg.tidal.lists.v1')")
                        assert "http" not in raw and "access-" not in raw and "refresh-" not in raw
                        rows = [r for entry in json.loads(raw).values() for r in entry["rows"]]
                        assert rows and all(set(r) <= {"id", "type", "ti", "su", "al", "dur"} for r in rows)
                    check("the saved menu copy holds titles only: no addresses, no artwork, no tokens", saved_is_titles_only)

                    def song_offline():
                        key(page, "Escape")
                        open_menu(page, "tracks")
                        wait_rows(page, 20)
                        mock.offline = True
                        page.locator('#items button[data-id="tracks:t7"]').click()
                        page.wait_for_function("document.getElementById('stateText').textContent === 'No connection. Trying again…'", timeout=15000)
                        assert text(page, "#title") == "Introvert" and page.locator("#now").is_visible()
                        mock.offline = False
                        page.evaluate("window.dispatchEvent(new Event('online'))")
                        wait_text(page, "#toggleLabel", "Preview 30 s")
                    check("a song opened without a connection keeps its title on screen, says so calmly and recovers by itself", song_offline)

                    def hide_and_show():
                        page.go_back()
                        page.locator('#items button[data-id="tracks:t9"]').focus()
                        page.evaluate("window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
                        assert page.locator("#list").is_visible() and text(page, "#listTitle") == "My tracks" and focused(page) == "tracks:t9"
                    check("the display going to sleep and waking keeps the same list and the same focused row", hide_and_show)

                    def help_and_sign_out():
                        key(page, "Escape")
                        open_menu(page, "help")
                        page.locator("#signOut").wait_for()
                        assert focused(page) == "setupTitle", "Sign out must not be one accidental pinch away"
                        assert "tap the right temple" in text(page, "#setupOption")
                        assert not page.locator("#signIn").is_visible() and not page.locator("#useAndroid").is_visible()
                        key(page, "ArrowDown")
                        assert focused(page) == "signOut"
                        key(page, "Escape")
                        wait_text(page, "#listTitle", "Library")
                        assert focused(page) == "menu:help"
                        open_menu(page, "help")
                        page.locator("#signOut").click()
                        page.locator("#signIn").wait_for()
                        assert page.evaluate("localStorage.getItem('tg.tidal.auth.v1') === null && localStorage.getItem('tg.tidal.lists.v1') === null")
                        assert "Signed out" in text(page, "#setupNeed")
                    check("Help keeps the temple-tap card one Back away; Sign out removes the tokens and the saved menu copy", help_and_sign_out)

                # ---- answers that must be refused ---------------------------------------------------------------
                mock = MockTidal(base)
                with new_context(mock) as ctx:
                    page = ctx.new_page()

                    def bad_answers():
                        page.goto(base + "?code=forged&state=forged")
                        page.wait_for_function("document.getElementById('setupNeed').textContent.startsWith('Signing in did not finish')")
                        assert page.url == base and not mock.token_posts and focused(page) == "signIn"
                        page.goto(base + "?error=access_denied&state=x")
                        page.wait_for_function("document.getElementById('setupNeed').textContent.startsWith('Signing in was cancelled')")
                        assert page.url == base and not page.evaluate("TidalAPI.signedIn()")
                    check("a forged or cancelled sign-in answer: nothing exchanged, address cleaned, back on Sign in with one line", bad_answers)

                    def garbage():
                        sign_in(page, base)
                        ctx.route("https://openapi.tidal.com/v2/userCollectionAlbums/**", lambda r: r.fulfill(
                            status=200, headers={"access-control-allow-origin": "*"}, body="<html>not json"))
                        open_menu(page, "albums")
                        wait_text(page, "#listNote", "TIDAL did not answer. Trying again…")
                        assert page.locator("#list").is_visible()
                        ctx.unroute("https://openapi.tidal.com/v2/userCollectionAlbums/**")
                        wait_rows(page, 5)
                    check("an answer that is not JSON: one calm line, then the list once TIDAL answers properly", garbage)

                # ---- storage switched off --------------------------------------------------------------------------
                mock = MockTidal(base)
                with new_context(mock) as ctx:
                    ctx.add_init_script("""(() => { const set = Storage.prototype.setItem;
                      Storage.prototype.setItem = function (k, v) { if (this === window.localStorage) throw new DOMException('full', 'QuotaExceededError'); return set.call(this, k, v); }; })();""")
                    page = ctx.new_page()

                    def storage_off():
                        sign_in(page, base)
                        open_menu(page, "tracks")
                        wait_rows(page, 20)
                        assert page.evaluate("localStorage.getItem('tg.tidal.auth.v1')") is None
                        page.locator('#items button[data-id="tracks:t1"]').click()
                        wait_text(page, "#toggleLabel", "Preview 30 s")
                    check("local storage that refuses every write: sign-in, lists and songs still work for this visit", storage_off)

                # ---- the Android path, untouched ---------------------------------------------------------------------
                mock = MockTidal(base)
                with new_context(mock, android=True) as ctx:
                    page = ctx.new_page()

                    def android_still_works():
                        sign_in(page, base)
                        page.goto(base + BRIDGE)
                        page.locator('#items button[data-id="menu:help"]').wait_for()
                        assert page.evaluate("linksToAndroid === 0 && sent.length === 0")
                        open_menu(page, "help")
                        page.locator("#useAndroid").wait_for()
                        output_test.select_android(page)
                        output_test.state(page)
                        assert text(page, "#stateText") == "Paused" and text(page, "#title") == "Test track"
                        assert not page.evaluate("document.body.classList.contains('tidal')")
                        for shown in ("#like", "#library", "#soundBtn", "#voldown", "#now .device-switch"):
                            assert page.locator(shown).is_visible(), shown
                        assert not page.locator("#tplay").is_visible() and not page.locator("#nowTidal").is_visible()
                        page.locator("#toggle").click()
                        assert text(page, "#stateText") == "Play requested…" and "play" in output_test.sent(page)
                        page.go_back()  # the Help level the library left behind
                        page.wait_for_timeout(200)
                        assert page.locator("#now").is_visible() and text(page, "#title") == "Test track"
                    check("signed in and paired: Help offers Control paired Android, and the Android player works exactly as before", android_still_works)

                    def back_to_library():
                        page.locator("#now .device-switch").click()
                        page.locator('#items button[data-id="menu:tracks"]').wait_for()
                        assert not any(output_test.try_commands(page))
                        open_menu(page, "tracks")
                        wait_rows(page, 20)
                        page.locator('#items button[data-id="tracks:t1"]').click()
                        wait_text(page, "#toggleLabel", "Preview 30 s")
                        before = output_test.sent(page)
                        page.locator("#toggle").click()
                        wait_text(page, "#stateText", "Playing a preview")
                        assert output_test.sent(page) == before, "a press in the TIDAL library must never reach the Android phone"
                    check("Android · Switch returns to the TIDAL library; presses there never reach the Android phone", back_to_library)

            # ---- service worker: the app opens offline ---------------------------------------------------------------------
            with TemporaryDirectory() as tmp:
                site = Path(tmp) / "tidal-glass"
                copytree(ROOT, site, ignore=ignore_patterns(".git", "tests", "node_modules"))
                (site / "tidal-config.js").write_text("window.TIDAL_CLIENT_ID=%s;" % json.dumps(CLIENT_ID))
                with server(Path(tmp)) as host:
                    base = host + "tidal-glass/"
                    mock = MockTidal(base)
                    ctx = browser.new_context(viewport={"width": 600, "height": 600})
                    ctx.on("page", lambda p: p.on("pageerror", lambda e: errors.append(str(e))))
                    ctx.route("https://login.tidal.com/**", mock.login)
                    ctx.route("https://auth.tidal.com/**", mock.token)
                    ctx.route("https://openapi.tidal.com/**", mock.api)
                    ctx.route("https://resources.tidal.com/**", mock.image)
                    page = ctx.new_page()

                    def offline_shell():
                        page.goto(base)
                        page.wait_for_function("navigator.serviceWorker.controller !== null")
                        sign_in(page, base)
                        open_menu(page, "tracks")
                        wait_rows(page, 20)
                        cached = page.evaluate("caches.open('tidal-glass-v26').then(c => c.keys()).then(ks => ks.map(k => k.url))")
                        for name in ("tidal-api.js", "tidal-library.js", "tidal-config.js", "app.js", "style.css"):
                            assert any(u.endswith("/" + name) for u in cached), name
                        assert not [u for u in cached if "code=" in u or "state=" in u], "a sign-in answer was kept in the cache"
                        assert page.evaluate("caches.keys()") == ["tidal-glass-v26"]
                        ctx.set_offline(True)
                        mock.offline = True
                        page.reload(wait_until="domcontentloaded")
                        page.locator('#items button[data-id="menu:tracks"]').wait_for()
                        key(page, "Enter")
                        wait_rows(page, 20)
                        page.wait_for_function("document.getElementById('listNote').textContent.startsWith('Saved list from')", timeout=15000)
                    check("with the service worker (cache v26, new files in its shell): the app and its saved menu open with no network at all", offline_shell)
                    ctx.close()

            check("no page errors in any of the above", lambda: (_ for _ in ()).throw(AssertionError(errors[:3])) if errors else None)
        finally:
            browser.close()

    failed = results.count(False)
    print("%d passed, %d failed" % (results.count(True), failed))
    print("ALL PASS" if not failed else "FAILURES")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
