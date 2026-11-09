#!/usr/bin/env node
/**
 * M5 L1 gate -- chunking equality between the static plan and the probe.
 *
 * The plan (`node scripts/m5_budget.cjs --operation plan`) replays
 * engine_multiexp.js / engine_batchconvert.js / engine_fft.js from source. This
 * checker asserts that the probe observed EXACTLY that sequence of calls, with
 * the same scalar width, bit-chunk count, point-chunk arithmetic and task count.
 *
 * There is no tolerance here: n_points, s_scalar, bit_chunk, n_bit, chunk_size
 * and the per-call task count are integers that the library computes
 * deterministically. Any difference means either the probe missed a call, or our
 * reading of the source is wrong -- both are fatal for attribution.
 *
 * Usage:
 *   node scripts/m5_check_l1.cjs --plan results/raw/m5_plan_p18.json \
 *                                --jsonl results/raw/m5_p18_r1.jsonl
 */

'use strict';

const fs = require('fs');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function readJsonl(p) {
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const events = [];
  let bad = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (e) {
      bad++;
    }
  }
  return { events, bad };
}

const PLAN_KINDS = new Set(['msm', 'batch', 'fft', 'fftjoinext']);
const FIELD_MAP = [
  ['n_points', 'n_points'],
  ['s_scalar', 's_scalar'],
  ['s_in', 's_in'],
  ['s_out', 's_out'],
  ['bit_chunk', 'bit_chunk'],
  ['n_bit', 'n_bit'],
  ['chunk_size', 'chunk_size'],
  ['points_in_chunk', 'points_in_chunk'],
  ['n_chunks', 'n_chunks'],
];

function main() {
  const planPath = arg('plan');
  const jsonlPath = arg('jsonl');
  if (!planPath || !jsonlPath) {
    console.error('usage: m5_check_l1.cjs --plan <plan.json> --jsonl <events.jsonl>');
    process.exit(2);
  }

  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const { events, bad } = readJsonl(jsonlPath);
  const prov = events.find((e) => e.ev === 'provenance');
  if (!prov) {
    console.error('FAIL: no provenance line -- refusing to grade an un-instrumented log');
    process.exit(1);
  }

  const calls = events.filter((e) => typeof e.ev === 'string' && e.ev.endsWith('_plan') && PLAN_KINDS.has(e.ev.slice(0, -5)));
  const sends = events.filter((e) => e.ev === 'task_send');

  const sendsByCall = new Map();
  for (const s of sends) sendsByCall.set(s.call_id, (sendsByCall.get(s.call_id) || 0) + 1);
  const unlabeled = sends.filter((s) => s.call_id === 0).length;

  const expected = plan.calls;
  const problems = [];

  if (calls.length !== expected.length) {
    problems.push(`call count: expected ${expected.length}, observed ${calls.length}`);
  }

  const n = Math.min(calls.length, expected.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i];
    const o = calls[i];
    if (e.kind !== o.kind) {
      problems.push(`#${i}: kind expected ${e.kind}, observed ${o.kind}`);
      continue;
    }
    for (const [ek, ok] of FIELD_MAP) {
      const ev = e[ek];
      const ov = o[ok];
      if (ev === null || ev === undefined) continue;
      if (ov === undefined || ov === null) {
        problems.push(`#${i} ${e.kind} ${e.site}: field ${ek} missing in probe (expected ${ev})`);
      } else if (typeof ev === 'number' && Math.abs(ev - ov) > 1e-9) {
        problems.push(`#${i} ${e.kind} ${e.site}: ${ek} expected ${ev}, observed ${ov}`);
      }
    }
    // task count is only comparable where one call == one wave of tasks
    if (e.kind !== 'fft' && e.kind !== 'fftjoinext') {
      const observed = sendsByCall.get(o.call_id) || 0;
      if (observed !== e.n_tasks) {
        problems.push(`#${i} ${e.kind} ${e.site}: tasks expected ${e.n_tasks}, observed ${observed} (call_id ${o.call_id})`);
      }
    }
  }

  // Unexpected kinds that the plan does not model at all.
  const seenKinds = new Set(calls.map((c) => c.kind));
  const known = new Set(expected.map((c) => c.kind));
  for (const k of seenKinds) if (!known.has(k)) problems.push(`unexpected call kind observed: ${k}`);

  console.log(`plan     : ${planPath} (power ${plan.power}, ${expected.length} calls)`);
  console.log(`jsonl    : ${jsonlPath} (${events.length} events, ${bad} unparsable)`);
  console.log(`proved   : ${prov.resolved}`);
  console.log(`sha256   : ${prov.sha256}`);
  console.log(`calls    : expected ${expected.length}, observed ${calls.length}`);
  console.log(`tasks    : ${sends.length} task_send (${unlabeled} unlabeled, ${sends.length - unlabeled} attributed)`);
  console.log(`kinds    : ${[...seenKinds].sort().join(', ')}`);

  if (problems.length) {
    console.log(`\nL1 FAIL (${problems.length} problem(s)):`);
    for (const p of problems.slice(0, 25)) console.log('  - ' + p);
    if (problems.length > 25) console.log(`  ... ${problems.length - 25} more`);
    process.exit(1);
  }
  console.log('\nL1 PASS: probe chunking equals the static plan for every call.');
}

main();
