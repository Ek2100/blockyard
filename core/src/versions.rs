//! Minecraft version helpers.
use std::cmp::Ordering;

fn parts(v: &str) -> Vec<i64> {
    let base = v.split(['-', '+']).next().unwrap_or("");
    base.split('.').map(|n| n.trim().parse::<i64>().unwrap_or(0)).collect()
}

/// Compare "1.21.4" with "1.21.10", "26.1" with "1.21.11", ignoring suffixes like "-pre1".
pub fn compare(a: &str, b: &str) -> Ordering {
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let d = pa.get(i).copied().unwrap_or(0).cmp(&pb.get(i).copied().unwrap_or(0));
        if d != Ordering::Equal { return d; }
    }
    Ordering::Equal
}

pub fn is_release(v: &str) -> bool {
    let mut it = v.split('.');
    let ok = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match it.next() { Some(f) if ok(f) => {}, _ => return false }
    let rest: Vec<&str> = it.collect();
    !rest.is_empty() && rest.iter().all(|s| ok(s))
}

/// Unique, newest first.
pub fn sort_desc(mut list: Vec<String>) -> Vec<String> {
    list.sort_by(|a, b| compare(b, a));
    list.dedup();
    list
}

/// Best guess at the Java version a Minecraft version needs, for when Mojang can't be asked.
pub fn guess_java_major(mc: &str) -> u32 {
    let p = parts(mc);
    let (a, b, c) = (p.first().copied().unwrap_or(0), p.get(1).copied().unwrap_or(0), p.get(2).copied().unwrap_or(0));
    if a >= 26 { 25 }
    else if a == 1 && (b > 20 || (b == 20 && c >= 5)) { 21 }
    else if a == 1 && b >= 18 { 17 }
    else if a == 1 && b == 17 { 16 }
    else { 8 }
}

/// NeoForge version → Minecraft version. Before 26: 21.1.77 → 1.21.1, 21.0.5 → 1.21. From 26: 26.1.2.76 → 26.1.2.
pub fn neo_to_mc(v: &str) -> String {
    let p = parts(v);
    let g = |i: usize| p.get(i).copied().unwrap_or(0);
    if g(0) >= 26 {
        if g(2) != 0 { format!("{}.{}.{}", g(0), g(1), g(2)) } else { format!("{}.{}", g(0), g(1)) }
    } else if g(1) != 0 { format!("1.{}.{}", g(0), g(1)) } else { format!("1.{}", g(0)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn helpers() {
        assert_eq!(compare("1.21.10", "1.21.4"), Ordering::Greater);
        assert_eq!(compare("1.21", "1.21.0"), Ordering::Equal);
        assert_eq!(compare("26.1", "1.21.11"), Ordering::Greater);
        assert!(is_release("1.21.4") && is_release("26.1") && !is_release("1.21-pre1") && !is_release("24w10a") && !is_release("1"));
        assert_eq!(sort_desc(vec!["1.20".into(), "1.21.4".into(), "1.21.10".into(), "1.20".into()]), vec!["1.21.10", "1.21.4", "1.20"]);
        assert_eq!(guess_java_major("1.20.4"), 17);
        assert_eq!(guess_java_major("1.20.5"), 21);
        assert_eq!(guess_java_major("1.16.5"), 8);
        assert_eq!(guess_java_major("26.1.2"), 25);
        assert_eq!(neo_to_mc("21.1.77"), "1.21.1");
        assert_eq!(neo_to_mc("21.0.5-beta"), "1.21");
        assert_eq!(neo_to_mc("26.1.2.76"), "26.1.2");
        assert_eq!(neo_to_mc("26.1.0.19-beta"), "26.1");
    }
}
