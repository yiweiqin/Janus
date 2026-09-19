param([string]$Root = "$PSScriptRoot")
$ErrorActionPreference = 'Stop'
$local = Join-Path $Root 'tdb_status.json'
$evalRoot = Join-Path $Root 'runs\three-machine-v3'
$seeds = '20260914','20260915','20260916'
$out = @{ updatedAt=(Get-Date).ToUniversalTime().ToString('o'); seeds=@{} }
foreach($s in $seeds){
  $d = Join-Path $evalRoot $s; $m=Join-Path $d 'eval_manifest.json'; $t=Join-Path $d 'target_metrics.json'; $c=Join-Path $d 'projection_checker.json'
  $e=if(Test-Path $m){Get-Content $m -Raw|ConvertFrom-Json}else{$null}; $tm=if(Test-Path $t){Get-Content $t -Raw|ConvertFrom-Json}else{$null}; $ck=if(Test-Path $c){Get-Content $c -Raw|ConvertFrom-Json}else{$null}
  $out.seeds[$s]=@{name="seed$s";machine='archive/local';status=if($e){$e.status}else{'unknown'};gpu='n/a';training_process='not observed';eval_progress=if($e){"$($e.processedRows)/$($e.developmentRows)"}else{'n/a'};checkpoint='checkpoint-114';schema_valid_rate=if($tm){$tm.schemaValidRate}else{'n/a'};sufficiency=if($ck){$ck.sufficiencyRateConditionalCertified}else{'n/a'};decision_agreement=if($ck){$ck.decisionAgreementConditionalCertified}else{'n/a'};hard_violations=if($ck){$ck.hardViolationCount}else{'n/a'}}
}
$out|ConvertTo-Json -Depth 6|Set-Content $local -Encoding utf8
Write-Host "Wrote $local"
