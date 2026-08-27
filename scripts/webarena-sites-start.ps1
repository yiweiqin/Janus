$ErrorActionPreference = 'Stop'
$dockerBin = 'C:\Program Files\Docker\Docker\resources\bin'
if (Test-Path $dockerBin) { $env:Path = "$dockerBin;$env:Path" }

$sites = @(
  @{ Name = 'shopping_admin'; Container = 'webarena-verified-shopping_admin'; Image = 'am1n3e/webarena-verified-shopping_admin'; Ports = @('7780:80', '7781:8877'); Control = 'http://127.0.0.1:7781' },
  @{ Name = 'reddit'; Container = 'webarena-verified-reddit'; Image = 'am1n3e/webarena-verified-reddit'; Ports = @('9999:80', '9998:8877'); Control = 'http://127.0.0.1:9998' },
  @{ Name = 'gitlab'; Container = 'webarena-verified-gitlab'; Image = 'am1n3e/webarena-verified-gitlab'; Ports = @('8023:8023', '8024:8877'); Control = 'http://127.0.0.1:8024' }
)

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$docker = if ($dockerCommand) { $dockerCommand.Source } else { 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' }
if (-not (Test-Path $docker)) {
  throw 'Docker CLI is unavailable. Install and start Docker Desktop, then rerun this command.'
}
& $docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker daemon is not running.' }

foreach ($site in $sites) {
  $existing = & $docker ps -a --filter "name=^/$($site.Container)$" --format '{{.Names}}'
  if ($existing -eq $site.Container) {
    $running = & $docker ps --filter "name=^/$($site.Container)$" --format '{{.Names}}'
    if ($running -ne $site.Container) { & $docker start $site.Container | Out-Null; if ($LASTEXITCODE -ne 0) { throw "Failed to start $($site.Container)." } }
  } else {
    $arguments = @('run', '-d', '--name', $site.Container)
    foreach ($mapping in $site.Ports) { $arguments += @('-p', $mapping) }
    $arguments += $site.Image
    & $docker @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to create $($site.Container)." }
  }
}

$deadline = (Get-Date).AddMinutes(12)
foreach ($site in $sites) {
  $ready = $false
  while ((Get-Date) -lt $deadline -and -not $ready) {
    try {
      $status = Invoke-RestMethod -Uri "$($site.Control)/status" -TimeoutSec 10
      $ready = [bool]$status.success
    } catch { Start-Sleep -Seconds 5 }
  }
  if (-not $ready) { throw "Site $($site.Name) did not become ready at $($site.Control)." }
}

Write-Output (@{ started = $true; sites = $sites.Name } | ConvertTo-Json -Compress)
