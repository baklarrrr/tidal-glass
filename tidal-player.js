// TIDAL's own Player, unmodified (vendor/tidal-player/), with the sign-in this app already holds.
// It asks TIDAL what may play for this account, opens the stream (protected ones too, where the
// browser can) and keeps TIDAL's playback rules. The app's screens stay as they are: this file only
// offers them `window.TidalPlayer`. If the Player cannot load, the page keeps its plain audio element.
import * as Player from './vendor/tidal-player/index.js';

const heard = new Set();
let lastError = null;

Player.setCredentialsProvider({
  bus(listener) { heard.add(listener); },
  async getCredentials() {
    try {
      const c = await TidalAPI.credentials();
      return { clientId: c.clientId, requestedScopes: c.scopes, grantedScopes: c.scopes, token: c.token, userId: c.userId, expires: c.expires };
    } catch (e) {
      return { clientId: '', requestedScopes: [] }; // signed out: the Player then asks for nothing
    }
  },
});
// Play reporting to TIDAL is not wired yet (it needs TIDAL's event producer); nothing is sent.
Player.setEventSender({ sendEvent() {} });
Player.bootstrap({ outputDevices: false, players: [{ player: 'shaka', itemTypes: ['track'] }, { player: 'browser', itemTypes: ['track'] }] });
try { Player.setStreamingWifiAudioQuality('HIGH'); } catch (e) { /* the Player's own default stays */ }
Player.events.addEventListener('error', (e) => { lastError = e && e.detail ? e.detail : e; });

window.TidalPlayer = {
  version: (() => { try { return Player.getPlayerVersion(); } catch (e) { return ''; } })(),
  // Load one track and start it. Resolves with the media element that plays it.
  async start(id, sourceId) {
    lastError = null;
    await Player.load({ productId: String(id), productType: 'track', sourceId: String(sourceId || ''), sourceType: sourceId ? 'PLAYLIST' : '' }, 0);
    await Player.play();
    return Player.getMediaElement();
  },
  play: () => Player.play(),
  pause: () => Player.pause(),
  seek: (seconds) => Player.seek(seconds),
  stop: () => Player.reset(),
  state: () => { try { return Player.getPlaybackState(); } catch (e) { return 'IDLE'; } },
  context: () => { try { return Player.getPlaybackContext(); } catch (e) { return null; } },
  element: () => Player.getMediaElement(),
  // The Player's last error as a few characters, for the on-screen reason line.
  errorCode() {
    const e = lastError;
    if (!e) return '';
    return String(e.errorCode || e.errorId || e.code || e.message || e).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 24);
  },
  on(name, fn) { Player.events.addEventListener(name, fn); },
  // The sign-in changed (signed in again, or signed out): the Player reads the credentials afresh.
  credentialsChanged() { for (const fn of heard) { try { fn(new CustomEvent('message', { detail: { type: 'CredentialsUpdatedMessage' } })); } catch (e) { /* its own business */ } } },
};
window.dispatchEvent(new Event('tidalplayerready'));
