// A fake home router: NAT-PMP on UDP and a UPnP IGD (description XML + SOAP) on HTTP.
const dgram = require('dgram');
const http = require('http');

function startRouter({ externalIP = '203.0.113.7', pmpEnabled = true, upnpEnabled = true, upnpPermanentOnly = false, conflicts = {} } = {}) {
  const state = { pmpMaps: new Map(), upnpMaps: new Map(), externalIP, pmpEnabled, upnpEnabled, upnpPermanentOnly, conflicts, calls: [] };
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, rinfo) => {
    const op = msg[1];
    const res = Buffer.alloc(op === 0 ? 12 : 16);
    res[0] = 0; res[1] = 128 + op;
    res.writeUInt16BE(state.pmpEnabled ? 0 : 2, 2);
    res.writeUInt32BE(1234, 4);
    if (op === 0) state.externalIP.split('.').forEach((b, i) => { res[8 + i] = +b; });
    else {
      const internal = msg.readUInt16BE(4), external = msg.readUInt16BE(6), life = msg.readUInt32BE(8);
      state.calls.push(['pmp', op, internal, external, life]);
      if (state.pmpEnabled) { if (life === 0) state.pmpMaps.delete(internal); else state.pmpMaps.set(internal, { external, life }); }
      res.writeUInt16BE(internal, 8); res.writeUInt16BE(life === 0 ? 0 : external, 10); res.writeUInt32BE(life, 12);
    }
    udp.send(res, rinfo.port, rinfo.address);
  });

  const svcType = 'urn:schemas-upnp-org:service:WANIPConnection:1';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/rootDesc.xml') {
        res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
          <deviceList><device><deviceList><device><serviceList><service><serviceType>${svcType}</serviceType><serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId><controlURL>/ctl/IPConn</controlURL><eventSubURL>/evt/IPConn</eventSubURL><SCPDURL>/WANIPCnSCPD.xml</SCPDURL></service></serviceList></device></deviceList></device></deviceList></device></root>`);
        return;
      }
      if (req.method === 'POST' && req.url === '/ctl/IPConn') {
        const action = (req.headers.soapaction || '').replace(/"/g, '').split('#')[1];
        const arg = n => body.match(new RegExp(`<${n}>([^<]*)</${n}>`))?.[1];
        state.calls.push(['upnp', action, arg('NewExternalPort'), arg('NewLeaseDuration'), arg('NewInternalClient'), arg('NewProtocol')]);
        const fault = (code, desc) => { res.statusCode = 500; res.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`); };
        if (!state.upnpEnabled) return fault(606, 'Action not authorized');
        const ok = inner => res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${svcType}">${inner || ''}</u:${action}Response></s:Body></s:Envelope>`);
        const port = +arg('NewExternalPort');
        if (action === 'GetExternalIPAddress') return ok(`<NewExternalIPAddress>${state.externalIP}</NewExternalIPAddress>`);
        if (action === 'AddPortMapping') {
          if (state.upnpPermanentOnly && arg('NewLeaseDuration') !== '0') return fault(725, 'OnlyPermanentLeasesSupported');
          // A rule left behind by someone (maybe us last time) answers 718 until it's deleted.
          if (state.conflicts[port]) return fault(718, 'ConflictInMappingEntry');
          const existing = state.upnpMaps.get(port);
          if (existing && existing.client !== arg('NewInternalClient')) return fault(718, 'ConflictInMappingEntry');
          state.upnpMaps.set(port, { client: arg('NewInternalClient'), lease: +arg('NewLeaseDuration') });
          return ok();
        }
        if (action === 'GetSpecificPortMappingEntry') {
          const m = state.upnpMaps.get(port) || (state.conflicts[port] && { client: state.conflicts[port] });
          if (!m) return fault(714, 'NoSuchEntryInArray');
          return ok(`<NewInternalPort>${port}</NewInternalPort><NewInternalClient>${m.client}</NewInternalClient><NewEnabled>1</NewEnabled>`);
        }
        if (action === 'DeletePortMapping') { delete state.conflicts[port]; state.upnpMaps.delete(port); return ok(); }
        return fault(401, 'Invalid Action');
      }
      res.statusCode = 404; res.end();
    });
  });

  return new Promise(resolve => {
    udp.bind(0, '127.0.0.1', () => server.listen(0, '127.0.0.1', () => resolve({
      state, pmpPort: udp.address().port, location: `http://127.0.0.1:${server.address().port}/rootDesc.xml`,
      close: () => { udp.close(); server.close(); },
    })));
  });
}

module.exports = { startRouter };
