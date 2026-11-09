#!/usr/bin/env node
/**
 * M5-A static allocation ledger calculator (rev A.1).
 *
 * Does NOT instrument anything, does NOT monkey-patch a prototype, and never
 * launches snarkjs. It only re-derives, from the chunking arithmetic in
 * ffjavascript 0.3.1 / snarkjs 0.7.6, the buffer sizes that the library WILL
 * request, so that the M5 probe design has a falsifiable prediction.
 *
 * REV A.1 -- scalar width correction. Three MSM families must be kept apart,
 * because snarkjs feeds them different scalar widths:
 *
 *   processSection (phase 1)   scalars = getRandomBytes(4*(n-1))   ->  4 B
 *   verifyPower.resTau         buff_r  = new Uint32Array(nPoints)  ->  4 B
 *   verifyPower.resLagrange    buff_r  = BigBuffer(nPoints*Fr.n8)  -> 32 B
 *       (after batchToMontgomery -> fft -> batchFromMontgomery)
 *
 * The 18x bit-chunk amplification in the earlier draft applies ONLY to the
 * 32 B path. A 4 B path divides the scalar bit length by 8 and therefore
 * needs ~3 bit-chunks, not ~18.
 *
 * Transcribed constants (verify against the installed tree):
 *   ffjavascript/src/threadman.js:21             MEM_SIZE  = 25 pages (1.6 MiB)
 *   ffjavascript/src/threadman.js:104-119        concurrency = min(os.cpus(),64)
 *   ffjavascript/src/threadman_thread.js:4       MAXMEM    = 32767 pages (2 GiB)
 *   ffjavascript/src/threadman_thread.js:44-56   alloc() growth rule (top+len)
 *   ffjavascript/src/engine_multiexp.js:3-8      pTSizes[]
 *   ffjavascript/src/engine_multiexp.js:112-137  sScalar, bitChunk, chunkSize
 *   ffjavascript/src/engine_fft.js:13,109-115    MAX_BITS_THREAD=14, split loop
 *   ffjavascript/src/bigbuffer.js:2              PAGE_SIZE = 1 GiB
 *   snarkjs/src/powersoftau_verify.js:340-396    processSection (4 B scalars)
 *   snarkjs/src/powersoftau_verify.js:421-490    verifyPower (4 B then 32 B)
 *
 * Assumption that is NOT verified and must be measured in M5-B:
 *   the worker allocator pointer u32[0] after module init is taken as 0.
 *   A non-zero static-data offset only pushes capacities up by whole pages.
 *
 * Usage:
 *   node scripts/m5_budget.cjs --power 18 --operation prepared_verify
 *   node scripts/m5_budget.cjs --power 18 --operation phase1
 *   node scripts/m5_budget.cjs --power 18 --operation prepare_phase2
 *   node scripts/m5_budget.cjs --power 18 --operation prepared_verify --json
 */

'use strict';

const os = require('os');

// ---- constants transcribed from the installed tree -------------------------
const MEM_SIZE_PAGES = 25;
const MAXMEM_PAGES = 32767;
const PAGE_BYTES = 65536;
const MAX_CHUNK_SIZE = 1 << 22; // engine_multiexp.js:92
const MIN_CHUNK_SIZE = 1 << 10; // engine_multiexp.js:93
const PHASE1_CHUNK = 1 << 16; // powersoftau_verify.js:341 MAX_CHUNK_SIZE
const MAX_BITS_THREAD = 14; // engine_fft.js:13
const PTSIZES = [
  1, 1, 1, 1, 2, 3, 4, 5,
  6, 7, 7, 8, 9, 10, 11, 12,
  13, 13, 14, 15, 16, 16, 17, 17,
  17, 17, 17, 17, 17, 17, 17, 17,
];

// BLS12-381 sizes
const S = { G1aff: 96, G1jac: 144, G2aff: 192, G2jac: 288, Fr: 32 };
const SCALAR_4B = 4; // polyfill scalar width used by snarkjs in two places
// Allocator base offset, MEASURED (M5-C: identical on all 10,084 tasks at p10 and
// on every task at p16/p18). HYP-1 assumed 0; that was wrong by 102 KiB, which is
// enough to move whole pages in the zero-tolerance L2 replay.
const ALLOC_BASE_MEASURED = 102328;
const SCALAR_FR = 32;

const MiB = (b) => b / 1048576;
const f1 = (x) => Math.round(x * 10) / 10;
const f2 = (x) => Math.round(x * 100) / 100;

function log2floor(v) {
  let x = v;
  return (
    ((x & 0xffff0000) !== 0 ? ((x &= 0xffff0000), 16) : 0) |
    ((x & 0xff00ff00) !== 0 ? ((x &= 0xff00ff00), 8) : 0) |
    ((x & 0xf0f0f0f0) !== 0 ? ((x &= 0xf0f0f0f0), 4) : 0) |
    ((x & 0xcccccccc) !== 0 ? ((x &= 0xcccccccc), 2) : 0) |
    ((x & 0xaaaaaaaa) !== 0)
  );
}

/**
 * Replays threadman_thread.js alloc() for one task.
 * `allocs` are the byte lengths passed, in order, by ALLOC/ALLOCSET.
 */
function replayWorkerMemory(allocs, baseBytes = ALLOC_BASE_MEASURED, initialPages = MEM_SIZE_PAGES) {
  let top = baseBytes; // measured, not assumed: every worker reports 102328 B
  let bytes = initialPages * PAGE_BYTES;
  let grows = 0;
  const trace = [];
  for (const len of allocs) {
    while (top & 3) top++;
    top += len;
    // threadman_thread.js:49 -- the condition adds `length` a SECOND time on top
    // of the already-incremented top, so the memory must fit top + len.
    if (top + len > bytes) {
      let reqPages = Math.floor((top + len) / PAGE_BYTES) + 1;
      if (reqPages > MAXMEM_PAGES) reqPages = MAXMEM_PAGES;
      bytes = reqPages * PAGE_BYTES;
      grows++;
      trace.push({ event: 'grow', toBytes: bytes });
    }
  }
  return { bytes, top, grows, trace };
}


/** phase 1: the four processSection() calls before phase 2 begins
 *
 * NOTE (M5-B): this ledger used to size each section in isolation with the OUTER
 * bit-chunk count, which produced task counts that the probe does not reproduce
 * (_multiExpChunk recomputes bitChunkSize from the chunk size -- see msmTasks).
 * The per-section numbers now come from the sequential plan (phase1RowsFromPlan);
 * verifyPowerLedger is likewise replaced by powerRowsFromPlan so that G2 and every
 * power actually executed are covered, not just the largest G1 tier.
 */

/** Per-section phase-1 rows taken from the sequential plan (single source of truth). */
function phase1RowsFromPlan(plan) {
  const names = [];
  for (const c of plan.calls) {
    if (!c.site.startsWith('phase1.')) continue;
    const name = c.site.split('.')[1];
    if (!names.includes(name)) names.push(name);
  }
  return names.map((name) => {
    const batch = callsMatching(plan, `phase1.${name}.batchLEMtoU`);
    const msms = callsMatching(plan, `phase1.${name}.bases0`);
    const exit = lastCall(plan, `phase1.${name}.`);
    const worst = msms.reduce((a, b) => (b.perTaskWasmMax > a.perTaskWasmMax ? b : a));
    const nPerChunk = msms.length ? msms[0].taskCount : 0;
    return {
      name,
      group: worst.group,
      nPoints: batch.reduce((a, b) => a + b.nPoints, 0),
      nChunks: batch.length,
      msmPoints: worst.nPoints,
      chunkPts: worst.chunkPts,
      bitChunkSize: worst.bitChunk,
      innerBitChunks: worst.chunkPts ? worst.chunkPts.map((p) => PTSIZES[log2floor(p)]) : [],
      nBitChunks: worst.nBit,
      nPointChunks: worst.chunkPts ? worst.chunkPts.length : 0,
      taskCount: nPerChunk,
      perTaskWasmMax: worst.perTaskWasmMax,
      perTaskCloneMax: worst.perTaskCloneMax,
      wave1CloneBytes: worst.wave1CloneBytes,
      wave1WasmBytes: worst.wave1WasmBytes,
      maxWorkerPages: Math.max(...exit.workerPagesAfter),
      sectionPoolPages: exit.poolPagesAfter,
      grewWorkersInRun: exit.grewWorkers,
    };
  });
}

/** Per-power rows of one phase-2 section from the plan (G1 or G2, every power). */
function powerRowsFromPlan(plan, sectionName, phase) {
  const rows = [];
  for (const c of plan.calls) {
    const m = c.site.match(new RegExp(`^${sectionName}\\.p(\\d+)\\.${phase}$`));
    if (m) rows.push(Object.assign({ power: Number(m[1]) }, c));
  }
  return rows;
}

/** engine_fft.js _fft (mix + join), single non-extended transform */
function fftLedger(nPoints, concurrency, sIn, sMid, sOut) {
  const bits = log2floor(nPoints);
  let pointsInChunk = Math.min(1 << MAX_BITS_THREAD, nPoints);
  let nChunks = nPoints / pointsInChunk;
  while (nChunks < concurrency && pointsInChunk >= 16) {
    nChunks *= 2;
    pointsInChunk /= 2;
  }
  const l2Chunk = log2floor(pointsInChunk);

  const inputCopyBytes = nPoints * sIn;
  const reverseBitsAllocs = Math.floor(nPoints / 2) * 2;

  const mixTask = {
    sendBytes: pointsInChunk * sIn,
    recvBytes: pointsInChunk * (l2Chunk === bits ? sOut : sMid),
    workerMemBytes: replayWorkerMemory([pointsInChunk * sMid]).bytes,
  };
  const mixTasks = [];
  for (let i = 0; i < nChunks; i++) mixTasks.push(mixTask);

  let joinTasks = 0;
  let joinSend = 0;
  let joinRecv = 0;
  let joinWorkerMemMax = 0;
  for (let i = l2Chunk + 1; i <= bits; i++) {
    const nGroups = 1 << (bits - i);
    const nChunksPerGroup = nChunks / nGroups;
    const perWave = nGroups * (nChunksPerGroup / 2);
    joinTasks += perWave;
    joinSend += perWave * 2 * pointsInChunk * sMid;
    joinRecv += perWave * 2 * pointsInChunk * (i === bits ? sOut : sMid);
    const mem = replayWorkerMemory([pointsInChunk * sMid, pointsInChunk * sMid]).bytes;
    if (mem > joinWorkerMemMax) joinWorkerMemMax = mem;
  }

  const totalSend = mixTasks.reduce((a, t) => a + t.sendBytes, 0) + joinSend;
  const totalRecv = mixTasks.reduce((a, t) => a + t.recvBytes, 0) + joinRecv;
  const perWorkerMax = Math.max(mixTask.workerMemBytes, joinWorkerMemMax);
  const workerMem = Math.min(concurrency, nChunks) * perWorkerMax;

  const joinWavePeak = Math.min(concurrency, nChunks / 2) * 2 * pointsInChunk * sMid;
  const inflightPeak = Math.max(
    Math.min(concurrency, nChunks) * mixTask.sendBytes,
    joinWavePeak
  );

  const chunkBytes = nChunks * pointsInChunk * sMid;
  const outBytes = nPoints * sOut;

  return {
    kind: 'fft',
    nPoints,
    bits,
    pointsInChunk,
    nChunks,
    l2Chunk,
    mixTasks: nChunks,
    joinTasks,
    inputCopyBytes,
    reverseBitsAllocs,
    totalSendBytes: totalSend,
    totalRecvBytes: totalRecv,
    inflightPeakBytes: inflightPeak,
    workerMemBytes: workerMem,
    assemblyChunksBytes: chunkBytes,
    assemblyOutBytes: outBytes,
    assemblyPeakBytes: Math.min(inputCopyBytes + chunkBytes + outBytes, 2 ** 53),
  };
}

/**
 * engine_batchconvert.js:23-32 -- one task per chunk, and EVERY task does
 * TWO allocations: ALLOCSET var0 (buffChunk, n*sIn) then ALLOC var1 (n*sOut).
 * Fr.batchToMontgomery / batchFromMontgomery are built with sIn = sOut = n8 (32).
 * The two allocations are what pushes a clean 25-page worker to 28 pages at
 * 2^19 points, purely because alloc() demands top + length (F4).
 */
function batchConvertLedger(nPoints, concurrency, sIn, sOut) {
  const pointsPerChunk = Math.floor(nPoints / concurrency);
  const chunks = [];
  for (let i = 0; i < concurrency; i++) {
    const n = i < concurrency - 1 ? pointsPerChunk : nPoints - i * pointsPerChunk;
    if (n === 0) continue;
    const allocs = [n * sIn, n * sOut];
    const replay = replayWorkerMemory(allocs);
    chunks.push({
      points: n,
      allocs,
      top: replay.top,
      pages: replay.bytes / PAGE_BYTES,
      grows: replay.grows,
      memBytes: replay.bytes,
    });
  }
  const maxPages = Math.max(...chunks.map((c) => c.pages));
  const grownWorkers = chunks.filter((c) => c.grows > 0).length;
  const workerWasmBytes = chunks.reduce((a, c) => a + c.memBytes, 0);

  return {
    kind: 'batchConvert',
    nPoints,
    pointsPerChunk,
    sIn,
    sOut,
    taskCount: chunks.length,
    chunks,
    maxPages,
    grownWorkers,
    perChunkBytes: chunks[0].allocs[0] + chunks[0].allocs[1],
    workerWasmBytes,
    workerCapacityMiB: MiB(workerWasmBytes),
    // main-thread JS side: input BigBuffer survives the call; each chunk is copied
    // by BigBuffer.slice (span > page), each GET is a second copy, and the
    // assembled output is a third.
    mainThread: {
      inputBytes: nPoints * sIn,
      sliceCopyBytes: nPoints * sIn,
      recvBytes: nPoints * sOut,
      outBytes: nPoints * sOut,
      transientAddBytes: nPoints * sIn + 2 * nPoints * sOut,
      peakBytes: 2 * nPoints * sIn + 2 * nPoints * sOut,
    },
    // binding is a per-iteration question: this op runs AFTER resTau in the same
    // verifyPower iteration, so it only binds if it needs more pages than resTau left.
    callsPerPower: 2,
  };
}

// ---------------------------------------------------------------------------
// Sequential worker-pool model (rev A.3).
//
// The A.2 model sized every call in isolation and then summed "the 28 worst
// tasks". Two things are wrong with that as soon as you want per-worker pages:
//
//   1. Worker capacity is a HIGH-WATER MARK carried across calls (threadman_thread
//      .js:115-117 restores the allocator pointer but never shrinks memory), so a
//      later call cannot be charged for capacity an earlier call already paid for.
//   2. The task-to-worker map is not "sorted descending"; it is deterministic for
//      the first wave. queueAction() dispatches synchronously (threadman.js:200-215
//      -> processWorks() scans i = 0..C-1), and _multiExpChunk() enqueues all of
//      its bit-chunk tasks before the enclosing loop advances, so the first C tasks
//      in (point-chunk outer, bit-chunk inner) order land on workers 0..C-1.
//
// Late tasks (index >= C) are dispatched whenever a worker frees, which depends on
// runtime. Instead of guessing, we prove a sufficient condition: if the task's
// requirement at 25 pages is <= min(pages over all workers), then it cannot grow
// ANY worker and the pool total is independent of the dispatch order.
// ---------------------------------------------------------------------------

function newPool(concurrency, baseBytes = 0) {
  return { concurrency, base: baseBytes, pages: new Array(concurrency).fill(MEM_SIZE_PAGES) };
}

function poolPages(pool) {
  return pool.pages.reduce((a, b) => a + b, 0);
}

function poolMiB(pool) {
  return MiB(poolPages(pool) * PAGE_BYTES);
}

/** Replay one task on one worker. Returns the grow events actually taken. */
function replayOn(pool, worker, allocs, baseBytes) {
  let top = baseBytes === undefined ? pool.base || 0 : baseBytes;
  let pages = pool.pages[worker];
  const events = [];
  for (let i = 0; i < allocs.length; i++) {
    while (top & 3) top++;
    top += allocs[i];
    if (top + allocs[i] > pages * PAGE_BYTES) {
      let req = Math.floor((top + allocs[i]) / PAGE_BYTES) + 1;
      if (req > MAXMEM_PAGES) req = MAXMEM_PAGES;
      events.push({ at_alloc: i, from_pages: pages, to_pages: req });
      pages = req;
    }
  }
  pool.pages[worker] = pages;
  return events;
}

/** Pages a task needs on a pristine 25-page worker (alloc_base = 0). */
function pagesAtInit(allocs, baseBytes = 0) {
  const probe = { concurrency: 1, base: baseBytes, pages: [MEM_SIZE_PAGES] };
  replayOn(probe, 0, allocs);
  return probe.pages[0];
}

/**
 * Dispatch a task list. Tasks 0..C-1 go to workers 0..C-1; the rest are "late"
 * and are only charged if no worker could absorb them (see header).
 */
function dispatchTasks(pool, tasks) {
  const C = pool.concurrency;
  const delta = new Array(C).fill(0);
  const before = pool.pages.slice();
  const firstWave = Math.min(C, tasks.length);

  for (let w = 0; w < firstWave; w++) replayOn(pool, w, tasks[w].allocs);

  let lateMaxNeed = 0;
  let lateProvablyFree = true;
  const minAfterFirst = Math.min(...pool.pages);
  for (let i = C; i < tasks.length; i++) {
    const need = pagesAtInit(tasks[i].allocs, pool.base || 0);
    if (need > lateMaxNeed) lateMaxNeed = need;
    if (need > minAfterFirst) lateProvablyFree = false;
  }

  for (let w = 0; w < C; w++) delta[w] = pool.pages[w] - before[w];

  return {
    firstWave,
    lateTasks: Math.max(0, tasks.length - C),
    lateMaxNeedAtInit: lateMaxNeed,
    lateProvablyFree,
    deltaPages: delta.reduce((a, b) => a + b, 0),
    grewWorkers: delta.filter((d) => d > 0).length,
    wave1Pages: tasks.slice(0, C).map((t) => pagesAtInit(t.allocs, pool.base || 0)),
    workerPages: pool.pages.slice(),
  };
}

function msmTasks(nPoints, sG, sScalar, jacBytes, concurrency) {
  const bitChunkSize = PTSIZES[log2floor(nPoints)];
  const nBitChunks = Math.floor((sScalar * 8 - 1) / bitChunkSize) + 1;
  let chunkSize = Math.floor(nPoints / (concurrency / nBitChunks));
  if (chunkSize > MAX_CHUNK_SIZE) chunkSize = MAX_CHUNK_SIZE;
  if (chunkSize < MIN_CHUNK_SIZE) chunkSize = MIN_CHUNK_SIZE;

  const chunkPts = [];
  for (let i = 0; i < nPoints; i += chunkSize) chunkPts.push(Math.min(nPoints - i, chunkSize));

  // engine_multiexp.js:53-54 recomputes bitChunkSize INSIDE _multiExpChunk from
  // the CHUNK size, not from the whole buffer. The two differ whenever the
  // chunk size crosses a power of two (e.g. 2^11 points clamped to 2 x 2^10:
  // outer pTSizes[11]=8 -> 4 bit-chunks, inner pTSizes[10]=7 -> 5 bit-chunks).
  // The task count follows the INNER value; only `chunkSize` uses the outer one.
  const nBitByChunk = [];
  const tasks = [];
  for (const pts of chunkPts) {
    const bc = PTSIZES[log2floor(pts)];
    const nb = Math.floor((sScalar * 8 - 1) / bc) + 1;
    nBitByChunk.push({ points: pts, bit_chunk: bc, n_bit: nb });
    // Command shapes (engine_multiexp.js):
    //   ALLOCSET bases, ALLOCSET scalars, ALLOC jac, CALLs, GET jac
    // clone = bases + scalars (structured clone), alloc = all three (WASM),
    // get = jac (the worker hands the group element back).
    const allocs = [pts * sG, pts * sScalar, jacBytes];
    const bytes = { clone: pts * sG + pts * sScalar, alloc: pts * sG + pts * sScalar + jacBytes, get: jacBytes };
    for (let b = 0; b < nb; b++) tasks.push({ pts, allocs, bytes });
  }
  return { bitChunkSize, nBitChunks, chunkSize, chunkPts, nBitByChunk, tasks };
}

function batchTasks(nPoints, concurrency, sIn, sOut) {
  const per = Math.floor(nPoints / concurrency);
  const tasks = [];
  for (let i = 0; i < concurrency; i++) {
    const n = i < concurrency - 1 ? per : nPoints - i * per;
    if (n === 0) continue;
    // ALLOCSET in (clone + alloc), ALLOC out (alloc), GET out.
    tasks.push({
      pts: n,
      allocs: [n * sIn, n * sOut],
      bytes: { clone: n * sIn, alloc: n * sIn + n * sOut, get: n * sOut },
    });
  }
  return tasks;
}

/**
 * FFT tasks: nChunks mix tasks, then (bits - l2Chunk) join levels of nChunks/2
 * tasks each (engine_fft.js:5241-5300, nGroups * nChunksPerGroup / 2 == nChunks/2).
 *
 * The previous model counted only the mix phase, so every fft call with
 * bits > l2Chunk under-reported its task count by 2-4x (p4: 2 vs 3, p8: 32 vs
 * 112). That is why L1 had to skip fft in the task-count comparison; it no
 * longer needs to.
 */
function fftTasks(nPoints, concurrency, sMid, sIn, sOut) {
  let pointsInChunk = Math.min(1 << MAX_BITS_THREAD, nPoints);
  let nChunks = nPoints / pointsInChunk;
  while (nChunks < concurrency && pointsInChunk >= 16) {
    nChunks *= 2;
    pointsInChunk /= 2;
  }
  const bits = log2floor(nPoints);
  const l2Chunk = log2floor(pointsInChunk);
  const tasks = [];

  // mix: ALLOC var0 (sMid), SET var0 (sIn), CALLs, GET (sOut when this is the
  // last level, sMid otherwise)
  const mixGet = l2Chunk === bits ? sOut : sMid;
  for (let i = 0; i < nChunks; i++) {
    tasks.push({
      pts: pointsInChunk,
      allocs: [pointsInChunk * sMid],
      bytes: { clone: pointsInChunk * sIn, alloc: pointsInChunk * sMid, get: pointsInChunk * mixGet },
    });
  }

  // join: ALLOCSET x2 (sMid) + ALLOCSET first/inc (Fr.n8 x2), then GET x2 (sOut
  // on the last level, sMid otherwise). No ALLOC, but allocBuffer() allocates.
  const joinGet = sOut;
  const joinMid = sMid * 2 + 2 * S.Fr;
  for (let lvl = l2Chunk + 1; lvl <= bits; lvl++) {
    const nTasksThisLevel = nChunks / 2;
    for (let k = 0; k < nTasksThisLevel; k++) {
      const get = pointsInChunk * (lvl === bits ? joinGet : sMid) * 2;
      tasks.push({
        pts: pointsInChunk * 2,
        allocs: [pointsInChunk * sMid, pointsInChunk * sMid, S.Fr, S.Fr],
        bytes: { clone: joinMid, alloc: joinMid, get },
      });
    }
  }
  return { pointsInChunk, nChunks, bits, l2Chunk, tasks };
}

/** One instrumented emission: run the call, record pool state before/after. */
function emit(pool, call) {
  const beforePages = poolPages(pool);
  const workerPagesBefore = pool.pages.slice();
  // Three distinct quantities per task (M5-E.1):
  //   clone -> structured-clone'd into the worker message (main-thread buffers)
  //   alloc -> reserved in the worker's WASM linear memory
  //   get   -> handed back by the worker (GET request size; real copy = out_bytes)
  const clone = call.tasks.map((t) => t.bytes.clone);
  const alloc = call.tasks.map((t) => t.bytes.alloc);
  const getB = call.tasks.map((t) => t.bytes.get);
  const wave1Clone = clone.slice(0, pool.concurrency);
  const wave1Alloc = alloc.slice(0, pool.concurrency);
  const wave1Get = getB.slice(0, pool.concurrency);
  const d = dispatchTasks(pool, call.tasks);
  return Object.assign({}, call, {
    taskCount: call.tasks.length,
    perTaskCloneMax: clone.length ? Math.max(...clone) : 0,
    perTaskWasmMax: alloc.length ? Math.max(...alloc) : 0,
    wave1CloneBytes: wave1Clone.reduce((a, b) => a + b, 0),
    wave1WasmBytes: wave1Alloc.reduce((a, b) => a + b, 0),
    wave1GetBytes: wave1Get.reduce((a, b) => a + b, 0),
    wave1Pages: d.wave1Pages,
    lateTasks: d.lateTasks,
    lateMaxNeedAtInit: d.lateMaxNeedAtInit,
    lateProvablyFree: d.lateProvablyFree,
    deltaPages: d.deltaPages,
    grewWorkers: d.grewWorkers,
    workerPagesBefore,
    workerPagesAfter: pool.pages.slice(),
    poolPagesBefore: beforePages,
    poolPagesAfter: poolPages(pool),
    poolMiBAfter: f1(poolMiB(pool)),
    tasks: undefined,
  });
}

/** All emitted calls whose site starts with `prefix`, in execution order. */
function callsMatching(plan, prefix) {
  return plan.calls.filter((c) => c.site.startsWith(prefix));
}

/** Last call of a section group -- its pool snapshot is the section's exit state. */
function lastCall(plan, prefix) {
  const m = callsMatching(plan, prefix);
  return m.length ? m[m.length - 1] : null;
}

function phase1Sections(power) {
  return [
    { name: 'tauG1', group: 'G1', sG: S.G1aff, jac: S.G1jac, nPoints: 2 ** power * 2 - 1 },
    { name: 'tauG2', group: 'G2', sG: S.G2aff, jac: S.G2jac, nPoints: 2 ** power },
    { name: 'alphatauG1', group: 'G1', sG: S.G1aff, jac: S.G1jac, nPoints: 2 ** power },
    { name: 'betatauG1', group: 'G1', sG: S.G1aff, jac: S.G1jac, nPoints: 2 ** power },
  ];
}

const PHASE2_SECTIONS = (power) => [
  { name: 'tauG1', group: 'G1', sG: S.G1aff, jac: S.G1jac, extra: true },
  { name: 'tauG2', group: 'G2', sG: S.G2aff, jac: S.G2jac, extra: false },
  { name: 'alphaTauG1', group: 'G1', sG: S.G1aff, jac: S.G1jac, extra: false },
  { name: 'betaTauG1', group: 'G1', sG: S.G1aff, jac: S.G1jac, extra: false },
];

/**
 * Full plan for `snarkjs powersoftau verify <fixture>` at this power, in the exact
 * order the code executes it. This is the L1 oracle: every field except the pool
 * columns must match the probe byte for byte.
 */
function buildPlan(power, concurrency, baseBytes = 0) {
  const pool = newPool(concurrency, baseBytes);
  const calls = [];

  // ---- phase 1: processSection, 4 B scalars, two MSMs per 64 Ki chunk --------
  for (const sec of phase1Sections(power)) {
    for (let i = 0; i < sec.nPoints; i += PHASE1_CHUNK) {
      const n = Math.min(sec.nPoints - i, PHASE1_CHUNK);
      calls.push(emit(pool, {
        site: `phase1.${sec.name}.batchLEMtoU`, kind: 'batch', group: sec.group,
        nPoints: n, sIn: sec.sG, sOut: sec.sG,
        tasks: batchTasks(n, concurrency, sec.sG, sec.sG),
      }));
      for (const tag of ['bases0', 'bases1']) {
        const m = msmTasks(n - 1, sec.sG, SCALAR_4B, sec.jac, concurrency);
        calls.push(emit(pool, {
          site: `phase1.${sec.name}.${tag}`, kind: 'msm', group: sec.group,
          nPoints: n - 1, sScalar: SCALAR_4B, sG: sec.sG, jac: sec.jac,
          bitChunk: m.bitChunkSize, nBit: m.nBitChunks, chunkSize: m.chunkSize,
          chunkPts: m.chunkPts, tasks: m.tasks,
        }));
      }
    }
  }
  const poolAtPhase2 = poolPages(pool);

  // ---- phase 2: verifyLagrangeEvaluations, 4 sections ------------------------
  for (const sec of PHASE2_SECTIONS(power)) {
    const pMax = power + (sec.extra ? 1 : 0);
    for (let p = 0; p <= pMax; p++) {
      const nPoints = 2 ** p;

      const tau = msmTasks(nPoints, sec.sG, SCALAR_4B, sec.jac, concurrency);
      calls.push(emit(pool, {
        site: `${sec.name}.p${p}.resTau`, kind: 'msm', group: sec.group, p,
        nPoints, sScalar: SCALAR_4B, sG: sec.sG, jac: sec.jac,
        bitChunk: tau.bitChunkSize, nBit: tau.nBitChunks, chunkSize: tau.chunkSize,
        chunkPts: tau.chunkPts, tasks: tau.tasks,
      }));

      for (const op of ['batchTo', 'fft', 'batchFrom']) {
        if (op === 'fft') {
          const f = fftTasks(nPoints, concurrency, S.Fr, S.Fr, S.Fr);
          calls.push(emit(pool, {
            site: `${sec.name}.p${p}.fft`, kind: 'fft', group: 'Fr', p, nPoints,
            pointsInChunk: f.pointsInChunk, nChunks: f.nChunks, sMid: S.Fr,
            tasks: f.tasks,
          }));
        } else {
          calls.push(emit(pool, {
            site: `${sec.name}.p${p}.${op}Montgomery`, kind: 'batch', group: 'Fr', p,
            nPoints, sIn: S.Fr, sOut: S.Fr,
            tasks: batchTasks(nPoints, concurrency, S.Fr, S.Fr),
          }));
        }
      }

      const lag = msmTasks(nPoints, sec.sG, SCALAR_FR, sec.jac, concurrency);
      calls.push(emit(pool, {
        site: `${sec.name}.p${p}.resLagrange`, kind: 'msm', group: sec.group, p,
        nPoints, sScalar: SCALAR_FR, sG: sec.sG, jac: sec.jac,
        bitChunk: lag.bitChunkSize, nBit: lag.nBitChunks, chunkSize: lag.chunkSize,
        chunkPts: lag.chunkPts, tasks: lag.tasks,
      }));
    }
  }

  return { power, concurrency, calls, poolAtPhase2, poolFinalPages: poolPages(pool) };
}

/**
 * The site string the probe will record for a plan call.
 *
 * The plan names calls after what they are (tauG1.p19.resLagrange); snarkjs names
 * them after the `loggerTxt` it passes down, and passes nothing at all in three
 * places. Comparing sites verbatim is therefore impossible -- and skipping the
 * comparison entirely (the pre-M5-E.1 behaviour) would let a G1/G2 swap or a
 * section mix-up pass L1 as long as the call geometry matched. So the mapping is
 * written down once, here, and asserted.
 *
 *   phase1.<sec>.bases0|bases1  -> "msm"            (multiExpAffine, no logger)
 *   phase1.<sec>.batchLEMtoU    -> "g1m_|g2m_batchLEMtoU"
 *   <sec>.p<N>.resTau           -> "<sec>_<N>"
 *   <sec>.p<N>.resLagrange      -> "<sec>_<N>_transformed"
 *   <sec>.p<N>.fft              -> "fft"            (_fft with loggerTxt undefined)
 *   <sec>.p<N>.batch[To|From]   -> "frm_batch[To|From]Montgomery"
 */
function probeSite(site, kind, group) {
  if (typeof site !== 'string') return null;
  if (site.startsWith('phase1.')) {
    if (/batchLEMtoU$/.test(site)) return (group === 'G2' ? 'g2m' : 'g1m') + '_batchLEMtoU';
    return 'msm';
  }
  if (kind === 'fft' || kind === 'fftjoinext') return 'fft';
  if (kind === 'batch') {
    if (/batchToMontgomery$/.test(site)) return 'frm_batchToMontgomery';
    if (/batchFromMontgomery$/.test(site)) return 'frm_batchFromMontgomery';
    return null;
  }
  const m = /^([A-Za-z0-9]+)\.p(\d+)\.(resTau|resLagrange)$/.exec(site);
  if (m) return m[1] + '_' + m[2] + (m[3] === 'resLagrange' ? '_transformed' : '');
  return null;
}

/** Pages a single call leaves on the pool, without touching a shared pool. */
function callInIsolation(call, concurrency, baseBytes = 0) {
  const pool = newPool(concurrency, baseBytes);
  dispatchTasks(pool, call.tasks);
  return { poolPages: poolPages(pool), poolMiB: f1(poolMiB(pool)) };
}

// ---- reporting -------------------------------------------------------------
function printPool(power, concurrency, baseBytes) {
  const plan = buildPlan(power, concurrency, baseBytes);
  console.log(`### per-worker capacity pool @ power ${power} (C=${concurrency})\n`);
  console.log('| site | kind | pts | tasks | wave1 pages (min..max) | late | delta pages | delta MiB | grew | pool MiB |');
  console.log('| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const c of plan.calls) {
    const w1 = c.wave1Pages || [];
    const w1txt = w1.length ? `${Math.min(...w1)}..${Math.max(...w1)}` : '—';
    if (c.deltaPages === 0 && c.kind === 'fft') continue; // keep the table readable
    console.log(
      `| ${c.site} | ${c.kind} | ${c.nPoints} | ${c.taskCount} | ${w1txt} | ${c.lateTasks}${c.lateProvablyFree ? '' : ' (!)'} | ${c.deltaPages} | ${f1(MiB(c.deltaPages * PAGE_BYTES))} | ${c.grewWorkers} | ${c.poolMiBAfter} |`
    );
  }
  console.log(`\nphase-1 baseline (pool at phase-2 start) = ${plan.poolAtPhase2} pages = ${f1(MiB(plan.poolAtPhase2 * PAGE_BYTES))} MiB`);
  console.log(`final pool = ${plan.poolFinalPages} pages = ${f1(MiB(plan.poolFinalPages * PAGE_BYTES))} MiB`);
  return plan;
}

function printSegments(power, concurrency, baseBytes) {
  const plan = buildPlan(power, concurrency, baseBytes);
  const find = (site) => plan.calls.find((c) => c.site === site);
  const last = (suffix) => [...plan.calls].reverse().find((c) => c.site.endsWith(suffix));
  const tauG1Start = find('tauG1.p0.resTau');
  const tauG1Lag = find(`tauG1.p${power + 1}.resLagrange`);
  const tauG2Start = find('tauG2.p0.resTau');
  const tauG2Lag = find(`tauG2.p${power}.resLagrange`);

  console.log(`### capacity segments @ power ${power} (C=${concurrency})\n`);
  console.log('| segment | pool pages before | pool pages after | delta MiB | pool MiB (after) |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  const seg = (label, a, b) => {
    const d = (b.poolPagesAfter - a.poolPagesBefore) * PAGE_BYTES;
    console.log(`| ${label} | ${a.poolPagesBefore} | ${b.poolPagesAfter} | ${f1(MiB(d))} | ${f1(MiB(b.poolPagesAfter * PAGE_BYTES))} |`);
  };
  seg('phase 1', plan.calls[0], plan.calls.find((c) => c.site.startsWith('tauG1.p0')));
  seg('tauG1 section (p0..p' + (power + 1) + ')', tauG1Start, tauG1Lag);
  seg('tauG2 section', tauG2Start, tauG2Lag);
  console.log(`\ntauG1 resLagrange@p${power + 1}: ${tauG1Lag.grewWorkers} workers grew, delta ${tauG1Lag.deltaPages} pages = ${f1(MiB(tauG1Lag.deltaPages * PAGE_BYTES))} MiB`);
  console.log(`  wave1 pages by worker: ${tauG1Lag.wave1Pages.join(',')}`);
  console.log(`tauG2 resLagrange@p${power}: ${tauG2Lag.grewWorkers} workers grew, delta ${tauG2Lag.deltaPages} pages = ${f1(MiB(tauG2Lag.deltaPages * PAGE_BYTES))} MiB`);
  console.log(`  wave1 pages by worker: ${tauG2Lag.wave1Pages.join(',')}`);
  const perWorker = tauG2Lag.workerPagesAfter.map((v, i) => v - tauG2Lag.workerPagesBefore[i]);
  console.log(`  per-worker delta: ${perWorker.filter((d) => d !== 0).join(',')}`);
  return plan;
}

function printPreparedVerify(power, concurrency, baseBytes = 0) {
  const plan = buildPlan(power, concurrency, baseBytes);
  const p1rows = phase1RowsFromPlan(plan);
  const fft = fftLedger(2 ** (power + 1), concurrency, S.Fr, S.Fr, S.Fr);
  const b = (n) => baseBytes; // readability alias for the cold-start replay
  void b;

  console.log(`### prepared_verify @ power ${power} (concurrency ${concurrency}, alloc base ${baseBytes} B)\n`);
  console.log('#### A. phase 1 -- processSection, 4 B scalars (powersoftau_verify.js:361)\n');
  console.log('| section | group | points | 64 Ki-chunks | MSM points | outer bitChunk | inner bit-chunks | point-chunks | tasks per 64 Ki | per-task (MiB) | in-flight (MiB) | worker pages (max) | pool after (pages) |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of p1rows) {
    console.log(
      `| ${r.name} | ${r.group} | ${r.nPoints} | ${r.nChunks} | ${r.msmPoints} | ${r.bitChunkSize} | ${r.innerBitChunks.join('/')} | ${r.nPointChunks} | ${r.taskCount} | ${f1(MiB(r.perTaskWasmMax))} | ${f1(MiB(r.wave1CloneBytes))} | ${r.maxWorkerPages} | ${r.sectionPoolPages} |`
    );
  }
  const pool1 = plan.poolAtPhase2;
  console.log(
    `\nphase-1 exit pool = ${pool1} pages = **${f1(MiB(pool1 * PAGE_BYTES))} MiB** (sequential high-water model, base ${baseBytes} B)\n`
  );

  const showPowers = (phase) => {
    const rows = [];
    for (const sec of ['tauG1', 'tauG2']) {
      for (const r of powerRowsFromPlan(plan, sec, phase)) {
        if (r.power >= power - 1) rows.push({ sec, r });
      }
    }
    return rows;
  };

  console.log('#### B. phase 2 -- resTau, 4 B scalars (powersoftau_verify.js:425,452) -- every group, largest powers\n');
  console.log('| section | group | p | points | bitChunk | bit-chunks | point-chunks | tasks | per-task (MiB) | in-flight (MiB) | cold-start pages | pool delta | grew |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const { sec, r } of showPowers('resTau')) {
    const cold = Math.max(...r.wave1Pages, r.lateMaxNeedAtInit || 0);
    console.log(
      `| ${sec} | ${r.group} | ${r.power} | ${r.nPoints} | ${r.bitChunk} | ${r.nBit} | ${(r.chunkPts || []).length} | ${r.taskCount} | ${f1(MiB(r.perTaskWasmMax))} | ${f1(MiB(r.wave1CloneBytes))} | ${cold} | ${r.deltaPages} | ${r.grewWorkers} |`
    );
  }
  console.log('');

  console.log('#### C. phase 2 -- resLagrange, 32 B scalars after fft (powersoftau_verify.js:454,482) -- every group, largest powers\n');
  console.log('| section | group | p | points | bitChunk | bit-chunks | point-chunks | tasks | per-task (MiB) | in-flight (MiB) | cold-start pages | pool delta | grew |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const { sec, r } of showPowers('resLagrange')) {
    const cold = Math.max(...r.wave1Pages, r.lateMaxNeedAtInit || 0);
    console.log(
      `| ${sec} | ${r.group} | ${r.power} | ${r.nPoints} | ${r.bitChunk} | ${r.nBit} | ${(r.chunkPts || []).length} | ${r.taskCount} | ${f1(MiB(r.perTaskWasmMax))} | ${f1(MiB(r.wave1CloneBytes))} | ${cold} | ${r.deltaPages} | ${r.grewWorkers} |`
    );
  }
  console.log('');

  console.log('#### D. Fr batchTo/FromMontgomery -- 32 B in/out, TWO allocations per chunk (engine_batchconvert.js:23-32)\n');
  console.log('| section | op | p | points | chunks | pts/chunk (last) | ALLOCSET (B) | ALLOC (B) | cold-start pages | pages before call | in-run pool delta | grew |');
  console.log('| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const sec of ['tauG1', 'tauG2']) {
    for (const op of ['batchToMontgomery', 'batchFromMontgomery']) {
      for (const r of powerRowsFromPlan(plan, sec, op)) {
        if (r.power < power - 1) continue;
        const lastPts = batchTasks(r.nPoints, concurrency, S.Fr, S.Fr).slice(-1)[0].pts;
        const cold = Math.max(...r.wave1Pages, r.lateMaxNeedAtInit || 0);
        const before = Math.min(...r.workerPagesBefore);
        console.log(
          `| ${sec} | ${op.replace('Montgomery', '')} | ${r.power} | ${r.nPoints} | ${r.taskCount} | ${r.perTaskCloneMax / S.Fr} (${lastPts}) | ${r.perTaskCloneMax} | ${r.perTaskWasmMax - r.perTaskCloneMax} | ${cold} | ${before} | ${r.deltaPages} | ${r.grewWorkers} |`
        );
      }
    }
  }
  console.log(
    '\nCold-start pages are the requirement on a pristine 25-page worker; "in-run pool delta" is what the same call\ncosts inside prepared_verify, where resTau already ran. M5-B/C read the second column from wasm_before/after.\n'
  );

  const bigLag = lastCall(plan, `tauG1.p${power + 1}.resLagrange`);
  const inc = bigLag ? bigLag.wave1CloneBytes : 0;
  console.log('#### E. tauG1 phase-2 segment increment (model, same window as M4.1)\n');
  console.log('| term | MiB |');
  console.log('| --- | ---: |');
  console.log(`| resLagrange in-flight | ${f1(MiB(inc))} |`);
  console.log(`| phase-1 exit pool (replaced by measurement) | ${f1(MiB(pool1 * PAGE_BYTES))} |`);
  console.log(`\nFr FFT @2^${power + 1}: ${fft.nChunks} chunks x ${fft.pointsInChunk} pts, in-flight ${f1(MiB(fft.inflightPeakBytes))} MiB, worker WASM ${f1(MiB(fft.workerMemBytes))} MiB, input copy ${f1(MiB(fft.inputCopyBytes))} MiB`);
  console.log('\nEvery column above is produced by one sequential replay of the real call order; the only free parameter\n' +
    'is the allocator base, which the probe measures (worker_task.alloc_base) rather than assumes.\n');

  return { power, concurrency, baseBytes, plan, rows: p1rows, fft, poolAtPhase2: pool1 };
}

function printBatchConvert(power, concurrency) {
  const rows = [batchConvertLedger(2 ** (power + 1), concurrency, S.Fr, S.Fr), batchConvertLedger(2 ** power, concurrency, S.Fr, S.Fr)];
  console.log(`### Fr batchconvert @ power ${power} (concurrency ${concurrency})\n`);
  console.log('| p | points | chunks | pts/chunk (last) | ALLOCSET (B) | ALLOC (B) | pages after | workers grown | worker WASM (MiB) |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of rows) {
    const c = r.chunks[0];
    console.log(
      `| ${log2floor(r.nPoints)} | ${r.nPoints} | ${r.taskCount} | ${r.pointsPerChunk} (${r.chunks[r.chunks.length - 1].points}) | ${c.allocs[0]} | ${c.allocs[1]} | ${r.maxPages} | ${r.grownWorkers} | ${f1(r.workerCapacityMiB)} |`
    );
  }
  console.log(`\nper-call main-thread bytes at 2^${power + 1}: input ${f1(MiB(rows[0].mainThread.inputBytes))} + slice copies ${f1(MiB(rows[0].mainThread.sliceCopyBytes))} + GET ${f1(MiB(rows[0].mainThread.recvBytes))} + out ${f1(MiB(rows[0].mainThread.outBytes))} MiB (transient add ${f1(MiB(rows[0].mainThread.transientAddBytes))} MiB)`);
  console.log('Two calls per verifyPower iteration (toMontgomery, fromMontgomery), sequential.');
  return rows;
}

function printPhase1(power, concurrency, baseBytes = 0) {
  const plan = buildPlan(power, concurrency, baseBytes);
  const rows = phase1RowsFromPlan(plan);
  console.log(`### phase 1 only @ power ${power} (concurrency ${concurrency}, alloc base ${baseBytes} B)\n`);
  console.log('| section | group | points | 64 Ki-chunks | MSM points | outer bitChunk | inner bit-chunks | point-chunks | tasks per 64 Ki | per-task (MiB) | in-flight (MiB) | worker pages (max) | pool after (pages) |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of rows) {
    console.log(
      `| ${r.name} | ${r.group} | ${r.nPoints} | ${r.nChunks} | ${r.msmPoints} | ${r.bitChunkSize} | ${r.innerBitChunks.join('/')} | ${r.nPointChunks} | ${r.taskCount} | ${f1(MiB(r.perTaskWasmMax))} | ${f1(MiB(r.wave1CloneBytes))} | ${r.maxWorkerPages} | ${r.sectionPoolPages} |`
    );
  }
  const pool = plan.poolAtPhase2;
  console.log(
    `\nphase-1 exit pool = ${pool} pages = **${f1(MiB(pool * PAGE_BYTES))} MiB** over ${concurrency} workers (sequential high-water model, base ${baseBytes} B)`
  );
  console.log('worker pages at phase-2 start: ' + JSON.stringify(lastCall(plan, 'phase1.').workerPagesAfter));
  return { power, concurrency, baseBytes, rows, poolAtPhase2: pool, poolMiB: MiB(pool * PAGE_BYTES) };
}

function printPreparePhase2(power, concurrency) {
  // powersoftau_preparephase2.js:92 -- G.ifft(buff, "affine", "affine"):
  // in/out are affine (96 B), the intermediate chunks are jacobian (144 B).
  const big = fftLedger(2 ** (power + 1), concurrency, S.G1aff, S.G1jac, S.G1aff);
  const mid = fftLedger(2 ** power, concurrency, S.G1aff, S.G1jac, S.G1aff);
  console.log(`### prepare_phase2 @ power ${power} (concurrency ${concurrency})\n`);
  console.log('| ifft | points | chunks x pts | in-flight (MiB) | recv (MiB) | worker WASM (MiB) | input copy (MiB) | chunks[] (MiB) | out (MiB) | assembly peak (MiB) |');
  console.log('| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [label, r] of [['tauG1 tail', big], ['largest in-section', mid]]) {
    console.log(
      `| ${label} | ${r.nPoints} | ${r.nChunks} x ${r.pointsInChunk} | ${f1(MiB(r.inflightPeakBytes))} | ${f1(MiB(r.totalRecvBytes))} | ${f1(MiB(r.workerMemBytes))} | ${f1(MiB(r.inputCopyBytes))} | ${f1(MiB(r.assemblyChunksBytes))} | ${f1(MiB(r.assemblyOutBytes))} | ${f1(MiB(r.assemblyPeakBytes))} |`
    );
  }
  console.log('\nNo MSM in this operation: the peer path in prepared_verify does not apply.\n');
  return { power, concurrency, big, mid };
}

// ---- CLI -------------------------------------------------------------------
function main(argv) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const power = Number(arg('power', 18));
  const baseBytes = Number(arg('base', 0));
  const operation = arg('operation', 'prepared_verify');
  const concurrency = Number(arg('concurrency', Math.min(os.cpus().length, 64)));
  const asJson = argv.includes('--json');

  let out;
  if (operation === 'prepared_verify') out = asJson ? null : printPreparedVerify(power, concurrency, baseBytes);
  else if (operation === 'phase1') out = printPhase1(power, concurrency, baseBytes);
  else if (operation === 'prepare_phase2') out = printPreparePhase2(power, concurrency);
  else if (operation === 'batchconvert') out = printBatchConvert(power, concurrency);
  else if (operation === 'pool') out = printPool(power, concurrency, baseBytes);
  else if (operation === 'segments') out = printSegments(power, concurrency, baseBytes);
  else if (operation === 'plan') out = null;
  else {
    console.error(`unknown --operation ${operation} (prepared_verify | phase1 | prepare_phase2 | batchconvert | pool | segments | plan)`);
    process.exit(2);
  }

  if (operation === 'plan') {
    // L1 oracle: the complete execution plan, every call, every power.
    const plan = buildPlan(power, concurrency, baseBytes);
    const calls = plan.calls.map((c, i) => ({
      i,
      site: c.site,
      probe_site: probeSite(c.site, c.kind, c.group),
      kind: c.kind,
      group: c.group,
      p: c.p === undefined ? null : c.p,
      n_points: c.nPoints,
      s_scalar: c.sScalar === undefined ? null : c.sScalar,
      s_g: c.sG === undefined ? null : c.sG,
      s_in: c.sIn === undefined ? null : c.sIn,
      s_out: c.sOut === undefined ? null : c.sOut,
      bit_chunk: c.bitChunk === undefined ? null : c.bitChunk,
      n_bit: c.nBit === undefined ? null : c.nBit,
      chunk_size: c.chunkSize === undefined ? null : c.chunkSize,
      chunk_pts: c.chunkPts || null,
      points_in_chunk: c.pointsInChunk === undefined ? null : c.pointsInChunk,
      n_chunks: c.nChunks === undefined ? null : c.nChunks,
      n_tasks: c.taskCount,
      per_task_clone_bytes: c.perTaskCloneMax,
      per_task_wasm_bytes: c.perTaskWasmMax,
      wave1_clone_bytes: c.wave1CloneBytes,
      wave1_wasm_bytes: c.wave1WasmBytes,
      wave1_get_bytes: c.wave1GetBytes,
      wave1_pages: c.wave1Pages,
      late_tasks: c.lateTasks,
      late_provably_free: c.lateProvablyFree,
      delta_pages: c.deltaPages,
      grew_workers: c.grewWorkers,
      pool_pages_after: c.poolPagesAfter,
    }));
    console.log(
      JSON.stringify(
        {
          power,
          concurrency,
          alloc_base_bytes: baseBytes,
          generator: 'scripts/m5_budget.cjs --operation plan',
          assumptions: [
            'allocator base offset = ' + baseBytes + ' B (from worker_task.alloc_base; M5-C measured 102328 at p10)',
            'first wave = tasks 0..C-1 on workers 0..C-1 in (point-chunk outer, bit-chunk inner) order',
            'late tasks charged only when no worker could absorb them (late_provably_free)',
          ],
          phase1_baseline_pages: plan.poolAtPhase2,
          phase1_baseline_mib: f2(MiB(plan.poolAtPhase2 * PAGE_BYTES)),
          final_pool_pages: plan.poolFinalPages,
          final_pool_mib: f2(MiB(plan.poolFinalPages * PAGE_BYTES)),
          call_count: calls.length,
          calls,
        },
        null,
        2
      )
    );
    return null;
  }

  if (asJson) {
    // Every number here comes from the same sequential replay as --operation plan.
    // Nothing is estimated per-call in isolation any more (that path produced the
    // 223 MiB phase-1 baseline and is gone; see M5-A errata).
    const plan = buildPlan(power, concurrency, baseBytes);
    console.log(
      JSON.stringify(
        {
          power,
          concurrency,
          alloc_base_bytes: baseBytes,
          phase1: {
            rows: phase1RowsFromPlan(plan),
            baselinePages: plan.poolAtPhase2,
            baselineMiB: f2(MiB(plan.poolAtPhase2 * PAGE_BYTES)),
          },
          verifyPower: {
            resTau: powerRowsFromPlan(plan, 'tauG1', 'resTau'),
            resLagrange: powerRowsFromPlan(plan, 'tauG1', 'resLagrange'),
            tauG2: {
              resTau: powerRowsFromPlan(plan, 'tauG2', 'resTau'),
              resLagrange: powerRowsFromPlan(plan, 'tauG2', 'resLagrange'),
            },
          },
          batchConvert: {
            to: powerRowsFromPlan(plan, 'tauG1', 'batchToMontgomery'),
            from: powerRowsFromPlan(plan, 'tauG1', 'batchFromMontgomery'),
          },
          fft: fftLedger(2 ** (power + 1), concurrency, S.Fr, S.Fr, S.Fr),
          finalPoolPages: plan.poolFinalPages,
          finalPoolMiB: f2(MiB(plan.poolFinalPages * PAGE_BYTES)),
          callCount: plan.calls.length,
        },
        null,
        2
      )
    );
  }
  return out;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  replayWorkerMemory,
  phase1RowsFromPlan,
  powerRowsFromPlan,
  callsMatching,
  lastCall,
  fftLedger,
  batchConvertLedger,
  newPool,
  replayOn,
  dispatchTasks,
  msmTasks,
  batchTasks,
  fftTasks,
  buildPlan,
  callInIsolation,
  pagesAtInit,
  probeSite,
};
