# Phase 9 profiling notes

Profiles are diagnostic only; do not compare their sample counts across processes or use them as throughput evidence. Run one worker at a time after warmup. Keep generated profiles and traces in a temporary directory and do not commit them.

Example source-read capture (use the case's frozen iteration count):

```powershell
$profileDir = Join-Path $env:TEMP 'phase9-profile'
New-Item -ItemType Directory -Force $profileDir | Out-Null
$payload = '{"runtimeId":"rfsg-current","kind":"source-read","iterations":1693079,"size":1,"warmups":3,"samples":7}'
node --cpu-prof --cpu-prof-interval=100 --cpu-prof-dir=$profileDir --cpu-prof-name=source-read --expose-gc benchmarks/phase9/worker.mjs $payload
node benchmarks/phase9/profiling/summarize-cpuprofile.mjs (Join-Path $profileDir 'source-read.cpuprofile')
```

For optimization/deoptimization tracing, run the same worker in a separate process:

```powershell
node --trace-opt --trace-deopt --expose-gc benchmarks/phase9/worker.mjs $payload *> (Join-Path $profileDir 'source-read.trace.txt')
node benchmarks/phase9/profiling/summarize-v8-trace.mjs (Join-Path $profileDir 'source-read.trace.txt')
```

Repeat separately for `source-write-read`, `computed-dirty-read`, `computed-equality-suppression`, and `effect-fanout` at sizes 16 and 64. Profiles must include the actual worker workload and must not overlap benchmark timing runs. V8 trace evidence indicates compilation/deoptimization events only; it does not establish that a runtime change improves performance.
