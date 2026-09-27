# Phase 9 M1.3.1 — Remaining Hot-path Causal Closure

## Starting state and scope

M1.3.1 started from local and remote `main` at `fb14d01ad990d56cf920e8350c015175ce3897a4` (`perf: optimize computed cache promotion`), with a clean checkout. Three read-only audits traced effect fan-out, ordinary source reads, and likely avoidable work. Experiments used one managed disposable worktree, one temporary runtime edit at a time, serial fresh-process pairs on the same Windows x64 machine (AMD Ryzen 7 PRO 6850U, Node v24.21.0), and the frozen M1b iteration counts. Every diagnostic used four alternating process pairs, three warmups and seven samples per process; worker semantic preflight and assertions passed.

The accepted public wrapper/private node representation, current `RuntimeReadableInterop`, speculative-cache promotion optimization, and `alien-signals/system` boundary were left unchanged. No production runtime patch was accepted. The report closes only fan-out and plain `source/read` investigation; it does not begin M2 implementation.

## Effect fan-out path delta

The workload creates one source and N flat effects. Each effect reads the source once and increments a counter. Each timed write changes the source value; setup and disposal are outside the timed region. Thus each write reaches N dependency edges and schedules/runs N callbacks.

| Operation | v0.1.1 | Current RFSG | Frequency in this workload | Semantic status |
| --- | --- | --- | --- | --- |
| Source write and equality | Alien source setter applies its equality/update path. | `writeSignalValue` checks deep-signal membership, compares `pendingValue` with `Object.is`, stores the pending value, increments the render revision, and sets `Mutable | Dirty`. | Once per source write. | Equality, pending settlement and revision notification are required; the extra bookkeeping is current implementation work, not proven unavoidable cost. |
| Dependency propagation | Alien `propagate` walks the source's subscriber links and visits each watching effect. | Same Alien system traversal; each direct effect edge reaches RFSG `notify`. | Once per edge/subscriber. | Required graph behavior. |
| Notification and queue | Alien updates effect flags and queues the effect for synchronous flush. | `notify` marks `scheduled`, appends to the queue, clears `Watching`, and checks for a watching child link; the child check fails for each flat leaf. | Once per subscriber. | Scheduling and single-notification behavior are required; the leaf-loop shape is an implementation choice tested below. |
| Flush and run eligibility | Alien drains the queue, checks flags and calls `checkDirty` when needed. | `flushQueue` clears each queue slot, distinguishes effect from render watcher, and calls `run`; `run` checks active/running state, flags, and `checkDirty`. | Once per queued effect. | Synchronous flush and stale/equality correctness are required. |
| Callback lifecycle | Alien saves/restores active subscriber and cycle/run depth, executes the wrapped callback, and purges stale dependencies. The v0.1.1 RFSG effect wrapper also performs render-untracked/error/cleanup handling. | RFSG resets dependency tail/flags/scheduled state, marks running, saves/sets `activeSub`, invokes `withoutInteropSpeculativeMode`, `withTrackedGraph`, and `withoutAllRenderCollection`, executes `effect.fn`, then restores run depth/subscriber/running/flags and calls `purgeDeps`. | Once per callback. | Cleanup, error containment, synchronous execution, render isolation, cross-copy graph capture and dependency purge are required; whether the exact nested state work can be safely shortened was not established. |
| Dependency read/reuse | `SignalImpl.value` calls render-subscription tracking, then the Alien source getter tracks/reuses the dependency edge. | `.value` enters `readSignalValue` → `readSignalCore` → `track`; Alien `link` reuses the stable one-edge dependency, followed by runtime node/liveness classification checks. | Once per callback and dependency edge. | Tracking/relinking semantics are required; the fan-out experiment below tested one narrow classification shortcut. |

In the flat fan-out callback, cleanup is absent, dynamic dependency churn is absent, no computed is involved, and local-source tracking does not refresh foreign liveness. The queue reversal loop performs no swaps because each notification adds one leaf. These observations locate repeated work but do not apportion elapsed time among it. M1.3 current/v0.1.1 ratios remain 0.785 at fanout@16 (8/8 slower) and 0.833 at @64 (7/8 slower).

### Fan-out diagnostics

| One-variable temporary candidate | Workload | Variant/control median (Q1–Q3) | Faster pairs | Result |
| --- | --- | ---: | ---: | --- |
| Enqueue a leaf directly instead of entering the generic notification loop | @1 | 1.071× (1.001–1.149) | 3/4 | Inconclusive; wide spread. |
| Same | @16 | 1.017× (0.942–1.087) | 2/4 | Rejected; no repeatable gain. |
| Same | @64 | 1.041× (0.980–1.122) | 2/4 | Rejected; no repeatable gain. |
| Return after linking a source dependency, skipping computed/external classification checks | @1 | 1.046× (0.952–1.116) | 2/4 | Inconclusive. |
| Same | @16 | 0.959× (0.940–0.979) | 1/4 | Rejected; slower direction. |
| Same | @64 | 0.966× (0.904–1.131) | 2/4 | Rejected; no supported gain. |

Neither candidate improved the scaling cases. The @1 samples were also too dispersed to support a stable benefit. The previously rejected graph/render scope omissions, inactive `withoutAllRenderCollection` guard, and speculative-depth guard were not repeated. No queue, effect lifecycle, tracking, or isolation change was retained.

## Ordinary source/read path delta

The benchmark creates one clean source and repeatedly reads `source.value`, with no subscriber, computed, render collector, speculative read, or dirty value. The ordinary path is:

```text
RuntimeSignalReadable.value
  → readSignalValue
  → activeSub check (false; speculative check in this condition is short-circuited)
  → speculativeReads check (absent)
  → isInteropSpeculative
      → cached shared-context read
      → speculativeDepth check (false)
  → activeRenderReads check (absent)
  → local/shared render collector check (absent)
  → publishForeignGraphRead
      → graphCollector read (undefined; return)
  → readSignalCore
      → Dirty flag check (false)
      → track
          → activeSub read (undefined; return)
  → currentValue return
```

The v0.1.1 getter instead calls `RenderSubscription.track()` → `trackRenderDependency` (no active render collector) → the Alien source getter (no active subscriber) → its cached current value. Both paths return a clean cached value. Current adds the ordinary-context speculative-mode lookup, local/shared collection checks, foreign graph publication helper, Dirty check, and the `readSignalCore`/`track` call layers. No global symbol lookup occurs on this cached shared-context path, and the protocol runtime token is not read when the graph collector is absent. Those current checks support required active modes, but the measurements below do not prove how much each specific branch costs.

M1.3 current/v0.1.1 for `source/read@1` was 0.654 (7/8 slower). M1.2 Candidate C's paired current-control read diagnostic was neutral at 1.004× (IQR 0.959–1.013, 3/4 faster); wrapper/node or protocol-closure changes therefore do not explain the final M1.2 movement from 0.698 to 0.645.

### Source/read diagnostics

| One-variable temporary candidate | Workload | Variant/control median (Q1–Q3) | Faster pairs | Result |
| --- | --- | ---: | ---: | --- |
| After foreign-read publication, return `currentValue` for a clean ordinary read instead of calling `readSignalCore`/`track` | source/read | 1.024× (0.979–1.087) | 2/4 | Rejected; no repeatable target gain. |
| Same | source/write-read | 0.932× (0.903–0.983) | 1/4 | Rejected; slower direction. |
| Same | source/unobserved-write | 0.989× (0.929–1.004) | 1/4 | No adjacent benefit. |
| Inline the foreign graph collector lookup/publication into the ordinary-read caller, preserving cross-copy publication | source/read | 1.013× (0.955–1.062) | 2/4 | Rejected; no repeatable target gain. |
| Same | source/write-read | 0.992× (0.926–1.012) | 2/4 | No directional change. |
| Same | source/unobserved-write | 1.054× (0.996–1.090) | 3/4 | Partial signal only; plain read did not improve repeatably. |

The clean-read variant preserved foreign graph publication and fell back to core settlement for Dirty nodes, but it did not pass the read/adjacent-workload evidence gate. The inline candidate preserved publication whenever a foreign collector's runtime token differed from the readable's token; its small unobserved-write signal did not establish a source-read improvement. Both changes were discarded. No M1.1b guarded source-read branch was repeated unchanged.

## Corrections, validation, and closure

The M1.2 table and summary now state that Candidate C itself measured neutral on source/read and that its final current/v0.1.1 ratio remained below parity. The observed M1b-to-M1.2 shift is not attributed to Candidate C.

Validation performed:

- Each temporary variant passed `pnpm build:runtime` in the disposable worktree.
- All paired workers passed their semantic preflight and workload assertions.
- `git diff --check` passed for the final documentation and attribution changes.
- No production runtime change was retained, so broad runtime/browser test suites and a new 958-task matrix were not run.

The exact contributor to the fan-out and ordinary-read throughput gap remains **measurement-limited**: path audits show repeated checks and bookkeeping, but no narrow safe variant produced a repeatable target gain. This does not establish that the entire gap is required semantic cost. There is no remaining narrow, proven optimization that should block v0.2 hardening. M1.3.1 recommends proceeding to **M2 — Release Hardening**, with the M1.3 performance matrix remaining the current comparative evidence. Future optimization should require a new concrete hypothesis and repeatable paired benefit; do not create M1.4 solely because parity has not been reached.
