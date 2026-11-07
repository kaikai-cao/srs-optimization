/*
 * m4_stage_analysis.cjs <run.json>
 *
 * Prints a markdown stage-by-stage memory view for one M4 run:
 *   - deciles of the per-poll timeline (current WS, current commit, both peaks)
 *   - the largest single-step working-set jumps
 *   - snarkjs phase markers extracted from the timestamped stdout log
 *
 * The peak values in run.json (PeakWorkingSet64 / PeakPagedMemorySize64) are
 * kernel counters, so they are authoritative regardless of poll interval; the
 * timeline is used only for the *shape* of memory over the run. Since M4.1 the
 * timeline carries a real instantaneous commit series (`current_commit_mib`)
 * next to the historical high-water mark (`peak_commit_so_far_mib`). Pre-M4.1
 * timelines only had `pagefile_mib`, which was actually the peak-so-far value.
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
  const legacy = n === 0 || s[0].current_commit_mib === undefined;

  // First sample at or after `tms` (the marker logs just before the work starts).
  function at(tms) {
    if (!n) return null;
    let lo = 0, hi = n - 1, idx = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t_ms >= tms) { idx = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    return s[idx];
  }
  function markerRow(t, msg, tLabel) {
    const r = at(Number(t));
    const curWs = r ? r.ws_mib : '-';
    const curCommit = r ? (r.current_commit_mib ?? r.pagefile_mib) : '-';
    console.log(`| ${tLabel || t} | ${msg} | ${curWs} | ${curCommit} |`);
  }

  console.log(`# Stage analysis — ${run.operation} @ p${run.power} (${run.run_id})`);
  console.log('');
  console.log(`- Peak Working Set: ${run.peak_working_set_mib} MiB`);
  console.log(`- Peak Commit (PeakPagedMemorySize64): ${run.peak_commit_mib ?? run.peak_pagefile_usage_mib} MiB`);
  console.log(`- Elapsed: ${Math.round(run.elapsed_ms)} ms, samples: ${n}, poll: ${tl.poll_ms} ms ${legacy ? '(LEGACY timeline: pagefile_mib is peak-so-far, no current commit)' : ''}`);
  console.log('');

  console.log('## Memory deciles (per-poll timeline)');
  console.log('');
  console.log('| % of duration | t (ms) | current WS (MiB) | current commit (MiB) | peak WS (MiB) | peak commit so far (MiB) |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: |');
  for (let i = 1; i <= 10; i++) {
    const idx = Math.min(n - 1, Math.floor(i * n / 10) - 1);
    const r = s[idx];
    const curCommit = r.current_commit_mib ?? r.pagefile_mib;
    const peakCommit = r.peak_commit_so_far_mib ?? r.pagefile_mib;
    console.log(`| ${i * 10}% | ${r.t_ms} | ${r.ws_mib} | ${curCommit} | ${r.peak_ws_mib} | ${peakCommit} |`);
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
  console.log('| t (ms) | phase | current WS (MiB) | current commit (MiB) |');
  console.log('| ---: | --- | ---: | ---: |');
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
      markerRow(t, msg);
    } else if (/^Verifying powers in .* section/.test(msg)) {
      markerRow(t, msg);
    } else if (/^Verifying phase2 calculated values/.test(msg)) {
      markerRow(t, msg);
    } else if (/^reading points Lagrange/.test(msg)) {
      lastLagrange = { t, msg };
    } else if (/^done/.test(msg) || /^Contribution/.test(msg)) {
      if (lastLagrange) { markerRow(t, `reading points ${lastLagrange.msg.replace('reading points ', '')} …`, `${lastLagrange.t}–${t}`); lastLagrange = null; }
      markerRow(t, msg);
    }
  }
  if (lastLagrange) markerRow(lastLagrange.t, lastLagrange.msg);
  console.log('');
}

main();
