// Checks GitHub Releases for a newer Blockyard. No auto-install: Blockyard isn't notarized,
// so it only tells people a new version exists and opens the release page.
const REPO = 'Ek2100/blockyard';
const REPO_URL = `https://github.com/${REPO}`;
const RELEASES_URL = `${REPO_URL}/releases`;
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

// "v1.2.10" -> [1, 2, 10]; pre-release suffixes are ignored for ordering.
function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [+m[1], +(m[2] || 0), +(m[3] || 0)] : null;
}

function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// Picks the Apple Silicon zip from a release's assets, falling back to the release page.
function pickAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const zip = assets.find(a => /arm64.*\.zip$/i.test(a.name)) || assets.find(a => /\.(zip|dmg)$/i.test(a.name));
  return zip ? zip.browser_download_url : release?.html_url || RELEASES_URL;
}

function createUpdater({ currentVersion, fetchImpl = globalThis.fetch, userAgent, ttlMs = 6 * 3600e3, now = () => Date.now() }) {
  let cache = null; // { at, result }
  async function check({ force = false } = {}) {
    if (!force && cache && now() - cache.at < ttlMs) return cache.result;
    const res = await fetchImpl(API_LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': userAgent } });
    if (res.status === 404) {
      // No published release yet.
      const result = { current: currentVersion, latest: null, available: false, url: RELEASES_URL };
      cache = { at: now(), result };
      return result;
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}. Try again later.`);
    const rel = await res.json();
    if (rel.draft || rel.prerelease) {
      const result = { current: currentVersion, latest: null, available: false, url: RELEASES_URL };
      cache = { at: now(), result };
      return result;
    }
    const latest = String(rel.tag_name || rel.name || '').replace(/^v/i, '');
    const result = {
      current: currentVersion,
      latest,
      available: isNewer(latest, currentVersion),
      url: rel.html_url || RELEASES_URL,
      download: pickAsset(rel),
      notes: String(rel.body || '').slice(0, 4000),
      publishedAt: rel.published_at || null,
    };
    cache = { at: now(), result };
    return result;
  }
  return { check };
}

function issueUrl({ version, macos, arch }) {
  const body = [
    '**What happened?**', '', '', '**What did you expect?**', '', '',
    '**Steps to reproduce**', '1. ', '',
    '---', `Blockyard ${version} · macOS ${macos} · ${arch}`,
    'If it’s a crash, please attach the log from Help → Show Blockyard Logs.',
  ].join('\n');
  return `${REPO_URL}/issues/new?body=${encodeURIComponent(body)}`;
}

module.exports = { REPO, REPO_URL, RELEASES_URL, API_LATEST, parseVersion, isNewer, pickAsset, createUpdater, issueUrl };
