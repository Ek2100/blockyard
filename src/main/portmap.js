// Automatic router port forwarding (NAT-PMP + UPnP IGD) and network diagnostics.
// No native dependencies: NAT-PMP is a tiny UDP protocol, UPnP is SSDP + SOAP over HTTP.
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const EventEmitter = require('events');
const { getJSON, getText, UA } = require('./net');

const run = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 5000 }, (err, out) => r(err ? '' : String(out))));

// ---------- address helpers ----------
const ipToInt = ip => ip.split('.').reduce((a, b) => (a << 8) + (+b), 0) >>> 0;
const inRange = (ip, base, bits) => /^\d+\.\d+\.\d+\.\d+$/.test(ip || '') && (ipToInt(ip) >>> (32 - bits)) === (ipToInt(base) >>> (32 - bits));
const isPrivate = ip => inRange(ip, '10.0.0.0', 8) || inRange(ip, '172.16.0.0', 12) || inRange(ip, '192.168.0.0', 16);
const isCgnat = ip => inRange(ip, '100.64.0.0', 10);

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}

/** Tailscale hands out 100.64/10 addresses on a utun interface. */
function tailscaleAddress() {
  return lanAddresses().find(a => isCgnat(a.address))?.address || null;
}

async function defaultRoute() {
  if (process.platform === 'darwin') {
    const out = await run('route', ['-n', 'get', 'default']);
    return { gateway: out.match(/gateway:\s*([\d.]+)/)?.[1] || null, iface: out.match(/interface:\s*(\S+)/)?.[1] || null };
  }
  const out = await run('ip', ['-4', 'route', 'show', 'default']);
  return { gateway: out.match(/via\s+([\d.]+)/)?.[1] || null, iface: out.match(/dev\s+(\S+)/)?.[1] || null };
}

/** The LAN IP of this Mac that the router sees. */
function localIpFor(iface, gateway) {
  const all = lanAddresses().filter(a => !isCgnat(a.address));
  const byIface = all.find(a => a.name === iface);
  if (byIface) return byIface.address;
  if (gateway) { const same = all.find(a => a.address.split('.').slice(0, 3).join('.') === gateway.split('.').slice(0, 3).join('.')); if (same) return same.address; }
  return all[0]?.address || null;
}

async function publicIP() {
  for (const url of ['https://api.ipify.org?format=json', 'https://api64.ipify.org?format=json']) {
    try { const ip = (await getJSON(url)).ip; if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip; } catch {}
  }
  try { const t = (await getText('https://icanhazip.com')).trim(); if (/^\d+\.\d+\.\d+\.\d+$/.test(t)) return t; } catch {}
  return null;
}

// ---------- NAT-PMP (RFC 6886) ----------
function udpRequest(host, port, payload, { tries = 3, firstTimeout = 250, validate } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let attempt = 0; let timer;
    const done = (err, msg) => { clearTimeout(timer); try { sock.close(); } catch {} err ? reject(err) : resolve(msg); };
    sock.on('error', e => done(e));
    sock.on('message', msg => { if (!validate || validate(msg)) done(null, msg); });
    const send = () => {
      if (attempt >= tries) return done(new Error('timeout'));
      const wait = firstTimeout * 2 ** attempt++;
      sock.send(payload, port, host, err => { if (err) done(err); });
      timer = setTimeout(send, wait);
    };
    sock.bind(0, send);
  });
}

const PMP_ERRORS = { 1: 'unsupported version', 2: 'not authorized (NAT-PMP is turned off on the router)', 3: 'network failure on the router', 4: 'router is out of resources', 5: 'unsupported opcode' };

async function pmpExternalIP(gateway, opts) {
  const msg = await udpRequest(gateway, opts?.pmpPort || 5351, Buffer.from([0, 0]), { ...opts, validate: m => m.length >= 12 && m[1] === 128 });
  const code = msg.readUInt16BE(2);
  if (code) throw new Error(`NAT-PMP: ${PMP_ERRORS[code] || 'error ' + code}`);
  return `${msg[8]}.${msg[9]}.${msg[10]}.${msg[11]}`;
}

async function pmpMap(gateway, { internalPort, externalPort, lifetime, protocol = 'tcp' }, opts) {
  const op = protocol === 'udp' ? 1 : 2;
  const buf = Buffer.alloc(12);
  buf[0] = 0; buf[1] = op;
  buf.writeUInt16BE(internalPort, 4); buf.writeUInt16BE(externalPort, 6); buf.writeUInt32BE(lifetime, 8);
  const msg = await udpRequest(gateway, opts?.pmpPort || 5351, buf, { ...opts, validate: m => m.length >= 16 && m[1] === 128 + op });
  const code = msg.readUInt16BE(2);
  if (code) throw new Error(`NAT-PMP: ${PMP_ERRORS[code] || 'error ' + code}`);
  return { internalPort: msg.readUInt16BE(8), externalPort: msg.readUInt16BE(10), lifetime: msg.readUInt32BE(12) };
}

// ---------- UPnP IGD ----------
const IGD_SERVICES = ['urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];

function ssdpDiscover({ timeout = 2500 } = {}) {
  return new Promise(resolve => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Set();
    const finish = () => { try { sock.close(); } catch {} resolve([...found]); };
    sock.on('error', finish);
    sock.on('message', msg => {
      const loc = String(msg).match(/^location:\s*(\S+)/im)?.[1];
      if (loc) found.add(loc);
    });
    sock.bind(0, () => {
      for (const st of ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2', ...IGD_SERVICES]) {
        const m = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
        sock.send(m, 1900, '239.255.255.250', () => {});
      }
    });
    setTimeout(finish, timeout);
  });
}

const tag = (xml, name) => xml.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'))?.[1]?.trim();

async function igdControl(location) {
  const xml = await getText(location);
  const base = tag(xml, 'URLBase') || location;
  for (const block of xml.match(/<service>[\s\S]*?<\/service>/gi) || []) {
    const type = tag(block, 'serviceType');
    if (IGD_SERVICES.includes(type)) {
      return { serviceType: type, controlURL: new URL(tag(block, 'controlURL'), base).toString(), location };
    }
  }
  return null;
}

class SoapError extends Error { constructor(code, desc) { super(`UPnP error ${code}: ${desc}`); this.code = code; } }

async function soap(svc, action, args = {}) {
  const body = `<?xml version="1.0"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${svc.serviceType}">${Object.entries(args).map(([k, v]) => `<${k}>${String(v).replace(/[<&]/g, c => (c === '<' ? '&lt;' : '&amp;'))}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  let res;
  try {
    res = await fetch(svc.controlURL, { method: 'POST', body, headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${svc.serviceType}#${action}"`, 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
  } catch (e) { throw new Error(`Router didn't answer UPnP (${e.cause?.code || e.message})`); }
  const text = await res.text();
  if (!res.ok) throw new SoapError(+(tag(text, 'errorCode') || res.status), tag(text, 'errorDescription') || `HTTP ${res.status}`);
  return text;
}

const UPNP_HINTS = {
  606: 'the router refused (UPnP control is restricted)',
  714: 'no such mapping',
  718: 'that port is already forwarded to another device',
  724: 'the router needs the same internal and external port',
  725: 'the router only supports permanent mappings',
};

// ---------- the mapper ----------
// TCP mappings keep the bare port as key (backwards compatible); UDP ones are 'udp:<port>'.
const mapKey = (port, protocol = 'tcp') => (protocol === 'udp' ? `udp:${port}` : port);

class PortMapper extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts; // test hooks: { gateway, lanIp, locations, pmpPort, timeout }
    this.mappings = new Map(); // port -> { via, externalIP, externalPort, lifetime, timer }
    this.igd = null;
  }

  async route() {
    if (this.opts.gateway) return { gateway: this.opts.gateway, lanIp: this.opts.lanIp || localIpFor(null, this.opts.gateway) };
    const r = await defaultRoute();
    return { gateway: r.gateway, lanIp: localIpFor(r.iface, r.gateway) };
  }

  async findIgd() {
    if (this.igd) return this.igd;
    const locations = this.opts.locations || await ssdpDiscover({ timeout: this.opts.timeout || 2500 });
    for (const loc of locations) {
      try { const svc = await igdControl(loc); if (svc) return (this.igd = svc); } catch {}
    }
    return null;
  }

  async viaPmp(gateway, port, lifetime, protocol = 'tcp') {
    const r = await pmpMap(gateway, { internalPort: port, externalPort: port, lifetime, protocol }, this.opts);
    const externalIP = await pmpExternalIP(gateway, this.opts).catch(() => null);
    return { via: 'NAT-PMP', externalIP, externalPort: r.externalPort, lifetime: r.lifetime };
  }

  async viaUpnp(svc, lanIp, port, description, protocol = 'tcp') {
    const P = protocol.toUpperCase();
    const add = lease => soap(svc, 'AddPortMapping', {
      NewRemoteHost: '', NewExternalPort: port, NewProtocol: P, NewInternalPort: port, NewInternalClient: lanIp,
      NewEnabled: 1, NewPortMappingDescription: description, NewLeaseDuration: lease,
    });
    let lifetime = 3600;
    try { await add(lifetime); } catch (e) {
      if (e.code === 725) { lifetime = 0; await add(0); }
      else if (e.code === 718) {
        // Already mapped. Fine if it points at us (e.g. left over from last time).
        const entry = await soap(svc, 'GetSpecificPortMappingEntry', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: P }).catch(() => '');
        if (tag(entry, 'NewInternalClient') !== lanIp) throw new Error(`Port ${port} is already forwarded to another device (${tag(entry, 'NewInternalClient') || 'unknown'}). Pick another port or remove that rule in your router.`);
        await soap(svc, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: P }).catch(() => {});
        await add(lifetime).catch(async err => { if (err.code === 725) { lifetime = 0; await add(0); } else throw err; });
      } else throw e;
    }
    const externalIP = tag(await soap(svc, 'GetExternalIPAddress').catch(() => ''), 'NewExternalIPAddress') || null;
    return { via: 'UPnP', externalIP, externalPort: port, lifetime };
  }

  /** Open a port (TCP for Java, UDP for Bedrock) on the router. Tries NAT-PMP first (fast), then UPnP. */
  async map(port, description = 'Blockyard Minecraft', protocol = 'tcp') {
    const key = mapKey(port, protocol);
    const { gateway, lanIp } = await this.route();
    if (!gateway) throw new Error("Couldn't find your router (no default gateway). Are you connected to a network?");
    const errors = [];
    let result = null;
    try { result = await this.viaPmp(gateway, port, 3600, protocol); } catch (e) { errors.push(`NAT-PMP: ${e.message.replace(/^NAT-PMP: /, '')}`); }
    if (!result) {
      const svc = await this.findIgd();
      if (!svc) errors.push('UPnP: no UPnP router answered');
      else {
        try { result = await this.viaUpnp(svc, lanIp, port, description, protocol); } catch (e) {
          errors.push(`UPnP: ${UPNP_HINTS[e.code] || e.message}`);
          if (/already forwarded/.test(e.message)) throw e;
        }
      }
    }
    if (!result) {
      const err = new Error(`Your router didn't accept automatic port forwarding. Turn on UPnP (or NAT-PMP) in your router's settings, or use playit.gg or manual port forwarding. (${errors.join('; ')})`);
      err.details = errors;
      throw err;
    }
    this.unschedule(port, protocol);
    const m = { ...result, port, protocol, gateway, lanIp, at: Date.now() };
    if (m.lifetime > 0) m.timer = setTimeout(() => this.map(port, description, protocol).catch(e => this.emit('error', port, e)), Math.max(30, m.lifetime / 2) * 1000);
    this.mappings.set(key, m);
    this.emit('mapped', port, this.info(port, protocol));
    return this.info(port, protocol);
  }

  info(port, protocol = 'tcp') {
    const m = this.mappings.get(mapKey(port, protocol));
    if (!m) return null;
    const { timer, ...rest } = m;
    return rest;
  }

  unschedule(port, protocol = 'tcp') { clearTimeout(this.mappings.get(mapKey(port, protocol))?.timer); }

  async unmap(port, protocol = 'tcp') {
    const key = mapKey(port, protocol);
    const m = this.mappings.get(key);
    if (!m) return;
    this.unschedule(port, protocol);
    this.mappings.delete(key);
    try {
      if (m.via === 'NAT-PMP') await pmpMap(m.gateway, { internalPort: port, externalPort: 0, lifetime: 0, protocol }, this.opts);
      else if (this.igd) await soap(this.igd, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: protocol.toUpperCase() });
    } catch {}
    this.emit('unmapped', port);
  }

  async unmapAll() { await Promise.all([...this.mappings.values()].map(m => this.unmap(m.port, m.protocol))); }

  /** What does the network look like? Used by the Public Access diagnostics. */
  async diagnose() {
    const { gateway, lanIp } = await this.route();
    const out = { gateway, lanIp, publicIP: null, routerIP: null, natpmp: false, upnp: false, nat: 'unknown', tailscale: tailscaleAddress(), firewall: 'unknown' };
    const [pub, pmpIp, svc, fw] = await Promise.all([
      publicIP(),
      gateway ? pmpExternalIP(gateway, this.opts).catch(() => null) : null,
      this.findIgd().catch(() => null),
      firewallState(),
    ]);
    out.publicIP = pub; out.natpmp = !!pmpIp; out.firewall = fw;
    let routerIP = pmpIp;
    if (svc) {
      out.upnp = true;
      routerIP ||= tag(await soap(svc, 'GetExternalIPAddress').catch(() => ''), 'NewExternalIPAddress') || null;
    }
    out.routerIP = routerIP;
    if (routerIP) {
      if (isCgnat(routerIP)) out.nat = 'cgnat';
      else if (isPrivate(routerIP)) out.nat = 'double';
      else if (pub && routerIP !== pub) out.nat = 'cgnat';
      else out.nat = 'ok';
    }
    return out;
  }
}

async function firewallState() {
  if (process.platform !== 'darwin') return 'unknown';
  const out = await run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']);
  if (/enabled/i.test(out)) return 'on';
  if (/disabled/i.test(out)) return 'off';
  return 'unknown';
}

/** Ask a public service to ping the server from the internet. */
async function testReachable(host, port) {
  const target = `${host}${port && port !== 25565 ? ':' + port : ''}`;
  try {
    const r = await getJSON(`https://api.mcsrvstat.us/3/${encodeURIComponent(target)}`);
    return { online: !!r.online, via: 'mcsrvstat.us', players: r.players || null, version: r.version || null, target };
  } catch {
    const r = await getJSON(`https://api.mcstatus.io/v2/status/java/${encodeURIComponent(target)}`);
    return { online: !!r.online, via: 'mcstatus.io', players: r.players || null, version: r.version?.name_clean || null, target };
  }
}

module.exports = { PortMapper, pmpMap, pmpExternalIP, igdControl, soap, publicIP, testReachable, tailscaleAddress, lanAddresses, isPrivate, isCgnat, defaultRoute };
