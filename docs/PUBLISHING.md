# Publishing Blockyard on GitHub

A checklist for putting this repository online and making the first release.

## 1. Create the repository

On github.com, create a new **public** repository named `blockyard` under `Ek2100`. Leave it empty: don't add a README, licence or .gitignore, because this folder already has them.

Then, in this folder:

```sh
git remote add origin https://github.com/Ek2100/blockyard.git
git push -u origin main
```

If you use a different repository name or account, search the project for `Ek2100/blockyard` and replace it. It appears in `package.json`, `README.md`, `src/main/updates.js` and `src/main/net.js`.

## 2. Fill in the About box

On the repository page, click the ⚙︎ next to **About**:

- **Description:** Host a Minecraft server on your Mac without the terminal. Paper, Fabric, Forge, NeoForge and more, with a console, players, plugins, stats, crossplay and public access.
- **Website:** leave empty, or use the releases page: `https://github.com/Ek2100/blockyard/releases/latest`
- **Topics:** `minecraft` `minecraft-server` `macos` `apple-silicon` `electron` `papermc` `fabric` `forge` `neoforge` `geyser` `server-manager` `gui`
- Untick **Packages** and **Deployments**; keep **Releases**.

## 3. Social preview

**Settings → General → Social preview → Edit → Upload an image** and choose `docs/social-preview.png`. This is the picture shown when the link is shared on Discord, Reddit or X.

## 4. Make the first release

GitHub Actions builds the Mac app for you on GitHub's Apple Silicon machines:

```sh
git tag v1.2.0
git push origin v1.2.0
```

Open the **Actions** tab to watch it. When it finishes (about 5 minutes), the release appears under **Releases** with `Blockyard-1.2.0-arm64.zip`, its SHA-256 checksum, and notes taken from `CHANGELOG.md`.

If you'd rather upload a zip you built yourself: **Releases → Draft a new release**, choose the tag `v1.2.0`, paste the output of `node scripts/release-notes.js 1.2.0` as the description, and attach the zip. Name it `Blockyard-1.2.0-arm64.zip` so the in-app update check finds it.

## 5. Later releases

1. Bump `version` in `package.json`.
2. Add a `## [x.y.z] - date` section at the top of `CHANGELOG.md`.
3. Commit, push, then tag `vx.y.z` and push the tag.

The release workflow refuses to run if the tag and `package.json` disagree. Copies of Blockyard that people already have will show "Blockyard x.y.z is out" in the sidebar within a day.

## Optional

- **Donations:** create `.github/FUNDING.yml` with, for example, `ko_fi: yourname` or `github: Ek2100` to add a Sponsor button.
- **Notarization:** with a paid Apple Developer account ($99/year), the release workflow can sign with a Developer ID and notarize the app, so the "Open Anyway" step disappears. That needs your certificate and an app-specific password stored as repository secrets.
