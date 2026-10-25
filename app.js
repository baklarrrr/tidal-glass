'use strict';

// Tidal Glass web app. Talks to the Tidal Glass phone app through two private ntfy.sh topics.
// Everything sent either way is AES-GCM encrypted with the key in this page's URL fragment.

const SERVER = 'https://ntfy.sh';
const $ = (id) => document.getElementById(id);

let topic = null;
let key = null;
let state = null;
let lastHeard = 0;
let waitingSince = 0;
let listMode = null; // null | 'queue' | 'lib'
let libStack = [];
let libCurrent = null;

// ---- pairing and crypto ------------------------------------------------------------------

function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readPairing() {
  const p = new URLSearchParams(location.hash.slice(1));
  let t = p.get('t');
  let k = p.get('k');
  try {
    if (t && k) localStorage.setItem('tg.pair', JSON.stringify({ t, k }));
    else {
      const saved = JSON.parse(localStorage.getItem('tg.pair') || 'null');
      if (saved) ({ t, k } = saved);
    }
  } catch (e) { /* storage can be unavailable; the fragment still works */ }
  return t && k ? { t, k } : null;
}

async function openMessage(text) {
  const buf = fromB64url(text.trim());
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return toB64url(out);
}

async function send(c, extra = {}) {
  try {
    const body = await seal({ c, ts: Date.now(), ...extra });
    const r = await fetch(`${SERVER}/${topic}-c`, { method: 'POST', body });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (c !== 'hello') waitingSince = Date.now();
  } catch (e) {
    $('status').textContent = 'Could not reach the relay. Check the phone has internet.';
  }
}

// ---- receiving ---------------------------------------------------------------------------

async function handle(text) {
  let m;
  try { m = await openMessage(text); } catch (e) { return; }
  lastHeard = Date.now();
  waitingSince = 0;
  if (m.t === 'state') {
    state = m;
    renderNow();
    if (listMode === 'queue') renderQueue();
  } else if (m.t === 'lib' && listMode === 'lib') {
    renderLibrary(m);
  }
}

async function connect() {
  try {
    const r = await fetch(`${SERVER}/${topic}-s/json?poll=1&since=latest`);
    for (const line of (await r.text()).split('\n')) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.event === 'message') await handle(ev.message);
    }
  } catch (e) { /* the live stream below still connects */ }

  if (typeof EventSource === 'undefined') { poll(); return; }
  const es = new EventSource(`${SERVER}/${topic}-s/sse`);
  let failures = 0;
  const onEvent = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.event === 'message' && ev.message) handle(ev.message);
    } catch (err) { /* keepalive or unrelated */ }
  };
  es.addEventListener('message', onEvent);
  es.addEventListener('open', () => { failures = 0; send('hello'); });
  es.onerror = () => {
    if (!state) $('status').textContent = 'Reconnecting…';
    // If the live stream keeps failing on this device, fall back to asking every few seconds.
    if (++failures >= 4) { es.close(); poll(); }
  };
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  let since = Math.floor(Date.now() / 1000) - 5;
  send('hello');
  for (;;) {
    try {
      const r = await fetch(`${SERVER}/${topic}-s/json?poll=1&since=${since}`);
      for (const line of (await r.text()).split('\n')) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.event === 'message') { since = ev.id; await handle(ev.message); }
      }
    } catch (e) { /* try again next round */ }
    await new Promise((res) => setTimeout(res, 2500));
  }
}

// ---- rendering ---------------------------------------------------------------------------

function clock(ms) {
  if (!ms || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function position() {
  if (!state || !state.dur) return 0;
  const p = state.pos + (state.play ? Date.now() - state.at : 0);
  return Math.max(0, Math.min(p, state.dur));
}

function statusText() {
  if (!state) return lastHeard ? 'Waiting for your phone…' : 'Connecting to your phone…';
  if (waitingSince && Date.now() - waitingSince > 7000) return 'Your phone has not answered. Is Tidal Glass running?';
  if (!state.acc) return 'Tidal Glass on your phone needs notification access';
  if (!state.ses || !state.ti) return `Tidal is idle · Vol ${state.vol || '?'}`;
  return `${state.buf ? 'Buffering' : state.play ? 'Playing' : 'Paused'} · Vol ${state.vol || '?'}`;
}

function renderNow() {
  const s = state;
  $('status').textContent = statusText();
  const hasTrack = s && s.acc && s.ses && s.ti;
  $('title').textContent = hasTrack ? s.ti : (s && !s.acc ? 'Needs access' : 'Nothing playing');
  $('artist').textContent = hasTrack ? (s.ar || '') : 'Start a song in Tidal on your phone, or press play.';
  $('album').textContent = hasTrack ? (s.al || '') : '';

  const art = $('art');
  if (hasTrack && s.art) { if (art.src !== s.art) art.src = s.art; art.hidden = false; } else { art.hidden = true; }

  const playing = !!(s && s.play);
  $('playIcon').hidden = playing;
  $('pauseIcon').hidden = !playing;
  $('toggle').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('like').setAttribute('aria-pressed', s && s.liked ? 'true' : 'false');
  $('like').setAttribute('aria-label', s && s.liked ? 'Unlike' : 'Like');
  tick();
}

function tick() {
  if (!state || !state.dur) {
    $('bar').style.inlineSize = '0';
    $('elapsed').textContent = '';
    $('total').textContent = '';
    return;
  }
  const p = position();
  $('bar').style.inlineSize = `${(100 * p) / state.dur}%`;
  $('elapsed').textContent = clock(p);
  $('total').textContent = clock(state.dur);
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4h10v4h-8v9a3 3 0 1 1-2-2.8z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6z"/></svg>',
};

function itemButton(title, sub, icon, onPress, current) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.innerHTML = `${icon}<span><span class="ti"></span><span class="su"></span></span>`;
  b.querySelector('.ti').textContent = title || 'Untitled';
  b.querySelector('.su').textContent = sub || '';
  if (current) b.classList.add('current');
  b.addEventListener('click', onPress);
  li.appendChild(b);
  return li;
}

function showList(mode, title) {
  if (!listMode) history.pushState({ screen: 'list' }, '');
  listMode = mode;
  $('now').hidden = true;
  $('list').hidden = false;
  $('listTitle').textContent = title;
}

function showNow() {
  listMode = null;
  libStack = [];
  libCurrent = null;
  $('list').hidden = true;
  $('now').hidden = false;
  $('toggle').focus();
}

function renderQueue() {
  const items = $('items');
  items.textContent = '';
  const q = (state && state.q) || [];
  $('listNote').textContent = q.length ? '' : 'Tidal has not shared a queue for this song.';
  $('more').hidden = true;
  q.forEach((e) => items.appendChild(itemButton(e.ti, e.su, e.id === state.qa ? ICONS.note : ICONS.play, () => {
    send('skip', { id: e.id });
    history.back();
  }, e.id === state.qa)));
  (items.querySelector('button') || $('back')).focus();
}

function openLibrary(id, title, page) {
  libCurrent = { id, title, page };
  showList('lib', title);
  $('items').textContent = '';
  $('more').hidden = true;
  $('listNote').textContent = 'Loading…';
  $('back').focus();
  send('lib', { id, title, page });
}

function renderLibrary(m) {
  if (!libCurrent || m.id !== libCurrent.id || m.page !== libCurrent.page) return;
  const items = $('items');
  items.textContent = '';
  $('listNote').textContent = m.err ? m.err : (m.items.length ? '' : 'Empty');
  m.items.forEach((it) => items.appendChild(itemButton(it.ti, it.su, it.b ? ICONS.folder : ICONS.play, () => {
    if (it.b) {
      libStack.push(libCurrent);
      openLibrary(it.id, it.ti, 0);
    } else if (it.p) {
      send('libplay', { id: it.id });
      history.back();
    }
  })));
  $('more').hidden = !m.more;
  (items.querySelector('button') || $('back')).focus();
}

function goBack() {
  if (listMode === 'lib' && libStack.length) {
    const prev = libStack.pop();
    openLibrary(prev.id, prev.title, prev.page);
  } else {
    history.back();
  }
}

// ---- wiring ------------------------------------------------------------------------------

function wire() {
  $('toggle').addEventListener('click', () => send('toggle'));
  $('prev').addEventListener('click', () => send('prev'));
  $('next').addEventListener('click', () => send('next'));
  $('like').addEventListener('click', () => send('like'));
  $('voldown').addEventListener('click', () => send('volDown'));
  $('volup').addEventListener('click', () => send('volUp'));
  $('queue').addEventListener('click', () => { showList('queue', 'Up next'); renderQueue(); });
  $('library').addEventListener('click', () => { libStack = []; openLibrary(null, 'Library', 0); });
  $('back').addEventListener('click', goBack);
  $('more').addEventListener('click', () => {
    if (libCurrent) openLibrary(libCurrent.id, libCurrent.title, libCurrent.page + 1);
  });
  window.addEventListener('popstate', () => { if (listMode) showNow(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && listMode) { e.preventDefault(); goBack(); }
  });
  setInterval(() => { tick(); $('status').textContent = statusText(); }, 1000);
}

async function main() {
  const pair = readPairing();
  if (!pair || !crypto.subtle) {
    $('now').hidden = true;
    $('setup').hidden = false;
    return;
  }
  topic = pair.t;
  key = await crypto.subtle.importKey('raw', fromB64url(pair.k), 'AES-GCM', false, ['encrypt', 'decrypt']);
  wire();
  $('toggle').focus();
  connect();
}

main();
