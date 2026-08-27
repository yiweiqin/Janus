param(
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot '.local-runtime'
$fileStorageRoot = Join-Path $repoRoot '.local-data\file-storage'
$postgresBin = 'D:\PostgreSQL\17\bin'
$postgresService = 'postgresql-x64-17'

New-Item -ItemType Directory -Force -Path $runtimeRoot, $fileStorageRoot | Out-Null

function Import-UserEnvironment([string[]]$Names) {
  foreach ($name in $Names) {
    $value = [Environment]::GetEnvironmentVariable($name, 'User')
    if ($value) { Set-Item -Path "Env:$name" -Value $value }
  }
}

function Test-JanusProcess([string]$PidFile, [string]$CommandFragment) {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $false }
  $processId = [int](Get-Content -Raw -LiteralPath $PidFile)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  return ($null -ne $process) -and ([string]$process.CommandLine).Contains($CommandFragment)
}

function Stop-JanusProcess([string]$PidFile, [string]$CommandFragment) {
  if (-not (Test-JanusProcess $PidFile $CommandFragment)) { return }
  $processId = [int](Get-Content -Raw -LiteralPath $PidFile)
  Stop-Process -Id $processId -Force
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

$service = Get-Service -Name $postgresService -ErrorAction SilentlyContinue
if (-not $service) { throw 'PostgreSQL 17 service is not installed.' }
if ($service.Status -ne 'Running') {
  $command = "Start-Service -Name '$postgresService'"
  $elevated = Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile', '-Command', $command -Wait -PassThru
  if ($elevated.ExitCode -ne 0) { throw "Could not start PostgreSQL (exit $($elevated.ExitCode))." }
}

& (Join-Path $postgresBin 'pg_isready.exe') -h 127.0.0.1 -p 5432 | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL is not accepting local connections.' }

Import-UserEnvironment @(
  'DATABASE_URL', 'EVOLUTION_WORKER_DATABASE_URL', 'DATABASE_MIGRATOR_URL',
  'OPENAI_BASE_URL', 'CRS_OAI_KEY', 'OPENAI_MODEL',
  'JANUS_EVOLUTION_MODEL', 'JANUS_EVOLUTION_REASONING_EFFORT',
  'JANUS_EVOLUTION_ACTIVE_KEY_ID', 'JANUS_EVOLUTION_KEYS_JSON',
  'JANUS_EVOLUTION_WORKER_ACTIVE_KEY_ID',
  'JANUS_EVOLUTION_WORKER_PUBLIC_KEYS_JSON',
  'JANUS_EVOLUTION_WORKER_PRIVATE_KEYS_JSON'
)

$env:JWT_SECRET = [Environment]::GetEnvironmentVariable('JANUS_LOCAL_JWT_SECRET', 'User')
$env:NODE_ENV = 'production'
$env:HOST = '127.0.0.1'
$env:PORT = '8787'
$env:MAIL_PROVIDER = 'console'
$env:JANUS_FILE_STORAGE_ROOT = $fileStorageRoot
$env:JANUS_EVOLUTION_WORKER_INTERVAL_MS = '60000'

foreach ($required in @('DATABASE_URL', 'EVOLUTION_WORKER_DATABASE_URL', 'JWT_SECRET')) {
  if (-not (Get-Item -Path "Env:$required" -ErrorAction SilentlyContinue).Value) {
    throw "Required local environment variable is missing: $required"
  }
}

$apiPid = Join-Path $runtimeRoot 'cloud-api.pid'
$workerPid = Join-Path $runtimeRoot 'evolution-worker.pid'
if ($Restart) {
  Stop-JanusProcess $apiPid 'cloud/src/index.mjs'
  Stop-JanusProcess $workerPid 'cloud/src/evolution-worker.mjs'
}

if (-not (Test-JanusProcess $apiPid 'cloud/src/index.mjs')) {
  $api = Start-Process node.exe -ArgumentList 'cloud/src/index.mjs' -WorkingDirectory $repoRoot `
    -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'cloud-api.out.log') `
    -RedirectStandardError (Join-Path $runtimeRoot 'cloud-api.err.log') -PassThru
  Set-Content -LiteralPath $apiPid -Value $api.Id
}

if (-not (Test-JanusProcess $workerPid 'cloud/src/evolution-worker.mjs')) {
  $worker = Start-Process node.exe -ArgumentList 'cloud/src/evolution-worker.mjs' -WorkingDirectory $repoRoot `
    -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'evolution-worker.out.log') `
    -RedirectStandardError (Join-Path $runtimeRoot 'evolution-worker.err.log') -PassThru
  Set-Content -LiteralPath $workerPid -Value $worker.Id
}

Start-Sleep -Seconds 2
& (Join-Path $PSScriptRoot 'local-janus-status.ps1')
