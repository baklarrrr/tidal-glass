'use strict';

// The TIDAL library on the glasses when the phone is an iPhone.
// Same screens as the Android player (the list and Now Playing in index.html), fed by TIDAL's own API
// (tidal-api.js) instead of a companion app. Every level is one history entry, so the glasses' Back
// always steps up exactly one level: song -> list -> Library -> out of the app.
//
// This file only reads from app.js (small helpers such as $, itemButton, focusItem, clock); app.js
// calls show() where it used to draw the iPhone card, and stop() when the Android player takes over.

const TidalLibrary = (() => {
  const HOME = { s: 'home' };
  const LISTS_KEY = 'tg.tidal.lists.v1';   // localStorage: titles of the last lists, for an instant and offline menu
  const RESUME_KEY = 'tg.tidal.resume.v1'; // sessionStorage: where the menu was when sign-in was needed again
  const SAVED_LISTS = 10;
  const SAVED_ROWS = 40;
  const FRESH_MS = 5 * 60 * 1000;
  const RETRY_STEPS = [4000, 8000, 16000, 30000, 60000];

  const MENU = [
    { key: 'tracks', title: 'My tracks', icon: 'note' },
    { key: 'playlists', title: 'Playlists', icon: 'list' },
    { key: 'albums', title: 'Albums', icon: 'disc' },
    { key: 'artists', title: 'Artists', icon: 'person' },
    { key: 'search', title: 'Search', icon: 'search' },
    { key: 'help', title: 'Help and sign out', icon: 'info' },
  ];
  const GLYPH = {
    note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4h10v4h-8v9a3 3 0 1 1-2-2.8z"/></svg>',
    list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h11v2H4zm0 5h11v2H4zm0 5h7v2H4zm13-5.6 5 3.1-5 3.1z"/></svg>',
    disc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 6.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z"/></svg>',
    person: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20.5c.6-4.2 3.8-6.5 8-6.5s7.400 2.300 8 6.500z"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M10.500 3a7.500 7.500 0 1 0 4.600 13.400l4.200 4.200 1.400-1.400-4.200-4.200A7.500 7.500 0 0 0 10.500 3zm0 2.200a5.300 5.300 0 1 1 0 10.600 5.300 5.300 0 0 1 0-10.600z"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm-1.100 7.200h2.200V17h-2.200zm1.100-3.700a1.400 1.400 0 1 1 0 2.800 1.400 1.400 0 0 1 0-2.800z"/></svg>',
  };
  const TYPE_GLYPH = { tracks: 'note', albums: 'disc', artists: 'person', playlists: 'list' };

  let active = false;      // the library owns the screen
  let wired = false;
  let finishing = false;   // exchanging TIDAL's sign-in answer for tokens
  let showCard = null;     // app.js's own first-screen card
  let stack = [HOME];      // the levels from Library down to what is on screen; mirrors history.state
  const lists = new Map(); // list key -> { rows, keys, next, at, savedAt, loading, error }
  let retryTimer = 0;
  let retryStep = 0;
  let retryWhat = null;

  // ---- storage, wrapped -------------------------------------------------------------------------------

  function readJson(kind, key) {
    try { const v = (kind === 'session' ? sessionStorage : localStorage).getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function writeJson(kind, key, value) {
    try { (kind === 'session' ? sessionStorage : localStorage).setItem(key, JSON.stringify(value)); } catch (e) { /* storage may be full or off */ }
  }
  function dropKey(kind, key) {
    try { (kind === 'session' ? sessionStorage : localStorage).removeItem(key); } catch (e) { /* nothing kept */ }
  }

  // Titles only: no artwork, no addresses, nothing from the account beyond what the menu shows.
  function saveList(key, list) {
    const all = readJson('local', LISTS_KEY) || {};
    all[key] = {
      at: Date.now(),
      more: !!list.next || list.rows.length > SAVED_ROWS,
      rows: list.rows.slice(0, SAVED_ROWS).map((r) => ({ id: r.id, type: r.type, ti: r.ti, su: r.su, al: r.al, dur: r.dur })),
    };
    const keep = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, SAVED_LISTS);
    writeJson('local', LISTS_KEY, Object.fromEntries(keep));
  }

  function savedList(key) {
    const s = (readJson('local', LISTS_KEY) || {})[key];
    if (!s || !Array.isArray(s.rows)) return null;
    const rows = s.rows.filter((r) => r && r.id != null && typeof r.ti === 'string' && TYPE_GLYPH[r.type])
      .map((r) => ({ id: String(r.id), type: r.type, ti: r.ti, su: typeof r.su === 'string' ? r.su : '', al: typeof r.al === 'string' ? r.al : '',
        dur: Number.isFinite(r.dur) ? r.dur : 0, ex: false, art: '', artL: '', link: '' }));
    return rows.length ? { rows, at: Number.isFinite(s.at) ? s.at : 0 } : null;
  }

  // "14:05", or "Mon 14:05" when it was not today.
  function when(at) {
    const d = new Date(at);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  }

  // ---- entering and leaving ------------------------------------------------------------------------------

  // Called by app.js wherever it used to draw the iPhone card (every launch and every time the app
  // comes back on screen). Already showing the library: nothing moves.
  function show(message, card) {
    showCard = card;
    wireCard();
    if (finishing) return;
    // A phone that TIDAL sent back with an answer for the glasses: this visit is on its way to link/.
    if (window.__tgHandoffReturn) { drawCard('Finishing on your glasses…', false, true); return; }
    if (pairing) return; // the code stays on screen while the phone is at work
    if (TidalAPI.configured() && TidalAPI.hasLoginAnswer()) {
      finishing = true;
      drawCard('Signing you in…', false, true);
      TidalAPI.finishLogin().then((result) => {
        finishing = false;
        if (result === 'ok' && TidalAPI.signedIn()) start();
        else drawCard(result === 'denied' ? 'Signing in was cancelled. Nothing changed.' : 'Signing in did not finish. Please try again.');
      }, () => { finishing = false; drawCard('Signing in did not finish. Please try again.'); });
      return;
    }
    if (TidalAPI.signedIn()) {
      if (!active) start();
      else if (document.visibilityState === 'visible') retryNow();
      return;
    }
    stop();
    drawCard(message);
  }

  // The first screen: no client ID yet, or signed out. Also Help, with `help` set.
  // What happened (a cancelled sign-in, a sign-in TIDAL wants again) is said once, in the line under
  // the title, in place of the usual one; `busy` hides the button while an answer is being exchanged.
  function drawCard(message, help = false, busy = false) {
    endPairing();
    document.body.classList.remove('tidal');
    if (showCard) showCard('');
    const configured = TidalAPI.configured();
    const signedIn = TidalAPI.signedIn();
    const need = $('setupNeed');
    need.textContent = message || (!configured ? 'TIDAL needs one sign-in to set up. Until then:'
      : (signedIn ? '' : 'Sign in once to see your TIDAL library here.'));
    need.hidden = !need.textContent;
    $('signIn').hidden = !configured || signedIn || busy;
    $('signOut').hidden = !(help && signedIn);
    // Help rests on the title: signing out takes a deliberate swipe to its button first.
    if (!$('signIn').hidden) $('signIn').focus({ preventScroll: true });
  }

  // ---- signing in from a phone ---------------------------------------------------------------------------
  // The glasses show a code; the phone opens link/, takes the code and does the TIDAL sign-in. The
  // phone then hands TIDAL's one-time answer back, and this page alone can turn it into a sign-in.
  const LINK_ADDRESS = (location.host + location.pathname.replace(/[^/]*$/, '') + 'link').replace(/^www\./, '');
  let pairing = null; // { room, timers: [], done }

  function endPairing() {
    document.body.classList.remove('pairing');
    $('pairCode').textContent = '';
    $('pairCode').hidden = true;
    $('signInHere').hidden = true;
    if (!pairing) return;
    const p = pairing;
    pairing = null;
    for (const t of p.timers) clearTimeout(t), clearInterval(t);
    if (p.room) p.room.close();
  }

  function pairingNote(text) {
    $('setupHint').textContent = text;
    $('setupHint').hidden = !text;
  }

  async function beginPairing() {
    if (pairing || typeof TidalHandoff === 'undefined') return false;
    const offer = await TidalAPI.offerLogin();
    if (!offer) return false;
    const code = TidalHandoff.newCode();
    const mine = { room: null, timers: [], done: false };
    pairing = mine;
    document.body.classList.add('pairing');
    $('setupNeed').hidden = false;
    $('setupNeed').textContent = 'On your iPhone, open ' + LINK_ADDRESS + ' and enter this code:';
    $('pairCode').textContent = TidalHandoff.showCode(code);
    $('pairCode').hidden = false;
    $('signInHere').hidden = false;
    $('setupTitle').focus({ preventScroll: true });
    pairingNote('Connecting…');
    const fail = (text) => { if (pairing === mine) drawCard(text); };
    let room;
    try {
      room = await TidalHandoff.meet(code, 'g', async (msg) => {
        if (pairing !== mine || mine.done) return;
        if (msg.t === 'hello') {
          room.send(offer);
          pairingNote('iPhone connected. Finish signing in to TIDAL there.');
        } else if (msg.t === 'cancel') {
          fail('Signing in was cancelled on the iPhone. Nothing changed.');
        } else if (msg.t === 'code' && msg.st === offer.st) {
          mine.done = true;
          pairingNote('Signing you in…');
          const result = await TidalAPI.redeemOffer(msg.code, msg.st);
          // Said three times: the phone may be reconnecting while it waits to hear this.
          for (const wait of [0, 1500, 4000]) setTimeout(() => { try { room.send({ t: result === 'ok' ? 'done' : 'failed' }); } catch (e) { /* closed */ } }, wait);
          if (pairing !== mine) return;
          if (result === 'ok' && TidalAPI.signedIn()) {
            mine.room = null; // stays open a few seconds so the phone hears "done"
            setTimeout(() => room.close(), 6000);
            endPairing();
            start();
          } else fail('Signing in did not finish. Please try again.');
        }
      });
    } catch (e) { fail('Signing in needs a connection. Please try again.'); return true; }
    if (pairing !== mine) { room.close(); return true; }
    mine.room = room;
    // The phone may arrive before or after this page is connected: the offer is repeated until it is used.
    mine.timers.push(setInterval(() => {
      if (mine.done) return;
      if (room.live() && $('setupHint').textContent === 'Connecting…') pairingNote('Waiting for your iPhone…');
      room.send(offer);
    }, 2500));
    mine.timers.push(setTimeout(() => fail('That code ran out. Press Sign in for a new one.'), TidalHandoff.MAX_AGE));
    return true;
  }

  function start() {
    endPairing();
    active = true;
    wire();
    wireListSwipes();
    document.body.classList.add('tidal');
    document.body.classList.remove('calm', 'stale');
    TidalAPI.onAuthLost = authLost;
    // Back where the menu was before TIDAL asked for a new sign-in; otherwise the Library.
    const resume = readJson('session', RESUME_KEY);
    dropKey('session', RESUME_KEY);
    const levels = Array.isArray(resume) && resume.length && resume.every((v) => v && typeof v.s === 'string') ? resume.slice(0, HISTORY_LIMIT + 1) : [HOME];
    levels[0] = HOME;
    stack = [HOME];
    try { history.replaceState({ tl: stack }, ''); } catch (e) { /* history is a convenience */ }
    for (const level of levels.slice(1)) push(level);
    render();
    TidalAPI.whoAmI().catch(() => {});
  }

  // The Android player takes over, or the sign-in is gone. Music started here stops.
  function stop() {
    endPairing();
    if (!active) return;
    active = false;
    clearRetry();
    stopAudio();
    document.body.classList.remove('tidal');
    for (const id of ['tplay', 'nowTidal', 'listTidal', 'searchRow']) $(id).hidden = true;
    $('toggleLabel').hidden = true;
    $('toggle').classList.remove('labelled');
    $('toggle').hidden = false;
    $('prev').classList.remove('ghost');
    $('next').classList.remove('ghost');
    $('now').classList.remove('phone');
    delete $('art').dataset.want;
  }

  // TIDAL would not renew the sign-in. Remember the menu position, then ask for sign-in again.
  function authLost() {
    if (!active) return;
    writeJson('session', RESUME_KEY, stack);
    stop();
    drawCard('Please sign in to TIDAL again. Your place in the menu is kept.');
  }

  function signOut() {
    TidalAPI.signOut();
    dropKey('local', LISTS_KEY);
    dropKey('session', RESUME_KEY);
    lists.clear();
    caps.clear();
    stop();
    stack = [HOME];
    drawCard('Signed out of TIDAL on these glasses.');
  }

  // ---- levels and Back -----------------------------------------------------------------------------------

  const top = () => stack[stack.length - 1];

  function push(level) {
    stack = [...stack, level];
    try {
      if (stack.length - 1 <= HISTORY_LIMIT) history.pushState({ tl: stack }, '');
      else history.replaceState({ tl: stack }, '');
    } catch (e) { /* the screen still changes */ }
  }

  function go(level) {
    // Remember the row that was open, so Back lands on it again.
    const here = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : null;
    if (here && top().s !== 'track') replaceTop({ ...top(), focus: here });
    push(level);
    render();
  }

  function replaceTop(level) {
    stack = [...stack.slice(0, -1), level];
    try { history.replaceState({ tl: stack }, ''); } catch (e) { /* the screen still changes */ }
  }

  function back() {
    if (stack.length > 1) history.back();
  }

  function onPop(e) {
    if (!active) return;
    const saved = e.state && Array.isArray(e.state.tl) ? e.state.tl : null;
    stack = saved && saved.length ? saved : [HOME];
    render();
  }

  function render() {
    if (!active) return;
    clearRetry();
    const v = top();
    const screen = v.s === 'track' ? 'now' : (v.s === 'help' ? 'setup' : 'list');
    for (const el of document.querySelectorAll('main > section')) el.hidden = el.id !== screen;
    document.body.classList.toggle('tidal', v.s !== 'help');
    if (v.s === 'track') renderTrack();
    else if (v.s === 'help') drawCard('', true);
    else if (v.s === 'home') renderHome();
    else renderList();
  }

  // ---- the Library menu and its lists ----------------------------------------------------------------------

  function head(title, crumbs, link) {
    setListHead(title, crumbs);
    $('listTidal').hidden = false;
    $('listTidal').href = link || 'https://tidal.com/my-collection';
    $('searchRow').hidden = true;
    $('more').hidden = true;
    $('listNote').textContent = '';
  }

  function renderHome() {
    head('Library', ['TIDAL']);
    const items = $('items');
    items.textContent = '';
    items.scrollTop = 0;
    for (const m of MENU) {
      const open = () => {
        if (m.key === 'help') go({ s: 'help' });
        else go({ s: 'list', key: m.key, title: m.title, crumbs: ['Library'] });
      };
      const li = itemButton('menu:' + m.key, m.title, '', GLYPH[m.icon], open, { chevron: true, onRight: open });
      li.querySelector('button').classList.add('menu');
      items.appendChild(li);
    }
    focusItem(top().focus || 'menu:tracks');
  }

  function listFor(key) {
    let list = lists.get(key);
    if (!list) {
      list = { rows: [], keys: [], next: '', at: 0, savedAt: 0, loading: false, error: '' };
      const saved = savedList(key);
      if (saved) { list.rows = saved.rows; list.savedAt = saved.at; }
      lists.set(key, list);
    }
    return list;
  }

  const LINKS = { playlist: 'playlist', album: 'album', artist: 'artist' };
  function listLink(key) {
    const [kind, ...rest] = key.split(':');
    return LINKS[kind] ? 'https://tidal.com/' + LINKS[kind] + '/' + encodeURIComponent(rest.join(':')) : '';
  }

  function renderList() {
    const v = top();
    head(v.title || 'Library', v.crumbs || [], listLink(v.key));
    const searching = v.key === 'search';
    $('searchRow').hidden = !searching;
    if (searching) {
      $('items').textContent = '';
      $('searchBox').value = '';
      $('listNote').textContent = 'Type a song, album or artist, then press Search.';
      $('searchBox').focus({ preventScroll: true });
      return;
    }
    const list = listFor(v.key);
    drawRows(v.focus, true);
    if (!list.loading && (!list.at || Date.now() - list.at > FRESH_MS)) load(v.key, false);
    else drawNote();
  }

  function thumb(row) {
    return `<span class="thumb${row.type === 'artists' ? ' round' : ''}">${GLYPH[TYPE_GLYPH[row.type]]}</span>`;
  }

  function setArt(button, row) {
    const box = button.querySelector('.thumb');
    if (!box || !row.art || box.dataset.art === row.art) return;
    box.dataset.art = row.art;
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => { if (box.dataset.art === row.art) { box.querySelector('img')?.remove(); box.appendChild(img); box.classList.add('has-art'); } };
    img.src = row.art;
  }

  function rowSub(row) {
    if (row.type !== 'tracks') return row.su;
    const time = row.dur ? clock(row.dur) : '';
    return [row.su, time].filter(Boolean).join(' · ');
  }

  // Draws the list's rows. `focus` is the row to light (by "type:id"); null keeps the lit row.
  function drawRows(focus, fresh) {
    const v = top();
    if (v.s !== 'list' || v.key === 'search') return;
    const list = listFor(v.key);
    const items = $('items');
    const lit = document.activeElement && items.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    const moreLit = document.activeElement === $('more');
    const f = document.activeElement;
    // Focus that the wearer moved above the rows (the TIDAL link) stays where it is.
    const elsewhere = !fresh && f && f !== $('listTitle') && f !== $('more') && !items.contains(f) && $('list').contains(f);
    const scroll = items.scrollTop;
    items.textContent = '';
    list.rows.forEach((row, i) => {
      const id = row.type + ':' + row.id;
      const isTrack = row.type === 'tracks';
      const open = () => {
        if (isTrack) go({ s: 'track', key: v.key, at: i, row: slim(row) });
        else go({ s: 'list', key: row.type.slice(0, -1) + ':' + row.id, title: row.ti, crumbs: [...(v.crumbs || []), v.title].slice(-2) });
      };
      const li = itemButton(id, row.ti, rowSub(row), thumb(row), open, { chevron: !isTrack, onRight: open });
      const button = li.querySelector('button');
      button.classList.add('art');
      if (playing && isTrack && playing.id === row.id) button.classList.add('current');
      setArt(button, row);
      items.appendChild(li);
    });
    $('more').hidden = !list.next;
    if (fresh) items.scrollTop = 0; else items.scrollTop = scroll;
    if (focus && list.rows.length) focusItem(focus);
    else if (moreLit && !$('more').hidden) $('more').focus({ preventScroll: true });
    else if (elsewhere) { /* leave it */ }
    else if (list.rows.length) focusItem(focus || lit || v.focus);
    else $('listTitle').focus({ preventScroll: true });
    drawNote();
  }

  // What a level needs to draw a song again after a reload: text only.
  function slim(row) {
    return { id: row.id, type: 'tracks', ti: row.ti, su: row.su, al: row.al, dur: row.dur, ex: row.ex, art: row.art, artL: row.artL, link: row.link };
  }

  const SAY = {
    offline: 'No connection. Trying again…',
    busy: 'TIDAL is busy. Trying again…',
    server: 'TIDAL did not answer. Trying again…',
    missing: 'This is not available in TIDAL right now.',
  };

  // One calm line above the rows, and only one.
  function drawNote() {
    const v = top();
    if (v.s !== 'list' || v.key === 'search') return;
    const list = listFor(v.key);
    let text = '';
    if (list.error) {
      text = !list.at && list.savedAt && list.rows.length && list.error !== 'missing'
        ? `Saved list from ${when(list.savedAt)}. ${list.error === 'offline' ? 'No connection.' : 'TIDAL did not answer.'}`
        : (SAY[list.error] || SAY.server);
    } else if (list.loading && !list.rows.length) text = 'Loading…';
    else if (!list.loading && list.at && !list.rows.length) text = v.key.startsWith('search:') ? 'Nothing found.' : 'Nothing here yet.';
    $('listNote').textContent = text;
  }

  async function load(key, more) {
    const list = listFor(key);
    if (list.loading || (more && !list.next)) return;
    list.loading = true;
    list.error = '';
    const showing = () => active && top().s === 'list' && top().key === key;
    if (showing()) drawNote();
    try {
      const page = await TidalAPI.page(key, more ? list.next : '');
      const firstNew = more && page.rows[0] ? page.rows[0].type + ':' + page.rows[0].id : null;
      list.keys = more ? [...list.keys, ...page.keys] : page.keys;
      list.rows = more ? [...list.rows, ...page.rows] : page.rows;
      list.next = page.next;
      list.at = Date.now();
      list.loading = false;
      retryStep = 0;
      saveList(key, list);
      if (showing()) drawRows(more ? firstNew : null, false);
      // Artist names and covers follow; the titles are already readable.
      const keys = page.keys;
      TidalAPI.details(keys).then((rows) => {
        const byId = new Map(rows.map((r) => [r.type + ':' + r.id, r]));
        list.rows = list.rows.map((r) => byId.get(r.type + ':' + r.id) || r);
        saveList(key, list);
        if (showing()) drawRows(null, false);
      }).catch(() => { /* titles stay; details are tried again with the next load */ });
    } catch (e) {
      list.loading = false;
      if (e && e.kind === 'auth') return; // the sign-in screen is already showing
      list.error = (e && e.kind) || 'server';
      if (showing()) {
        drawNote();
        if (list.error !== 'missing') retryLater(() => load(key, more), e && e.retryAfter);
      }
    }
  }

  // ---- retrying by itself -------------------------------------------------------------------------------------

  function clearRetry() {
    clearTimeout(retryTimer);
    retryTimer = 0;
    retryWhat = null;
  }

  function retryLater(what, wait) {
    clearTimeout(retryTimer);
    retryWhat = what;
    const delay = Math.min(120000, Math.max(wait || 0, RETRY_STEPS[Math.min(retryStep, RETRY_STEPS.length - 1)]));
    retryStep++;
    retryTimer = setTimeout(retryNow, delay);
  }

  // The connection is back, or the app is on screen again: do not wait for the timer.
  function retryNow() {
    if (!active || !retryWhat) return;
    const what = retryWhat;
    clearRetry();
    what();
  }

  // ---- one song: Now Playing ------------------------------------------------------------------------------------

  const caps = new Map(); // track id -> { mode, url, ... } or { mode: 'checking' } or { mode: 'error', kind }
  let audio = null;
  let playing = null;     // { id, mode, row } for what the <audio> element holds

  function neighbours() {
    const v = top();
    const rows = (lists.get(v.key) || { rows: [] }).rows;
    let at = rows.findIndex((r) => r.type === 'tracks' && r.id === v.row.id);
    if (at < 0) at = -1;
    const step = (dir) => {
      if (at < 0) return null;
      for (let i = at + dir; i >= 0 && i < rows.length; i += dir) if (rows[i].type === 'tracks') return { row: rows[i], at: i };
      return null;
    };
    return { prev: step(-1), next: step(1) };
  }

  function renderTrack() {
    const v = top();
    const row = v.row;
    $('tplay').hidden = false;
    $('nowTidal').hidden = false;
    $('nowTidalLink').href = row.link || 'https://tidal.com/track/' + encodeURIComponent(row.id);
    $('atmos').hidden = true;
    $('explicit').hidden = !row.ex;
    $('vol').hidden = true;
    for (const bat of document.querySelectorAll('[data-gbat]')) bat.hidden = true;
    $('title').textContent = row.ti;
    $('artist').textContent = row.su;
    $('album').textContent = [row.al, row.dur ? clock(row.dur) : ''].filter(Boolean).join(' · ');
    drawCover(row);
    const n = neighbours();
    // A missing neighbour keeps its place, unseen, so Play never jumps sideways between songs.
    $('prev').hidden = $('next').hidden = !n.prev && !n.next;
    $('prev').classList.toggle('ghost', !n.prev);
    $('next').classList.toggle('ghost', !n.next);
    drawPlay();
    if (!caps.has(row.id) || caps.get(row.id).mode === 'error') check(row.id);
    focusTrack();
  }

  function drawCover(row) {
    const wrap = $('artwrap');
    const art = $('art');
    const want = row.artL || row.art || '';
    wrap.classList.remove('empty');
    if (!want) {
      art.hidden = true;
      art.removeAttribute('src');
      delete art.dataset.want;
      wrap.classList.remove('has-art');
      return;
    }
    if (art.dataset.want === want) return;
    art.dataset.want = want;
    art.hidden = true;
    wrap.classList.remove('has-art');
    art.removeAttribute('crossorigin');
    art.onload = () => { if (art.dataset.want === want) { art.hidden = false; wrap.classList.add('has-art'); } };
    art.onerror = () => { art.hidden = true; wrap.classList.remove('has-art'); };
    art.src = want;
  }

  async function check(id) {
    caps.set(id, { mode: 'checking' });
    const showing = () => active && top().s === 'track' && top().row.id === id;
    if (showing()) drawPlay();
    try {
      caps.set(id, await TidalAPI.playable(id));
      retryStep = 0;
    } catch (e) {
      if (e && e.kind === 'auth') { caps.delete(id); return; }
      caps.set(id, { mode: 'error', kind: (e && e.kind) || 'server' });
      if (showing()) retryLater(() => { if (showing()) check(id); }, e && e.retryAfter);
    }
    if (showing()) {
      drawPlay();
      focusTrack();
      if (playNext === id && caps.get(id).mode === 'full') pressPlay();
    }
    if (playNext === id) playNext = null;
  }

  const loaded = () => !!(playing && top().s === 'track' && playing.id === top().row.id);

  // The play button, the line that says what it does, and the top line: one honest state at a time.
  function drawPlay() {
    if (!active || top().s !== 'track') return;
    const row = top().row;
    const cap = caps.get(row.id) || { mode: 'checking' };
    const on = loaded() && audio && !audio.paused && !audio.ended;
    const canPlay = cap.mode === 'full' || cap.mode === 'preview';
    const toggle = $('toggle');
    const label = $('toggleLabel');
    toggle.hidden = !canPlay && cap.mode !== 'checking';
    shown($('playIcon'), !on);
    shown($('pauseIcon'), on);
    const preview = cap.mode === 'preview';
    label.hidden = !preview;
    label.textContent = on ? 'Pause preview' : 'Preview 30 s';
    toggle.classList.toggle('labelled', preview);
    toggle.setAttribute('aria-label', preview ? label.textContent : (on ? 'Pause' : 'Play'));
    toggle.setAttribute('aria-disabled', cap.mode === 'checking' ? 'true' : 'false');

    let state = '';
    let note = '';
    let hint = '';
    if (cap.mode === 'checking') state = 'Asking TIDAL what can play…';
    else if (cap.mode === 'error') state = SAY[cap.kind] || SAY.server;
    else if (cap.mode === 'preview') {
      state = on ? 'Playing a preview' : (loaded() && audio.ended ? 'Preview finished' : 'Preview ready');
      note = 'TIDAL lets other apps play previews only.';
      hint = 'Full songs play from the TIDAL app on your phone.';
    } else if (cap.mode === 'full') {
      state = on ? 'Playing' : (loaded() && audio.currentTime > 0 && !audio.ended ? 'Paused' : 'Ready to play');
    } else {
      state = 'Plays from your phone';
      note = 'Play this in TIDAL on your iPhone';
      hint = 'With the display asleep, tap the right temple to pause or resume.';
    }
    if (playFailed === row.id && cap.mode !== 'checking') {
      state = 'This song could not start here';
    }
    // The few letters that say why (see playable() in tidal-api.js), for a song that plays from the phone only.
    if (cap.mode === 'phone' && cap.facts) hint = (hint ? hint + ' ' : '') + '[' + cap.facts + ']';
    $('stateText').textContent = state;
    $('stateText').parentElement.classList.toggle('warn', cap.mode === 'error');
    $('dot').classList.toggle('live', on);
    $('tplayNote').textContent = note;
    $('tplayHint').textContent = hint;
    $('tplay').classList.toggle('big', cap.mode === 'phone');
    $('now').classList.toggle('phone', cap.mode === 'phone');
    drawBar();
  }

  function focusTrack() {
    if (!active || top().s !== 'track') return;
    const f = document.activeElement;
    if (f && f !== document.body && $('now').contains(f) && !f.hidden && f.offsetParent && !f.classList.contains('ghost')) return;
    const order = [$('toggle'), $('next'), $('prev'), $('nowTidalLink')];
    const target = order.find((el) => !el.hidden && el.offsetParent && !el.classList.contains('ghost'));
    if (target) target.focus({ preventScroll: true });
  }

  function drawBar() {
    if (!active || top().s !== 'track') return;
    const seek = $('seek');
    const mine = loaded() && audio;
    const dur = mine && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : 0;
    seek.classList.toggle('disabled', !dur);
    seek.tabIndex = dur ? 0 : -1;
    if (!dur) return;
    const p = Math.min(dur, audio.currentTime * 1000);
    const pct = (100 * p) / dur;
    $('fill').style.inlineSize = `${pct}%`;
    $('knob').style.insetInlineStart = `${pct}%`;
    $('elapsed').textContent = clock(p);
    $('total').textContent = `-${clock(dur - p)}`;
    seek.setAttribute('aria-valuemax', String(Math.round(dur / 1000)));
    seek.setAttribute('aria-valuenow', String(Math.round(p / 1000)));
    seek.setAttribute('aria-valuetext', `${clock(p)} of ${clock(dur)}`);
  }

  // ---- playing in the page: a plain <audio> element, nothing added to or taken from the sound -----------------------

  let playFailed = null;
  let playNext = null; // the song to start by itself once TIDAL says it plays in full
  // A browser that refuses to start sound without a press has not failed: the button stays.
  const startFailed = (id, url) => (err) => { if (err && err.name === 'NotAllowedError') drawPlay(); else if (!err || err.name !== 'AbortError') failPlay(id, url); };

  function player() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'none';
    for (const ev of ['play', 'pause', 'playing', 'waiting', 'durationchange']) audio.addEventListener(ev, drawPlay);
    audio.addEventListener('timeupdate', drawBar);
    audio.addEventListener('ended', () => {
      drawPlay();
      // A whole song that ends moves on to the next one in the list; a preview just ends.
      if (playing && playing.mode === 'full' && loaded()) {
        const n = neighbours().next;
        if (n) { playNext = n.row.id; step(n); if ((caps.get(n.row.id) || {}).mode === 'full') pressPlay(); }
      }
    });
    audio.addEventListener('error', () => { if (playing) failPlay(playing.id, playing.url); });
    return audio;
  }

  // One way of playing did not work in this browser: try the next one TIDAL gave, if there is one.
  function failPlay(id, url) {
    const cap = caps.get(id);
    // The same failure is reported twice (by the element and by play()): act on it once.
    if (!cap || !cap.sources || !cap.sources.length || cap.sources[0].url !== url) return;
    if (cap.sources.length > 1) {
      const sources = cap.sources.slice(1);
      caps.set(id, { ...cap, sources, mode: sources[0].full ? 'full' : 'preview' });
      if (playing && playing.id === id) {
        playing.mode = sources[0].full ? 'full' : 'preview';
        playing.url = sources[0].url;
        audio.src = sources[0].url;
        audio.play().catch(startFailed(id, playing.url));
      }
      drawPlay();
      return;
    }
    playFailed = id;
    playing = null;
    // What TIDAL handed out did not play in this browser: say where it does play.
    let code = '';
    try { code = audio && audio.error ? ' e' + audio.error.code : ' e-'; } catch (e) { /* no code */ }
    caps.set(id, { mode: 'phone', sources: [], presentation: '', why: 'unplayable', facts: (cap.facts || '') + code });
    drawPlay();
    focusTrack();
  }

  function stopAudio() {
    if (!audio) return;
    try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (e) { /* already idle */ }
    playing = null;
  }

  function pressPlay() {
    if (!active || top().s !== 'track') return;
    const row = top().row;
    const cap = caps.get(row.id);
    if (!cap || (cap.mode !== 'full' && cap.mode !== 'preview')) return;
    const a = player();
    if (loaded()) {
      if (a.paused || a.ended) { if (a.ended) a.currentTime = 0; a.play().catch(startFailed(row.id, playing.url)); }
      else a.pause();
      return;
    }
    playFailed = null;
    playing = { id: row.id, mode: cap.mode, url: cap.sources[0].url };
    a.src = playing.url;
    a.play().catch(startFailed(row.id, playing.url));
    announce(row);
    drawPlay();
  }

  // The glasses' own media controls (a temple tap) pause and resume what plays here.
  function announce(row) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: row.ti, artist: row.su, album: row.al,
        artwork: row.artL ? [{ src: row.artL }] : [] });
      navigator.mediaSession.setActionHandler('play', () => audio && audio.play().catch(() => {}));
      navigator.mediaSession.setActionHandler('pause', () => audio && audio.pause());
    } catch (e) { /* optional */ }
  }

  function step(n) {
    if (!n) return;
    const v = top();
    replaceTop({ ...v, at: n.at, row: slim(n.row) });
    renderTrack();
  }

  function nudge(dir) {
    if (!loaded() || !audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration - 0.25, audio.currentTime + dir * 10));
    drawBar();
  }

  // ---- wiring ------------------------------------------------------------------------------------------------------

  function wire() {
    if (wired) return;
    wired = true;
    window.addEventListener('popstate', onPop);
    window.addEventListener('online', retryNow);
    $('toggle').addEventListener('click', () => { if (active) pressPlay(); });
    $('prev').addEventListener('click', () => { if (active && top().s === 'track') { step(neighbours().prev); focusTrack(); } });
    $('next').addEventListener('click', () => { if (active && top().s === 'track') { step(neighbours().next); focusTrack(); } });
    $('more').addEventListener('click', () => { if (active && top().s === 'list') load(top().key, true); });
    $('seek').addEventListener('keydown', (e) => {
      if (!active || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      nudge(e.key === 'ArrowRight' ? 1 : -1);
    });
    // Lists are one column, so sideways swipes are free: left steps back, right opens the row.
    $('list').addEventListener('keydown', (e) => {
      if (!active) return;
      const inBox = e.target === $('searchBox');
      if (inBox && e.key === 'Enter') {
        const q = $('searchBox').value.trim().replace(/\s+/g, ' ');
        if (q) { e.preventDefault(); go({ s: 'list', key: 'search:' + q, title: q, crumbs: ['Library', 'Search'] }); }
        return;
      }
      if (inBox && $('searchBox').value) return; // the arrows move through what was typed
      const b = e.target.closest && e.target.closest('#items button');
      if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
      else if (e.key === 'ArrowRight' && b && b._open) { e.preventDefault(); b._open(); }
    });
    document.addEventListener('keydown', (e) => {
      if (active && e.key === 'Escape' && stack.length > 1) { e.preventDefault(); back(); }
    });
    // Help opens resting on its title. A swipe down that the platform did not turn into a move
    // goes to the first button there.
    $('setup').addEventListener('keydown', (e) => {
      if (!active || top().s !== 'help' || e.key !== 'ArrowDown') return;
      const from = document.activeElement;
      setTimeout(() => {
        if (document.activeElement !== from || (from !== $('setupTitle') && from !== document.body)) return;
        const first = [$('signOut'), $('useAndroid')].find((b) => !b.hidden);
        if (first) first.focus({ preventScroll: true });
      }, 0);
    });
  }

  // The first screen's own buttons exist before any sign-in, so they are wired at load.
  let cardWired = false;
  function wireCard() {
    if (cardWired) return;
    cardWired = true;
    // Sign in shows a code for the phone. Glasses cannot leave the app for TIDAL's page, and a
    // password is not something to type on them; a phone or a computer can sign in on the spot.
    $('signIn').addEventListener('click', async () => {
      const shown = await beginPairing().catch(() => false);
      if (!shown) $('setupNeed').textContent = 'Signing in cannot start in this browser.';
    });
    $('signInHere').addEventListener('click', async () => {
      endPairing();
      $('setupNeed').textContent = 'Opening TIDAL…';
      const left = await TidalAPI.beginLogin().catch(() => false);
      if (!left) { $('setupNeed').textContent = 'Signing in cannot start in this browser.'; return; }
      // Still here after a while: this browser did not go. Say so instead of waiting forever.
      setTimeout(() => { if (!TidalAPI.signedIn() && $('setupNeed').textContent === 'Opening TIDAL…') drawCard('This browser did not open TIDAL. Sign in with the code instead.'); }, 8000);
    });
    $('signOut').addEventListener('click', signOut);
  }

  return { show, stop };
})();
