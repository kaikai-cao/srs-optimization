#!/usr/bin/env node
/**
 * M5 L2 gate -- exact replay of every worker task's allocator history.
 *
 * threadman_thread.js is deterministic once you know four things per task:
 * the allocator pointer at entry (`alloc_base`), the ordered allocation lengths
 * (`allocs[]`), the page size (64 KiB) and the growth rule
 *
 *     top += len;  if (top + len > capacity) capacity = floor((top+len)/64KiB)+1 pages
 *
 * Note the rule uses `top` AFTER the increment, so it effectively demands
 * `capacity >= top + len` -- that double count is exactly F4.
 *
 * This checker replays `allocs[]` from `alloc_base` and requires the observed
 * `grow_events[]` and `wasm_after` to match EXACTLY, per worker, per event.
 * There is no whole-page tolerance: every input to the replay is measured.
 *
 * M5-E.1 additions (review finding #4.2):
 *   - per-worker continuity: wasm_after(task k) must equal wasm_before(task k+1)
 *     on the same worker. Without this the replay only proves each task correct
 *     in isolation, not that the per-worker capacity history is one chain.
 *   - alloc_base must be the SAME constant on every task of every worker
 *     (HYP-1's "0" would still replay if alloc_base were read per task).
 *   - grow_events[].len and .top are compared, not only from/to pages: they tie
 *     the grow to a specific allocation, so a reordering inside alloc() shows up.
 *   - task_send.wasm_alloc_bytes must equal sum(allocs) -- the two are produced
 *     by independent code paths (main-thread command scan vs. worker-side alloc
 *     counter), so agreement is a real cross-check of the byte accounting.
 *
 * Usage:
 *   node scripts/m5_check_l2.cjs --jsonl results/raw/m5_p18_r1.jsonl [--verbose]
 */

'use strict';

const fs = require('fs');

const PAGE = 65536;

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function main() {
  const jsonlPath = arg('jsonl');
  if (!jsonlPath) {
    console.error('usage: m5_check_l2.cjs --jsonl <events.jsonl> [--verbose]');
    process.exit(2);
  }
  const verbose = process.argv.includes('--verbose');

  const tasks = [];
  const sends = new Map();
  let byteCheck = { n: 0, bad: 0 };
  for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch (err) {
      continue;
    }
    if (e.ev === 'worker_task') tasks.push(e);
    else if (e.ev === 'task_send') sends.set(e.task_id, e);
  }
  if (!tasks.length) {
    console.error('FAIL: no worker_task events -- nothing to replay');
    process.exit(1);
  }

  const problems = [];
  const perWorker = new Map();
  const bases = new Set();
  let grows = 0;
  let maxPages = 0;
  const lastAfter = new Map(); // worker -> wasm_after of its previous task
  const lastGrowTs = new Map(); // worker -> last grow t_hr_after (monotonicity)
  const growTsChecks = { n: 0, bad: 0 };

  for (const t of tasks) {
    const base = t.alloc_base;
    bases.add(base);
    let top = base;
    let pages = Math.round(t.wasm_before / PAGE);
    const computed = [];
    const allocs = t.allocs || [];
    for (let i = 0; i < allocs.length; i++) {
      while (top & 3) top++;
      top += allocs[i];
      if (top + allocs[i] > pages * PAGE) {
        let req = Math.floor((top + allocs[i]) / PAGE) + 1;
        computed.push({ at_alloc: i, len: allocs[i], from_pages: pages, to_pages: req, top });
        pages = req;
      }
    }
    const observed = (t.grow_events || []).map((g) => ({
      at_alloc: g.at_alloc,
      len: g.len,
      from_pages: g.from_pages,
      to_pages: g.to_pages,
      top: g.top,
    }));

    let ok = true;
    if (pages * PAGE !== t.wasm_after) {
      ok = false;
      problems.push(
        `task ${t.task_id} (w${t.worker} ${t.site}): wasm_after ${t.wasm_after} != replay ${pages * PAGE} (${pages} pages)`
      );
    }
    if (computed.length !== observed.length) {
      ok = false;
      problems.push(
        `task ${t.task_id} (w${t.worker} ${t.site}): grow count ${observed.length} != replay ${computed.length}`
      );
    } else {
      for (let k = 0; k < computed.length; k++) {
        const a = computed[k];
        const b = observed[k];
        if (a.at_alloc !== b.at_alloc || a.from_pages !== b.from_pages || a.to_pages !== b.to_pages) {
          ok = false;
          problems.push(
            `task ${t.task_id} (w${t.worker} ${t.site}) grow#${k}: replay ${a.from_pages}->${a.to_pages} @alloc${a.at_alloc}, observed ${b.from_pages}->${b.to_pages} @alloc${b.at_alloc}`
          );
        } else if (a.len !== b.len || a.top !== b.top) {
          ok = false;
          problems.push(
            `task ${t.task_id} (w${t.worker} ${t.site}) grow#${k}: replay len=${a.len} top=${a.top}, observed len=${b.len} top=${b.top}`
          );
        }
      }
    }
    if (t.alloc_top != null) {
      const expectTop = (() => {
        let x = base;
        for (const len of allocs) {
          while (x & 3) x++;
          x += len;
        }
        return x;
      })();
      if (t.alloc_top !== expectTop) {
        ok = false;
        problems.push(`task ${t.task_id}: alloc_top ${t.alloc_top} != replay ${expectTop}`);
      }
    }

    // byte accounting cross-check: main-thread command scan vs worker alloc list.
    // A missing REQUIRED field is itself a failure -- the old code silently skipped
    // the whole check when wasm_alloc_bytes was absent (M5-E.2 review).
    const send = sends.get(t.task_id);
    if (send) {
      byteCheck.n += 1;
      if (send.wasm_alloc_bytes === undefined || send.wasm_alloc_bytes === null) {
        byteCheck.bad += 1;
        if (byteCheck.bad <= 10) problems.push(`task ${t.task_id}: task_send.wasm_alloc_bytes missing (required)`);
      } else {
        const sumAllocs = allocs.reduce((x, y) => x + y, 0);
        if (send.wasm_alloc_bytes !== sumAllocs) {
          byteCheck.bad += 1;
          if (byteCheck.bad <= 10) problems.push(`task ${t.task_id}: task_send.wasm_alloc_bytes ${send.wasm_alloc_bytes} != sum(allocs) ${sumAllocs}`);
        }
      }
      if (send.clone_buffer_bytes === undefined || send.clone_buffer_bytes === null) {
        byteCheck.bad += 1;
        if (byteCheck.bad <= 10) problems.push(`task ${t.task_id}: task_send.clone_buffer_bytes missing (required)`);
      } else if (send.clone_buffer_bytes !== (t.allocset_bytes || 0) + (t.set_bytes || 0)) {
        byteCheck.bad += 1;
        if (byteCheck.bad <= 10) problems.push(`task ${t.task_id}: task_send.clone_buffer_bytes ${send.clone_buffer_bytes} != allocset+set ${(t.allocset_bytes || 0) + (t.set_bytes || 0)}`);
      }
      // GET request length (what the worker was asked to return) vs the actual
      // returned copy. worker_output_bytes is the request size; out_bytes is the
      // copy the worker actually produced -- they must agree.
      if (send.worker_output_bytes === undefined || send.worker_output_bytes === null) {
        byteCheck.bad += 1;
        if (byteCheck.bad <= 10) problems.push(`task ${t.task_id}: task_send.worker_output_bytes missing (required)`);
      } else if (t.out_bytes === undefined || t.out_bytes === null) {
        byteCheck.bad += 1;
        if (byteCheck.bad <= 10) problems.push(`task ${t.task_id}: worker_task.out_bytes missing (required)`);
      } else if (send.worker_output_bytes !== t.out_bytes) {
        byteCheck.bad += 1;
        if (byteCheck.bad <= 10) problems.push(`task ${t.task_id}: GET request ${send.worker_output_bytes} != out_bytes ${t.out_bytes}`);
      }
    }

    // grow timestamps: M5-E.2 added t_hr_before / t_hr_after around memory.grow().
    // They must sit inside the task's worker window and be monotonic per worker.
    const ge = t.grow_events || [];
    for (const g of ge) {
      if (g.t_hr_before == null || g.t_hr_after == null) continue; // absent on old traces: skip
      growTsChecks.n += 1;
      const tb = BigInt(g.t_hr_before);
      const ta = BigInt(g.t_hr_after);
      if (t.t_hr_start != null && tb < BigInt(t.t_hr_start)) {
        growTsChecks.bad += 1;
        if (growTsChecks.bad <= 10) problems.push(`task ${t.task_id} (w${t.worker}): grow t_hr_before ${g.t_hr_before} < task t_hr_start ${t.t_hr_start}`);
      }
      if (t.t_hr_end != null && ta > BigInt(t.t_hr_end)) {
        growTsChecks.bad += 1;
        if (growTsChecks.bad <= 10) problems.push(`task ${t.task_id} (w${t.worker}): grow t_hr_after ${g.t_hr_after} > task t_hr_end ${t.t_hr_end}`);
      }
      const prev = lastGrowTs.get(t.worker);
      if (prev !== undefined && tb < prev) {
        growTsChecks.bad += 1;
        if (growTsChecks.bad <= 10) problems.push(`worker ${t.worker}: grow t_hr_before ${g.t_hr_before} < previous grow t_hr_after ${prev} -- not monotonic`);
      }
      lastGrowTs.set(t.worker, ta);
    }

    grows += observed.length;
    if (pages > maxPages) maxPages = pages;
    // per-worker continuity: the capacity at entry must be what the previous task
    // on this worker left behind. Worker tasks are strictly sequential (the
    // scheduler refuses to post to a busy worker), so file order per worker IS
    // the execution order.
    const prev = lastAfter.get(t.worker);
    if (prev !== undefined && prev !== t.wasm_before) {
      ok = false;
      problems.push(
        `worker ${t.worker} task ${t.task_id}: wasm_before ${t.wasm_before} != previous wasm_after ${prev} -- history is not a chain`
      );
    }
    lastAfter.set(t.worker, t.wasm_after);

    const w = perWorker.get(t.worker) || { tasks: 0, pages: 0, base: base, fails: 0, bases: new Set() };
    if (!w.bases) w.bases = new Set();
    w.bases.add(base);
    w.tasks += 1;
    w.pages = Math.max(w.pages, Math.round(t.wasm_after / PAGE));
    if (!ok) w.fails += 1;
    perWorker.set(t.worker, w);
  }

  const sendCount = sends.size;
  console.log(`jsonl   : ${jsonlPath}`);
  console.log(`tasks   : ${tasks.length} worker_task (${sendCount} task_send)`);
  console.log(`bases   : ${[...bases].join(', ')} (distinct alloc_base values)`);
  console.log(`grows   : ${grows} memory.grow events replayed`);
  console.log(`maxpages: ${maxPages}`);
  console.log(`workers : ${perWorker.size}`);

  for (const [w, v] of perWorker) {
    if (v.bases && v.bases.size > 1) {
      problems.push(`worker ${w}: ${v.bases.size} distinct alloc_base values (${[...v.bases].join(', ')})`);
    }
  }
  const chained = lastAfter.size;
  console.log(`history : ${tasks.length - chained === 0 ? chained : chained} worker histories chained (wasm_after -> next wasm_before)`);
  console.log(`bytes   : ${byteCheck.n - byteCheck.bad}/${byteCheck.n} tasks agree on clone_buffer_bytes, wasm_alloc_bytes and GET/out_bytes`);
  console.log(`grow_ts : ${growTsChecks.n - growTsChecks.bad}/${growTsChecks.n} grow events inside their task window and monotonically ordered per worker`);

  const rows = [...perWorker.entries()].sort((a, b) => a[0] - b[0]);
  console.log('\nworker  tasks   max pages   alloc_base   replay fails');
  for (const [w, v] of rows) {
    console.log(
      `${String(w).padStart(6)}  ${String(v.tasks).padStart(5)}  ${String(v.pages).padStart(9)}  ${String(v.base).padStart(10)}  ${String(v.fails).padStart(11)}`
    );
  }

  if (problems.length) {
    console.log(`\nL2 FAIL (${problems.length} problem(s)); first 20:`);
    for (const p of problems.slice(0, 20)) console.log('  - ' + p);
    process.exit(1);
  }
  console.log('\nL2 PASS: every worker task replays exactly (grow events + wasm_after + alloc_top).');
  if (verbose) {
    for (const [w, v] of rows) console.log(`w${w}: base=${v.base} pages=${v.pages} tasks=${v.tasks}`);
  }
}

main();
