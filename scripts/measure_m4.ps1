<#
.SYNOPSIS
  M4: repeat a snarkjs operation N times with FastFile page-pool instrumentation
  and a per-run memory timeline.

.DESCRIPTION
  Loops measure_snarkjs.ps1 Repeats times for one (operation, power) pair.
  Each iteration:
    - sets M4_FASTFILE_OUT to a per-run JSON consumed by m4_instrument.js
    - passes -ExtraRequire scripts/m4_instrument.js (FastFile page-pool probe)
  measure_snarkjs.ps1 always records a per-poll memory timeline, which since M4.1
  carries BOTH the current commit charge (Process.PagedMemorySize64) and the
  historical peak (Process.PeakPagedMemorySize64).
  After the loop it writes a manifest JSON listing every run, then calls
  build_m4_summary.cjs to produce the aggregated CSV / markdown tables.

  -Prefix controls the run-label prefix (default 'm4'). Use e.g. 'm4_1' to add a
  calibration set without overwriting the frozen M4 runs.

  This is the M4 baseline step: 3-5 independent repeats of Prepared Verify at
  Power 16 / 18, recorded with Peak Working Set + Peak Pagefile + FastFile pool.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Operation,

    [Parameter(Mandatory = $true)]
    [int]$Power,

    [Parameter(Mandatory = $true)]
    [string]$InputPath,

    [int]$Repeats = 3,

    # Run-label prefix, e.g. 'm4' -> m4_prepared_verify_p18_r1.
    [string]$Prefix = 'm4',

    [int]$PollIntervalMs = 50,

    [int]$TimeoutSec = 0,

    [string]$ResultsDir = 'results/raw',

    [string]$LogDir = 'results/raw/m4_logs',

    [string]$Instrument = 'scripts/m4_instrument.js',

    [string]$SummaryOut = 'results/processed/m4_summary.csv',

    [string]$NodeExe = ''
)

$validOps = @('phase1_verify', 'prepare_phase2', 'prepared_verify')
if ($validOps -notcontains $Operation) {
    throw "Operation must be one of: $($validOps -join ', ')"
}

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$measurer = Join-Path $PSScriptRoot 'measure_snarkjs.ps1'
$builder = Join-Path $PSScriptRoot 'build_m4_summary.cjs'

if (-not (Test-Path -LiteralPath $measurer)) { throw "measurer not found: $measurer" }
$instrumentFull = if ([System.IO.Path]::IsPathRooted($Instrument)) {
    $Instrument
} else {
    Join-Path $repoRoot $Instrument
}
if (-not (Test-Path -LiteralPath $instrumentFull)) { throw "instrument not found: $instrumentFull" }

$resultsFull = Join-Path $repoRoot $ResultsDir
$logsFull = Join-Path $repoRoot $LogDir
New-Item -ItemType Directory -Force -Path $resultsFull, $logsFull | Out-Null

$runs = [System.Collections.Generic.List[object]]::new()

Write-Output ("=== M4 baseline: operation=$Operation power=$Power repeats=$Repeats prefix=$Prefix ===")

for ($i = 1; $i -le $Repeats; $i++) {
    $label = "${Prefix}_${Operation}_p${Power}_r${i}"
    $ffOut = Join-Path $resultsFull "${label}.fastfile.json"

    # Per-run FastFile pool output (consumed by m4_instrument.js at node exit).
    $env:M4_FASTFILE_OUT = $ffOut

    Write-Output ("--- repeat $i/$Repeats (label=$label) ---")

    $mArgs = @{
        Operation = $Operation
        Power = $Power
        InputPath = $InputPath
        Label = $label
        ResultsDir = $ResultsDir
        LogDir = $LogDir
        PollIntervalMs = $PollIntervalMs
        ExtraRequire = $instrumentFull
    }
    if ($TimeoutSec -gt 0) { $mArgs['TimeoutSec'] = $TimeoutSec }
    if ($NodeExe) { $mArgs['NodeExe'] = $NodeExe }

    & $measurer @mArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Output ("  WARN: measurer exited with code $LASTEXITCODE for $label")
    }

    $runJson = Join-Path $resultsFull "${label}.json"
    $runs.Add([ordered]@{
        repeat      = $i
        label       = $label
        run_json    = $runJson
        fastfile_json = $ffOut
    })
}

# Manifest
$manifest = [ordered]@{
    experiment = 'M4-repeat-baseline'
    operation  = $Operation
    power      = $Power
    repeats    = $Repeats
    prefix     = $Prefix
    instrument = 'm4_instrument.js (FastFile page-pool probe, synchronized snapshots)'
    runs       = $runs
}
$manifestPath = Join-Path $resultsFull "${Prefix}_manifest_${Operation}_p${Power}.json"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6) + "`n", $utf8)
Write-Output ("manifest: " + (Join-Path $ResultsDir (Split-Path $manifestPath -Leaf)))

# Aggregate
$buildArgs = @($manifestPath, '--out', (Join-Path $repoRoot $SummaryOut))
Write-Output ("=== building summary: node build_m4_summary.cjs ===")
& node $builder @buildArgs
if ($LASTEXITCODE -ne 0) {
    Write-Output ("  WARN: summary builder exited with code $LASTEXITCODE")
}
