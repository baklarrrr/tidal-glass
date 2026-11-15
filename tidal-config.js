// The one value TIDAL Glass needs before it can show a TIDAL library.
//
// It is the "Client ID" of an app created at https://developer.tidal.com (Dashboard -> Create new app),
// signed in with the owner's own TIDAL account. A client ID is public by design: this app signs in
// with "authorization code + PKCE", which needs no client secret. Never put a client secret, a token
// or a password in this file.
//
// In the TIDAL developer app, register this redirect URL exactly (with the trailing slash):
//   https://baklarrrr.github.io/tidal-glass/
// and switch on the scopes listed in TIDAL_SCOPES below.
//
// While this stays empty the app opens on a plain first screen and nothing contacts TIDAL.
window.TIDAL_CLIENT_ID = '';

// What the app asks TIDAL for at sign-in: who you are, your collection, your playlists, search,
// and playback. Read only; nothing is added, removed or changed in the TIDAL account.
window.TIDAL_SCOPES = 'user.read collection.read playlists.read search.read playback';
