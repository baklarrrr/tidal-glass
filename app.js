'use strict';

// Tidal Glass web app for Meta Ray-Ban Display.
// Shows what the official Tidal app is playing on the paired phone and sends presses back to it.
// The phone and this page talk through two private ntfy.sh topics; every message is AES-GCM
// encrypted with the key in this page's URL fragment, which browsers never send to a server.
//
// Input model (Neural Band or touchpad):
//   swipe = move focus, pinch = press, system Back = one step back (browser history);
//   on Now Playing, Back opens the glasses' own menu and a second Back leaves the app
//   in lists: swipe left = back, swipe right = open
//   on the song bar: swipe left/right = skip 10 s, faster while you keep swiping
//   pinch and drag up/down anywhere on Now Playing = volume

const SERVER = 'https://ntfy.sh';
const HISTORY_LIMIT = 4;   // the glasses keep at most five history entries including the first page
const $ = (id) => document.getElementById(id);

let topic = null;
let key = null;
let state = null;
let prevState = null;
let lastHeard = 0;
let pendingSince = 0;
let lastHello = 0;
let stream = null;
let polling = false;
let tickTimer = 0;
let toastTimer = 0;
let lastAction = '';
const waiters = new Set();

let view = { screen: 'now' };     // what is on screen; mirrors history.state
let depth = 0;                     // how many entries this app has pushed
const libCache = new Map();        // "id|page" -> library message, so Back is instant and free

let seekPreview = null;
let seekTimer = 0;
let seekStreak = 0;
let lastSeekKey = 0;

let volPreview = null;             // volume shown while adjusting, before the phone confirms
let volTimer = 0;

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
  } catch (e) { /* storage may be unavailable; the fragment still works */ }
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
    if (c !== 'hello') pendingSince = Date.now();
    return true;
  } catch (e) {
    showToast('No connection. Check your phone has internet.');
    return false;
  }
}

// ---- connection --------------------------------------------------------------------------

async function handle(text) {
  let m;
  try { m = await openMessage(text); } catch (e) { return; }
  lastHeard = Date.now();
  pendingSince = 0;
  if (m.t === 'state') {
    prevState = state;
    state = m;
    if (volPreview != null && !volTimer) volPreview = null;
    renderNow();
    confirmAction();
    if (view.screen === 'queue') renderQueue(false);
    for (const w of waiters) w();
  } else if (m.t === 'lib') {
    libCache.set(`${m.id}|${m.page}`, { at: Date.now(), m });
    if (view.screen === 'lib' && view.id === m.id && view.page === m.page) renderLibrary(m, true);
  }
}

function sayHello() {
  if (Date.now() - lastHello < 15000) return;
  lastHello = Date.now();
  send('hello');
}

async function catchUp() {
  try {
    const r = await fetch(`${SERVER}/${topic}-s/json?poll=1&since=latest`);
    for (const line of (await r.text()).split('\n')) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.event === 'message') await handle(ev.message);
    }
  } catch (e) { /* the live stream still connects */ }
}

function openStream() {
  if (stream || polling) return;
  if (typeof EventSource === 'undefined') { poll(); return; }
  let failures = 0;
  stream = new EventSource(`${SERVER}/${topic}-s/sse`);
  stream.addEventListener('message', (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.event === 'message' && ev.message) handle(ev.message);
    } catch (err) { /* keepalive */ }
  });
  stream.addEventListener('open', () => { failures = 0; sayHello(); });
  stream.onerror = () => { if (++failures >= 4) { closeStream(); poll(); } };
}

function closeStream() {
  if (stream) { stream.close(); stream = null; }
}

async function poll() {
  if (polling) return;
  polling = true;
  let since = Math.floor(Date.now() / 1000) - 5;
  sayHello();
  while (polling) {
    if (document.visibilityState === 'visible') {
      try {
        const r = await fetch(`${SERVER}/${topic}-s/json?poll=1&since=${since}`);
        for (const line of (await r.text()).split('\n')) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.event === 'message') { since = ev.id; await handle(ev.message); }
        }
      } catch (e) { /* next round */ }
    }
    await new Promise((res) => setTimeout(res, 2500));
  }
}

// Battery: while the app is not on screen, drop the live connection and stop every timer.
function onVisibility() {
  if (document.visibilityState === 'visible') {
    catchUp().then(() => { openStream(); sayHello(); });
    startTick();
    renderNow();
  } else {
    closeStream();
    stopTick();
  }
}

// ---- small helpers -----------------------------------------------------------------------

// SVG elements have no `hidden` property (it exists only on HTML elements), so toggle the attribute.
function shown(el, on) {
  if (on) el.removeAttribute('hidden');
  else el.setAttribute('hidden', '');
}

function clock(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function volParts() {
  const v = (state && state.vol) || '';
  const [cur, max] = v.split('/').map((n) => parseInt(n, 10));
  return { cur: Number.isFinite(cur) ? cur : null, max: Number.isFinite(max) ? max : null };
}

function showToast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
}

// ---- button names: shown briefly when focus lands, so icons never need guessing -------------

// Each name says what the next press does.
const TIPS = {
  prev: () => 'Previous song',
  toggle: () => (state && state.play ? 'Pause' : 'Play'),
  next: () => 'Next song',
  like: () => (state && state.liked ? 'Remove from My Collection' : 'Add to My Collection'),
  queue: () => 'Up next',
  library: () => 'Your Tidal library',
  voldown: () => 'Volume down',
  volup: () => 'Volume up',
  seek: () => 'Swipe left or right to skip',
};
let tipFor = null;
let tipShow = 0;
let tipHide = 0;

function showTip(el) {
  const tip = $('tip');
  clearTimeout(tipShow);
  clearTimeout(tipHide);
  tipFor = el && TIPS[el.id] ? el.id : null;
  if (!tipFor) { tip.classList.remove('on'); return; }
  // A short wait keeps quick swipes from flashing every name on the way past.
  tipShow = setTimeout(() => {
    tip.textContent = TIPS[tipFor]();
    tip.classList.add('on');
    tipHide = setTimeout(() => tip.classList.remove('on'), 2200);
  }, 160);
}

function refreshTip() {
  if (tipFor && $('tip').classList.contains('on')) $('tip').textContent = TIPS[tipFor]();
}

// ---- Now Playing -------------------------------------------------------------------------

function position() {
  if (!state || !state.dur) return 0;
  if (seekPreview != null) return seekPreview;
  const p = state.pos + (state.play ? Date.now() - state.at : 0);
  return Math.max(0, Math.min(p, state.dur));
}

function hasTrack() {
  return !!(state && state.acc && state.ses && state.ti);
}

function stateLine() {
  if (!state) return lastHeard ? 'Waiting for your phone…' : 'Connecting to your phone…';
  if (pendingSince && Date.now() - pendingSince > 7000) return 'Your phone is not answering';
  if (!state.acc) return 'Phone needs notification access';
  if (!hasTrack()) return 'Tidal is idle';
  if (state.buf) return 'Buffering…';
  return state.play ? 'Playing' : 'Paused';
}

function renderNow() {
  const s = state;
  const track = hasTrack();

  $('stateText').textContent = stateLine();
  $('dot').classList.toggle('live', !!(track && s.play && !s.buf));
  $('atmos').hidden = !(track && s.atmos);
  $('explicit').hidden = !(track && s.ex);
  const { cur } = volParts();
  $('vol').hidden = cur == null;
  $('volText').textContent = volPreview != null ? String(volPreview) : (cur == null ? '' : String(cur));

  $('title').textContent = track ? s.ti : (s && !s.acc ? 'Needs access' : (s ? 'Nothing playing' : 'Tidal Glass'));
  $('artist').textContent = track ? (s.ar || '') : (s && !s.acc
    ? 'Open Tidal Glass on your phone and allow notification access.'
    : 'Start something in Tidal, or pick from your library.');
  $('album').textContent = track ? (s.al || '') : '';

  const wrap = $('artwrap');
  const art = $('art');
  wrap.classList.toggle('empty', !track);
  if (track && s.art) {
    if (art.getAttribute('src') !== s.art) {
      art.hidden = true;
      wrap.classList.remove('has-art');
      art.onload = () => { art.hidden = false; wrap.classList.add('has-art'); };
      art.onerror = () => { art.hidden = true; wrap.classList.remove('has-art'); };
      art.src = s.art;
    }
  } else {
    art.hidden = true;
    art.removeAttribute('src');
    wrap.classList.remove('has-art');
  }

  const playing = !!(s && s.play);
  shown($('playIcon'), !playing);
  shown($('pauseIcon'), playing);
  $('toggle').setAttribute('aria-label', playing ? 'Pause' : (track ? 'Play' : 'Resume Tidal'));

  const liked = !!(s && s.liked);
  $('like').setAttribute('aria-pressed', liked ? 'true' : 'false');
  $('like').setAttribute('aria-label', liked ? 'Remove from My Collection' : 'Add to My Collection');
  shown($('heartLine'), !liked);
  shown($('heartFull'), liked);

  // Hide what cannot work right now so a swipe never lands on a dead button.
  const focused = document.activeElement;
  $('like').hidden = !track;
  $('prev').hidden = !track;
  $('next').hidden = !track;
  $('queue').hidden = !(track && s.q && s.q.length > 1);

  const seek = $('seek');
  const canSeek = !!(track && s.dur && s.seek);
  seek.classList.toggle('disabled', !(track && s.dur));
  seek.tabIndex = canSeek ? 0 : -1;
  if (focused && focused.hidden && view.screen === 'now') focusDefault();
  refreshTip();
  tick();
}

function tick() {
  if (!hasTrack() || !state.dur) {
    $('fill').style.inlineSize = '0';
    $('knob').style.insetInlineStart = '0';
    $('elapsed').textContent = '';
    $('total').textContent = '';
    return;
  }
  const p = position();
  const pct = (100 * p) / state.dur;
  $('fill').style.inlineSize = `${pct}%`;
  $('knob').style.insetInlineStart = `${pct}%`;
  $('elapsed').textContent = clock(p);
  $('total').textContent = `-${clock(state.dur - p)}`;
  const seek = $('seek');
  seek.setAttribute('aria-valuemax', String(Math.round(state.dur / 1000)));
  seek.setAttribute('aria-valuenow', String(Math.round(p / 1000)));
  seek.setAttribute('aria-valuetext', `${clock(p)} of ${clock(state.dur)}`);
}

function startTick() {
  stopTick();
  tickTimer = setInterval(() => {
    // Only the clock moves; when paused or idle there is nothing to redraw.
    if (view.screen === 'now' && state && state.play) tick();
    $('stateText').textContent = stateLine();
  }, 1000);
}

function stopTick() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = 0;
}

// After a press, say what actually changed once the phone confirms it.
function confirmAction() {
  const a = lastAction;
  if (!a || !prevState || !state) return;
  lastAction = '';
  if (a === 'like' && prevState.liked !== state.liked) showToast(state.liked ? 'Added to My Collection' : 'Removed from My Collection');
  else if ((a === 'next' || a === 'prev') && state.ti && state.ti !== prevState.ti) showToast(state.ti);
}

function press(c, extra) {
  lastAction = c;
  send(c, extra);
}

// ---- seeking: swipe on the song bar --------------------------------------------------------

function nudgeSeek(direction) {
  if (!hasTrack() || !state.dur || !state.seek) return;
  // Keep swiping and the steps grow: 10 s, 10 s, 20 s, 30 s, 60 s…
  const now = Date.now();
  seekStreak = now - lastSeekKey < 700 ? seekStreak + 1 : 0;
  lastSeekKey = now;
  const step = [10, 10, 20, 30, 60][Math.min(seekStreak, 4)] * 1000;
  seekPreview = Math.max(0, Math.min((seekPreview ?? position()) + direction * step, state.dur));
  tick();
  clearTimeout(seekTimer);
  seekTimer = setTimeout(() => {
    const target = seekPreview;
    seekPreview = null;
    seekStreak = 0;
    send('seek', { ms: Math.round(target) });
  }, 500);
}

// ---- volume: buttons and pinch-drag --------------------------------------------------------

function nudgeVolume(delta) {
  const { cur, max } = volParts();
  if (cur == null) { press(delta > 0 ? 'volUp' : 'volDown'); return; }
  volPreview = Math.max(0, Math.min((volPreview ?? cur) + delta, max ?? 15));
  $('volText').textContent = String(volPreview);
  showToast(`Volume ${volPreview} of ${max ?? 15}`);
  clearTimeout(volTimer);
  // One message for a whole burst of presses or a long drag.
  volTimer = setTimeout(() => {
    volTimer = 0;
    lastAction = 'volume';
    send('volSet', { v: volPreview });
  }, 350);
}

let drag = null;
let dragEndedAt = 0;

function wireDrag() {
  document.addEventListener('pointerdown', (e) => {
    if (view.screen !== 'now' || !state) return;
    drag = { id: e.pointerId, y: e.clientY, moved: false, sent: 0 };
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = drag.y - e.clientY;
    if (!drag.moved && Math.abs(dy) < 16) return;
    drag.moved = true;
    const steps = Math.trunc(dy / 34);
    if (steps !== drag.sent) {
      nudgeVolume(steps - drag.sent);
      drag.sent = steps;
    }
  });
  const end = () => { if (drag && drag.moved) dragEndedAt = Date.now(); drag = null; };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  // A drag must never also count as a press on whatever it ended over.
  document.addEventListener('click', (e) => {
    if (Date.now() - dragEndedAt < 400) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

// ---- screens and Back --------------------------------------------------------------------

// Every destination is a history entry so the glasses' Back steps out one level at a time.
function go(next) {
  if (depth < HISTORY_LIMIT) {
    history.pushState(next, '');
    depth++;
  } else {
    history.replaceState(next, '');
  }
  render(next);
}

function render(next) {
  view = next || { screen: 'now' };
  const onNow = view.screen === 'now';
  $('now').hidden = !onNow;
  $('list').hidden = onNow;
  if (onNow) {
    renderNow();
    // Coming back from a list lands on the button that opened it.
    const target = view.focus && $(view.focus);
    if (target && !target.hidden) target.focus();
    else focusDefault();
  } else if (view.screen === 'queue') {
    renderQueue(true);
  } else if (view.screen === 'lib') {
    openLibraryView();
  }
}

function focusDefault() {
  const t = $('toggle');
  (t.hidden ? $('library') : t).focus();
}

function setListHead(title, crumbs) {
  $('listTitle').textContent = title;
  $('crumb').textContent = crumbs && crumbs.length ? crumbs.join(' › ') : '';
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.4v13.2a.9.9 0 0 0 1.4.8l10.2-6.6a.9.9 0 0 0 0-1.6L9.4 4.6A.9.9 0 0 0 8 5.4z"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4h10v4h-8v9a3 3 0 1 1-2-2.8z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>',
};

function itemButton(id, title, sub, icon, onPress, opts = {}) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.dataset.id = id;
  b.innerHTML = `${icon}<span class="text"><span class="ti"></span><span class="su"></span></span>${opts.chevron ? ICONS.chev : ''}`;
  b.querySelector('.ti').textContent = title || 'Untitled';
  b.querySelector('.su').textContent = sub || '';
  if (opts.current) b.classList.add('current');
  b.addEventListener('click', onPress);
  if (opts.onRight) b.dataset.right = '1';
  b._open = opts.onRight;
  li.appendChild(b);
  return li;
}

function focusItem(id) {
  const items = $('items');
  const match = id != null ? items.querySelector(`button[data-id="${CSS.escape(String(id))}"]`) : null;
  (match || items.querySelector('button') || $('listTitle')).focus();
}

function renderQueue(fresh) {
  setListHead('Up next', []);
  const items = $('items');
  const keep = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : null;
  items.textContent = '';
  const q = (state && state.q) || [];
  $('listNote').textContent = q.length ? '' : 'Tidal is not sharing what plays next.';
  $('more').hidden = true;
  q.forEach((e) => items.appendChild(itemButton(e.id, e.ti, e.su, e.id === state.qa ? ICONS.note : ICONS.play, () => {
    send('skip', { id: e.id });
    showToast(`Playing ${e.ti}`);
    history.back();
  }, { current: e.id === state.qa })));
  focusItem(fresh ? state && state.qa : keep);
}

function openLibraryView() {
  setListHead(view.title || 'Library', view.crumbs || []);
  const cached = libCache.get(`${view.id}|${view.page}`);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
    renderLibrary(cached.m, false);
    return;
  }
  $('items').textContent = '';
  $('more').hidden = true;
  $('listNote').textContent = 'Loading…';
  $('listTitle').focus();
  send('lib', { id: view.id ?? null, title: view.title || 'Library', page: view.page || 0 });
}

function renderLibrary(m, fromNetwork) {
  const items = $('items');
  items.textContent = '';
  $('listNote').textContent = m.err ? m.err : (m.items.length ? '' : 'Nothing here yet.');
  m.items.forEach((it) => {
    const open = it.b ? () => openFolder(it) : null;
    items.appendChild(itemButton(it.id, it.ti, it.su, it.b ? ICONS.folder : ICONS.play, () => {
      if (it.b) openFolder(it);
      else if (it.p) {
        lastAction = 'libplay';
        send('libplay', { id: it.id });
        showToast(`Playing ${it.ti}`);
        leaveToNow();
      }
    }, { chevron: it.b, onRight: open }));
  });
  $('more').hidden = !m.more;
  // Back from a folder lands on the row that opened it; a fresh list starts at the top.
  focusItem(view.focus);
}

function openFolder(it) {
  // Remember where we were so Back lands on this row again.
  history.replaceState({ ...view, focus: it.id }, '');
  const crumbs = [...(view.crumbs || []), view.title || 'Library'];
  go({ screen: 'lib', id: it.id, title: it.ti, page: 0, crumbs, focus: null });
}

function openLibraryRoot() {
  history.replaceState({ ...view, focus: 'library' }, '');
  go({ screen: 'lib', id: null, title: 'Library', page: 0, crumbs: [], focus: null });
}

function openQueue() {
  history.replaceState({ ...view, focus: 'queue' }, '');
  go({ screen: 'queue' });
}

// After choosing something to play, unwind every list back to Now Playing.
function leaveToNow() {
  if (depth > 0) {
    const steps = depth;
    depth = 0;
    history.go(-steps);
  } else {
    render({ screen: 'now' });
  }
}

function onPopState(e) {
  depth = Math.max(0, depth - 1);
  render(e.state || { screen: 'now' });
}

// ---- voice: tools Meta AI can call (only where WebMCP is switched on) ---------------------

function snapshot() {
  if (!state) return { connected: false, note: 'The phone has not reported yet.' };
  return {
    connected: true,
    playing: !!state.play,
    title: state.ti || null,
    artist: state.ar || null,
    album: state.al || null,
    in_my_collection: !!state.liked,
    volume: state.vol || null,
    position: hasTrack() ? clock(position()) : null,
    length: state.dur ? clock(state.dur) : null,
  };
}

function waitForPhone(check, signal, ms = 4000) {
  return new Promise((resolve) => {
    const done = () => { waiters.delete(on); clearTimeout(timer); resolve(snapshot()); };
    const on = () => { if (check()) done(); };
    const timer = setTimeout(done, ms);
    waiters.add(on);
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

function registerVoiceTools() {
  const ctx = document.modelContext;
  if (!ctx || typeof ctx.registerTool !== 'function') return;
  const reg = (tool) => {
    try {
      const r = ctx.registerTool(tool);
      if (r && typeof r.then === 'function') r.then(undefined, (e) => console.warn(tool.name, e));
    } catch (e) { console.warn(tool.name, e); }
  };
  const act = (c, check) => async (args, opts) => {
    const before = snapshot();
    press(c);
    const after = await waitForPhone(() => check(before), opts && opts.signal);
    return JSON.stringify({ ...after, next_action: 'Confirm in one short sentence, then stop.' });
  };

  reg({
    name: 'tidal_now_playing',
    description: 'What Tidal is playing on the wearer\'s phone: title, artist, album, playing or paused, volume, position.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => JSON.stringify({ ...snapshot(), next_action: 'Answer briefly, then stop.' }),
  });
  reg({ name: 'tidal_play', description: 'Resume Tidal playback on the phone.', inputSchema: { type: 'object', properties: {} }, execute: act('play', () => state && state.play) });
  reg({ name: 'tidal_pause', description: 'Pause Tidal playback on the phone.', inputSchema: { type: 'object', properties: {} }, execute: act('pause', () => state && !state.play) });
  reg({ name: 'tidal_next_track', description: 'Skip to the next track in Tidal.', inputSchema: { type: 'object', properties: {} }, execute: act('next', (b) => state && state.ti !== b.title) });
  reg({
    name: 'tidal_previous_track',
    description: 'Go back to the previous track, or restart the current one, in Tidal.',
    inputSchema: { type: 'object', properties: {} },
    execute: act('prev', (b) => state && (state.ti !== b.title || state.pos < 3000)),
  });
  reg({
    name: 'tidal_set_in_collection',
    description: 'Add the current track to the wearer\'s Tidal My Collection, or remove it.',
    inputSchema: { type: 'object', properties: { add: { type: 'boolean', description: 'true to add (like), false to remove.' } }, required: ['add'] },
    execute: async ({ add }, opts) => {
      const want = add !== false && add !== 'false';
      if (!hasTrack()) return JSON.stringify({ error: true, message: 'Nothing is playing.', next_action: 'Tell the wearer, then stop.' });
      if (!!state.liked === want) return JSON.stringify({ ...snapshot(), next_action: 'Say it is already that way, then stop.' });
      press('like');
      const after = await waitForPhone(() => !!state.liked === want, opts && opts.signal);
      return JSON.stringify({ ...after, next_action: 'Confirm in one short sentence, then stop.' });
    },
  });
  reg({
    name: 'tidal_set_volume',
    description: 'Set Tidal\'s volume on the phone, either to a level or up/down by steps.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'integer', description: 'Exact level, 0 to the maximum shown in now_playing (usually 15).' },
        direction: { type: 'string', description: '"up" or "down", used when no level is given.' },
        steps: { type: 'integer', description: 'Steps for up/down, 1 to 8 (default 2).' },
      },
    },
    execute: async ({ level, direction, steps }, opts) => {
      const { cur, max } = volParts();
      const top = max ?? 15;
      let target;
      if (level != null && level !== '') target = parseInt(level, 10);
      else {
        const n = Math.max(1, Math.min(8, parseInt(steps, 10) || 2));
        target = (cur ?? 7) + (String(direction || '').toLowerCase().startsWith('d') ? -n : n);
      }
      target = Math.max(0, Math.min(top, Number.isFinite(target) ? target : (cur ?? 7)));
      send('volSet', { v: target });
      const after = await waitForPhone(() => volParts().cur === target, opts && opts.signal, 3000);
      return JSON.stringify({ ...after, next_action: 'Confirm in one short sentence, then stop.' });
    },
  });
}

// ---- service worker: the app still opens when the network is slow ------------------------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) { /* optional */ }
}

// ---- wiring ------------------------------------------------------------------------------

function wire() {
  $('toggle').addEventListener('click', () => press(state && state.play ? 'pause' : 'play'));
  $('prev').addEventListener('click', () => press('prev'));
  $('next').addEventListener('click', () => press('next'));
  $('like').addEventListener('click', () => press('like'));
  $('voldown').addEventListener('click', () => nudgeVolume(-1));
  $('volup').addEventListener('click', () => nudgeVolume(1));
  $('queue').addEventListener('click', openQueue);
  $('library').addEventListener('click', openLibraryRoot);
  $('more').addEventListener('click', () => {
    if (view.screen === 'lib') go({ ...view, page: (view.page || 0) + 1, focus: null });
  });

  $('seek').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      nudgeSeek(e.key === 'ArrowRight' ? 1 : -1);
    }
  });

  // Lists are one column, so sideways swipes are free: left steps back, right opens a folder.
  $('list').addEventListener('keydown', (e) => {
    const b = e.target.closest && e.target.closest('#items button');
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      history.back();
    } else if (e.key === 'ArrowRight' && b && b._open) {
      e.preventDefault();
      b._open();
    }
  });

  document.addEventListener('focusin', (e) => { if (view.screen === 'now') showTip(e.target); });

  window.addEventListener('popstate', onPopState);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && view.screen !== 'now') { e.preventDefault(); history.back(); }
  });
  document.addEventListener('visibilitychange', onVisibility);
  wireDrag();
}

async function main() {
  const pair = readPairing();
  if (!pair || !window.crypto || !crypto.subtle) {
    $('now').hidden = true;
    $('setup').hidden = false;
    return;
  }
  topic = pair.t;
  key = await crypto.subtle.importKey('raw', fromB64url(pair.k), 'AES-GCM', false, ['encrypt', 'decrypt']);
  history.replaceState({ screen: 'now' }, '');
  wire();
  renderNow();
  focusDefault();
  registerVoiceTools();
  registerServiceWorker();
  await catchUp();
  if (view.screen === 'now') focusDefault();
  if (document.visibilityState === 'visible') { openStream(); startTick(); }
}

main();
