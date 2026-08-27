$ErrorActionPreference = 'Continue'
$targets = @(
  @{ Name = 'shopping_admin'; App = 'http://127.0.0.1:7780/admin'; Control = 'http://127.0.0.1:7781/status' },
  @{ Name = 'reddit'; App = 'http://127.0.0.1:9999'; Control = 'http://127.0.0.1:9998/status' },
  @{ Name = 'gitlab'; App = 'http://127.0.0.1:8023'; Control = 'http://127.0.0.1:8024/status' }
)
$results = @()
foreach ($target in $targets) {
  $appOk = $false
  $controlOk = $false
  try { $response = Invoke-WebRequest -Uri $target.App -Method Head -TimeoutSec 10 -SkipHttpErrorCheck; $appOk = $response.StatusCode -lt 500 } catch {}
  try { $status = Invoke-RestMethod -Uri $target.Control -TimeoutSec 10; $controlOk = [bool]$status.success } catch {}
  $results += @{ site = $target.Name; appOk = $appOk; controlOk = $controlOk; ready = $appOk -and $controlOk }
}
$allReady = ($results | Where-Object { -not $_.ready }).Count -eq 0
Write-Output (@{ allReady = $allReady; sites = $results } | ConvertTo-Json -Depth 5)
if (-not $allReady) { exit 1 }
