# Changelog

All notable changes to this project are documented in this file.

## [2.0.0.0] - 2026-09-01

### Added

- Authoritative Node.js and Socket.IO multiplayer rooms for one host and up to eight local-network players.
- Live synchronized boards, server-ordered buzzing, host scoring, Daily Doubles, private Final Jeopardy submissions, and final standings.
- Resumable host and player sessions with active-tab takeover and safe reconnect behavior.
- A replacement library of 20 original medium-difficulty games with 600 board clues, 20 Daily Doubles, and 20 Finals.
- Automated game-bank, room-engine, privacy, reconnect, authorization, and multi-client integration coverage.

### Changed

- Rebuilt the landing and room lobby around a dense, responsive, Lichess-inspired game browser.
- Split the warm charcoal lobby palette from the cobalt-and-gold board presentation.
- Improved mobile ordering, bounded game lists, touch targets, keyboard focus handling, dialog focus trapping, and screen-reader labels.
- Moved hidden responses and authoritative game state to the server so player clients receive only role-appropriate data.
- Expanded the README with setup, LAN hosting, player instructions, architecture, question-bank schema, and troubleshooting guidance.

### Fixed

- Kept reconnect credentials valid when a resume acknowledgement is lost.
- Rejected buzzes on the server while the host is offline.
- Immediately locked Final Jeopardy forms after keyboard or button submission.
- Corrected clue wording, difficulty inversions, answer giveaways, and repeated concepts found during the final content audit.

### Removed

- The old browser-bundled game bank and its backup copies.
