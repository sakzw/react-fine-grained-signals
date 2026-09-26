$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$results = Join-Path $PSScriptRoot 'results-final-2026-09-26.jsonl'
$rounds = if ($env:FINAL_BENCH_ROUNDS) { [int]$env:FINAL_BENCH_ROUNDS } else { 3 }
$samples = if ($env:BENCH_SAMPLES) { [int]$env:BENCH_SAMPLES } else { 7 }
$warmups = if ($env:BENCH_WARMUPS) { [int]$env:BENCH_WARMUPS } else { 2 }
$core = @(
  @('read', 5000000), @('unobservedWrite', 1000000), @('observed', 300000),
  @('computed', 300000), @('batch', 100000), @('dynamic', 100000),
  @('effectCreateDispose', 300000), @('computedCold', 100000), @('computedHot', 1000000)
)
$deep = @('untrackedRead', 'trackedUpdate', 'siblingUpdate', 'computedUpdate', 'arrayIndex') |
  ForEach-Object { ,@($_, 50000) }
Remove-Item -LiteralPath $results -Force -ErrorAction SilentlyContinue
$cpu = 'AMD Ryzen 7 PRO 6850U with Radeon Graphics'
$meta = [ordered]@{
  kind = 'environment'; date = '2026-09-26'; commit = '906a0108b212dff2c84ed226c48063a6d096cc40'
  node = (& node --version); platform = 'win32'; arch = 'x64'; cpu = $cpu
  alienSignals = '3.2.1'; react = '19.2.8'; rounds = $rounds
  samplesPerProcess = $samples; warmupsPerProcess = $warmups
  ordering = 'isolated Node process per runtime/case/round; runtime order alternates by case and round'
}
($meta | ConvertTo-Json -Compress) | Set-Content -LiteralPath $results -Encoding utf8
$env:BENCH_SAMPLES = "$samples"
$env:BENCH_WARMUPS = "$warmups"
for ($round = 0; $round -lt $rounds; $round++) {
  for ($index = 0; $index -lt ($core.Count + $deep.Count); $index++) {
    if ($index -lt $core.Count) { $group = 'core'; $case = $core[$index][0]; $iterations = $core[$index][1] }
    else { $deepIndex = $index - $core.Count; $group = 'deep'; $case = $deep[$deepIndex][0]; $iterations = $deep[$deepIndex][1] }
    $script = if ($group -eq 'deep') { Join-Path $PSScriptRoot 'bench-deep.mjs' } else { Join-Path $PSScriptRoot 'bench.mjs' }
    $runtimes = if (($group -eq 'core') -and ($case -in @('read','observed','computed','batch'))) { @('current','lean','lean-wrapped') } else { @('current','lean') }
    if ((($round + $index) % 2) -ne 0) { [array]::Reverse($runtimes) }
    foreach ($runtime in $runtimes) {
      $output = (& node --expose-gc $script $runtime $case $iterations | Out-String).Trim()
      if ($LASTEXITCODE -ne 0) { throw "Benchmark failed: $runtime/$case round $round" }
      $row = $output | ConvertFrom-Json
      $row | Add-Member -NotePropertyName kind -NotePropertyValue 'sample'
      $row | Add-Member -NotePropertyName group -NotePropertyValue $group
      $row | Add-Member -NotePropertyName round -NotePropertyValue $round
      $json = $row | ConvertTo-Json -Compress
      Add-Content -LiteralPath $results -Value $json -Encoding utf8
      Write-Output $json
    }
  }
}
Write-Output "Results: $results"
