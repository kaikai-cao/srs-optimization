use crate::header::{G1_UNCOMPRESSED_BYTES, G2_UNCOMPRESSED_BYTES, PtauHeader};
use crate::parser::{PtauContainer, Section};
use std::collections::BTreeMap;
use std::error::Error;

pub const REQUIRED_SECTION_IDS: [u32; 7] = [1, 2, 3, 4, 5, 6, 7];

#[derive(Debug, Clone)]
pub struct PointGroup {
    pub name: &'static str,
    pub section_id: u32,
    pub count: u64,
    pub unit_bytes: u64,
    pub expected_bytes: u64,
    pub actual_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct PointsAudit {
    pub groups: Vec<PointGroup>,
    pub total_points: u64,
    pub points_bytes: u64,
    pub section_payload_bytes: u64,
    pub duplicate_section_ids: Vec<u32>,
    /// Phase 2 sections (e.g. 12-15) are legal extras, recorded but never rejected.
    pub extra_section_ids: Vec<u32>,
}

fn find_unique_id<'a>(
    by_id: &BTreeMap<u32, Vec<&'a Section>>,
    id: u32,
) -> Result<&'a Section, Box<dyn Error>> {
    match by_id.get(&id) {
        Some(v) if v.len() == 1 => Ok(v[0]),
        Some(_) => Err(format!("Section {} appears more than once", id).into()),
        None => Err(format!("Missing required section {}", id).into()),
    }
}

/// Derive the five point-group counts from the header capacity and verify that
/// every Section 2-6 payload length matches the theoretical byte count.
pub fn audit(
    container: &PtauContainer,
    header: &PtauHeader,
) -> Result<PointsAudit, Box<dyn Error>> {
    let mut by_id: BTreeMap<u32, Vec<&Section>> = BTreeMap::new();
    for s in &container.sections {
        by_id.entry(s.id).or_default().push(s);
    }

    let duplicate_section_ids: Vec<u32> = by_id
        .iter()
        .filter(|(_, v)| v.len() > 1)
        .map(|(k, _)| *k)
        .collect();
    if !duplicate_section_ids.is_empty() {
        return Err(format!("Duplicate section IDs: {:?}", duplicate_section_ids).into());
    }

    let missing: Vec<u32> = REQUIRED_SECTION_IDS
        .iter()
        .copied()
        .filter(|id| !by_id.contains_key(id))
        .collect();
    if !missing.is_empty() {
        return Err(format!("Missing required sections: {:?}", missing).into());
    }

    let extra_section_ids: Vec<u32> = by_id
        .keys()
        .copied()
        .filter(|id| !REQUIRED_SECTION_IDS.contains(id))
        .collect();

    let n = header.capacity;
    let tau_g1_count = n
        .checked_mul(2)
        .and_then(|v| v.checked_sub(1))
        .ok_or("Capacity overflow while computing 2N-1")?;

    let spec: [(&str, u32, u64, u64); 5] = [
        ("Tau G1", 2, tau_g1_count, G1_UNCOMPRESSED_BYTES),
        ("Tau G2", 3, n, G2_UNCOMPRESSED_BYTES),
        ("Alpha Tau G1", 4, n, G1_UNCOMPRESSED_BYTES),
        ("Beta Tau G1", 5, n, G1_UNCOMPRESSED_BYTES),
        ("Beta G2", 6, 1, G2_UNCOMPRESSED_BYTES),
    ];

    let mut groups = Vec::new();
    for (name, id, count, unit_bytes) in spec {
        let expected_bytes = count
            .checked_mul(unit_bytes)
            .ok_or("Byte count overflow for point group")?;
        let section = find_unique_id(&by_id, id)?;
        let actual_bytes = section.payload_len;
        if actual_bytes != expected_bytes {
            return Err(format!(
                "Section {} ({}) length mismatch: expected {} B, actual {} B",
                id, name, expected_bytes, actual_bytes
            )
            .into());
        }
        groups.push(PointGroup {
            name,
            section_id: id,
            count,
            unit_bytes,
            expected_bytes,
            actual_bytes,
        });
    }

    let total_points = n.checked_mul(5).ok_or("Point count overflow")?;
    let points_bytes = groups.iter().try_fold(0u64, |acc, g| {
        acc.checked_add(g.expected_bytes)
            .ok_or("Point byte total overflow")
    })?;
    let formula = n
        .checked_mul(576)
        .and_then(|v| v.checked_add(96))
        .ok_or("576N+96 overflow")?;
    if points_bytes != formula {
        return Err(format!(
            "Point-byte identity broken: sum={}, 576N+96={}",
            points_bytes, formula
        )
        .into());
    }

    let section_payload_bytes = container.sections.iter().try_fold(0u64, |acc, s| {
        acc.checked_add(s.payload_len)
            .ok_or("Payload total overflow")
    })?;

    Ok(PointsAudit {
        groups,
        total_points,
        points_bytes,
        section_payload_bytes,
        duplicate_section_ids,
        extra_section_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_container(n: u64) -> (PtauContainer, PtauHeader) {
        let sizes: [(u32, u64); 7] = [
            (1, 60),
            (2, (2 * n - 1) * 96),
            (3, n * 192),
            (4, n * 96),
            (5, n * 96),
            (6, 192),
            (7, 4),
        ];
        let mut offset = 12u64 + 7 * 12;
        let sections = sizes
            .iter()
            .enumerate()
            .map(|(i, (id, len))| {
                let s = Section {
                    index: i as u32 + 1,
                    id: *id,
                    header_offset: offset - 12,
                    payload_offset: offset,
                    payload_len: *len,
                };
                offset += *len + 12;
                s
            })
            .collect::<Vec<_>>();
        (
            PtauContainer {
                version: 1,
                declared_sections: 7,
                file_size: offset - 12,
                sections,
            },
            PtauHeader {
                curve: "BLS12-381".to_string(),
                n8: 48,
                modulus_be_hex: String::new(),
                power: 10,
                ceremony_power: 10,
                capacity: n,
            },
        )
    }

    #[test]
    fn power_10_counts_and_bytes() {
        let (c, h) = fake_container(1024);
        let a = audit(&c, &h).unwrap();
        assert_eq!(a.groups[0].count, 2047);
        assert_eq!(a.total_points, 5120);
        assert_eq!(a.points_bytes, 589_920);
        assert_eq!(a.points_bytes, 576 * 1024 + 96);
    }

    #[test]
    fn mismatched_section_length_is_rejected() {
        let (mut c, h) = fake_container(1024);
        c.sections[1].payload_len -= 96;
        assert!(audit(&c, &h).is_err());
    }

    #[test]
    fn phase2_extra_sections_are_allowed() {
        let (mut c, h) = fake_container(1024);
        c.sections.push(Section {
            index: 8,
            id: 12,
            header_offset: 0,
            payload_offset: 0,
            payload_len: 1024,
        });
        let a = audit(&c, &h).unwrap();
        assert_eq!(a.extra_section_ids, vec![12]);
    }

    #[test]
    fn duplicate_section_id_is_rejected() {
        let (mut c, h) = fake_container(1024);
        let dup = c.sections[1].clone();
        c.sections.push(dup);
        assert!(audit(&c, &h).is_err());
    }
}
