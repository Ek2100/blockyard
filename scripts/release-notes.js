#!/usr/bin/env node
// Prints the release notes for one version: its CHANGELOG.md section plus install steps.
// Usage: node scripts/release-notes.js 1.2.0
const fs = require('fs');
const path = require('path');

const version = (process.argv[2] || require('../package.json').version).replace(/^v/, '');
const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const start = changelog.search(new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?`, 'm'));
if (start < 0) { console.error(`No CHANGELOG.md section for ${version}`); process.exit(1); }
const rest = changelog.slice(start);
const next = rest.slice(1).search(/^## /m);
const section = (next < 0 ? rest : rest.slice(0, next + 1)).split('\n').slice(1).join('\n').trim();

process.stdout.write(`${section}

## Install

1. Download **Blockyard-${version}-arm64.zip** below and unzip it.
2. Drag **Blockyard** into **Applications**.
3. The first time, macOS says it can't check the app for malware. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. You only do this once.

Needs a Mac with Apple Silicon (M1 or later) and macOS 13 Ventura or later.
`);
