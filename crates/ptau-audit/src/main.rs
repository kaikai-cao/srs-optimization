mod parser;

use std::env;
use std::error::Error;
use std::path::Path;

fn main() -> Result<(), Box<dyn Error>> {
    let input = env::args().nth(1).ok_or("Usage: ptau-audit <input.ptau>")?;

    let path = Path::new(&input);

    let container = parser::parse_container(path)?;

    println!("========== PTAU CONTAINER AUDIT ==========");
    println!("File: {}", path.display());
    println!("File size: {} bytes", container.file_size);
    println!("Magic: ptau");
    println!("Container version: {}", container.version);
    println!("Declared sections: {}", container.declared_sections);

    println!("\n------------- SECTION TABLE --------------");

    println!(
        "{:<8} {:<8} {:<18} {:<18} {:<18}",
        "Index", "ID", "Header Offset", "Payload Offset", "Payload Length"
    );

    for section in &container.sections {
        println!(
            "{:<8} {:<8} {:<18} {:<18} {:<18}",
            section.index,
            section.id,
            section.header_offset,
            section.payload_offset,
            section.payload_len
        );
    }

    println!("\nAudit result: CONTAINER SCAN PASS");

    Ok(())
}
