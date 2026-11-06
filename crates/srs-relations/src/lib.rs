//! M2 (R1-R4 revision) experiment infrastructure.
//!
//! The formal M2-B experiment runs as THREE INDEPENDENT OS PROCESSES
//! (orchestrated by `scripts/run_m2b.sh`):
//!
//! ```text
//!   gen     (src/main.rs)        OS-entropy trapdoor -> public files + private oracle
//!      |  writes only public parameters (no seed, no trapdoor, no full array)
//!      v
//!   recover (src/bin/recover.rs) reads ONLY results/raw/m2b/public/
//!      |  never opens the oracle, never generates an SRS, never sees tau/alpha/beta
//!      v
//!   eval    (src/main.rs)        reads oracle + recovery output, scores, writes JSON
//! ```
//!
//! SECURITY MODEL (R1): the trapdoor seed is drawn from the OS entropy source
//! via `getrandom` inside the `gen` process only. It is never returned, printed,
//! serialized, or written to any file, and it dies when that process exits.
//! The public dataset is identified by its SHA-256, not by its seed. A fixed
//! seed survives ONLY inside `#[cfg(test)]` code for reproducible unit tests.
//!
//! Isolation is PROCESS-LEVEL and INPUT-LEVEL: the recover process has no
//! oracle file in its inputs. It is not a separate compiled crate; see
//! `docs/COMPRESSION_EXPERIMENTS.md` for the precise claim.

pub mod compression_tests;
pub mod pairing;
pub mod powers;
pub mod public_io;
pub mod sha256;
