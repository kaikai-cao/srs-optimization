#!/usr/bin/env node
/**
 * M5-E.1 -- attribution with three independent clocks on one axis.
 *
 * What changed against M5-D
 * -------------------------
 * M5-D placed each memory.grow at the moment the *main thread received*
 * `worker_task`, i.e. after the task finished. The grow happened somewhere inside
 * the task, so "capacity at the in-flight peak" was a lower bound and the report
 * could not decide whether the two peaks coincide. Hence the E.1 review finding:
 * the conclusion "the peaks do not coincide" was ahead of the evidence.
 *
 * Now every grow carries `t_hr` recorded inside alloc(), on the same process-wide
 * `process.hrtime.bigint()` clock as `anchor.t0_hr`. Capacity is therefore an
 * exact step function of time, not a per-task approximation:
 *
 *     C(t) = 28 * 25 pages * 64 KiB + 64 KiB * |{g : t_grow(g) <= t}|
 *
 * Three things are reported and never added together (M5_PROBE_DESIGN §10.9):
 *   - in-flight clone bytes : data buffers attached to unfinished tasks
 *   - capacity C(t)         : Worker WASM *address space* high-water mark
 *   - working set WS(t)     : resident bytes of the whole process
 *
 * A residual WS - in-flight - capacity is only meaningful at the end of the run,
 * where in-flight is exactly zero and capacity is a hard upper bound on what the
 * Worker WASM can be holding. That residual is reported as a lower bound with an
 * explicitly incomplete name, never as "the fragment" or "the leak".
 *
 * Usage:
 *   node scripts/m5e_attribution.cjs --jsonl <trace>.jsonl --run <run>.json \
 *        --timeline <trace>.timeline.json --out results/processed/m5e_p18_r1
 */

'use strict';

const fs = require('fs');

const MiB = (b) => b / 1048576;
const f1 = (x) => Math.round(x * 10) / 10;
const PAGE_MIB = 65536 / 1048576;

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

function sweepPeak(intervals) {
  const pts = [];
  for (const iv of intervals) {
    if (!(iv.end > iv.start)) continue;
    pts.push({ t: iv.start, d: iv.w });
    pts.push({ t: iv.end, d: -iv.w });
  }
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

/** Value of a step function (sorted [{t, value}]) at time t. */
function stepAt(steps, t) {
  let lo = 0;
  let hi = steps.length - 1;
  let ans = steps.length ? steps[0].value : 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].t <= t) {
      ans = steps[mid].value;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function main() {
  const jsonl = arg('jsonl');
  const runPath = arg('run');
  const tlPath = arg('timeline');
  const outPrefix = arg('out');
  if (!jsonl) {
    console.error('usage: m5e_attribution.cjs --jsonl X.jsonl [--run X.json] [--timeline X.timeline.json] [--out prefix]');
    process.exit(2);
  }

  const events = readEvents(jsonl);
  const anchor = events.find((e) => e.ev === 'anchor');
  if (!anchor || !anchor.t0_hr) {
    console.error('FAIL: no anchor.t0_hr -- this build does not timestamp grows; nothing to attribute');
    process.exit(2);
  }
  const t0hr = BigInt(anchor.t0_hr);
  const t0epoch = anchor.t0_epoch_ms != null ? Number(anchor.t0_epoch_ms) : null;
  const toMs = (hr) => Number(BigInt(hr) - t0hr) / 1e6;

  const sends = new Map();
  const tasks = [];
  let nWorkers = 0;
  for (const e of events) {
    if (e.ev === 'task_send') sends.set(e.task_id, e);
    else if (e.ev === 'worker_task') {
      tasks.push(e);
      if (e.worker + 1 > nWorkers) nWorkers = e.worker + 1;
    }
  }

  // ---- capacity as an exact step function of time -------------------------
  const grows = [];
  for (const t of tasks) {
    for (const g of t.grow_events || []) {
      if (!g.t_hr) continue;
      grows.push({ t: toMs(g.t_hr), worker: t.worker, task_id: t.task_id, from: g.from_pages, to: g.to_pages });
    }
  }
  grows.sort((a, b) => a.t - b.t);
  const basePages = nWorkers * 25;
  const capSteps = [{ t: -Infinity, value: basePages * PAGE_MIB }];
  let pages = basePages;
  for (const g of grows) {
    pages += g.to - g.from;
    capSteps.push({ t: g.t, value: pages * PAGE_MIB });
  }
  const finalCapacityMiB = pages * PAGE_MIB;
  const lastGrowT = grows.length ? grows[grows.length - 1].t : 0;

  // ---- in-flight, both windows --------------------------------------------
  const rows = [];
  for (const t of tasks) {
    const s = sends.get(t.task_id);
    if (!s) continue;
    const clone = (t.allocset_bytes || 0) + (t.set_bytes || 0);
    const wasm = (t.allocs || []).reduce((a, b) => a + b, 0);
    const hasW = t.t_hr_start != null && t.t_hr_end != null;
    rows.push({
      task_id: t.task_id,
      site: s.site,
      kind: s.kind,
      worker: t.worker,
      clone,
      wasm,
      getReq: s.worker_output_bytes || 0,
      out: t.out_bytes || 0,
      postStart: s.t_ms,
      postEnd: t.t_ms,
      start: hasW ? toMs(t.t_hr_start) : s.t_ms,
      end: hasW ? toMs(t.t_hr_end) : t.t_ms,
      hasWorkerWindow: hasW,
    });
  }
  // Two distinct byte pools -- clone (logical buffers) is NOT the WASM address
  // space. BatchConvert and FFT each add an ALLOC on top of ALLOCSET, so the WASM
  // total must exceed the clone total; the 10,745 == 10,745 equality claimed in
  // the old report was an arithmetic mistake (see M5-E.2 errata).
  const cloneTotalBytes = rows.reduce((a, r) => a + r.clone, 0);
  const wasmTotalBytes = rows.reduce((a, r) => a + r.wasm, 0);
  const getReqTotalBytes = rows.reduce((a, r) => a + r.getReq, 0);
  const outTotalBytes = rows.reduce((a, r) => a + r.out, 0);
  const hasWorkerClock = rows.length > 0 && rows[0].hasWorkerWindow;

  const workerPeak = sweepPeak(rows.map((r) => ({ start: r.start, end: r.end, w: r.clone })));
  const postPeak = sweepPeak(rows.map((r) => ({ start: r.postStart, end: r.postEnd, w: r.clone })));

  const headline = hasWorkerClock ? workerPeak : postPeak;
  const atPeak = rows.filter((r) => r.start <= headline.peakT && r.end > headline.peakT);
  const siteMap = new Map();
  for (const r of atPeak) siteMap.set(r.site, (siteMap.get(r.site) || 0) + r.clone);
  const siteRows = [...siteMap.entries()].sort((a, b) => b[1] - a[1]);

  const capAtPeak = stepAt(capSteps, headline.peakT);
  const inflightAtLastGrow = (() => {
    const live = rows.filter((r) => r.start <= lastGrowT && r.end > lastGrowT);
    return { n: live.length, bytes: live.reduce((a, r) => a + r.clone, 0) };
  })();
  const inflightAtPostPeak = (() => {
    const live = rows.filter((r) => r.start <= postPeak.peakT && r.end > postPeak.peakT);
    return { n: live.length, bytes: live.reduce((a, r) => a + r.clone, 0) };
  })();

  // ---- WS samples, epoch-aligned against the Node probe --------------------
  // The probe records anchor.t0_epoch_ms (Date.now) and every worker event on the
  // process-wide hrtime clock. The Windows sampler records start_epoch_ms at
  // Process.Start() and every poll on a .NET Stopwatch. The two origins differ by
  // the node startup gap, so we reconcile them through the two epoch stamps:
  //   ws_abs_epoch   = start_epoch_ms + series[].t_ms
  //   node_abs_epoch = anchor.t0_epoch_ms + (hrtime - t0_hr)/1e6
  // Anything reported as WS before this alignment is unverified (M5-E.2 review).
  let series = [];
  let tlStartEpoch = null;
  let run = null;
  if (tlPath && fs.existsSync(tlPath)) {
    const tl = JSON.parse(fs.readFileSync(tlPath, 'utf8'));
    series = tl.series || [];
    tlStartEpoch = tl.start_epoch_ms != null ? Number(tl.start_epoch_ms) : null;
  }
  if (runPath && fs.existsSync(runPath)) run = JSON.parse(fs.readFileSync(runPath, 'utf8'));

  const epochAligned = t0epoch !== null && tlStartEpoch !== null;
  const relToEpoch = (relMs) => (epochAligned ? t0epoch + relMs : null);
  function nearestWs(absEpoch) {
    if (absEpoch === null || !series.length) return null;
    let best = series[0];
    let bd = Math.abs((tlStartEpoch + best.t_ms) - absEpoch);
    for (const s of series) {
      const d = Math.abs((tlStartEpoch + s.t_ms) - absEpoch);
      if (d < bd) { bd = d; best = s; }
    }
    return { sample: best, delta_ms: bd };
  }

  const wsPeak = nearestWs(relToEpoch(headline.peakT));
  const firstSendT = rows.length ? Math.min(...rows.map((r) => r.postStart)) : null;
  const wsStart = firstSendT != null ? nearestWs(relToEpoch(firstSendT)) : null;
  // "end of run" must mean "all tasks finished, worker pool NOT yet torn down".
  // The sampler keeps polling after snarkjs terminates the ThreadManager, and
  // releasing ~1.5 GiB of WASM makes the last few samples useless (WS falls from
  // 2,714 to 207 MiB in 200 ms). So we clamp to the final task completion and
  // only accept samples at or before it.
  const lastTaskEndT = rows.length ? Math.max(...rows.map((r) => r.postEnd)) : null;
  const endAbs = relToEpoch(lastTaskEndT);
  const beforeTeardown = endAbs === null
    ? []
    : series.filter((x) => (tlStartEpoch + x.t_ms) <= endAbs + 60);
  const wsEnd = beforeTeardown.length ? beforeTeardown[beforeTeardown.length - 1] : null;
  const wsEndDelta = wsEnd && lastTaskEndT != null && endAbs !== null
    ? Math.abs((tlStartEpoch + wsEnd.t_ms) - endAbs) : null;
  const wsPeakProcess = series.length ? series.reduce((a, b) => (b.ws_mib > a.ws_mib ? b : a)) : null;

  // ---- per kind ------------------------------------------------------------
  const kinds = new Map();
  for (const r of rows) {
    const k = kinds.get(r.kind) || { tasks: 0, clone: 0 };
    k.tasks += 1;
    k.clone += r.clone;
    kinds.set(r.kind, k);
  }
  const kindPeaks = {};
  for (const kind of kinds.keys()) {
    const sub = rows.filter((r) => r.kind === kind);
    const p = sweepPeak(sub.map((r) => ({ start: r.start, end: r.end, w: r.clone })));
    kindPeaks[kind] = {
      clone_peak_MiB: f1(MiB(p.peak)),
      at_t_ms: Math.round(p.peakT * 10) / 10,
      tasks_in_flight: sub.filter((r) => r.start <= p.peakT && r.end > p.peakT).length,
    };
  }

  // ---- FFT main-thread side (assembly), which in-flight does NOT cover ------
  const asm = events.filter((e) => e.ev === 'fft_assembly');
  const fftAssembly = asm.length
    ? {
        calls: asm.length,
        max_copy_MiB: f1(MiB(Math.max(...asm.map((a) => a.copy_bytes || 0)))),
        max_chunks_MiB: f1(MiB(Math.max(...asm.map((a) => a.chunks_bytes || 0)))),
        max_out_MiB: f1(MiB(Math.max(...asm.map((a) => a.out_bytes || 0)))),
      }
    : null;

  const endResidual = wsEnd && wsEnd.ws_mib != null ? wsEnd.ws_mib - finalCapacityMiB : null;

  const report = {
    jsonl,
    power: anchor && run ? run.power : null,
    workers: nWorkers,
    tasks: rows.length,
    grows: grows.length,
    clock: hasWorkerClock ? 'worker hrtime' : 'main-thread post/reply',
    inflight: {
      worker_window_peak_MiB: f1(MiB(workerPeak.peak)),
      worker_window_peak_t_ms: Math.round(workerPeak.peakT * 10) / 10,
      post_window_peak_MiB: f1(MiB(postPeak.peak)),
      post_window_peak_t_ms: Math.round(postPeak.peakT * 10) / 10,
      at_headline_peak_tasks: atPeak.length,
      at_headline_peak_sites: siteRows.map(([site, b]) => ({ site, MiB: f1(MiB(b)) })),
      at_post_peak_tasks: inflightAtPostPeak.n,
      at_post_peak_MiB: f1(MiB(inflightAtPostPeak.bytes)),
    },
    capacity: {
      base_MiB: f1(basePages * PAGE_MIB),
      final_MiB: f1(finalCapacityMiB),
      final_pages: pages,
      last_grow_t_ms: Math.round(lastGrowT * 10) / 10,
      at_inflight_peak_MiB: f1(capAtPeak),
      inflight_at_last_grow_tasks: inflightAtLastGrow.n,
      inflight_at_last_grow_MiB: f1(MiB(inflightAtLastGrow.bytes)),
    },
    ws: {
      epoch_aligned: epochAligned,
      alignment_note: epochAligned
        ? 'WS(t) aligned to Node events via start_epoch_ms + anchor.t0_epoch_ms; residual uncertainty is the 25 ms poll'
        : 'NOT aligned: timeline has no start_epoch_ms (pre-M5-E.2 run). WS columns are n/a.',
      peak_process_MiB: run ? run.peak_working_set_mib : null,
      at_inflight_peak_MiB: wsPeak ? wsPeak.sample.ws_mib : null,
      at_inflight_peak_delta_ms: wsPeak ? Math.round(wsPeak.delta_ms) : null,
      at_first_send_MiB: wsStart ? wsStart.sample.ws_mib : null,
      end_MiB: wsEnd ? wsEnd.ws_mib : null,
      end_t_ms: wsEnd ? wsEnd.t_ms : null,
      end_delta_ms: wsEndDelta === null ? null : Math.round(wsEndDelta),
      last_task_end_t_ms: lastTaskEndT,
      peak_process_at_t_ms: wsPeakProcess ? wsPeakProcess.t_ms : null,
      samples: series.length,
      poll_ms: 25,
    },
    bytes_total: {
      clone_MiB: f1(MiB(cloneTotalBytes)),
      worker_wasm_alloc_MiB: f1(MiB(wasmTotalBytes)),
      get_request_MiB: f1(MiB(getReqTotalBytes)),
      worker_out_bytes_MiB: f1(MiB(outTotalBytes)),
      note: 'clone = ALLOCSET+SET (logical buffers); worker_wasm_alloc = sum of WASM linear-memory allocs (address space, NOT residency). The two are different objects and are never summed.',
    },
    end_residual: {
      definition: 'WS(end) - C(final): bytes the process holds that cannot be Worker WASM address space',
      MiB: endResidual === null ? null : f1(endResidual),
      above_process_baseline_MiB: endResidual === null || !wsStart ? null : f1(endResidual - wsStart.sample.ws_mib),
    },
    per_kind_peak: kindPeaks,
    fft_assembly: fftAssembly,
  };

  const lines = [];
  const say = (x) => lines.push(x);
  say(`# M5-E.2 attribution -- ${jsonl.split(/[\\/]/).pop()}`);
  say('');
  say(`workers ${nWorkers}   tasks ${rows.length}   grows ${grows.length}   clock ${report.clock}`);
  // Provenance: WS columns are only populated when a timeline is supplied AND the
  // two clocks were aligned, so say plainly which inputs this artifact used.
  say(`inputs jsonl=yes  run=${runPath ? 'yes' : 'no'}  timeline=${tlPath ? 'yes' : 'no'}`
    + (tlPath ? '' : '   (WS rows are n/a without --timeline)')
    + (tlPath ? `   ws_alignment=${epochAligned ? 'epoch-aligned' : 'MISSING start_epoch_ms (n/a)'}` : ''));
  say('');
  say('## 1. in-flight (clone buffers only: ALLOCSET + SET)');
  say('');
  say('| window | peak MiB | at t (ms) | tasks in flight |');
  say('| --- | ---: | ---: | ---: |');
  say(`| worker (t_hr_start..t_hr_end) | ${f1(MiB(workerPeak.peak))} | ${Math.round(workerPeak.peakT * 10) / 10} | ${rows.filter((r) => r.start <= workerPeak.peakT && r.end > workerPeak.peakT).length} |`);
  say(`| post (send..reply) | ${f1(MiB(postPeak.peak))} | ${Math.round(postPeak.peakT * 10) / 10} | ${inflightAtPostPeak.n} |`);
  say('');
  say('At the worker-window peak:');
  for (const [site, b] of siteRows) say(`- \`${site}\` ${f1(MiB(b))} MiB`);
  say('');
  say('## 2. capacity, exact from grow timestamps');
  say('');
  say(`- C(final) = ${f1(finalCapacityMiB)} MiB (${pages} pages), last grow at t=${Math.round(lastGrowT * 10) / 10} ms`);
  say(`- C(t_inflight_peak) = ${f1(capAtPeak)} MiB  (= ${f1((100 * capAtPeak) / finalCapacityMiB)}% of final)`);
  say(`- in flight when the last grow happened: ${inflightAtLastGrow.n} tasks, ${f1(MiB(inflightAtLastGrow.bytes))} MiB`);
  say('');
  say('## 3. side by side at the in-flight peak (NOT summed)');
  say('');
  say('| quantity | value | unit |');
  say('| --- | ---: | --- |');
  say(`| in-flight clone, worker window | ${f1(MiB(workerPeak.peak))} | MiB |`);
  say(`| in-flight clone, post window | ${f1(MiB(postPeak.peak))} | MiB |`);
  say(`| Worker WASM capacity C(t) | ${f1(capAtPeak)} | MiB (address space, exact) |`);
  say(`| Working set WS(t) | ${wsPeak ? wsPeak.sample.ws_mib : 'n/a'} | MiB (resident${epochAligned ? ', epoch-aligned, +-25 ms poll' : ', NOT aligned'}) |`);
  say('');
  say('**Overlap, not identity of peaks.** The two quantities overlap heavily: at the in-flight');
  say(`peak the Worker WASM capacity is already at ${f1((100 * capAtPeak) / finalCapacityMiB)}% of its final value. But their`);
  say(`individual maxima are NOT at the same instant -- the in-flight peak is at t=${Math.round(workerPeak.peakT * 10) / 10} ms,`);
  say(`while the capacity final value is only reached at the last grow t=${Math.round(lastGrowT * 10) / 10} ms`);
  say(`(${f1((lastGrowT - workerPeak.peakT) / 1000)} s later for p18; the gap is smaller but non-zero for p16).`);
  say('M5-E said "the two peaks do not coincide" and retracted it; the precise correction is');
  say('"they coincide in being HIGH, but not at their respective maxima".');
  say('');
  say('No residual is computed here. In-flight counts logical clone buffers; capacity is linear');
  say('address space; WS is resident pages. They are three different objects. The prohibition on');
  say('adding them together stands, but for the correct reason: clone bytes and the WASM copy are');
  say('*separate* memory objects that may coexist, capacity is not residency, and the current');
  say('telemetry cannot convert any of them directly into the Working Set (M5_PROBE_DESIGN 10.9).');
  say('');
  say('## 4. end of run, where in-flight is exactly zero');
  say('');
  say(`Sampled at t=${wsEnd ? wsEnd.t_ms : 'n/a'} ms (${wsEndDelta === null ? 'n/a' : Math.round(wsEndDelta) + ' ms '}from the last task completion at ${lastTaskEndT === null ? 'n/a' : Math.round(lastTaskEndT)} ms). Later samples are teardown.`);
  if (!epochAligned) {
    say('WS(end) is n/a: this timeline carries no start_epoch_ms, so it cannot be aligned to the');
    say('Node probe events. Re-run with the M5-E.2 sampler to populate it (see M5_PROBE_DESIGN).');
  }
  say('');
  say('| quantity | value | unit |');
  say('| --- | ---: | --- |');
  say(`| WS(end) | ${wsEnd ? wsEnd.ws_mib : 'n/a'} | MiB |`);
  say(`| Worker WASM capacity C(final) | ${f1(finalCapacityMiB)} | MiB (upper bound on WASM residency) |`);
  say(`| **WS(end) - C(final)** | **${endResidual === null ? 'n/a' : f1(endResidual)}** | MiB |`);
  say(`| minus process baseline WS(first send) | ${report.end_residual.above_process_baseline_MiB} | MiB |`);
  say('');
  say('The last row is a LOWER BOUND on "bytes outside Worker WASM". It is not a');
  say('fragment estimate: main-thread clones, BigBuffer pages, FastFile cache and');
  say('uncollected V8 heap all live in there and have not been separated.');
  say('');
  say('## 5. per kind in-flight peak');
  say('');
  say('| kind | tasks | clone peak MiB | at t (ms) | in flight |');
  say('| --- | ---: | ---: | ---: | ---: |');
  for (const [kind, kp] of Object.entries(kindPeaks)) {
    say(`| ${kind} | ${kinds.get(kind).tasks} | ${kp.clone_peak_MiB} | ${kp.at_t_ms} | ${kp.tasks_in_flight} |`);
  }
  if (fftAssembly) {
    say('');
    say(`FFT main-thread assembly (outside in-flight): ${fftAssembly.calls} calls, max copy ${fftAssembly.max_copy_MiB} MiB + chunks ${fftAssembly.max_chunks_MiB} MiB + out ${fftAssembly.max_out_MiB} MiB.`);
    say('M5-E.2 fix: chunks_bytes is now counted BEFORE the per-chunk delete loop, so it reflects');
    say('the real transient chunk working set (it was 0 before the fix).');
    say('These are transient allocations inside `_fft`; their lifetime across the whole FFT call is');
    say('NOT modelled here, so FFT still cannot be excluded from the Working Set budget.');
  }

  say('');
  say('## 6. byte accounting totals (whole run)');
  say('');
  say(`- clone  (ALLOCSET+SET, logical buffers): ${f1(MiB(cloneTotalBytes))} MiB`);
  say(`- worker WASM alloc (sum of allocs, address space): ${f1(MiB(wasmTotalBytes))} MiB`);
  say(`- GET request bytes (task_send.worker_output_bytes): ${f1(MiB(getReqTotalBytes))} MiB`);
  say(`- worker out_bytes (actual returned copies): ${f1(MiB(outTotalBytes))} MiB`);
  say('');
  say('The worker WASM alloc total is LARGER than the clone total (BatchConvert and FFT each add');
  say('an ALLOC on top of ALLOCSET, and FFT adds more). The old report equated the two at 10,745 MiB;');
  say('that equality was an arithmetic error and is retracted (M5-E.2 errata). clone and WASM alloc');
  say('are separate memory objects and are never summed.');

  const text = lines.join('\n') + '\n';
  if (outPrefix) {
    fs.writeFileSync(outPrefix + '.md', text, 'utf8');
    fs.writeFileSync(outPrefix + '.json', JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  process.stdout.write(text);
}

main();
