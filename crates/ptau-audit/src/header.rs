use crate::parser::Section;
use std::error::Error;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

/// BLS12-381 base-field modulus q, big-endian hex (48 bytes).
/// The file stores it little-endian, so the parsed bytes must be reversed first.
pub const BLS12_381_Q_BE_HEX: &str = "1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241e\
abfffeb153ffffb9feffffffffaaab";

pub const HEADER_PAYLOAD_LEN: u64 = 60;
pub const FIELD_ELEMENT_BYTES: u32 = 48;
pub const G1_UNCOMPRESSED_BYTES: u64 = 96;
pub const G2_UNCOMPRESSED_BYTES: u64 = 192;

#[derive(Debug, Clone)]
pub struct PtauHeader {
    pub curve: String,
    pub n8: u32,
    pub modulus_be_hex: String,
    pub power: u32,
    pub ceremony_power: u32,
    pub capacity: u64,
}

fn hex_to_be_bytes(hex: &str) -> Result<Vec<u8>, Box<dyn Error>> {
    if hex.len() % 2 != 0 {
        return Err("odd-length hex constant".into());
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    for i in (0..hex.len()).step_by(2) {
        out.push(u8::from_str_radix(&hex[i..i + 2], 16)?);
    }
    Ok(out)
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn read_u32(file: &mut File) -> Result<u32, Box<dyn Error>> {
    let mut buf = [0u8; 4];
    file.read_exact(&mut buf)?;
    Ok(u32::from_le_bytes(buf))
}

/// Parse Section 1 of a Powers-of-Tau container.
///
/// The curve is identified by the full 48-byte base-field modulus, not by `n8` alone.
pub fn parse_header(file: &mut File, section: &Section) -> Result<PtauHeader, Box<dyn Error>> {
    if section.id != 1 {
        return Err(format!("Section 1 expected, got section id {}", section.id).into());
    }
    if section.payload_len != HEADER_PAYLOAD_LEN {
        return Err(format!(
            "Section 1 payload length mismatch: expected {} B, got {} B",
            HEADER_PAYLOAD_LEN, section.payload_len
        )
        .into());
    }

    file.seek(SeekFrom::Start(section.payload_offset))?;

    let n8 = read_u32(file)?;
    if n8 != FIELD_ELEMENT_BYTES {
        return Err(format!(
            "Unsupported field element size: n8 = {}, expected {}",
            n8, FIELD_ELEMENT_BYTES
        )
        .into());
    }

    let mut modulus_le = vec![0u8; n8 as usize];
    file.read_exact(&mut modulus_le)?;
    let mut modulus_be = modulus_le;
    modulus_be.reverse();

    let expected_q = hex_to_be_bytes(BLS12_381_Q_BE_HEX)?;
    if modulus_be != expected_q {
        return Err(format!(
            "Unsupported curve: base-field modulus mismatch (got 0x{})",
            bytes_to_hex(&modulus_be)
        )
        .into());
    }

    let power = read_u32(file)?;
    let ceremony_power = read_u32(file)?;

    let capacity = 1u64
        .checked_shl(power)
        .ok_or("Power too large to represent as u64 capacity")?;
    capacity
        .checked_mul(576)
        .and_then(|v| v.checked_add(96))
        .ok_or("Power too large for safe byte accounting")?;

    let end = file.stream_position()?;
    let expected_end = section.payload_offset + section.payload_len;
    if end != expected_end {
        return Err(format!(
            "Section 1 header not fully consumed: position={}, expected={}",
            end, expected_end
        )
        .into());
    }

    Ok(PtauHeader {
        curve: "BLS12-381".to_string(),
        n8,
        modulus_be_hex: bytes_to_hex(&modulus_be),
        power,
        ceremony_power,
        capacity,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bls12_381_modulus_is_48_bytes() {
        let q = hex_to_be_bytes(BLS12_381_Q_BE_HEX).unwrap();
        assert_eq!(q.len(), 48);
        assert_eq!(bytes_to_hex(&q), BLS12_381_Q_BE_HEX);
    }

    #[test]
    fn header_layout_sums_to_60_bytes() {
        assert_eq!(4 + 48 + 4 + 4, HEADER_PAYLOAD_LEN as usize);
    }
}
