param(
  [int]$TargetMs = 120,
  [int]$SamplesPerProcess = 3,
  [int]$Warmups = 3,
  [int]$Rounds = 3,
  [int]$HeapCount = 50000,
  [string]$ResultsFile = "benchmarks/phase6/results-m0.1.jsonl"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
$bundleRoot = Join-Path $tempRoot "bundles"
$rawResults = [System.Collections.Generic.List[object]]::new()
$candidates = @("A", "B", "C0", "C1")
$cases = @(
  "signal-read", "unobserved-write", "observed-write", "computed-update-read",
  "hot-computed-read", "batch", "effect-create-dispose", "signal-create",
  "computed-create", "signal-create-discard", "computed-create-discard",
  "heap-signal", "heap-computed"
)
$revision = "5170e76cef6d6f46329ae1ebfebee3fdd382f4f3 + M0.1 worktree changes"
$workerPath = Join-Path $PSScriptRoot "worker.mjs"
$builderPath = Join-Path $PSScriptRoot "build-candidates.mjs"

try {
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  & node $builderPath $bundleRoot
  if ($LASTEXITCODE -ne 0) { throw "Candidate bundles failed to build (exit $LASTEXITCODE)" }

  for ($round = 0; $round -lt $Rounds; $round++) {
    foreach ($caseIndex in 0..($cases.Length - 1)) {
      $case = $cases[$caseIndex]
      $shift = ($round + $caseIndex) % $candidates.Length
      for ($candidateOffset = 0; $candidateOffset -lt $candidates.Length; $candidateOffset++) {
        $candidateIndex = ($candidateOffset + $shift) % $candidates.Length
        $candidate = $candidates[$candidateIndex]
        $bundle = Join-Path $bundleRoot "$candidate.js"
        if ($case.StartsWith("heap-")) {
          $env:PHASE6_HEAP_COUNT = "$HeapCount"
          $sampleCount = 3
          $warmupCount = 0
        } else {
          Remove-Item Env:\PHASE6_HEAP_COUNT -ErrorAction SilentlyContinue
          $sampleCount = $SamplesPerProcess
          $warmupCount = $Warmups
        }
        $workerOutput = & node --expose-gc $workerPath $bundle $case $TargetMs $sampleCount $warmupCount
        if ($LASTEXITCODE -ne 0) { throw "$candidate/$case process failed (exit $LASTEXITCODE)" }
        $record = ($workerOutput -join "`n") | ConvertFrom-Json
        $record | Add-Member -NotePropertyName round -NotePropertyValue $round
        $record | Add-Member -NotePropertyName revision -NotePropertyValue $revision
        $rawResults.Add($record)
      }
    }
  }

  $destination = Join-Path $repo $ResultsFile
  $rawResults | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 6 } | Set-Content -LiteralPath $destination -Encoding utf8

  $rawResults | Where-Object { $_.case -notlike "heap-*" } |
    Group-Object candidate, case | ForEach-Object {
      $items = $_.Group | Sort-Object round
      $times = @($items | ForEach-Object { $_.samplesMs }) | Sort-Object
      $rates = [System.Collections.Generic.List[double]]::new()
      foreach ($item in $items) {
        foreach ($sampleMs in $item.samplesMs) {
          $rates.Add($item.iterations / ($sampleMs / 1000))
        }
      }
      $rates = @($rates | Sort-Object)
      $middle = [int][Math]::Floor($times.Count / 2)
      $rateMiddle = [int][Math]::Floor($rates.Count / 2)
      $median = if (($times.Count % 2) -eq 1) { $times[$middle] } else { ($times[$middle - 1] + $times[$middle]) / 2 }
      $rateMedian = if (($rates.Count % 2) -eq 1) { $rates[$rateMiddle] } else { ($rates[$rateMiddle - 1] + $rates[$rateMiddle]) / 2 }
      $p25 = $times[[int][Math]::Floor(($times.Count - 1) * 0.25)]
      $p75 = $times[[int][Math]::Ceiling(($times.Count - 1) * 0.75)]
      [pscustomobject]@{
        Candidate = $items[0].candidate
        Case = $items[0].case
        IterationsRange = "$(($items | Measure-Object iterations -Minimum).Minimum)-$(($items | Measure-Object iterations -Maximum).Maximum)"
        Samples = $times.Count
        MedianMs = [Math]::Round($median, 3)
        P25Ms = [Math]::Round($p25, 3)
        P75Ms = [Math]::Round($p75, 3)
        MinMs = [Math]::Round($times[0], 3)
        MaxMs = [Math]::Round($times[-1], 3)
        MedianOpsPerSecond = [Math]::Round($rateMedian)
      }
    } | Sort-Object Case, Candidate | Format-Table -AutoSize

  $rawResults | Where-Object { $_.case -like "heap-*" } |
    Group-Object candidate, case | ForEach-Object {
      $values = @($_.Group | ForEach-Object { $_.bytesPerInstance }) | Sort-Object
      [pscustomobject]@{
        Candidate = $_.Group[0].candidate
        Case = $_.Group[0].case
        Samples = $values.Count
        MedianBytesPerInstance = [Math]::Round($values[[int][Math]::Floor($values.Count / 2)], 1)
        MinBytesPerInstance = [Math]::Round($values[0], 1)
        MaxBytesPerInstance = [Math]::Round($values[-1], 1)
      }
    } | Sort-Object Case, Candidate | Format-Table -AutoSize
  Write-Output "Raw per-process samples written to $destination"
} finally {
  Remove-Item Env:\PHASE6_HEAP_COUNT -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
