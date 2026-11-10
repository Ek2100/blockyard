#!/usr/bin/env node
// Prints the release notes for one version: its CHANGELOG.md section (if there is one) plus install steps.
// Usage: node scripts/release-notes.js 2.0.0
const fs = require('fs');
const path = require('path');

const version = (process.argv[2] || require('../package.json').version).replace(/^v/, '');
let section = '';
try {
  const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  const start = changelog.search(new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?`, 'm'));
  if (start >= 0) {
    const rest = changelog.slice(start);
    const next = rest.slice(1).search(/^## /m);
    section = (next < 0 ? rest : rest.slice(0, next + 1)).split('\n').slice(1).join('\n').trim();
  }
} catch { /* no changelog: that's fine */ }

process.stdout.write(`${section || `Blockyard ${version}.`}

## Download

| | |
|---|---|
| **Mac** (Apple Silicon and Intel) | \`Blockyard_${version}_universal.dmg\`: open it and drag Blockyard into Applications. |
| **Windows 10/11** (most PCs) | \`Blockyard_${version}_x64-setup.exe\` installs it, or \`Blockyard_${version}_x64-portable.exe\` runs without installing. |
| **Windows on ARM** (Snapdragon, Surface Pro X) | \`Blockyard_${version}_arm64-setup.exe\` or \`Blockyard_${version}_arm64-portable.exe\`. |
| **Linux** (most PCs) | \`Blockyard_${version}_amd64.AppImage\` (make it executable and run it), or \`Blockyard_${version}_amd64.deb\` for Ubuntu/Debian. |
| **Linux on ARM** (Raspberry Pi 5, ARM servers) | \`Blockyard_${version}_aarch64.AppImage\` or \`Blockyard_${version}_aarch64.deb\`. |

**First launch on Mac:** macOS says it can't check the app for malware, because Blockyard isn't notarized by Apple. Click **Done**, open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. You only do this once.

**First launch on Windows:** if SmartScreen says "Windows protected your PC", click **More info → Run anyway** (Blockyard isn't code-signed yet). When the first server starts, Windows asks whether Java may use the network: click **Allow**.

Each download has a \`.sha256\` checksum next to it.
`);
