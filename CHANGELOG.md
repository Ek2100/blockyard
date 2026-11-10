# Changelog

## [2.0.1] - 2026-11-11

- Fixed: Blockyard 2.0.0 closed immediately when opened (on every platform). The app now starts its
  background work correctly.
- Every build is now launched for real before it's released, on Mac, Windows and Linux (Intel/AMD
  and ARM): it must open its window, load the interface, start a Minecraft server and stop it again.

## [2.0.0] - 2026-11-10

Blockyard 2: rewritten in Rust for Mac, Windows and Linux, with safe public access (whitelist on,
invites, clear warnings), sleep mode, modpacks, IPv6 and a new welcome screen.
