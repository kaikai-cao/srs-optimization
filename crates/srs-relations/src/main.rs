mod compression_tests;
mod pairing;
mod powers;

use compression_tests::{control_known_scalar, run_all};
use pairing::verify_all;
use powers::{DEFAULT_N, generate};
use std::fs;
use std::path::Path;

fn main() {
    let n = DEFAULT_N;

    // Secrets are produced and immediately dropped; they never reach any
    // public-parameter file or recovery interface.
    let (secret, srs) = generate(n);
    drop(secret);

    println!("========== M2: ALGEBRAIC RELATIONS ==========");
    println!("Curve: BLS12-381 (arkworks 0.6.0)");
    println!("N: {}", n);
    println!("Tau G1 sequence length: {}", srs.tau_g1.len());
    println!("Fixed-seed test RNG; trapdoor scalars dropped before any experiment.");

    let counts = verify_all(&srs);
    println!("\nTau pairing relations: PASS ({} groups)", counts.tau);
    println!("Alpha pairing relations: PASS ({} groups)", counts.alpha);
    println!("Beta pairing relations: PASS ({} groups)", counts.beta);
    println!(
        "Total relation checks: {} ({} pairings)",
        counts.total(),
        counts.total() * 2
    );
    println!(
        "NOTE: structural consistency only, NOT a full Powers-of-Tau contribution verification."
    );

    let (control_ok, control_scalar, control_tried) = control_known_scalar(srs.tau_g2[0]);
    println!(
        "\nControl (hidden exponent = 7, bounded search 1..={}): recovered = {} (scalar {})",
        control_tried, control_ok, control_scalar
    );

    println!("\n========== M2-B: COMPRESSION / RECOVERY ==========");
    let out_dir = Path::new("results/raw/compression");
    let results = run_all(&srs, out_dir);

    println!(
        "{:<22} {:>7} {:>9} {:>8} {:>8} {:>9} {:>11} {:>10} {:>9} {:>12} {:>10}",
        "scheme",
        "saved",
        "file_B",
        "reduce%",
        "missing",
        "GT_targets",
        "candidates",
        "recovered",
        "success",
        "time_ms",
        "point_eq"
    );
    for r in &results {
        println!(
            "{:<22} {:>7} {:>9} {:>8.2} {:>8} {:>9} {:>11} {:>10} {:>9} {:>12.2} {:>10}",
            r.scheme,
            r.saved_points,
            r.file_bytes,
            r.storage_reduction_pct,
            r.missing_points,
            r.gt_targets_computed,
            r.candidates_tested,
            r.recovered_points,
            r.recovery_success,
            r.recovery_ms,
            r.point_equality
        );
    }
    println!(
        "\nAll non-baseline schemes fail at: {}",
        results[1].failure_stage
    );
    println!("A GT element is NOT a G1 point; recovering P_k needs the unknown exponent tau^k.");
    println!("Failure reason (odd_only): {}", results[1].recovery_reason);

    // ---------------------- machine-readable results ----------------------
    let mut fields: Vec<String> = Vec::new();
    fields.push(format!("\"curve\": \"BLS12-381\""));
    fields.push(format!("\"arkworks\": \"0.6.0\""));
    fields.push(format!("\"n\": {}", n));
    fields.push(format!(
        "\"relations\": {{\"tau\": {}, \"alpha\": {}, \"beta\": {}, \"total\": {}}}",
        counts.tau,
        counts.alpha,
        counts.beta,
        counts.total()
    ));
    fields.push(format!(
        "\"control\": {{\"hidden_scalar\": 7, \"recovered\": {}, \"found_scalar\": {}, \"searched\": {}}}",
        control_ok, control_scalar, control_tried
    ));
    let exps: Vec<String> = results
        .iter()
        .map(|r| {
            format!(
                "{{\"scheme\": \"{}\", \"saved_points\": {}, \"file_bytes\": {}, \"storage_reduction_pct\": {:.4}, \"missing_points\": {}, \"gt_targets_computed\": {}, \"candidates_tested\": {}, \"aux_relations_checked\": {}, \"recovered_points\": {}, \"recovery_success\": {}, \"point_equality\": \"{}\", \"recovery_ms\": {:.4}, \"failure_stage\": \"{}\"}}",
                r.scheme,
                r.saved_points,
                r.file_bytes,
                r.storage_reduction_pct,
                r.missing_points,
                r.gt_targets_computed,
                r.candidates_tested,
                r.aux_relations_checked,
                r.recovered_points,
                r.recovery_success,
                r.point_equality,
                r.recovery_ms,
                r.failure_stage
            )
        })
        .collect();
    fields.push(format!("\"experiments\": [{}]", exps.join(", ")));
    let json = format!("{{\n  {}\n}}\n", fields.join(",\n  "));

    fs::create_dir_all("results/raw").unwrap();
    fs::write("results/raw/m2_results.json", &json).unwrap();
    println!("\nMachine-readable results: results/raw/m2_results.json");
}
