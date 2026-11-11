"""Check both glasses registrations under a Pages project subpath, online and offline."""
import struct
from pathlib import Path
from shutil import copytree, ignore_patterns
from tempfile import TemporaryDirectory
from urllib.parse import urljoin

from playwright.sync_api import sync_playwright
from output_test import server


def check_entry(page, address, title):
    page.goto(address)
    assert page.url == address
    assert page.title() == title
    for tag, value in (("application-name", title), ("mrbd-web-app-capable", "yes")):
        assert page.locator(f'meta[name="{tag}"]').get_attribute("content") == value
    desc = page.locator('meta[name="description"]').get_attribute("content")
    web_url = page.locator('link[rel="manifest"]').evaluate("e => e.href")
    native_url = urljoin(address, ".well-known/meta-wearables-manifest.json")
    request = page.context.request
    web = request.get(web_url).json()
    native = request.get(native_url).json()
    assert web["name"] == web["short_name"] == native["name"] == title
    assert web["description"] == native["description"] == desc and desc.strip()
    for field in ("id", "start_url", "scope"):
        assert urljoin(web_url, web[field]) == address

    mask = request.get(urljoin(native_url, native["appearance"]["icon"]["src"]))
    assert mask.ok and mask.headers["content-type"].startswith("image/svg+xml")
    icons = {}
    for asset in web["icons"]:
        url = urljoin(web_url, asset["src"])
        icon = request.get(url)
        data = icon.body()
        assert icon.ok and icon.headers["content-type"].startswith("image/png")
        assert data[:8] == bytes.fromhex("89504e470d0a1a0a")
        assert "%dx%d" % struct.unpack(">II", data[16:24]) == asset["sizes"]
        icons[asset["sizes"]] = (url, data)
    assert set(icons) >= {"192x192", "512x512"}
    for relation in ("icon", "apple-touch-icon"):
        assert page.locator(f'link[rel="{relation}"]').evaluate("e => e.href") == icons["192x192"][0]
    page.wait_for_function("navigator.serviceWorker.controller !== null")
    return icons["192x192"][1]


def main():
    source = Path(__file__).resolve().parents[1]
    with TemporaryDirectory() as tmp:
        copytree(source, Path(tmp) / "tidal-glass", ignore=ignore_patterns(".git", "tests", "node_modules"))
        with server(Path(tmp)) as host, sync_playwright() as pw:
            browser = pw.chromium.launch(channel="chrome")
            try:
                ctx = browser.new_context(viewport={"width": 600, "height": 600})
                page = ctx.new_page()
                base = host + "tidal-glass/"
                tidal = check_entry(page, base, "TIDAL Glass")
                sound = check_entry(page, base + "sound/", "Sound Lab")
                assert tidal != sound
                ctx.set_offline(True)
                page.goto(base + "?app=sound#t=obsolete&k=obsolete")
                page.wait_for_url(base + "sound/")
                assert page.title() == "Sound Lab"
                for entry in (base, base + "sound/"):
                    for path in ("manifest.webmanifest", ".well-known/meta-wearables-manifest.json",
                                 "icon-192.png", "icon-512.png", "icon-mono.svg"):
                        assert page.evaluate("u => fetch(u).then(r => r.ok)", urljoin(entry, path))
                print("PASS both native and web registrations, distinct PNGs, scope, old Sound alias and offline assets")
            finally:
                browser.close()


if __name__ == "__main__":
    main()
