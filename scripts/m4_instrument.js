/*
 * M4 / M4.1 FastFile page-pool instrumentation (non-invasive).
 *
 * Loaded with `node --require scripts/m4_instrument.js ...`.
 *
 * snarkjs -> @iden3/binfileutils -> fastfile (CJS build, build/main.cjs).
 * We require('fastfile') (same cached CJS instance binfileutils uses) and wrap its
 * public factory functions. When a factory returns a FastFile instance we patch
 * that instance's prototype ONCE, then track the instance in a live set. A short
 * setInterval samples the live page pool so we capture the true peak even though
 * page population happens asynchronously inside fastfile.
 *
 * Performance: the per-call prototype hooks only read `maxPagesLoaded` (O(1)).
 * The expensive `Object.keys(pages).length` scan happens ONLY in the 50 ms
 * sampler, so per-read overhead stays negligible (important for high powers).
 *
 * M4.1 adds SYNCHRONIZED SNAPSHOTS. M4 kept three independent historical maxima
 * (max capacity, max pages, max avBuffs), which cannot be compared to each other
 * because they may come from different instants. Every sample now reads
 * (maxPagesLoaded, pagesCount, avBuffsCount) in one pass and stores the whole
 * triple, so `capacity == held` becomes a claim about ONE moment.
 *
 * At process exit we dump per-file and global page-pool peaks to M4_FASTFILE_OUT.
 *
 * This does NOT modify any dependency source; it only wraps exported functions
 * and prototypes at load time. All logic is guarded by try/catch.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const T0 = Date.now();

const OUT_PATH = process.env.M4_FASTFILE_OUT ||
  path.resolve(__dirname, '..', 'results', 'raw', 'm4_fastfile_pool.json');

const SAMPLER_MS = 50;

// fileName -> record (see ensureRec)
const perFile = new Map();
// live FastFile instances (for the sampler)
const liveSet = new Set();

function ensureRec(fd) {
  const key = fd.fileName || '<unknown>';
  let rec = perFile.get(key);
  if (!rec) {
    rec = {
      fileName: key,
      pageSize: fd.pageSize || 0,
      // --- M4 legacy: independent historical maxima ---
      peakMaxPagesLoaded: 0,
      peakPagesCount: 0,
      peakAvBuffsCount: 0,
      // --- M4.1: same-instant snapshots + sampling counter ---
      nSamples: 0,
      peakCapacitySnapshot: null,
      peakHeldSnapshot: null,
    };
    perFile.set(key, rec);
  }
  if (fd.pageSize) rec.pageSize = fd.pageSize;
  return rec;
}

// O(1): capacity only. Called on every readToBuffer / _triggerLoad.
// This keeps the per-read hook cheap; the synchronized numbers come from the
// sampler, which sees the whole triple.
function recordCapacity(fd) {
  if (!fd) return;
  try {
    const maxPages = fd.maxPagesLoaded || 0;
    if (!maxPages) return;
    const rec = ensureRec(fd);
    if (maxPages > rec.peakMaxPagesLoaded) rec.peakMaxPagesLoaded = maxPages;
  } catch (_) { /* never break the measured process */ }
}

// O(pages): full scan, ONE instant. Called by the 50 ms sampler and on close.
function sampleInstance(fd) {
  if (!fd) return;
  try {
    const rec = ensureRec(fd);
    // Read the triple in one pass: these three values describe the SAME moment.
    const maxPages = fd.maxPagesLoaded || 0;
    const pagesCount = fd.pages ? Object.keys(fd.pages).length : 0;
    const avCount = fd.avBuffs ? fd.avBuffs.length : 0;
    const pageSize = rec.pageSize || fd.pageSize || 0;
    const capacityBytes = maxPages * pageSize;
    const heldBytes = (pagesCount + avCount) * pageSize;

    if (maxPages > rec.peakMaxPagesLoaded) rec.peakMaxPagesLoaded = maxPages;
    if (pagesCount > rec.peakPagesCount) rec.peakPagesCount = pagesCount;
    if (avCount > rec.peakAvBuffsCount) rec.peakAvBuffsCount = avCount;
    rec.nSamples++;

    const snap = {
      tMs: Date.now() - T0,
      maxPagesLoaded: maxPages,
      pagesCount: pagesCount,
      avBuffsCount: avCount,
      capacityBytes: capacityBytes,
      heldBytes: heldBytes,
    };

    // Keep the snapshot at maximal capacity (tie-break: more held bytes, i.e. the
    // richer instant for the same capacity).
    const cap = rec.peakCapacitySnapshot;
    if (!cap || capacityBytes > cap.capacityBytes ||
        (capacityBytes === cap.capacityBytes && heldBytes > cap.heldBytes)) {
      rec.peakCapacitySnapshot = snap;
    }
    const held = rec.peakHeldSnapshot;
    if (!held || heldBytes > held.heldBytes ||
        (heldBytes === held.heldBytes && capacityBytes > held.capacityBytes)) {
      rec.peakHeldSnapshot = snap;
    }
  } catch (_) { /* ignore */ }
}

function patchProto(proto) {
  if (!proto || proto.__m4_patched) return;
  try {
    const origRead = proto.readToBuffer;
    if (typeof origRead === 'function') {
      proto.readToBuffer = function () {
        const r = origRead.apply(this, arguments);
        recordCapacity(this);
        return r;
      };
    }
    const origTrigger = proto._triggerLoad;
    if (typeof origTrigger === 'function') {
      proto._triggerLoad = function () {
        const r = origTrigger.apply(this, arguments);
        recordCapacity(this);
        return r;
      };
    }
    const origClose = proto.close;
    if (typeof origClose === 'function') {
      proto.close = function () {
        sampleInstance(this);
        const r = origClose.apply(this, arguments);
        try { liveSet.delete(this); } catch (_) { /* ignore */ }
        return r;
      };
    }
    proto.__m4_patched = true;
  } catch (_) { /* ignore */ }
}

function register(inst) {
  if (!inst || !inst.constructor || !inst.constructor.prototype) return;
  try {
    patchProto(inst.constructor.prototype);
    liveSet.add(inst);
    sampleInstance(inst);
  } catch (_) { /* ignore */ }
}

function wrapFactory(mod, name) {
  const orig = mod[name];
  if (typeof orig !== 'function') return;
  mod[name] = function () {
    const ret = orig.apply(null, arguments);
    if (ret && typeof ret.then === 'function') {
      return ret.then(function (inst) { register(inst); return inst; });
    }
    register(ret);
    return ret;
  };
}

try {
  const fastfile = require('fastfile');
  ['readExisting', 'readWriteExisting', 'readWriteExistingOrCreate',
    'createNoOverride', 'createOverride'].forEach(function (n) {
      try { wrapFactory(fastfile, n); } catch (_) { /* ignore */ }
    });
} catch (_) { /* fastfile not resolvable in this process: skip silently */ }

// Sampler: capture page-pool peak across all live instances (full scan).
let sampler = null;
try {
  sampler = setInterval(function () {
    liveSet.forEach(function (fd) { sampleInstance(fd); });
  }, SAMPLER_MS);
  if (sampler && typeof sampler.unref === 'function') sampler.unref();
} catch (_) { /* ignore */ }

const mib = (b) => Math.round((b / (1024 * 1024)) * 100) / 100;

function snapOut(s) {
  if (!s) return null;
  return {
    tMs: s.tMs,
    maxPagesLoaded: s.maxPagesLoaded,
    pagesCount: s.pagesCount,
    avBuffsCount: s.avBuffsCount,
    capacityBytes: s.capacityBytes,
    capacityMiB: mib(s.capacityBytes),
    heldBytes: s.heldBytes,
    heldMiB: mib(s.heldBytes),
  };
}

function dump() {
  try {
    if (sampler) { try { clearInterval(sampler); } catch (_) { /* ignore */ } }
    const files = [];
    let globalCapacityMiB = 0;
    let globalHeldMiB = 0;
    let globalCapacitySnapshot = null;
    let globalHeldSnapshot = null;

    perFile.forEach(function (rec) {
      const capacityBytes = rec.peakMaxPagesLoaded * rec.pageSize;
      const heldBytes = (rec.peakPagesCount + rec.peakAvBuffsCount) * rec.pageSize;
      const capacityMiB = mib(capacityBytes);
      const heldMiB = mib(heldBytes);
      if (capacityMiB > globalCapacityMiB) globalCapacityMiB = capacityMiB;
      if (heldMiB > globalHeldMiB) globalHeldMiB = heldMiB;

      const capSnap = snapOut(rec.peakCapacitySnapshot);
      const heldSnap = snapOut(rec.peakHeldSnapshot);
      if (capSnap && (!globalCapacitySnapshot || capSnap.capacityBytes > globalCapacitySnapshot.capacityBytes)) {
        globalCapacitySnapshot = Object.assign({ fileName: path.basename(rec.fileName) }, capSnap);
      }
      if (heldSnap && (!globalHeldSnapshot || heldSnap.heldBytes > globalHeldSnapshot.heldBytes)) {
        globalHeldSnapshot = Object.assign({ fileName: path.basename(rec.fileName) }, heldSnap);
      }

      files.push({
        fileName: path.basename(rec.fileName),
        pageSize: rec.pageSize,
        // independent historical maxima (M4 fields, kept for continuity)
        peakMaxPagesLoaded: rec.peakMaxPagesLoaded,
        capacityBytes: capacityBytes,
        capacityMiB: capacityMiB,
        peakPagesCount: rec.peakPagesCount,
        peakAvBuffsCount: rec.peakAvBuffsCount,
        heldBytes: heldBytes,
        heldMiB: heldMiB,
        // same-instant snapshots (M4.1)
        nSamples: rec.nSamples,
        peakCapacitySnapshot: capSnap,
        peakHeldSnapshot: heldSnap,
      });
    });

    const out = {
      metric: 'FastFile page-pool instrumentation (M4.1: synchronized snapshots)',
      note: 'capacityMiB = peakMaxPagesLoaded*pageSize is the page-buffer cache UPPER BOUND fastfile keeps while the fd is open; heldMiB = (pages+avBuffs)*pageSize is the allocated page-buffer footprint. The *_Snapshot objects read maxPagesLoaded/pages/avBuffs in ONE sample, so their three numbers describe the same instant; the flat peak* fields are independent historical maxima and must NOT be compared to each other. See MEMORY_BASELINE_M4.md.',
      samplerMs: SAMPLER_MS,
      files: files,
      global: {
        peakCapacityMiB: globalCapacityMiB,
        peakHeldMiB: globalHeldMiB,
        nFiles: files.length,
        nSamplesMax: files.reduce((m, f) => Math.max(m, f.nSamples), 0),
        peakCapacitySnapshot: globalCapacitySnapshot,
        peakHeldSnapshot: globalHeldSnapshot,
      },
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  } catch (_) { /* never throw during exit */ }
}

process.on('exit', dump);
