#!/usr/bin/env node
/*
 * M3-E: turn results/raw/m3_*.json + timestamped logs into
 *   results/processed/m3_summary.csv        (one row per measurement)
 *   results/processed/m3_phase_timings.csv  (long-format phase durations)
 *   results/processed/m3_tables.md          (Markdown tables for the report)
 *   results/processed/m3_peak_vs_power.svg  (peak WS + elapsed comparison chart)
 *
 * No third-party dependencies. All values come from measured files.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const rawDir = path.join(repoRoot, 'results', 'raw');
const outDir = path.join(repoRoot, 'results', 'processed');
fs.mkdirSync(outDir, { recursive: true });

const OPS = ['phase1_verify', 'prepare_phase2', 'prepared_verify'];
const OP_LABEL = {
  phase1_verify: 'Phase 1 Verify',
  prepare_phase2: 'Phase 2 Prepare',
  prepared_verify: 'Prepared Verify',
};
const COLORS = {
  phase1_verify: '#2563eb',
  prepare_phase2: '#ea580c',
  prepared_verify: '#16a34a',
};

function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows, columns) {
  return columns.join(',') + '\n' + rows.map(r => columns.map(c => csvCell(r[c])).join(',')).join('\n') + '\n';
}

const allRecords = fs.readdirSync(rawDir)
  .filter(f => /^m3_.*\.json$/.test(f) && !/environment|fixture_hashes|worker_baseline/.test(f))
  .map(f => json(path.join(rawDir, f)))
  .filter(r => r && r.run_id && OPS.includes(r.operation))
  .sort((a, b) => a.power - b.power || OPS.indexOf(a.operation) - OPS.indexOf(b.operation));

// Repeatability runs are kept out of the main curve, but reported separately.
const records = allRecords.filter(r => !/repeat/.test(r.run_id));
const repeatRecords = allRecords.filter(r => /repeat/.test(r.run_id));

function parseLog(rel) {
  const p = path.join(repoRoot, rel);
  if (!fs.existsSync(p)) return [];
  const events = [];
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\[t=(\d+)ms\]\s?(.*)$/.exec(line);
    if (m) events.push({ t: Number(m[1]), text: m[2] });
  }
  return events;
}

const first = (ev, pred) => ev.find(pred) || null;
const last = (ev, pred) => { for (let i = ev.length - 1; i >= 0; i--) if (pred(ev[i])) return ev[i]; return null; };
const count = (ev, re) => ev.filter(e => re.test(e.text)).length;
const delta = (a, b) => (a && b && b.t >= a.t) ? b.t - a.t : null;

function phaseTimings(r, ev) {
  const out = {
    phase1_contribution_ms: null,
    phase1_sections_ms: null,
    phase2_lagrange_ms: null,
    section_tauG1_ms: null,
    section_tauG2_ms: null,
    section_alphaTauG1_ms: null,
    section_betaTauG1_ms: null,
    fft_mix_lines: count(ev, /fft \d+ mix start/),
    fft_join_lines: count(ev, /fft \s*\d+\s+join/),
    multiexp_lines: count(ev, /Multiexp start/),
    points_relations_lines: count(ev, /points relations:/),
    log_lines: ev.length,
    first_log_ms: ev.length ? ev[0].t : null,
    last_log_ms: ev.length ? ev[ev.length - 1].t : null,
  };

  const contribStart = first(ev, e => e.text.includes('Computing initial contribution hash'));
  const contribEnd = first(ev, e => e.text.includes('Powers Of tau file OK!'));
  out.phase1_contribution_ms = delta(contribStart, contribEnd);

  const secStart = first(ev, e => e.text.includes('Verifying powers in tau*G1 section'));
  // The last "points relations:" line is emitted at the START of the final chunk,
  // so use the "Next challenge hash" print as the true end of section work.
  const secEnd = first(ev, e => e.text.includes('Next challenge hash'))
    || last(ev, e => /points relations:/.test(e.text));
  out.phase1_sections_ms = delta(secStart, secEnd);

  const lagrangeStart = first(ev, e => e.text.includes('Verifying phase2 calculated values'));
  const finalOk = last(ev, e => e.text.includes('Powers of Tau Ok!'));
  out.phase2_lagrange_ms = delta(lagrangeStart, finalOk);

  if (r.operation === 'prepare_phase2') {
    const marks = ['tauG1', 'tauG2', 'alphaTauG1', 'betaTauG1'].map(name => ({
      name,
      ev: first(ev, e => e.text.includes(`Starting section: ${name}`)),
    }));
    // Section end = next section start; last section end = last log line.
    const lastEv = ev.length ? ev[ev.length - 1] : null;
    const keys = {
      tauG1: 'section_tauG1_ms', tauG2: 'section_tauG2_ms',
      alphaTauG1: 'section_alphaTauG1_ms', betaTauG1: 'section_betaTauG1_ms',
    };
    marks.forEach((m, i) => {
      if (!m.ev) return;
      const next = i + 1 < marks.length ? marks[i + 1].ev : lastEv;
      out[keys[m.name]] = delta(m.ev, next);
    });
  }
  return out;
}

const rows = records.map(r => {
  const ev = parseLog(r.stdout_log);
  const t = phaseTimings(r, ev);
  return {
    run_id: r.run_id,
    operation: r.operation,
    operation_label: OP_LABEL[r.operation],
    power: r.power,
    input_file: r.input_path,
    input_sha256: r.input_sha256,
    input_bytes: r.input_bytes,
    output_file: r.output_path,
    output_bytes: r.output_bytes,
    output_sha256: r.output_sha256,
    elapsed_ms: r.elapsed_ms,
    elapsed_s: +(r.elapsed_ms / 1000).toFixed(3),
    peak_working_set_bytes: r.peak_working_set_bytes,
    peak_working_set_mib: r.peak_working_set_mib,
    peak_pagefile_usage_bytes: r.peak_pagefile_usage_bytes,
    peak_pagefile_usage_mib: r.peak_pagefile_usage_mib,
    exit_code: r.exit_code,
    timed_out: r.timed_out,
    ...t,
  };
});

const columns = [
  'run_id', 'operation', 'power', 'input_file', 'input_sha256', 'input_bytes',
  'output_file', 'output_bytes', 'output_sha256',
  'elapsed_ms', 'elapsed_s', 'peak_working_set_bytes', 'peak_working_set_mib',
  'peak_pagefile_usage_bytes', 'peak_pagefile_usage_mib',
  'exit_code', 'timed_out',
  'phase1_contribution_ms', 'phase1_sections_ms', 'phase2_lagrange_ms',
  'section_tauG1_ms', 'section_tauG2_ms', 'section_alphaTauG1_ms', 'section_betaTauG1_ms',
  'fft_mix_lines', 'fft_join_lines', 'multiexp_lines', 'points_relations_lines',
  'log_lines', 'first_log_ms', 'last_log_ms',
];
fs.writeFileSync(path.join(outDir, 'm3_summary.csv'), toCsv(rows, columns));

// Long-format phase timings
const phaseRows = [];
for (const r of rows) {
  for (const k of ['phase1_contribution_ms', 'phase1_sections_ms', 'phase2_lagrange_ms',
    'section_tauG1_ms', 'section_tauG2_ms', 'section_alphaTauG1_ms', 'section_betaTauG1_ms']) {
    if (r[k] !== null && r[k] !== undefined) {
      phaseRows.push({ run_id: r.run_id, operation: r.operation, power: r.power, phase: k, duration_ms: r[k] });
    }
  }
}
fs.writeFileSync(path.join(outDir, 'm3_phase_timings.csv'),
  toCsv(phaseRows, ['run_id', 'operation', 'power', 'phase', 'duration_ms']));

// Markdown tables for the report
const fmt = (v, d = 2) => (v === null || v === undefined || v === '') ? '—' :
  (typeof v === 'number' ? v.toFixed(d) : String(v));
const md = [];
md.push('# M3 measured tables (generated by scripts/build_m3_summary.cjs)\n');
md.push('| operation | power | input bytes | output bytes | elapsed (s) | Peak WS (MiB) | exit | phase1 contribution (ms) | phase1 sections (ms) | phase2 Lagrange (ms) |');
md.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const r of rows) {
  md.push(`| ${OP_LABEL[r.operation]} | ${r.power} | ${r.input_bytes.toLocaleString('en-US')} | ${(r.output_bytes || 0).toLocaleString('en-US')} | ${fmt(r.elapsed_s)} | ${fmt(r.peak_working_set_mib)} | ${r.exit_code} | ${fmt(r.phase1_contribution_ms, 0)} | ${fmt(r.phase1_sections_ms, 0)} | ${fmt(r.phase2_lagrange_ms, 0)} |`);
}
md.push('\n## Prepare phase2 per-section durations (ms)\n');
md.push('| power | tauG1 | tauG2 | alphaTauG1 | betaTauG1 | fft mix log lines | fft join log lines | multiexp log lines |');
md.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const r of rows.filter(x => x.operation === 'prepare_phase2')) {
  md.push(`| ${r.power} | ${fmt(r.section_tauG1_ms, 0)} | ${fmt(r.section_tauG2_ms, 0)} | ${fmt(r.section_alphaTauG1_ms, 0)} | ${fmt(r.section_betaTauG1_ms, 0)} | ${r.fft_mix_lines} | ${r.fft_join_lines} | ${r.multiexp_lines} |`);
}
md.push('\n## Input SHA-256\n');
md.push('| operation | power | input file | SHA-256 |');
md.push('| --- | ---: | --- | --- |');
for (const r of rows) md.push(`| ${OP_LABEL[r.operation]} | ${r.power} | ${r.input_file} | \`${r.input_sha256}\` |`);

// Repeatability section (separate CSV + Markdown)
const repeatRows = repeatRecords.map(r => ({
  run_id: r.run_id, operation: r.operation, power: r.power,
  elapsed_s: +(r.elapsed_ms / 1000).toFixed(3),
  peak_working_set_mib: r.peak_working_set_mib,
  exit_code: r.exit_code,
}));
if (repeatRows.length) {
  fs.writeFileSync(path.join(outDir, 'm3_repeatability.csv'),
    toCsv(repeatRows, ['run_id', 'operation', 'power', 'elapsed_s', 'peak_working_set_mib', 'exit_code']));
  const groups = {};
  for (const r of repeatRows) {
    const k = `${r.operation}@p${r.power}`;
    (groups[k] = groups[k] || []).push(r);
  }
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  md.push('\n## Repeatability (single-run peak WS has GC-dependent variance)\n');
  md.push('| operation / power | runs | peak min / median / max (MiB) | elapsed min / median / max (s) |');
  md.push('| --- | ---: | --- | --- |');
  for (const [k, g] of Object.entries(groups)) {
    const p = g.map(x => x.peak_working_set_mib), e = g.map(x => x.elapsed_s);
    md.push(`| ${k} | ${g.length} | ${Math.min(...p).toFixed(1)} / ${med(p).toFixed(1)} / ${Math.max(...p).toFixed(1)} | ${Math.min(...e).toFixed(2)} / ${med(e).toFixed(2)} / ${Math.max(...e).toFixed(2)} |`);
  }
}
fs.writeFileSync(path.join(outDir, 'm3_tables.md'), md.join('\n') + '\n');

// ---------------------------- SVG chart -----------------------------------
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const powers = [...new Set(rows.map(r => r.power))].sort((a, b) => a - b);
const W = 1040, H = 720;
const panels = [
  { key: 'peak_working_set_mib', title: 'Peak Working Set (MiB)', y0: 90, y1: 350 },
  { key: 'elapsed_s', title: 'Elapsed wall time (s)', y0: 430, y1: 680 },
];
const x0 = 90, x1 = 980;
const xOf = p => x0 + (powers.length === 1 ? 0.5 : (p - powers[0]) / (powers[powers.length - 1] - powers[0])) * (x1 - x0);

function panelSvg(panel) {
  const vals = rows.map(r => r[panel.key]).filter(v => typeof v === 'number' && isFinite(v) && v >= 0);
  const max = Math.max(1, ...vals) * 1.12;
  const yOf = v => panel.y1 - (v / max) * (panel.y1 - panel.y0);
  const s = [];
  s.push(`<text x="${x0}" y="${panel.y0 - 14}" font-size="15" font-weight="600" fill="#1f2937">${esc(panel.title)}</text>`);
  // grid + y labels
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const y = yOf(v);
    s.push(`<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>`);
    s.push(`<text x="${x0 - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#6b7280">${v >= 100 ? v.toFixed(0) : v.toFixed(1)}</text>`);
  }
  s.push(`<line x1="${x0}" y1="${panel.y0}" x2="${x0}" y2="${panel.y1}" stroke="#9ca3af" stroke-width="1"/>`);
  s.push(`<line x1="${x0}" y1="${panel.y1}" x2="${x1}" y2="${panel.y1}" stroke="#9ca3af" stroke-width="1"/>`);
  for (const p of powers) {
    s.push(`<text x="${xOf(p).toFixed(1)}" y="${panel.y1 + 20}" text-anchor="middle" font-size="11" fill="#374151">2^${p}</text>`);
  }
  // series
  for (const op of OPS) {
    const pts = rows.filter(r => r.operation === op && typeof r[panel.key] === 'number' && isFinite(r[panel.key]))
      .sort((a, b) => a.power - b.power)
      .map(r => ({ x: xOf(r.power), y: yOf(r[panel.key]), v: r[panel.key], r }));
    if (!pts.length) continue;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    s.push(`<path d="${d}" fill="none" stroke="${COLORS[op]}" stroke-width="2.5" stroke-linejoin="round"/>`);
    for (const p of pts) {
      s.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="${COLORS[op]}" stroke="#ffffff" stroke-width="1.5"><title>${esc(p.r.run_id)}: ${p.v.toFixed(2)}</title></circle>`);
      const label = panel.key === 'peak_working_set_mib' ? p.v.toFixed(0) : p.v.toFixed(1);
      s.push(`<text x="${p.x.toFixed(1)}" y="${(p.y - 10).toFixed(1)}" text-anchor="middle" font-size="10" fill="${COLORS[op]}">${label}</text>`);
    }
  }
  return s.join('\n');
}

const legend = OPS.map((op, i) =>
  `<g transform="translate(${x0 + i * 230},40)"><rect x="0" y="0" width="16" height="10" rx="2" fill="${COLORS[op]}"/><text x="22" y="10" font-size="13" fill="#374151">${OP_LABEL[op]}</text></g>`
).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Segoe UI, Arial, sans-serif">
<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
<text x="${x0}" y="26" font-size="18" font-weight="700" fill="#111827">M3 Powers of Tau memory baseline</text>
<text x="${x1}" y="26" text-anchor="end" font-size="12" fill="#6b7280">snarkjs 0.7.6 / ffjavascript 0.3.1 / Windows native</text>
${legend}
${panels.map(panelSvg).join('\n')}
<text x="${(x0 + x1) / 2}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#6b7280">x-axis: Powers of Tau power (N = 2^power). Peak WS = Windows PeakWorkingSet64, not Linux RSS / Private Bytes.</text>
</svg>\n`;
fs.writeFileSync(path.join(outDir, 'm3_peak_vs_power.svg'), svg);

console.log(`M3 summary: ${rows.length} runs over powers [${powers.join(', ')}]`);
console.log('  -> results/processed/m3_summary.csv');
console.log('  -> results/processed/m3_phase_timings.csv');
console.log('  -> results/processed/m3_tables.md');
console.log('  -> results/processed/m3_peak_vs_power.svg');
if (repeatRecords.length) console.log(`  -> results/processed/m3_repeatability.csv (${repeatRecords.length} repeat runs)`);
for (const r of rows) {
  console.log(`  ${r.run_id.padEnd(30)} peak=${String(r.peak_working_set_mib).padStart(9)} MiB  elapsed=${String(r.elapsed_s).padStart(8)} s  exit=${r.exit_code}`);
}
