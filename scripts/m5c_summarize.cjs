#!/usr/bin/env node
/**
 * M5-C perturbation summary: fold the per-run measurer JSONs of the three modes
 * into one table, so the numbers quoted in docs/M5_PROBE_DESIGN.md §5.9 and in
 * docs/EXPERIMENT_LOG.md can be regenerated from disk at any time.
 *
 * Usage:
 *   node scripts/m5c_summarize.cjs --power 10 --repeat 5 \
 *        --dir results/raw/m5c --out results/processed/m5c_perturbation_p10
 *
 * Reads  <dir>/m5_<mode>_prepared_verify_p<p>_r<n>.json   (measurer output)
 * Writes <out>.csv and <out>.md
 *
 * The point of the exercise is the third column group: a mode is only usable as
 * a control if its spread is smaller than the difference it is supposed to
 * explain. This script prints spread explicitly instead of hiding it in a mean.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const power = Number(arg('power', 10));
const repeats = Number(arg('repeat', 5));
const dir = arg('dir', 'results/raw/m5c');
const out = arg('out', `results/processed/m5c_perturbation_p${power}`);
const modes = ['pristine', 'vendor', 'trace'];

const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);

function stat(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { min: s[0], median: mid, max: s[s.length - 1], mean, spread: s[s.length - 1] - s[0] };
}

const rows = [];
const missing = [];
for (const mode of modes) {
  for (let r = 1; r <= repeats; r++) {
    const p = path.join(dir, `m5_${mode}_prepared_verify_p${power}_r${r}.json`);
    if (!fs.existsSync(p)) {
      missing.push(p);
      continue;
    }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    rows.push({
      mode,
      repeat: r,
      exit_code: j.exit_code,
      elapsed_ms: j.elapsed_ms,
      peak_ws_mib: j.peak_working_set_mib,
      peak_commit_mib: j.peak_commit_mib,
      input_sha256: j.input_sha256,
    });
  }
}

if (missing.length) {
  console.error(`missing ${missing.length} run file(s); first: ${missing[0]}`);
  process.exit(2);
}

// One input hash for the whole comparison -- otherwise the modes are not comparable.
const hashes = [...new Set(rows.map((r) => r.input_sha256))];
if (hashes.length !== 1) {
  console.error(`input_sha256 differs across runs: ${hashes.join(', ')}`);
  process.exit(3);
}

const csv = [
  'mode,repeat,exit_code,elapsed_ms,peak_ws_mib,peak_commit_mib,input_sha256',
  ...rows.map((r) => [r.mode, r.repeat, r.exit_code, f2(r.elapsed_ms), f2(r.peak_ws_mib), f2(r.peak_commit_mib), r.input_sha256].join(',')),
].join('\n') + '\n';

const md = [];
md.push(`# M5-C perturbation budget (prepared_verify @ 2^${power})`);
md.push('');
md.push(`Input fixture sha256: \`${hashes[0]}\` (identical for all ${rows.length} runs).`);
md.push('');
md.push('| mode | peak WS (MiB) | WS median | WS spread | elapsed median (ms) | elapsed spread | commit median |');
md.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const mode of modes) {
  const sub = rows.filter((r) => r.mode === mode);
  const ws = stat(sub.map((r) => r.peak_ws_mib));
  const el = stat(sub.map((r) => r.elapsed_ms));
  const cm = stat(sub.map((r) => r.peak_commit_mib));
  md.push(
    `| ${mode} | ${sub.map((r) => f1(r.peak_ws_mib)).join(' / ')} | ${f1(ws.median)} | ${f1(ws.spread)} | ` +
      `${f2(el.median)} | ${f1(el.spread)} | ${f1(cm.median)} |`
  );
}
md.push('');
md.push('## How to read this');
md.push('');
md.push('1. **Peak WS is not a control variable here.** The within-mode spread is the same size as the');
md.push('   between-mode difference, so it cannot be used to claim that the probe perturbs the workload,');
md.push('   nor that it does not. Attribution must rest on per-worker `allocs / grow_events / wasm_after`.');
md.push('2. **Wall time is usable.** Compare medians and require an ordering that holds for every repeat,');
md.push('   not just for the mean: the JSONL writer has a fixed cost and it must be declared before any');
md.push('   trace-vs-pristine timing claim.');
md.push('3. n is small. These are 5 repeats per mode, quoted as min/median/max, never as mean ± sigma.');
md.push('');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(`${out}.csv`, csv, 'utf8');
fs.writeFileSync(`${out}.md`, md.join('\n'), 'utf8');
console.log(csv.trimEnd());
console.log('');
console.log(md.join('\n').split('\n').filter((l) => l.startsWith('|')).join('\n'));
console.log(`\nwrote ${out}.csv and ${out}.md (${rows.length} runs)`);
