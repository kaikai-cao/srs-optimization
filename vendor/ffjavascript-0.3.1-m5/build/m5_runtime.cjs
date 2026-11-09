'use strict';
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
    process.stderr.write('m5_runtime: cannot read M5_CONFIG ' + cfgPath + ': ' + e.message + '\n');
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
  const chunk = buf.join('\n') + '\n';
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
    process.stderr.write('m5_runtime: M5_TRACE is on but M5_CONFIG has no "out"\n');
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
