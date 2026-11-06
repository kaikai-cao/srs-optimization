<#
.SYNOPSIS
  M3 control: measure the FIXED cost of ffjavascript building a BLS12-381 curve.

.DESCRIPTION
  buildBls12381() creates tm.concurrency = min(os.cpus().length, 64) worker_threads,
  each with its own V8 isolate + compiled WASM module. This cost is incurred by
  every snarkjs Powers-of-Tau command before any CRS byte is read. Measuring it
  separately explains why small-power Phase 1 Verify already needs ~500 MiB even
  though its largest chunk is only 6/12 MiB.

  Writes results/raw/m3_worker_baseline.json (NOT part of the 3-operation matrix).
#>
[CmdletBinding()]
param(
    [int]$PollIntervalMs = 25,
    [string]$NodeExe = ''
)
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$rawDir = Join-Path $repoRoot 'results\raw'
New-Item -ItemType Directory -Force -Path $rawDir | Out-Null

if (-not $NodeExe) {
    $NodeExe = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}

$js = "const ff=require('ffjavascript'); ff.getCurveFromName('bls12-381').then(c=>{console.log('tm.concurrency='+c.G1.tm.concurrency); return c.terminate();}).catch(e=>{console.error(e);process.exit(1);});"
$argLine = '"-e" "' + $js.Replace('"', '\"') + '"'

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
$outTask = $proc.StandardOutput.ReadToEndAsync()
$errTask = $proc.StandardError.ReadToEndAsync()

$sw = [System.Diagnostics.Stopwatch]::StartNew()
[long]$peak = 0
[int]$samples = 0
do {
    try {
        $proc.Refresh()
        $v = $proc.PeakWorkingSet64
        if ($v -gt $peak) { $peak = $v }
        $samples++
    } catch { }
} while (-not $proc.WaitForExit($PollIntervalMs))
$sw.Stop()
$proc.WaitForExit()
$exitCode = $proc.ExitCode

$ffVersion = (Get-Content -LiteralPath (Join-Path $repoRoot 'node_modules\ffjavascript\package.json') -Raw | ConvertFrom-Json).version
$result = [ordered]@{
    record                  = 'M3-E control: ffjavascript curve build only (no CRS I/O)'
    platform                = 'windows-native'
    metric                  = 'Windows Peak Working Set (Process.PeakWorkingSet64)'
    ffjavascript_version    = $ffVersion
    node_version            = ((& $NodeExe -v).Trim())
    tm_concurrency          = [math]::Min([Environment]::ProcessorCount, 64)
    command_line            = "$(($NodeExe)) -e <getCurveFromName('bls12-381') + terminate>"
    peak_working_set_bytes  = $peak
    peak_working_set_mib    = [math]::Round($peak / 1MB, 3)
    elapsed_ms              = [math]::Round($sw.Elapsed.TotalMilliseconds, 3)
    peak_samples            = $samples
    exit_code               = $exitCode
    stdout                  = $outTask.Result.Trim()
    stderr                  = $errTask.Result.Trim()
    timestamp_utc           = (Get-Date).ToUniversalTime().ToString('o')
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
    (Join-Path $rawDir 'm3_worker_baseline.json'),
    ($result | ConvertTo-Json -Depth 6) + "`n", $utf8)

Write-Output ("worker baseline: peak={0} MiB  elapsed={1} ms  exit={2}  concurrency={3}" -f `
    $result.peak_working_set_mib, $result.elapsed_ms, $exitCode, $result.tm_concurrency)
