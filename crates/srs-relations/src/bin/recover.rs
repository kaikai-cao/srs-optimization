//! INDEPENDENT RECOVERY PROCESS (R1).
//!
//! Inputs:  ONLY `results/raw/m2b/public/` (aux.bin + seven SCP1 files).
//! Outputs: `results/raw/m2b/recovered/` (partial points + summary.json).
//!
//! This process NEVER opens `oracle/`, NEVER generates an SRS, and NEVER
//! receives tau/alpha/beta, the seed, or the complete Tau-G1 array. It is a
//! separate OS process launched by `scripts/run_m2b.sh` between `gen` and
//! `eval`, so the generator's in-memory full array cannot leak into it.
//!
//! Isolation is process-level and input-level (not a separately compiled
//! crate): this binary only calls the public `public_io` / `compression_tests`
//! APIs and has no code path that reads the oracle or a trapdoor.

use serde_json::{Value, json};
use srs_relations::compression_tests as ct;
use srs_relations::public_io;
use std::fs;
use std::time::Instant;

fn main() {
    let pub_dir = public_io::public_dir();
    let out_dir = public_io::recovered_dir();
    fs::create_dir_all(&out_dir).expect("create recovered dir");

    // The ONLY data source of this process.
    let aux = public_io::read_public_aux(&pub_dir).expect("read public auxiliary parameters");

    let mut rows: Vec<Value> = Vec::new();
    for (name, _) in ct::SCHEMES {
        let file_path = pub_dir.join(format!("{}.bin", name));
        let file_bytes = fs::metadata(&file_path)
            .expect("stat public compressed file")
            .len();

        let pp = ct::CompressedParameters {
            scheme: name,
            n: aux.n,
            file_path,
            file_bytes,
            tau_g2: aux.tau_g2.clone(),
            alpha_tau_g1: aux.alpha_tau_g1.clone(),
            beta_tau_g1: aux.beta_tau_g1.clone(),
            beta_g2: aux.beta_g2,
        };

        let start = Instant::now();
        let outcome = ct::recover_with_diagnostics(&pp);
        let recovery_ms = start.elapsed().as_secs_f64() * 1000.0;

        let partial: Vec<(usize, ark_bls12_381::G1Affine)> = outcome
            .points
            .iter()
            .enumerate()
            .filter_map(|(i, p)| p.map(|x| (i, x)))
            .collect();
        public_io::write_recovered(&out_dir, name, &partial).expect("write recovered points");

        let s = &outcome.stats;
        rows.push(json!({
            "scheme": name,
            "file_bytes": file_bytes,
            "saved_points": s.saved,
            "missing_points": s.missing,
            "gt_targets_computed": s.gt_targets,
            "implicit_generator_filled": s.implicit_generator_filled,
            "candidates_tested": s.candidates,
            "aux_relations_checked": s.aux_relations_checked,
            "determined_points": partial.len(),
            "newly_recovered_points": s.recovered,
            "recovery_success": outcome.success,
            "recovery_ms": (recovery_ms * 10000.0).round() / 10000.0,
            "reason": outcome.reason,
        }));
    }

    // Functional test of the bounded small-scalar search machinery.
    let (ok, found, searched) = ct::control_known_scalar(aux.tau_g2[0]);
    let summary = json!({
        "process": "recover",
        "inputs": ["public/aux.bin", "public/<scheme>.bin x7"],
        "oracle_accessed": false,
        "trapdoor_accessed": false,
        "experiments": rows,
        "control": {
            "hidden_scalar": 7,
            "recovered": ok,
            "found_scalar": found,
            "searched": searched,
        },
    });
    public_io::write_json(&out_dir.join(public_io::SUMMARY_FILE), &summary).unwrap();

    println!("========== M2-B phase recover (independent process) ==========");
    println!(
        "Inputs: public/aux.bin + {} public SCP1 files",
        ct::SCHEMES.len()
    );
    println!("Oracle accessed: false | trapdoor accessed: false");
    println!(
        "Control (bounded small-scalar search): recovered={}, scalar={}, tried={}",
        ok, found, searched
    );
    for r in &rows {
        println!(
            "  {:<22} missing={:>3} GT={:>3} implicit_P0={} new_rec={:>2} success={}",
            r["scheme"].as_str().unwrap(),
            r["missing_points"].as_u64().unwrap(),
            r["gt_targets_computed"].as_u64().unwrap(),
            r["implicit_generator_filled"].as_u64().unwrap(),
            r["newly_recovered_points"].as_u64().unwrap(),
            r["recovery_success"].as_bool().unwrap()
        );
    }
}
