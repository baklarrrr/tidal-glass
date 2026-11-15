# TIDAL Player (vendored)

- Package: `@tidal-music/player` version 0.20.1, from the npm registry, copied unmodified
  (the built `dist/*.js` files; only the source-map comment lines were removed).
- Source: https://github.com/tidal-music/tidal-sdk-web (packages/player)
- License: Apache-2.0, © TIDAL Music AS. The bundle includes Shaka Player (Apache-2.0, © Google).
- Why it is here: TIDAL's developer rules ask third-party apps to play TIDAL content only through
  TIDAL's own, unmodified Player. `tidal-player.js` in the app folder is the only file that talks to it.
- To update: `npm install @tidal-music/player@<version>`, copy `dist/*.js` here, keep this note current.
