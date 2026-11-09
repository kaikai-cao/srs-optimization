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

// ---- reporting -------------------------------------------------------------
function printPreparedVerify(power, concurrency) {
  const p1 = phase1Ledger(power, concurrency);
  const big = verifyPowerLedger(power + 1, concurrency);
  const mid = verifyPowerLedger(power, concurrency);
  const fft = fftLedger(2 ** (power + 1), concurrency, S.Fr, S.Fr, S.Fr);

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

  const inc = big.resLagrange.wave1SendBytes + (big.resLagrange.workerMemBytes - p1.baselineBytes);
  console.log(`#### D. tauG1 phase-2 segment increment (model, same window as M4.1)\n`);
  console.log('| term | MiB |');
  console.log('| --- | ---: |');
  console.log(`| resLagrange in-flight | ${f1(MiB(big.resLagrange.wave1SendBytes))} |`);
  console.log(`| resLagrange worker WASM | ${f1(MiB(big.resLagrange.workerMemBytes))} |`);
  console.log(`| minus phase-1 baseline | ${f1(-p1.baselineMiB)} |`);
  console.log(`| **model increment** | **${f1(MiB(inc))}** |`);
  console.log(`\nFr FFT @2^${big.p}: ${fft.nChunks} chunks x ${fft.pointsInChunk} pts, in-flight ${f1(MiB(fft.inflightPeakBytes))} MiB, worker WASM ${f1(MiB(fft.workerMemBytes))} MiB, input copy ${f1(MiB(fft.inputCopyBytes))} MiB`);
  console.log('\nAll worker-memory figures assume allocator base 0 and a descending\n(schedule-favourable) task-to-worker assignment: they are UPPER bounds.\n');

  return { power, concurrency, phase1: p1, resTau: big.resTau, resLagrange: big.resLagrange, fft, inc };
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
  else {
    console.error(`unknown --operation ${operation} (prepared_verify | phase1 | prepare_phase2)`);
    process.exit(2);
  }

  if (asJson) {
    const p1 = phase1Ledger(power, concurrency);
    const big = verifyPowerLedger(power + 1, concurrency);
    const mid = verifyPowerLedger(power, concurrency);
    const fft = fftLedger(2 ** (power + 1), concurrency, S.Fr, S.Fr, S.Fr);
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
          modelIncrementMiB: f2(MiB(inc)),
          assumptions: ['allocator base offset = 0', 'descending task-to-worker assignment (upper bound)'],
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
};
