#!/usr/bin/env node
/**
 * M5-E.1 -- recompute in-flight bytes from a trace, without re-running anything.
 *
 * Why this exists
 * ---------------
 * M5-D's in-flight number came from `task_send.send_bytes`, which added ALLOCSET
 * + SET + ALLOC + GET together. Only the first two are structured-cloned into the
 * worker message; ALLOC never leaves the worker's WASM memory and GET is a
 * request size whose real copy is `out_bytes`. For MSM the error is one Jacobian
 * per task (144/288 B); for FFT and BatchConvert it is 2-3x, because those tasks
 * are ALLOC + SET + GET of the *same* buffer.
 *
 * This script rebuilds the quantity from the two independent counters the probe
 * already records on the worker side:
 *
 *     clone_buffer_bytes = worker_task.allocset_bytes + worker_task.set_bytes
 *
 * joined to `task_send` by task_id, and reports both the corrected peak and the
 * old definition so the size of the correction is explicit. It works on the
 * M5-D logs as they are -- `allocset_bytes`/`set_bytes` were always recorded.
 *
 * In-flight window
 * ----------------
 * A task holds its cloned buffers from the moment the main thread posts it to the
 * moment the worker's reply is consumed. Old logs only have main-thread
 * timestamps, so the window is [task_send.t_ms, worker_task.t_ms]. New logs also
 * carry worker-side `t_hr_start`/`t_hr_end` on the same process-wide monotonic
 * clock as `anchor.t0_hr`; when present the window is
 * [t_hr_start, t_hr_end] converted to ms, which removes the queueing delay.
 *
 * Usage:
 *   node scripts/m5e_inflight.cjs --jsonl results/raw/m5d/m5_trace_...p18_r1_b1.jsonl
 *   node scripts/m5e_inflight.cjs --jsonl X.jsonl --out results/processed/foo --json
 */

'use strict';

const fs = require('fs');

const MiB = (b) => b / 1048576;
const f1 = (x) => Math.round(x * 10) / 10;

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function readEvents(p) {
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      /* truncated tail */
    }
  }
  return out;
}

/** Peak of a set of half-open intervals with weights. */
function sweep(intervals) {
  const pts = [];
  for (const iv of intervals) {
    if (!(iv.end > iv.start)) continue;
    pts.push({ t: iv.start, d: iv.w });
    pts.push({ t: iv.end, d: -iv.w });
  }
  // ends before starts at the same instant: a task that finishes at t does not
  // overlap one that starts at t.
  pts.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let peak = 0;
  let peakT = 0;
  for (const p of pts) {
    cur += p.d;
    if (cur > peak) {
      peak = cur;
      peakT = p.t;
    }
  }
  return { peak, peakT };
}

function main() {
  const jsonl = arg('jsonl');
  if (!jsonl) {
    console.error('usage: m5e_inflight.cjs --jsonl <events.jsonl> [--out <prefix>] [--json]');
    process.exit(2);
  }
  const wantJson = process.argv.includes('--json');
  const outPrefix = arg('out');

  const events = readEvents(jsonl);
  const anchor = events.find((e) => e.ev === 'anchor') || {};
  const t0hr = anchor.t0_hr ? BigInt(anchor.t0_hr) : null;

  const sends = new Map();
  const tasks = [];
  for (const e of events) {
    if (e.ev === 'task_send') sends.set(e.task_id, e);
    else if (e.ev === 'worker_task') tasks.push(e);
  }

  const hasWorkerClock = t0hr !== null && tasks.length > 0 && tasks[0].t_hr_start != null;
  const toMs = (hr) => Number(BigInt(hr) - t0hr) / 1e6;

  const rows = [];
  let missing = 0;
  for (const t of tasks) {
    const s = sends.get(t.task_id);
    if (!s) {
      missing += 1;
      continue;
    }
    const clone = (t.allocset_bytes || 0) + (t.set_bytes || 0);
    const wasm = t.allocs ? t.allocs.reduce((a, b) => a + b, 0) : 0;
    const out = t.out_bytes || 0;
    // What M5-D called send_bytes: ALLOCSET + SET + ALLOC + GET
    const legacy = s.send_bytes !== undefined ? s.send_bytes : wasm + out;
    // Two windows, because they answer different questions:
    //   post -> reply : the main thread has handed the clone over and the worker
    //                   may have it queued. Upper bound on "a copy exists".
    //   worker        : the worker is actually running the task. Lower bound.
    const postStart = s.t_ms;
    const postEnd = t.t_ms;
    const hasW = t.t_hr_start != null && t.t_hr_end != null;
    rows.push({
      task_id: t.task_id,
      call_id: s.call_id,
      site: s.site,
      kind: s.kind,
      worker: t.worker,
      postStart,
      postEnd,
      start: hasW ? toMs(t.t_hr_start) : postStart,
      end: hasW ? toMs(t.t_hr_end) : postEnd,
      hasWorkerWindow: hasW,
      clone,
      legacy,
      wasm,
      out,
    });
  }

  const byClone = sweep(rows.map((r) => ({ start: r.start, end: r.end, w: r.clone })));
  const byLegacy = sweep(rows.map((r) => ({ start: r.start, end: r.end, w: r.legacy })));
  const postClone = sweep(rows.map((r) => ({ start: r.postStart, end: r.postEnd, w: r.clone })));
  const postLegacy = sweep(rows.map((r) => ({ start: r.postStart, end: r.postEnd, w: r.legacy })));

  // who is in flight at the corrected peak?
  const atPeak = rows.filter((r) => r.start <= byClone.peakT && r.end > byClone.peakT);
  const sites = new Map();
  for (const r of atPeak) sites.set(r.site, (sites.get(r.site) || 0) + r.clone);
  const siteRows = [...sites.entries()].sort((a, b) => b[1] - a[1]);

  const kinds = new Map();
  for (const r of rows) {
    const k = kinds.get(r.kind) || { tasks: 0, clone: 0, legacy: 0, wasm: 0, out: 0 };
    k.tasks += 1;
    k.clone += r.clone;
    k.legacy += r.legacy;
    k.wasm += r.wasm;
    k.out += r.out;
    kinds.set(r.kind, k);
  }

  // per-kind peaks: the combined peak is dominated by one kind, but the FFT
  // question is about the FFT timeline on its own.
  const kindPeaks = {};
  for (const kind of kinds.keys()) {
    const sub = rows.filter((r) => r.kind === kind);
    const c = sweep(sub.map((r) => ({ start: r.start, end: r.end, w: r.clone })));
    const l = sweep(sub.map((r) => ({ start: r.start, end: r.end, w: r.legacy })));
    kindPeaks[kind] = {
      clone_peak_MiB: f1(MiB(c.peak)),
      legacy_peak_MiB: f1(MiB(l.peak)),
      clone_peak_t_ms: Math.round(c.peakT * 10) / 10,
      tasks_in_flight: sub.filter((r) => r.start <= c.peakT && r.end > c.peakT).length,
    };
  }

  const report = {
    jsonl,
    clock: hasWorkerClock ? 'worker hrtime (t_hr_start..t_hr_end)' : 'main-thread (task_send..worker_task)',
    tasks: rows.length,
    tasks_without_send: missing,
    inflight_clone_peak_bytes: byClone.peak,
    window: hasWorkerClock ? 'worker' : 'post',
    post_window_clone_peak_mib: f1(MiB(postClone.peak)),
    post_window_clone_peak_t_ms: Math.round(postClone.peakT * 10) / 10,
    post_window_legacy_peak_mib: f1(MiB(postLegacy.peak)),
    inflight_clone_peak_mib: f1(MiB(byClone.peak)),
    inflight_clone_peak_t_ms: Math.round(byClone.peakT * 10) / 10,
    inflight_legacy_peak_bytes: byLegacy.peak,
    inflight_legacy_peak_mib: f1(MiB(byLegacy.peak)),
    inflation_ratio: postLegacy.peak && postClone.peak ? Math.round((postLegacy.peak / postClone.peak) * 1000) / 1000 : null,
    inflation_bytes: postLegacy.peak - postClone.peak,
    at_peak_tasks: atPeak.length,
    at_peak_sites: siteRows.map(([site, bytes]) => ({ site, MiB: f1(MiB(bytes)) })),
    per_kind_peak: kindPeaks,
    by_kind: [...kinds.entries()].map(([kind, v]) => ({
      kind,
      tasks: v.tasks,
      clone_MiB: f1(MiB(v.clone)),
      legacy_MiB: f1(MiB(v.legacy)),
      wasm_MiB: f1(MiB(v.wasm)),
      out_MiB: f1(MiB(v.out)),
    })),
  };

  if (outPrefix) {
    fs.writeFileSync(outPrefix + '.json', JSON.stringify(report, null, 2) + '\n', 'utf8');
  }

  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`jsonl   : ${jsonl}`);
  console.log(`clock   : ${report.clock}`);
  console.log(`tasks   : ${report.tasks}${missing ? ` (${missing} without task_send!)` : ''}`);
  console.log('');
  if (hasWorkerClock) {
    console.log(`in-flight peak, worker window  : ${f1(MiB(byClone.peak))} MiB at t=${report.inflight_clone_peak_t_ms} ms`);
    console.log(`in-flight peak, post window    : ${f1(MiB(postClone.peak))} MiB at t=${report.post_window_clone_peak_t_ms} ms`);
  } else {
    console.log(`in-flight peak, post window    : ${f1(MiB(postClone.peak))} MiB at t=${report.post_window_clone_peak_t_ms} ms`);
  }
  console.log(`in-flight peak, old send_bytes : ${f1(MiB(postLegacy.peak))} MiB  (x${report.inflation_ratio} = +${f1(MiB(postLegacy.peak - postClone.peak))} MiB)`);
  console.log('');
  console.log(`in flight at the corrected peak: ${atPeak.length} tasks`);
  for (const [site, bytes] of siteRows.slice(0, 8)) {
    console.log(`  ${String(site).padEnd(28)} ${f1(MiB(bytes)).toString().padStart(8)} MiB`);
  }
  if (siteRows.length > 8) console.log(`  ... ${siteRows.length - 8} more sites`);
  console.log('');
  console.log('per kind: whole-run totals and per-kind in-flight peak');
  console.log('kind          tasks     clone MiB    legacy MiB   clone peak   legacy peak   @t ms   in flight');
  for (const r of report.by_kind) {
    const kp = kindPeaks[r.kind];
    console.log(
      `${r.kind.padEnd(12)} ${String(r.tasks).padStart(6)} ${String(r.clone_MiB).padStart(13)} ${String(r.legacy_MiB).padStart(14)} ${String(kp.clone_peak_MiB).padStart(12)} ${String(kp.legacy_peak_MiB).padStart(13)} ${String(kp.clone_peak_t_ms).padStart(8)} ${String(kp.tasks_in_flight).padStart(11)}`
    );
  }
}

main();
