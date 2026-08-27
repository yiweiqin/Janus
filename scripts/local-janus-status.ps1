$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot '.local-runtime'

function Read-ProcessStatus([string]$PidName, [string]$Fragment) {
  $pidFile = Join-Path $runtimeRoot $PidName
  if (-not (Test-Path -LiteralPath $pidFile)) { return 'stopped' }
  $processId = [int](Get-Content -Raw -LiteralPath $pidFile)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if (-not $process -or -not ([string]$process.CommandLine).Contains($Fragment)) { return 'stopped' }
  return "running (PID $processId)"
}

$health = try {
  (Invoke-RestMethod -Uri 'http://127.0.0.1:8787/healthz' -TimeoutSec 3).status
} catch { 'unreachable' }
$database = Get-Service -Name 'postgresql-x64-17' -ErrorAction SilentlyContinue
$os = Get-CimInstance Win32_OperatingSystem

[pscustomobject]@{
  PostgreSQL = if ($database) { "$($database.Status) / $($database.StartType)" } else { 'not installed' }
  CloudAPI = Read-ProcessStatus 'cloud-api.pid' 'cloud/src/index.mjs'
  CloudHealth = $health
  EvolutionWorker = Read-ProcessStatus 'evolution-worker.pid' 'cloud/src/evolution-worker.mjs'
  FreeRAM_GB = [math]::Round($os.FreePhysicalMemory * 1KB / 1GB, 2)
  Logs = $runtimeRoot
} | Format-List
