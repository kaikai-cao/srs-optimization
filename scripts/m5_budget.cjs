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
function replayWorkerMemory(allocs, initialPages = MEM_SIZE_PAGES) {
  let top = 0; // ASSUMED allocator base offset (see header note)
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

/**
 * One _multiExp call: engine_multiexp.js:112-137.
 * sScalar is derived as floor(scalars.byteLength / nPoints); pass it explicitly.
 */
function msmCall(nPoints, sG, sScalar, concurrency, jacBytes) {
  const bitChunkSize = PTSIZES[log2floor(nPoints)];
  const nBitChunks = Math.floor((sScalar * 8 - 1) / bitChunkSize) + 1;

  let chunkSize = Math.floor(nPoints / (concurrency / nBitChunks));
  if (chunkSize > MAX_CHUNK_SIZE) chunkSize = MAX_CHUNK_SIZE;
  if (chunkSize < MIN_CHUNK_SIZE) chunkSize = MIN_CHUNK_SIZE;

  const pointChunks = [];
  for (let i = 0; i < nPoints; i += chunkSize) {
    pointChunks.push(Math.min(nPoints - i, chunkSize));
  }

  const perChunk = pointChunks.map((n) => {
    const bases = n * sG;
    const scalars = n * sScalar;
    return {
      points: n,
      sendBytes: bases + scalars,
      basesBytes: bases,
      scalarsBytes: scalars,
      workerMemBytes: replayWorkerMemory([bases, scalars, jacBytes]).bytes,
      workerGrows: replayWorkerMemory([bases, scalars, jacBytes]).grows,
    };
  });

  // nBitChunks tasks per point-chunk, each carrying the WHOLE point-chunk
  const tasks = [];
  for (const pc of perChunk) {
    for (let b = 0; b < nBitChunks; b++) tasks.push(pc);
  }

  const nWorkers = Math.min(concurrency, tasks.length);
  const memSorted = tasks.map((t) => t.workerMemBytes).sort((a, b) => b - a);
  const sendSorted = tasks.map((t) => t.sendBytes).sort((a, b) => b - a);

  return {
    nPoints,
    sG,
    sScalar,
    bitChunkSize,
    nBitChunks,
    chunkSize,
    nPointChunks: pointChunks.length,
    taskCount: tasks.length,
    perTaskPointsMin: Math.min(...pointChunks),
    perTaskPointsMax: Math.max(...pointChunks),
    perTaskSendMax: sendSorted[0],
    // upper bound: assumes the largest tasks land on distinct workers
    wave1SendBytes: sendSorted.slice(0, concurrency).reduce((a, b) => a + b, 0),
    // upper bound: same assumption applied to retained linear memory
    workerMemBytes: memSorted.slice(0, nWorkers).reduce((a, b) => a + b, 0),
    workerMemMinBytes: memSorted[Math.max(0, memSorted.length - 1)],
    maxWorkerMemBytes: memSorted[0],
    maxWorkerPages: Math.round(memSorted[0] / PAGE_BYTES),
    noGrow: memSorted[0] <= MEM_SIZE_PAGES * PAGE_BYTES,
    unchangedWorkerBytes: 0,
    nWorkers,
  };
}

/** phase 1: the four processSection() calls before phase 2 begins */
function phase1Ledger(power, concurrency) {
  const sections = [
    { name: 'tauG1', group: 'G1', sG: S.G1aff, jac: S.G1jac, nPoints: 2 ** power * 2 - 1 },
    { name: 'tauG2', group: 'G2', sG: S.G2aff, jac: S.G2jac, nPoints: 2 ** power },
    { name: 'alphatauG1', group: 'G1', sG: S.G1aff, jac: S.G1jac, nPoints: 2 ** power },
    { name: 'betatauG1', group: 'G1', sG: S.G1aff, jac: S.G1jac, nPoints: 2 ** power },
  ];

  const rows = sections.map((sec) => {
    // MAX_CHUNK_SIZE = 65536 points per read; each chunk runs TWO MSMs on n-1
    const chunkPts = [];
    for (let i = 0; i < sec.nPoints; i += PHASE1_CHUNK) {
      chunkPts.push(Math.min(sec.nPoints - i, PHASE1_CHUNK));
    }
    const worst = msmCall(
      Math.max(...chunkPts) - 1,
      sec.sG,
      SCALAR_4B,
      concurrency,
      sec.jac
    );
    const small = msmCall(
      Math.min(...chunkPts) - 1,
      sec.sG,
      SCALAR_4B,
      concurrency,
      sec.jac
    );
    return {
      ...sec,
      chunkPts,
      nChunks: chunkPts.length,
      msmPoints: Math.max(...chunkPts) - 1,
      worst,
      small,
    };
  });

  // A worker's linear memory is a high-water mark; the worst task in phase 1
  // decides every worker that ever ran a full-size chunk.
  const driver = rows.reduce((a, b) => (b.worst.maxWorkerMemBytes > a.worst.maxWorkerMemBytes ? b : a));
  const grownPages = driver.worst.maxWorkerPages;
  const grownBytes = driver.worst.maxWorkerMemBytes;
  const nGrownTasks = driver.worst.taskCount;

  // Point-chunks: full-size ones grow a worker, the tail one does not.
  const fullChunks = Math.max(1, driver.worst.nPointChunks - 1);
  const grownWorkers = Math.min(concurrency, fullChunks * driver.worst.nBitChunks);
  const initBytes = MEM_SIZE_PAGES * PAGE_BYTES;
  const baseline = grownWorkers * grownBytes + (concurrency - grownWorkers) * initBytes;

  return {
    kind: 'phase1',
    rows,
    driver: driver.name,
    grownPages,
    grownBytesPerWorker: grownBytes,
    grownWorkers,
    initPerWorkerBytes: initBytes,
    baselineBytes: baseline,
    baselineMiB: MiB(baseline),
    note: 'scalars are 4 B (getRandomBytes(4*(n-1))); two MSMs per 64 Ki-point chunk',
  };
}

/** phase 2: verifyPower(p) runs resTau (4 B) and then resLagrange (32 B) */
function verifyPowerLedger(p, concurrency) {
  const nPoints = 2 ** p;
  const tau = msmCall(nPoints, S.G1aff, SCALAR_4B, concurrency, S.G1jac);
  const lag = msmCall(nPoints, S.G1aff, SCALAR_FR, concurrency, S.G1jac);
  return { kind: 'verifyPower', p, nPoints, resTau: tau, resLagrange: lag };
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

function newPool(concurrency) {
  return { concurrency, pages: new Array(concurrency).fill(MEM_SIZE_PAGES) };
}

function poolPages(pool) {
  return pool.pages.reduce((a, b) => a + b, 0);
}

function poolMiB(pool) {
  return MiB(poolPages(pool) * PAGE_BYTES);
}

/** Replay one task on one worker. Returns the grow events actually taken. */
function replayOn(pool, worker, allocs, baseBytes = 0) {
  let top = baseBytes;
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
function pagesAtInit(allocs) {
  const probe = { concurrency: 1, pages: [MEM_SIZE_PAGES] };
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
    const need = pagesAtInit(tasks[i].allocs);
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
    wave1Pages: tasks.slice(0, C).map((t) => pagesAtInit(t.allocs)),
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

  const tasks = [];
  for (const pts of chunkPts) {
    const allocs = [pts * sG, pts * sScalar, jacBytes];
    for (let b = 0; b < nBitChunks; b++) tasks.push({ pts, allocs });
  }
  return { bitChunkSize, nBitChunks, chunkSize, chunkPts, tasks };
}

function batchTasks(nPoints, concurrency, sIn, sOut) {
  const per = Math.floor(nPoints / concurrency);
  const tasks = [];
  for (let i = 0; i < concurrency; i++) {
    const n = i < concurrency - 1 ? per : nPoints - i * per;
    if (n === 0) continue;
    tasks.push({ pts: n, allocs: [n * sIn, n * sOut] });
  }
  return tasks;
}

function fftTasks(nPoints, concurrency, sMid) {
  // only the mix phase allocates; pointsInChunk follows engine_fft.js:109-115
  let pointsInChunk = Math.min(1 << MAX_BITS_THREAD, nPoints);
  let nChunks = nPoints / pointsInChunk;
  while (nChunks < concurrency && pointsInChunk >= 16) {
    nChunks *= 2;
    pointsInChunk /= 2;
  }
  const tasks = [];
  for (let i = 0; i < nChunks; i++) tasks.push({ pts: pointsInChunk, allocs: [pointsInChunk * sMid] });
  return { pointsInChunk, nChunks, tasks };
}

/** One instrumented emission: run the call, record pool state before/after. */
function emit(pool, call) {
  const beforePages = poolPages(pool);
  const workerPagesBefore = pool.pages.slice();
  const d = dispatchTasks(pool, call.tasks);
  return Object.assign({}, call, {
    taskCount: call.tasks.length,
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
function buildPlan(power, concurrency) {
  const pool = newPool(concurrency);
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
          const f = fftTasks(nPoints, concurrency, S.Fr);
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

/** Pages a single call leaves on the pool, without touching a shared pool. */
function callInIsolation(call, concurrency) {
  const pool = newPool(concurrency);
  dispatchTasks(pool, call.tasks);
  return { poolPages: poolPages(pool), poolMiB: f1(poolMiB(pool)) };
}

// ---- reporting -------------------------------------------------------------
function printPool(power, concurrency) {
  const plan = buildPlan(power, concurrency);
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

function printSegments(power, concurrency) {
  const plan = buildPlan(power, concurrency);
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

function printPreparedVerify(power, concurrency) {
  const p1 = phase1Ledger(power, concurrency);
  const big = verifyPowerLedger(power + 1, concurrency);
  const mid = verifyPowerLedger(power, concurrency);
  const fft = fftLedger(2 ** (power + 1), concurrency, S.Fr, S.Fr, S.Fr);
  const bcBig = batchConvertLedger(2 ** (power + 1), concurrency, S.Fr, S.Fr);
  const bcMid = batchConvertLedger(2 ** power, concurrency, S.Fr, S.Fr);

  console.log(`### prepared_verify @ power ${power} (concurrency ${concurrency})\n`);
  console.log('#### A. phase 1 -- processSection, 4 B scalars (powersoftau_verify.js:361)\n');
  console.log('| section | group | points | 64 Ki-chunks | MSM points | bitChunk | bit-chunks | point-chunks | tasks | per-task (MiB) | in-flight (MiB) | worker pages | workers grown |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of p1.rows) {
    console.log(
      `| ${r.name} | ${r.group} | ${r.nPoints} | ${r.nChunks} | ${r.msmPoints} | ${r.worst.bitChunkSize} | ${r.worst.nBitChunks} | ${r.worst.nPointChunks} | ${r.worst.taskCount} | ${f1(MiB(r.worst.perTaskSendMax))} | ${f1(MiB(r.worst.wave1SendBytes))} | ${r.worst.maxWorkerPages} | ${r.worst.noGrow ? 0 : Math.min(concurrency, (r.worst.nPointChunks - 1) * r.worst.nBitChunks)} |`
    );
  }
  console.log(
    `\nphase-1 baseline (driver: ${p1.driver}): ${p1.grownWorkers} workers x ${p1.grownPages} pages (${f2(MiB(p1.grownBytesPerWorker))} MiB) + rest at 25 pages = **${f1(p1.baselineMiB)} MiB**\n`
  );

  console.log('#### B. phase 2 -- resTau, 4 B scalars (powersoftau_verify.js:425,452)\n');
  console.log('| p | points | bitChunk | bit-chunks | point-chunks | tasks | per-task (MiB) | in-flight (MiB) | worker pages |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  console.log(
    `| ${big.p} | ${big.nPoints} | ${big.resTau.bitChunkSize} | ${big.resTau.nBitChunks} | ${big.resTau.nPointChunks} | ${big.resTau.taskCount} | ${f1(MiB(big.resTau.perTaskSendMax))} | ${f1(MiB(big.resTau.wave1SendBytes))} | ${big.resTau.maxWorkerPages} |`
  );
  console.log(
    `| ${mid.p} | ${mid.nPoints} | ${mid.resTau.bitChunkSize} | ${mid.resTau.nBitChunks} | ${mid.resTau.nPointChunks} | ${mid.resTau.taskCount} | ${f1(MiB(mid.resTau.perTaskSendMax))} | ${f1(MiB(mid.resTau.wave1SendBytes))} | ${mid.resTau.maxWorkerPages} |\n`
  );

  console.log('#### C. phase 2 -- resLagrange, 32 B scalars after fft (powersoftau_verify.js:454,482)\n');
  console.log('| p | points | bitChunk | bit-chunks | point-chunks | tasks | per-task (MiB) | in-flight (MiB) | worker pages | worker WASM (MiB) |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  console.log(
    `| ${big.p} | ${big.nPoints} | ${big.resLagrange.bitChunkSize} | ${big.resLagrange.nBitChunks} | ${big.resLagrange.nPointChunks} | ${big.resLagrange.taskCount} | ${f1(MiB(big.resLagrange.perTaskSendMax))} | ${f1(MiB(big.resLagrange.wave1SendBytes))} | ${big.resLagrange.maxWorkerPages} | ${f1(MiB(big.resLagrange.workerMemBytes))} |`
  );
  console.log(
    `| ${mid.p} | ${mid.nPoints} | ${mid.resLagrange.bitChunkSize} | ${mid.resLagrange.nBitChunks} | ${mid.resLagrange.nPointChunks} | ${mid.resLagrange.taskCount} | ${f1(MiB(mid.resLagrange.perTaskSendMax))} | ${f1(MiB(mid.resLagrange.wave1SendBytes))} | ${mid.resLagrange.maxWorkerPages} | ${f1(MiB(mid.resLagrange.workerMemBytes))} |\n`
  );

  console.log('#### D. Fr batchTo/FromMontgomery -- 32 B in/out, TWO allocations per chunk (engine_batchconvert.js:23-32)\n');
  console.log('| p | points | chunks | pts/chunk (last) | bytes/chunk ALLOCSET+ALLOC | pages after | workers grown | worker WASM (MiB) | main-thread transient add (MiB) |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of [bcBig, bcMid]) {
    console.log(
      `| ${log2floor(r.nPoints)} | ${r.nPoints} | ${r.taskCount} | ${r.pointsPerChunk} (${r.chunks[r.chunks.length - 1].points}) | ${r.perChunkBytes} | ${r.maxPages} | ${r.grownWorkers} | ${f1(r.workerCapacityMiB)} | ${f1(MiB(r.mainThread.transientAddBytes))} |`
    );
  }
  console.log(
    `\nbinding check: resTau leaves ${big.resTau.maxWorkerPages} pages/worker, batchconvert needs ${bcBig.maxPages} -> ` +
      `${bcBig.maxPages > big.resTau.maxWorkerPages ? 'BINDS (adds memory)' : 'non-binding at this iteration'}; ` +
      `absolute level ${bcBig.maxPages} pages x ${concurrency} workers = ${f1(bcBig.workerCapacityMiB)} MiB.\n`
  );

  const inc = big.resLagrange.wave1SendBytes + (big.resLagrange.workerMemBytes - p1.baselineBytes);
  console.log(`#### E. tauG1 phase-2 segment increment (model, same window as M4.1)\n`);
  console.log('| term | MiB |');
  console.log('| --- | ---: |');
  console.log(`| resLagrange in-flight | ${f1(MiB(big.resLagrange.wave1SendBytes))} |`);
  console.log(`| resLagrange worker WASM | ${f1(MiB(big.resLagrange.workerMemBytes))} |`);
  console.log(`| minus phase-1 baseline | ${f1(-p1.baselineMiB)} |`);
  console.log(`| **model increment** | **${f1(MiB(inc))}** |`);
  console.log(`\nFr FFT @2^${big.p}: ${fft.nChunks} chunks x ${fft.pointsInChunk} pts, in-flight ${f1(MiB(fft.inflightPeakBytes))} MiB, worker WASM ${f1(MiB(fft.workerMemBytes))} MiB, input copy ${f1(MiB(fft.inputCopyBytes))} MiB`);
  console.log('\nAll worker-memory figures assume allocator base 0 and a descending\n(schedule-favourable) task-to-worker assignment: they are UPPER bounds.\n');

  return { power, concurrency, phase1: p1, resTau: big.resTau, resLagrange: big.resLagrange, fft, batchConvert: { big: bcBig, mid: bcMid }, inc };
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

function printPhase1(power, concurrency) {
  const p1 = phase1Ledger(power, concurrency);
  console.log(`### phase 1 only @ power ${power} (concurrency ${concurrency})\n`);
  console.log('| section | group | points | 64 Ki-chunks | MSM points | 4 B bitChunk | bit-chunks | point-chunks | tasks | per-task (MiB) | in-flight (MiB) | worker pages |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of p1.rows) {
    console.log(
      `| ${r.name} | ${r.group} | ${r.nPoints} | ${r.nChunks} | ${r.msmPoints} | ${r.worst.bitChunkSize} | ${r.worst.nBitChunks} | ${r.worst.nPointChunks} | ${r.worst.taskCount} | ${f1(MiB(r.worst.perTaskSendMax))} | ${f1(MiB(r.worst.wave1SendBytes))} | ${r.worst.maxWorkerPages} |`
    );
  }
  console.log(`\nbaseline = ${p1.grownWorkers} x ${p1.grownPages} pages + ${concurrency - p1.grownWorkers} x 25 pages = **${f1(p1.baselineMiB)} MiB** (driver: ${p1.driver})`);
  return p1;
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
  const operation = arg('operation', 'prepared_verify');
  const concurrency = Number(arg('concurrency', Math.min(os.cpus().length, 64)));
  const asJson = argv.includes('--json');

  let out;
  if (operation === 'prepared_verify') out = asJson ? null : printPreparedVerify(power, concurrency);
  else if (operation === 'phase1') out = printPhase1(power, concurrency);
  else if (operation === 'prepare_phase2') out = printPreparePhase2(power, concurrency);
  else if (operation === 'batchconvert') out = printBatchConvert(power, concurrency);
  else if (operation === 'pool') out = printPool(power, concurrency);
  else if (operation === 'segments') out = printSegments(power, concurrency);
  else if (operation === 'plan') out = null;
  else {
    console.error(`unknown --operation ${operation} (prepared_verify | phase1 | prepare_phase2 | batchconvert | pool | segments | plan)`);
    process.exit(2);
  }

  if (operation === 'plan') {
    // L1 oracle: the complete execution plan, every call, every power.
    const plan = buildPlan(power, concurrency);
    const calls = plan.calls.map((c, i) => ({
      i,
      site: c.site,
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
          generator: 'scripts/m5_budget.cjs --operation plan',
          assumptions: [
            'allocator base offset = 0 (HYP-1, lower bound; replaced by worker_task.alloc_base)',
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
    const p1 = phase1Ledger(power, concurrency);
    const big = verifyPowerLedger(power + 1, concurrency);
    const mid = verifyPowerLedger(power, concurrency);
    const fft = fftLedger(2 ** (power + 1), concurrency, S.Fr, S.Fr, S.Fr);
    const bc = batchConvertLedger(2 ** (power + 1), concurrency, S.Fr, S.Fr);
    const inc = big.resLagrange.wave1SendBytes + (big.resLagrange.workerMemBytes - p1.baselineBytes);
    console.log(
      JSON.stringify(
        {
          power,
          concurrency,
          phase1: { rows: p1.rows.map((r) => ({ name: r.name, group: r.group, points: r.nPoints, msmPoints: r.msmPoints, ...r.worst })), baselineMiB: f2(p1.baselineMiB), grownWorkers: p1.grownWorkers, grownPages: p1.grownPages, driver: p1.driver },
          resTau: big.resTau,
          resLagrange: big.resLagrange,
          resTauMid: mid.resTau,
          resLagrangeMid: mid.resLagrange,
          fft,
          batchConvert: {
            p: log2floor(bc.nPoints),
            points: bc.nPoints,
            chunks: bc.taskCount,
            maxPages: bc.maxPages,
            grownWorkers: bc.grownWorkers,
            workerCapacityMiB: f2(bc.workerCapacityMiB),
            perChunkBytes: bc.perChunkBytes,
            mainThread: bc.mainThread,
          },
          modelIncrementMiB: f2(MiB(inc)),
          assumptions: ['allocator base offset = 0 (lower bound)', 'descending task-to-worker assignment (upper bound, not actual scheduling)'],
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
  msmCall,
  phase1Ledger,
  verifyPowerLedger,
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
};
