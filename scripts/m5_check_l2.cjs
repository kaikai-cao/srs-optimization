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
        computed.push({ at_alloc: i, len: allocs[i], from_pages: pages, to_pages: req });
        pages = req;
      }
    }
    const observed = (t.grow_events || []).map((g) => ({
      at_alloc: g.at_alloc,
      len: g.len,
      from_pages: g.from_pages,
      to_pages: g.to_pages,
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
        }
      }
    }
    if (t.alloc_top !== undefined && t.alloc_top !== undefined) {
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

    grows += observed.length;
    if (pages > maxPages) maxPages = pages;
    const w = perWorker.get(t.worker) || { tasks: 0, pages: 0, base: base, fails: 0 };
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
