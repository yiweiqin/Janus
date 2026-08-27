$ErrorActionPreference = 'Stop'
$dockerBin = 'C:\Program Files\Docker\Docker\resources\bin'
if (Test-Path $dockerBin) { $env:Path = "$dockerBin;$env:Path" }
$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$docker = if ($dockerCommand) { $dockerCommand.Source } else { 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' }
$containers = @('webarena-verified-shopping_admin', 'webarena-verified-reddit', 'webarena-verified-gitlab')
foreach ($container in $containers) {
  $running = & $docker ps --filter "name=^/$container$" --format '{{.Names}}'
  if ($running -eq $container) { & $docker stop $container | Out-Null }
}
Write-Output (@{ stopped = $true; containers = $containers; removed = $false } | ConvertTo-Json -Compress)
