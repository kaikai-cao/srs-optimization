#!/usr/bin/env node
/**
 * M5-A static allocation ledger calculator.
 *
 * This file does NOT instrument anything, does NOT monkey-patch a prototype, and
 * never launches snarkjs. It only re-derives, from the chunking arithmetic in
 * ffjavascript 0.3.1, the buffer sizes that the library WILL request, so that the
 * M5 probe design has a falsifiable prediction to be checked against.
 *
 * Transcribed constants (verify against the installed tree):
 *   ffjavascript/src/threadman.js:21             MEM_SIZE  = 25 pages (1.6 MiB)
 *   ffjavascript/src/threadman.js:104-119        concurrency = min(os.cpus(),64)
 *   ffjavascript/src/threadman_thread.js:4       MAXMEM    = 32767 pages (2 GiB)
 *   ffjavascript/src/threadman_thread.js:44-56   alloc() growth rule (top+len headroom)
 *   ffjavascript/src/engine_multiexp.js:3-8      pTSizes[]
 *   ffjavascript/src/engine_multiexp.js:92-137   chunkSize / nChunks / slice per chunk
 *   ffjavascript/src/engine_fft.js:13,109-115    MAX_BITS_THREAD=14, chunk split loop
 *   ffjavascript/src/bigbuffer.js:2              PAGE_SIZE = 1 GiB (single page below 1 GiB)
 *   ffjavascript/src/utils.js:206                log2() is FLOOR log2
 *
 * Usage:
 *   node scripts/m5_budget.cjs --power 18 --operation prepared_verify
 *   node scripts/m5_budget.cjs --power 18 --operation prepare_phase2 --json
 */

'use strict';

const os = require('os');

// ---- constants transcribed from ffjavascript 0.3.1 -------------------------
const MEM_SIZE_PAGES = 25;
const MAXMEM_PAGES = 32767;
const PAGE_BYTES = 65536;
const BIGBUFFER_PAGE = 1 << 30;
const MAX_CHUNK_SIZE = 1 << 22; // engine_multiexp.js:92
const MIN_CHUNK_SIZE = 1 << 10; // engine_multiexp.js:93
const MAX_BITS_THREAD = 14; // engine_fft.js:13
const PTSIZES = [
  1, 1, 1, 1, 2, 3, 4, 5,
  6, 7, 7, 8, 9, 10, 11, 12,
  13, 13, 14, 15, 16, 16, 17, 17,
  17, 17, 17, 17, 17, 17, 17, 17,
];

// BLS12-381 point / field element sizes (sG = F.n8 * 2 for affine, * 3 for jacobian)
const S = { G1aff: 96, G1jac: 144, G2aff: 192, G2jac: 288, Fr: 32 };

const MiB = (b) => b / 1048576;
const f1 = (x) => Math.round(x * 10) / 10;
const f2 = (x) => Math.round(x * 100) / 100;

function log2floor(v) {
  // replicates utils.js:206 for v > 0
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
 * Returns the worker's linear-memory capacity after the task, plus the raw
 * allocation top (the value u32[0] reaches) for overlap bookkeeping.
 */
function replayWorkerMemory(allocs, initialPages = MEM_SIZE_PAGES) {
  let top = 0; // static data offset of the wasm module; upper bound = 0
  let bytes = initialPages * PAGE_BYTES;
  let grows = 0;
  const trace = [];
  for (const len of allocs) {
    while (top & 3) top++;
    top += len;
    // threadman_thread.js:49 -- the condition adds `length` a SECOND time on top
    // of the already-incremented top, so the memory must fit top + len, i.e.
    // roughly 2x the first allocation plus the rest.
    if (top + len > bytes) {
      const curPages = bytes / PAGE_BYTES;
      let reqPages = Math.floor((top + len) / PAGE_BYTES) + 1;
      if (reqPages > MAXMEM_PAGES) reqPages = MAXMEM_PAGES;
      bytes = reqPages * PAGE_BYTES;
      grows++;
      trace.push({ event: 'grow', toBytes: bytes });
    }
  }
  return { bytes, top, grows, trace };
}

/** engine_multiexp.js _multiExp + _multiExpChunk */
function multiExpLedger(nPoints, concurrency, sG, sScalar) {
  const bitChunkSize = PTSIZES[log2floor(nPoints)];
  const nBitChunks = Math.floor((sScalar * 8 - 1) / bitChunkSize) + 1;

  let chunkSize = Math.floor(nPoints / (concurrency / nBitChunks));
  if (chunkSize > MAX_CHUNK_SIZE) chunkSize = MAX_CHUNK_SIZE;
  if (chunkSize < MIN_CHUNK_SIZE) chunkSize = MIN_CHUNK_SIZE;

  const tasks = [];
  for (let i = 0; i < nPoints; i += chunkSize) {
    const n = Math.min(nPoints - i, chunkSize);
    const bases = n * sG;
    const scalars = n * sScalar;
    for (let c = 0; c < nBitChunks; c++) {
      const mem = replayWorkerMemory([bases, scalars, S.G1jac]);
      tasks.push({
        points: n,
        basesBytes: bases,
        scalarsBytes: scalars,
        sendBytes: bases + scalars, // structured clone payload (no transfer list)
        recvBytes: S.G1jac, // GET out 0
        workerMemBytes: mem.bytes,
        workerGrows: mem.grows,
      });
    }
  }

  const nPointChunks = Math.ceil(nPoints / chunkSize);
  const byChunk = new Map();
  for (const t of tasks) byChunk.set(t.points, (byChunk.get(t.points) || 0) + 1);

  const totalSend = tasks.reduce((a, t) => a + t.sendBytes, 0);
  const totalRecv = tasks.reduce((a, t) => a + t.recvBytes, 0);
  // All point-chunks are created before the first await (one slice per chunk,
  // shared by every bit-chunk task of that chunk), and stay referenced until
  // Promise.all resolves.
  const sliceRetention = nPoints * (sG + sScalar);

  // First dispatch wave: queueAction -> processWorks posts to every free worker,
  // so up to `concurrency` tasks are serialized/cloned at once.
  const sorted = tasks.map((t) => t.sendBytes).sort((a, b) => b - a);
  const wave1Send = sorted.slice(0, concurrency).reduce((a, b) => a + b, 0);

  // Every worker that ever ran a task keeps its grown linear memory forever
  // (allocation pointer is restored, memory is not shrunk).
  const workerMemSorted = tasks.map((t) => t.workerMemBytes).sort((a, b) => b - a);
  const distinctWorkers = Math.min(concurrency, tasks.length);
  const workerMemTotal = workerMemSorted
    .slice(0, distinctWorkers)
    .reduce((a, b) => a + b, 0);

  return {
    kind: 'multiExp',
    nPoints,
    bitChunkSize,
    nBitChunks,
    chunkSize,
    nPointChunks,
    taskCount: tasks.length,
    perTaskPoints: [...byChunk.keys()],
    perTaskSendMiB: [...byChunk.keys()].map((k) => f1(MiB(k * (sG + sScalar)))),
    totalSendBytes: totalSend,
    totalRecvBytes: totalRecv,
    sliceRetentionBytes: sliceRetention,
    wave1SendBytes: wave1Send,
    workerMemBytes: workerMemTotal,
    maxWorkerMemBytes: workerMemSorted[0] || 0,
    maxWorkerGrows: Math.max(...tasks.map((t) => t.workerGrows)),
  };
}

/** engine_fft.js _fft (mix + join), for a single non-extended transform */
function fftLedger(nPoints, concurrency, sIn, sMid, sOut) {
  const bits = log2floor(nPoints);
  let pointsInChunk = Math.min(1 << MAX_BITS_THREAD, nPoints);
  let nChunks = nPoints / pointsInChunk;
  while (nChunks < concurrency && pointsInChunk >= 16) {
    nChunks *= 2;
    pointsInChunk /= 2;
  }
  const l2Chunk = log2floor(pointsInChunk);

  // engine_fft.js:73 -- buff.slice(0, byteLength). Below 1 GiB a BigBuffer slice
  // returns a plain Uint8Array COPY of the whole input.
  const inputCopyBytes = nPoints * sIn;
  // engine_fft.js:106 -- buffReverseBits: one tmp slice + one read slice per swap,
  // each of eSize bytes; number of swaps is ~nPoints/2.
  const reverseBitsAllocs = Math.floor(nPoints / 2) * 2;

  // mix wave: ALLOC sMid*ppc, SET from a 96*ppc slice, GET sMid*ppc (unless the
  // single-chunk case applies)
  const mixTask = {
    sendBytes: pointsInChunk * sIn,
    recvBytes: pointsInChunk * (l2Chunk === bits ? sOut : sMid),
    workerMemBytes: replayWorkerMemory([pointsInChunk * sMid]).bytes,
  };
  const mixTasks = [];
  for (let i = 0; i < nChunks; i++) mixTasks.push(mixTask);

  // join waves: one task per pair, two ALLOCSET of sMid*ppc each
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
  // A worker's linear memory is the high-water mark over EVERY task it ever ran,
  // so the join wave (two ALLOCSET) can dominate the mix wave.
  const perWorkerMax = Math.max(mixTask.workerMemBytes, joinWorkerMemMax);
  const workerMem = Math.min(concurrency, nChunks) * perWorkerMax;

  // Largest single dispatch wave: the mix wave, or the widest join wave.
  const joinWavePeak =
    Math.min(concurrency, nChunks / 2) * 2 * pointsInChunk * sMid;
  const inflightPeak = Math.max(
    Math.min(concurrency, nChunks) * mixTask.sendBytes,
    joinWavePeak
  );

  // final assembly: chunks[] still fully alive while buffOut is filled
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
    totalSendBytes: totalSend,
    totalRecvBytes: totalRecv,
    inflightPeakBytes: inflightPeak,
    inputCopyBytes,
    reverseBitsAllocs,
    workerMemBytes: workerMem,
    maxWorkerMemBytes: perWorkerMax,
    assemblyPeakBytes: inputCopyBytes + chunkBytes + outBytes,
  };
}

/** engine_batchconvert.js -- exactly `concurrency` chunks, no whole-buffer copy */
function batchConvertLedger(bytes, concurrency, sIn, sOut) {
  const nPoints = Math.floor(bytes / sIn);
  const per = Math.floor(nPoints / concurrency);
  const inChunk = per * sIn;
  const outChunk = per * sOut;
  return {
    kind: 'batchConvert',
    nPoints,
    chunks: concurrency,
    totalSendBytes: inChunk * concurrency,
    totalRecvBytes: outChunk * concurrency,
    workerMemBytes:
      Math.min(concurrency, concurrency) *
      replayWorkerMemory([inChunk, outChunk]).bytes,
    outBufferBytes: nPoints * sOut,
  };
}

/** fastfile cache capacity estimate -- control row only (M4 already measured it) */
function fastfileCapacity(readBytes, pageSize = 8192) {
  const pages = Math.floor((readBytes * 1.1) / pageSize) + 1;
  return { readBytes, pages, capacityBytes: pages * pageSize };
}

// ---- report ---------------------------------------------------------------
function buildLedger(power, operation, concurrency) {
  const p = power;
  const n = 2 ** p;
  const rows = [];

  if (operation === 'prepared_verify') {
    // powersoftau_verify.js:421-490 verifyPower(p): tauG1 section runs p=0..power
    // and one extra p=power+1 (line 414-417).
    const tau = multiExpLedger(2 ** (p + 1), concurrency, S.G1aff, S.Fr);
    const lag = multiExpLedger(n, concurrency, S.G1aff, S.Fr);
    const fftFr = fftLedger(2 ** (p + 1), concurrency, S.Fr, S.Fr, S.Fr);
    const b2m = batchConvertLedger(2 ** (p + 1) * S.Fr, concurrency, S.Fr, S.Fr);
    rows.push(['MSM tauG1 (2^(p+1) points)', tau]);
    rows.push(['MSM lagrange (2^p points)', lag]);
    rows.push(['Fr FFT for the shifted scalars', fftFr]);
    rows.push(['Fr batchTo/FromMontgomery', b2m]);
    rows.push([
      'FastFile largest read (control)',
      fastfileCapacity(Math.max((2 ** (p + 1) - 1) * S.G1aff, n * S.G1aff)),
    ]);
  } else if (operation === 'prepare_phase2') {
    // powersoftau_preparephase2.js:56-62: p=0..power per section, plus p=power+1
    // for section 2 (tauG1).
    const last = fftLedger(2 ** (p + 1), concurrency, S.G1aff, S.G1jac, S.G1aff);
    const inner = fftLedger(n, concurrency, S.G1aff, S.G1jac, S.G1aff);
    rows.push(['ifft tauG1 tail (2^(p+1) points)', last]);
    rows.push(['ifft largest in-section (2^p points)', inner]);
    rows.push([
      'FastFile largest read (control)',
      fastfileCapacity((2 ** (p + 1) - 1) * S.G1aff),
    ]);
  } else {
    throw new Error('unknown operation: ' + operation);
  }

  return { power: p, operation, concurrency, rows };
}

function toMarkdown(ledger) {
  const out = [];
  out.push(`### ${ledger.operation} @ power ${ledger.power} (concurrency ${ledger.concurrency})`);
  out.push('');
  out.push('| component | tasks | chunk | in-flight send (MiB) | total send (MiB) | total recv (MiB) | worker WASM (MiB) | JS retention (MiB) |');
  out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [name, r] of ledger.rows) {
    if (r.kind === 'multiExp') {
      out.push(
        `| ${name} | ${r.taskCount} | ${r.nPointChunks}x${r.nBitChunks} bit-chunks, ${r.perTaskPoints.join('+')} pts | ${f1(MiB(r.wave1SendBytes))} | ${f1(MiB(r.totalSendBytes))} | ${f1(MiB(r.totalRecvBytes))} | ${f1(MiB(r.workerMemBytes))} | ${f1(MiB(r.sliceRetentionBytes))} |`
      );
    } else if (r.kind === 'fft') {
      out.push(
        `| ${name} | ${r.mixTasks + r.joinTasks} | ${r.nChunks} chunks x ${r.pointsInChunk} pts | ${f1(MiB(r.inflightPeakBytes))} | ${f1(MiB(r.totalSendBytes))} | ${f1(MiB(r.totalRecvBytes))} | ${f1(MiB(r.workerMemBytes))} | ${f1(MiB(r.assemblyPeakBytes))} |`
      );
    } else if (r.kind === 'batchConvert') {
      out.push(
        `| ${name} | ${r.chunks} | ${r.chunks} chunks | ${f1(MiB(r.totalSendBytes))} | ${f1(MiB(r.totalSendBytes))} | ${f1(MiB(r.totalRecvBytes))} | ${f1(MiB(r.workerMemBytes))} | ${f1(MiB(r.outBufferBytes))} |`
      );
    } else {
      out.push(
        `| ${name} | - | read ${f1(MiB(r.readBytes))} MiB | - | - | - | - | ${f1(MiB(r.capacityBytes))} |`
      );
    }
  }
  out.push('');
  return out.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const get = (name, dflt) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const power = Number(get('power', '18'));
  const operation = get('operation', 'prepared_verify');
  const concurrency = Number(get('concurrency', String(Math.min(os.cpus().length, 64))));
  const ledger = buildLedger(power, operation, concurrency);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(ledger, null, 2));
  } else {
    console.log(toMarkdown(ledger));
  }
}

if (require.main === module) main();

module.exports = { multiExpLedger, fftLedger, batchConvertLedger, replayWorkerMemory };
