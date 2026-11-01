# Tidal Glass

<sub>BAKAR STUDIO / WEARABLE EXPERIMENTS</sub>

A web interface for Meta Ray-Ban Display that shows what TIDAL is playing on a paired phone and sends controls back to the phone companion.

It explores music controls that can fit a small wearable display: now-playing information, previous/next, seeking, volume, queue and library views. Sound Lab adds an interface for phone-side sound settings.

[Hosted page](https://baklarrrr.github.io/tidal-glass/) | [Sound Lab entry](https://baklarrrr.github.io/tidal-glass/sound/) | [Bakar Studio](https://bakar.ca/)

## Current status

This repository contains the **web half of a paired-phone companion**. Playback, library access and sound changes depend on the separate Android companion and the official TIDAL app on the phone. The web page does not supply audio streaming or a phone app build.

The source includes connection freshness, reconnect handling and pending-seek state. Physical Neural Band cadence, device clock behavior, phone reply timing and full Sound Lab behavior require device checks. A browser test does not establish that an effect works on a particular phone or audio session.

## Preview locally

Prerequisites: Git, Python 3 and a current browser. Files are served directly from the repository root; no Node install or build step is needed.

```sh
git clone https://github.com/baklarrrr/tidal-glass.git
cd tidal-glass
python -m http.server 8000 --bind 127.0.0.1
```

Open <http://127.0.0.1:8000/> in a fresh browser profile without pairing information. The unpaired screen says **Not paired with your phone yet**. It is a setup preview, with no bundled tracks or demonstration account. Stop the server with Ctrl+C.

The `sound/` entry redirects to the same application in Sound Lab mode, carrying its URL fragment. It needs the same phone connection for actual sound settings.

## Connected use

Use the existing Tidal Glass companion on the phone paired with the glasses, then its **Put Tidal on my glasses** action. Connected use also needs TIDAL set up on that phone and network access for the MQTT connection and the services the phone uses.

The Android companion is not included in this public checkout, so there is no Android build or installation command here. Pairing contains a topic and key in the URL fragment and is saved as `tg.pair` in the page's local storage. Treat it as private. A fresh local preview cannot inherit the installed glasses app's connection.

## Browser checks

The included suites require Python, Playwright and an installed Google Chrome. Press tests use Pillow; light measurements also use NumPy. In a local virtual environment:

```sh
python -m pip install playwright pillow numpy
```

With a loopback server running from this repository root as above, use a second terminal in the same directory:

```sh
python tests/link_test.py http://127.0.0.1:8000/
python tests/press_test.py http://127.0.0.1:8000/
```

These use synthetic phone state or a fake broker; their fixtures are not evidence of playback on real glasses. The optional light measurement command is `python tests/light_measure.py ../tidal-light http://127.0.0.1:8000/`; it writes browser measurement artifacts outside the app. This README update does not report a new test run. Older test-file comments refer to a parent `webapp/` layout; this public repository's app and `tests/` are at its root.

## Privacy and credits

The web app exchanges AES-GCM messages with the companion through three public MQTT brokers. Brokers relay ciphertext but can still observe topic names and traffic timing. Pairing data and a visit record are saved in browser storage; the visit report is sent to the paired companion. This is not an independent privacy audit of the phone app. Do not publish pairing links, keys, private listening records or companion logs.

Personal project by [Bakar Studio](https://bakar.ca/), independent of TIDAL and Meta. Music, artwork and service access remain subject to their respective providers' terms. The vendored [MQTT.js](https://github.com/mqttjs/MQTT.js) library retains its [MIT license and contributor credits](vendor/mqtt-LICENSE.md); that license does not assign a license to the rest of this application.
