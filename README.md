<p align="center">
  <img src="build/icon.png" width="112" alt="Blockyard icon">
</p>

<h1 align="center">Blockyard</h1>

<p align="center">
  <b>Host a Minecraft server on your Mac, without the terminal.</b><br>
  Paper, Purpur, Fabric, Forge, NeoForge and Vanilla, with a console, players, plugins, stats, crossplay and public access in one window.
</p>

<p align="center">
  <a href="https://github.com/Ek2100/blockyard/releases/latest"><img alt="Download" src="https://img.shields.io/github/v/release/Ek2100/blockyard?label=download&color=2f9e44"></a>
  <img alt="macOS 13+ on Apple Silicon" src="https://img.shields.io/badge/macOS-13%2B%20·%20Apple%20Silicon-333">
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/github/license/Ek2100/blockyard?color=555"></a>
  <a href="https://github.com/Ek2100/blockyard/actions/workflows/ci.yml"><img alt="Tests" src="https://github.com/Ek2100/blockyard/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="https://github.com/Ek2100/blockyard/releases/latest"><b>⬇︎ Download for Mac</b></a>
</p>

![Blockyard showing a running Paper server's console](docs/screenshots/01-console.png)

Blockyard is a free app that runs the normal Minecraft server for you. It downloads the server and the right Java, starts it, and gives you buttons for everything you'd otherwise type. Your server stays a plain, standard Minecraft folder, so you can open it in any other tool or move it to a host later.

## Features

**Make a server in a minute.** Choose a fresh world, one of your singleplayer worlds, or a server folder you already have. Pick the software and version, say who's playing, and Blockyard sets up the rest, including Java.

**Turn a singleplayer world into a server.** Blockyard copies the world (your original is never touched), keeps its game mode and difficulty, and moves your inventory and position to your account so you spawn where you left off.

**Let friends join from anywhere.** Choose *Friends anywhere* and Blockyard opens the port on your router (UPnP / NAT-PMP), then checks from the internet that it worked. If your provider blocks incoming connections (Starlink, 4G/5G home internet), it sets up a free [playit.gg](https://playit.gg) tunnel instead.

**Bedrock crossplay.** One click installs Geyser and Floodgate, so friends on phones, tablets, Windows and consoles can join your Java server.

**Real performance numbers.** TPS and tick time are measured quietly in the background, using Paper's `tps`/`mspt` or vanilla's `tick query`. Charts show TPS, tick time, CPU, memory and players over the last 15 minutes, hour or 6 hours, and each player's playtime is tracked.

**Plugins and mods from Modrinth.** Search for your exact software and version, install with one click (required dependencies included, checksums verified), and update everything at once.

**Everything else you'd want:**
- Console with colour-coded warnings and errors, command history and quick commands
- Players: kick, ban, op, gamemode; whitelist, ops and ban lists
- File browser and editor, with drag-and-drop from Finder
- A form for `server.properties`
- World switching, resets with a new seed, and copying server worlds back to singleplayer
- Changing the Minecraft version safely, with a backup first and downgrades blocked
- Backups on demand or on a schedule, with one-click restore
- Auto-restart after a crash, daily restarts with warnings, scheduled commands
- Discord notifications, a log and crash-report viewer, a menu bar icon, and alerts when players join
- Keeps your Mac awake while a server runs, and stops servers cleanly when you quit

## Screenshots

| | |
|---|---|
| ![Players tab with four online players and moderation buttons](docs/screenshots/02-players.png) | ![Stats tab with TPS, tick time, CPU and memory charts](docs/screenshots/03-stats.png) |
| **Players**: kick, ban, op and manage lists | **Stats**: real TPS and tick time over time |
| ![Browsing Modrinth for Paper plugins](docs/screenshots/04-plugins.png) | ![Public Access showing the server reachable from the internet](docs/screenshots/05-public-access.png) |
| **Plugins & mods** straight from Modrinth | **Public Access** that tests itself |
| ![Bedrock crossplay settings with Wi-Fi and internet addresses](docs/screenshots/06-crossplay.png) | ![Worlds tab listing the server's worlds](docs/screenshots/07-worlds.png) |
| **Bedrock crossplay** with Geyser + Floodgate | **Worlds**: switch, reset, copy |
| ![New server wizard, first step](docs/screenshots/08-new-server.png) | ![Choosing a singleplayer world to turn into a server](docs/screenshots/09-import-world.png) |
| **New Server** wizard | **Bring in a singleplayer world** |

It follows your Mac's light or dark appearance:

![Stats tab in dark mode](docs/screenshots/dark-03-stats.png)

## Install

1. Download **Blockyard-x.y.z-arm64.zip** from the [latest release](https://github.com/Ek2100/blockyard/releases/latest) and unzip it.
2. Drag **Blockyard** into **Applications** and open it.
3. The first time, macOS says it can't check the app for malware, because Blockyard isn't notarized by Apple (that needs a paid developer account). Click **Done**, then open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to Blockyard. You only do this once.

If macOS says the app is "damaged", run this once in Terminal and open it again:

```sh
xattr -dr com.apple.quarantine /Applications/Blockyard.app
```

**Requirements:** a Mac with Apple Silicon (M1 or later) and macOS 13 Ventura or later. You don't need to install Java first.

**Updating:** Blockyard tells you when a new version is out (you can turn this off in ⚙︎ Settings). Download it and replace the app in Applications. Your servers and settings aren't touched.

## FAQ

**Is it really free?** Yes. It's open source under the MIT licence. There are no accounts, ads or paid features.

**Can a Mac run a Minecraft server well?** Yes. Apple Silicon Macs are fast at this. A few friends on Paper is comfortable on any M-series Mac with 8 GB of memory; give the server more memory for big modpacks.

**Does my Mac need to stay on?** Yes. The server runs on your Mac, so friends can only join while it's awake and Blockyard is running. Blockyard stops idle sleep while a server runs, but closing a MacBook's lid still sleeps it.

**Is opening a port safe?** The router only opens the Minecraft port, and only while the server is running. Keep `online-mode=true` (the default) and use the whitelist if you only want people you know. playit.gg avoids opening anything on your router.

**Can I use it with a server I already have?** Yes. Use **Import Existing…** and pick the folder. Blockyard detects the software, version, jar and port.

**Intel Macs, Windows or Linux?** Not at the moment. Blockyard is built and tested for Apple Silicon Macs only.

## Privacy

Blockyard has no analytics and no account. It only contacts outside services to do what you ask:

| Service | When |
|---|---|
| Mojang, PaperMC, Purpur, Fabric, Forge, NeoForge | Downloading server software and version lists |
| Adoptium | Downloading Java, if your Mac needs it |
| Modrinth, GeyserMC | Searching for and downloading plugins and mods, and crossplay |
| ipify / icanhazip | Finding your public IP for Public Access |
| mcstatus.io / mcsrvstat.us | **Test from Internet**: these services try to connect to your server's address |
| playit.gg | Only if you choose the playit.gg tunnel |
| mc-heads.net | Player head pictures in the Players and Stats tabs |
| Mojang API | Looking up a player's UUID when you import a world |
| Discord | Only if you add a webhook |
| GitHub | Checking for new Blockyard versions (can be turned off) |

## Where things live

- **Servers:** wherever you choose. The default is `~/Minecraft Servers/<name>`.
- **App data** (server list, stats, downloaded Java, playit agent, logs): `~/Library/Application Support/Blockyard/`
- **Logs:** Help → Show Blockyard Logs

## Building from source

You need Node.js 20+ and, for the tests, Java 21+.

```sh
git clone https://github.com/Ek2100/blockyard.git
cd blockyard
npm install
npm start            # run in development
npm test             # backend tests
npm run pack:mac     # builds dist/Blockyard-darwin-arm64/Blockyard.app
```

The UI tests drive the real app with fake servers, a fake router and mocked web services. They run headless on Linux in CI:

```sh
xvfb-run -a npx electron --no-sandbox test/ui-harness.js
```

The README screenshots are made the same way, with a demo server and made-up players:

```sh
xvfb-run -a -s "-screen 0 3000x2200x24" npx electron --no-sandbox scripts/screenshots/capture.js
SHOT_THEME=dark xvfb-run -a -s "-screen 0 3000x2200x24" npx electron --no-sandbox scripts/screenshots/capture.js
```

### Project layout

```
src/main/        Electron main process: servers, downloads, networking, backups, stats
src/preload.js   The bridge between the window and the main process (an allow-list of channels)
src/renderer/    The interface: plain DOM, no framework
test/            Backend tests, UI harnesses and fakes (Minecraft server, Forge installer, router, playit)
scripts/         Release notes and screenshot tooling
```

### Releasing

1. Bump `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Commit, then tag and push: `git tag v1.2.0 && git push --tags`.
3. GitHub Actions tests it, builds and ad-hoc signs the Apple Silicon app, and publishes a release with the zip and its SHA-256.

## Contributing

Bug reports and ideas are welcome in [Issues](https://github.com/Ek2100/blockyard/issues). Please include your Blockyard and macOS versions, and the log from Help → Show Blockyard Logs if something crashed. For pull requests, run `npm test` first.

## Licence

MIT. See [LICENSE](LICENSE).

Blockyard is not an official Minecraft product and is not approved by or associated with Mojang or Microsoft. Minecraft is a trademark of Mojang AB. Server software, plugins and mods are downloaded from their official sources and belong to their authors.
