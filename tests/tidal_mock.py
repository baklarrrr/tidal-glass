"""A stand-in for TIDAL, for tests and screenshots of the TIDAL library (iPhone) path.

Nothing here reaches TIDAL: Playwright answers every request to login.tidal.com, auth.tidal.com,
openapi.tidal.com and resources.tidal.com from this file. The shapes follow TIDAL's public API
reference (JSON:API documents, cursor paging through links.next, authorization code + PKCE).
It is a test double: it proves the app's behaviour against these shapes, not against the real service.
"""
import base64
import hashlib
import io
import json
import math
import struct
import time
import wave
from urllib.parse import parse_qs, urlencode, urlparse

from PIL import Image, ImageDraw

CLIENT_ID = "mock-client-id"
USER_ID = "4201"
CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS"}

ARTISTS = {
    "a1": "Khruangbin", "a2": "Nils Frahm", "a3": "Little Simz", "a4": "Bonobo",
    "a5": "The Cinematic Orchestra featuring Patrick Watson and the London Metropolitan Strings",
}
ALBUMS = {  # id: (title, artist id)
    "b1": ("Mordechai", "a1"), "b2": ("All Melody", "a2"), "b3": ("Sometimes I Might Be Introvert", "a3"),
    "b4": ("Migration", "a4"), "b5": ("Ma Fleur (Deluxe Anniversary Edition, Remastered)", "a5"),
}
TITLES = [
    "Time (You and I)", "So We Won't Forget", "Pelota", "All Melody", "My Friend the Forest", "Sunson",
    "Introvert", "Woman", "Point and Kill", "Migration", "Kerala", "Break Apart",
    "To Build a Home (Live at the Royal Albert Hall with the London Metropolitan Orchestra, 2007)",
    "Familiar", "As the Stars Fall", "Dearest Alfred", "If There Is No Question", "Connaissais de Face",
    "A Place", "Human", "Momentum", "Says", "Hammers", "Toilet Brushes - More", "Some", "Ode",
    "Two Night Wonder", "Standing Ovation", "Rollin Stone", "Little Q, Pt. 2", "Gems (Interlude)",
    "Speed", "I Love You, I Hate You", "Grains", "Outlier", "Second Sun", "Surface", "Bambro Koyo Ganda",
    "Ontario", "No Reason", "7th Sevens", "Figures", "Fog Tropes", "Child Song", "Flite",
]
# Per track: what TIDAL lets this app play. Default PREVIEW (a single audio file).
FULL_TRACKS = {"t2"}      # the whole song as a single file
PHONE_TRACKS = {"t3"}     # a protected stream only: nothing a page can play without a DRM player


def track(i):
    album = "b%d" % (i // 3 % 5 + 1)
    return {"id": "t%d" % (i + 1), "title": TITLES[i % len(TITLES)], "album": album, "artist": ALBUMS[album][1],
            "seconds": 150 + (i * 37) % 200, "explicit": i % 7 == 6}


TRACKS = [track(i) for i in range(45)]
PLAYLISTS = [("p-uuid-1", "Morning walk", 12), ("p-uuid-2", "Deep focus for long edits and renders", 34), ("p-uuid-3", "Sunday", 1)]


def cover(seed, size=320):
    """A flat two-tone cover with a soft disc: a stand-in for album art, different per id."""
    hue = sum(seed.encode()) * 47 % 360
    img = Image.new("HSV", (size, size), (int(hue / 360 * 255), 150, 150))
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, size // 2, size, size), fill=(int(((hue + 40) % 360) / 360 * 255), 170, 95))
    draw.ellipse((size * .28, size * .22, size * .72, size * .66), fill=(int(((hue + 180) % 360) / 360 * 255), 60, 235))
    out = io.BytesIO()
    img.convert("RGB").save(out, "PNG")
    return out.getvalue()


def tone(seconds=30):
    """A quiet 30-second tone as a WAV file: enough for a browser to play and report progress."""
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"".join(struct.pack("<h", int(1200 * math.sin(n * 2 * math.pi * 330 / 8000))) for n in range(8000 * seconds)))
    return out.getvalue()


def artwork(aid):
    return {"id": aid, "type": "artworks", "attributes": {"mediaType": "IMAGE", "files": [
        {"href": "https://resources.tidal.com/images/%s/%d.jpg" % (aid, w), "meta": {"width": w, "height": w}} for w in (80, 160, 320, 640)]}}


def artist_res(aid, art=False):
    r = {"id": aid, "type": "artists", "attributes": {"name": ARTISTS[aid], "popularity": 0.5}}
    if art:
        r["relationships"] = {"profileArt": {"data": [{"id": "art-" + aid, "type": "artworks"}]}}
    return r


def album_res(bid, linked=False):
    title, artist = ALBUMS[bid]
    r = {"id": bid, "type": "albums", "attributes": {"title": title, "duration": "PT45M", "numberOfItems": 9, "explicit": False}}
    if linked:
        r["relationships"] = {"artists": {"data": [{"id": artist, "type": "artists"}]},
                              "coverArt": {"data": [{"id": "art-" + bid, "type": "artworks"}]}}
    return r


def track_res(t, linked=False):
    m, s = divmod(t["seconds"], 60)
    r = {"id": t["id"], "type": "tracks", "attributes": {"title": t["title"], "duration": "PT%dM%dS" % (m, s),
                                                         "explicit": t["explicit"], "isrc": "XX0000000000"}}
    if linked:
        r["relationships"] = {"artists": {"data": [{"id": t["artist"], "type": "artists"}]},
                              "albums": {"data": [{"id": t["album"], "type": "albums"}]}}
    return r


def playlist_res(p, linked=False):
    r = {"id": p[0], "type": "playlists", "attributes": {"name": p[1], "numberOfItems": p[2]}}
    if linked:
        r["relationships"] = {"coverArt": {"data": [{"id": "art-" + p[0], "type": "artworks"}]}}
    return r


class MockTidal:
    """Attach to a browser context with install(ctx). Flags change how TIDAL answers; `log` records what was asked."""

    def __init__(self, base):
        self.base = base                 # the app's own address: the only redirect the mock accepts
        self.legacy = False              # True: only the older request wording is understood
        self.client_id = CLIENT_ID       # '' leaves tidal-config.js as committed (no client ID)
        self.challenges = {}             # code -> PKCE challenge
        self.token_n = 0
        self.valid = set()               # access tokens the API accepts
        self.refresh_ok = True
        self.slow_down = 0               # answer this many API requests with 429 + Retry-After: 1
        self.fail_5xx = 0                # answer this many API requests with 503
        self.offline = False             # drop every request to TIDAL, as with no connection
        self.log = []                    # (method, host+path, query dict)
        self.logins = []                 # query of every authorize request
        self.token_posts = []            # form of every token request
        self.png = {}
        self.wav = tone()

    # -- helpers -----------------------------------------------------------------------------------
    def expire_tokens(self):
        self.valid.clear()

    def calls(self, part):
        return [c for c in self.log if part in c[1]]

    def new_tokens(self):
        self.token_n += 1
        access = "access-%d" % self.token_n
        self.valid.add(access)
        return {"access_token": access, "refresh_token": "refresh-%d" % self.token_n, "expires_in": 3600, "token_type": "Bearer"}

    def install(self, ctx):
        if self.client_id:
            ctx.route("**/tidal-config.js", lambda r: r.fulfill(content_type="text/javascript",
                      body="window.TIDAL_CLIENT_ID=%s;" % json.dumps(self.client_id)))
        ctx.route("https://login.tidal.com/**", self.login)
        ctx.route("https://auth.tidal.com/**", self.token)
        ctx.route("https://openapi.tidal.com/**", self.api)
        ctx.route("https://resources.tidal.com/**", self.image)
        # A segmented stream is not something the mock can serve: the app must fall back to the single file.
        ctx.route("https://audio.tidal.com/**", lambda r: r.fulfill(status=404, headers=CORS) if r.request.url.endswith(".m3u8")
                  else r.fulfill(content_type="audio/wav", body=self.wav, headers=CORS))
        ctx.route("https://tidal.com/**", lambda r: r.fulfill(content_type="text/html", body="<title>TIDAL</title>TIDAL web"))

    # -- sign-in ------------------------------------------------------------------------------------
    def login(self, route):
        q = {k: v[0] for k, v in parse_qs(urlparse(route.request.url).query).items()}
        self.logins.append(q)
        ok = (q.get("response_type") == "code" and q.get("client_id") == self.client_id and q.get("redirect_uri") == self.base
              and q.get("code_challenge_method") == "S256" and len(q.get("code_challenge", "")) == 43 and len(q.get("state", "")) >= 16)
        if not ok:
            return route.fulfill(status=400, body="bad authorize request")
        code = "code-%d" % len(self.logins)
        self.challenges[code] = q["code_challenge"]
        route.fulfill(status=302, headers={"location": self.base + "?" + urlencode({"code": code, "state": q["state"]})})

    def token(self, route):
        if self.offline:
            return route.abort("internetdisconnected")
        if route.request.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        form = {k: v[0] for k, v in parse_qs(route.request.post_data or "").items()}
        self.token_posts.append(form)
        if form.get("client_id") != self.client_id or "client_secret" in form:
            return route.fulfill(status=400, headers=CORS, json={"error": "invalid_client"})
        if form.get("grant_type") == "authorization_code":
            want = self.challenges.pop(form.get("code"), None)
            got = base64.urlsafe_b64encode(hashlib.sha256(form.get("code_verifier", "").encode()).digest()).rstrip(b"=").decode()
            if want != got or form.get("redirect_uri") != self.base:
                return route.fulfill(status=400, headers=CORS, json={"error": "invalid_grant"})
            return route.fulfill(headers=CORS, json=self.new_tokens())
        if form.get("grant_type") == "refresh_token":
            if not self.refresh_ok or not form.get("refresh_token", "").startswith("refresh-"):
                return route.fulfill(status=400, headers=CORS, json={"error": "invalid_grant"})
            tokens = self.new_tokens()
            del tokens["refresh_token"]  # TIDAL may keep the same refresh token: the app must keep its old one
            return route.fulfill(headers=CORS, json=tokens)
        route.fulfill(status=400, headers=CORS, json={"error": "unsupported_grant_type"})

    # -- pictures -----------------------------------------------------------------------------------
    def image(self, route):
        if self.offline:
            return route.abort("internetdisconnected")
        seed = urlparse(route.request.url).path.split("/")[-2]
        if seed not in self.png:
            self.png[seed] = cover(seed)
        route.fulfill(content_type="image/png", body=self.png[seed], headers=CORS)

    # -- the API ------------------------------------------------------------------------------------
    def api(self, route):
        req = route.request
        if self.offline:
            return route.abort("internetdisconnected")
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        url = urlparse(req.url)
        q = parse_qs(url.query)
        path = url.path[len("/v2"):]
        self.log.append((req.method, path, q))
        ctype = {**CORS, "content-type": "application/vnd.api+json"}

        def send(doc, status=200, extra=None):
            route.fulfill(status=status, headers={**ctype, **(extra or {})}, body=json.dumps(doc))

        token = (req.headers.get("authorization") or "")[len("Bearer "):]
        if token not in self.valid:
            return send({"errors": [{"code": "UNAUTHORIZED"}]}, 401)
        if self.slow_down:
            self.slow_down -= 1
            return send({"errors": [{"code": "TOO_MANY_REQUESTS"}]}, 429, {"retry-after": "1", "access-control-expose-headers": "retry-after"})
        if self.fail_5xx:
            self.fail_5xx -= 1
            return send({"errors": [{"code": "UNAVAILABLE"}]}, 503)
        if path == "/users/me":
            return send({"data": {"id": USER_ID, "type": "users", "attributes": {"country": "GB", "username": "mock"}}})
        # self.legacy: the service only understands the older wording (numeric user id, search text in the path,
        # countryCode everywhere). Otherwise it follows the API description: "me", filter[query], and no
        # parameter an endpoint does not list.
        mine = path.startswith("/userCollection")
        if self.legacy:
            if "/me/" in path or path == "/searchResults":
                return send({"errors": [{"code": "NOT_FOUND"}]}, 404)
            if not path.startswith(("/trackManifests", "/trackFiles")) and q.get("countryCode") != ["GB"]:
                return send({"errors": [{"code": "MISSING_COUNTRY"}]}, 400)
        else:
            if mine and ("countryCode" in q or (path.startswith("/userCollectionPlaylists") and "locale" in q)):
                return send({"errors": [{"code": "UNKNOWN_PARAMETER"}]}, 400)
            if not mine and not path.startswith(("/trackManifests", "/trackFiles")) and (q.get("countryCode") != ["GB"] or "locale" in q):
                return send({"errors": [{"code": "BAD_PARAMETERS"}]}, 400)
            if path.startswith("/searchResults/"):
                return send({"errors": [{"code": "NOT_FOUND"}]}, 404)
            path = path.replace("/me/relationships/items", "/%s/relationships/items" % USER_ID) if mine else path
        ids = [x for v in q.get("filter[id]", []) for x in v.split(",")]
        inc = [x for v in q.get("include", []) for x in v.split(",")]
        if len(ids) > 20:
            return send({"errors": [{"code": "TOO_MANY_IDS"}]}, 400)

        def paged(refs, included, size=20):
            cursor = int(q.get("page[cursor]", ["0"])[0])
            chunk = refs[cursor:cursor + size]
            keep = {(r["type"], r["id"]) for r in chunk}
            doc = {"data": chunk, "included": [r for r in included if (r["type"], r["id"]) in keep or r["type"] in ("artists", "artworks")],
                   "links": {"self": path}}
            if cursor + size < len(refs):
                doc["links"]["next"] = path + "?" + urlencode({"page[cursor]": cursor + size})
            send(doc)

        me = "/%s/relationships/items" % USER_ID
        if path == "/userCollectionTracks" + me:
            # Rows described, but not who made them or which album: the app must ask /tracks for that.
            return paged([{"id": t["id"], "type": "tracks"} for t in TRACKS], [track_res(t) for t in TRACKS] if "items" in inc else [])
        if path == "/userCollectionPlaylists" + me:
            # Rows named only: the app must ask /playlists for them before it can draw anything.
            return paged([{"id": p[0], "type": "playlists"} for p in PLAYLISTS], [])
        if path == "/userCollectionAlbums" + me:
            # Everything in one answer: no further request is needed.
            inc_all = [album_res(b, True) for b in ALBUMS] + [artist_res(a) for a in ARTISTS] + [artwork("art-" + b) for b in ALBUMS]
            return paged([{"id": b, "type": "albums"} for b in ALBUMS], inc_all)
        if path == "/userCollectionArtists" + me:
            return paged([{"id": a, "type": "artists"} for a in ARTISTS], [artist_res(a) for a in ARTISTS])
        if path.startswith("/playlists/") and path.endswith("/relationships/items"):
            n = dict((p[0], p[2]) for p in PLAYLISTS).get(path.split("/")[2])
            if n is None:
                return send({"errors": [{"code": "NOT_FOUND"}]}, 404)
            return paged([{"id": t["id"], "type": "tracks"} for t in TRACKS[:n]], [track_res(t) for t in TRACKS[:n]])
        if path.startswith("/albums/") and path.endswith("/relationships/items"):
            mine = [t for t in TRACKS if t["album"] == path.split("/")[2]]
            return paged([{"id": t["id"], "type": "tracks"} for t in mine], [track_res(t) for t in mine])
        if path.startswith("/artists/") and path.endswith("/relationships/albums"):
            mine = [b for b in ALBUMS if ALBUMS[b][1] == path.split("/")[2]]
            return paged([{"id": b, "type": "albums"} for b in mine], [album_res(b) for b in mine])
        if path == "/searchResults":
            word = (q.get("filter[query]") or [""])[0].lower()
            if not word:
                return send({"errors": [{"code": "MISSING_QUERY"}]}, 400)
            hits = [track_res(t) for t in TRACKS if word in t["title"].lower()] + [album_res(b) for b in ALBUMS if word in ALBUMS[b][0].lower()] \
                + [artist_res(a) for a in ARTISTS if word in ARTISTS[a].lower()]
            return send({"data": [{"id": "opaque-1", "type": "searchResults",
                                   "relationships": {"topHits": {"data": [{"id": r["id"], "type": r["type"]} for r in hits]}}}],
                         "included": hits if "topHits" in inc else []})
        if path.startswith("/searchResults/") and path.endswith("/relationships/topHits"):
            word = path.split("/")[2].lower()
            from urllib.parse import unquote
            word = unquote(word)
            hits = [track_res(t) for t in TRACKS if word in t["title"].lower()] + [album_res(b) for b in ALBUMS if word in ALBUMS[b][0].lower()] \
                + [artist_res(a) for a in ARTISTS if word in ARTISTS[a].lower()]
            return paged([{"id": r["id"], "type": r["type"]} for r in hits], hits)
        if path == "/tracks":
            found = [t for t in TRACKS if t["id"] in ids]
            return send({"data": [track_res(t, True) for t in found],
                         "included": [artist_res(a) for a in {t["artist"] for t in found}] + [album_res(b) for b in {t["album"] for t in found}]})
        if path == "/albums":
            found = [b for b in ALBUMS if b in ids]
            return send({"data": [album_res(b, True) for b in found],
                         "included": [artist_res(ALBUMS[b][1]) for b in found] + [artwork("art-" + b) for b in found]})
        if path == "/artists":
            found = [a for a in ARTISTS if a in ids]
            return send({"data": [artist_res(a, True) for a in found], "included": [artwork("art-" + a) for a in found]})
        if path == "/playlists":
            found = [p for p in PLAYLISTS if p[0] in ids]
            return send({"data": [playlist_res(p, True) for p in found], "included": [artwork("art-" + p[0]) for p in found]})
        if path.startswith("/trackManifests/"):
            tid = path.split("/")[2]
            need = ("manifestType", "formats", "uriScheme", "usage", "adaptive")
            if any(k not in q for k in need):
                return send({"errors": [{"code": "MISSING_PARAMETER"}]}, 400)
            attrs = {"trackPresentation": "FULL" if tid in FULL_TRACKS | PHONE_TRACKS else "PREVIEW", "formats": ["HEAACV1"],
                     "uri": "https://audio.tidal.com/stream/%s/main.m3u8" % tid, "hash": "x"}
            if tid in PHONE_TRACKS:
                attrs["drmData"] = {"drmSystem": "WIDEVINE", "licenseUrl": "https://audio.tidal.com/license", "certificateUrl": "https://audio.tidal.com/cert"}
            else:
                attrs["previewReason"] = None if tid in FULL_TRACKS else "FULL_REQUIRES_SUBSCRIPTION"
            return send({"data": {"id": tid, "type": "trackManifests", "attributes": attrs}})
        if path.startswith("/trackFiles/"):
            tid = path.split("/")[2]
            if tid in PHONE_TRACKS:
                return send({"errors": [{"code": "NOT_FOUND"}]}, 404)
            return send({"data": {"id": tid, "type": "trackFiles", "attributes": {
                "format": "HEAACV1", "trackPresentation": "FULL" if tid in FULL_TRACKS else "PREVIEW",
                "url": "https://audio.tidal.com/%s/%s.wav" % ("full" if tid in FULL_TRACKS else "preview", tid)}}})
        send({"errors": [{"code": "NOT_FOUND", "detail": path}]}, 404)


def sign_in(page, base):
    """From the signed-out first screen to the Library, through the mocked TIDAL sign-in."""
    page.goto(base)
    page.locator("#signIn").wait_for()
    page.keyboard.press("Enter")
    page.locator("#items button").first.wait_for()
    time.sleep(0.05)
