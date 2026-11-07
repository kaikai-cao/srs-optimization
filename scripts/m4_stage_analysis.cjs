/*
 * m4_stage_analysis.cjs <run.json>
 *
 * Prints a markdown stage-by-stage memory view for one M4 run:
 *   - deciles of the per-poll (t_ms, ws, peak_ws, pagefile) timeline
 *   - the largest single-step working-set jumps
 *   - snarkjs phase markers extracted from the timestamped stdout log
 *
 * The peak values in run.json (PeakWorkingSet64 / PeakPagedMemorySize64) are
 * kernel counters, so they are authoritative regardless of poll interval; the
 * timeline is used only for the *shape* of memory over the run.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function main() {
  const runPath = process.argv[2];
  if (!runPath) { console.error('usage: node m4_stage_analysis.cjs <run.json>'); process.exit(2); }
  const run = readJson(runPath);
  const repoRoot = path.resolve(__dirname, '..');
  const tlPath = path.isAbsolute(run.timeline_path) ? run.timeline_path : path.join(repoRoot, run.timeline_path);
  const logPath = path.isAbsolute(run.stdout_log) ? run.stdout_log : path.join(repoRoot, run.stdout_log);

  const tl = readJson(tlPath);
  const s = tl.series || [];
  const n = s.length;

  console.log(`# Stage analysis — ${run.operation} @ p${run.power} (${run.run_id})`);
  console.log('');
  console.log(`- Peak Working Set: ${run.peak_working_set_mib} MiB`);
  console.log(`- Peak Commit (PeakPagedMemorySize64): ${run.peak_pagefile_usage_mib} MiB`);
  console.log(`- Elapsed: ${Math.round(run.elapsed_ms)} ms, samples: ${n}, poll: ${tl.poll_ms} ms`);
  console.log('');

  console.log('## Memory deciles (per-poll timeline)');
  console.log('');
  console.log('| % of duration | t (ms) | current WS (MiB) | peak WS (MiB) | commit (MiB) |');
  console.log('| ---: | ---: | ---: | ---: | ---: |');
  for (let i = 1; i <= 10; i++) {
    const idx = Math.min(n - 1, Math.floor(i * n / 10) - 1);
    const r = s[idx];
    console.log(`| ${i * 10}% | ${r.t_ms} | ${r.ws_mib} | ${r.peak_ws_mib} | ${r.pagefile_mib} |`);
  }
  console.log('');

  console.log('## Largest single-step working-set jumps');
  console.log('');
  const jumps = [];
  for (let i = 1; i < n; i++) {
    const d = s[i].ws_mib - s[i - 1].ws_mib;
    if (d > 0) jumps.push({ t: s[i].t_ms, d: +d.toFixed(1), ws: s[i].ws_mib });
  }
  jumps.sort((a, b) => b.d - a.d);
  console.log('| t (ms) | jump (MiB) | WS after (MiB) |');
  console.log('| ---: | ---: | ---: |');
  jumps.slice(0, 6).forEach((j) => console.log(`| ${j.t} | +${j.d} | ${j.ws} |`));
  console.log('');

  console.log('## snarkjs phase markers (from timestamped stdout)');
  console.log('');
  console.log('| t (ms) | phase |');
  console.log('| ---: | --- |');
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch (e) { text = ''; }
  if (process.env.M4_DEBUG) {
    console.error('[debug] logPath=', logPath, 'exists=', fs.existsSync(logPath), 'len=', text.length);
    if (text) console.error('[debug] line0=', JSON.stringify(text.split(/\r?\n/)[0]));
  }
  const lines = text.split(/\r?\n/);
  let lastLagrange = null;
  // snarkjs logs carry ANSI colour codes (e.g. \u001b[36;22m[DEBUG] \u001b[39;1msnarkJS\u001b[0m: ...).
  const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
  for (const rawLine of lines) {
    const line = stripAnsi(rawLine);
    const m = line.match(/\[t=(\d+)ms\]\s*(?:\[[A-Z]+\]\s*)?(?:snarkJS:\s*)?(.*)$/);
    if (!m) continue;
    const t = m[1], msg = m[2].trim();
    if (/^power:/.test(msg)) {
      console.log(`| ${t} | ${msg} |`);
    } else if (/^Verifying powers in .* section/.test(msg)) {
      console.log(`| ${t} | ${msg} |`);
    } else if (/^Verifying phase2 calculated values/.test(msg)) {
      console.log(`| ${t} | ${msg} |`);
    } else if (/^reading points Lagrange/.test(msg)) {
      lastLagrange = { t, msg };
    } else if (/^done/.test(msg) || /^Contribution/.test(msg)) {
      if (lastLagrange) { console.log(`| ${lastLagrange.t}–${t} | reading points ${lastLagrange.msg.replace('reading points ','')} … |`); lastLagrange = null; }
      console.log(`| ${t} | ${msg} |`);
    }
  }
  if (lastLagrange) console.log(`| ${lastLagrange.t} | ${lastLagrange.msg} |`);
  console.log('');
}

main();
