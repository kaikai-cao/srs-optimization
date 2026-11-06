/*
 * Loaded with `node --require scripts/timestamp_hook.cjs ...`.
 *
 * Prefixes every stdout/stderr line with the elapsed time since Node startup so
 * that snarkjs / ffjavascript debug logs can be used for per-section timing.
 * Uses the ORIGINAL stream.write captured before the override (no recursion).
 * node_modules/snarkjs/build/cli.cjs uses logplease -> console.log -> stdout.
 */
'use strict';

const start = process.hrtime.bigint();
const elapsedMs = () => Number((process.hrtime.bigint() - start) / 1000000n);

function timestampStream(stream) {
  const original = stream.write.bind(stream);
  let pending = '';
  let exiting = false;

  const flush = () => {
    if (pending.length && !exiting) {
      exiting = true;
      try { original(`[t=${elapsedMs()}ms] ${pending}\n`); } catch (_) { /* ignore */ }
      pending = '';
      exiting = false;
    }
  };

  stream.write = function (chunk, encoding, callback) {
    let text;
    if (typeof chunk === 'string') text = chunk;
    else text = Buffer.from(chunk).toString('utf8');
    pending += text;
    let idx;
    while ((idx = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      original(`[t=${elapsedMs()}ms] ${line}\n`);
    }
    if (typeof encoding === 'function') encoding();
    else if (typeof callback === 'function') callback();
    return true;
  };

  process.on('exit', flush);
}

timestampStream(process.stdout);
timestampStream(process.stderr);
