<#
.SYNOPSIS
  M5: run snarkjs with the instrumented ffjavascript copy and record JSONL events.

.DESCRIPTION
  Thin driver over measure_snarkjs.ps1. It only decides WHICH ffjavascript gets
  loaded and whether tracing is on, then delegates all Windows measurement
  (Peak Working Set, commit charge, per-poll timeline) to the M3/M4 measurer so
  the numbers stay comparable with M4.1.

  Three modes, and the differences between them are the whole point:

    pristine  node_modules/ffjavascript, no hook, no events. This is the M4.1
              baseline path (identical command line apart from the label).
    vendor    instrumented copy loaded, M5_TRACE=0. Measures the perturbation
              introduced by loading the patched bundle (should be ~0) without
              emitting events.
    trace     instrumented copy loaded, M5_TRACE=1, JSONL written.

  M5-C requires all three on p10 before any p16/p18 attribution run.

  Output per run:
    results/raw/m5_<op>_p<p>_r<n>.json            (measurer output)
    results/raw/m5_<op>_p<p>_r<n>.timeline.json   (measurer timeline)
    results/raw/m5_<op>_p<p>_r<n>.jsonl           (trace only)
    results/raw/m5_<op>_p<p>_r<n>.config.json     (trace only: exact probe config)
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Operation,

    [Parameter(Mandatory = $true)]
    [int]$Power,

    [Parameter(Mandatory = $true)]
    [string]$InputPath,

    [string]$OutputPath = '',

    [ValidateSet('pristine', 'vendor', 'trace')]
    [string]$Mode = 'trace',

    [int]$Repeats = 1,

    [int]$PollIntervalMs = 25,

    [int]$TimeoutSec = 0,

    [string]$ResultsDir = 'results/raw',

    [string]$LogDir = 'results/raw/m5_logs',

    [int]$FlushEvery = 256,

    [int]$HeapSampleMs = 0,

    [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$measurer = Join-Path $PSScriptRoot 'measure_snarkjs.ps1'
$hook = Join-Path $PSScriptRoot 'm5_hook.cjs'
$vendorMain = Join-Path $repoRoot 'vendor\ffjavascript-0.3.1-m5\build\main.cjs'

if (-not (Test-Path -LiteralPath $measurer)) { throw "measurer not found: $measurer" }
if ($Mode -ne 'pristine') {
    if (-not (Test-Path -LiteralPath $hook)) { throw "hook not found: $hook" }
    if (-not (Test-Path -LiteralPath $vendorMain)) {
        throw "instrumented copy missing: $vendorMain -- run: node scripts/m5_build_vendor.cjs"
    }
}

$resultsFull = Join-Path $repoRoot $ResultsDir
New-Item -ItemType Directory -Force -Path $resultsFull, (Join-Path $repoRoot $LogDir) | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

$manifestRuns = [System.Collections.Generic.List[object]]::new()
$prefix = "m5_$Mode"

Write-Output ("=== M5: operation=$Operation power=$Power mode=$Mode repeats=$Repeats ===")

for ($i = 1; $i -le $Repeats; $i++) {
    $label = "${prefix}_${Operation}_p${Power}_r${i}"
    $jsonl = Join-Path $resultsFull "$label.jsonl"
    $cfgPath = Join-Path $resultsFull "$label.config.json"

    $prevCfg = $env:M5_CONFIG
    $prevTrace = $env:M5_TRACE
    try {
        if ($Mode -eq 'pristine') {
            Remove-Item Env:M5_CONFIG -ErrorAction SilentlyContinue
            Remove-Item Env:M5_TRACE -ErrorAction SilentlyContinue
        } else {
            if (Test-Path -LiteralPath $jsonl) { Remove-Item -LiteralPath $jsonl -Force }
            $cfg = [ordered]@{
                trace         = [bool]($Mode -eq 'trace')
                out           = $jsonl
                run_id        = $label
                flush_every   = $FlushEvery
                heap_sample_ms = $HeapSampleMs
            }
            [System.IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 4) + "`n", $utf8)
            $env:M5_CONFIG = $cfgPath
            $env:M5_TRACE = if ($Mode -eq 'trace') { '1' } else { '0' }
        }

        $mArgs = @{
            Operation      = $Operation
            Power          = $Power
            InputPath      = $InputPath
            Label          = $label
            ResultsDir     = $ResultsDir
            LogDir         = $LogDir
            PollIntervalMs = $PollIntervalMs
        }
        if ($OutputPath) { $mArgs['OutputPath'] = $OutputPath }
        if ($TimeoutSec -gt 0) { $mArgs['TimeoutSec'] = $TimeoutSec }
        if ($NodeExe) { $mArgs['NodeExe'] = $NodeExe }
        if ($Mode -ne 'pristine') { $mArgs['ExtraRequire'] = $hook }

        Write-Output ("--- repeat $i/$Repeats label=$label ---")
        & $measurer @mArgs

        $events = 0
        if ($Mode -eq 'trace' -and (Test-Path -LiteralPath $jsonl)) {
            # -ReadCount 0 hands back ONE array; Measure-Object -Line then reports 1.
            # Count lines directly on the file handle instead.
            $events = 0
            $fs = [System.IO.File]::OpenRead($jsonl)
            try {
                $sr = New-Object System.IO.StreamReader($fs)
                while ($null -ne $sr.ReadLine()) { $events++ }
                $sr.Dispose()
            }
            finally { $fs.Dispose() }
        }
        $manifestRuns.Add([ordered]@{
            repeat   = $i
            label    = $label
            mode     = $Mode
            jsonl    = if ($Mode -eq 'trace') { $jsonl } else { '' }
            config   = if ($Mode -eq 'pristine') { '' } else { $cfgPath }
            events   = $events
        })
        Write-Output ("  events: $events")
    }
    finally {
        if ($null -eq $prevCfg) { Remove-Item Env:M5_CONFIG -ErrorAction SilentlyContinue } else { $env:M5_CONFIG = $prevCfg }
        if ($null -eq $prevTrace) { Remove-Item Env:M5_TRACE -ErrorAction SilentlyContinue } else { $env:M5_TRACE = $prevTrace }
    }
}

$manifest = [ordered]@{
    experiment = 'M5-probe'
    operation  = $Operation
    power      = $Power
    mode       = $Mode
    repeats    = $Repeats
    poll_ms    = $PollIntervalMs
    vendor     = 'vendor/ffjavascript-0.3.1-m5/build/main.cjs'
    hook       = 'scripts/m5_hook.cjs'
    runs       = $manifestRuns
    timestamp_utc = (Get-Date).ToUniversalTime().ToString('o')
}
$manifestPath = Join-Path $resultsFull "${prefix}_manifest_${Operation}_p${Power}.json"
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6) + "`n", $utf8)
Write-Output ("manifest: " + $manifestPath)
