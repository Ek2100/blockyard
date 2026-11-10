# Changelog

All notable changes to Blockyard are listed here. Versions follow [semantic versioning](https://semver.org).

## [1.2.0] - 2026-11-10

The first public release.

### Create and import
- New Server wizard: start from a fresh world, a singleplayer world, or a server folder you already have, then choose the software, version and who's playing.
- Supports Paper, Purpur, Vanilla, Fabric, Forge and NeoForge, and downloads the right Java (Eclipse Temurin) when your Mac doesn't have it.
- Copies singleplayer worlds into servers. Game mode and difficulty are kept, and your inventory and position move to your account. Server worlds can also be copied back into singleplayer.

### Run and manage
- Console with colour-coded output, command history and quick commands.
- Players: kick, ban, op and gamemode, plus the whitelist, ops and ban lists.
- Files, `server.properties`, plugins and mods, worlds, backups and settings tabs.
- Modrinth search, one-click installs with dependencies and checksum checks, and an "update all" button.
- Safely change the Minecraft version, with a backup first and downgrades blocked.
- Backups on demand or on a schedule, with one-click restore.
- Auto-restart after a crash, daily restarts with warnings, scheduled commands and Discord notifications.
- A log and crash-report viewer, a menu bar icon, and notifications when players join or a server crashes.

### Stats
- Real TPS and tick time, from Paper's `tps`/`mspt` or vanilla's `tick query` (1.20.3+), measured in the background without filling the console.
- Charts of TPS, tick time, CPU, memory and players, with player playtime, peak players, uptime and crash counts.

### Public access and crossplay
- "Only my Wi-Fi" or "Friends anywhere": opens your router with UPnP / NAT-PMP, then tests from the internet.
- Falls back to a playit.gg tunnel when your provider blocks incoming connections.
- Manual port forwarding, Tailscale/ZeroTier and a network check under Advanced.
- One-click Bedrock crossplay with Geyser and Floodgate, including the Bedrock UDP port or a Bedrock playit tunnel.

### App
- Apple Silicon only (macOS 13 Ventura or later).
- Checks GitHub for new versions; you can turn this off in Settings.
- Help → Report a Problem opens a pre-filled GitHub issue.
- Only one copy of the app runs at a time, and servers left running after an unexpected quit are found and stopped safely.
