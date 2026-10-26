'use strict';

// Tidal Glass web app for Meta Ray-Ban Display.
// Shows what the official Tidal app is playing on the paired phone and sends presses back to it.
// The phone and this page talk through two public MQTT brokers on a private random topic; every
// message is AES-GCM encrypted with the key in this page's URL fragment, which browsers never send
// to a server.
//
// Input model (Neural Band or touchpad):
//   swipe = move focus, pinch = press, system Back = one step back (browser history);
//   on Now Playing, Back opens the glasses' own menu and a second Back leaves the app
//   in lists: swipe left = back, swipe right = open
//   on the song bar: swipe left/right = skip 10 s, faster while you keep swiping

const HISTORY_LIMIT = 4;   // the glasses keep at most five history entries including the first page
const $ = (id) => document.getElementById(id);

// The same page is also the Sound Lab app (opened from ./sound/), which starts on its Sound screen.
const APP_MODE = new URLSearchParams(location.search).get('app') === 'sound' ? 'sound' : 'tidal';
const ROOT = APP_MODE === 'sound' ? { screen: 'sound' } : { screen: 'now' };
// Presses that Tidal answers with a fresh state; anything else must not raise "not answering".
// The phone answers hello and snd every time, so a phone that stays silent shows as "not answering"
// instead of its last state passing for live.
const EXPECTS_REPLY = new Set(['hello', 'snd', 'toggle', 'play', 'pause', 'next', 'prev', 'like', 'volUp', 'volDown', 'volSet', 'skip', 'seek', 'seekBy', 'lib', 'libplay']);
const RECHECK_MS = 3 * 60 * 1000; // while on screen, ask the phone again this often

let topic = null;
let key = null;
let state = null;
let prevState = null;
let lastHeard = 0;
// When the phone last said something while this visit listened. A broker's stored copy (sent because
// the page just subscribed) shows the phone's last state but is not the phone answering now.
let heardLive = 0;
let pendingSince = 0; // the oldest request still waiting for the phone (0 when none)
let lastHello = 0;
let tickTimer = 0;
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

// ---- the link to the phone ----------------------------------------------------------------
// Three free public MQTT brokers at once (EMQX, HiveMQ and shiftr.io's on port 443): no account, no
// daily cap, and any one can be down without anything stopping. The phone is on all three and keeps
// its latest state retained there, so a reopened app shows it the moment the first one connects.
// Messages are AES-GCM sealed here and on the phone; the brokers only carry ciphertext.
//
// All three open together. shiftr.io used to wait 5 s as a spare, but on 2026-10-25 EMQX and HiveMQ
// could not be reached from home at all, so every opening sat on "Connecting…" for about 10 s.

const BROKERS = [
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
  { url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' },
];
const OUTBOX_MAX_AGE = 60000;
// A broker that connects late (or again) is also handed what went out in the last few seconds, so a
// hello or press sent while only a broker without the phone was up still arrives. The phone ignores a
// message it has already had (same command, same time).
const RESEND_WINDOW = 10000;
let links = [];
let linkId = '';
let linkDownSince = 0;    // when the page started waiting for a broker (0 while one is connected)
let outbox = [];          // sealed presses waiting for a connection: { body, at, expects }
let sentLately = [];      // sealed messages already out: { body, at }
const recent = [];        // the last messages handled (the same one arrives from every broker)

function linkUp() {
  return links.some((l) => l.connected);
}

// ---- link report ---------------------------------------------------------------------------
// What the glasses' own link did on each visit, so the opening lag on the real glasses can be read
// (Bakar 2026-10-25: there a press waited 20-60 s for a broker; on a PC 2 s). Sent sealed once per
// visit, on its first broker connect, with the previous visit's whole record (kept here when the page
// is hidden, so a visit that never reached the phone still gets reported). The phone ignores it.
const BUILD = 17;
let visit = null;
let hiddenAt = 0;

function startVisit(kind) {
  const now = Date.now();
  visit = {
    k: kind, // 'load' or 'wake'
    hid: kind === 'wake' && hiddenAt ? now - hiddenAt : 0,
    kept: linkUp(),
    on: navigator.onLine,
    mq: typeof mqtt !== 'undefined',
    age: Math.round(performance.now()),
    b: {}, // per broker: n reconnect attempts, up ms to the first connect, e the last error
    at: now, sent: false,
  };
}

function visitRecord(v) {
  const { at, sent, ...r } = v;
  return r;
}

function noteLink(host, what, err) {
  if (!visit) return;
  const b = visit.b[host] || (visit.b[host] = { n: 0 });
  if (what === 'try') b.n++;
  else if (what === 'err') b.e = String((err && (err.message || err.code)) || err).slice(0, 40);
  else if (what === 'up' && b.up == null) {
    b.up = Date.now() - visit.at;
    if (!visit.sent) {
      visit.sent = true;
      let prev = null;
      try { prev = JSON.parse(localStorage.getItem('tg.visit') || 'null'); localStorage.removeItem('tg.visit'); } catch (e) { /* none kept */ }
      send('diag', { v: BUILD, cur: visitRecord(visit), prev });
    }
  }
}

function endVisit() {
  if (!visit) return;
  try { localStorage.setItem('tg.visit', JSON.stringify(visitRecord(visit))); } catch (e) { /* storage may be off */ }
  visit = null;
}

function linkChanged() {
  if (linkUp()) linkDownSince = 0;
  else {
    if (!linkDownSince) linkDownSince = Date.now();
    armHedge();
  }
  renderStateLine();
}

// A try that hangs costs a whole connect timeout. On the glasses a fresh open sometimes sat 10-14 s while every
// broker's first tries timed out together (link reports, 2026-10-25 19:13), so when nothing has connected for
// HEDGE_AFTER a second, fresh connection to shiftr.io (the broker the phone is always on) is tried beside the stuck
// one. The first shiftr connection to connect stays; the other is closed.
const HEDGE_AFTER = 3000;
let hedgeTimer = 0;

function armHedge() {
  if (hedgeTimer || !links.length || window.__testLink) return;
  hedgeTimer = setTimeout(() => {
    hedgeTimer = 0;
    if (linkUp() || links.filter((l) => l.host === 'shiftr').length > 1) return;
    if (visit) visit.hedge = Date.now() - visit.at;
    addBroker(BROKERS[2]);
  }, HEDGE_AFTER);
}

// Two shiftr connections: keep the one that connected, close the other.
function dropSpareShiftr(kept) {
  for (const l of links.filter((x) => x !== kept && x.host === 'shiftr')) {
    links = links.filter((x) => x !== l);
    clearTimeout(l.retryTimer);
    try { l.end(true); } catch (e) { /* already closed */ }
  }
}

// The link library is a large file. On the first launch after an update the previous offline copy
// of this app can give up on it before it arrives, so it is fetched again for about half a minute
// instead of the page waiting silently.
let mqttTries = 0;
let mqttLoading = false;
function loadMqtt() {
  if (typeof mqtt !== 'undefined' || mqttLoading || mqttTries >= 10) return;
  mqttTries++;
  mqttLoading = true;
  const s = document.createElement('script');
  s.src = 'vendor/mqtt.min.js';
  s.onload = () => { mqttLoading = false; if (document.visibilityState === 'visible') openLink(); };
  s.onerror = () => { mqttLoading = false; setTimeout(loadMqtt, 3000); };
  document.head.appendChild(s);
}

function openLink() {
  if (links.length) return;
  // Tests (and only tests) supply their own link.
  if (window.__testLink) { links = [window.__testLink]; window.__testLink.onMessage = handle; flushOutbox(); return; }
  if (typeof mqtt === 'undefined') {
    if (!linkDownSince) linkDownSince = Date.now();
    loadMqtt();
    return;
  }
  linkDownSince = Date.now();
  linkId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  for (const b of BROKERS) addBroker(b);
  armHedge();
}

// Retries are scheduled here, not by mqtt.js (reconnectPeriod 0). The glasses' link report of 2026-10-25 20:08 showed
// a page left open without signal trying every broker about every 2 s for 8.5 minutes (205 tries to shiftr alone),
// which keeps the radio awake. Now: 1 s for the first three tries, then doubling to 30 s while nothing is connected;
// a broker that keeps failing while another carries the link backs off to 10 min. A connect, a network change
// ('online') or a new visit starts it fast again (each opens fresh links).
function retryDelay(fails, othersUp) {
  if (othersUp) return Math.min(600000, 1000 * 2 ** Math.min(fails, 10));
  return fails <= 3 ? 1000 : Math.min(30000, 1000 * 2 ** (fails - 3));
}

function scheduleRetry(client) {
  if (client.retryTimer || !links.includes(client) || client.connected) return;
  client.fails = (client.fails || 0) + 1;
  client.retryTimer = setTimeout(() => {
    client.retryTimer = 0;
    if (!links.includes(client) || client.connected) return;
    noteLink(client.host, 'try');
    try { client.reconnect(); } catch (e) { scheduleRetry(client); }
  }, retryDelay(client.fails, linkUp()));
}

// Connect timeout 6 s (was 8 s): the slowest successful connect the glasses reported was 4.1 s, and every try
// that hangs costs the whole timeout before the next one.
let clientSeq = 0;
function addBroker({ url, ...extra }) {
  const client = mqtt.connect(url, {
    clientId: `tgg-${linkId}-${clientSeq++}`, clean: true, keepalive: 45, protocolVersion: 4,
    reconnectPeriod: 0, connectTimeout: 6000, ...extra,
  });
  const host = new URL(url).hostname.split('.').slice(-2, -1)[0]; // emqx, hivemq, shiftr
  client.host = host;
  client.on('connect', () => {
    client.fails = 0;
    clearTimeout(client.retryTimer);
    client.retryTimer = 0;
    if (host === 'shiftr') {
      // The other shiftr connection got there first: this one is not needed.
      if (links.some((l) => l !== client && l.host === 'shiftr' && l.connected)) { dropSpareShiftr(links.find((l) => l !== client && l.host === 'shiftr' && l.connected)); return; }
      dropSpareShiftr(client);
    }
    clearTimeout(hedgeTimer);
    hedgeTimer = 0;
    noteLink(host, 'up');
    client.subscribe([`bkr/${topic}/s`, `bkr/${topic}/snd`, `bkr/${topic}/lib`], { qos: 1 });
    linkChanged();
    const now = Date.now();
    sentLately = sentLately.filter((o) => now - o.at < RESEND_WINDOW);
    for (const o of sentLately) client.publish(`bkr/${topic}/c`, o.body, { qos: 1 });
    flushOutbox();
    // After any (re)connect, ask the phone for the current sound rather than trust a copy a
    // broker kept.
    if (APP_MODE === 'sound') askSound(true);
  });
  // MQTT marks a broker's stored copy (sent on subscribing) as retained, and a message published while
  // the page listens as not retained.
  client.on('message', (t, payload, packet) => handle(new TextDecoder().decode(payload), !!(packet && packet.retain)));
  client.on('offline', linkChanged);
  client.on('close', () => { linkChanged(); scheduleRetry(client); });
  client.on('error', (e) => noteLink(host, 'err', e));
  links.push(client);
  return client;
}

function closeLink() {
  const old = links;
  links = [];
  linkDownSince = 0;
  sentLately = [];
  clearTimeout(hedgeTimer);
  hedgeTimer = 0;
  for (const l of old) { clearTimeout(l.retryTimer); try { l.end(true); } catch (e) { /* already closed */ } }
}

function flushOutbox() {
  const live = links.filter((l) => l.connected);
  if (!live.length) return;
  const now = Date.now();
  const due = outbox.filter((o) => now - o.at < OUTBOX_MAX_AGE);
  outbox = [];
  for (const o of due) {
    if (o.expects && !pendingSince) pendingSince = Date.now();
    for (const l of live) l.publish(`bkr/${topic}/c`, o.body, { qos: 1 });
    sentLately.push({ body: o.body, at: now });
  }
}

async function send(c, extra = {}) {
  const body = await seal({ c, ts: Date.now(), ...extra });
  const expects = EXPECTS_REPLY.has(c);
  const live = links.filter((l) => l.connected);
  if (!live.length) {
    // Not connected this instant (just opened, or the glasses' network is waking): it goes out
    // the moment a broker connects. The phone ignores a press it has already done. A hidden page
    // never reopens the link; the press waits for the app to come back.
    outbox.push({ body, at: Date.now(), expects });
    if (document.visibilityState === 'visible') openLink();
    return true;
  }
  // The oldest unanswered request counts: asking again must not reset the clock on a silent phone.
  if (expects && !pendingSince) pendingSince = Date.now();
  for (const l of live) l.publish(`bkr/${topic}/c`, body, { qos: 1 });
  sentLately.push({ body, at: Date.now() });
  if (sentLately.length > 40) sentLately.shift();
  return true;
}

// ---- connection --------------------------------------------------------------------------

async function handle(text, retained = false) {
  // The same message arrives from every broker, stored on one and live on another; it is drawn once,
  // and its live copy still counts as the phone answering.
  const again = recent.includes(text);
  if (!again) {
    recent.push(text);
    if (recent.length > 12) recent.shift();
  }
  let m;
  try { m = await openMessage(text); } catch (e) { return; }
  lastHeard = Date.now();
  if (!retained) {
    heardLive = Date.now();
    pendingSince = 0;
    if (visit && visit.ans == null) visit.ans = Date.now() - visit.at;
  }
  if (again) {
    if (!retained) renderStateLine();
    return;
  }
  if (m.t === 'state') {
    // A broker that missed some updates can hand over an older copy on connect; keep the newest.
    if (state && m.at < state.at) return;
    prevState = state;
    state = m;
    if (playIntent && !!m.play === playIntent.want) clearIntent();
    if (hasTrack()) startingSince = 0;
    if (volPreview != null && !volTimer) volPreview = null;
    renderNow();
    confirmAction();
    if (view.screen === 'queue') renderQueue(false);
    for (const w of waiters) w();
  } else if (m.t === 'lib') {
    libCache.set(`${m.id}|${m.page}`, { at: Date.now(), m });
    if (view.screen === 'lib' && view.id === m.id && view.page === m.page) renderLibrary(m, true);
  } else if (m.t === 'snd') {
    receiveSound(m);
  }
}

function sayHello() {
  if (APP_MODE === 'sound') {
    lastHello = Date.now();
    askSound();
    return;
  }
  if (Date.now() - lastHello < 15000) return;
  lastHello = Date.now();
  // Whether this browser can read the glasses' own battery (tells the phone app's log; no UI use yet).
  const probe = navigator.getBattery
    ? navigator.getBattery().then((b) => ({ nb: Math.round(b.level * 100), nc: b.charging })).catch(() => ({ nb: -2 }))
    : Promise.resolve({ nb: -1 });
  probe.then((extra) => send('hello', { ...extra, v: BUILD }));
}

// Battery: while the app is not on screen, drop the live connection and stop every timer. Anything a
// swipe left waiting (a seek, a volume, a sound) goes out first; nothing is repeated while hidden.
// Coming back, the retained state arrives the moment a broker connects.
function onVisibility() {
  if (document.visibilityState === 'visible') {
    // A new visit: the phone has to answer again before anything shows as live, so it is always asked,
    // however soon after the last hello (Director recheck 2026-10-25: shown again within 15 s, it waited
    // three minutes on "Checking your phone…").
    heardLive = 0;
    pendingSince = 0;
    lastHello = 0;
    startVisit('wake');
    openLink();
    sayHello();
    startTick();
    renderNow();
  } else {
    hiddenAt = Date.now();
    endVisit();
    clearTimeout(confirmTimer);
    confirmTimer = 0;
    if (seekPreview != null) {
      clearTimeout(seekTimer);
      const target = seekPreview;
      seekPreview = null;
      seekStreak = 0;
      send('seek', { ms: Math.round(target) });
    }
    if (volTimer) {
      clearTimeout(volTimer);
      volTimer = 0;
      send('volSet', { v: volPreview });
    }
    if (sndTimer) flushSound();
    stopTick();
    setTimeout(() => { if (document.visibilityState !== 'visible') closeLink(); }, 400);
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

// ---- the name line: a button's name, or a short confirmation ---------------------------------
// On the see-through display a message on top of other text makes both unreadable, so Now Playing
// keeps one line under its controls for this. A confirmation takes the line from the button's name
// while it shows, and is cut with "…" rather than wrapped onto the controls.

let notice = null;      // { text, until } while a confirmation shows
let noticeTimer = 0;
let tipWaiting = false; // focus moved while a confirmation showed: name that button once it ends

function say(text, ms = 2200) {
  notice = { text, until: Date.now() + ms };
  const n = $('notice');
  n.textContent = text;
  n.classList.add('on');
  clearTimeout(tipShow);
  clearTimeout(tipHide);
  $('tip').classList.remove('on');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(endNotice, ms);
}

function endNotice() {
  notice = null;
  $('notice').classList.remove('on');
  if (tipWaiting && view.screen === 'now') showTip(document.activeElement);
  tipWaiting = false;
}

// ---- button names: shown briefly when focus lands, so icons never need guessing -------------

// Each name says what the next press does.
const TIPS = {
  prev: () => 'Previous song',
  toggle: () => (state && state.play ? 'Pause' : (hasTrack() || (state && state.ses) ? 'Play' : 'Start Tidal and play')),
  next: () => 'Next song',
  like: () => (state && state.liked ? 'Remove from My Collection' : 'Add to My Collection'),
  queue: () => 'Up next',
  library: () => 'Your Tidal library',
  voldown: () => 'Volume down',
  volup: () => 'Volume up',
  soundBtn: () => 'Sound Lab: equaliser and speakers',
  seek: () => 'Swipe left or right to jump 10 s',
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
  // A confirmation on the line wins; the name follows when it ends.
  if (notice) { tipWaiting = true; return; }
  // A short wait keeps quick swipes from flashing every name on the way past.
  tipShow = setTimeout(() => {
    tip.textContent = TIPS[tipFor]();
    tip.classList.add('on');
    tipHide = setTimeout(() => tip.classList.remove('on'), 2200);
  }, 160);
}

function refreshTip() {
  if (tipFor && !notice && $('tip').classList.contains('on')) $('tip').textContent = TIPS[tipFor]();
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

// Play pressed with Tidal closed: 'starting' for 25 s (a cold Tidal can take a while on a slow network). Then 'failed' (said in the headline) if the phone
// has answered since the press, so Tidal itself did not start, or 'silent' if the phone has not, so it
// is the phone that is not answering. Either stays until the next press.
function startPhase() {
  if (!startingSince || hasTrack()) return '';
  if (Date.now() - startingSince < 25000) return 'starting';
  return heardLive > startingSince ? 'failed' : 'silent';
}

// The glasses' battery: the glasses' own browser reading when it has one (on the glasses it matched the
// phone's report, 47% at 2026-10-25 07:53), else the phone's report (5% steps) while under 30 minutes
// old. One chip on Now Playing and Sound Lab; charging shows a bolt, not only a colour.
let browserBattery = null; // { level 0..1, charging } from navigator.getBattery, when it is real

function watchBrowserBattery() {
  if (!navigator.getBattery) return;
  navigator.getBattery().then((b) => {
    const read = () => {
      // Chromium answers "full, charging, never empties" when it has no battery at all.
      const unknown = b.level === 1 && b.charging && b.chargingTime === 0 && b.dischargingTime === Infinity;
      browserBattery = unknown ? null : { level: b.level, charging: b.charging };
      drawBattery();
    };
    read();
    for (const ev of ['levelchange', 'chargingchange']) b.addEventListener(ev, read);
  }).catch(() => {});
}

function drawBattery() {
  const s = state;
  let pct = null;
  let charging = false;
  if (browserBattery) {
    pct = Math.round(browserBattery.level * 100);
    charging = browserBattery.charging;
  } else if (s && Number.isFinite(s.gb) && Date.now() - (s.at || 0) < 30 * 60 * 1000) {
    pct = s.gb;
    charging = !!s.gc;
  }
  for (const bat of document.querySelectorAll('[data-gbat]')) {
    bat.hidden = pct == null;
    if (pct == null) continue;
    bat.querySelector('.gbat-text').textContent = `${pct}%`;
    bat.querySelector('.gbat-fill').setAttribute('width', String(Math.max(1, 13.4 * pct / 100)));
    bat.classList.toggle('charging', charging);
    bat.classList.toggle('low', !charging && pct <= 15);
    bat.setAttribute('aria-label', `Glasses battery ${pct}%${charging ? ', charging' : ''}`);
  }
}

function phoneSilent() {
  return !!(pendingSince && Date.now() - pendingSince > 7000);
}

// A warning on screen (link down, phone silent, Tidal not starting) keeps the page out of calm.
function warningShown() {
  const phase = startPhase();
  return !!((linkDownSince && Date.now() - linkDownSince > 5000) || phoneSilent() || phase === 'failed' || phase === 'silent'
    || (typeof mqtt === 'undefined' && mqttTries >= 10 && !window.__testLink));
}

// The top line is about the link to the phone. What Tidal is doing (closed, starting, did not start,
// needs access) is said once, in the headline, never repeated up here.
function stateLine() {
  if (typeof mqtt === 'undefined' && mqttTries >= 10 && !window.__testLink) return 'No link yet: press Back, then Refresh';
  if (!state) return lastHeard ? 'Waiting for your phone…' : 'Connecting to your phone…';
  if (linkDownSince && Date.now() - linkDownSince > 5000) return 'Reconnecting…';
  const phase = startPhase();
  // While Tidal starts the phone may not answer at once; that is not a dead phone.
  if (phase === 'starting' && !phoneSilent()) return heardLive ? 'Phone connected' : 'Checking your phone…';
  if (phoneSilent() || phase === 'silent') return 'Your phone is not answering';
  // Only the phone's own answer this visit is live; until then the screen shows its last stored state.
  if (!heardLive) return 'Checking your phone…';
  if (phase || !hasTrack()) return 'Phone connected';
  if (state.buf) return 'Buffering…';
  return state.play ? 'Playing' : 'Paused';
}

// The state line, its dot and the warning look, redrawn together whenever any of them may change: a
// warning never sits beside a live dot. Under a warning the rest of Now Playing is the phone's last
// state, so it is dimmed.
function renderStateLine() {
  const warn = warningShown();
  $('stateText').textContent = stateLine();
  // The line is in the warning style only when it is itself a warning; "Tidal didn't start" is said in
  // the headline, beside a plain "Phone connected".
  $('stateText').parentElement.classList.toggle('warn', lineWarns());
  $('dot').classList.toggle('live', !!(hasTrack() && state.play && !state.buf && heardLive && !warn));
  // Dimmed only when an old song is on screen; a headline saying what went wrong stays bright.
  document.body.classList.toggle('stale', !!state && warn && hasTrack());
}

function lineWarns() {
  return !!((linkDownSince && Date.now() - linkDownSince > 5000) || phoneSilent() || startPhase() === 'silent'
    || (typeof mqtt === 'undefined' && mqttTries >= 10 && !window.__testLink));
}

// Headline and line under it when no song is showing: what is going on, and what to do.
function emptyHeadline(s) {
  if (!s) return ['Tidal Glass', ''];
  if (!s.acc) return ['Needs notification access', 'Open Tidal Glass on your phone and allow it.'];
  // Tidal closed on the phone is not a dead end: Play starts it where it left off. If it does not
  // start, the headline says so and what to do.
  const closed = !s.ses;
  const phase = startPhase();
  if (phase === 'starting') return closed ? ['Starting Tidal…', 'Starting your recent music on your phone.'] : ['Starting playback…', 'Asking Tidal on your phone to play.'];
  if (phase === 'failed') {
    return closed ? ["Tidal didn't start", 'Press Play to try again, or pick something from your library.']
      : ["Tidal didn't play", 'Pick something from your library, or press Play on your phone.'];
  }
  if (phase === 'silent') return ['Your phone is not answering', 'Open Tidal Glass on your phone, then press Play.'];
  return closed ? ['Tidal is closed', 'Press Play to start your recent music.'] : ['Nothing playing', 'Press Play, or pick something from your library.'];
}

// ---- cover light: a pale cover is dimmed more in calm --------------------------------------
// An album cover is most of the light on Now Playing (77% with a pale one). In calm the cover dims to
// 50%; a cover brighter than a typical one dims further, so none gives off more light at rest than a
// typical cover does. Measured once per cover on a 32 x 32 copy of the loaded image; no extra download.
// Linear light of a typical cover at 50% (the test cover in tests/light_measure.py measures 0.057).
const CALM_ART_LIGHT = 0.06;

function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function calmArtOpacity(img) {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, 32, 32);
  const px = g.getImageData(0, 0, 32, 32).data; // throws for a cover from a host without CORS
  // The display adds light, so what matters is the mean linear light the dimmed cover sends out.
  const light = (a) => {
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      sum += 0.2126 * srgbToLinear(a * px[i] / 255) + 0.7152 * srgbToLinear(a * px[i + 1] / 255)
        + 0.0722 * srgbToLinear(a * px[i + 2] / 255);
    }
    return sum / (px.length / 4);
  };
  if (light(0.5) <= CALM_ART_LIGHT) return 0.5;
  let lo = 0.2;
  let hi = 0.5;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (light(mid) > CALM_ART_LIGHT) hi = mid; else lo = mid;
  }
  return Math.max(0.2, lo);
}

function capArt(img, readable) {
  let a = 0.4; // a cover that cannot be measured gets a fixed, cautious cap
  if (readable) {
    try { a = calmArtOpacity(img); } catch (e) { a = 0.4; }
  }
  $('artwrap').style.setProperty('--calm-art', a.toFixed(3));
}

function renderNow() {
  const s = state;
  const track = hasTrack();

  renderStateLine();
  $('atmos').hidden = !(track && s.atmos);
  $('explicit').hidden = !(track && s.ex);
  const { cur } = volParts();
  $('vol').hidden = cur == null;
  drawBattery();
  $('volText').textContent = volPreview != null ? String(volPreview) : (cur == null ? '' : String(cur));

  const [headline, subline] = track ? [s.ti, s.ar || ''] : emptyHeadline(s);
  $('title').textContent = headline;
  $('artist').textContent = subline;
  $('album').textContent = track ? (s.al || '') : '';

  const wrap = $('artwrap');
  const art = $('art');
  wrap.classList.toggle('empty', !track);
  if (track && s.art) {
    if (art.dataset.want !== s.art) {
      art.dataset.want = s.art;
      art.hidden = true;
      wrap.classList.remove('has-art');
      // Asked for with CORS so the cover can be measured (Tidal's image server allows it). A server
      // that does not allow it gets one plain retry: the cover always shows, with the fixed cap.
      art.crossOrigin = 'anonymous';
      art.onload = () => { art.hidden = false; wrap.classList.add('has-art'); capArt(art, art.crossOrigin === 'anonymous'); };
      art.onerror = () => {
        if (art.crossOrigin === 'anonymous' && art.dataset.want === s.art) {
          art.removeAttribute('crossorigin');
          art.src = s.art;
          return;
        }
        art.hidden = true;
        wrap.classList.remove('has-art');
      };
      art.src = s.art;
    }
  } else {
    art.hidden = true;
    art.removeAttribute('src');
    delete art.dataset.want;
    wrap.classList.remove('has-art');
  }

  const playing = shownPlaying();
  shown($('playIcon'), !playing);
  shown($('pauseIcon'), playing);
  $('toggle').setAttribute('aria-label', playing ? 'Pause' : (track || (s && s.ses) ? 'Play' : 'Start Tidal and play'));

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

// ---- calm: less light while nobody is touching it ------------------------------------------
// After CALM_AFTER without a swipe or pinch on Now Playing or in Sound Lab the page dims its art and
// outlines (see style.css); the first input wakes it at once and is handled as usual.
const CALM_AFTER = 15000;
const SOUND_SCREENS = new Set(['sound', 'bands', 'slots']);
let lastInputAt = Date.now();

function wakeUp() {
  lastInputAt = Date.now();
  document.body.classList.remove('calm');
}

function checkCalm() {
  // Never while a warning is showing: it must stay readable.
  const sc = view.screen;
  const quiet = sc === 'now' ? !warningShown() : SOUND_SCREENS.has(sc) && !sndWarn;
  document.body.classList.toggle('calm', quiet && Date.now() - lastInputAt > CALM_AFTER);
}

let lastPhase = '';

function startTick() {
  stopTick();
  tickTimer = setInterval(() => {
    // Only the clock moves; when paused or idle there is nothing to redraw.
    if (view.screen === 'now' && state && state.play) tick();
    renderStateLine();
    if (view.screen === 'sound' || view.screen === 'bands' || view.screen === 'slots') renderSoundStatus();
    // A failed Tidal start changes the headline, not only this line.
    const phase = startPhase();
    if (phase !== lastPhase) { lastPhase = phase; renderNow(); }
    // While on screen, ask the phone again now and then (every 3 minutes, not every tick), so a phone
    // that has gone silent says so.
    if (Date.now() - lastHello > RECHECK_MS) {
      if (APP_MODE === 'sound') {
        lastHello = Date.now();
        askSound(true);
      } else {
        lastHello = 0;
        sayHello();
      }
    }
    checkCalm();
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
  if (a === 'like' && prevState.liked !== state.liked) say(state.liked ? 'Added to My Collection' : 'Removed from My Collection');
  else if ((a === 'next' || a === 'prev') && state.ti && state.ti !== prevState.ti) say(state.ti);
}

let confirmTimer = 0;

// Play pressed while Tidal was closed: when. The phone starts Tidal; the state line says so until a
// song shows up, or says what to do if Tidal never starts.
let startingSince = 0;

// A play or pause press shows on the button at once instead of a round trip later; the phone's state
// then confirms it. Unconfirmed after 5 s (the press goes out again at 2.5 s), the button goes back to
// what the phone last said. The "Playing"/"Paused" line and the live dot only ever show the phone's word.
const INTENT_MS = 5000;
let playIntent = null; // { want, at }
let intentTimer = 0;

function shownPlaying() {
  if (playIntent && Date.now() - playIntent.at < INTENT_MS) return playIntent.want;
  return !!(state && state.play);
}

function clearIntent() {
  playIntent = null;
  clearTimeout(intentTimer);
  intentTimer = 0;
}

function press(c, extra) {
  lastAction = c;
  if (c === 'play' && !hasTrack()) {
    startingSince = Date.now();
    renderNow(); // the headline says "Starting…" at once
  } else if (startingSince) {
    startingSince = 0; // any other press ends the "didn't start" message
    renderNow();
  }
  if ((c === 'play' || c === 'pause') && hasTrack()) {
    clearIntent();
    playIntent = { want: c === 'play', at: Date.now() };
    intentTimer = setTimeout(() => { clearIntent(); renderNow(); }, INTENT_MS);
    renderNow();
  }
  send(c, extra);
  // Starting Tidal: the phone answers every hello, so an answer after this press tells "Tidal didn't
  // start" (the phone is fine) apart from "your phone is not answering", even when Tidal reports nothing.
  if (c === 'play' && startingSince) send('hello');
  // Play and pause are safe to repeat: if Tidal has not changed after a moment (the phone was
  // reconnecting, a message was lost), send it once more instead of leaving the press unanswered.
  if (c === 'play' || c === 'pause') {
    const want = c === 'play';
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      confirmTimer = 0;
      if (state && !!state.play === want) return;
      if (want && startingSince) return; // the phone is still starting Tidal
      say(want ? 'Asking Tidal to play again…' : 'Asking Tidal to pause again…');
      send(c, extra);
    }, 2500);
  }
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

// ---- volume: buttons ---------------------------------------------------------------------
// (A pinch-and-drag volume gesture used to live here. On the glasses an ordinary pinch moves the
// hand a little, so presses were read as drags: Play changed the volume instead. Removed for good;
// tests/press_test.py checks that a press with hand movement is still a press.)

function nudgeVolume(delta) {
  const { cur, max } = volParts();
  if (cur == null) { press(delta > 0 ? 'volUp' : 'volDown'); return; }
  volPreview = Math.max(0, Math.min((volPreview ?? cur) + delta, max ?? 15));
  $('volText').textContent = String(volPreview);
  say(`Volume ${volPreview} of ${max ?? 15}`, 1600);
  clearTimeout(volTimer);
  // One message for a whole burst of presses.
  volTimer = setTimeout(() => {
    volTimer = 0;
    lastAction = 'volume';
    send('volSet', { v: volPreview });
  }, 350);
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
  view = next || ROOT;
  const sc = view.screen;
  $('now').hidden = sc !== 'now';
  $('list').hidden = sc !== 'queue' && sc !== 'lib';
  $('sound').hidden = sc !== 'sound';
  $('bands').hidden = sc !== 'bands';
  $('slots').hidden = sc !== 'slots';
  if (sc === 'now') {
    renderNow();
    // Coming back from a list lands on the button that opened it.
    const target = view.focus && $(view.focus);
    if (target && !target.hidden) target.focus();
    else focusDefault();
  } else if (sc === 'queue') {
    renderQueue(true);
  } else if (sc === 'lib') {
    openLibraryView();
  } else if (sc === 'sound') {
    openSound();
  } else if (sc === 'bands') {
    openBands();
  } else if (sc === 'slots') {
    openSlots();
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
  const target = match || items.querySelector('button');
  if (!target) { $('listTitle').focus(); return; }
  target.focus({ preventScroll: true });
  reveal(target);
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
    say(`Playing ${e.ti}`);
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
        say(`Playing ${it.ti}`);
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
    render(ROOT);
  }
}

function onPopState(e) {
  depth = Math.max(0, depth - 1);
  render(e.state || ROOT);
}

// ---- swiping through the scrolling lists -------------------------------------------------------
// The glasses move focus themselves when you swipe (spatial navigation). In the lists that scroll
// (Library, Up next, Sound Lab's controls) the browser's version gets three things wrong, so they are
// repaired right after it has had its turn: a swipe that only scrolls the list instead of moving to the
// next row, focus landing on the list itself with no row lit, and Up from More going nowhere. When the
// platform did move focus to a row, nothing is changed except the scroll, which then shows that row
// whole, inside the padding that keeps its ring and glow from being cut.
// Seen in desktop Chrome with spatial navigation; how the glasses' own browser behaves here is not
// verified.

function listOf(el) {
  if (!el || !el.closest) return null;
  if (el.closest('#items') || el.id === 'more') {
    return { box: $('items'), rows: () => [...$('items').querySelectorAll('button')], below: () => (!$('more').hidden ? $('more') : null), above: null };
  }
  if (el.closest('#sndRows') || el.closest('.sndtools')) {
    return { box: $('sndRows'), rows: () => [...$('sndRows').querySelectorAll('.srow')], below: null, above: () => $('sndPower') };
  }
  return null;
}

function repairSwipe(from, dir) {
  const list = listOf(from);
  if (!list) return;
  const rows = list.rows();
  const now = document.activeElement;
  const moved = now && now !== from && now !== list.box && now !== document.body;
  if (!moved) {
    const i = rows.indexOf(from);
    let want = null;
    if (i >= 0) want = rows[i + dir] || (dir > 0 ? list.below && list.below() : list.above && list.above());
    else if (list.below && from === list.below()) want = dir < 0 ? rows[rows.length - 1] : null; // past More: stay
    else if (dir > 0 || now === list.box) want = rows[0];
    if (want) want.focus({ preventScroll: true });
  }
  const f = document.activeElement;
  if (rows.includes(f)) reveal(f, dir);
  else if (list.below && f === list.below()) trimTop(list.box, f); // reaching More scrolled the list
}

// A swipe past the end of a list has nowhere to go. Left to the platform it scrolls the list by
// itself, which leaves half a row peeking in at the top (Photographer recheck 2026-10-25), so it does
// nothing instead.
function atListEnd(from, dir) {
  const list = listOf(from);
  if (!list || dir < 0) return false;
  const below = list.below && list.below();
  if (below) return from === below;
  const rows = list.rows();
  return rows.length > 0 && from === rows[rows.length - 1];
}


// Scrolls the focused row's list so the row shows whole, 14 px inside the list's edges (its padding).
// Going down, a row left cut by the top edge is scrolled out of sight, so no sliver of it peeks out.
function reveal(el, dir = 0) {
  const box = el.closest('#items, #sndRows');
  if (!box) return;
  const pad = 14;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < b.top + pad) box.scrollTop -= (b.top + pad) - r.top;
  else if (r.bottom > b.bottom - pad) box.scrollTop += r.bottom - (b.bottom - pad);
  trimTop(box, el);
}

// No sliver at the top: the list's padding shows rows too, and the rows' gaps are narrower than the
// padding, so lining a row up with the padding left a strip of the row above it (Photographer recheck
// 2026-10-25). A row cut by the top edge is scrolled fully out of sight when the list can go that far
// and the focused row stays whole; otherwise it is shown whole.
function trimTop(box, el) {
  // Cut = partly hidden by the top edge. A row lying whole inside the padding is not cut.
  const cutRow = () => {
    const top = box.getBoundingClientRect().top;
    return [...box.querySelectorAll('.srow, li')].find((x) => {
      if (x === el || x.contains(el)) return false;
      const q = x.getBoundingClientRect();
      return q.top < top - 0.5 && q.bottom > top + 0.5;
    });
  };
  const cut = cutRow();
  if (!cut) return;
  const top = box.getBoundingClientRect().top;
  const q = cut.getBoundingClientRect();
  const before = box.scrollTop;
  box.scrollTop = before + (q.bottom - top);
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const whole = !box.contains(el) || (r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5);
  if (cutRow() || !whole) box.scrollTop = before - (top - q.top);
}

// ---- Sound Lab ---------------------------------------------------------------------------
// The phone applies the sound to Tidal; this page owns the controls. Adjustments are drawn at once
// and sent as one message per burst of swipes, so a whole tuning session costs a few messages.

let snd = null;           // the phone's last Sound Lab message; local edits are applied to snd.s
let sndAt = 0;            // when it arrived
let sndAsked = 0;         // when we last asked for it
let sndEditAt = 0;        // last local adjustment, so an older copy from the phone never undoes it
let sndTimer = 0;
let sndLoading = 0;       // slot number being loaded
const armed = new Map();  // confirm-twice buttons: id -> timer

const SLIDERS = [
  { k: 'bass', label: 'Bass', min: -12, max: 12, db: true },
  { k: 'mids', label: 'Mids', min: -12, max: 12, db: true },
  { k: 'treble', label: 'Treble', min: -12, max: 12, db: true },
  { k: 'clarity', label: 'Clarity', min: 0, max: 10 },
  { k: 'loud', label: 'Loudness', min: 0, max: 10 },
  { k: 'bal', label: 'Balance', min: -10, max: 10 },
];
const BAND_COUNT = 10;
const DB_RANGE = 15;

function askSound(force) {
  if (!force && snd && Date.now() - sndAt < 10 * 60 * 1000) return;
  if (Date.now() - sndAsked < 5000) return;
  sndAsked = Date.now();
  send('snd');
}

function receiveSound(m) {
  // A broker that missed some updates can hand over an older copy on connect; keep the newest.
  if (snd && m.at && snd.at && m.at < snd.at) return;
  sndConfirmed = JSON.parse(JSON.stringify(m.s)); // what the phone itself last said it plays
  if (sndPending && sndPending.check(m)) {
    const done = sndPending.done;
    sndPending = null;
    if (done) soundNote(done);
  }
  const local = snd && snd.s;
  const keepLocal = local && !sndLoading && (sndTimer || Date.now() - sndEditAt < 3000);
  snd = m;
  sndAt = Date.now();
  if (keepLocal) snd.s = local;
  if (!Array.isArray(snd.s.bands)) snd.s.bands = Array(BAND_COUNT).fill(0);
  if (sndLoading) {
    sndLoading = 0;
    if (view.screen === 'slots') history.back();
  }
  if (view.screen === 'sound') {
    const first = $('sound').classList.contains('waiting');
    renderSound();
    // The controls just appeared: put focus on them so the next swipe does something.
    const a = document.activeElement;
    if (first || !a || a === document.body || a === $('soundTitle')) focusSound(view.focus);
  } else if (view.screen === 'bands') renderBands();
  else if (view.screen === 'slots') renderSlots(true);
}

// What you hear per band: preset + tone controls + fine-tune, as the phone computes it.
function soundCurve(s) {
  const base = (snd.presets && (snd.presets[s.preset] || snd.presets.Flat)) || Array(BAND_COUNT).fill(0);
  const w = snd.w || {};
  const wt = (k, i) => (w[k] ? w[k][i] || 0 : 0);
  return base.map((b, i) => {
    const g = b + s.bass * wt('bass', i) + s.mids * wt('mids', i) + s.treble * wt('treble', i)
      + s.clarity * wt('clarity', i) + (s.bands[i] || 0);
    return Math.max(-DB_RANGE, Math.min(DB_RANGE, g));
  });
}

function signedDb(v) {
  return `${v > 0 ? '+' : ''}${v} dB`;
}

function sliderText(c, v) {
  if (c.k === 'bal') return v === 0 ? 'Centre' : `${v < 0 ? 'Left' : 'Right'} ${Math.abs(v)}`;
  return c.db ? signedDb(v) : String(v);
}

function soundChanged() {
  sndEditAt = Date.now();
  if (view.screen === 'bands') renderBands(); else renderSound();
  clearTimeout(sndTimer);
  // One message per short pause in swiping, so the sound follows the slider almost at once.
  sndTimer = setTimeout(flushSound, 250);
}

function dropPendingSound() {
  clearTimeout(sndTimer);
  sndTimer = 0;
}

function flushSound() {
  if (!sndTimer) return;
  clearTimeout(sndTimer);
  sndTimer = 0;
  send('sndSet', { s: snd.s });
}

// Destructive buttons ask for a second pinch within three seconds.
function confirmTwice(btn, prompt, action) {
  const label = btn.querySelector('span') || btn;
  if (armed.has(btn.id)) {
    clearTimeout(armed.get(btn.id));
    armed.delete(btn.id);
    label.textContent = btn.dataset.label;
    action();
    return;
  }
  btn.dataset.label = btn.dataset.label || label.textContent;
  label.textContent = prompt;
  armed.set(btn.id, setTimeout(() => {
    armed.delete(btn.id);
    label.textContent = btn.dataset.label;
  }, 3000));
}

// ---- Sound screen

function buildSound() {
  const box = $('sndRows');
  box.textContent = '';
  const preset = document.createElement('div');
  preset.className = 'srow preset';
  preset.id = 'srow-preset';
  preset.tabIndex = 0;
  preset.setAttribute('role', 'slider');
  preset.setAttribute('aria-label', 'Preset. Swipe left or right to change.');
  preset.innerHTML = '<span class="lab">Preset</span><span class="pval"><span class="arrow" aria-hidden="true">‹</span><span class="pname"></span><span class="arrow" aria-hidden="true">›</span></span>';
  box.appendChild(preset);
  for (const c of SLIDERS) {
    const row = document.createElement('div');
    row.className = 'srow';
    row.id = `srow-${c.k}`;
    row.dataset.k = c.k;
    row.tabIndex = 0;
    row.setAttribute('role', 'slider');
    row.setAttribute('aria-label', `${c.label}. Swipe left or right to change.`);
    row.setAttribute('aria-valuemin', String(c.min));
    row.setAttribute('aria-valuemax', String(c.max));
    row.innerHTML = `<span class="lab">${c.label}</span><span class="track"><span class="mid"></span><span class="fill"></span><span class="knob"></span></span><span class="val"></span>`;
    if (c.min >= 0) row.querySelector('.mid').hidden = true;
    box.appendChild(row);
  }

  box.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('.srow');
    if (!row || !snd) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (row.id === 'srow-preset') stepPreset(dir);
      else stepSlider(row.dataset.k, dir);
    } else if (e.key === 'ArrowUp' && row.id === 'srow-preset') {
      // Up from Preset is On/Off, the first of the actions, for comparing in one swipe.
      e.preventDefault();
      $('sndPower').focus({ preventScroll: true });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (row.id === 'srow-preset') stepPreset(1);
      else soundNote('Swipe left or right to change it');
    }
  });
  preset.addEventListener('click', (e) => { if (e.detail && snd) stepPreset(1); });

  $('sndFine').addEventListener('click', () => { if (snd) openSub('bands', 'sndFine'); });
  $('sndSlots').addEventListener('click', () => { if (snd) openSub('slots', 'sndSlots'); });
  $('sndTest').addEventListener('click', () => {
    send('sndTest', { side: 'lr' });
    soundNote('Left speaker, then right');
  });
  $('sndReset').addEventListener('click', () => {
    if (!snd) return;
    if (!armed.has('sndReset')) soundNote('Pinch Reset again to go back to flat', 3000);
    confirmTwice($('sndReset'), 'Reset?', () => {
      sndNote = null;
      Object.assign(snd.s, { preset: 'Flat', bass: 0, mids: 0, treble: 0, clarity: 0, loud: 0, bal: 0, bands: Array(BAND_COUNT).fill(0) });
      soundChanged();
      flushSound();
      expectSound('Going back to flat…', (m) => m.s && m.s.preset === 'Flat', 'Back to flat');
      setTimeout(() => send('snd'), 600); // the phone answers with what it now plays
    });
  });
  $('sndPower').addEventListener('click', () => {
    if (!snd) return;
    snd.s.on = !snd.s.on;
    soundChanged();
    flushSound(); // on/off is for comparing, so it goes at once; the button and status say which
    const want = snd.s.on;
    expectSound(want ? 'Turning on…' : 'Turning off…', (m) => m.s && m.s.on === want);
    setTimeout(() => send('snd'), 600); // the phone answers with what it now plays
  });

  const freqs = $('freqs');
  freqs.textContent = '';
  ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'].forEach((f, i) => {
    const span = document.createElement('span');
    span.textContent = f;
    span.style.insetInlineStart = `${(curveX(i) / 540) * 100}%`;
    freqs.appendChild(span);
  });
}

function stepSlider(k, dir) {
  const c = SLIDERS.find((x) => x.k === k);
  const next = Math.max(c.min, Math.min(c.max, (snd.s[k] || 0) + dir));
  if (next === snd.s[k]) return;
  snd.s[k] = next;
  soundChanged();
}

function stepPreset(dir) {
  const names = Object.keys(snd.presets || {});
  if (!names.length) return;
  const i = (names.indexOf(snd.s.preset) + dir + names.length) % names.length;
  snd.s.preset = names[i];
  soundChanged();
}

function openSub(screen, from) {
  history.replaceState({ ...view, focus: from }, '');
  go({ screen });
}

function openSound() {
  askSound();
  renderSound();
  focusSound(view.focus);
}

// Where focus goes in Sound Lab: the remembered control, else Preset. With no sound from the phone yet
// there are no controls, so the heading holds focus until the sound arrives (receiveSound moves it on).
function focusSound(id) {
  if (!snd) { $('soundTitle').focus({ preventScroll: true }); return; }
  fitTools();
  const target = (id && $(id)) || $('srow-preset');
  target.focus({ preventScroll: true });
  if (target.classList.contains('srow')) reveal(target);
}

// The five actions share one row, measured with the PC's font. If the glasses' font is wider, the
// labels step down a size at a time (to 14 px at the least) rather than being cut.
function fitTools() {
  const bar = document.querySelector('.sndtools');
  if (!bar.offsetWidth) return;
  const cut = () => [...bar.querySelectorAll('span')].some((s) => s.scrollWidth > s.clientWidth + 0.5);
  for (let px = 17; px >= 14; px--) {
    bar.style.fontSize = `${px}px`;
    if (!cut()) return;
  }
}

// Sound Lab says things in its own header line, never in a message over the controls (on the
// see-through display overlapping text cannot be read).
let sndNote = null;    // { text, until }
let sndPending = null; // { doing, check(m), at }: sent, waiting for the phone's sound report to confirm
let sndConfirmed = null; // the settings in the phone's last sound report

function soundNote(text, ms = 2500) {
  sndNote = { text, until: Date.now() + ms };
  renderSoundStatus();
  setTimeout(renderSoundStatus, ms + 50);
}

// Said in the header until the phone's next sound report confirms it; after 7 s without one, says so.
function expectSound(doing, check, done) {
  sndPending = { doing, check, done, at: Date.now() };
  renderSoundStatus();
}

// True while the Sound Lab header shows something that needs the wearer (it keeps calm away).
let sndWarn = false;

function renderSoundStatus() {
  let text;
  let live = false;
  let warn = false;
  if (sndNote && Date.now() < sndNote.until) text = sndNote.text;
  else if (sndPending) {
    warn = Date.now() - sndPending.at >= 7000;
    text = warn ? 'Your phone did not confirm. Try again.' : sndPending.doing;
    if (Date.now() - sndPending.at > 12000) {
      // Never confirmed: the controls go back to what the phone last said it plays, so nothing here
      // claims a change that may not have happened.
      sndPending = null;
      if (snd && sndConfirmed) {
        snd.s = JSON.parse(JSON.stringify(sndConfirmed));
        if (view.screen === 'sound') renderSound();
        else if (view.screen === 'bands') renderBands();
      }
    }
  } else if (linkDownSince && Date.now() - linkDownSince > 5000) { text = 'Reconnecting…'; warn = true; }
  else if (!snd) {
    warn = !!(sndAsked && Date.now() - sndAsked > 7000);
    text = warn ? 'Your phone is not answering' : 'Asking your phone…';
  } else if (phoneSilent()) { text = 'Your phone is not answering'; warn = true; }
  // A broker's stored copy shows the last sound, but only the phone's own answer this visit is live.
  else if (!heardLive) text = 'Checking your phone…';
  else if (!snd.s.on) text = 'Off · Tidal plays as normal';
  else { text = snd.status || ''; live = !!snd.active; }
  sndWarn = warn;
  $('sndStateText').textContent = text;
  $('sndStateText').parentElement.classList.toggle('warn', warn);
  $('sndDot').classList.toggle('live', live && !warn);
  // Fine-tune and My sounds keep their hint in the same place, and show notes and confirmations there.
  const busy = (sndNote && Date.now() < sndNote.until) || sndPending;
  for (const id of ['bandsState', 'slotsState']) $(id).textContent = busy || warn ? text : $(id).dataset.default;
  if (warn) document.body.classList.remove('calm');
}

function renderSound() {
  renderSoundStatus();
  const sec = $('sound');
  sec.classList.toggle('waiting', !snd);
  sec.classList.toggle('off', !!(snd && !snd.s.on));
  // The switch shows the state (cyan, knob right = shaping Tidal); the label repeats it in words.
  const on = !!(snd && snd.s.on);
  const power = $('sndPower');
  power.classList.toggle('is-on', on);
  power.setAttribute('aria-pressed', on ? 'true' : 'false');
  power.setAttribute('aria-label', on ? 'Sound Lab is on. Pinch to turn it off and hear Tidal as normal.' : 'Sound Lab is off. Pinch to turn it on.');
  power.querySelector('.sw-knob').setAttribute('cx', on ? '21' : '9');
  power.querySelector('span').textContent = on ? 'On' : 'Off';
  if (!snd) return;
  const s = snd.s;
  $('srow-preset').querySelector('.pname').textContent = s.preset;
  for (const c of SLIDERS) {
    const row = $(`srow-${c.k}`);
    const v = s[c.k] || 0;
    const pos = (v - c.min) / (c.max - c.min);
    const zero = c.min < 0 ? 0.5 : 0;
    const fill = row.querySelector('.fill');
    fill.style.insetInlineStart = `${Math.min(pos, zero) * 100}%`;
    fill.style.inlineSize = `${Math.abs(pos - zero) * 100}%`;
    row.querySelector('.knob').style.insetInlineStart = `${pos * 100}%`;
    row.querySelector('.val').textContent = sliderText(c, v);
    row.setAttribute('aria-valuenow', String(v));
    row.setAttribute('aria-valuetext', sliderText(c, v));
  }
  // The bands the focused control moves are lit on the curve.
  const k = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.k;
  const w = k && snd.w && snd.w[k];
  drawCurve(soundCurve(s), w ? w.map((x) => x >= 0.5) : null);
}

function curveX(i) {
  return 16 + i * ((540 - 32) / (BAND_COUNT - 1));
}

function drawCurve(gains, hot) {
  const mid = 48; // the curve's box is 540 x 96 (index.html)
  const scale = (mid - 8) / 12; // ±12 dB fills the box; the rare ±15 may overhang a little
  const xs = gains.map((_, i) => curveX(i));
  const ys = gains.map((g) => mid - g * scale);
  // A smooth line through the ten points (Catmull-Rom as cubic Béziers).
  let d = `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
  for (let i = 0; i < xs.length - 1; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(xs.length - 1, i + 2);
    const c1x = xs[i] + (xs[i + 1] - xs[a]) / 6;
    const c1y = ys[i] + (ys[i + 1] - ys[a]) / 6;
    const c2x = xs[i + 1] - (xs[b] - xs[i]) / 6;
    const c2y = ys[i + 1] - (ys[b] - ys[i]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${xs[i + 1].toFixed(1)},${ys[i + 1].toFixed(1)}`;
  }
  $('curveLine').setAttribute('d', d);
  $('curveFill').setAttribute('d', `${d} L${xs[xs.length - 1].toFixed(1)},${mid} L${xs[0].toFixed(1)},${mid} Z`);
  const dots = $('curveDots');
  if (dots.childElementCount !== xs.length) {
    dots.textContent = '';
    xs.forEach(() => dots.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'circle')));
  }
  [...dots.children].forEach((dot, i) => {
    dot.setAttribute('cx', xs[i].toFixed(1));
    dot.setAttribute('cy', ys[i].toFixed(1));
    dot.setAttribute('r', hot && hot[i] ? '6' : '3.5');
    dot.classList.toggle('hot', !!(hot && hot[i]));
  });
}

// ---- Fine-tune: ten bands side by side; swipe left/right to pick, up/down to change

function openBands() {
  if (!snd) { history.back(); return; }
  const box = $('bandCols');
  if (!box.childElementCount) {
    (snd.freqs || []).forEach((f, i) => {
      const col = document.createElement('div');
      col.className = 'bcol';
      col.id = `band-${i}`;
      col.dataset.i = String(i);
      col.tabIndex = 0;
      col.setAttribute('role', 'slider');
      col.setAttribute('aria-orientation', 'vertical');
      col.setAttribute('aria-label', `${f} hertz. Swipe up or down to change.`);
      col.innerHTML = '<span class="bv"></span><span class="bt"><span class="mid"></span><span class="fill"></span><span class="knob"></span></span><span class="bf"></span><span class="bo"></span>';
      col.querySelector('.bf').textContent = f;
      box.appendChild(col);
    });
    box.addEventListener('keydown', (e) => {
      const col = e.target.closest && e.target.closest('.bcol');
      if (!col) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        const i = Number(col.dataset.i);
        const next = Math.max(-12, Math.min(12, (snd.s.bands[i] || 0) + (e.key === 'ArrowUp' ? 1 : -1)));
        if (next !== snd.s.bands[i]) { snd.s.bands[i] = next; soundChanged(); }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        soundNote('Swipe up or down to change this band');
      }
    });
  }
  renderBands();
  const target = (view.focus && $(view.focus)) || $('band-5');
  if (target) target.focus();
}

function renderBands() {
  if (!snd) return;
  const gains = soundCurve(snd.s);
  [...$('bandCols').children].forEach((col, i) => {
    const g = gains[i];
    const pos = (g + DB_RANGE) / (2 * DB_RANGE);
    const fill = col.querySelector('.fill');
    fill.style.insetBlockEnd = `${Math.min(pos, 0.5) * 100}%`;
    fill.style.blockSize = `${Math.abs(pos - 0.5) * 100}%`;
    col.querySelector('.knob').style.insetBlockStart = `${(1 - pos) * 100}%`;
    const shown = Math.round(g);
    col.querySelector('.bv').textContent = `${shown > 0 ? '+' : ''}${shown}`;
    const own = snd.s.bands[i] || 0;
    col.querySelector('.bo').textContent = own ? `${own > 0 ? '+' : ''}${own}` : '';
    col.setAttribute('aria-valuenow', String(shown));
    col.setAttribute('aria-valuetext', `${signedDb(shown)}${own ? `, tuned ${signedDb(own)}` : ''}`);
  });
}

// ---- My sounds: three save slots kept on the phone

function openSlots() {
  if (!snd) { history.back(); return; }
  renderSlots(false);
  const first = $('slotList').querySelector('button:not([disabled])');
  if (first) first.focus();
}

function renderSlots(keepFocus) {
  const list = $('slotList');
  const was = keepFocus && document.activeElement ? document.activeElement.id : null;
  list.textContent = '';
  (snd.slots || []).forEach((sl) => {
    const li = document.createElement('li');
    li.className = 'slot';
    li.innerHTML = '<span class="stext"><span class="sn"></span><span class="sd"></span></span>'
      + '<button class="pill-btn load"><span>Load</span></button><button class="pill-btn save"><span>Save here</span></button>';
    li.querySelector('.sn').textContent = `Sound ${sl.n}`;
    li.querySelector('.sd').textContent = sl.label || 'Empty';
    const load = li.querySelector('.load');
    const save = li.querySelector('.save');
    load.id = `slot-load-${sl.n}`;
    save.id = `slot-save-${sl.n}`;
    load.disabled = !sl.label;
    load.addEventListener('click', () => {
      dropPendingSound(); // the loaded sound replaces any unsent adjustment
      sndLoading = sl.n;
      send('sndLoad', { n: sl.n });
      expectSound(`Loading Sound ${sl.n}…`, () => true, `Sound ${sl.n} loaded`);
    });
    save.addEventListener('click', () => {
      const store = () => {
        // The sound travels with the save, so the two can never arrive out of order.
        dropPendingSound();
        send('sndSave', { n: sl.n, s: snd.s });
        expectSound(`Saving to Sound ${sl.n}…`, (m) => !!(m.slots && m.slots[sl.n - 1] && m.slots[sl.n - 1].label), `Saved as Sound ${sl.n}`);
      };
      if (sl.label) confirmTwice(save, 'Replace?', store);
      else store();
    });
    list.appendChild(li);
  });
  if (was && $(was)) $(was).focus();
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
  // Any swipe or pinch wakes the page from calm before anything else handles it.
  document.addEventListener('keydown', wakeUp, true);
  document.addEventListener('pointerdown', wakeUp, true);
  document.addEventListener('click', wakeUp, true);
  // From what the button shows, so a second tap before the phone answers undoes the first.
  $('toggle').addEventListener('click', () => press(shownPlaying() ? 'pause' : 'play'));
  $('prev').addEventListener('click', () => press('prev'));
  $('next').addEventListener('click', () => press('next'));
  $('like').addEventListener('click', () => press('like'));
  $('voldown').addEventListener('click', () => nudgeVolume(-1));
  $('volup').addEventListener('click', () => nudgeVolume(1));
  $('queue').addEventListener('click', openQueue);
  $('library').addEventListener('click', openLibraryRoot);
  $('soundBtn').addEventListener('click', () => openSub('sound', 'soundBtn'));
  buildSound();
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

  // Up and down in the scrolling lists: let the platform move focus, then repair (see repairSwipe).
  document.addEventListener('keydown', (e) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.defaultPrevented) return;
    const from = e.target;
    if (!listOf(from)) return;
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    if (atListEnd(from, dir)) {
      e.preventDefault();
      return;
    }
    setTimeout(() => repairSwipe(from, dir), 0);
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

  document.addEventListener('focusin', (e) => {
    if (view.screen === 'now') showTip(e.target);
    else if (view.screen === 'sound' && snd) renderSound();
  });

  window.addEventListener('popstate', onPopState);
  // The glasses' connection comes back after charging or a restart: reconnect at once.
  window.addEventListener('online', () => {
    if (visit) visit.onN = (visit.onN || 0) + 1; // each one restarts every link, so the report counts them
    if (document.visibilityState !== 'visible') return;
    closeLink();
    lastHello = 0;
    openLink();
    sayHello();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && view.screen !== ROOT.screen) { e.preventDefault(); history.back(); }
  });
  document.addEventListener('visibilitychange', onVisibility);
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
  history.replaceState(ROOT, '');
  wire();
  if (APP_MODE === 'sound') {
    document.title = 'Sound Lab';
    render(ROOT);
  } else {
    renderNow();
    focusDefault();
    registerVoiceTools();
  }
  watchBrowserBattery();
  // A late web font can change label widths after the first fit.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (view.screen === 'sound') fitTools(); });
  registerServiceWorker();
  if (document.visibilityState === 'visible') { startVisit('load'); openLink(); sayHello(); startTick(); }
}

main();
