use crate::parser;
use std::error::Error;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// SHA-256 (standard library only, streaming / chunked)
// ---------------------------------------------------------------------------

const H0: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub struct Sha256 {
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    byte_len: u64,
}

impl Sha256 {
    pub fn new() -> Self {
        Sha256 {
            state: H0,
            buf: [0u8; 64],
            buf_len: 0,
            byte_len: 0,
        }
    }

    pub fn update(&mut self, data: &[u8]) {
        self.byte_len = self.byte_len.wrapping_add(data.len() as u64);
        self.update_raw(data);
    }

    /// Same as `update` but does not advance the message-length counter (padding).
    fn update_raw(&mut self, mut data: &[u8]) {
        if self.buf_len > 0 {
            let take = (64 - self.buf_len).min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            data = &data[take..];
            if self.buf_len == 64 {
                let block = self.buf;
                self.compress(&block);
                self.buf_len = 0;
            }
        }
        while data.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            self.compress(&block);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.buf[..data.len()].copy_from_slice(data);
            self.buf_len = data.len();
        }
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for i in 0..64 {
            let big_s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = h
                .wrapping_add(big_s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let big_s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = big_s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        let mix = [a, b, c, d, e, f, g, h];
        for i in 0..8 {
            self.state[i] = self.state[i].wrapping_add(mix[i]);
        }
    }

    pub fn finalize(mut self) -> [u8; 32] {
        let bit_len = self.byte_len.wrapping_mul(8);
        self.update_raw(&[0x80]);
        let zeros = if self.buf_len > 56 {
            64 - self.buf_len + 56
        } else {
            56 - self.buf_len
        };
        let zero_block = [0u8; 64];
        self.update_raw(&zero_block[..zeros]);
        self.update_raw(&bit_len.to_be_bytes());

        let mut out = [0u8; 32];
        for i in 0..8 {
            out[i * 4..i * 4 + 4].copy_from_slice(&self.state[i].to_be_bytes());
        }
        out
    }
}

pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

#[allow(dead_code)] // used by unit tests; kept public for library-style reuse
pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex(&h.finalize())
}

/// Whole-file SHA-256 with bounded memory: never loads the full file.
pub fn sha256_file(path: &Path, chunk_bytes: usize) -> Result<String, Box<dyn Error>> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; chunk_bytes.max(1)];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// SHA-256 over a byte range of a file, also chunked.
pub fn sha256_range(
    file: &mut File,
    offset: u64,
    len: u64,
    chunk_bytes: usize,
) -> Result<String, Box<dyn Error>> {
    file.seek(SeekFrom::Start(offset))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; chunk_bytes.max(1)];
    let mut remaining = len;
    while remaining > 0 {
        let take = remaining.min(buf.len() as u64) as usize;
        file.read_exact(&mut buf[..take])?;
        hasher.update(&buf[..take]);
        remaining -= take as u64;
    }
    Ok(hex(&hasher.finalize()))
}

// ---------------------------------------------------------------------------
// Minimal JSON writer (no serde dependency)
// ---------------------------------------------------------------------------

pub fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

#[derive(Default)]
pub struct JsonObj {
    fields: Vec<String>,
}

impl JsonObj {
    pub fn new() -> Self {
        JsonObj { fields: Vec::new() }
    }
    pub fn str(&mut self, key: &str, value: &str) {
        self.fields.push(format!(
            "\"{}\":\"{}\"",
            json_escape(key),
            json_escape(value)
        ));
    }
    pub fn num(&mut self, key: &str, value: u64) {
        self.fields
            .push(format!("\"{}\":{}", json_escape(key), value));
    }
    pub fn raw(&mut self, key: &str, value: String) {
        self.fields
            .push(format!("\"{}\":{}", json_escape(key), value));
    }
    pub fn render(&self) -> String {
        format!("{{\n  {}\n}}", self.fields.join(",\n  "))
    }
}

pub fn json_array(items: Vec<String>) -> String {
    format!("[{}]", items.join(", "))
}

pub fn json_string_array(items: &[String]) -> String {
    let parts: Vec<String> = items
        .iter()
        .map(|s| format!("\"{}\"", json_escape(s)))
        .collect();
    format!("[{}]", parts.join(", "))
}

pub fn write_json(path: &Path, data: &str) -> Result<(), Box<dyn Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut f = File::create(path)?;
    f.write_all(data.as_bytes())?;
    f.write_all(b"\n")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Negative tests T1-T4 (mutate copies only; original fixtures are untouched)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct NegativeTest {
    pub id: &'static str,
    pub mutation: &'static str,
    pub sample: String,
    pub rejected: bool,
    pub error: String,
}

fn copy_fixture(fixture: &Path, name: &str, out_dir: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let dst = out_dir.join(name);
    fs::copy(fixture, &dst)?;
    Ok(dst)
}

pub fn run_negative_tests(
    fixture: &Path,
    out_dir: &Path,
) -> Result<Vec<NegativeTest>, Box<dyn Error>> {
    fs::create_dir_all(out_dir)?;
    let original = parser::parse_container(fixture)?;
    let sec2 = original
        .sections
        .iter()
        .find(|s| s.id == 2)
        .ok_or("fixture has no Section 2")?;
    let sec2_size_offset = sec2.header_offset + 4;
    let file_size = fs::metadata(fixture)?.len();

    let mut samples: Vec<(&'static str, &'static str, PathBuf)> = Vec::new();

    // T1 - corrupt magic
    let p = copy_fixture(fixture, "t1_bad_magic.ptau", out_dir)?;
    {
        let mut f = OpenOptions::new().write(true).open(&p)?;
        f.seek(SeekFrom::Start(0))?;
        f.write_all(b"xtau")?;
    }
    samples.push(("T1", "Magic 'ptau' -> 'xtau'", p));

    // T2 - truncate the final byte
    let p = copy_fixture(fixture, "t2_truncated.ptau", out_dir)?;
    OpenOptions::new()
        .write(true)
        .open(&p)?
        .set_len(file_size - 1)?;
    samples.push(("T2", "Truncate last byte", p));

    // T3 - make a Section length overflow the file
    let p = copy_fixture(fixture, "t3_bad_section_len.ptau", out_dir)?;
    {
        let mut f = OpenOptions::new().write(true).open(&p)?;
        f.seek(SeekFrom::Start(sec2_size_offset))?;
        f.write_all(&u64::MAX.to_le_bytes())?;
    }
    samples.push(("T3", "Section 2 length -> u64::MAX", p));

    // T4 - append an invalid trailing byte
    let p = copy_fixture(fixture, "t4_trailing_byte.ptau", out_dir)?;
    {
        let mut f = OpenOptions::new().append(true).open(&p)?;
        f.write_all(&[0x00])?;
    }
    samples.push(("T4", "Append 1 trailing byte", p));

    let mut results = Vec::new();
    for (id, mutation, sample) in samples {
        let (rejected, error) = match parser::parse_container(&sample) {
            Err(e) => (true, e.to_string()),
            Ok(_) => (false, "ACCEPTED (unexpected)".to_string()),
        };
        results.push(NegativeTest {
            id,
            mutation,
            sample: sample.to_string_lossy().into_owned(),
            rejected,
            error,
        });
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(&b"a".repeat(1_000_000)),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    #[test]
    fn chunk_size_does_not_change_digest() {
        let data: Vec<u8> = (0..5000).map(|i| (i % 251) as u8).collect();
        let mut h = Sha256::new();
        for chunk in data.chunks(7) {
            h.update(chunk);
        }
        assert_eq!(hex(&h.finalize()), sha256_hex(&data));
    }

    #[test]
    fn json_escapes_quotes_and_backslashes() {
        assert_eq!(json_escape("a\"b\\c"), "a\\\"b\\\\c");
    }
}
