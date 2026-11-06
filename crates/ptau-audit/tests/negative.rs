// Integration tests that do NOT depend on the gitignored .ptau fixtures:
// a tiny synthetic container is built in memory and mutated in a temp copy.
#[allow(dead_code)]
#[path = "../src/parser.rs"]
mod parser;

use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;

fn temp_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("ptau_audit_{}_{}.ptau", std::process::id(), name))
}

fn build_valid_container() -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(b"ptau");
    b.extend_from_slice(&1u32.to_le_bytes());
    b.extend_from_slice(&7u32.to_le_bytes());
    for id in 1..=7u32 {
        let payload = vec![0x5au8; id as usize * 3];
        b.extend_from_slice(&id.to_le_bytes());
        b.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        b.extend_from_slice(&payload);
    }
    b
}

fn write_sample(name: &str, data: &[u8]) -> PathBuf {
    let p = temp_path(name);
    fs::write(&p, data).unwrap();
    p
}

fn check(name: &str, mutated: Vec<u8>) {
    let p = write_sample(name, &mutated);
    let res = parser::parse_container(&p);
    assert!(res.is_err(), "{} should have been rejected", name);
    let _ = fs::remove_file(&p);
}

#[test]
fn valid_synthetic_container_is_accepted() {
    let p = write_sample("valid.ptau", &build_valid_container());
    assert!(parser::parse_container(&p).is_ok());
    let _ = fs::remove_file(&p);
}

#[test]
fn t1_bad_magic_is_rejected() {
    let mut b = build_valid_container();
    b[0..4].copy_from_slice(b"xtau");
    check("t1_bad_magic", b);
}

#[test]
fn t2_truncated_tail_is_rejected() {
    let mut b = build_valid_container();
    b.pop();
    check("t2_truncated", b);
}

#[test]
fn t3_out_of_bounds_section_length_is_rejected() {
    let mut b = build_valid_container();
    // Section 2 header starts after 12 B file header + 12 B + 3 B of Section 1.
    let off = (12 + 12 + 3 + 4) as usize;
    b[off..off + 8].copy_from_slice(&u64::MAX.to_le_bytes());
    check("t3_bad_section_len", b);
}

#[test]
fn t4_trailing_byte_is_rejected() {
    let mut b = build_valid_container();
    b.push(0x00);
    check("t4_trailing_byte", b);
}

#[test]
fn integer_overflowing_section_length_is_rejected() {
    let mut b = build_valid_container();
    let off = (12 + 12 + 3 + 4) as usize;
    b[off..off + 8].copy_from_slice(&(u64::MAX - 8).to_le_bytes());
    let p = write_sample("overflow", &b);
    assert!(parser::parse_container(&p).is_err());
    let _ = fs::remove_file(&p);
}

#[test]
fn appending_requires_write_permission_only_on_copy() {
    // Sanity: OpenOptions append on a copy works and changes the length.
    let p = write_sample("append_probe", &build_valid_container());
    let before = fs::metadata(&p).unwrap().len();
    let mut f = OpenOptions::new().append(true).open(&p).unwrap();
    f.write_all(&[0x01]).unwrap();
    let after = fs::metadata(&p).unwrap().len();
    assert_eq!(after, before + 1);
    let _ = f.seek(SeekFrom::Start(0));
    let _ = fs::remove_file(&p);
}
