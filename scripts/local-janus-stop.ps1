param(
  [switch]$StopDatabase
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot '.local-runtime'

foreach ($item in @(
  @{ Pid = 'cloud-api.pid'; Fragment = 'cloud/src/index.mjs' },
  @{ Pid = 'evolution-worker.pid'; Fragment = 'cloud/src/evolution-worker.mjs' }
)) {
  $pidFile = Join-Path $runtimeRoot $item.Pid
  if (-not (Test-Path -LiteralPath $pidFile)) { continue }
  $processId = [int](Get-Content -Raw -LiteralPath $pidFile)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if ($process -and ([string]$process.CommandLine).Contains($item.Fragment)) {
    Stop-Process -Id $processId -Force
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

if ($StopDatabase) {
  $command = "Stop-Service -Name 'postgresql-x64-17'"
  $elevated = Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile', '-Command', $command -Wait -PassThru
  if ($elevated.ExitCode -ne 0) { throw "Could not stop PostgreSQL (exit $($elevated.ExitCode))." }
}

& (Join-Path $PSScriptRoot 'local-janus-status.ps1')
