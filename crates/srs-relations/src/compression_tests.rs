//! M2-B recovery algorithms (R2 revision: P0/Q0 are implicit public generators).
//!
//! This module belongs to the library that the INDEPENDENT `recover` process
//! links. It contains no trapdoor generation and no full Tau-G1 oracle. Its
//! only input is `CompressedParameters`: a public SCP1 file plus public
//! auxiliary parameters.

use crate::pairing::{Gt, pairing_g1_g2};
use ark_bls12_381::{Fr, G1Affine, G1Projective, G2Affine};
use ark_ec::{AffineRepr, CurveGroup, PrimeGroup};
use ark_ff::PrimeField;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

const FILE_MAGIC: &[u8; 4] = b"SCP1";

/// Public, compressed parameter subset. Contains NO trapdoor scalars and NO
/// complete Tau-G1 array. The saved Tau-G1 points live only in `file_path`.
#[allow(dead_code)]
pub struct CompressedParameters {
    pub scheme: &'static str,
    pub n: usize,
    pub file_path: PathBuf,
    pub file_bytes: u64,
    // Public auxiliary parameters (shared by all schemes, not counted in file size).
    pub tau_g2: Vec<G2Affine>,
    pub alpha_tau_g1: Vec<G1Affine>,
    pub beta_tau_g1: Vec<G1Affine>,
    pub beta_g2: G2Affine,
}

impl CompressedParameters {
    /// P0 = [1]G1 is a PUBLIC constant (snarkjs powersoftau_verify.js:182).
    pub fn p0() -> G1Affine {
        G1Affine::generator()
    }
    /// Q0 = [1]G2 is a PUBLIC constant (powersoftau_verify.js:201).
    pub fn q0() -> G2Affine {
        G2Affine::generator()
    }
}

/// Diagnostic counters from one recovery attempt.
#[derive(Debug, Clone, Copy, Default)]
pub struct RecoveryStats {
    pub sequence_len: usize,
    pub saved: usize,
    pub missing: usize,
    pub gt_targets: usize,
    pub implicit_generator_filled: usize,
    pub candidates: usize,
    pub aux_relations_checked: usize,
    pub recovered: usize,
}

#[derive(Debug, Clone)]
pub struct RecoveryError {
    pub stats: RecoveryStats,
    pub reason: String,
    /// Points recovered so far (Some = determined, None = still missing).
    /// The evaluator uses this to score partial recovery.
    pub partial_points: Vec<Option<G1Affine>>,
}

/// Full diagnostic output of a recovery attempt.
#[derive(Debug, Clone)]
pub struct RecoveryOutcome {
    pub points: Vec<Option<G1Affine>>,
    pub stats: RecoveryStats,
    pub success: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Copy)]
pub enum Scheme {
    All,
    Odd,
    Even,
    FirstHalf,
    Step2,
    Step4,
    Step8,
}

pub const SCHEMES: [(&str, Scheme); 7] = [
    ("all_powers_baseline", Scheme::All),
    ("odd_only", Scheme::Odd),
    ("even_only", Scheme::Even),
    ("first_half", Scheme::FirstHalf),
    ("every_2", Scheme::Step2),
    ("every_4", Scheme::Step4),
    ("every_8", Scheme::Step8),
];

pub fn selected_indices(scheme: Scheme, seq_len: usize, n: usize) -> Vec<usize> {
    match scheme {
        Scheme::All => (0..seq_len).collect(),
        Scheme::Odd => (0..seq_len).filter(|i| i % 2 == 1).collect(),
        Scheme::Even => (0..seq_len).filter(|i| i % 2 == 0).collect(),
        // Plan wording: "only the first N/2 Tau-G1 points".
        Scheme::FirstHalf => (0..(n / 2)).collect(),
        Scheme::Step2 => (0..seq_len).filter(|i| i % 2 == 0).collect(),
        Scheme::Step4 => (0..seq_len).filter(|i| i % 4 == 0).collect(),
        Scheme::Step8 => (0..seq_len).filter(|i| i % 8 == 0).collect(),
    }
}

fn io_err<E: std::fmt::Display>(e: E) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

/// SCP1 layout: magic(4) | sequence_len u32 | count u32 |
///              count x [ index u32 | 96 B uncompressed arkworks G1Affine ].
/// NOTE: arkworks canonical serialization is NOT the same as snarkjs
/// LEM/Montgomery encoding. These are M2-only mathematical fixtures.
pub fn write_compressed_file(
    path: &Path,
    seq_len: usize,
    saved: &[(usize, G1Affine)],
) -> std::io::Result<u64> {
    let mut w = BufWriter::new(File::create(path)?);
    w.write_all(FILE_MAGIC)?;
    w.write_all(&(seq_len as u32).to_le_bytes())?;
    w.write_all(&(saved.len() as u32).to_le_bytes())?;
    for (idx, p) in saved {
        w.write_all(&(*idx as u32).to_le_bytes())?;
        let mut bytes = Vec::new();
        p.serialize_uncompressed(&mut bytes).map_err(io_err)?;
        assert_eq!(bytes.len(), 96, "uncompressed G1 must be 96 B");
        w.write_all(&bytes)?;
    }
    w.flush()?;
    Ok(fs::metadata(path)?.len())
}

fn read_saved_from_file(path: &Path) -> std::io::Result<(usize, Vec<(usize, G1Affine)>)> {
    let mut r = BufReader::new(File::open(path)?);
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic)?;
    if &magic != FILE_MAGIC {
        return Err(io_err("bad compressed-parameter file magic"));
    }
    let mut b4 = [0u8; 4];
    r.read_exact(&mut b4)?;
    let seq_len = u32::from_le_bytes(b4) as usize;
    r.read_exact(&mut b4)?;
    let count = u32::from_le_bytes(b4) as usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        r.read_exact(&mut b4)?;
        let idx = u32::from_le_bytes(b4) as usize;
        let p = G1Affine::deserialize_uncompressed(&mut r).map_err(io_err)?;
        out.push((idx, p));
    }
    Ok((seq_len, out))
}

fn add_candidate(p: G1Affine, seen: &mut HashSet<Vec<u8>>, out: &mut Vec<G1Affine>) {
    let mut key = Vec::new();
    p.serialize_compressed(&mut key).expect("serialize G1");
    if seen.insert(key) {
        out.push(p);
    }
}

/// Build a bounded search space of G1 points obtainable with PUBLIC operations:
/// integer linear combinations of saved points, doubling/negation, the implicit
/// public generator P0, other public G1 families, and small known scalar
/// multiples of the generator.
fn build_candidates(saved: &[(usize, G1Affine)], pp: &CompressedParameters) -> Vec<G1Affine> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let g1_gen = G1Projective::generator();

    // R2: P0 = G1 is public even when it was not stored in the compressed file.
    add_candidate(CompressedParameters::p0(), &mut seen, &mut out);

    for (_, p) in saved {
        let proj = p.into_group();
        add_candidate(*p, &mut seen, &mut out);
        add_candidate((proj + proj).into_affine(), &mut seen, &mut out);
        add_candidate((-proj).into_affine(), &mut seen, &mut out);
    }

    let head: Vec<G1Affine> = saved.iter().take(12).map(|(_, p)| *p).collect();
    for a in &head {
        for b in &head {
            add_candidate(
                (a.into_group() + b.into_group()).into_affine(),
                &mut seen,
                &mut out,
            );
        }
    }

    for family in [&pp.alpha_tau_g1, &pp.beta_tau_g1] {
        for p in family {
            let proj = p.into_group();
            add_candidate(*p, &mut seen, &mut out);
            add_candidate((proj + proj).into_affine(), &mut seen, &mut out);
        }
    }

    for c in 1..=64u64 {
        let s = Fr::from(c);
        add_candidate(
            g1_gen.mul_bigint(s.into_bigint()).into_affine(),
            &mut seen,
            &mut out,
        );
    }
    out
}

/// Recover the full Tau-G1 sequence using ONLY the compressed public parameters.
///
/// Allowed: group law on saved G1 points, known scalar multiplication, the
/// implicit public generators P0/Q0, G2 points, bilinear pairings, and publicly
/// computable auxiliary values.
/// Forbidden (by construction): tau / alpha / beta, and the original full array.
///
/// Strategy:
///  1. Fill indices already present in the compressed file.
///  1b (R2). Fill index 0 with the PUBLIC generator P0 when it is missing.
///  2  (R2). Build GT targets from all public sources INCLUDING (0, P0), so
///           for 0<=k<N we can always use e(P_0,Q_k)=e(P_k,Q_0).
///  3. Build a bounded candidate set of G1 points reachable by public ops.
///  4. Try to invert e(., Q_0): G1 -> GT by looking up t_k among candidate images.
///  5. Re-verify any hit with a pairing; the evaluator compares points afterwards.
///
/// A GT target alone is NOT a recovered G1 point. If inversion fails, the whole
/// recovery is reported as failed.
pub fn recover_with_diagnostics(pp: &CompressedParameters) -> RecoveryOutcome {
    let (seq_len, saved) = match read_saved_from_file(&pp.file_path) {
        Ok(v) => v,
        Err(e) => {
            return RecoveryOutcome {
                points: Vec::new(),
                stats: RecoveryStats::default(),
                success: false,
                reason: format!("cannot read compressed file: {}", e),
            };
        }
    };

    let q0 = CompressedParameters::q0();
    if pp.tau_g2.first() != Some(&q0) {
        return RecoveryOutcome {
            points: Vec::new(),
            stats: RecoveryStats::default(),
            success: false,
            reason: "public Q0 does not equal the standard G2 generator".to_string(),
        };
    }

    let mut present: HashMap<usize, G1Affine> = HashMap::new();
    for (i, p) in &saved {
        present.insert(*i, *p);
    }
    let saved_count = saved.len();
    let mut result: Vec<Option<G1Affine>> =
        (0..seq_len).map(|i| present.get(&i).copied()).collect();
    let missing: Vec<usize> = (0..seq_len).filter(|i| result[*i].is_none()).collect();

    if missing.is_empty() {
        return RecoveryOutcome {
            points: result,
            stats: RecoveryStats {
                sequence_len: seq_len,
                saved: saved_count,
                missing: 0,
                gt_targets: 0,
                implicit_generator_filled: 0,
                candidates: 0,
                aux_relations_checked: 0,
                recovered: seq_len,
            },
            success: true,
            reason: "n/a (baseline, no missing points)".to_string(),
        };
    }

    // Step 1b: P0 = G1 is an implicit PUBLIC parameter, not an unknown point.
    let mut implicit_generator_filled = 0usize;
    if !present.contains_key(&0) {
        result[0] = Some(CompressedParameters::p0());
        implicit_generator_filled = 1;
    }

    // Step 2: public sources for GT targets include (0, P0).
    let mut available: Vec<(usize, G1Affine)> = saved.clone();
    if !present.contains_key(&0) {
        available.push((0, CompressedParameters::p0()));
    }
    let mut targets: Vec<(usize, Gt)> = Vec::new();
    for &k in &missing {
        for (i, p) in &available {
            if *i <= k {
                let j = k - *i;
                if j < pp.tau_g2.len() {
                    targets.push((k, pairing_g1_g2(*p, pp.tau_g2[j])));
                    break;
                }
            }
        }
    }

    // Cross-check the beta family on public data: e(B_i, Q_0) = e(P_i, B_2).
    let mut aux_relations_checked = 0usize;
    for (i, p) in &saved {
        if *i < pp.n && *i < pp.beta_tau_g1.len() {
            let lhs = pairing_g1_g2(pp.beta_tau_g1[*i], q0);
            let rhs = pairing_g1_g2(*p, pp.beta_g2);
            if lhs == rhs {
                aux_relations_checked += 1;
            }
        }
    }

    // Steps 3 & 4: bounded GT -> G1 inversion over publicly constructible points.
    let candidates = build_candidates(&saved, pp);
    let mut gt_map: HashMap<Gt, G1Affine> = HashMap::new();
    for x in &candidates {
        let image = pairing_g1_g2(*x, q0);
        gt_map.entry(image).or_insert(*x);
    }

    let mut recovered = implicit_generator_filled;
    for (k, t) in &targets {
        if result[*k].is_some() {
            continue; // already determined as the public generator
        }
        if let Some(x) = gt_map.get(t) {
            if pairing_g1_g2(*x, q0) == *t {
                result[*k] = Some(*x);
                recovered += 1;
            }
        }
    }

    let success = result.iter().all(Option::is_some);
    let stats = RecoveryStats {
        sequence_len: seq_len,
        saved: saved_count,
        missing: missing.len(),
        gt_targets: targets.len(),
        implicit_generator_filled,
        candidates: candidates.len(),
        aux_relations_checked,
        recovered,
    };
    let reason = if success {
        "n/a".to_string()
    } else {
        "pairing yields GT elements only; GT -> G1 inversion requires solving \
         the discrete log of tau^k, which is not a known public scalar"
            .to_string()
    };
    RecoveryOutcome {
        points: result,
        stats,
        success,
        reason,
    }
}

/// The recovery contract requested in the experiment plan. It deliberately
/// accepts ONLY public parameters; no trapdoor and no full original array.
pub fn recover_missing_powers(
    public_parameters: &CompressedParameters,
) -> Result<Vec<G1Affine>, RecoveryError> {
    let o = recover_with_diagnostics(public_parameters);
    if o.success {
        Ok(o.points.into_iter().map(Option::unwrap).collect())
    } else {
        Err(RecoveryError {
            stats: o.stats,
            reason: o.reason,
            partial_points: o.points,
        })
    }
}

/// FUNCTIONAL TEST (positive control): when the hidden exponent IS a small
/// known integer, the same bounded GT -> G1 inversion succeeds. This only shows
/// that the pairing/lookup machinery works; it does NOT prove any general
/// correctness of an unknown-exponent recovery algorithm.
pub fn control_known_scalar(q0: G2Affine) -> (bool, u64, usize) {
    let g1_gen = G1Projective::generator();
    let hidden = g1_gen
        .mul_bigint(Fr::from(7u64).into_bigint())
        .into_affine();
    let target = pairing_g1_g2(hidden, q0);
    for c in 1..=64u64 {
        let p = g1_gen.mul_bigint(Fr::from(c).into_bigint()).into_affine();
        if pairing_g1_g2(p, q0) == target {
            return (true, c, 64);
        }
    }
    (false, 0, 64)
}

/// Final per-scheme record assembled by the independent evaluator (R3 fields).
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ExperimentResult {
    pub scheme: &'static str,
    pub saved_points: usize,
    pub missing_points: usize,
    pub scp1_bytes: u64,
    pub native_tau_g1_section_bytes: u64,
    pub scp1_baseline_bytes: u64,
    pub native_aux_bytes: u64,
    pub native_full_crs_bytes: u64,
    pub tau_g1_representation_saving_pct: f64,
    pub scp1_baseline_reduction_pct: f64,
    pub full_crs_bytes: u64,
    pub full_crs_reduction_pct: f64,
    pub implicit_generator_filled: usize,
    pub gt_targets_computed: usize,
    pub gt_target_coverage_pct: f64,
    pub candidates_tested: usize,
    pub aux_relations_checked: usize,
    /// Points newly obtained for indices that were MISSING from the compressed
    /// file (implicit P0 + successful GT->G1 inversions). NOT the saved points.
    pub recovered_points: usize,
    /// Total determined points in the result array = saved + recovered_points.
    pub determined_points: usize,
    pub recovery_success: bool,
    pub point_equality: String,
    pub recovery_ms: f64,
    pub failure_stage: &'static str,
    pub recovery_reason: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::powers;

    fn pp_for(
        dir: &Path,
        name: &'static str,
        n: usize,
        srs: &powers::TestSrs,
        saved: &[(usize, G1Affine)],
    ) -> CompressedParameters {
        fs::create_dir_all(dir).unwrap();
        let seq_len = 2 * n - 1;
        let path = dir.join(format!("{}.bin", name));
        let bytes = write_compressed_file(&path, seq_len, saved).unwrap();
        CompressedParameters {
            scheme: name,
            n,
            file_path: path,
            file_bytes: bytes,
            tau_g2: srs.tau_g2.clone(),
            alpha_tau_g1: srs.alpha_tau_g1.clone(),
            beta_tau_g1: srs.beta_tau_g1.clone(),
            beta_g2: srs.beta_g2,
        }
    }

    #[test]
    fn baseline_recovers_all_points_exactly() {
        let (_, srs) = powers::generate_for_tests(4);
        let dir = std::env::temp_dir().join(format!("srs_m2r1_{}", std::process::id()));
        let seq_len = 2 * srs.n - 1;
        let saved: Vec<(usize, G1Affine)> = (0..seq_len).map(|i| (i, srs.tau_g1[i])).collect();
        let pp = pp_for(&dir, "all", srs.n, &srs, &saved);
        let recovered = recover_missing_powers(&pp).unwrap();
        assert_eq!(recovered, srs.tau_g1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn odd_only_fills_implicit_generator_and_still_fails() {
        let (_, srs) = powers::generate_for_tests(8);
        let dir = std::env::temp_dir().join(format!("srs_m2r2_{}", std::process::id()));
        let seq_len = 2 * srs.n - 1;
        let indices = selected_indices(Scheme::Odd, seq_len, srs.n);
        let saved: Vec<(usize, G1Affine)> = indices.iter().map(|i| (*i, srs.tau_g1[*i])).collect();
        let pp = pp_for(&dir, "odd", srs.n, &srs, &saved);
        let out = recover_with_diagnostics(&pp);

        assert!(!out.success);
        assert_eq!(out.stats.missing, 8);
        // R2: P0 is public, so it is determined even though it was not saved.
        assert_eq!(out.stats.implicit_generator_filled, 1);
        assert_eq!(out.points[0], Some(CompressedParameters::p0()));
        // R2: GT target coverage is now 8/8 (was 7/8 before the fix).
        assert_eq!(out.stats.gt_targets, out.stats.missing);
        assert_eq!(out.stats.recovered, 1);
        assert!(out.points[1].is_some()); // P1 was saved in odd_only
        assert!(out.points[2].is_none()); // an even missing point is NOT recovered
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bounded_small_scalar_search_functional_test_passes() {
        let (_, srs) = powers::generate_for_tests(4);
        let (ok, c, tried) = control_known_scalar(srs.tau_g2[0]);
        assert!(ok);
        assert_eq!(c, 7);
        assert_eq!(tried, 64);
    }

    #[test]
    fn compressed_file_roundtrip() {
        let (_, srs) = powers::generate_for_tests(4);
        let dir = std::env::temp_dir().join(format!("srs_m2r3_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("roundtrip.bin");
        let saved: Vec<(usize, G1Affine)> = vec![(1, srs.tau_g1[1]), (3, srs.tau_g1[3])];
        assert_eq!(write_compressed_file(&p, 7, &saved).unwrap(), 12 + 2 * 100);
        let (seq, back) = read_saved_from_file(&p).unwrap();
        assert_eq!(seq, 7);
        assert_eq!(back, saved);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn q0_is_the_public_generator() {
        let (_, srs) = powers::generate_for_tests(4);
        assert_eq!(srs.tau_g2[0], CompressedParameters::q0());
        assert_eq!(srs.tau_g1[0], CompressedParameters::p0());
    }
}
