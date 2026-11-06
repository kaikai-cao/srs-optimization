use std::error::Error;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const MAGIC: &[u8; 4] = b"ptau";
const MAX_SECTIONS: u32 = 64;

#[derive(Debug)]
pub struct Section {
    pub index: u32,
    pub id: u32,
    pub header_offset: u64,
    pub payload_offset: u64,
    pub payload_len: u64,
}

#[derive(Debug)]
pub struct PtauContainer {
    pub version: u32,
    pub declared_sections: u32,
    pub file_size: u64,
    pub sections: Vec<Section>,
}

fn read_u32(file: &mut File) -> Result<u32, Box<dyn Error>> {
    let mut buf = [0u8; 4];
    file.read_exact(&mut buf)?;
    Ok(u32::from_le_bytes(buf))
}

fn read_u64(file: &mut File) -> Result<u64, Box<dyn Error>> {
    let mut buf = [0u8; 8];
    file.read_exact(&mut buf)?;
    Ok(u64::from_le_bytes(buf))
}

pub fn parse_container(path: &Path) -> Result<PtauContainer, Box<dyn Error>> {
    let mut file = File::open(path)?;
    let file_size = file.metadata()?.len();

    // Generic binary-file header: magic + version + section count.
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic)?;

    if &magic != MAGIC {
        return Err(format!("Invalid magic: expected ptau, got {:?}", magic).into());
    }

    let version = read_u32(&mut file)?;

    if version != 1 {
        return Err(format!("Unsupported ptau container version: {}", version).into());
    }

    let declared_sections = read_u32(&mut file)?;

    if declared_sections == 0 || declared_sections > MAX_SECTIONS {
        return Err(format!("Invalid section count: {}", declared_sections).into());
    }

    let mut sections = Vec::new();

    for index in 0..declared_sections {
        let header_offset = file.stream_position()?;

        let id = read_u32(&mut file)?;
        let payload_len = read_u64(&mut file)?;
        let payload_offset = file.stream_position()?;

        let payload_end = payload_offset
            .checked_add(payload_len)
            .ok_or("Section offset overflow")?;

        if payload_end > file_size {
            return Err(format!(
                "Section {} exceeds file boundary: end={}, file_size={}",
                id, payload_end, file_size
            )
            .into());
        }

        sections.push(Section {
            index: index + 1,
            id,
            header_offset,
            payload_offset,
            payload_len,
        });

        file.seek(SeekFrom::Start(payload_end))?;
    }

    // The declared sections must consume the entire file.
    let final_position = file.stream_position()?;

    if final_position != file_size {
        return Err(format!(
            "Trailing or unparsed bytes: position={}, file_size={}",
            final_position, file_size
        )
        .into());
    }

    Ok(PtauContainer {
        version,
        declared_sections,
        file_size,
        sections,
    })
}
