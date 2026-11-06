//! Three-process file protocol + storage accounting (R1 / R3).
//!
//! All paths live under `results/raw/m2b/` which is excluded by `.gitignore`.
//!
//! ```text
//! public/    aux.bin, <scheme>.bin x7, relations.json, manifest.json
//!            -> the ONLY inputs of the independent `recover` process
//! oracle/    tau_g1_full.bin   -> full public CRS sequence, read by `eval` ONLY
//! recovered/ <scheme>.bin x7, summary.json -> output of `recover`
//! ```

use crate::sha256::Sha256;
use ark_bls12_381::{G1Affine, G2Affine};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

pub const BASE: &str = "results/raw/m2b";
pub const AUX_FILE: &str = "aux.bin";
pub const ORACLE_FILE: &str = "tau_g1_full.bin";
pub const RELATIONS_FILE: &str = "relations.json";
pub const MANIFEST_FILE: &str = "manifest.json";
pub const SUMMARY_FILE: &str = "summary.json";

const AUX_MAGIC: &[u8; 4] = b"SAX1";
const ORACLE_MAGIC: &[u8; 4] = b"SOR1";
const REC_MAGIC: &[u8; 4] = b"SCR1";

pub fn public_dir() -> PathBuf {
    Path::new(BASE).join("public")
}
pub fn oracle_dir() -> PathBuf {
    Path::new(BASE).join("oracle")
}
pub fn recovered_dir() -> PathBuf {
    Path::new(BASE).join("recovered")
}

pub fn ensure_dirs() -> std::io::Result<()> {
    fs::create_dir_all(public_dir())?;
    fs::create_dir_all(oracle_dir())?;
    fs::create_dir_all(recovered_dir())?;
    Ok(())
}

fn io_err<E: std::fmt::Display>(e: E) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

fn ser_g1<W: Write>(w: &mut W, p: &G1Affine) -> std::io::Result<()> {
    let mut b = Vec::new();
    p.serialize_uncompressed(&mut b).map_err(io_err)?;
    assert_eq!(b.len(), 96, "uncompressed G1 must be 96 B");
    w.write_all(&b)
}
fn ser_g2<W: Write>(w: &mut W, p: &G2Affine) -> std::io::Result<()> {
    let mut b = Vec::new();
    p.serialize_uncompressed(&mut b).map_err(io_err)?;
    assert_eq!(b.len(), 192, "uncompressed G2 must be 192 B");
    w.write_all(&b)
}
fn de_g1<R: Read>(r: &mut R) -> std::io::Result<G1Affine> {
    G1Affine::deserialize_uncompressed(r).map_err(io_err)
}
fn de_g2<R: Read>(r: &mut R) -> std::io::Result<G2Affine> {
    G2Affine::deserialize_uncompressed(r).map_err(io_err)
}
fn read_u32<R: Read>(r: &mut R) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}
fn check_magic<R: Read>(r: &mut R, expected: &[u8; 4]) -> std::io::Result<()> {
    let mut m = [0u8; 4];
    r.read_exact(&mut m)?;
    if &m != expected {
        return Err(io_err(format!(
            "bad file magic: expected {}, got {:?}",
            String::from_utf8_lossy(expected),
            m
        )));
    }
    Ok(())
}

/// Public auxiliary parameters shared by every scheme (all of them are public
/// CRS elements; none of them is a trapdoor).
#[derive(Clone)]
pub struct PublicAux {
    pub n: usize,
    pub seq_len: usize,
    pub tau_g2: Vec<G2Affine>,
    pub alpha_tau_g1: Vec<G1Affine>,
    pub beta_tau_g1: Vec<G1Affine>,
    pub beta_g2: G2Affine,
}

pub fn write_public_aux(dir: &Path, aux: &PublicAux) -> std::io::Result<u64> {
    let path = dir.join(AUX_FILE);
    let mut w = BufWriter::new(File::create(&path)?);
    w.write_all(AUX_MAGIC)?;
    w.write_all(&(aux.n as u32).to_le_bytes())?;
    w.write_all(&(aux.seq_len as u32).to_le_bytes())?;
    for p in &aux.tau_g2 {
        ser_g2(&mut w, p)?;
    }
    for p in &aux.alpha_tau_g1 {
        ser_g1(&mut w, p)?;
    }
    for p in &aux.beta_tau_g1 {
        ser_g1(&mut w, p)?;
    }
    ser_g2(&mut w, &aux.beta_g2)?;
    w.flush()?;
    Ok(fs::metadata(path)?.len())
}

pub fn read_public_aux(dir: &Path) -> std::io::Result<PublicAux> {
    let mut r = BufReader::new(File::open(dir.join(AUX_FILE))?);
    check_magic(&mut r, AUX_MAGIC)?;
    let n = read_u32(&mut r)? as usize;
    let seq_len = read_u32(&mut r)? as usize;
    let mut tau_g2 = Vec::with_capacity(n);
    for _ in 0..n {
        tau_g2.push(de_g2(&mut r)?);
    }
    let mut alpha_tau_g1 = Vec::with_capacity(n);
    for _ in 0..n {
        alpha_tau_g1.push(de_g1(&mut r)?);
    }
    let mut beta_tau_g1 = Vec::with_capacity(n);
    for _ in 0..n {
        beta_tau_g1.push(de_g1(&mut r)?);
    }
    let beta_g2 = de_g2(&mut r)?;
    // Reject trailing bytes: the public file must be exactly consumed.
    let mut tail = [0u8; 1];
    if r.read(&mut tail)? != 0 {
        return Err(io_err("trailing bytes in public aux file"));
    }
    Ok(PublicAux {
        n,
        seq_len,
        tau_g2,
        alpha_tau_g1,
        beta_tau_g1,
        beta_g2,
    })
}

/// Full Tau-G1 sequence: the scoring oracle. Written by `gen`, read ONLY by
/// `eval`. The `recover` process never opens this directory.
pub fn write_oracle(dir: &Path, full: &[G1Affine]) -> std::io::Result<u64> {
    let path = dir.join(ORACLE_FILE);
    let mut w = BufWriter::new(File::create(&path)?);
    w.write_all(ORACLE_MAGIC)?;
    w.write_all(&(full.len() as u32).to_le_bytes())?;
    for p in full {
        ser_g1(&mut w, p)?;
    }
    w.flush()?;
    Ok(fs::metadata(path)?.len())
}

#[allow(dead_code)]
pub fn read_oracle(dir: &Path) -> std::io::Result<Vec<G1Affine>> {
    let mut r = BufReader::new(File::open(dir.join(ORACLE_FILE))?);
    check_magic(&mut r, ORACLE_MAGIC)?;
    let count = read_u32(&mut r)? as usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        out.push(de_g1(&mut r)?);
    }
    Ok(out)
}

/// Points the recovery process actually produced (possibly a partial set).
pub fn write_recovered(
    dir: &Path,
    scheme: &str,
    points: &[(usize, G1Affine)],
) -> std::io::Result<u64> {
    let path = dir.join(format!("{}.bin", scheme));
    let mut w = BufWriter::new(File::create(&path)?);
    w.write_all(REC_MAGIC)?;
    w.write_all(&(points.len() as u32).to_le_bytes())?;
    for (idx, p) in points {
        w.write_all(&(*idx as u32).to_le_bytes())?;
        ser_g1(&mut w, p)?;
    }
    w.flush()?;
    Ok(fs::metadata(path)?.len())
}

pub fn read_recovered(dir: &Path, scheme: &str) -> std::io::Result<Vec<(usize, G1Affine)>> {
    let mut r = BufReader::new(File::open(dir.join(format!("{}.bin", scheme)))?);
    check_magic(&mut r, REC_MAGIC)?;
    let count = read_u32(&mut r)? as usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let idx = read_u32(&mut r)? as usize;
        out.push((idx, de_g1(&mut r)?));
    }
    Ok(out)
}

pub fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    fs::write(path, serde_json::to_string_pretty(value).map_err(io_err)?)
}

pub fn read_json(path: &Path) -> std::io::Result<Value> {
    let s = fs::read_to_string(path)?;
    serde_json::from_str(&s).map_err(io_err)
}

/// Identify this batch of PUBLIC test parameters by a single SHA-256.
/// Fixed concatenation order: aux.bin, then the seven scheme files in SCHEMES
/// order. Streamed in 1 MiB chunks, so no file is fully loaded.
pub fn dataset_sha256(dir: &Path, scheme_names: &[&str]) -> std::io::Result<String> {
    let mut paths = vec![dir.join(AUX_FILE)];
    for name in scheme_names {
        paths.push(dir.join(format!("{}.bin", name)));
    }
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    for p in &paths {
        let mut r = BufReader::new(File::open(p)?);
        loop {
            let n = r.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
    }
    Ok(h.finalize_hex())
}

/// R3: three explicit storage accounting scopes.
///
/// - `native_tau_g1_section_bytes`: the raw Tau-G1 Section of a `.ptau` file,
///   `(2N-1) x 96` bytes, with NO per-point index (M1 audited this layout).
/// - `scp1_baseline_bytes`: our M2-only SCP1 representation of the FULL
///   sequence, `12 + (2N-1) x 100` (100 = 4 B index + 96 B point).
/// - `native_full_crs_bytes`: all five parameter families in native encoding.
///
/// None of the resulting percentages is a *valid* CRS compression ratio,
/// because the missing points are not recovered.
#[derive(Debug, Clone, Copy)]
pub struct StorageScope {
    pub n: usize,
    pub seq_len: usize,
    pub native_tau_g1_section_bytes: u64,
    pub native_aux_bytes: u64,
    pub native_full_crs_bytes: u64,
    pub scp1_baseline_bytes: u64,
}

impl StorageScope {
    pub fn new(n: usize) -> Self {
        let seq = 2 * n - 1;
        let native_tau_g1 = seq as u64 * 96;
        // Q: N x 192, A: N x 96, B: N x 96, B2: 192
        let native_aux = n as u64 * 192 + n as u64 * 96 * 2 + 192;
        StorageScope {
            n,
            seq_len: seq,
            native_tau_g1_section_bytes: native_tau_g1,
            native_aux_bytes: native_aux,
            native_full_crs_bytes: native_tau_g1 + native_aux,
            scp1_baseline_bytes: 12 + seq as u64 * 100,
        }
    }

    pub fn for_representation(&self, scp1_bytes: u64) -> RepresentationSizes {
        let full = scp1_bytes + self.native_aux_bytes;
        RepresentationSizes {
            scp1_bytes,
            tau_g1_representation_saving_pct: saving_pct(
                scp1_bytes,
                self.native_tau_g1_section_bytes,
            ),
            scp1_baseline_reduction_pct: saving_pct(scp1_bytes, self.scp1_baseline_bytes),
            full_crs_bytes: full,
            full_crs_reduction_pct: saving_pct(full, self.native_full_crs_bytes),
        }
    }
}

/// `(1 - value/base) * 100`. May be NEGATIVE when a representation is larger
/// than the native layout (e.g. SCP1 adds a 4 B index per point).
fn saving_pct(value: u64, base: u64) -> f64 {
    (1.0 - value as f64 / base as f64) * 100.0
}

#[derive(Debug, Clone, Copy)]
pub struct RepresentationSizes {
    pub scp1_bytes: u64,
    pub tau_g1_representation_saving_pct: f64,
    pub scp1_baseline_reduction_pct: f64,
    pub full_crs_bytes: u64,
    pub full_crs_reduction_pct: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sha256::sha256_file_hex;
    use ark_bls12_381::{Fr, G1Projective, G2Projective};
    use ark_ec::{CurveGroup, PrimeGroup};
    use ark_ff::PrimeField;

    fn point(c: u64) -> G1Affine {
        G1Projective::generator()
            .mul_bigint(Fr::from(c).into_bigint())
            .into_affine()
    }

    #[test]
    fn storage_scope_matches_audited_layout_for_n32() {
        let s = StorageScope::new(32);
        assert_eq!(s.seq_len, 63);
        assert_eq!(s.native_tau_g1_section_bytes, 6048);
        assert_eq!(s.native_aux_bytes, 12480);
        assert_eq!(s.native_full_crs_bytes, 18528);
        assert_eq!(s.scp1_baseline_bytes, 6312);
        let odd = s.for_representation(3112);
        // 1 - 3112/6048 ~= 48.55% against the native Tau-G1 Section.
        assert!((odd.tau_g1_representation_saving_pct - 48.5450).abs() < 0.01);
        assert_eq!(odd.full_crs_bytes, 3112 + 12480);
    }

    #[test]
    fn aux_and_oracle_and_recovered_roundtrip() {
        let dir = std::env::temp_dir().join(format!("srs_io_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let g2 = G2Projective::generator().into_affine();
        let aux = PublicAux {
            n: 2,
            seq_len: 3,
            tau_g2: vec![g2, g2],
            alpha_tau_g1: vec![point(1), point(2)],
            beta_tau_g1: vec![point(3), point(4)],
            beta_g2: g2,
        };
        assert_eq!(
            write_public_aux(&dir, &aux).unwrap(),
            12 + 2 * 192 + 2 * 96 + 2 * 96 + 192
        );
        let back = read_public_aux(&dir).unwrap();
        assert_eq!(back.n, 2);
        assert_eq!(back.tau_g2, aux.tau_g2);
        assert_eq!(back.alpha_tau_g1, aux.alpha_tau_g1);

        let full = vec![point(5), point(6), point(7)];
        assert_eq!(write_oracle(&dir, &full).unwrap(), 8 + 3 * 96);
        assert_eq!(read_oracle(&dir).unwrap(), full);

        let got = vec![(0usize, point(5)), (2usize, point(7))];
        assert_eq!(write_recovered(&dir, "t", &got).unwrap(), 8 + 2 * 100);
        assert_eq!(read_recovered(&dir, "t").unwrap(), got);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sha256_file_matches_in_memory() {
        let dir = std::env::temp_dir().join(format!("srs_hash_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x.bin");
        let bytes: Vec<u8> = (0..3000u32).map(|i| (i % 251) as u8).collect();
        fs::write(&p, &bytes).unwrap();
        assert_eq!(
            sha256_file_hex(&p).unwrap(),
            crate::sha256::sha256_hex(&bytes)
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
