/*
 * build_m4_summary.cjs <manifest.json> [--out <m4_summary.csv>]
 *
 * Reads the M4 repeat manifest produced by measure_m4.ps1. For each run it reads
 * the per-run measure_snarkjs JSON (peak working set, peak pagefile, elapsed,
 * exit code, input hash) and the per-run FastFile pool JSON (m4_instrument.js
 * output). It aggregates the repeats (mean / median / min / max / stdev / CV over
 * PASS runs) and emits:
 *   - <out>.csv   (one row per measured quantity, stats columns)
 *   - <out>.md    (markdown tables: stats + per-run detail + FastFile per-file)
 */
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = { manifest: null, out: 'results/processed/m4_summary.csv' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = argv[++i];
    else if (!a.manifest) a.manifest = argv[i];
  }
  return a;
}

function mean(xs) { return xs.reduce((s, x) => s + x, 0) / xs.length; }
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}
function round(x, d = 3) { return Math.round(x * 10 ** d) / 10 ** d; }

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) { console.error('usage: node build_m4_summary.cjs <manifest.json> [--out csv]'); process.exit(2); }

  const manifest = readJsonSafe(args.manifest);
  if (!manifest || !Array.isArray(manifest.runs)) { console.error('invalid manifest:', args.manifest); process.exit(2); }

  const runs = manifest.runs.map((r) => {
    const run = readJsonSafe(r.run_json) || {};
    const ff = readJsonSafe(r.fastfile_json) || {};
    return {
      label: r.label,
      repeat: r.repeat,
      exitCode: run.exit_code,
      pass: run.exit_code === 0,
      peakWs: run.peak_working_set_mib,
      peakPf: run.peak_pagefile_usage_mib,
      elapsed: run.elapsed_ms,
      inputHash: run.input_sha256,
      ffGlobal: ff.global || null,
      ffFiles: (ff.files || []).map((f) => ({
        fileName: f.fileName,
        pageSize: f.pageSize,
        peakMaxPagesLoaded: f.peakMaxPagesLoaded,
        capacityMiB: f.capacityMiB,
        peakPagesCount: f.peakPagesCount,
        peakAvBuffsCount: f.peakAvBuffsCount,
        heldMiB: f.heldMiB,
      })),
    };
  });

  const pass = runs.filter((r) => r.pass);
  const nPass = pass.length;
  const nRuns = runs.length;

  function statsOf(key) {
    const vals = pass.map((r) => r[key]).filter((v) => typeof v === 'number');
    if (vals.length === 0) return { n: 0, mean: 0, median: 0, min: 0, max: 0, stdev: 0, cv: 0 };
    const m = mean(vals), s = stdev(vals);
    return {
      n: vals.length,
      mean: round(m), median: round(median(vals)),
      min: round(Math.min(...vals)), max: round(Math.max(...vals)),
      stdev: round(s), cv: round(m ? (s / m) * 100 : 0, 2),
    };
  }

  const sWs = statsOf('peakWs');
  const sPf = statsOf('peakPf');
  const sEl = statsOf('elapsed');
  // FastFile global peaks: take the *max* observed across PASS runs (upper bound of cache footprint).
  const ffCap = pass.map((r) => (r.ffGlobal ? r.ffGlobal.peakCapacityMiB : 0)).filter((v) => v > 0);
  const ffHeld = pass.map((r) => (r.ffGlobal ? r.ffGlobal.peakHeldMiB : 0)).filter((v) => v > 0);
  const ffCapStats = ffCap.length ? { max: round(Math.max(...ffCap)), mean: round(mean(ffCap)) } : { max: 0, mean: 0 };
  const ffHeldStats = ffHeld.length ? { max: round(Math.max(...ffHeld)), mean: round(mean(ffHeld)) } : { max: 0, mean: 0 };

  // CSV
  const rows = [
    ['quantity', 'power', 'operation', 'n_runs', 'n_pass', 'mean', 'median', 'min', 'max', 'stdev', 'cv_pct'],
    ['peak_working_set_mib', manifest.power, manifest.operation, nRuns, nPass, sWs.mean, sWs.median, sWs.min, sWs.max, sWs.stdev, sWs.cv],
    ['peak_pagefile_usage_mib', manifest.power, manifest.operation, nRuns, nPass, sPf.mean, sPf.median, sPf.min, sPf.max, sPf.stdev, sPf.cv],
    ['elapsed_ms', manifest.power, manifest.operation, nRuns, nPass, sEl.mean, sEl.median, sEl.min, sEl.max, sEl.stdev, sEl.cv],
    ['ff_peak_capacity_mib', manifest.power, manifest.operation, nRuns, nPass, ffCapStats.mean, ffCapStats.max, ffCapStats.max, ffCapStats.max, 0, 0],
    ['ff_peak_held_mib', manifest.power, manifest.operation, nRuns, nPass, ffHeldStats.mean, ffHeldStats.max, ffHeldStats.max, ffHeldStats.max, 0, 0],
  ];
  const csv = rows.map((r) => r.join(',')).join('\n') + '\n';
  fs.writeFileSync(args.out, csv);

  // Markdown
  const md = [];
  md.push(`# M4 Repeat Baseline — ${manifest.operation} @ Power ${manifest.power}`);
  md.push('');
  md.push(`- Repeats: ${nRuns} (PASS: ${nPass})`);
  md.push(`- Instrument: ${manifest.instrument}`);
  md.push('');
  md.push('## Aggregate statistics (over PASS runs)');
  md.push('');
  md.push('| Quantity | n | mean | median | min | max | stdev | CV % |');
  md.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  md.push(`| Peak Working Set (MiB) | ${sWs.n} | ${sWs.mean} | ${sWs.median} | ${sWs.min} | ${sWs.max} | ${sWs.stdev} | ${sWs.cv} |`);
  md.push(`| Peak Pagefile Usage (MiB) | ${sPf.n} | ${sPf.mean} | ${sPf.median} | ${sPf.min} | ${sPf.max} | ${sPf.stdev} | ${sPf.cv} |`);
  md.push(`| Elapsed (ms) | ${sEl.n} | ${sEl.mean} | ${sEl.median} | ${sEl.min} | ${sEl.max} | ${sEl.stdev} | ${sEl.cv} |`);
  md.push(`| FastFile peak cache capacity (MiB) | ${nPass} | ${ffCapStats.mean} | ${ffCapStats.max} | ${ffCapStats.max} | ${ffCapStats.max} | 0 | 0 |`);
  md.push(`| FastFile peak held buffers (MiB) | ${nPass} | ${ffHeldStats.mean} | ${ffHeldStats.max} | ${ffHeldStats.max} | ${ffHeldStats.max} | 0 | 0 |`);
  md.push('');
  md.push('## Per-run detail');
  md.push('');
  md.push('| run | label | exit | peak WS (MiB) | peak Pagefile (MiB) | elapsed (ms) | FF cap (MiB) | FF held (MiB) |');
  md.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  runs.forEach((r) => {
    const cap = r.ffGlobal ? r.ffGlobal.peakCapacityMiB : '-';
    const held = r.ffGlobal ? r.ffGlobal.peakHeldMiB : '-';
    md.push(`| ${r.repeat} | ${r.label} | ${r.exitCode} | ${r.peakWs ?? '-'} | ${r.peakPf ?? '-'} | ${r.elapsed ?? '-'} | ${cap} | ${held} |`);
  });
  md.push('');
  md.push('## FastFile per-file page pool (max across PASS runs)');
  md.push('');
  md.push('| file | pageSize | peakMaxPagesLoaded | capacity (MiB) | peakPages | peakAvBuffs | held (MiB) |');
  md.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  // union of files across pass runs, taking max per fileName
  const fileMap = new Map();
  pass.forEach((r) => r.ffFiles.forEach((f) => {
    const cur = fileMap.get(f.fileName) || { capacityMiB: 0, peakPagesCount: 0, peakAvBuffsCount: 0, peakMaxPagesLoaded: 0, pageSize: f.pageSize, heldMiB: 0 };
    cur.capacityMiB = Math.max(cur.capacityMiB, f.capacityMiB);
    cur.heldMiB = Math.max(cur.heldMiB, f.heldMiB);
    cur.peakPagesCount = Math.max(cur.peakPagesCount, f.peakPagesCount);
    cur.peakAvBuffsCount = Math.max(cur.peakAvBuffsCount, f.peakAvBuffsCount);
    cur.peakMaxPagesLoaded = Math.max(cur.peakMaxPagesLoaded, f.peakMaxPagesLoaded);
    cur.pageSize = f.pageSize;
    fileMap.set(f.fileName, cur);
  }));
  if (fileMap.size === 0) {
    md.push('| (no FastFile pool data captured) | | | | | | |');
  } else {
    for (const [name, f] of fileMap) {
      md.push(`| ${name} | ${f.pageSize} | ${f.peakMaxPagesLoaded} | ${f.capacityMiB} | ${f.peakPagesCount} | ${f.peakAvBuffsCount} | ${f.heldMiB} |`);
    }
  }
  md.push('');
  md.push('> `capacityMiB = peakMaxPagesLoaded * pageSize` is the page-buffer cache UPPER BOUND that fastfile');
  md.push('> keeps allocated (never returned to OS) while the file descriptor is open. `heldMiB` is the');
  md.push('> sum of actually-allocated page buffers (`peakPagesCount + peakAvBuffsCount`) * pageSize.');
  md.push('');

  const mdPath = args.out.replace(/\.csv$/i, '.md');
  fs.writeFileSync(mdPath, md.join('\n'));

  console.log(`Wrote ${args.out} (${rows.length - 1} stat rows) and ${mdPath}`);
  console.log(`PASS ${nPass}/${nRuns}  peak WS mean=${sWs.mean} MiB (CV ${sWs.cv}%)  FF cache cap max=${ffCapStats.max} MiB`);
}

main();
