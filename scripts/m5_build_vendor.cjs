#!/usr/bin/env node
/**
 * M5-B: build the instrumented ffjavascript copy.
 *
 *   node_modules/ffjavascript            ->  vendor/ffjavascript-0.3.1-m5/
 *
 * The patch target is `build/main.cjs`, NOT `src/*.js`:
 *   ffjavascript's package.json exports "." -> { require: "./build/main.cjs" },
 *   snarkjs resolves `ffjavascript` through that CJS bundle, and the Worker
 *   source is generated from `thread.toString()` *inside* the bundle
 *   (threadman.js:43). Patching src/ alone would therefore be a no-op for both
 *   the main thread and the workers. One file, 170 KB, ~5.6k lines.
 *
 * Every replacement is anchored on an exact source string and asserted to occur
 * exactly once. If upstream changes, this script fails loudly instead of
 * producing a half-instrumented copy.
 *
 * Usage:
 *   node scripts/m5_build_vendor.cjs [--force]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'node_modules', 'ffjavascript');
const DEST = path.join(ROOT, 'vendor', 'ffjavascript-0.3.1-m5');
const BUNDLE = path.join(DEST, 'build', 'main.cjs');
const RUNTIME = path.join(DEST, 'build', 'm5_runtime.cjs');

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, ent.name);
    const b = path.join(to, ent.name);
    if (ent.isDirectory()) copyTree(a, b);
    else if (ent.isFile()) fs.copyFileSync(a, b);
  }
}

// ---------------------------------------------------------------------------
// The runtime module (main thread only; the worker gets an inlined copy of the
// few constants it needs because thread.toString() cannot require anything).
// ---------------------------------------------------------------------------
const RUNTIME_SRC = `'use strict';
/*
 * M5 instrumentation runtime -- main thread only.
 * Injected by scripts/m5_build_vendor.cjs; do not edit inside vendor/.
 *
 * Contract:
 *   - When M5 is off, every entry point is a no-op and the callers keep their
 *     original code path (see the "M5 && M5.on ? ... : undefined" guards).
 *   - Every event is one JSON line, appended in batches (no sync write per
 *     event on the hot path).
 *   - Nothing here reads a "current call" global: callers pass an explicit ctx
 *     down to queueAction (see the patch in build/main.cjs).
 */

const fs = require('fs');

let cfg = { trace: false, out: '', run_id: '', flush_every: 256, heap_sample_ms: 0 };
const cfgPath = process.env.M5_CONFIG || '';
if (cfgPath) {
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
  } catch (e) {
    process.stderr.write('m5_runtime: cannot read M5_CONFIG ' + cfgPath + ': ' + e.message + '\\n');
  }
}
const ON = cfg.trace === true || process.env.M5_TRACE === '1';

let fd = null;
let buf = [];
let written = 0;
let dropped = 0;
let taskSeq = 0;
let callSeq = 0;
let t0hr = process.hrtime.bigint();
let t0ms = Date.now();
let sampling = null;

function now() {
  return Number(process.hrtime.bigint() - t0hr) / 1e6;
}

function flush() {
  if (!fd || buf.length === 0) return;
  const chunk = buf.join('\\n') + '\\n';
  buf = [];
  try {
    fs.writeSync(fd, chunk);
    written += 1;
  } catch (e) {
    dropped += 1;
  }
}

function emit(ev) {
  if (!ON) return;
  ev.t_ms = Math.round(now() * 1000) / 1000;
  buf.push(JSON.stringify(ev));
  if (buf.length >= (cfg.flush_every || 256)) flush();
}

function start(provenance) {
  if (!ON) return false;
  if (!cfg.out) {
    process.stderr.write('m5_runtime: M5_TRACE is on but M5_CONFIG has no "out"\\n');
    return false;
  }
  fs.mkdirSync(require('path').dirname(cfg.out), { recursive: true });
  fd = fs.openSync(cfg.out, 'a');
  emit({ ev: 'provenance', run_id: cfg.run_id, ...provenance });
  emit({ ev: 'anchor', t0_epoch_ms: t0ms, t0_hr: String(t0hr), node: process.version, pid: process.pid,
         page_bytes: 65536, mem_size_pages: 25, maxmem_pages: 32767,
         cpus: require('os').cpus().length });
  process.on('exit', function () {
    emit({ ev: 'summary', tasks: taskSeq, calls: callSeq, batches_written: written, dropped });
    flush();
    if (fd) { try { fs.closeSync(fd); } catch (e) {} }
  });
  if (cfg.heap_sample_ms > 0) {
    sampling = setInterval(function () {
      const m = process.memoryUsage();
      emit({ ev: 'heap_sample', rss: m.rss, heap_used: m.heapUsed, heap_total: m.heapTotal,
             external: m.external, array_buffers: m.arrayBuffers });
    }, cfg.heap_sample_ms);
    if (sampling.unref) sampling.unref();
  }
  return true;
}

/** New logical call (one MSM / batchConvert / FFT invocation). */
function plan(kind, site, fields) {
  if (!ON) return null;
  const ctx = Object.assign({ call_id: ++callSeq, kind: kind, site: site }, fields || {});
  emit(Object.assign({ ev: kind + '_plan' }, ctx));
  return ctx;
}

/** Derive a sub-context: same call_id, extra fields, never reads globals. */
function sub(ctx, fields) {
  if (!ctx) return null;
  return Object.assign({}, ctx, fields || {});
}

/** Bind a task id at ENQUEUE time (not at dispatch time). */
function bind(ctx) {
  if (!ON || !ctx) return null;
  const c = Object.assign({}, ctx);
  c.task_id = ++taskSeq;
  return c;
}

const UNLABELED = { call_id: 0, kind: 'unlabeled', site: 'unlabeled' };
function unlabeled() {
  return ON ? UNLABELED : null;
}

/**
 * Split the command payload into the three quantities that were previously
 * collapsed into one send_bytes (M5-E.1, review finding #1):
 *
 *   clone  = ALLOCSET + SET   -- buffers actually serialised into the worker
 *                                message (structured clone, no transfer list)
 *   alloc  = ALLOCSET + ALLOC -- bytes the worker reserves in its own WASM
 *                                linear memory (allocBuffer() = alloc + set);
 *                                never crosses the boundary
 *   get    = GET              -- bytes the worker is asked to hand back; this is
 *                                a request size, the real copy is out_bytes
 *
 * Adding these together (the old behaviour) inflated every MSM task by one
 * s_out (144/288 B) and every FFT / BatchConvert task by 2-3x, because those
 * tasks are ALLOC + SET + GET of the same buffer.
 *
 * Identity used as a cross-check: alloc == sum(worker_task.allocs), because
 * allocs[] records every alloc() call, and ALLOCSET is exactly one of them.
 */
function payloadBytes(task) {
  const r = { clone: 0, alloc: 0, get: 0, cmds: 0 };
  if (!Array.isArray(task)) return r;
  for (const cmd of task) {
    if (!cmd) continue;
    r.cmds += 1;
    if (cmd.cmd === 'ALLOCSET') {
      // allocBuffer() = alloc(byteLength) + setBuffer(). This command therefore
      // contributes to BOTH quantities: the buffer is cloned across the boundary
      // AND reserved in the worker's linear memory.
      const n = cmd.buff ? cmd.buff.byteLength : 0;
      r.clone += n;
      r.alloc += n;
    } else if (cmd.cmd === 'SET') {
      // setBuffer into a variable that was already ALLOCed: clone only.
      r.clone += cmd.buff ? cmd.buff.byteLength : 0;
    } else if (cmd.cmd === 'ALLOC') {
      r.alloc += cmd.len || 0;
    } else if (cmd.cmd === 'GET') {
      r.get += cmd.len || 0;
    }
  }
  return r;
}

/** Small ctx shipped to the worker (kept tiny: it is cloned per task). */
function wire(ctx) {
  return { task_id: ctx.task_id, call_id: ctx.call_id, site: ctx.site, kind: ctx.kind };
}

function emitSend(ctx, bytes) {
  if (!ON || !ctx) return;
  const b = typeof bytes === 'number' ? { clone: bytes, alloc: 0, get: 0, cmds: 0 } : bytes;
  emit({ ev: 'task_send', task_id: ctx.task_id, call_id: ctx.call_id, site: ctx.site,
         kind: ctx.kind, worker: ctx.worker, t_send_ms: ctx.t_send_ms,
         clone_buffer_bytes: b.clone, wasm_alloc_bytes: b.alloc, worker_output_bytes: b.get,
         cmd_count: b.cmds,
         n_points: ctx.points || ctx.chunk_points || ctx.n_points || null,
         s_scalar: ctx.s_scalar === undefined ? null : ctx.s_scalar,
         bit_chunk: ctx.bit_chunk === undefined ? null : ctx.bit_chunk,
         pc_idx: ctx.pc_idx === undefined ? null : ctx.pc_idx,
         bc_idx: ctx.bc_idx === undefined ? null : ctx.bc_idx,
         chunk_idx: ctx.chunk_idx === undefined ? null : ctx.chunk_idx });
}

/** Merge the worker snapshot with the enqueue-time ctx and return the outputs.
 *  "payload" is the raw message: { __m5: snapshot, out: outputs }. */
function ingest(payload, ctx, worker) {
  const snap = payload && payload.__m5;
  const out = payload && payload.out;
  if (ON && snap) {
    emit({ ev: 'worker_task', task_id: ctx ? ctx.task_id : null,
           call_id: ctx ? ctx.call_id : (snap.call_id || 0),
           site: ctx ? ctx.site : 'unlabeled',
           worker: worker,
           alloc_base: snap.alloc_base, wasm_before: snap.wasm_before, wasm_after: snap.wasm_after,
           alloc_top: snap.alloc_top, allocs: snap.allocs, grow_events: snap.grow_events,
           allocset_bytes: snap.allocset_bytes, set_bytes: snap.set_bytes,
           get_bytes: snap.get_bytes, out_bytes: snap.out_bytes, cmd_count: snap.cmd_count,
           t_hr_start: snap.t_hr_start, t_hr_end: snap.t_hr_end,
           w_heap_used: snap.heap_used, w_external: snap.external, w_array_buffers: snap.array_buffers });
  }
  return out;
}

function done(ctx) {
  if (!ON || !ctx) return;
  emit({ ev: 'task_done', task_id: ctx.task_id, call_id: ctx.call_id, worker: ctx.worker,
         svc_ms: Math.round((now() - (ctx.t_send_ms || now())) * 1000) / 1000 });
}

module.exports = {
  on: ON,
  cfg: cfg,
  start: start,
  plan: plan,
  sub: sub,
  bind: bind,
  unlabeled: unlabeled,
  payloadBytes: payloadBytes,
  wire: wire,
  emitSend: emitSend,
  ingest: ingest,
  done: done,
  emit: emit,
  flush: flush,
  now: now,
};
`;

// ---------------------------------------------------------------------------
// Patch set. Each entry: [label, find, replace] applied to build/main.cjs.
// ---------------------------------------------------------------------------
const PATCHES = [
  [
    'P1 runtime require',
    `'use strict';

var crypto = require('crypto');`,
    `'use strict';

var M5 = require('./m5_runtime.cjs');
var crypto = require('crypto');`,
  ],

  [
    'P2 worker: M5 constants + task recorder',
    `function thread(self) {
    const MAXMEM = 32767;
    let instance;
    let memory;
`,
    `function thread(self) {
    const MAXMEM = 32767;
    let instance;
    let memory;
    // M5: the worker cannot require() anything (thread.toString() -> data URL),
    // so the switch and the recorder live inline. Off => zero behaviour change.
    const M5_ON = (typeof process !== "undefined") && process.env && process.env.M5_TRACE === "1";
    let M5_CUR = null;
    // M5-E.1: memory.grow() happens *inside* the task, but the main thread only
    // learns about it when postMessage arrives. hrtime.bigint() is a single
    // process-wide monotonic clock shared by every worker thread, so recording it
    // here lets the analyser put the grow on the same axis as main-thread events
    // (the origin is published once, in the "anchor" event).
    const M5_HR = (M5_ON && typeof process !== "undefined" && process.hrtime)
        ? function () { return String(process.hrtime.bigint()); } : null;
`,
  ],

  [
    'P3 worker: unwrap the ctx envelope',
    `        self.onmessage = function(e) {
            let data;
            if (e.data) {
                data = e.data;
            } else {
                data = e;
            }

            if (data[0].cmd == "INIT") {`,
    `        self.onmessage = function(e) {
            let data;
            if (e.data) {
                data = e.data;
            } else {
                data = e;
            }

            let m5ctx = null;
            if (M5_ON && data && data.__m5ctx) {
                m5ctx = data.__m5ctx;
                data = data.cmds;
            }

            if (data[0].cmd == "INIT") {`,
  ],

  [
    'P4 worker: pass ctx into runTask',
    `            } else {
                const res = runTask(data);
                self.postMessage(res);
            }`,
    `            } else {
                const res = runTask(data, m5ctx);
                self.postMessage(res);
            }`,
  ],

  [
    'P5 worker: record every alloc + grow event',
    `    function alloc(length) {
        const u32 = new Uint32Array(memory.buffer, 0, 1);
        while (u32[0] & 3) u32[0]++;  // Return always aligned pointers
        const res = u32[0];
        u32[0] += length;
        if (u32[0] + length > memory.buffer.byteLength) {
            const currentPages = memory.buffer.byteLength / 0x10000;
            let requiredPages = Math.floor((u32[0] + length) / 0x10000)+1;
            if (requiredPages>MAXMEM) requiredPages=MAXMEM;
            memory.grow(requiredPages-currentPages);
        }
        return res;
    }`,
    `    function alloc(length) {
        const u32 = new Uint32Array(memory.buffer, 0, 1);
        while (u32[0] & 3) u32[0]++;  // Return always aligned pointers
        const res = u32[0];
        u32[0] += length;
        let m5idx = -1;
        if (M5_CUR) m5idx = M5_CUR.allocs.push(length) - 1;
        if (u32[0] + length > memory.buffer.byteLength) {
            const currentPages = memory.buffer.byteLength / 0x10000;
            let requiredPages = Math.floor((u32[0] + length) / 0x10000)+1;
            if (requiredPages>MAXMEM) requiredPages=MAXMEM;
            if (M5_CUR) {
                // M5-E.2: record the grow on BOTH sides of memory.grow() so the
                // analyser can treat [t_hr_before, t_hr_after] as the capacity
                // change window. t_hr keeps the pre-call value for backward
                // compatibility with any reader that predates this split.
                // m5top is captured BEFORE memory.grow() detaches the current
                // linear-memory view (u32); reading u32[0] after grow yields
                // undefined, which broke the L2 grow.top replay (grow_ts FAIL).
                const m5hrB = M5_HR ? M5_HR() : null;
                const m5top = u32[0];
                memory.grow(requiredPages-currentPages);
                M5_CUR.grow_events.push({at_alloc: m5idx, len: length,
                    from_pages: currentPages, to_pages: requiredPages, top: m5top,
                    t_hr_before: m5hrB, t_hr: m5hrB,
                    t_hr_after: M5_HR ? M5_HR() : null});
            } else {
                memory.grow(requiredPages-currentPages);
            }
        }
        return res;
    }`,
  ],

  [
    'P6 worker: runTask snapshot',
    `    function runTask(task) {
        if (task[0].cmd == "INIT") {
            return init(task[0]);
        }
        const ctx = {
            vars: [],
            out: []
        };
        const u32a = new Uint32Array(memory.buffer, 0, 1);
        const oldAlloc = u32a[0];`,
    `    function runTask(task, m5ctx) {
        if (task[0].cmd == "INIT") {
            return init(task[0]);
        }
        const ctx = {
            vars: [],
            out: []
        };
        const u32a = new Uint32Array(memory.buffer, 0, 1);
        const oldAlloc = u32a[0];
        const m5 = M5_ON ? { alloc_base: oldAlloc, wasm_before: memory.buffer.byteLength,
            allocs: [], grow_events: [], allocset_bytes: 0, set_bytes: 0, get_bytes: 0,
            cmd_count: task.length, t_hr_start: M5_HR ? M5_HR() : null } : null;
        M5_CUR = m5;`,
  ],

  [
    'P7 worker: count per-command bytes',
    `            case "ALLOCSET":
                ctx.vars[task[i].var] = allocBuffer(task[i].buff);
                break;
            case "ALLOC":
                ctx.vars[task[i].var] = alloc(task[i].len);
                break;
            case "SET":
                setBuffer(ctx.vars[task[i].var], task[i].buff);
                break;`,
    `            case "ALLOCSET":
                if (m5) m5.allocset_bytes += task[i].buff.byteLength;
                ctx.vars[task[i].var] = allocBuffer(task[i].buff);
                break;
            case "ALLOC":
                ctx.vars[task[i].var] = alloc(task[i].len);
                break;
            case "SET":
                if (m5) m5.set_bytes += task[i].buff.byteLength;
                setBuffer(ctx.vars[task[i].var], task[i].buff);
                break;`,
  ],

  [
    'P8 worker: count GET bytes',
    `            case "GET":
                ctx.out[task[i].out] = getBuffer(ctx.vars[task[i].var], task[i].len).slice();
                break;`,
    `            case "GET":
                if (m5) m5.get_bytes += task[i].len;
                ctx.out[task[i].out] = getBuffer(ctx.vars[task[i].var], task[i].len).slice();
                break;`,
  ],

  [
    'P9 worker: return the snapshot next to the outputs',
    `        const u32b = new Uint32Array(memory.buffer, 0, 1);
        u32b[0] = oldAlloc;
        return ctx.out;
    }`,
    `        const u32b = new Uint32Array(memory.buffer, 0, 1);
        let m5out = null;
        if (m5) {
            m5.alloc_top = u32b[0];
            u32b[0] = oldAlloc;
            m5.wasm_after = memory.buffer.byteLength;
            m5.out_bytes = 0;
            for (let k=0; k<ctx.out.length; k++) m5.out_bytes += ctx.out[k].byteLength;
            if (typeof process !== "undefined" && process.memoryUsage) {
                const mu = process.memoryUsage();
                m5.heap_used = mu.heapUsed; m5.external = mu.external; m5.array_buffers = mu.arrayBuffers;
            }
            m5.call_id = m5ctx ? m5ctx.call_id : 0;
            m5.t_hr_end = M5_HR ? M5_HR() : null;
            m5.task_id = m5ctx && m5ctx.task_id !== undefined ? m5ctx.task_id : null;
            m5out = { __m5: m5, out: ctx.out };
        } else {
            u32b[0] = oldAlloc;
        }
        M5_CUR = null;
        return m5out ? m5out : ctx.out;
    }`,
  ],

  [
    'P10 main: getOnMsg unwraps telemetry and resolves the original shape',
    `            tm.working[i]=false;
            tm.pendingDeferreds[i].resolve(data);
            tm.processWorks();`,
    `            if (M5 && M5.on && data && data.__m5) {
                const d = tm.pendingDeferreds[i];
                data = M5.ingest(data, d && d.__m5ctx, i);
                if (d && d.__m5ctx) M5.done(d.__m5ctx);
            }
            tm.working[i]=false;
            tm.pendingDeferreds[i].resolve(data);
            tm.processWorks();`,
  ],

  [
    'P11 main: postAction carries the ctx and logs task_send',
    `    postAction(workerId, e, transfers, _deferred) {
        if (this.working[workerId]) {
            throw new Error("Posting a job t a working worker");
        }
        this.working[workerId] = true;

        this.pendingDeferreds[workerId] = _deferred ? _deferred : new Deferred();
        this.workers[workerId].postMessage(e, transfers);

        return this.pendingDeferreds[workerId].promise;
    }`,
    `    postAction(workerId, e, transfers, _deferred, m5ctx) {
        if (this.working[workerId]) {
            throw new Error("Posting a job t a working worker");
        }
        this.working[workerId] = true;

        this.pendingDeferreds[workerId] = _deferred ? _deferred : new Deferred();
        if (m5ctx && M5 && M5.on) {
            m5ctx.worker = workerId;
            m5ctx.t_send_ms = M5.now();
            this.pendingDeferreds[workerId].__m5ctx = m5ctx;
            M5.emitSend(m5ctx, M5.payloadBytes(e));
            this.workers[workerId].postMessage({ __m5ctx: M5.wire(m5ctx), cmds: e }, transfers);
        } else {
            this.workers[workerId].postMessage(e, transfers);
        }

        return this.pendingDeferreds[workerId].promise;
    }`,
  ],

  [
    'P12 main: processWorks forwards the enqueue-time ctx',
    `                const work = this.actionQueue.shift();
                this.postAction(i, work.data, work.transfers, work.deferred);`,
    `                const work = this.actionQueue.shift();
                this.postAction(i, work.data, work.transfers, work.deferred, work.m5ctx);`,
  ],

  [
    'P13 main: queueAction binds task_id at enqueue time',
    `    queueAction(actionData, transfers) {
        const d = new Deferred();

        if (this.singleThread) {
            const res = this.taskManager(actionData);
            d.resolve(res);
        } else {
            this.actionQueue.push({
                data: actionData,
                transfers: transfers,
                deferred: d
            });
            this.processWorks();
        }
        return d.promise;
    }`,
    `    queueAction(actionData, transfers, m5ctx) {
        const d = new Deferred();

        if (this.singleThread) {
            const res = this.taskManager(actionData);
            d.resolve(res);
        } else {
            if (M5 && M5.on) {
                m5ctx = M5.bind(m5ctx || M5.unlabeled());
            }
            this.actionQueue.push({
                data: actionData,
                transfers: transfers,
                deferred: d,
                m5ctx: m5ctx
            });
            this.processWorks();
        }
        return d.promise;
    }`,
  ],

  [
    'P14 batchConvert: own plan event + per-chunk ctx',
    `function buildBatchConvert(tm, fnName, sIn, sOut) {
    return async function batchConvert(buffIn) {
        const nPoints = Math.floor(buffIn.byteLength / sIn);
        if ( nPoints * sIn !== buffIn.byteLength) {
            throw new Error("Invalid buffer size");
        }
        const pointsPerChunk = Math.floor(nPoints/tm.concurrency);
        const opPromises = [];`,
    `function buildBatchConvert(tm, fnName, sIn, sOut) {
    return async function batchConvert(buffIn) {
        const nPoints = Math.floor(buffIn.byteLength / sIn);
        if ( nPoints * sIn !== buffIn.byteLength) {
            throw new Error("Invalid buffer size");
        }
        const pointsPerChunk = Math.floor(nPoints/tm.concurrency);
        const m5c = (M5 && M5.on) ? M5.plan('batch', fnName, {n_points: nPoints, s_in: sIn,
            s_out: sOut, n_chunks: tm.concurrency}) : null;
        const opPromises = [];`,
  ],

  [
    'P15 batchConvert: enqueue with ctx',
    `                {cmd: "GET", out: 0, var: 1, len:sOut * n},
            ];
            opPromises.push(
                tm.queueAction(task)
            );
        }`,
    `                {cmd: "GET", out: 0, var: 1, len:sOut * n},
            ];
            opPromises.push(
                tm.queueAction(task, undefined, (M5 && M5.on) ? M5.sub(m5c, {chunk_idx: i, chunk_points: n}) : undefined)
            );
        }`,
  ],

  [
    'P16 _multiExpChunk: signature + per-bit-chunk ctx',
    `    async function _multiExpChunk(buffBases, buffScalars, inType, logger, logText) {`,
    `    async function _multiExpChunk(buffBases, buffScalars, inType, logger, logText, m5c) {`,
  ],

  [
    'P17 _multiExpChunk: enqueue with ctx',
    `            opPromises.push(
                G.tm.queueAction(task)
            );`,
    `            opPromises.push(
                G.tm.queueAction(task, undefined, (M5 && M5.on) ? M5.sub(m5c, {bc_idx: i}) : undefined)
            );`,
  ],

  [
    'P18 _multiExp: plan event + per-point-chunk ctx',
    `        const opPromises = [];
        for (let i=0; i<nPoints; i += chunkSize) {
            if (logger) logger.debug(\`Multiexp start: \${logText}: \${i}/\${nPoints}\`);
            const n= Math.min(nPoints - i, chunkSize);
            const buffBasesChunk = buffBases.slice(i*sGIn, (i+n)*sGIn);
            const buffScalarsChunk = buffScalars.slice(i*sScalar, (i+n)*sScalar);
            opPromises.push(_multiExpChunk(buffBasesChunk, buffScalarsChunk, inType, logger, logText).then( (r) => {`,
    `        const m5c = (M5 && M5.on) ? M5.plan('msm', logText || 'msm', {group: groupName,
            n_points: nPoints, s_scalar: sScalar, s_g: sGIn, in_type: inType,
            bit_chunk: bitChunkSize, n_bit: nChunks,
            chunk_size: chunkSize, n_point_chunk: Math.ceil(nPoints / chunkSize)}) : null;
        const opPromises = [];
        for (let i=0; i<nPoints; i += chunkSize) {
            if (logger) logger.debug(\`Multiexp start: \${logText}: \${i}/\${nPoints}\`);
            const n= Math.min(nPoints - i, chunkSize);
            const buffBasesChunk = buffBases.slice(i*sGIn, (i+n)*sGIn);
            const buffScalarsChunk = buffScalars.slice(i*sScalar, (i+n)*sScalar);
            const m5sub = (M5 && M5.on) ? M5.sub(m5c, {pc_idx: i / chunkSize, points: n}) : undefined;
            opPromises.push(_multiExpChunk(buffBasesChunk, buffScalarsChunk, inType, logger, logText, m5sub).then( (r) => {`,
  ],

  [
    'P19 _fft: plan event',
    `        const l2Chunk = log2(pointsInChunk);

        const promises = [];`,
    `        const l2Chunk = log2(pointsInChunk);

        const m5c = (M5 && M5.on) ? M5.plan('fft', loggerTxt || 'fft', {n_points: nPoints,
            bits: bits, points_in_chunk: pointsInChunk, n_chunks: nChunks,
            inverse: !!inverse}) : null;
        const promises = [];`,
  ],

  [
    'P20 _fft mix: enqueue with ctx',
    `            promises.push(tm.queueAction(task).then( (r) => {
                if (logger) logger.debug(\`\${loggerTxt}: fft \${bits} mix end: \${i}/\${nChunks}\`);`,
    `            promises.push(tm.queueAction(task, undefined, (M5 && M5.on) ? M5.sub(m5c, {phase: 'mix', chunk_idx: i, chunk_points: pointsInChunk}) : undefined).then( (r) => {
                if (logger) logger.debug(\`\${loggerTxt}: fft \${bits} mix end: \${i}/\${nChunks}\`);`,
  ],

  [
    'P21 _fft join: enqueue with ctx',
    `                    opPromises.push(tm.queueAction(task).then( (r) => {
                        if (logger) logger.debug(\`\${loggerTxt}: fft \${bits} join  \${i}/\${bits}  \${j+1}/\${nGroups} \${k}/\${nChunksPerGroup/2}\`);`,
    `                    opPromises.push(tm.queueAction(task, undefined, (M5 && M5.on) ? M5.sub(m5c, {phase: 'join', level: i, group_idx: j, pair_idx: k, chunk_points: pointsInChunk}) : undefined).then( (r) => {
                        if (logger) logger.debug(\`\${loggerTxt}: fft \${bits} join  \${i}/\${bits}  \${j+1}/\${nGroups} \${k}/\${nChunksPerGroup/2}\`);`,
  ],

  [
    'P22 _fft: assembly event',
    `        if (returnArray) {
            return buffer2array(buffOut, sOut);
        } else {
            return buffOut;
        }
    }

    async function _fftExt(buff, inType, outType, logger, loggerTxt) {`,
    `        if (M5 && M5.on) {
        // M5-E.2: chunks_bytes is counted BEFORE the delete loop (see the
        // counting block inserted just above the BigBuffer branch), so it
        // reflects the real transient working set of the assembly, not 0.
        M5.emit({ev: 'fft_assembly', call_id: m5c ? m5c.call_id : null, site: loggerTxt || 'fft',
            n_points: nPoints, s_in: sIn, s_mid: sMid, s_out: sOut,
            copy_bytes: nPoints * sIn, chunks_bytes: m5ChunkBytes, out_bytes: buffOut.byteLength,
            t_hr_start: m5AsmT0hr, t_hr_end: (typeof process !== "undefined" && process.hrtime && process.hrtime.bigint) ? String(process.hrtime.bigint()) : null});
    }
        if (returnArray) {
            return buffer2array(buffOut, sOut);
        } else {
            return buffOut;
        }
    }

    async function _fftExt(buff, inType, outType, logger, loggerTxt) {`,
  ],

  [
    'P24 _fftJoinExt: count chunk bytes + stamp assembly start BEFORE delete',
    `        if (buff instanceof BigBuffer) {
            buffOut = new BigBuffer(nPoints*sOut);
        } else {
            buffOut = new Uint8Array(nPoints*sOut);
        }
        if (inverse) {
            buffOut.set(chunks[0].slice((pointsInChunk-1)*sOut));
            let p= sOut;
            for (let i=nChunks-1; i>0; i--) {
                buffOut.set(chunks[i], p);
                p += pointsInChunk*sOut;
                delete chunks[i];  // Liberate mem
            }
            buffOut.set(chunks[0].slice(0, (pointsInChunk-1)*sOut), p);
            delete chunks[0];
        } else {
            for (let i=0; i<nChunks; i++) {
                buffOut.set(chunks[i], pointsInChunk*sOut*i);
                delete chunks[i];
            }
        }`,
    `        let m5ChunkBytes = 0;
        for (let i=0; i<nChunks; i++) m5ChunkBytes += (chunks[i] ? chunks[i].byteLength : 0);
        const m5AsmT0hr = (typeof process !== "undefined" && process.hrtime && process.hrtime.bigint) ? String(process.hrtime.bigint()) : null;
        if (buff instanceof BigBuffer) {
            buffOut = new BigBuffer(nPoints*sOut);
        } else {
            buffOut = new Uint8Array(nPoints*sOut);
        }
        if (inverse) {
            buffOut.set(chunks[0].slice((pointsInChunk-1)*sOut));
            let p= sOut;
            for (let i=nChunks-1; i>0; i--) {
                buffOut.set(chunks[i], p);
                p += pointsInChunk*sOut;
                delete chunks[i];  // Liberate mem
            }
            buffOut.set(chunks[0].slice(0, (pointsInChunk-1)*sOut), p);
            delete chunks[0];
        } else {
            for (let i=0; i<nChunks; i++) {
                buffOut.set(chunks[i], pointsInChunk*sOut*i);
                delete chunks[i];
            }
        }`,
  ],

  [
    'P23 _fftJoinExt: plan event + ctx (lagrangeEvaluations / fftExt path)',
    `        const opPromises = [];

        for (let i=0; i<nPoints; i += chunkSize) {
            if (logger) logger.debug(\`\${loggerTxt}: fftJoinExt Start: \${i}/\${nPoints}\`);`,
    `        const opPromises = [];
        const m5c = (M5 && M5.on) ? M5.plan('fftjoinext', loggerTxt || 'fftJoinExt', {n_points: nPoints,
            s_in: sIn, s_mid: sMid, s_out: sOut, chunk_size: chunkSize, fn: fn}) : null;

        for (let i=0; i<nPoints; i += chunkSize) {
            if (logger) logger.debug(\`\${loggerTxt}: fftJoinExt Start: \${i}/\${nPoints}\`);`,
  ],

  [
    'P24 _fftJoinExt: enqueue with ctx',
    `            opPromises.push(
                tm.queueAction(task).then( (r) => {
                    if (logger) logger.debug(\`\${loggerTxt}: fftJoinExt End: \${i}/\${nPoints}\`);`,
    `            opPromises.push(
                tm.queueAction(task, undefined, (M5 && M5.on) ? M5.sub(m5c, {chunk_idx: i / chunkSize, chunk_points: n}) : undefined).then( (r) => {
                    if (logger) logger.debug(\`\${loggerTxt}: fftJoinExt End: \${i}/\${nPoints}\`);`,
  ],
];

function applyPatches(src) {
  let out = src;
  const applied = [];
  for (const [label, find, repl] of PATCHES) {
    const parts = out.split(find);
    if (parts.length !== 2) {
      throw new Error(
        `anchor not unique for [${label}]: found ${parts.length - 1} occurrence(s)\n` +
          `--- anchor ---\n${find.slice(0, 300)}\n--------------`
      );
    }
    out = parts[0] + repl + parts[1];
    applied.push(label);
  }
  return { out, applied };
}

function main(argv) {
  const force = argv.includes('--force');
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
  if (pkg.version !== '0.3.1') {
    throw new Error(`expected ffjavascript 0.3.1, found ${pkg.version}`);
  }
  if (fs.existsSync(DEST) && !force) {
    // Rebuild from scratch anyway: the copy is generated, never hand-edited.
    fs.rmSync(DEST, { recursive: true, force: true });
  }
  copyTree(SRC, DEST);

  const before = sha256File(BUNDLE);
  const original = fs.readFileSync(BUNDLE, 'utf8');
  const { out, applied } = applyPatches(original);
  fs.writeFileSync(BUNDLE, out, 'utf8');
  fs.writeFileSync(RUNTIME, RUNTIME_SRC, 'utf8');

  const manifest = {
    experiment: 'M5-B',
    generated_utc: new Date().toISOString(),
    source: 'node_modules/ffjavascript@0.3.1',
    dest: path.relative(ROOT, DEST).replace(/\\/g, '/'),
    target_file: 'build/main.cjs',
    why_bundle: 'package.json exports["."].node.require -> ./build/main.cjs; thread.toString() is taken from this bundle',
    sha256_before: before,
    sha256_after: sha256File(BUNDLE),
    sha256_runtime: sha256File(RUNTIME),
    patches_applied: applied,
    patch_count: applied.length,
  };
  fs.writeFileSync(path.join(DEST, 'M5_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // Human-readable patch artefact (unified diff against the pristine bundle).
  // NOTE: `git diff --no-index` writes the machine-local absolute paths into the header, so the
  // artefact is not portable and carries the local user name. Do NOT "fix" that here: every trace
  // logs patch_sha256 in its `provenance` event, and changing these bytes after the runs would
  // break the binding between the recorded evidence and the committed artefact. Cosmetic
  // normalisation is queued for after the measurement campaign (M5_PROBE_DESIGN 10.16).
  const os = require('os');
  const tmp = path.join(os.tmpdir(), 'ffjs-orig-main.cjs');
  fs.writeFileSync(tmp, original, 'utf8');
  const { spawnSync } = require('child_process');
  const diff = spawnSync('git', ['diff', '--no-index', '--no-color', '--', tmp, BUNDLE], { encoding: 'utf8' });
  const patchPath = path.join(ROOT, 'patches', 'm5-instrumentation.patch');
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, diff.stdout || '', 'utf8');
  const patchSha = sha256File(patchPath);

  console.log(`vendor  : ${manifest.dest}`);
  console.log(`patches : ${applied.length} applied`);
  console.log(`sha256  : ${before} -> ${manifest.sha256_after}`);
  console.log(`runtime : ${manifest.sha256_runtime}`);
  console.log(`patch   : ${path.relative(ROOT, patchPath)} (${patchSha}, ${(diff.stdout || '').length} bytes)`);
  console.log(`manifest: ${path.join(manifest.dest, 'M5_MANIFEST.json')}`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error('m5_build_vendor: ' + e.message);
    process.exit(1);
  }
}
