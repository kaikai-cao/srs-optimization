<#
.SYNOPSIS
  M3-C / M3-D: run the Powers-of-Tau memory baseline matrix on Windows.

.DESCRIPTION
  For each requested power, using the CONTRIBUTED file pot<p>_0001.ptau:
    1. phase1_verify      powersoftau verify <contributed>       (M3-C)
    2. prepare_phase2     powersoftau prepare phase2 ... <final> (M3-D)
    3. prepared_verify    powersoftau verify <final>             (M3-D, includes
                                                                 Phase-2 Lagrange checks)

  Each step is one independent node.exe process measured by measure_snarkjs.ps1.
  Results: results/raw/m3_*.json + results/raw/m3_logs/*.log.
  Finally builds results/processed/m3_summary.csv and the comparison chart.

  Power 21 is deliberately NOT in the default matrix.

.EXAMPLE
  powershell.exe -ExecutionPolicy Bypass -File scripts\run_m3_benchmarks.ps1 -Powers 10,12,14
  powershell.exe -ExecutionPolicy Bypass -File scripts\run_m3_benchmarks.ps1 -Powers 16 -GenerateMissing
#>
[CmdletBinding()]
param(
    [int[]]$Powers = @(10, 12, 14, 16, 18),
    [switch]$GenerateMissing,
    [switch]$SkipPhase1,
    [switch]$SkipPrepare,
    [switch]$SkipPreparedVerify,
    [switch]$NoSummary,
    [int]$TimeoutSec = 1800,
    [int]$PollIntervalMs = 25,
    [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'

$scriptRoot = $PSScriptRoot
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $scriptRoot '..')).Path
$measure = Join-Path $scriptRoot 'measure_snarkjs.ps1'
$cli = Join-Path $repoRoot 'node_modules\snarkjs\build\cli.cjs'
$fixtureDir = Join-Path $repoRoot 'data\fixtures'
$rawDir = Join-Path $repoRoot 'results\raw'
New-Item -ItemType Directory -Force -Path $fixtureDir, $rawDir | Out-Null

if (-not $NodeExe) {
    $NodeExe = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}

Write-Output '========== M3 MEMORY BASELINE MATRIX =========='
Write-Output ("repo      : {0}" -f $repoRoot)
Write-Output ("node      : {0} ({1})" -f $NodeExe, ((& $NodeExe -v).Trim()))
Write-Output ("powers    : {0}" -f ($Powers -join ', '))
Write-Output ("timeout   : {0} s per run" -f $TimeoutSec)
Write-Output ("metric    : Windows Peak Working Set (PeakWorkingSet64)")
Write-Output ''

function Invoke-SnarkjsRaw([string[]]$argv, [string]$logLabel) {
    $log = Join-Path $rawDir "m3_logs\$logLabel.stdout.log"
    $err = Join-Path $rawDir "m3_logs\$logLabel.stderr.log"
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    $argLine = ($argv | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '

    # Use .NET Process rather than Start-Process: this session carries BOTH
    # HTTPS_PROXY and https_proxy, which makes Start-Process throw a duplicate
    # env-key ArgumentException on Windows PowerShell 5.1.
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
    $proc.WaitForExit()
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($log, $outTask.Result, $utf8)
    [System.IO.File]::WriteAllText($err, $errTask.Result, $utf8)
    $code = $proc.ExitCode
    $proc.Dispose()
    if ($code -ne 0) {
        throw "fixture generation failed ($logLabel), exit=$code; see $err"
    }
}

foreach ($power in $Powers) {
    $contributed = "data/fixtures/pot${power}_0001.ptau"
    $initial = "data/fixtures/pot${power}_0000.ptau"
    $prepared = "data/fixtures/pot${power}_final.ptau"
    $contributedFull = Join-Path $repoRoot $contributed
    $preparedFull = Join-Path $repoRoot $prepared

    Write-Output ("---------- POWER {0} ----------" -f $power)

    if (-not (Test-Path -LiteralPath $contributedFull)) {
        if (-not $GenerateMissing) {
            Write-Output "  SKIP: $contributed missing (use -GenerateMissing)"
            continue
        }
        Write-Output "  generating $initial + $contributed (unmeasured fixture generation)"
        Invoke-SnarkjsRaw (@($cli, 'powersoftau', 'new', 'bls12-381', "$power", $initial, '-v')) "m3_fixture_p${power}_new"
        Invoke-SnarkjsRaw (@($cli, 'powersoftau', 'contribute', $initial, $contributed,
            "--name=SRS M3 Power $power", "-e=srs-m3-power${power}-test-entropy", '-v')) "m3_fixture_p${power}_contribute"
        Write-Output "  generated (hashes recorded at end of run)"
    }

    if (-not $SkipPhase1) {
        & $measure -Operation phase1_verify -Power $power -InputPath $contributed `
            -Label "m3_phase1_verify_p${power}" -TimeoutSec $TimeoutSec `
            -PollIntervalMs $PollIntervalMs -NodeExe $NodeExe
    }

    if (-not $SkipPrepare) {
        & $measure -Operation prepare_phase2 -Power $power -InputPath $contributed -OutputPath $prepared `
            -Label "m3_prepare_phase2_p${power}" -TimeoutSec $TimeoutSec `
            -PollIntervalMs $PollIntervalMs -NodeExe $NodeExe
    }

    if (-not $SkipPreparedVerify) {
        if (-not (Test-Path -LiteralPath $preparedFull)) {
            Write-Output "  SKIP prepared_verify: $prepared missing"
        } else {
            & $measure -Operation prepared_verify -Power $power -InputPath $prepared `
                -Label "m3_prepared_verify_p${power}" -TimeoutSec $TimeoutSec `
                -PollIntervalMs $PollIntervalMs -NodeExe $NodeExe
        }
    }
    Write-Output ''
}

# ---- Record every fixture identity, so results are reproducible -------------
$fixtureRecords = @()
Get-ChildItem -LiteralPath $fixtureDir -Filter '*.ptau' -File | Sort-Object Name | ForEach-Object {
    $fixtureRecords += [ordered]@{
        file        = "data/fixtures/$($_.Name)"
        bytes       = $_.Length
        sha256      = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
    (Join-Path $rawDir 'm3_fixture_hashes.json'),
    (@{ record = 'M3 fixture identities'; generated_at_utc = (Get-Date).ToUniversalTime().ToString('o'); fixtures = $fixtureRecords } | ConvertTo-Json -Depth 6) + "`n",
    $utf8)

if (-not $NoSummary) {
    Write-Output '========== BUILDING SUMMARY =========='
    & $NodeExe (Join-Path $scriptRoot 'build_m3_summary.cjs')
}

Write-Output '========== M3 MATRIX DONE =========='
