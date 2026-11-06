#!/usr/bin/env bash
# M2-B formal experiment (R1-R4 revision): THREE INDEPENDENT OS PROCESSES.
#
#   gen     -> fresh OS-entropy SRS, writes public/ + oracle/
#   recover -> reads ONLY public/, outputs recovered/
#   eval    -> reads oracle/ + recovered/, scores, writes m2_results.json
#
# The trapdoor seed exists only inside the `gen` process and is never written
# to disk. Re-running this script produces a DIFFERENT public dataset; use the
# SHA-256 printed by `gen` / stored in manifest.json to identify a batch.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== [1/3] gen (OS entropy -> public parameters + scoring oracle) ==="
cargo run --release -q -p srs-relations --bin srs-relations -- gen

echo
echo "=== [2/3] recover (independent process, public files ONLY) ==="
cargo run --release -q -p srs-relations --bin recover

echo
echo "=== [3/3] eval (independent process, scores against oracle) ==="
cargo run --release -q -p srs-relations --bin srs-relations -- eval
