'use strict';

// TIDAL's official API for TIDAL Glass: sign-in, a careful fetch layer, and the library as plain rows.
// Nothing here touches the page; tidal-library.js draws what this returns.
//
// Hosts used, all TIDAL's own: login.tidal.com (sign-in page), auth.tidal.com (tokens),
// openapi.tidal.com (the catalogue and the user's collection, JSON:API), plus whatever artwork and
// audio addresses those answers contain. No client secret exists in a browser app: sign-in is
// "authorization code + PKCE". Tokens stay in this browser's storage, are never logged and never put
// in an address.

const TidalAPI = (() => {
  const API = 'https://openapi.tidal.com/v2';
  const AUTHORIZE = 'https://login.tidal.com/authorize';
  const TOKEN = 'https://auth.tidal.com/v1/oauth2/token';
  const DEFAULT_SCOPES = 'user.read collection.read playlists.read search.read playback';

  const AUTH_KEY = 'tg.tidal.auth.v1';     // localStorage: { a, r, exp, uid, cc }
  const PKCE_KEY = 'tg.tidal.pkce.v1';     // sessionStorage: { state, verifier, at }
  const PKCE_MAX_AGE = 15 * 60 * 1000;
  const TIMEOUT_MS = 12000;
  const RETRIES = 3;                       // tries after the first, for a dropped connection or a 5xx
  const BACKOFF_MS = 400;                  // 400, 800, 1600 ms (plus a little jitter)
  const MAX_INLINE_WAIT = 20000;           // a longer Retry-After is handed to the screen to wait out
  const CHUNK = 20;                        // ids per filter[id] request

  // ---- storage and JSON, wrapped: a full or switched-off store never throws into the page -------

  function store(kind) {
    try { return kind === 'session' ? window.sessionStorage : window.localStorage; } catch (e) { return null; }
  }
  function read(kind, key) {
    try { const v = store(kind).getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function write(kind, key, value) {
    try { store(kind).setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }
  function drop(kind, key) {
    try { store(kind).removeItem(key); } catch (e) { /* nothing kept */ }
  }

  // kind: 'offline' (no connection), 'auth' (sign in again), 'busy' (TIDAL said slow down),
  // 'server' (TIDAL failed), 'missing' (not there, or not allowed), 'setup' (no client ID).
  class TidalError extends Error {
    constructor(kind, extra = {}) {
      super(kind);
      this.name = 'TidalError';
      this.kind = kind;
      Object.assign(this, extra);
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---- configuration ---------------------------------------------------------------------------

  function clientId() {
    const id = typeof window.TIDAL_CLIENT_ID === 'string' ? window.TIDAL_CLIENT_ID.trim() : '';
    return /^[A-Za-z0-9._~-]{4,128}$/.test(id) ? id : '';
  }
  function scopes() {
    const s = typeof window.TIDAL_SCOPES === 'string' ? window.TIDAL_SCOPES.trim() : '';
    return s || DEFAULT_SCOPES;
  }
  function configured() { return !!clientId(); }

  // The address TIDAL sends the browser back to: this app's own folder, nothing after it.
  function redirectUri() {
    const here = new URL(location.href);
    return here.origin + here.pathname.replace(/[^/]*$/, '');
  }

  // ---- sign-in: authorization code + PKCE --------------------------------------------------------

  function b64url(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomToken(n) {
    return b64url(crypto.getRandomValues(new Uint8Array(n)));
  }

  function canSignIn() {
    return configured() && !!(window.crypto && crypto.subtle && crypto.getRandomValues) && !!store('session');
  }

  // Leaves the app for TIDAL's sign-in page. Resolves false when this browser cannot do it.
  async function beginLogin() {
    if (!canSignIn()) return false;
    const verifier = randomToken(48);
    const state = randomToken(18);
    let challenge;
    try {
      challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    } catch (e) { return false; }
    if (!write('session', PKCE_KEY, { state, verifier, at: Date.now() })) return false;
    const url = new URL(AUTHORIZE);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId(),
      redirect_uri: redirectUri(),
      scope: scopes(),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
    }).toString();
    // replace(): the sign-in page takes this entry's place, so Back never lands on a half-used page.
    location.replace(url.href);
    return true;
  }

  // Sign-in finished on a phone (see tidal-handoff.js). The verifier is made here and stays in this
  // page's memory; only its challenge and the state are handed out.
  let offered = null; // { state, verifier, at }

  async function offerLogin() {
    if (!configured() || !(window.crypto && crypto.subtle && crypto.getRandomValues)) return null;
    const verifier = randomToken(48);
    const state = randomToken(18);
    let challenge;
    try {
      challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    } catch (e) { return null; }
    offered = { state, verifier, at: Date.now() };
    return { t: 'offer', ch: challenge, st: state, ru: redirectUri(), sc: scopes() };
  }

  // TIDAL's one-time answer, brought over from the phone. Resolves 'ok', 'failed' or 'stale'.
  async function redeemOffer(code, state) {
    const mine = offered;
    if (!mine || mine.state !== state || Date.now() - mine.at > PKCE_MAX_AGE) return 'stale';
    if (typeof code !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(code)) return 'failed';
    offered = null; // an answer is used once
    return exchange(code, mine.verifier);
  }

  async function exchange(code, verifier) {
    try {
      const res = await timedFetch(TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId(),
          code,
          redirect_uri: redirectUri(),
          code_verifier: verifier,
        }).toString(),
      });
      if (!res.ok) return 'failed';
      return saveTokens(await res.json(), null) ? 'ok' : 'failed';
    } catch (e) { return 'failed'; }
  }

  function hasLoginAnswer() {
    const q = new URLSearchParams(location.search);
    return q.has('code') || q.has('error');
  }

  // Called on every load. If the address carries TIDAL's answer, it is taken out of the address at
  // once (before anything else can read, cache or share it) and exchanged for tokens.
  // Resolves 'none', 'ok', 'denied' or 'failed'.
  async function finishLogin() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return 'none';
    const code = q.get('code');
    const state = q.get('state');
    const denied = q.has('error');
    for (const k of ['code', 'state', 'error', 'error_description', 'error_uri']) q.delete(k);
    const rest = q.toString();
    try { history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '')); } catch (e) { /* stays as it is */ }
    const pkce = read('session', PKCE_KEY);
    drop('session', PKCE_KEY);
    if (denied) return 'denied';
    if (!configured() || !code || !pkce || !pkce.verifier || pkce.state !== state
        || Date.now() - (pkce.at || 0) > PKCE_MAX_AGE) return 'failed';
    return exchange(code, pkce.verifier);
  }

  function saveTokens(t, previous) {
    if (!t || typeof t.access_token !== 'string' || !t.access_token) return false;
    const life = Number.isFinite(t.expires_in) && t.expires_in > 0 ? t.expires_in : 3600;
    const next = {
      a: t.access_token,
      r: typeof t.refresh_token === 'string' && t.refresh_token ? t.refresh_token : (previous && previous.r) || '',
      exp: Date.now() + life * 1000,
      uid: (previous && previous.uid) || (t.user_id != null ? String(t.user_id) : (t.user && t.user.userId != null ? String(t.user.userId) : '')),
      cc: (previous && previous.cc) || (t.user && typeof t.user.countryCode === 'string' ? t.user.countryCode : ''),
    };
    auth = next;
    return write('local', AUTH_KEY, next) || true; // without storage the sign-in still lasts this visit
  }

  let auth = null;       // the record in use; re-read from storage when empty
  let refreshing = null; // one refresh at a time, shared by every waiting request
  let onAuthLost = null;

  function tokens() {
    if (!auth) {
      const saved = read('local', AUTH_KEY);
      if (saved && typeof saved.a === 'string' && saved.a) auth = saved;
    }
    return auth;
  }
  function signedIn() { return configured() && !!tokens(); }

  function forget() {
    auth = null;
    me = null;
    drop('local', AUTH_KEY);
    cache.clear();
  }

  function signOut() { forget(); }

  // The sign-in cannot be renewed: forget it and tell the screen once.
  function loseAuth() {
    const had = !!tokens();
    forget();
    if (had && onAuthLost) { try { onAuthLost(); } catch (e) { /* the screen's own business */ } }
    return new TidalError('auth');
  }

  // Renewing the sign-in. The sign-in is given up ONLY when TIDAL itself says the grant is over
  // (the error names in its sign-in rules). A dropped connection, a slow answer, a 5xx or an answer
  // that makes no sense keeps the sign-in and is tried again: up to five more times here, and then
  // again on the next request, for as long as it takes.
  const GRANT_OVER = { 400: ['invalid_grant', 'unauthorized_client', 'invalid_request'], 401: ['invalid_client', 'access_denied'] };
  const REFRESH_TRIES = 5;

  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      let lastKind = 'offline';
      for (let attempt = 0; attempt <= REFRESH_TRIES; attempt++) {
        if (attempt) await sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
        const t = tokens();
        if (!t || !t.r) throw loseAuth();
        let res;
        try {
          res = await timedFetch(TOKEN, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.r, client_id: clientId() }).toString(),
          });
        } catch (e) {
          lastKind = 'offline';
          if (navigator.onLine === false) break; // no network at all: waiting here helps nobody
          continue;
        }
        let body = null;
        try { body = await res.json(); } catch (e) { /* judged below */ }
        if (res.ok) {
          if (saveTokens(body, t)) return;
          lastKind = 'server';
          continue;
        }
        const named = body && typeof body.error === 'string' ? body.error : '';
        if ((GRANT_OVER[res.status] || []).includes(named)) {
          // Another open page of this app may have renewed first and been given a new refresh token.
          auth = null;
          const now = tokens();
          if (now && now.r && now.r !== t.r) { if (now.exp - Date.now() > 60000) return; continue; }
          auth = t;
          throw loseAuth();
        }
        lastKind = res.status === 429 ? 'busy' : 'server';
      }
      throw new TidalError(lastKind); // the sign-in is kept
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function accessToken() {
    const t = tokens();
    if (!t) throw new TidalError(configured() ? 'auth' : 'setup');
    if (t.r && t.exp - Date.now() < 60000) await refresh();
    return tokens().a;
  }

  // ---- the fetch layer ----------------------------------------------------------------------------

  async function timedFetch(url, init = {}) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: stop.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    } finally { clearTimeout(timer); }
  }

  function backoff(n) {
    return BACKOFF_MS * 2 ** (n - 1) + Math.floor(Math.random() * 150);
  }

  // Retry-After is seconds or a date. Missing or unreadable: two seconds.
  function retryAfterMs(res) {
    const h = res.headers.get('retry-after');
    if (!h) return 2000;
    const secs = Number(h);
    if (Number.isFinite(secs)) return Math.max(500, secs * 1000);
    const at = Date.parse(h);
    return Number.isFinite(at) ? Math.max(500, at - Date.now()) : 2000;
  }

  function buildUrl(path, params) {
    // "next" links come back as a path with its own query; some include /v2, some do not.
    const url = /^https:\/\/openapi\.tidal\.com\//.test(path) ? new URL(path)
      : new URL(API + (path.startsWith('/v2/') ? path.slice(3) : path));
    if (url.origin !== 'https://openapi.tidal.com') throw new TidalError('server');
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null || v === '') continue;
      if (Array.isArray(v)) { url.searchParams.delete(k); for (const x of v) url.searchParams.append(k, x); }
      else if (!url.searchParams.has(k)) url.searchParams.set(k, v);
    }
    return url.href;
  }

  // GET one JSON:API document. Retries a dropped connection and a 5xx with backoff, waits out a 429
  // as TIDAL asks, and renews the sign-in once on a 401.
  async function get(path, params) {
    const url = buildUrl(path, params);
    let tries = 0;
    let slowdowns = 0;
    let renewed = false;
    for (;;) {
      const token = await accessToken();
      let res;
      try {
        res = await timedFetch(url, { headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.api+json' } });
      } catch (e) {
        if (navigator.onLine === false || ++tries > RETRIES) throw new TidalError('offline');
        await sleep(backoff(tries));
        continue;
      }
      if (res.status === 401) {
        // Renewed a moment ago and still refused: that is about this one request, not the sign-in.
        if (renewed) throw new TidalError('missing', { status: 401 });
        renewed = true;
        await refresh();
        continue;
      }
      if (res.status === 429) {
        const wait = retryAfterMs(res);
        if (++slowdowns > 2 || wait > MAX_INLINE_WAIT) throw new TidalError('busy', { retryAfter: wait });
        await sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        if (++tries > RETRIES) throw new TidalError('server', { status: res.status });
        await sleep(backoff(tries));
        continue;
      }
      if (res.status === 403 || res.status === 404) throw new TidalError('missing', { status: res.status });
      if (!res.ok) throw new TidalError('server', { status: res.status });
      try { return await res.json(); } catch (e) { throw new TidalError('server'); }
    }
  }

  // ---- who is signed in -------------------------------------------------------------------------------

  let me = null; // { id, cc }

  async function whoAmI() {
    if (me) return me;
    const t = tokens();
    if (t && t.uid && t.cc) { me = { id: t.uid, cc: t.cc }; return me; }
    const doc = await get('/users/me');
    const d = (doc && doc.data) || {};
    const a = d.attributes || {};
    const cc = /^[A-Za-z]{2}$/.test(a.country || '') ? a.country.toUpperCase() : guessCountry();
    me = { id: String(d.id || (t && t.uid) || ''), cc };
    if (!me.id) { me = null; throw new TidalError('server'); }
    const now = tokens();
    if (now) { now.uid = me.id; now.cc = me.cc; write('local', AUTH_KEY, now); }
    return me;
  }

  function guessCountry() {
    const m = /[-_]([A-Za-z]{2})\b/.exec(navigator.language || '');
    return m ? m[1].toUpperCase() : 'US';
  }

  async function common() {
    const who = await whoAmI();
    return { countryCode: who.cc, locale: navigator.language || 'en-US' };
  }

  // ---- JSON:API documents into one small store ----------------------------------------------------------
  // Every resource seen this visit, by "type:id", so a later answer can fill in what an earlier one
  // left out (artist names, cover art) without asking for the list again.

  const cache = new Map();

  function absorb(doc) {
    if (!doc) return;
    const all = [].concat(doc.data || [], doc.included || []);
    for (const r of all) {
      if (!r || !r.type || r.id == null) continue;
      const k = r.type + ':' + r.id;
      const old = cache.get(k) || { type: r.type, id: String(r.id), attributes: null, rel: {} };
      if (r.attributes) old.attributes = { ...(old.attributes || {}), ...r.attributes };
      for (const [name, value] of Object.entries(r.relationships || {})) {
        if (value && Array.isArray(value.data)) old.rel[name] = value.data.map((x) => x.type + ':' + x.id);
        else if (value && value.data && value.data.id != null) old.rel[name] = [value.data.type + ':' + value.data.id];
      }
      cache.set(k, old);
    }
  }

  function related(res, name) {
    return ((res && res.rel[name]) || []).map((k) => cache.get(k)).filter(Boolean);
  }

  function durationMs(iso) {
    const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso || '');
    if (!m) return Number.isFinite(iso) ? iso * 1000 : 0;
    return Math.round(((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 1000);
  }

  // The smallest picture at least `want` wide, else the largest there is. https only.
  function artUrl(artwork, want) {
    const files = ((artwork && artwork.attributes && artwork.attributes.files) || [])
      .filter((f) => f && typeof f.href === 'string' && /^https:\/\//.test(f.href))
      .map((f) => ({ href: f.href, w: (f.meta && f.meta.width) || 0 }))
      .sort((a, b) => a.w - b.w);
    if (!files.length) return '';
    return (files.find((f) => f.w >= want) || files[files.length - 1]).href;
  }

  const NAMES = (list) => list.map((r) => r.attributes && r.attributes.name).filter(Boolean).join(', ');
  const WEB = { tracks: 'track', albums: 'album', artists: 'artist', playlists: 'playlist' };

  // One row for the screen. Plain text and addresses only.
  function rowOf(key) {
    const res = cache.get(key);
    if (!res || !WEB[res.type]) return null;
    const a = res.attributes || {};
    const row = { id: res.id, type: res.type, ti: '', su: '', al: '', dur: 0, ex: false, art: '', artL: '',
      link: 'https://tidal.com/' + WEB[res.type] + '/' + encodeURIComponent(res.id) };
    if (res.type === 'tracks') {
      const album = related(res, 'albums')[0];
      row.ti = (a.title || '') + (a.version ? ' (' + a.version + ')' : '');
      row.su = NAMES(related(res, 'artists'));
      row.al = (album && album.attributes && album.attributes.title) || '';
      row.dur = durationMs(a.duration);
      row.ex = !!a.explicit;
      const cover = related(album, 'coverArt')[0];
      row.art = artUrl(cover, 160);
      row.artL = artUrl(cover, 640);
    } else if (res.type === 'albums') {
      row.ti = (a.title || '') + (a.version ? ' (' + a.version + ')' : '');
      row.su = NAMES(related(res, 'artists')) || 'Album';
      row.ex = !!a.explicit;
      row.art = artUrl(related(res, 'coverArt')[0], 160);
    } else if (res.type === 'artists') {
      row.ti = a.name || '';
      row.su = 'Artist';
      row.art = artUrl(related(res, 'profileArt')[0], 160);
    } else {
      row.ti = a.name || '';
      row.su = Number.isFinite(a.numberOfItems) ? a.numberOfItems + (a.numberOfItems === 1 ? ' track' : ' tracks') : 'Playlist';
      row.art = artUrl(related(res, 'coverArt')[0], 160);
    }
    return row;
  }

  // What a row of each type needs beside its own fields, asked for by name.
  const WANTS = { tracks: ['artists', 'albums'], albums: ['artists', 'coverArt'], artists: ['profileArt'], playlists: ['coverArt'] };

  function lacking(key) {
    const res = cache.get(key);
    return !res || !res.attributes || WANTS[res.type].some((name) => !res.rel[name]);
  }

  // Fetch the resources of one type that are still incomplete, twenty at a time.
  async function fill(type, keys) {
    const ids = [...new Set(keys.filter((k) => k.startsWith(type + ':') && lacking(k)).map((k) => k.slice(type.length + 1)))];
    const base = await common();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const doc = await get('/' + type, { countryCode: base.countryCode, 'filter[id]': ids.slice(i, i + CHUNK), include: WANTS[type] });
      absorb(doc);
      // A resource TIDAL answered without a relationship has none: do not ask again.
      for (const id of ids.slice(i, i + CHUNK)) {
        const res = cache.get(type + ':' + id);
        if (res) for (const name of WANTS[type]) if (!res.rel[name]) res.rel[name] = [];
      }
    }
  }

  // ---- the library ------------------------------------------------------------------------------------------

  // Where each list lives. `rel` is the relationship that holds its rows. Each list has one or two
  // ways of asking, tried in order: first exactly as TIDAL's API description (OpenAPI 1.10) words it,
  // then the older wording. The way that answered is remembered for the rest of the visit, so a
  // difference between the description and the live service costs one extra request, not a dead menu.
  //   send: which of the common parameters this request carries ('cc' countryCode, 'locale').
  //   shape 'search': the answer is the search result itself, its rows under relationships.topHits.
  async function sources(listKey) {
    const who = await whoAmI();
    const [kind, ...rest] = listKey.split(':');
    const raw = rest.join(':');
    const id = encodeURIComponent(raw);
    const mine = (name, send) => [
      { path: `/${name}/me/relationships/items`, rel: 'items', send },
      { path: `/${name}/${encodeURIComponent(who.id)}/relationships/items`, rel: 'items', send: ['cc', 'locale'] },
    ];
    switch (kind) {
      case 'tracks': return mine('userCollectionTracks', ['locale']);
      case 'albums': return mine('userCollectionAlbums', ['locale']);
      case 'artists': return mine('userCollectionArtists', ['locale']);
      case 'playlists': return mine('userCollectionPlaylists', []);
      case 'playlist': return [{ path: `/playlists/${id}/relationships/items`, rel: 'items', send: ['cc'] }];
      case 'album': return [{ path: `/albums/${id}/relationships/items`, rel: 'items', send: ['cc'] }];
      case 'artist': return [{ path: `/artists/${id}/relationships/albums`, rel: 'albums', send: ['cc'] }];
      case 'search': return [
        { path: '/searchResults', rel: 'topHits', send: ['cc'], shape: 'search', extra: { 'filter[query]': raw, explicitFilter: 'INCLUDE' } },
        { path: `/searchResults/${id}/relationships/topHits`, rel: 'topHits', send: ['cc', 'locale'], extra: { explicitFilter: 'INCLUDE' } },
      ];
      default: throw new TidalError('missing');
    }
  }

  const answered = new Map(); // list kind -> index of the way of asking that worked

  function paramsFor(src, base) {
    const out = {};
    if (src.send.includes('cc')) out.countryCode = base.countryCode;
    if (src.send.includes('locale')) out.locale = base.locale;
    return { ...out, ...(src.extra || {}), include: [src.rel] };
  }

  // The row identifiers of one answer, whichever shape it came in.
  function rowsOf(doc, src) {
    if (src.shape !== 'search') return Array.isArray(doc.data) ? doc.data : [];
    const first = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    const rel = first && first.relationships && first.relationships[src.rel];
    return rel && Array.isArray(rel.data) ? rel.data : [];
  }

  // One page of a list: { keys, rows, next }. Rows have their titles; details() adds the rest.
  async function page(listKey, cursor) {
    const ways = await sources(listKey);
    const base = await common();
    const kind = listKey.split(':')[0];
    let at = Math.min(answered.get(kind) || 0, ways.length - 1);
    let doc;
    let src;
    for (;;) {
      src = ways[at];
      try {
        doc = await get(cursor || src.path, paramsFor(src, base));
        break;
      } catch (e) {
        // Refused as worded (400, 403, 404): ask the other way before giving up.
        const refused = e.kind === 'missing' || (e.kind === 'server' && e.status >= 400 && e.status < 500);
        if (cursor || at + 1 >= ways.length || !refused) throw e;
        at += 1;
      }
    }
    answered.set(kind, at);
    absorb(doc);
    const keys = rowsOf(doc, src).filter((r) => r && WEB[r.type]).map((r) => r.type + ':' + r.id);
    // An answer that named the rows without describing them: ask for them by id before drawing.
    const bare = keys.filter((k) => !cache.get(k) || !cache.get(k).attributes);
    for (const type of new Set(bare.map((k) => k.split(':')[0]))) await fill(type, bare);
    const links = (src.shape === 'search' && doc.data && !Array.isArray(doc.data) && doc.data.relationships && doc.data.relationships[src.rel] && doc.data.relationships[src.rel].links) || doc.links;
    const next = links && typeof links.next === 'string' && links.next ? links.next : '';
    return { keys, rows: keys.map(rowOf).filter((r) => r && r.ti), next };
  }

  // Artist names and cover art for rows already on screen. Returns the rows again, complete.
  async function details(keys) {
    for (const type of new Set(keys.map((k) => k.split(':')[0]))) await fill(type, keys);
    const albums = [];
    for (const k of keys) if (k.startsWith('tracks:')) albums.push(...((cache.get(k) || { rel: {} }).rel.albums || []));
    if (albums.length) await fill('albums', albums);
    return keys.map(rowOf).filter((r) => r && r.ti);
  }

  // ---- what Play can do for one track -------------------------------------------------------------------------
  // TIDAL decides, per track and per signed-in user, whether an app gets the whole song or a preview.
  // { mode: 'full' | 'preview' | 'phone', sources: [{ url, full }], presentation, why }
  //   full / preview: the sources play in a plain <audio> element, tried in order.
  //   phone: nothing this page can play. why: 'drm' (protected: needs a player library with
  //   Widevine or FairPlay), 'stream' (a segmented stream this browser cannot open by itself), '' otherwise.
  const FORMATS = ['HEAACV1', 'AACLC'];

  function nativeHls() {
    try {
      const a = document.createElement('audio');
      return !!(a.canPlayType('application/vnd.apple.mpegurl') || a.canPlayType('application/x-mpegURL'));
    } catch (e) { return false; }
  }

  async function playable(trackId) {
    const id = encodeURIComponent(trackId);
    const sources = [];
    let presentation = '';
    let protectedStream = false;
    let stream = '';
    try {
      const doc = await get('/trackManifests/' + id, { manifestType: 'HLS', formats: FORMATS, uriScheme: 'HTTPS', usage: 'PLAYBACK', adaptive: false });
      const a = (doc && doc.data && doc.data.attributes) || {};
      presentation = a.trackPresentation === 'FULL' ? 'FULL' : (a.trackPresentation === 'PREVIEW' ? 'PREVIEW' : '');
      protectedStream = !!a.drmData;
      stream = typeof a.uri === 'string' && /^https:\/\//.test(a.uri) ? a.uri : '';
    } catch (e) {
      if (e.kind !== 'missing' && e.kind !== 'server') throw e;
    }
    // A stream this browser opens by itself (Safari and newer Chrome do), when it is not protected.
    if (stream && !protectedStream && nativeHls()) sources.push({ url: stream, full: presentation === 'FULL' });
    // And a single audio file, when TIDAL hands one out.
    try {
      const doc = await get('/trackFiles/' + id, { formats: FORMATS, usage: 'PLAYBACK' });
      const a = (doc && doc.data && doc.data.attributes) || {};
      const url = typeof a.url === 'string' && /^https:\/\//.test(a.url) ? a.url : '';
      if (url) sources.push({ url, full: (a.trackPresentation || presentation) === 'FULL' });
    } catch (e) {
      if (e.kind !== 'missing' && e.kind !== 'server') throw e;
    }
    if (sources.length) return { mode: sources[0].full ? 'full' : 'preview', sources, presentation, why: '' };
    return { mode: 'phone', sources, presentation, why: protectedStream ? 'drm' : (stream ? 'stream' : '') };
  }

  return {
    configured, canSignIn, signedIn, scopes, redirectUri,
    beginLogin, hasLoginAnswer, finishLogin, signOut, offerLogin, redeemOffer,
    page, details, playable, whoAmI,
    set onAuthLost(fn) { onAuthLost = fn; },
  };
})();
