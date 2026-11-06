//! M2 formal experiment, phases `gen` and `eval`.
//!
//! These are TWO SEPARATE PROCESS INVOCATIONS. Between them runs the independent
//! `recover` binary (see `scripts/run_m2b.sh`). Neither phase reads the other's
//! private state: `gen` never reads `recovered/`, `eval` never generates an SRS.

use ark_bls12_381::G1Affine;
use serde_json::{Value, json};
use srs_relations::compression_tests as ct;
use srs_relations::{pairing, powers, public_io, sha256};
use std::env;
use std::fs;
use std::path::Path;

fn main() {
    let phase = env::args().nth(1).unwrap_or_default();
    match phase.as_str() {
        "gen" => run_gen(),
        "eval" => run_eval(),
        _ => {
            eprintln!("usage: srs-relations <gen|eval>");
            eprintln!("       (the full 3-process experiment: scripts/run_m2b.sh)");
            std::process::exit(2);
        }
    }
}

/// PROCESS 1: generate a FRESH random SRS from OS entropy, then write ONLY
/// public parameters (+ a scoring oracle that `recover` never sees).
fn run_gen() {
    let n = powers::DEFAULT_N;
    // The trapdoor lives only in this process. No seed is returned, printed,
    // or persisted; it disappears when this process exits.
    let (secret, srs) = powers::generate_from_os_entropy(n);
    drop(secret);
    let seq_len = 2 * n - 1;
    public_io::ensure_dirs().expect("create m2b directories");

    // M2-A re-run on the RANDOM SRS (counts depend only on N, so unchanged).
    let counts = pairing::verify_all(&srs);

    let pub_dir = public_io::public_dir();
    let oracle_dir = public_io::oracle_dir();

    let aux = public_io::PublicAux {
        n,
        seq_len,
        tau_g2: srs.tau_g2.clone(),
        alpha_tau_g1: srs.alpha_tau_g1.clone(),
        beta_tau_g1: srs.beta_tau_g1.clone(),
        beta_g2: srs.beta_g2,
    };
    let aux_bytes = public_io::write_public_aux(&pub_dir, &aux).expect("write public aux");
    let aux_hash = sha256::sha256_file_hex(&pub_dir.join(public_io::AUX_FILE)).unwrap();

    let mut names: Vec<&str> = Vec::new();
    let mut file_rows: Vec<Value> = Vec::new();
    for (name, scheme) in ct::SCHEMES {
        let indices = ct::selected_indices(scheme, seq_len, n);
        let saved: Vec<(usize, G1Affine)> = indices.iter().map(|i| (*i, srs.tau_g1[*i])).collect();
        let path = pub_dir.join(format!("{}.bin", name));
        let bytes = ct::write_compressed_file(&path, seq_len, &saved)
            .expect("write compressed parameter file");
        let hash = sha256::sha256_file_hex(&path).unwrap();
        names.push(name);
        file_rows.push(json!({
            "name": format!("{}.bin", name),
            "bytes": bytes,
            "saved_points": indices.len(),
            "sha256": hash,
        }));
    }

    // The full Tau-G1 sequence is PUBLIC CRS data, but it is the scoring
    // oracle: only `eval` opens it, `recover` does not.
    let oracle_bytes =
        public_io::write_oracle(&oracle_dir, &srs.tau_g1).expect("write scoring oracle");
    let oracle_hash = sha256::sha256_file_hex(&oracle_dir.join(public_io::ORACLE_FILE)).unwrap();

    let dataset_hash = public_io::dataset_sha256(&pub_dir, &names).expect("hash public dataset");

    let relations = json!({
        "tau": counts.tau,
        "alpha": counts.alpha,
        "beta": counts.beta,
        "total": counts.total(),
        "pairings": counts.total() * 2,
    });
    public_io::write_json(&pub_dir.join(public_io::RELATIONS_FILE), &relations).unwrap();

    let manifest = json!({
        "phase": "gen",
        "curve": "BLS12-381",
        "arkworks": "0.6.0",
        "n": n,
        "seq_len": seq_len,
        "secret_model": {
            "trapdoor_source": "getrandom OS entropy (32 B seed) -> StdRng",
            "seed_persisted": false,
            "seed_committed": false,
            "trapdoor_passed_to_recovery": false,
            "note": "seed is a local variable in the gen process; it is never printed, serialized, or written to disk"
        },
        "public_dataset_sha256": dataset_hash,
        "aux_file": {"bytes": aux_bytes, "sha256": aux_hash},
        "oracle_file": {"bytes": oracle_bytes, "sha256": oracle_hash},
        "files": file_rows,
        "relations": relations,
    });
    public_io::write_json(&pub_dir.join(public_io::MANIFEST_FILE), &manifest).unwrap();

    println!("========== M2-B phase gen (independent process) ==========");
    println!(
        "Curve: BLS12-381 (arkworks 0.6.0), N = {}, seq_len = {}",
        n, seq_len
    );
    println!("Trapdoor: OS entropy (getrandom), NOT persisted / NOT committed");
    println!(
        "M2-A re-run on random SRS: tau={} alpha={} beta={} total={} ({} pairings)",
        counts.tau,
        counts.alpha,
        counts.beta,
        counts.total(),
        counts.total() * 2
    );
    println!("Public dataset SHA-256: {}", dataset_hash);
    println!(
        "Public files: aux.bin + {} scheme files (+ relations.json / manifest.json)",
        names.len()
    );
    println!(
        "Scoring oracle written to {} (read ONLY by eval)",
        oracle_dir.display()
    );
}

/// PROCESS 3: independent evaluator. Reads the oracle + recovery output,
/// scores point-by-point, computes the three storage scopes, writes JSON.
fn run_eval() {
    let pub_dir = public_io::public_dir();
    let rec_dir = public_io::recovered_dir();
    let oracle_dir = public_io::oracle_dir();

    let manifest = public_io::read_json(&pub_dir.join(public_io::MANIFEST_FILE))
        .expect("read manifest (run gen first)");
    let summary = public_io::read_json(&rec_dir.join(public_io::SUMMARY_FILE))
        .expect("read recovery summary (run recover first)");
    let oracle = public_io::read_oracle(&oracle_dir).expect("read scoring oracle");
    let n = manifest["n"].as_u64().expect("n") as usize;
    let seq_len = oracle.len();
    let scope = public_io::StorageScope::new(n);

    let names: Vec<&str> = ct::SCHEMES.iter().map(|(s, _)| *s).collect();
    let recomputed = public_io::dataset_sha256(&pub_dir, &names).expect("rehash public dataset");
    let declared = manifest["public_dataset_sha256"].as_str().unwrap_or("");
    let dataset_ok = recomputed == declared;

    let files = manifest["files"].as_array().expect("manifest files");
    let mut experiments: Vec<Value> = Vec::new();
    let mut table: Vec<ct::ExperimentResult> = Vec::new();

    for item in summary["experiments"]
        .as_array()
        .expect("summary experiments")
    {
        let name = item["scheme"].as_str().unwrap();
        let scp1_bytes = item["file_bytes"].as_u64().unwrap();
        // Cross-check the file size recorded by the recovery process.
        let decl_bytes = files
            .iter()
            .find(|f| f["name"].as_str() == Some(&format!("{}.bin", name)))
            .and_then(|f| f["bytes"].as_u64());
        assert_eq!(
            Some(scp1_bytes),
            decl_bytes,
            "file size mismatch for {}",
            name
        );

        let recovered = public_io::read_recovered(&rec_dir, name).expect("read recovered points");
        let mut equal = 0usize;
        for (idx, p) in &recovered {
            if *idx < seq_len && oracle[*idx] == *p {
                equal += 1;
            }
        }
        let determined = recovered.len();
        let all_equal = determined == seq_len && equal == seq_len;
        let point_equality = if all_equal {
            "PASS".to_string()
        } else if recovered.is_empty() {
            "N/A".to_string()
        } else {
            format!(
                "PARTIAL ({} / {} determined, {} equal)",
                determined, seq_len, equal
            )
        };

        let saved = item["saved_points"].as_u64().unwrap() as usize;
        let missing = item["missing_points"].as_u64().unwrap() as usize;
        let gt_targets = item["gt_targets_computed"].as_u64().unwrap() as usize;
        // The evaluator computes this INDEPENDENTLY from the files, instead of
        // trusting the counters reported by the recovery process.
        // `partial` = saved points UNION newly recovered points (disjoint).
        let recovered_from_missing = determined.saturating_sub(saved);
        let implicit = item["implicit_generator_filled"].as_u64().unwrap() as usize;
        assert!(
            recovered_from_missing >= implicit,
            "implicit P0 must appear in the recovery output for {}",
            name
        );
        let sizes = scope.for_representation(scp1_bytes);
        let coverage = if missing == 0 {
            100.0
        } else {
            gt_targets as f64 / missing as f64 * 100.0
        };

        let record = ct::ExperimentResult {
            scheme: ct::SCHEMES
                .iter()
                .find(|(s, _)| *s == name)
                .map(|(s, _)| *s)
                .unwrap_or("unknown"),
            saved_points: saved,
            missing_points: missing,
            scp1_bytes,
            native_tau_g1_section_bytes: scope.native_tau_g1_section_bytes,
            scp1_baseline_bytes: scope.scp1_baseline_bytes,
            native_aux_bytes: scope.native_aux_bytes,
            native_full_crs_bytes: scope.native_full_crs_bytes,
            tau_g1_representation_saving_pct: sizes.tau_g1_representation_saving_pct,
            scp1_baseline_reduction_pct: sizes.scp1_baseline_reduction_pct,
            full_crs_bytes: sizes.full_crs_bytes,
            full_crs_reduction_pct: sizes.full_crs_reduction_pct,
            implicit_generator_filled: item["implicit_generator_filled"].as_u64().unwrap() as usize,
            gt_targets_computed: gt_targets,
            gt_target_coverage_pct: coverage,
            candidates_tested: item["candidates_tested"].as_u64().unwrap() as usize,
            aux_relations_checked: item["aux_relations_checked"].as_u64().unwrap() as usize,
            recovered_points: recovered_from_missing,
            determined_points: determined,
            recovery_success: all_equal,
            point_equality: point_equality.clone(),
            recovery_ms: item["recovery_ms"].as_f64().unwrap(),
            failure_stage: if all_equal {
                "n/a (baseline, no missing points)"
            } else {
                "GT -> G1 inversion (recovering an unknown tau^k exponent)"
            },
            recovery_reason: item["reason"].as_str().unwrap_or("").to_string(),
        };

        experiments.push(json!({
            "scheme": record.scheme,
            "saved_points": record.saved_points,
            "missing_points": record.missing_points,
            "scp1_bytes": record.scp1_bytes,
            "native_tau_g1_section_bytes": record.native_tau_g1_section_bytes,
            "scp1_baseline_bytes": record.scp1_baseline_bytes,
            "tau_g1_representation_saving_pct": round2(record.tau_g1_representation_saving_pct),
            "scp1_baseline_reduction_pct": round2(record.scp1_baseline_reduction_pct),
            "native_aux_bytes": record.native_aux_bytes,
            "native_full_crs_bytes": record.native_full_crs_bytes,
            "full_crs_bytes": record.full_crs_bytes,
            "full_crs_reduction_pct": round2(record.full_crs_reduction_pct),
            "implicit_generator_filled": record.implicit_generator_filled,
            "gt_targets_computed": record.gt_targets_computed,
            "gt_target_coverage_pct": round2(record.gt_target_coverage_pct),
            "candidates_tested": record.candidates_tested,
            "aux_relations_checked": record.aux_relations_checked,
            "recovered_points": record.recovered_points,
            "determined_points": record.determined_points,
            "recovery_success": record.recovery_success,
            "point_equality": record.point_equality,
            "recovery_ms": round2(record.recovery_ms),
            "failure_stage": record.failure_stage,
            "recovery_reason": record.recovery_reason,
        }));
        table.push(record);
    }

    let control = &summary["control"];
    let results = json!({
        "experiment": "M2-B (R1-R4 revision)",
        "curve": "BLS12-381",
        "arkworks": "0.6.0",
        "n": n,
        "seq_len": seq_len,
        "secret_model": manifest["secret_model"],
        "public_dataset_sha256": declared,
        "public_dataset_sha256_recomputed": recomputed,
        "public_dataset_hash_match": dataset_ok,
        "relations": manifest["relations"],
        "control": {
            "description": "小标量有界搜索功能测试通过 (bounded small-scalar search functional test)",
            "hidden_scalar": control["hidden_scalar"],
            "recovered": control["recovered"],
            "found_scalar": control["found_scalar"],
            "searched": control["searched"],
            "scope_note": "only verifies the pairing/lookup machinery; NOT a general correctness proof for unknown-exponent recovery"
        },
        "storage_scope": {
            "unit": "bytes",
            "native_tau_g1_section_bytes": scope.native_tau_g1_section_bytes,
            "scp1_representation_baseline_bytes": scope.scp1_baseline_bytes,
            "native_aux_bytes": scope.native_aux_bytes,
            "native_full_crs_bytes": scope.native_full_crs_bytes,
            "note": "all percentages are REPRESENTATION savings, NOT valid CRS compression ratios (missing points are not recovered)"
        },
        "experiments": experiments,
    });
    fs::create_dir_all("results/raw").unwrap();
    public_io::write_json(Path::new("results/raw/m2_results.json"), &results).unwrap();

    println!("\n========== M2-B phase eval (independent process) ==========");
    println!("Public dataset SHA-256 : {}", declared);
    println!("Recomputed / match     : {} / {}", recomputed, dataset_ok);
    println!(
        "Storage scopes (B)     : native TauG1={}  SCP1 baseline={}  aux={}  full CRS={}",
        scope.native_tau_g1_section_bytes,
        scope.scp1_baseline_bytes,
        scope.native_aux_bytes,
        scope.native_full_crs_bytes
    );
    println!(
        "\n{:<22} {:>6} {:>9} {:>9} {:>9} {:>7} {:>7} {:>8} {:>8} {:>8} {:>8}",
        "scheme",
        "saved",
        "scp1_B",
        "native_B",
        "save%",
        "missing",
        "GT",
        "cover%",
        "determ",
        "new_rec",
        "success"
    );
    for r in &table {
        println!(
            "{:<22} {:>6} {:>9} {:>9} {:>9.3} {:>7} {:>7} {:>8.1} {:>8} {:>8} {:>8}",
            r.scheme,
            r.saved_points,
            r.scp1_bytes,
            r.native_tau_g1_section_bytes,
            r.tau_g1_representation_saving_pct,
            r.missing_points,
            r.gt_targets_computed,
            r.gt_target_coverage_pct,
            r.determined_points,
            r.recovered_points,
            r.recovery_success
        );
    }
    println!(
        "determ = points determined in result (saved + new_rec); new_rec = points recovered from MISSING indices."
    );
    println!("\nMachine-readable results: results/raw/m2_results.json");
    println!(
        "NOTE: percentages are Tau-G1 REPRESENTATION savings, not valid CRS compression ratios."
    );
}

fn round2(v: f64) -> f64 {
    (v * 10000.0).round() / 10000.0
}
