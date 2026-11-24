# CW Station

A browser-based Morse code (CW) station: key with a straight key or paddles, decode what you hear, and talk to other operators live.

**Live site: <https://cw-station.deploynest.at>**

## Features

- **Rooms:** General (shared band with other operators), Echo (your own keying played back), Practice (band and decoder only) and Training.
- **Keyer and decoder:** straight key and paddle keying, with a live decoder and a sidetone.
- **Rig:** adjustable WPM, pitch, volume, tuning and receive filter, with a waterfall and band scan.
- **Paddle training:** Koch, Farnsworth and Alphabetical methods, answered on the paddle.
- **Online list and chat:** see who is on and what they are doing, and chat across all rooms.
- **Logbook:** save contacts and notes to your callsign.
- **Accounts:** any callsign works as a guest, or claim it with a password.

Live CW and chat are relayed in memory and are not stored.

## Stack

PHP 8.4 and SQLite for accounts, sessions and logbooks, a small Python relay for live traffic over a Unix socket, and plain JavaScript in the browser. Production runs on Debian with Caddy.

## Layout

- `public/`: the web root (page, API and browser code)
- `src/`: application state and the chat relay
- `deploy/`: systemd socket and service units

## Feedback

Found a bug? Use the Report bug button in the app, or open an issue on [GitHub](https://github.com/monkeCoding06/cw-station/issues).
