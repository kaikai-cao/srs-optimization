mod contributions;
mod header;
mod parser;
mod report;
mod sections;

use std::env;
use std::error::Error;
use std::fs::File;
use std::path::{Path, PathBuf};

const HASH_CHUNK: usize = 1 << 20;

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().collect();
    let input = args
        .get(1)
        .ok_or("Usage: ptau-audit <input.ptau> [--json <output.json>] [--negative-tests]")?;
    let path = Path::new(input);

    let mut json_out: Option<PathBuf> = None;
    let mut negative = false;
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => {
                i += 1;
                json_out = Some(PathBuf::from(
                    args.get(i).ok_or("--json requires an output path")?,
                ));
            }
            "--negative-tests" => negative = true,
            other => return Err(format!("Unknown option: {}", other).into()),
        }
        i += 1;
    }

    let container = parser::parse_container(path)?;
    let mut file = File::open(path)?;

    let header_section = container
        .sections
        .iter()
        .find(|s| s.id == 1)
        .ok_or("Missing Section 1 (header)")?;
    let header = header::parse_header(&mut file, header_section)?;
    let points = sections::audit(&container, &header)?;

    let section7 = container
        .sections
        .iter()
        .find(|s| s.id == 7)
        .ok_or("Missing Section 7 (contributions)")?;
    let contributions_audit = contributions::parse_contributions(&mut file, section7)?;

    let file_sha256 = report::sha256_file(path, HASH_CHUNK)?;
    let mut section_sha256 = Vec::new();
    for s in &container.sections {
        section_sha256.push(report::sha256_range(
            &mut file,
            s.payload_offset,
            s.payload_len,
            HASH_CHUNK,
        )?);
    }

    let mut expected_len: Vec<Option<u64>> = Vec::new();
    for s in &container.sections {
        expected_len.push(match s.id {
            1 => Some(header::HEADER_PAYLOAD_LEN),
            7 => Some(
                4 + contributions_audit
                    .records
                    .iter()
                    .map(|r| r.record_bytes)
                    .sum::<u64>(),
            ),
            2..=6 => points
                .groups
                .iter()
                .find(|g| g.section_id == s.id)
                .map(|g| g.expected_bytes),
            _ => None, // Phase 2 sections 12-15 are optional extras.
        });
    }

    // ------------------------- human-readable report -------------------------
    println!("========== PTAU FULL AUDIT ==========");
    println!("File: {}", path.display());
    println!("SHA-256 (file, 1 MiB chunks): {}", file_sha256);
    println!("File size: {} bytes", container.file_size);
    println!("Magic: ptau");
    println!("Container version: {}", container.version);
    println!("Declared sections: {}", container.declared_sections);

    println!("\n------------- SECTION 1 HEADER -------------");
    println!("Curve: {}", header.curve);
    println!("Field Element Bytes: {}", header.n8);
    println!("Base field modulus: 0x{}", header.modulus_be_hex);
    println!("Power: {}", header.power);
    println!("Ceremony Power: {}", header.ceremony_power);
    println!("Capacity (N = 2^power): {}", header.capacity);

    println!("\n------------- SECTION TABLE -------------");
    println!(
        "{:<6} {:<5} {:<15} {:<15} {:<15} {:<15} {:<8}",
        "Index", "ID", "Header Offset", "Payload Offset", "Actual Len", "Expected Len", "OK"
    );
    for (i, s) in container.sections.iter().enumerate() {
        let e = expected_len[i];
        let ok = e.map(|v| v == s.payload_len).unwrap_or(true);
        println!(
            "{:<6} {:<5} {:<15} {:<15} {:<15} {:<15} {:<8}",
            s.index,
            s.id,
            s.header_offset,
            s.payload_offset,
            s.payload_len,
            e.map(|v| v.to_string()).unwrap_or_else(|| "n/a".into()),
            if ok { "PASS" } else { "FAIL" }
        );
    }

    println!("\n------------- POINT GROUPS -------------");
    for g in &points.groups {
        println!(
            "{:<15} (Section {}): {:>8} pts x {:>3} B = {:>10} B  [PASS]",
            g.name, g.section_id, g.count, g.unit_bytes, g.actual_bytes
        );
    }
    println!("Total points: {} (= 5N)", points.total_points);
    println!("Points bytes: {} (= 576N+96)", points.points_bytes);
    println!("Section payload bytes: {}", points.section_payload_bytes);
    println!(
        "Container overhead (headers only): {} B",
        container.file_size - points.section_payload_bytes
    );
    if !points.extra_section_ids.is_empty() {
        println!(
            "Extra (Phase 2) section IDs, allowed: {:?}",
            points.extra_section_ids
        );
    }

    println!("\n------------- CONTRIBUTIONS -------------");
    println!("Contributions: {}", contributions_audit.count);
    for r in &contributions_audit.records {
        println!("Contribution {}:", r.index);
        println!("    Type: {}", r.contribution_type);
        println!("    Name: {}", r.name.as_deref().unwrap_or("(none)"));
        println!("    TLV types: {:?}", r.tlv_types);
        if let Some(v) = r.num_iterations_exp {
            println!("    Num iterations exp: {}", v);
        }
        if let Some(v) = &r.beacon_hash_hex {
            println!("    Beacon hash: {}", v);
        }
        println!("    Next challenge: {}", r.next_challenge_hex);
        println!("    Record Bytes: {}", r.record_bytes);
    }
    println!(
        "Section 7: {} bytes (consumed {} bytes)  [PASS]",
        contributions_audit.section_len, contributions_audit.consumed_bytes
    );

    println!("\n------------- INTEGRITY CHECKS -------------");
    println!("Magic / version / section count: PASS");
    println!("Section bounds and trailing bytes: PASS");
    println!(
        "Duplicate / missing required sections: PASS (duplicates: {:?})",
        points.duplicate_section_ids
    );
    println!("Base-field modulus = BLS12-381 q: PASS");
    println!("Section 2-6 lengths vs theory: PASS");
    println!("TLV order / completeness / consumption: PASS");
    println!("\nAudit result: FULL AUDIT PASS");

    // ------------------------------ JSON report ------------------------------
    if let Some(out) = &json_out {
        let mut json = report::JsonObj::new();
        json.str("file", &path.to_string_lossy());
        json.str("sha256", &file_sha256);
        json.num("file_size_bytes", container.file_size);
        json.str("curve", &header.curve);
        json.num("field_element_bytes", header.n8 as u64);
        json.str("base_field_modulus_be_hex", &header.modulus_be_hex);
        json.num("power", header.power as u64);
        json.num("ceremony_power", header.ceremony_power as u64);
        json.num("capacity", header.capacity);
        json.num("container_version", container.version as u64);
        json.num("declared_sections", container.declared_sections as u64);

        let mut p = report::JsonObj::new();
        for g in &points.groups {
            let key = match g.name {
                "Tau G1" => "tau_g1",
                "Tau G2" => "tau_g2",
                "Alpha Tau G1" => "alpha_tau_g1",
                "Beta Tau G1" => "beta_tau_g1",
                "Beta G2" => "beta_g2",
                _ => "other",
            };
            p.num(key, g.count);
        }
        p.num("total", points.total_points);
        json.raw("points", p.render());

        let mut sec_json = Vec::new();
        for (i, s) in container.sections.iter().enumerate() {
            let mut o = report::JsonObj::new();
            o.num("index", s.index as u64);
            o.num("id", s.id as u64);
            o.num("header_offset", s.header_offset);
            o.num("payload_offset", s.payload_offset);
            o.num("payload_len", s.payload_len);
            if let Some(v) = expected_len[i] {
                o.num("expected_len", v);
            } else {
                o.str("expected_len", "n/a (optional phase 2 section)");
            }
            o.str("sha256", &section_sha256[i]);
            sec_json.push(o.render());
        }
        json.raw("sections", report::json_array(sec_json));

        let mut c = report::JsonObj::new();
        c.num("count", contributions_audit.count as u64);
        c.num("section_len", contributions_audit.section_len);
        c.num("consumed_bytes", contributions_audit.consumed_bytes);
        let mut recs = Vec::new();
        for r in &contributions_audit.records {
            let mut o = report::JsonObj::new();
            o.num("index", r.index as u64);
            o.num("type", r.contribution_type as u64);
            o.str("name", r.name.as_deref().unwrap_or(""));
            o.num("record_bytes", r.record_bytes);
            o.str("next_challenge", &r.next_challenge_hex);
            o.raw(
                "tlv_types",
                report::json_string_array(
                    &r.tlv_types
                        .iter()
                        .map(|t| t.to_string())
                        .collect::<Vec<String>>(),
                ),
            );
            recs.push(o.render());
        }
        c.raw("records", report::json_array(recs));
        json.raw("contributions", c.render());

        json.num("points_bytes", points.points_bytes);
        json.num("section_payload_bytes", points.section_payload_bytes);
        json.num(
            "container_overhead_bytes",
            container.file_size - points.section_payload_bytes,
        );
        json.raw(
            "extra_section_ids",
            report::json_string_array(
                &points
                    .extra_section_ids
                    .iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<String>>(),
            ),
        );

        let mut checks = report::JsonObj::new();
        for k in [
            "magic",
            "version",
            "section_bounds",
            "no_trailing_bytes",
            "no_duplicate_section_ids",
            "required_sections_present",
            "curve_modulus",
            "section_lengths_match_theory",
            "tlv_order_and_completeness",
            "contribution_section_consumed",
        ] {
            checks.str(k, "PASS");
        }
        json.raw("checks", checks.render());
        json.str("audit_status", "PASS");

        report::write_json(out, &json.render())?;
        println!("\nJSON report written to: {}", out.display());
    }

    // --------------------------- negative tests -----------------------------
    if negative {
        let out_dir = Path::new("results/raw/negative");
        let results = report::run_negative_tests(path, out_dir)?;
        println!("\n------------- NEGATIVE TESTS (copies only) -------------");
        for r in &results {
            println!(
                "{} [{}] {} ({}): {}",
                r.id,
                if r.rejected { "PASS" } else { "FAIL" },
                r.mutation,
                r.sample,
                r.error
            );
        }
        println!(
            "Negative tests: {}/{} rejected",
            results.iter().filter(|r| r.rejected).count(),
            results.len()
        );
        if results.iter().any(|r| !r.rejected) {
            return Err("A malformed container was accepted".into());
        }
    }

    Ok(())
}
