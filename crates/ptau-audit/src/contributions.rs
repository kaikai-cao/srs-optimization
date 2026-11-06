use crate::parser::Section;
use std::error::Error;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

pub const CONTRIB_TAU_G1: u64 = 96;
pub const CONTRIB_TAU_G2: u64 = 192;
pub const CONTRIB_ALPHA_G1: u64 = 96;
pub const CONTRIB_BETA_G1: u64 = 96;
pub const CONTRIB_BETA_G2: u64 = 192;
pub const CONTRIB_PUBLIC_KEY: u64 = 1152;
pub const CONTRIB_PARTIAL_HASH: u64 = 216;
pub const CONTRIB_NEXT_CHALLENGE: u64 = 64;
pub const CONTRIB_TYPE: u64 = 4;
pub const CONTRIB_PARAMS_LEN_FIELD: u64 = 4;

/// Fixed part of one contribution record, including the u32 parameter-length field.
pub const FIXED_PART_BYTES: u64 = CONTRIB_TAU_G1
    + CONTRIB_TAU_G2
    + CONTRIB_ALPHA_G1
    + CONTRIB_BETA_G1
    + CONTRIB_BETA_G2
    + CONTRIB_PUBLIC_KEY
    + CONTRIB_PARTIAL_HASH
    + CONTRIB_NEXT_CHALLENGE
    + CONTRIB_TYPE
    + CONTRIB_PARAMS_LEN_FIELD;

pub const TLV_NAME: u8 = 1;
pub const TLV_NUM_ITERATIONS_EXP: u8 = 2;
pub const TLV_BEACON_HASH: u8 = 3;

#[derive(Debug, Clone)]
pub struct TlvParam {
    pub param_type: u8,
    pub value: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ContributionRecord {
    pub index: u32,
    pub record_bytes: u64,
    pub contribution_type: u32,
    pub name: Option<String>,
    pub num_iterations_exp: Option<u8>,
    pub beacon_hash_hex: Option<String>,
    pub next_challenge_hex: String,
    pub tlv_types: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ContributionsAudit {
    pub section_len: u64,
    pub count: u32,
    pub records: Vec<ContributionRecord>,
    pub consumed_bytes: u64,
}

fn read_u32(file: &mut File) -> Result<u32, Box<dyn Error>> {
    let mut buf = [0u8; 4];
    file.read_exact(&mut buf)?;
    Ok(u32::from_le_bytes(buf))
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn parse_tlvs(buf: &[u8]) -> Result<Vec<TlvParam>, Box<dyn Error>> {
    let mut pos = 0usize;
    let mut last_type = 0u8;
    let mut out = Vec::new();

    while pos < buf.len() {
        let t = buf[pos];
        pos += 1;
        // snarkjs readContribution requires strictly increasing parameter types.
        if t <= last_type {
            return Err(format!(
                "TLV parameter types must be strictly increasing: got {} after {}",
                t, last_type
            )
            .into());
        }
        last_type = t;

        match t {
            TLV_NAME | TLV_BEACON_HASH => {
                if pos >= buf.len() {
                    return Err("Truncated TLV length byte".into());
                }
                let len = buf[pos] as usize;
                pos += 1;
                if pos + len > buf.len() {
                    return Err(format!(
                        "Truncated TLV value for type {}: need {} B, have {} B",
                        t,
                        len,
                        buf.len() - pos
                    )
                    .into());
                }
                out.push(TlvParam {
                    param_type: t,
                    value: buf[pos..pos + len].to_vec(),
                });
                pos += len;
            }
            // Type 2 carries a single value byte, not a length-prefixed blob.
            TLV_NUM_ITERATIONS_EXP => {
                if pos >= buf.len() {
                    return Err("Truncated TLV value for type 2".into());
                }
                out.push(TlvParam {
                    param_type: t,
                    value: vec![buf[pos]],
                });
                pos += 1;
            }
            other => return Err(format!("Unrecognized TLV parameter type: {}", other).into()),
        }
    }

    if pos != buf.len() {
        return Err("TLV parameter region not fully consumed".into());
    }
    Ok(out)
}

/// Parse Section 7: u32 count, then `count` records of 2112 B fixed part plus
/// a length-prefixed TLV parameter region. Checks exact section consumption.
pub fn parse_contributions(
    file: &mut File,
    section: &Section,
) -> Result<ContributionsAudit, Box<dyn Error>> {
    if section.id != 7 {
        return Err(format!("Section 7 expected, got section id {}", section.id).into());
    }
    if section.payload_len < 4 {
        return Err("Section 7 too short to hold the contribution counter".into());
    }
    let section_end = section
        .payload_offset
        .checked_add(section.payload_len)
        .ok_or("Section 7 offset overflow")?;

    file.seek(SeekFrom::Start(section.payload_offset))?;
    let count = read_u32(file)?;

    // Bound the declared count before allocating anything.
    let max_records = (section.payload_len - 4) / FIXED_PART_BYTES;
    if count as u64 > max_records {
        return Err(format!(
            "Contribution count {} exceeds Section 7 capacity (max {})",
            count, max_records
        )
        .into());
    }

    let mut records = Vec::new();
    let mut fixed = vec![0u8; FIXED_PART_BYTES as usize];

    for i in 0..count {
        let record_start = file.stream_position()?;
        file.read_exact(&mut fixed)?;

        let mut off = (CONTRIB_TAU_G1
            + CONTRIB_TAU_G2
            + CONTRIB_ALPHA_G1
            + CONTRIB_BETA_G1
            + CONTRIB_BETA_G2
            + CONTRIB_PUBLIC_KEY
            + CONTRIB_PARTIAL_HASH) as usize;
        let next_challenge_hex = bytes_to_hex(&fixed[off..off + CONTRIB_NEXT_CHALLENGE as usize]);
        off += CONTRIB_NEXT_CHALLENGE as usize;
        let contribution_type = u32::from_le_bytes(fixed[off..off + 4].try_into().unwrap());
        off += 4;
        let params_len = u32::from_le_bytes(fixed[off..off + 4].try_into().unwrap()) as u64;

        let remaining = section_end
            .checked_sub(file.stream_position()?)
            .ok_or("Contribution record exceeds Section 7")?;
        if params_len > remaining {
            return Err(format!(
                "TLV parameter region ({} B) exceeds remaining Section 7 bytes ({} B)",
                params_len, remaining
            )
            .into());
        }

        let mut params_buf = vec![0u8; params_len as usize];
        file.read_exact(&mut params_buf)?;
        let tlvs = parse_tlvs(&params_buf)?;

        let mut name = None;
        let mut num_iterations_exp = None;
        let mut beacon_hash_hex = None;
        for tlv in &tlvs {
            match tlv.param_type {
                TLV_NAME => {
                    name = Some(String::from_utf8(tlv.value.clone())?);
                }
                TLV_NUM_ITERATIONS_EXP => {
                    num_iterations_exp = Some(tlv.value[0]);
                }
                TLV_BEACON_HASH => {
                    beacon_hash_hex = Some(bytes_to_hex(&tlv.value));
                }
                _ => unreachable!(),
            }
        }

        let record_end = file.stream_position()?;
        records.push(ContributionRecord {
            index: i + 1,
            record_bytes: record_end - record_start,
            contribution_type,
            name,
            num_iterations_exp,
            beacon_hash_hex,
            next_challenge_hex,
            tlv_types: tlvs.iter().map(|t| t.param_type).collect(),
        });
    }

    let consumed_bytes = file
        .stream_position()?
        .checked_sub(section.payload_offset)
        .ok_or("Section 7 position underflow")?;
    if consumed_bytes != section.payload_len {
        return Err(format!(
            "Contribution records do not consume Section 7: consumed {} B, section {} B",
            consumed_bytes, section.payload_len
        )
        .into());
    }

    Ok(ContributionsAudit {
        section_len: section.payload_len,
        count,
        records,
        consumed_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_part_is_2112_bytes() {
        assert_eq!(FIXED_PART_BYTES, 2112);
    }

    #[test]
    fn name_tlv_parses_and_strict_order_is_enforced() {
        let mut buf = vec![TLV_NAME, 3];
        buf.extend_from_slice(b"abc");
        let tlvs = parse_tlvs(&buf).unwrap();
        assert_eq!(tlvs.len(), 1);
        assert_eq!(tlvs[0].value, b"abc");

        let bad = vec![TLV_NAME, 1, b'a', TLV_NAME, 1, b'b'];
        assert!(parse_tlvs(&bad).is_err());
    }

    #[test]
    fn truncated_tlv_is_rejected() {
        assert!(parse_tlvs(&[TLV_BEACON_HASH, 10, 0x01]).is_err());
    }
}
