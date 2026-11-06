#!/usr/bin/env node
/*
 * M3-B environment record.
 *
 * Writes results/raw/m3_environment.json with values collected at runtime.
 * Nothing here is a benchmark result; it is the fixed-context record that
 * accompanies every m3_*.json measurement.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const outPath = path.join(repoRoot, 'results', 'raw', 'm3_environment.json');

function pkg(name) {
  try {
    return require(path.join(repoRoot, 'node_modules', name, 'package.json')).version;
  } catch {
    return null;
  }
}

function ps(expr) {
  try {
    // Force UTF-8 stdout so Chinese Windows edition strings are not mojibake.
    const command =
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + expr;
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    ).trim();
  } catch (e) {
    return `unavailable: ${e.message.split('\n')[0]}`;
  }
}

function disk() {
  try {
    const s = fs.statfsSync('D:\\');
    const block = s.bsize;
    return {
      drive: 'D:',
      total_bytes: s.blocks * block,
      free_bytes: s.bavail * block,
      block_size: block,
    };
  } catch (e) {
    return { drive: 'D:', error: e.message };
  }
}

const env = {
  record: 'M3-B environment',
  collected_at_utc: new Date().toISOString(),
  platform: 'Windows native (Git Bash / PowerShell 5.1), NOT WSL',
  os: {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    caption: ps('(Get-CimInstance Win32_OperatingSystem).Caption'),
    version: ps('(Get-CimInstance Win32_OperatingSystem).Version'),
  },
  cpu: {
    model: os.cpus()[0] ? os.cpus()[0].model : null,
    logical_cores: os.cpus().length,
    ffjavascript_tm_concurrency: Math.min(os.cpus().length, 64),
  },
  memory: {
    total_bytes: os.totalmem(),
    free_bytes_at_record: os.freemem(),
  },
  disk: disk(),
  runtime: {
    node_version: process.versions.node,
    node_version_string: `v${process.versions.node}`,
    v8: process.versions.v8,
    modules: process.versions.modules,
    snarkjs_version: pkg('snarkjs'),
    ffjavascript_version: pkg('ffjavascript'),
    binfileutils_version: pkg('@iden3/binfileutils'),
    fastfile_version: pkg('fastfile'),
    powershell_version: ps('$PSVersionTable.PSVersion.ToString()'),
  },
  metric: {
    name: 'Windows Peak Working Set',
    field: 'peak_working_set_bytes',
    api: 'System.Diagnostics.Process.PeakWorkingSet64',
    definition:
      'Peak resident working set (RAM-resident pages) of the measured node.exe process, ' +
      'polled while running and read once more after exit; the maximum sample is reported.',
    caveats: [
      'NOT Linux Maximum RSS and NOT Private Bytes / Commit Charge.',
      'Includes shared pages; excludes pages paged out to disk.',
      'Working-set trimming by the OS can lower the observed value.',
      'Worker threads share the process working set; child processes would not.',
      'All M3 comparisons use this single metric, so the comparison is internally consistent.',
    ],
  },
  method: {
    launcher: 'node.exe launched directly (no npx/cmd shim), so the measured process IS snarkjs',
    cli_entry: 'node_modules/snarkjs/build/cli.cjs',
    polling_interval_ms: 25,
    timing: 'Stopwatch around Process.Start -> WaitForExit (wall clock, includes startup)',
    input_hash: 'SHA-256 via Get-FileHash -Algorithm SHA256',
    logs: 'stdout/stderr captured to results/raw/m3_logs/*.log with [t=...ms] prefixes',
  },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(env, null, 2) + '\n', 'utf8');
console.log(`written: ${path.relative(repoRoot, outPath)}`);
console.log(JSON.stringify({
  node: env.runtime.node_version_string,
  snarkjs: env.runtime.snarkjs_version,
  ffjavascript: env.runtime.ffjavascript_version,
  cores: env.cpu.logical_cores,
  ram_GiB: +(env.memory.total_bytes / 2 ** 30).toFixed(2),
  disk_free_GiB: env.disk.free_bytes ? +(env.disk.free_bytes / 2 ** 30).toFixed(2) : null,
}, null, 2));
