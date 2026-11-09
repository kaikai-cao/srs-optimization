#!/usr/bin/env node
/**
 * M5-D attribution: put the four quantities side by side AT THE SAME INSTANT.
 *
 * The point of M5 is that "model vs peak WS" is a category error unless the
 * quantities are read on one clock. This script builds exactly that:
 *
 *   in-flight   sum of send_bytes of tasks that have been sent and not yet returned
 *               (probe clock, from task_send / task_done)
 *   capacity    sum over workers of wasm_after pages x 64 KiB
 *               (probe clock; growth is dated at the completing worker_task, so it
 *                is an upper bound on WHEN the growth became visible)
 *   worker-js   sum of the per-task snapshots (w_heap_used + w_external +
 *               w_array_buffers) of the tasks in flight -- the worker-side JS heap
 *   ws          measured Working Set (measurer clock, 25 ms poll)
 *
 * and reports the residual WS - (in-flight + capacity) as an INTERVAL, never as a
 * point estimate. Nothing here is allowed to add bytes of different kinds and call
 * the result a prediction; the residual is what the probe cannot yet attribute.
 *
 * Usage:
 *   node scripts/m5d_attribution.cjs \
 *     --jsonl results/raw/m5d/m5_trace_prepared_verify_p18_r1_b1.jsonl \
 *     --run   results/raw/m5d/m5_trace_prepared_verify_p18_r1_b1.json \
 *     --timeline results/raw/m5d/m5_trace_prepared_verify_p18_r1_b1.timeline.json \
 *     --out results/processed/m5d_attribution_p18_r1
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const jsonlPath = arg('jsonl', '');
const runPath = arg('run', '');
const timelinePath = arg('timeline', '');
const outPath = arg('out', '');
if (!jsonlPath || !outPath) {
  console.error('need --jsonl and --out');
  process.exit(2);
}

const MiB = (b) => b / 1048576;
const PAGE = 65536;
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

async function main() {
  const run = runPath && fs.existsSync(runPath) ? JSON.parse(fs.readFileSync(runPath, 'utf8')) : null;
  const tl = timelinePath && fs.existsSync(timelinePath) ? JSON.parse(fs.readFileSync(timelinePath, 'utf8')) : null;

  let NW = 0; // workers that ever ran a task
  const starts = new Map(); // task_id -> {t, bytes, site, worker}
  const done = new Map(); // task_id -> t
  const workerPages = new Map(); // worker -> pages (latest)
  const capacityEvents = []; // {t, pages}
  const calls = new Map(); // call_id -> site (first seen)
  const sendTimes = [];
  const doneTimes = [];

  const rl = readline.createInterface({ input: fs.createReadStream(jsonlPath), crlfDelay: Infinity });
  let provenance = null;
  let summary = null;
  const events = [];

  for await (const line of rl) {
    if (!line) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (j.ev === 'provenance') {
      provenance = j;
      continue;
    }
    if (j.ev === 'summary') {
      summary = j;
      continue;
    }
    if (j.ev === 'task_send') {
      if (j.worker + 1 > NW) NW = j.worker + 1;
      starts.set(j.task_id, { t: j.t_ms, bytes: j.send_bytes || 0, site: j.site, worker: j.worker });
      sendTimes.push(j.t_ms);
      continue;
    }
    if (j.ev === 'task_done') {
      done.set(j.task_id, j.t_ms);
      doneTimes.push(j.t_ms);
      continue;
    }
    if (j.ev === 'worker_task') {
      const before = workerPages.get(j.worker) || 0;
      const after = j.wasm_after / PAGE;
      if (after !== before) {
        workerPages.set(j.worker, after);
        capacityEvents.push({ t: j.t_ms, worker: j.worker, pages: after });
      }
      events.push({ ev: 'worker_task', t: j.t_ms, task_id: j.task_id, call_id: j.call_id, wjs: (j.w_heap_used || 0) + (j.w_external || 0) + (j.w_array_buffers || 0) });
      continue;
    }
    if (j.ev === 'msm_plan' || j.ev === 'batch_plan' || j.ev === 'fft_plan') {
      if (!calls.has(j.call_id)) calls.set(j.call_id, j.site);
      events.push({ ev: j.ev, t: j.t_ms, call_id: j.call_id });
    }
  }

  if (!provenance) {
    console.error('no provenance line: refusing to attribute');
    process.exit(3);
  }

  // ---- sweep in-flight ------------------------------------------------------
  // Merge start/end points; on ties a start precedes an end so the peak is not
  // understated by tasks that hand over within the same millisecond.
  const points = [];
  for (const [id, s] of starts) points.push({ t: s.t, d: +1, id, bytes: s.bytes, site: s.site });
  for (const [id, t] of done) if (starts.has(id)) points.push({ t, d: -1, id, bytes: starts.get(id).bytes, site: starts.get(id).site });
  points.sort((a, b) => (a.t - b.t) || (b.d - a.d));

  let live = 0;
  let liveBySite = new Map();
  let peak = { bytes: 0, t: 0, bySite: [] };
  const inflightSeries = [];
  for (const p of points) {
    if (p.d > 0) {
      live += p.bytes;
      liveBySite.set(p.site, (liveBySite.get(p.site) || 0) + p.bytes);
    } else {
      live -= p.bytes;
      liveBySite.set(p.site, Math.max(0, (liveBySite.get(p.site) || 0) - p.bytes));
    }
    inflightSeries.push({ t: p.t, bytes: live });
    if (live > peak.bytes) {
      peak = {
        bytes: live,
        t: p.t,
        bySite: [...liveBySite.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 6),
      };
    }
  }

  // ---- capacity series ------------------------------------------------------
  capacityEvents.sort((a, b) => a.t - b.t);
  const capSeries = [];
  {
    let pages = 0;
    const perWorker = new Map();
    for (const e of capacityEvents) {
      const prev = perWorker.get(e.worker) || 25; // every worker starts at 25 pages
      pages += e.pages - prev;
      perWorker.set(e.worker, e.pages);
      capSeries.push({ t: e.t, pages, worker: e.worker, to: e.pages });
    }
    const total = [...perWorker.values()].reduce((a, b) => a + b, 0);
    capSeries.push({ t: Infinity, pages: total });
    var capacityFinal = { pages: total, workers: perWorker.size };
  }

  const capAt = (t) => {
    const perWorker = new Map();
    let n = 0;
    for (const e of capacityEvents) {
      if (e.t > t) break;
      perWorker.set(e.worker, e.pages);
      if (e.worker + 1 > n) n = e.worker + 1;
    }
    let pages = 0;
    for (let w = 0; w < NW; w++) pages += perWorker.get(w) || 25;
    return pages;
  };

  const inflightAt = (t) => {
    let lo = 0;
    let hi = inflightSeries.length - 1;
    if (!inflightSeries.length) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (inflightSeries[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return inflightSeries[lo].bytes;
  };

  // ---- WS series ------------------------------------------------------------
  const wsSamples = tl ? tl.series.map((s) => ({ t: s.t_ms, ws: s.ws_mib })) : [];
  const wsAt = (t) => {
    if (!wsSamples.length) return null;
    let lo = 0;
    let hi = wsSamples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (wsSamples[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    // report the bracketing pair, so the reader sees the poll granularity
    const a = wsSamples[lo];
    const b = wsSamples[Math.min(lo + 1, wsSamples.length - 1)];
    return { before: a.ws, after: b.ws, dt: b.t - a.t };
  };

  // ---- checkpoints ----------------------------------------------------------
  // Dated from the probe itself: the instant of the in-flight peak, and the ends
  // of the four segments the model talks about.
  const ck = [];
  const push = (label, t) => {
    const w = wsAt(t);
    const cap = capAt(t);
    const inf = inflightAt(t);
    ck.push({
      label,
      t_ms: t,
      inflight_mib: MiB(inf),
      capacity_mib: MiB(cap * PAGE),
      ws_before_mib: w ? w.before : null,
      ws_after_mib: w ? w.after : null,
      residual_before_mib: w ? w.before - MiB(inf) - MiB(cap * PAGE) : null,
      residual_after_mib: w ? w.after - MiB(inf) - MiB(cap * PAGE) : null,
    });
  };

  const firstSend = sendTimes.length ? Math.min(...sendTimes) : 0;
  push('before first task', firstSend);
  push('in-flight peak', peak.t);
  if (summary) push('end of run', summary.t_ms);

  // ---- write ---------------------------------------------------------------
  const md = [];
  md.push(`# M5-D attribution — ${path.basename(jsonlPath)}`);
  md.push('');
  md.push(`probe: \`${provenance.sha256.slice(0, 12)}…\` resolved to \`${provenance.resolved}\``);
  md.push('');
  md.push('| quantity | value | clock |');
  md.push('| --- | ---: | --- |');
  md.push(`| tasks | ${summary ? summary.tasks : starts.size} | probe |`);
  md.push(`| calls | ${summary ? summary.calls : calls.size} | probe |`);
  md.push(`| in-flight peak | **${f1(MiB(peak.bytes))} MiB** | probe (send→done) |`);
  md.push(`| capacity, final | **${f1(MiB(capacityFinal.pages * PAGE))} MiB** (${capacityFinal.pages} pages over ${capacityFinal.workers} workers) | probe (worker_task) |`);
  md.push(`| capacity, at in-flight peak | ${f1(MiB(capAt(peak.t) * PAGE))} MiB | probe |`);
  md.push(`| WS at in-flight peak | ${wsAt(peak.t) ? f1(wsAt(peak.t).before) + '–' + f1(wsAt(peak.t).after) : 'n/a'} MiB | measurer (25 ms) |`);
  if (run) md.push(`| peak WS (whole run) | ${f1(run.peak_working_set_mib)} MiB | measurer |`);
  md.push(`| peak commit (whole run) | ${run ? f1(run.peak_commit_mib) + ' MiB' : 'n/a'} | measurer |`);
  md.push('');
  md.push('## In-flight peak composition (top sites)');
  md.push('');
  md.push('| site | MiB |');
  md.push('| --- | ---: |');
  for (const [site, bytes] of peak.bySite) md.push(`| ${site} | ${f1(MiB(bytes))} |`);
  md.push('');
  md.push('## Same-instant placement');
  md.push('');
  md.push('| checkpoint | t (ms) | in-flight | capacity | WS (before→after poll) | residual |');
  md.push('| --- | ---: | ---: | ---: | --- | ---: |');
  for (const c of ck) {
    md.push(
      `| ${c.label} | ${c.t_ms.toFixed(0)} | ${f1(c.inflight_mib)} | ${f1(c.capacity_mib)} | ` +
        `${c.ws_before_mib === null ? 'n/a' : f1(c.ws_before_mib) + '→' + f1(c.ws_after_mib)} | ` +
        `${c.residual_before_mib === null ? 'n/a' : f1(c.residual_before_mib) + '…' + f1(c.residual_after_mib)} |`
    );
  }
  md.push('');
  md.push('Residual = WS − in-flight − capacity, given as an interval because WS is polled every 25 ms while');
  md.push('the probe events are exact. It is **not** attributed to anything in this file.');
  md.push('');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(`${outPath}.md`, md.join('\n'), 'utf8');
  const csv = [
    'checkpoint,t_ms,inflight_mib,capacity_mib,ws_before_mib,ws_after_mib,residual_min_mib,residual_max_mib',
    ...ck.map((c) =>
      [
        c.label,
        c.t_ms.toFixed(1),
        f1(c.inflight_mib),
        f1(c.capacity_mib),
        c.ws_before_mib === null ? '' : f1(c.ws_before_mib),
        c.ws_after_mib === null ? '' : f1(c.ws_after_mib),
        c.residual_before_mib === null ? '' : f1(Math.min(c.residual_before_mib, c.residual_after_mib)),
        c.residual_after_mib === null ? '' : f1(Math.max(c.residual_before_mib, c.residual_after_mib)),
      ].join(',')
    ),
  ].join('\n') + '\n';
  fs.writeFileSync(`${outPath}.csv`, csv, 'utf8');

  console.log(md.join('\n'));
  console.log(`wrote ${outPath}.md and ${outPath}.csv`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
