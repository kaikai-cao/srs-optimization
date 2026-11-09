#!/usr/bin/env node
/**
 * M5-B: `--require` hook that redirects `ffjavascript` to the instrumented copy
 * and proves that the redirect actually took effect.
 *
 * Why a resolve hook instead of editing node_modules:
 *   - `node_modules` stays byte-identical to `npm i`, so M1/M2 frozen results stay
 *     re-derivable and an M5 run can never be confused with a pristine run.
 *   - The only supported entry is `--require`, the same mechanism M4 used.
 *
 * Redirect policy:
 *   M5_CONFIG set   -> redirect + (optionally) trace. Lets us run the vendor copy
 *                      with tracing OFF, which is the perturbation control.
 *   M5_CONFIG unset -> no redirect at all, i.e. a pristine run.
 *
 * Provenance (hard gate):
 *   The first JSONL line must be `{"ev":"provenance"}` carrying the resolved
 *   absolute path and the SHA-256 of the instrumented bundle. If the resolved
 *   path is under node_modules/, the run is aborted with exit code 3 BEFORE
 *   snarkjs starts, so a silently un-instrumented measurement cannot exist.
 *
 * Usage (driven by scripts/measure_m5.ps1):
 *   node --require scripts/m5_hook.cjs node_modules/snarkjs/build/cli.cjs ...
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(ROOT, 'vendor', 'ffjavascript-0.3.1-m5');
const VENDOR_MAIN = path.join(VENDOR_ROOT, 'build', 'main.cjs');
const VENDOR_RUNTIME = path.join(VENDOR_ROOT, 'build', 'm5_runtime.cjs');
const PATCH_FILE = path.join(ROOT, 'patches', 'm5-instrumentation.patch');
const MANIFEST = path.join(VENDOR_ROOT, 'M5_MANIFEST.json');

function sha256(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch (e) {
    return null;
  }
}

function fail(msg, code) {
  process.stderr.write('[m5] FATAL: ' + msg + '\n');
  process.exit(code || 3);
}

const cfgPath = process.env.M5_CONFIG || '';
if (!cfgPath) {
  // Pristine run: leave resolution untouched.
  return;
}

// Worker threads inherit process.execArgv, so this hook is loaded once per
// thread as well. They must NOT touch the log: the JSONL has exactly one writer
// (the main thread), and worker telemetry travels back through postMessage.
// They also do not need the redirect -- a worker only evaluates thread.toString().
try {
  if (require('worker_threads').isMainThread === false) return;
} catch (e) {
  /* worker_threads unavailable: treat as main thread */
}

// ---- 1. redirect ----------------------------------------------------------
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'ffjavascript') {
    return origResolve.call(this, VENDOR_MAIN, parent, isMain, options);
  }
  if (request.startsWith('ffjavascript/')) {
    return origResolve.call(this, path.join(VENDOR_ROOT, request.slice('ffjavascript/'.length)), parent, isMain, options);
  }
  return origResolve.call(this, request, parent, isMain, options);
};

// ---- 2. self-check --------------------------------------------------------
for (const p of [VENDOR_MAIN, VENDOR_RUNTIME]) {
  if (!fs.existsSync(p)) fail('instrumented copy missing: ' + p + ' -- run node scripts/m5_build_vendor.cjs');
}

let resolved;
try {
  resolved = require.resolve('ffjavascript');
} catch (e) {
  fail('require.resolve(ffjavascript) threw: ' + e.message);
}

const normalized = path.resolve(resolved);
if (normalized !== path.resolve(VENDOR_MAIN)) {
  fail(
    'redirect ineffective: require.resolve(ffjavascript) -> ' + normalized +
      ' (expected ' + VENDOR_MAIN + '). Refusing to measure an un-instrumented run.'
  );
}
if (normalized.split(path.sep).includes('node_modules')) {
  fail('redirect resolved into node_modules: ' + normalized);
}

// ---- 3. provenance --------------------------------------------------------
const provenance = {
  resolved: normalized,
  sha256: sha256(VENDOR_MAIN),
  runtime_sha256: sha256(VENDOR_RUNTIME),
  patch_sha256: sha256(PATCH_FILE),
  manifest_sha256: sha256(MANIFEST),
  ffjavascript_version: '0.3.1',
  node: process.version,
  exec_argv: process.argv.slice(0, 4),
};

const runtime = require(VENDOR_RUNTIME);
const started = runtime.start(provenance);

process.stdout.write(
  '[m5] resolved=' + provenance.resolved + '\n' +
    '[m5] sha256=' + provenance.sha256 + ' patch=' + provenance.patch_sha256 + '\n' +
    '[m5] trace=' + (started ? 'ON' : 'OFF') + ' out=' + (runtime.cfg.out || '(none)') + '\n'
);

if (!started) {
  // M5_CONFIG present but trace off: keep the vendor copy, no events.
  process.env.M5_TRACE = '0';
} else {
  // Workers inherit process.env at Worker() construction time, and the worker
  // side reads M5_TRACE directly (it cannot read M5_CONFIG: no fs there).
  process.env.M5_TRACE = '1';
}
