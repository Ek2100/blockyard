// Small HTTP helpers built on the global fetch that ships with Electron's Node.
const fs = require('fs');
const { once } = require('events');

// PaperMC (and some others) reject requests without a descriptive User-Agent.
const UA = `Blockyard/${require('../../package.json').version} (+https://github.com/Ek2100/blockyard)`;

async function request(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
  } catch (e) {
    throw new Error(`Couldn't reach ${new URL(url).host}. Check your internet connection. (${e.cause?.code || e.message})`);
  }
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status} for ${url}`);
  return res;
}

async function getJSON(url) {
  return (await request(url, { headers: { Accept: 'application/json' } })).json();
}

async function getText(url) {
  return (await request(url)).text();
}

/** Stream a file to disk. onProgress(receivedBytes, totalBytes) is throttled. */
async function download(url, dest, onProgress) {
  const res = await request(url);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  let last = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
      const now = Date.now();
      if (onProgress && now - last > 150) { last = now; onProgress(got, total); }
    }
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.renameSync(tmp, dest);
  if (onProgress) onProgress(got, total || got);
  return dest;
}

module.exports = { UA, request, getJSON, getText, download };
