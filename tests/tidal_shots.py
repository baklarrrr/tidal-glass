"""Screenshots of the TIDAL library (iPhone) path at the glasses' size, with a mocked TIDAL.

600 x 600 at device scale 2, service workers blocked, nothing real contacted (tests/tidal_mock.py).
  python tests/tidal_shots.py OUT_DIR [--before DIR_OF_PREVIOUS_RELEASE]
"""
import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright

from output_test import server
from tidal_mock import MockTidal, sign_in


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path)
    parser.add_argument("--before", type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parents[1]

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", args=["--enable-spatial-navigation", "--autoplay-policy=no-user-gesture-required"])

        def context():
            ctx = browser.new_context(viewport={"width": 600, "height": 600}, device_scale_factor=2, service_workers="block")
            ctx.route_web_socket("**/*", lambda ws: ws.close())
            return ctx

        def shot(page, name):
            page.wait_for_timeout(350)
            page.screenshot(path=args.out / (name + ".png"))
            print("shot", name, flush=True)

        try:
            if args.before:
                with server(args.before) as base, context() as ctx:
                    page = ctx.new_page()
                    page.goto(base)
                    shot(page, "00-before-iphone-card")

            with server(root) as base:
                with context() as ctx:  # as committed: no client ID
                    page = ctx.new_page()
                    page.goto(base)
                    shot(page, "01-no-client-id")

                with context() as ctx:
                    mock = MockTidal(base)
                    mock.install(ctx)
                    page = ctx.new_page()
                    page.goto(base)
                    page.locator("#signIn").wait_for()
                    shot(page, "02-signed-out")
                    sign_in(page, base)
                    shot(page, "03-library")
                    page.keyboard.press("ArrowDown")
                    page.keyboard.press("ArrowDown")
                    shot(page, "04-library-focus-albums")
                    page.keyboard.press("ArrowUp")
                    page.keyboard.press("ArrowUp")
                    page.keyboard.press("Enter")
                    page.locator("#items .thumb.has-art").first.wait_for()
                    shot(page, "05-my-tracks")
                    for _ in range(12):
                        page.keyboard.press("ArrowDown")
                        page.wait_for_timeout(40)
                    shot(page, "06-my-tracks-long-title")
                    for _ in range(30):
                        if page.evaluate("document.activeElement.id === 'more'"):
                            break
                        page.keyboard.press("ArrowDown")
                        page.wait_for_timeout(40)
                    shot(page, "07-my-tracks-more")
                    page.keyboard.press("Enter")
                    page.wait_for_function("document.querySelectorAll('#items button').length === 40")
                    shot(page, "08-my-tracks-second-page")
                    page.evaluate("document.querySelector('#items button[data-id=\"tracks:t1\"]').focus()")
                    page.keyboard.press("Enter")
                    page.wait_for_function("document.getElementById('toggleLabel').textContent === 'Preview 30 s' && !document.getElementById('toggleLabel').hidden")
                    page.locator("#artwrap.has-art").wait_for()
                    shot(page, "09-song-preview")
                    page.keyboard.press("Enter")
                    page.wait_for_function("document.getElementById('stateText').textContent === 'Playing a preview' && document.getElementById('elapsed').textContent >= '0:02'")
                    shot(page, "10-song-preview-playing")
                    page.keyboard.press("Enter")
                    page.locator("#next").click()
                    page.wait_for_function("document.getElementById('stateText').textContent === 'Ready to play'")
                    page.locator("#artwrap.has-art").wait_for()
                    shot(page, "11-song-full")
                    page.locator("#next").click()
                    page.wait_for_function("document.getElementById('stateText').textContent === 'Plays from your phone'")
                    shot(page, "12-song-plays-from-phone")
                    for _ in range(10):
                        page.locator("#next").click()
                    page.wait_for_function("document.getElementById('stateText').textContent === 'Preview ready'")
                    page.locator("#artwrap.has-art").wait_for()
                    shot(page, "13-song-long-title")
                    page.go_back()
                    page.go_back()
                    for key, name, ready in (("playlists", "14-playlists", "#items .thumb.has-art"), ("albums", "15-albums", "#items .thumb.has-art"),
                                             ("artists", "16-artists", "#items .thumb.has-art")):
                        page.locator(f'#items button[data-id="menu:{key}"]').click()
                        page.locator(ready).first.wait_for()
                        shot(page, name)
                        if key == "artists":
                            page.locator('#items button[data-id="artists:a5"]').click()
                            page.locator("#items .thumb.has-art").first.wait_for()
                            shot(page, "17-artist-albums")
                            page.go_back()
                        page.go_back()
                    page.locator('#items button[data-id="menu:search"]').click()
                    shot(page, "18-search")
                    page.keyboard.type("me")
                    page.keyboard.press("Enter")
                    page.locator("#items .thumb.has-art").first.wait_for()
                    shot(page, "19-search-results")
                    page.go_back()
                    page.go_back()
                    page.locator('#items button[data-id="menu:help"]').click()
                    shot(page, "20-help")
                    page.go_back()
                    # Offline, in a fresh page: the saved titles open at once.
                    mock.offline = True
                    page.reload()
                    page.locator('#items button[data-id="menu:tracks"]').wait_for()
                    page.keyboard.press("Enter")
                    page.wait_for_function("document.getElementById('listNote').textContent.startsWith('Saved list from')")
                    shot(page, "21-offline-saved-list")
                    mock.offline = False
                    page.evaluate("window.dispatchEvent(new Event('online'))")
                    page.locator("#items .thumb.has-art").first.wait_for()
                    # TIDAL refuses to renew the sign-in.
                    mock.expire_tokens()
                    mock.refresh_ok = False
                    page.go_back()
                    page.locator('#items button[data-id="menu:albums"]').click()
                    page.locator("#signIn").wait_for()
                    shot(page, "22-sign-in-again")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
