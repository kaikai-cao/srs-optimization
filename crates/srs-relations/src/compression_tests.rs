use crate::pairing::{Gt, pairing_g1_g2};
use crate::powers::TestSrs;
use ark_bls12_381::{Fr, G1Affine, G1Projective, G2Affine};
use ark_ec::{AffineRepr, CurveGroup, PrimeGroup};
use ark_ff::PrimeField;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

const FILE_MAGIC: &[u8; 4] = b"SCP1";

/// Public, compressed parameter subset. Contains NO trapdoor scalars and NO
/// complete Tau-G1 array. The Tau-G1 points live only in `file_path`.
/// Some fields are metadata kept for reporting / reproducibility.
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

/// Diagnostic counters from one recovery attempt; some fields are recorded for
/// reproducibility even when the harness does not print them.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Default)]
pub struct RecoveryStats {
    pub sequence_len: usize,
    pub saved: usize,
    pub missing: usize,
    pub gt_targets: usize,
    pub candidates: usize,
    pub aux_relations_checked: usize,
    pub recovered: usize,
}

#[derive(Debug, Clone)]
pub struct RecoveryError {
    pub stats: RecoveryStats,
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

#[derive(Debug, Clone)]
pub struct ExperimentResult {
    pub scheme: &'static str,
    pub saved_points: usize,
    pub file_bytes: u64,
    pub storage_reduction_pct: f64,
    pub missing_points: usize,
    pub gt_targets_computed: usize,
    pub candidates_tested: usize,
    pub aux_relations_checked: usize,
    pub recovered_points: usize,
    pub recovery_success: bool,
    pub point_equality: &'static str,
    pub recovery_ms: f64,
    pub failure_stage: &'static str,
    pub recovery_reason: String,
}

fn selected_indices(scheme: Scheme, seq_len: usize, n: usize) -> Vec<usize> {
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

/// File layout: magic(4) | sequence_len u32 | count u32 |
///              count x [ index u32 | 96 B uncompressed arkworks G1Affine ].
/// NOTE: arkworks canonical serialization is NOT the same as snarkjs LEM/Montgomery
/// encoding. These files are M2-only mathematical fixtures, not .ptau fragments.
fn write_compressed_file(
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
/// integer linear combinations of saved points, doubling/negation, and small
/// known scalar multiples of the generator.
fn build_candidates(saved: &[(usize, G1Affine)], pp: &CompressedParameters) -> Vec<G1Affine> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let g1_gen = G1Projective::generator();

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

    // Also try the other public G1 families (alpha*tau^i, beta*tau^i) and their
    // doubles: they are legitimate public inputs to any recovery attempt.
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
/// Allowed: group law on saved G1 points, known scalar multiplication, G2 points,
/// bilinear pairings, and publicly computable auxiliary values.
/// Forbidden (by construction): tau / alpha / beta, and the original full array.
///
/// Strategy:
///  1. Fill indices already present in the compressed file.
///  2. For each missing k, compute a GT target t_k = e(P_i, Q_{k-i}) whenever a
///     saved index i and a legal G2 index j = k-i exist (M2-A verified identity).
///  3. Build a bounded candidate set of G1 points reachable by public operations.
///  4. Try to invert e(., Q_0): G1 -> GT by looking up t_k among candidate images.
///  5. Any G1 point found is re-verified with a pairing and compared afterwards.
///
/// A GT target alone is NOT a recovered G1 point. If inversion fails, the whole
/// recovery is reported as failed.
pub fn recover_missing_powers(
    public_parameters: &CompressedParameters,
) -> Result<Vec<G1Affine>, RecoveryError> {
    let (seq_len, saved) =
        read_saved_from_file(&public_parameters.file_path).map_err(|e| RecoveryError {
            stats: RecoveryStats::default(),
            reason: format!("cannot read compressed file: {}", e),
        })?;

    let mut present: HashMap<usize, G1Affine> = HashMap::new();
    for (i, p) in &saved {
        present.insert(*i, *p);
    }
    let missing: Vec<usize> = (0..seq_len).filter(|i| !present.contains_key(i)).collect();
    let mut result: Vec<Option<G1Affine>> =
        (0..seq_len).map(|i| present.get(&i).copied()).collect();

    if missing.is_empty() {
        return Ok(result.into_iter().map(Option::unwrap).collect());
    }

    // Step 2: GT targets from the tau-powers pairing identity.
    let mut targets: Vec<(usize, Gt)> = Vec::new();
    for &k in &missing {
        for (i, p) in &saved {
            if *i <= k {
                let j = k - *i;
                if j < public_parameters.tau_g2.len() {
                    targets.push((k, pairing_g1_g2(*p, public_parameters.tau_g2[j])));
                    break;
                }
            }
        }
    }

    let q0 = public_parameters.tau_g2[0];

    // Cross-check the beta family on public data: e(B_i, Q_0) = e(P_i, B_2).
    // This uses the auxiliary G2 element, but still produces only GT elements.
    let mut aux_relations_checked = 0usize;
    for (i, p) in &saved {
        if *i < public_parameters.n && *i < public_parameters.beta_tau_g1.len() {
            let lhs = pairing_g1_g2(public_parameters.beta_tau_g1[*i], q0);
            let rhs = pairing_g1_g2(*p, public_parameters.beta_g2);
            if lhs == rhs {
                aux_relations_checked += 1;
            }
        }
    }
    // Step 3 & 4: bounded GT -> G1 inversion over publicly constructible points.
    let candidates = build_candidates(&saved, public_parameters);
    let mut gt_map: HashMap<Gt, G1Affine> = HashMap::new();
    for x in &candidates {
        let image = pairing_g1_g2(*x, q0);
        gt_map.entry(image).or_insert(*x);
    }

    let mut recovered = 0usize;
    for (k, t) in &targets {
        if let Some(x) = gt_map.get(t) {
            if pairing_g1_g2(*x, q0) == *t {
                result[*k] = Some(*x);
                recovered += 1;
            }
        }
    }

    let stats = RecoveryStats {
        sequence_len: seq_len,
        saved: saved.len(),
        missing: missing.len(),
        gt_targets: targets.len(),
        candidates: candidates.len(),
        aux_relations_checked,
        recovered,
    };

    if result.iter().any(Option::is_none) {
        Err(RecoveryError {
            stats,
            reason: "pairing yields GT elements only; GT -> G1 inversion requires solving \
                     the discrete log of tau^k, which is not a known public scalar"
                .to_string(),
        })
    } else {
        Ok(result.into_iter().map(Option::unwrap).collect())
    }
}

/// Positive control: when the hidden exponent IS a small known integer, the same
/// bounded GT -> G1 inversion succeeds. This proves the failure above is caused
/// by the unknown exponent, not by a broken pairing/verification implementation.
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

pub fn run_all(srs: &TestSrs, out_dir: &Path) -> Vec<ExperimentResult> {
    fs::create_dir_all(out_dir).expect("create compression output dir");
    let seq_len = 2 * srs.n - 1;
    // Kept in the harness ONLY as a comparison oracle; never passed to recovery.
    let original = srs.tau_g1.clone();
    let mut results = Vec::new();
    let baseline_bytes = 12u64 + (seq_len as u64) * 100;

    for (name, scheme) in SCHEMES {
        let indices = selected_indices(scheme, seq_len, srs.n);
        let saved: Vec<(usize, G1Affine)> = indices.iter().map(|i| (*i, srs.tau_g1[*i])).collect();
        let file_path = out_dir.join(format!("{}.bin", name));
        let file_bytes = write_compressed_file(&file_path, seq_len, &saved)
            .expect("write compressed parameter file");
        // The full array is deliberately not copied into `pp`.
        drop(saved);

        let pp = CompressedParameters {
            scheme: name,
            n: srs.n,
            file_path,
            file_bytes,
            tau_g2: srs.tau_g2.clone(),
            alpha_tau_g1: srs.alpha_tau_g1.clone(),
            beta_tau_g1: srs.beta_tau_g1.clone(),
            beta_g2: srs.beta_g2,
        };

        let start = Instant::now();
        let attempt = recover_missing_powers(&pp);
        let recovery_ms = start.elapsed().as_secs_f64() * 1000.0;

        let (recovery_success, point_equality, stats, failure_stage, recovery_reason) =
            match attempt {
                Ok(recovered) => {
                    let equal = recovered.len() == original.len()
                        && recovered.iter().zip(&original).all(|(a, b)| a == b);
                    (
                        true,
                        if equal { "PASS" } else { "FAIL" },
                        RecoveryStats {
                            sequence_len: seq_len,
                            saved: indices.len(),
                            missing: seq_len - indices.len(),
                            gt_targets: 0,
                            candidates: 0,
                            aux_relations_checked: 0,
                            recovered: recovered.len(),
                        },
                        "n/a (baseline, no missing points)",
                        "n/a".to_string(),
                    )
                }
                Err(e) => (
                    false,
                    "N/A",
                    e.stats,
                    "GT -> G1 inversion (recovering an unknown tau^k exponent)",
                    e.reason,
                ),
            };

        results.push(ExperimentResult {
            scheme: name,
            saved_points: indices.len(),
            file_bytes,
            storage_reduction_pct: (1.0 - file_bytes as f64 / baseline_bytes as f64) * 100.0,
            missing_points: seq_len - indices.len(),
            gt_targets_computed: stats.gt_targets,
            candidates_tested: stats.candidates,
            aux_relations_checked: stats.aux_relations_checked,
            recovered_points: stats.recovered,
            recovery_success,
            point_equality,
            recovery_ms,
            failure_stage,
            recovery_reason,
        });
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::powers;

    #[test]
    fn baseline_recovers_all_points_exactly() {
        let (_, srs) = powers::generate(4);
        let dir = std::env::temp_dir().join(format!("srs_m2_{}", std::process::id()));
        let r = run_all(&srs, &dir);
        assert!(r[0].recovery_success);
        assert_eq!(r[0].point_equality, "PASS");
        assert_eq!(r[0].saved_points, 7);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn odd_only_and_first_half_fail_to_recover() {
        let (_, srs) = powers::generate(8);
        let dir = std::env::temp_dir().join(format!("srs_m2b_{}", std::process::id()));
        let r = run_all(&srs, &dir);
        assert!(!r[1].recovery_success);
        assert!(!r[3].recovery_success);
        assert_eq!(r[1].recovered_points, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn control_with_known_small_exponent_succeeds() {
        let (_, srs) = powers::generate(4);
        let (ok, c, tried) = control_known_scalar(srs.tau_g2[0]);
        assert!(ok);
        assert_eq!(c, 7);
        assert_eq!(tried, 64);
    }

    #[test]
    fn compressed_file_roundtrip() {
        let (_, srs) = powers::generate(4);
        let dir = std::env::temp_dir().join(format!("srs_m2c_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("roundtrip.bin");
        let saved: Vec<(usize, G1Affine)> = vec![(1, srs.tau_g1[1]), (3, srs.tau_g1[3])];
        assert_eq!(write_compressed_file(&p, 7, &saved).unwrap(), 12 + 2 * 100);
        let (seq, back) = read_saved_from_file(&p).unwrap();
        assert_eq!(seq, 7);
        assert_eq!(back, saved);
        let _ = fs::remove_dir_all(&dir);
    }
}
