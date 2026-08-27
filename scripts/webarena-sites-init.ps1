$ErrorActionPreference = 'Stop'
$controls = @(
  @{ Name = 'shopping_admin'; Url = 'http://127.0.0.1:7781' },
  @{ Name = 'reddit'; Url = 'http://127.0.0.1:9998' },
  @{ Name = 'gitlab'; Url = 'http://127.0.0.1:8024' }
)
$results = @()
foreach ($site in $controls) {
  $result = Invoke-RestMethod -Method Post -Uri "$($site.Url)/init" -TimeoutSec 600
  $results += @{ site = $site.Name; success = [bool]$result.success; message = $result.message }
  if (-not $result.success) { throw "Failed to initialize $($site.Name): $($result.message)" }
}
Write-Output (@{ initialized = $true; results = $results } | ConvertTo-Json -Depth 5 -Compress)
