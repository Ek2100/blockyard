// Minimal, lossless NBT (Minecraft "Named Binary Tag") reader/writer for level.dat and playerdata.
// Values are kept as { type, value } so a read → write round trip is byte-for-byte faithful.
const zlib = require('zlib');

const T = { End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6, ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12 };

// Java "modified UTF-8": NUL is 0xC0 0x80 and characters outside the BMP are encoded as surrogate pairs.
function mutf8Decode(buf) {
  let out = '';
  for (let i = 0; i < buf.length;) {
    const a = buf[i++];
    if (a < 0x80) out += String.fromCharCode(a);
    else if ((a & 0xe0) === 0xc0) out += String.fromCharCode(((a & 0x1f) << 6) | (buf[i++] & 0x3f));
    else { const b = buf[i++], c = buf[i++]; out += String.fromCharCode(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f)); }
  }
  return out;
}
function mutf8Encode(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i); // UTF-16 code unit, so surrogates are encoded separately, as Java does
    if (c >= 1 && c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(bytes);
}

function readPayload(buf, pos, type) {
  switch (type) {
    case T.Byte: return [buf.readInt8(pos), pos + 1];
    case T.Short: return [buf.readInt16BE(pos), pos + 2];
    case T.Int: return [buf.readInt32BE(pos), pos + 4];
    case T.Long: return [buf.readBigInt64BE(pos), pos + 8];
    case T.Float: return [buf.readFloatBE(pos), pos + 4];
    case T.Double: return [buf.readDoubleBE(pos), pos + 8];
    case T.ByteArray: { const n = buf.readInt32BE(pos); return [Buffer.from(buf.subarray(pos + 4, pos + 4 + n)), pos + 4 + n]; }
    case T.String: { const n = buf.readUInt16BE(pos); return [mutf8Decode(buf.subarray(pos + 2, pos + 2 + n)), pos + 2 + n]; }
    case T.List: {
      const itemType = buf.readInt8(pos); const n = buf.readInt32BE(pos + 1); pos += 5;
      const items = [];
      for (let i = 0; i < n; i++) { let v; [v, pos] = readPayload(buf, pos, itemType); items.push(v); }
      return [{ itemType, items }, pos];
    }
    case T.Compound: {
      const map = new Map();
      for (;;) {
        const t = buf.readInt8(pos++);
        if (t === T.End) break;
        let name; [name, pos] = readPayload(buf, pos, T.String);
        let v; [v, pos] = readPayload(buf, pos, t);
        map.set(name, { type: t, value: v });
      }
      return [map, pos];
    }
    case T.IntArray: { const n = buf.readInt32BE(pos); const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = buf.readInt32BE(pos + 4 + i * 4); return [a, pos + 4 + n * 4]; }
    case T.LongArray: { const n = buf.readInt32BE(pos); const a = new BigInt64Array(n); for (let i = 0; i < n; i++) a[i] = buf.readBigInt64BE(pos + 4 + i * 8); return [a, pos + 4 + n * 8]; }
    default: throw new Error(`Unknown NBT tag type ${type} at byte ${pos}`);
  }
}

function writePayload(out, type, v) {
  const b = n => { const x = Buffer.alloc(n); out.push(x); return x; };
  switch (type) {
    case T.Byte: b(1).writeInt8(v); break;
    case T.Short: b(2).writeInt16BE(v); break;
    case T.Int: b(4).writeInt32BE(v); break;
    case T.Long: b(8).writeBigInt64BE(BigInt(v)); break;
    case T.Float: b(4).writeFloatBE(v); break;
    case T.Double: b(8).writeDoubleBE(v); break;
    case T.ByteArray: b(4).writeInt32BE(v.length); out.push(Buffer.from(v)); break;
    case T.String: { const s = mutf8Encode(v); b(2).writeUInt16BE(s.length); out.push(s); break; }
    case T.List: { const h = b(5); h.writeInt8(v.items.length ? v.itemType : (v.itemType || 0), 0); h.writeInt32BE(v.items.length, 1); for (const it of v.items) writePayload(out, v.itemType, it); break; }
    case T.Compound:
      for (const [name, tag] of v) { b(1).writeInt8(tag.type); writePayload(out, T.String, name); writePayload(out, tag.type, tag.value); }
      b(1).writeInt8(T.End);
      break;
    case T.IntArray: { const x = b(4 + v.length * 4); x.writeInt32BE(v.length, 0); v.forEach((n, i) => x.writeInt32BE(n, 4 + i * 4)); break; }
    case T.LongArray: { const x = b(4 + v.length * 8); x.writeInt32BE(v.length, 0); v.forEach((n, i) => x.writeBigInt64BE(BigInt(n), 4 + i * 8)); break; }
    default: throw new Error(`Can't write NBT tag type ${type}`);
  }
}

/** Parse NBT (gzip/zlib-compressed or raw). Returns { name, root } where root is a compound Map. */
function parse(data) {
  let buf = Buffer.from(data);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  else if (buf[0] === 0x78) { try { buf = zlib.inflateSync(buf); } catch {} }
  if (buf.readInt8(0) !== T.Compound) throw new Error('Not an NBT file (root is not a compound).');
  const [name, p] = readPayload(buf, 1, T.String);
  const [root] = readPayload(buf, p, T.Compound);
  return { name, root };
}

/** Serialize to gzip-compressed NBT, as Minecraft writes level.dat and playerdata. */
function write({ name = '', root }) {
  const out = [Buffer.from([T.Compound])];
  writePayload(out, T.String, name);
  writePayload(out, T.Compound, root);
  return zlib.gzipSync(Buffer.concat(out));
}

/** Follow a path of compound keys: get(root, 'Data', 'Version', 'Name') → raw value or undefined. */
function get(compound, ...keys) {
  let cur = { type: T.Compound, value: compound };
  for (const k of keys) {
    if (!cur || cur.type !== T.Compound) return undefined;
    cur = cur.value.get(k);
  }
  return cur?.value;
}

/** Convert Minecraft's int-array UUID (4 ints) to a dashed UUID string. */
function uuidFromInts(arr) {
  const hex = [...arr].map(n => (n >>> 0).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const dashUuid = id => String(id).replace(/-/g, '').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

module.exports = { T, parse, write, get, uuidFromInts, dashUuid, mutf8Decode, mutf8Encode };
