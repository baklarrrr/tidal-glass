'use strict';

// Signing in to TIDAL for the glasses, done on a phone.
//
// The glasses' browser will not leave the app for TIDAL's sign-in page, and nobody should type a
// password on glasses. So the glasses show a short code; a phone opens link/ on this site, takes the
// code, and does the TIDAL sign-in there (Face ID, a saved password). TIDAL sends the phone back
// here with a one-time answer, and the phone passes that answer to the glasses.
//
// What travels between the two, over the public message brokers this app already uses:
//   glasses -> phone:  the PKCE challenge and the state (both are meant to be public)
//   phone -> glasses:  TIDAL's one-time authorization code
// The code is useless without the PKCE verifier, which is made on the glasses and never leaves
// them; the glasses alone can turn it into a sign-in. No token, password or secret is ever sent.
// The pairing code only names the meeting place; it runs out after ten minutes.
const TidalHandoff = (() => {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: read once off a small display
  const CODE_LENGTH = 8;
  const MAX_AGE = 10 * 60 * 1000;
  const RETURN_KEY = 'tg.tidal.handoff.v1';
  const AUTHORIZE = 'https://login.tidal.com/authorize';
  const BROKERS = [
    { url: 'wss://broker.emqx.io:8084/mqtt' },
    { url: 'wss://broker.hivemq.com:8884/mqtt' },
    { url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' },
  ];

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    let out = '';
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    return out;
  }
  // What a person typed, as the code it means: case, spaces and dashes do not matter; O and I are
  // read as the digits they are mistaken for.
  function cleanCode(text) {
    const s = String(text || '').toUpperCase().replace(/O/g, '0').replace(/I/g, '1').replace(/[^A-Z0-9]/g, '');
    const fixed = s.replace(/0/g, 'Q').replace(/1/g, 'L'); // neither digit is in the alphabet; never guess silently
    return s.length === CODE_LENGTH && s === fixed && [...s].every((c) => ALPHABET.includes(c)) ? s : '';
  }
  function showCode(code) { return code.slice(0, 4) + ' ' + code.slice(4); }

  async function topicOf(code) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('tidal-glass sign-in ' + code)));
    return [...hash.slice(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function loadMqtt(base) {
    if (typeof mqtt !== 'undefined') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = base + 'vendor/mqtt.min.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('link library'));
      document.head.appendChild(s);
    });
  }

  // One meeting place. role 'g' (glasses) hears 'p' (phone) and the other way round.
  // Returns { send(obj), close(), live() }. onMessage gets each parsed message once per broker.
  async function meet(code, role, onMessage, base = '') {
    await loadMqtt(base);
    const topic = await topicOf(code);
    const mine = `tgsi/${topic}/${role}`;
    const theirs = `tgsi/${topic}/${role === 'g' ? 'p' : 'g'}`;
    const clients = [];
    let closed = false;
    for (const b of BROKERS) {
      let client;
      try {
        client = mqtt.connect(b.url, {
          username: b.username, password: b.password, clean: true, keepalive: 30, connectTimeout: 8000, reconnectPeriod: 2500,
          clientId: 'tgsi-' + role + '-' + Math.random().toString(36).slice(2, 12),
        });
      } catch (e) { continue; }
      client.on('connect', () => { if (!closed) client.subscribe(theirs, { qos: 1 }); });
      client.on('message', (t, payload) => {
        if (closed || t !== theirs) return;
        let msg = null;
        try { msg = JSON.parse(String(payload)); } catch (e) { return; }
        if (msg && typeof msg === 'object' && typeof msg.t === 'string') onMessage(msg);
      });
      client.on('error', () => {});
      clients.push(client);
    }
    return {
      send(obj) {
        const body = JSON.stringify(obj);
        for (const c of clients) if (c.connected) { try { c.publish(mine, body, { qos: 1 }); } catch (e) { /* the next send repeats it */ } }
      },
      live() { return clients.some((c) => c.connected); },
      close() { closed = true; for (const c of clients) { try { c.end(true); } catch (e) { /* gone already */ } } },
    };
  }

  function clientId() {
    const id = typeof window.TIDAL_CLIENT_ID === 'string' ? window.TIDAL_CLIENT_ID.trim() : '';
    return /^[A-Za-z0-9._~-]{4,128}$/.test(id) ? id : '';
  }

  // TIDAL's sign-in address for an offer made on the glasses.
  function authorizeUrl(offer) {
    const url = new URL(AUTHORIZE);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId(),
      redirect_uri: offer.ru,
      scope: offer.sc,
      code_challenge_method: 'S256',
      code_challenge: offer.ch,
      state: offer.st,
    }).toString();
    return url.href;
  }

  // An offer is only followed when it is shaped like one and sends TIDAL's answer back to this site.
  function validOffer(o, appFolder) {
    return !!o && o.t === 'offer' && /^[A-Za-z0-9_-]{43}$/.test(o.ch || '') && /^[A-Za-z0-9_-]{16,128}$/.test(o.st || '')
      && o.ru === appFolder && typeof o.sc === 'string' && /^[a-z_. ]{1,200}$/.test(o.sc);
  }

  // The phone remembers which code it is working for while TIDAL has the tab.
  function remember(code, state) {
    try { localStorage.setItem(RETURN_KEY, JSON.stringify({ code, state, at: Date.now() })); return true; } catch (e) { return false; }
  }
  function remembered() {
    try {
      const v = JSON.parse(localStorage.getItem(RETURN_KEY) || 'null');
      return v && typeof v.code === 'string' && typeof v.state === 'string' && Date.now() - v.at < MAX_AGE ? v : null;
    } catch (e) { return null; }
  }
  function forget() { try { localStorage.removeItem(RETURN_KEY); } catch (e) { /* nothing kept */ } }

  // On the app's own page: TIDAL has sent a phone back with an answer meant for the glasses.
  // Pass the visit on to link/, which delivers it. True when this visit is leaving.
  function passReturnOn() {
    const q = new URLSearchParams(location.search);
    const kept = remembered();
    if (!kept || !(q.has('code') || q.has('error')) || q.get('state') !== kept.state) return false;
    location.replace('link/' + location.search);
    return true;
  }

  return { MAX_AGE, newCode, cleanCode, showCode, meet, authorizeUrl, validOffer, remember, remembered, forget, passReturnOn, clientId };
})();

// Only the app's own page loads this file before its other scripts; link/ sets the flag to stay put.
if (!window.TIDAL_LINK_PAGE) window.__tgHandoffReturn = TidalHandoff.passReturnOn();
