<#
.SYNOPSIS
  M3-B: measure ONE snarkjs invocation as an independent Windows process.

.DESCRIPTION
  Launches node.exe DIRECTLY (no npx/cmd shim, so the measured process really is
  snarkjs), records:
    - full command line and dependency versions
    - input SHA-256 / size (and output SHA-256 / size when applicable)
    - wall-clock elapsed time
    - Windows Peak Working Set via Process.PeakWorkingSet64, polled at 25 ms
      while the process runs and read once more after exit (max sample wins)
    - exit code, timeout flag
    - stdout / stderr logs, each line prefixed with [t=NNNms]

  Writes exactly one JSON: results/raw/m3_<operation>_p<power>.json

.NOTES
  "Peak Working Set" is NOT Linux Maximum RSS and NOT Private Bytes. See
  results/raw/m3_environment.json -> metric.caveats. All M3 numbers use this
  single metric so comparisons are internally consistent.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('phase1_verify', 'prepare_phase2', 'prepared_verify')]
    [string]$Operation,

    [Parameter(Mandatory = $true)]
    [int]$Power,

    [Parameter(Mandatory = $true)]
    [string]$InputPath,

    [string]$OutputPath = '',

    [string]$Label = '',

    [string]$ResultsDir = 'results/raw',

    [string]$LogDir = 'results/raw/m3_logs',

    [int]$PollIntervalMs = 25,

    [int]$TimeoutSec = 0,

    [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$script:Hook = Join-Path $repoRoot 'scripts\timestamp_hook.cjs'
$script:Cli = Join-Path $repoRoot 'node_modules\snarkjs\build\cli.cjs'

function Resolve-RepoPath([string]$p) {
    if ([System.IO.Path]::IsPathRooted($p)) { return (Resolve-Path -LiteralPath $p).Path }
    return (Resolve-Path -LiteralPath (Join-Path $repoRoot $p)).Path
}

function Get-Rel([string]$full) {
    if ($full.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $full.Substring($repoRoot.Length).TrimStart('\', '/').Replace('\', '/')
    }
    return $full
}

function Quote-Arg([string]$s) {
    return '"' + $s.Replace('"', '\"') + '"'
}

if (-not $NodeExe) {
    $cmd = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $NodeExe = $cmd.Source
}

$inFull = Resolve-RepoPath $InputPath
if (-not (Test-Path -LiteralPath $inFull -PathType Leaf)) {
    throw "input not found: $inFull"
}

# ---- Build the exact CLI argument vector -----------------------------------
switch ($Operation) {
    'phase1_verify' {
        $cliArgs = @('powersoftau', 'verify', $inFull, '-v')
        $outFull = ''
    }
    'prepare_phase2' {
        if (-not $OutputPath) { throw 'prepare_phase2 requires -OutputPath' }
        # Normalise separators: callers may pass data/fixtures/... with forward slashes.
        $outFull = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputPath))
        $fixtureRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'data\fixtures'))
        if (-not $outFull.StartsWith($fixtureRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "refusing to write outside data/fixtures: $outFull"
        }
        # No delete here: snarkjs createOverride() opens with O_TRUNC, so a
        # successful run replaces the file. A failed run is detected via the
        # exit code + LastWriteTimeUtc check below (no destructive operations).
        $cliArgs = @('powersoftau', 'prepare', 'phase2', $inFull, $outFull, '-v')
    }
    'prepared_verify' {
        $cliArgs = @('powersoftau', 'verify', $inFull, '-v')
        $outFull = ''
    }
}

$nodeArgs = @('--require', $Hook, $Cli) + $cliArgs
$argLine = ($nodeArgs | ForEach-Object { Quote-Arg $_ }) -join ' '
$commandLine = "$(Quote-Arg $NodeExe) $argLine"

if (-not $Label) { $Label = "m3_${Operation}_p${Power}" }

$resultsFull = Join-Path $repoRoot $ResultsDir
$logsFull = Join-Path $repoRoot $LogDir
New-Item -ItemType Directory -Force -Path $resultsFull, $logsFull | Out-Null
$stdoutLog = Join-Path $logsFull "$Label.stdout.log"
$stderrLog = Join-Path $logsFull "$Label.stderr.log"
$jsonPath = Join-Path $resultsFull "$Label.json"

# ---- Fixed dependency versions (read from installed packages) --------------
$snarkjsVersion = (Get-Content -LiteralPath (Join-Path $repoRoot 'node_modules\snarkjs\package.json') -Raw | ConvertFrom-Json).version
$ffjsVersion = (Get-Content -LiteralPath (Join-Path $repoRoot 'node_modules\ffjavascript\package.json') -Raw | ConvertFrom-Json).version
$nodeVersion = (& $NodeExe -v).Trim()

# ---- Input identity ---------------------------------------------------------
$inputBytes = (Get-Item -LiteralPath $inFull).Length
$inputHash = (Get-FileHash -LiteralPath $inFull -Algorithm SHA256).Hash.ToLowerInvariant()
$startUtc = (Get-Date).ToUniversalTime()

# ---- Launch + measure -------------------------------------------------------
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $NodeExe
$psi.Arguments = $argLine
$psi.WorkingDirectory = $repoRoot
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
[void]$proc.Start()

$stdoutTask = $proc.StandardOutput.ReadToEndAsync()
$stderrTask = $proc.StandardError.ReadToEndAsync()

$sw = [System.Diagnostics.Stopwatch]::StartNew()
[long]$peak = 0
[long]$wsMax = 0
[long]$pageMax = 0
[int]$samples = 0
[bool]$timedOut = $false

do {
    try {
        # Process.PeakWorkingSet64 / WorkingSet64 are CACHED in .NET.
        # Without Refresh() every sample returns the same first-read value.
        $proc.Refresh()
        $v = $proc.PeakWorkingSet64
        $w = $proc.WorkingSet64
        $p = $proc.PeakPagefileUsage
        if ($v -gt $peak) { $peak = $v }
        if ($w -gt $wsMax) { $wsMax = $w }
        if ($p -gt $pageMax) { $pageMax = $p }
        $samples++
    } catch { }
    if ($TimeoutSec -gt 0 -and $sw.Elapsed.TotalSeconds -gt $TimeoutSec) {
        $timedOut = $true
        try { $proc.Kill() } catch { }
        break
    }
} while (-not $proc.WaitForExit($PollIntervalMs))

$sw.Stop()
try {
    $proc.Refresh()
    $v = $proc.PeakWorkingSet64
    if ($v -gt $peak) { $peak = $v }
    $p = $proc.PeakPagefileUsage
    if ($p -gt $pageMax) { $pageMax = $p }
} catch { }
$proc.WaitForExit()
$exitCode = if ($timedOut) { -1 } else { $proc.ExitCode }

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($stdoutLog, $stdoutTask.Result, $utf8)
[System.IO.File]::WriteAllText($stderrLog, $stderrTask.Result, $utf8)

# ---- Output identity --------------------------------------------------------
$outBytes = 0
$outHash = ''
if ($outFull -and (Test-Path -LiteralPath $outFull -PathType Leaf)) {
    $outItem = Get-Item -LiteralPath $outFull
    # Only trust an output actually (re)written by THIS run.
    if ($exitCode -eq 0 -and $outItem.LastWriteTimeUtc -ge $startUtc.AddSeconds(-2)) {
        $outBytes = $outItem.Length
        $outHash = (Get-FileHash -LiteralPath $outFull -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

$result = [ordered]@{
    experiment                 = 'M3-B'
    run_id                     = $Label
    operation                  = $Operation
    power                      = $Power
    curve                      = 'BLS12-381'
    platform                   = 'windows-native'
    snarkjs_version            = $snarkjsVersion
    ffjavascript_version       = $ffjsVersion
    node_version               = $nodeVersion
    metric                     = 'Windows Peak Working Set (Process.PeakWorkingSet64)'
    command_line               = $commandLine
    cli_args                   = $cliArgs
    node_exe                   = $NodeExe
    cli_entry                  = Get-Rel $Cli
    timestamp_hook             = Get-Rel $Hook
    input_path                 = Get-Rel $inFull
    input_sha256               = $inputHash
    input_bytes                = $inputBytes
    output_path                = if ($outFull) { Get-Rel $outFull } else { '' }
    output_bytes               = $outBytes
    output_sha256              = $outHash
    elapsed_ms                 = [math]::Round($sw.Elapsed.TotalMilliseconds, 3)
    peak_working_set_bytes     = $peak
    peak_working_set_mib       = [math]::Round($peak / 1MB, 3)
    current_ws_max_bytes       = $wsMax
    current_ws_max_mib         = [math]::Round($wsMax / 1MB, 3)
    peak_pagefile_usage_bytes  = $pageMax
    peak_pagefile_usage_mib    = [math]::Round($pageMax / 1MB, 3)
    peak_samples               = $samples
    poll_interval_ms           = $PollIntervalMs
    exit_code                  = $exitCode
    timed_out                  = $timedOut
    stdout_log                 = Get-Rel $stdoutLog
    stderr_log                 = Get-Rel $stderrLog
    stdout_lines               = ($stdoutTask.Result -split "`n").Count
    stderr_lines               = ($stderrTask.Result -split "`n").Count
    timestamp_utc              = (Get-Date).ToUniversalTime().ToString('o')
}

[System.IO.File]::WriteAllText($jsonPath, ($result | ConvertTo-Json -Depth 8) + "`n", $utf8)

$status = if ($exitCode -eq 0) { 'PASS' } else { 'FAIL' }
Write-Output ("{0,-34} power={1,-2} exit={2,-3} {3,-4} elapsed={4,9:N0} ms  peak={5,9:N1} MiB  json={6}" -f `
    $Label, $Power, $exitCode, $status, $result.elapsed_ms, $result.peak_working_set_mib, (Get-Rel $jsonPath))

if ($exitCode -ne 0) {
    Write-Output ("  stderr tail: " + (($stderrTask.Result -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 3) -join ' | '))
}
