//! Minimal, lossless NBT ("Named Binary Tag") reader/writer for level.dat and playerdata files.
//! Compound entries keep their order, so read → write is byte-for-byte faithful (after decompression).
use crate::Result;
use flate2::{read::GzDecoder, read::ZlibDecoder, write::GzEncoder, Compression};
use std::io::{Read, Write};

#[derive(Debug, Clone, PartialEq)]
pub enum Tag {
    Byte(i8),
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    ByteArray(Vec<i8>),
    String(String),
    List(u8, Vec<Tag>),
    Compound(Vec<(String, Tag)>),
    IntArray(Vec<i32>),
    LongArray(Vec<i64>),
}

impl Tag {
    pub fn id(&self) -> u8 {
        match self {
            Tag::Byte(_) => 1, Tag::Short(_) => 2, Tag::Int(_) => 3, Tag::Long(_) => 4, Tag::Float(_) => 5, Tag::Double(_) => 6,
            Tag::ByteArray(_) => 7, Tag::String(_) => 8, Tag::List(..) => 9, Tag::Compound(_) => 10, Tag::IntArray(_) => 11, Tag::LongArray(_) => 12,
        }
    }
    /// Child of a compound by name.
    pub fn get(&self, key: &str) -> Option<&Tag> {
        match self { Tag::Compound(v) => v.iter().find(|(k, _)| k == key).map(|(_, t)| t), _ => None }
    }
    pub fn get_mut(&mut self, key: &str) -> Option<&mut Tag> {
        match self { Tag::Compound(v) => v.iter_mut().find(|(k, _)| k == key).map(|(_, t)| t), _ => None }
    }
    /// Follow a path of compound keys.
    pub fn path(&self, keys: &[&str]) -> Option<&Tag> { keys.iter().try_fold(self, |t, k| t.get(k)) }
    /// Insert or replace a compound entry.
    pub fn set(&mut self, key: &str, value: Tag) {
        if let Tag::Compound(v) = self {
            match v.iter_mut().find(|(k, _)| k == key) { Some(e) => e.1 = value, None => v.push((key.to_string(), value)) }
        }
    }
    pub fn as_str(&self) -> Option<&str> { if let Tag::String(s) = self { Some(s) } else { None } }
    /// Any integer type as i64.
    pub fn as_i64(&self) -> Option<i64> {
        match *self { Tag::Byte(v) => Some(v as i64), Tag::Short(v) => Some(v as i64), Tag::Int(v) => Some(v as i64), Tag::Long(v) => Some(v), _ => None }
    }
}

// Java "modified UTF-8": NUL is 0xC0 0x80 and characters outside the BMP are separate surrogates.
pub fn mutf8_decode(b: &[u8]) -> String {
    let mut units: Vec<u16> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let a = b[i] as u16;
        if a < 0x80 { units.push(a); i += 1; }
        else if a & 0xe0 == 0xc0 && i + 1 < b.len() { units.push(((a & 0x1f) << 6) | (b[i + 1] as u16 & 0x3f)); i += 2; }
        else if i + 2 < b.len() { units.push(((a & 0x0f) << 12) | ((b[i + 1] as u16 & 0x3f) << 6) | (b[i + 2] as u16 & 0x3f)); i += 3; }
        else { i += 1; }
    }
    String::from_utf16_lossy(&units)
}

pub fn mutf8_encode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    for c in s.encode_utf16() {
        if (1..0x80).contains(&c) { out.push(c as u8); }
        else if c < 0x800 { out.push(0xc0 | (c >> 6) as u8); out.push(0x80 | (c & 0x3f) as u8); }
        else { out.push(0xe0 | (c >> 12) as u8); out.push(0x80 | ((c >> 6) & 0x3f) as u8); out.push(0x80 | (c & 0x3f) as u8); }
    }
    out
}

struct Reader<'a> { b: &'a [u8], p: usize }
impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8]> {
        if self.p + n > self.b.len() { crate::bail!("This NBT file is cut short (at byte {}).", self.p); }
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8> { Ok(self.take(1)?[0]) }
    fn i16(&mut self) -> Result<i16> { Ok(i16::from_be_bytes(self.take(2)?.try_into()?)) }
    fn u16(&mut self) -> Result<u16> { Ok(u16::from_be_bytes(self.take(2)?.try_into()?)) }
    fn i32(&mut self) -> Result<i32> { Ok(i32::from_be_bytes(self.take(4)?.try_into()?)) }
    fn i64(&mut self) -> Result<i64> { Ok(i64::from_be_bytes(self.take(8)?.try_into()?)) }
    fn len(&mut self) -> Result<usize> { let n = self.i32()?; Ok(n.max(0) as usize) }
    fn string(&mut self) -> Result<String> { let n = self.u16()? as usize; Ok(mutf8_decode(self.take(n)?)) }

    fn payload(&mut self, t: u8, depth: usize) -> Result<Tag> {
        if depth > 512 { crate::bail!("This NBT file is nested too deeply."); }
        Ok(match t {
            1 => Tag::Byte(self.u8()? as i8),
            2 => Tag::Short(self.i16()?),
            3 => Tag::Int(self.i32()?),
            4 => Tag::Long(self.i64()?),
            5 => Tag::Float(f32::from_bits(self.i32()? as u32)),
            6 => Tag::Double(f64::from_bits(self.i64()? as u64)),
            7 => { let n = self.len()?; Tag::ByteArray(self.take(n)?.iter().map(|&x| x as i8).collect()) }
            8 => Tag::String(self.string()?),
            9 => {
                let it = self.u8()?;
                let n = self.len()?;
                let mut v = Vec::with_capacity(n.min(1 << 16));
                for _ in 0..n { v.push(self.payload(it, depth + 1)?); }
                Tag::List(it, v)
            }
            10 => {
                let mut v = Vec::new();
                loop {
                    let tt = self.u8()?;
                    if tt == 0 { break; }
                    let name = self.string()?;
                    v.push((name, self.payload(tt, depth + 1)?));
                }
                Tag::Compound(v)
            }
            11 => { let n = self.len()?; let mut v = Vec::with_capacity(n.min(1 << 16)); for _ in 0..n { v.push(self.i32()?); } Tag::IntArray(v) }
            12 => { let n = self.len()?; let mut v = Vec::with_capacity(n.min(1 << 16)); for _ in 0..n { v.push(self.i64()?); } Tag::LongArray(v) }
            _ => crate::bail!("Unknown NBT tag type {t} at byte {}", self.p),
        })
    }
}

fn write_payload(out: &mut Vec<u8>, t: &Tag) {
    match t {
        Tag::Byte(v) => out.push(*v as u8),
        Tag::Short(v) => out.extend(v.to_be_bytes()),
        Tag::Int(v) => out.extend(v.to_be_bytes()),
        Tag::Long(v) => out.extend(v.to_be_bytes()),
        Tag::Float(v) => out.extend(v.to_bits().to_be_bytes()),
        Tag::Double(v) => out.extend(v.to_bits().to_be_bytes()),
        Tag::ByteArray(v) => { out.extend((v.len() as i32).to_be_bytes()); out.extend(v.iter().map(|&x| x as u8)); }
        Tag::String(s) => write_string(out, s),
        Tag::List(it, v) => {
            out.push(if v.is_empty() { *it } else { v[0].id() });
            out.extend((v.len() as i32).to_be_bytes());
            for x in v { write_payload(out, x); }
        }
        Tag::Compound(v) => {
            for (k, x) in v { out.push(x.id()); write_string(out, k); write_payload(out, x); }
            out.push(0);
        }
        Tag::IntArray(v) => { out.extend((v.len() as i32).to_be_bytes()); for x in v { out.extend(x.to_be_bytes()); } }
        Tag::LongArray(v) => { out.extend((v.len() as i32).to_be_bytes()); for x in v { out.extend(x.to_be_bytes()); } }
    }
}

fn write_string(out: &mut Vec<u8>, s: &str) {
    let b = mutf8_encode(s);
    out.extend((b.len().min(65535) as u16).to_be_bytes());
    out.extend(&b[..b.len().min(65535)]);
}

/// Parse NBT (gzip, zlib or raw). Returns the root's name and the root compound.
pub fn parse(data: &[u8]) -> Result<(String, Tag)> {
    let mut raw = Vec::new();
    let buf: &[u8] = if data.starts_with(&[0x1f, 0x8b]) {
        GzDecoder::new(data).read_to_end(&mut raw)?;
        &raw
    } else if data.first() == Some(&0x78) && ZlibDecoder::new(data).read_to_end(&mut raw).is_ok() {
        &raw
    } else {
        data
    };
    let mut r = Reader { b: buf, p: 0 };
    if r.u8()? != 10 { crate::bail!("Not an NBT file (root is not a compound)."); }
    let name = r.string()?;
    let root = r.payload(10, 0)?;
    Ok((name, root))
}

pub fn read_file(p: &std::path::Path) -> Result<(String, Tag)> { parse(&std::fs::read(p)?) }

/// Uncompressed bytes.
pub fn encode(name: &str, root: &Tag) -> Vec<u8> {
    let mut out = vec![10u8];
    write_string(&mut out, name);
    write_payload(&mut out, root);
    out
}

/// Gzip-compressed, as Minecraft writes level.dat and playerdata.
pub fn write(name: &str, root: &Tag) -> Result<Vec<u8>> {
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(&encode(name, root))?;
    Ok(gz.finish()?)
}

/// "069a79f444e94726a5befca90e38aaf5" → "069a79f4-44e9-4726-a5be-fca90e38aaf5".
pub fn dash_uuid(id: &str) -> String {
    let h: String = id.chars().filter(|c| *c != '-').collect();
    if h.len() != 32 { return id.to_string(); }
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// Minecraft's int-array UUID (4 ints) → dashed string.
pub fn uuid_from_ints(a: &[i32]) -> String {
    dash_uuid(&a.iter().map(|n| format!("{:08x}", *n as u32)).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hello_world_example() {
        // The canonical hello_world.nbt from the NBT spec.
        let b = hex::decode("0a000b68656c6c6f20776f726c640800046e616d65000942616e616e72616d6100").unwrap();
        let (name, root) = parse(&b).unwrap();
        assert_eq!(name, "hello world");
        assert_eq!(root.get("name").unwrap().as_str(), Some("Bananrama"));
        assert_eq!(encode(&name, &root), b);
    }

    #[test]
    fn round_trips_every_type() {
        let root = Tag::Compound(vec![
            ("b".into(), Tag::Byte(-5)), ("s".into(), Tag::Short(-300)), ("i".into(), Tag::Int(123456)),
            ("l".into(), Tag::Long(-9_000_000_000)), ("f".into(), Tag::Float(1.5)), ("d".into(), Tag::Double(-2.25)),
            ("ba".into(), Tag::ByteArray(vec![1, -1])), ("str".into(), Tag::String("héllo \0 😀".into())),
            ("list".into(), Tag::List(3, vec![Tag::Int(1), Tag::Int(2)])), ("empty".into(), Tag::List(0, vec![])),
            ("c".into(), Tag::Compound(vec![("x".into(), Tag::String("y".into()))])),
            ("ia".into(), Tag::IntArray(vec![1, -2])), ("la".into(), Tag::LongArray(vec![i64::MIN])),
        ]);
        let gz = write("", &root).unwrap();
        let (_, back) = parse(&gz).unwrap();
        assert_eq!(back, root);
        assert_eq!(encode("", &back), encode("", &root));
        assert_eq!(mutf8_encode("\0"), vec![0xc0, 0x80]);
        assert_eq!(mutf8_encode("😀").len(), 6);
        assert_eq!(uuid_from_ints(&[0x069a79f4, 0x44e94726, 0xa5befca9u32 as i32, 0x0e38aaf5]), "069a79f4-44e9-4726-a5be-fca90e38aaf5");
        assert!(parse(&[10, 0]).is_err());
    }
}
