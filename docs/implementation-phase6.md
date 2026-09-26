# Phase 6 — Public Signal / Runtime Object Consolidation

## Status

Phase 5 is complete and frozen. Phase 6 is a separate investigation into whether the public API firewall can remain stable without allocating a second public wrapper object for each signal and computed.

**M0 — architecture prototype and measurement** is complete. Candidate B is rejected for production because it exposes runtime internals. Candidate C established architecture feasibility, but its production migration has not been approved. The initial M0 no-go recommendation was provisional: its one-process exploratory timings do not establish that consolidation itself causes the measured regressions.

**M0.1 — targeted performance, deep-liveness, bundle, and duplicate-package hardening** is complete. Candidate C1 passed the focused correctness, encapsulation, cross-copy, and bridge-free deepSignal checks. Its fresh-process measurements and package-faithful sizes support retaining C1 as the production-oriented candidate for a later, separately authorized phase; they do not approve a production migration. M1, M2, and M3 have not started.

## Core question and decision basis

Can the public API firewall remain stable without requiring a second public wrapper object?

Phase 6 is not synonymous with wrapper removal. The decision must weigh throughput, creation cost, allocation and retained memory, bundle size and tree-shaking, API exposure and encapsulation, deepSignal coupling, interop and brand complexity, cross-copy behavior, test and maintenance cost, and future runtime replacement flexibility. A small throughput gain may justify consolidation if it materially reduces object, forwarding, bundle, or maintenance costs. A fast design that exposes graph internals is unacceptable.

## Current architecture

Writable signals currently follow approximately:

```text
signal() → SignalImpl → RuntimeSignal → SignalNode → alien-signals/system
```

Computeds currently follow approximately:

```text
computed() → public readonly wrapper → RuntimeReadonlySignal → ComputedNode → alien-signals/system
```

The runtime readable owns the reactive behavior and currently has `value`, `peek()`, `getRenderVersion()`, `subscribeRender()`, `READABLE_INTEROP_V1`, and a private readable-to-node association. That association uses a non-exported symbol, but JavaScript reflection can discover the symbol and retrieve the node.

`SignalImpl` forwards `value` and `peek()`, forwards the V1 interop protocol, carries `SIGNAL_BRAND`, and has `#watchedSinceWrite`, `markWatched()`, and `hasSubscribers()` for deepSignal version-source pruning. Those last responsibilities are specifically deepSignal liveness needs and need not belong to every ordinary public signal. Computed uses a separate public wrapper and forwards the V1 protocol and brand.

React render collection currently relies on readable methods `getRenderVersion()` and `subscribeRender()`. Phase 6 may move these to runtime-private capabilities, but it must not change React tracking semantics. `deepSignal` uses per-property version sources and a conservative watched flag plus exact runtime liveness; Phase 6 may separate that capability from ordinary signals but must preserve Proxy behavior and pruning policy.

## Candidates

### A — current wrapper architecture (control)

```text
public SignalImpl / computed wrapper → runtime readable → runtime node
```

This is the accepted Phase 5 production architecture and the behavioral, performance, allocation, size, and exposure baseline. Its main advantage is the API firewall: graph representation and render capabilities remain behind the public wrapper. Its costs include an extra public object, forwarding, duplicate interop/brand plumbing, and deep-only liveness members on writable signals.

### B — direct existing runtime readable (diagnostic)

```text
signal() → existing RuntimeSignal object
```

This diagnostic control estimates the simplest wrapper-free throughput and allocation ceiling. It is not the production recommendation by default. The existing runtime readable exposes render methods and a reflectively discoverable symbol that leads to the raw node and graph metadata. Any such exposure is a known API-firewall failure.

### C — consolidated public readable with hidden capability (production-oriented candidate)

```text
public readable object
        │ closure / WeakMap / equivalent private association
        ▼
internal RuntimeNode → alien-signals/system
```

The target public JavaScript surface is approximately:

```text
Writable signal: value, peek(), SIGNAL_BRAND, READABLE_INTEROP_V1
Computed:        readonly value, peek(), SIGNAL_BRAND, READABLE_INTEROP_V1
```

The raw node must not be discoverable through own keys, symbols, prototype methods, or public properties. Closures and a runtime-private `WeakMap<readable, node>` are acceptable. Prefer hot `value` accessors that close directly over the node; use a WeakMap only where an operation starts from a public readable, such as ownership checks. Do not replace `SignalImpl` with another per-signal wrapper/capability object that defeats consolidation. Evaluate runtime-private alternatives for React render methods and deepSignal liveness without changing their semantics.

## deepSignal boundary

The current deep engine requests version sources with `value`, `peek()`, `markWatched()`, and `hasSubscribers()`. The investigation should test the smallest separation that lets ordinary public signals remain lean while deepSignal version sources retain the liveness needed by current pruning. Prefer a deep-specific internal operation or capability rather than adding deep-only methods to every signal. Do not change Proxy traps, property/iteration semantics, array/Map/Set behavior, normalization, or pruning policy.

## Milestones

### M0 — architecture prototype and measurement (approved)

Compare A/B/C in isolated `benchmarks/phase6/` and `tests/phase6/` work. Do not alter production `signal()`/`computed()` behavior, add a selector or feature flag, or add package exports. Measure identical workloads and environments across candidates: core throughput, creation, structural and measured allocation/retained heap, consumer bundle scenarios, tree-shaking, and reflective public object shape. Add focused correctness evidence for semantics, branding, cross-copy behavior, V1 interop, React render collection, and deepSignal adaptation/liveness. End with a documented go/no-go decision for C; do not force it to win.

### M1 — core object consolidation (planned only)

If C passes M0, consider consolidating signal and computed public/runtime identity, removing `SignalImpl` and the computed forwarding wrapper, placing `SIGNAL_BRAND` directly on the public readable, eliminating V1 forwarding, and storing runtime node/render capabilities privately. M1 must retain the API firewall and existing runtime semantics.

### M2 — deepSignal adapter/liveness separation (planned only)

If M1 validates, consider removing deepSignal-only liveness responsibilities from ordinary signals and supplying a narrow internal deep version-source capability. Preserve deepSignal root semantics and metadata pruning behavior. M1 and M2 may later be executed in one work session only if M1 validation is green.

### M3 — stabilization and freeze (planned only)

Run full correctness, duplicate-package and cross-runtime, React, deepSignal pruning, tree-shaking, size, allocation, and performance validation; remove obsolete prototype infrastructure; synchronize documentation; and decide whether Phase 6 can be frozen.

## Non-goals

Phase 6 does not include React subscription consolidation, direct runtime subscriptions for `useSignalValue`, removal of the JSX effect bridge, deepSignal Proxy or pruning redesign, ReadableInterop V2, a shared cross-runtime graph/scheduler or atomic batch, a redesign of bare `useSignalTracking()` or the managed transform, high-level alien-signals as the production core, Svelte-style API changes, or RSC-specific work. If M0 shows one is required, record a blocker or future dependency instead of expanding scope.

## M0 decision gate

Candidate C may be recommended for a later M1 only if its raw runtime node is not reflectively reachable; it avoids a replacement per-signal wrapper allocation; signal/read-only signal semantics, `Object.is`, branding and cross-copy `isSignal()`, and ReadableInterop V1 remain intact; React tracking and deepSignal semantics need no redesign; allocation/maintenance/API-structure benefits are credible; and measured regressions do not outweigh those benefits. The report must compare A/B/C explicitly and classify findings as **blocker**, **acceptable trade-off**, **hardening later**, or **future idea**. A failure at this gate is a valid M0 outcome.

## Phase 6 M0 findings

### Scope and environment

- Package revision: `74115da80613be8df83cd59f7fabbb18ab2ced2c` (`main` at the start of this pass).
- Node `v24.21.0`, Windows `win32/x64`, AMD64 Family 25 Model 68 Stepping 1 (AuthenticAMD).
- The isolated benchmark uses 50,000 operations for the ordinary cases, 5,000 for observed write, batch, and effect create/dispose, 2 warmups, and 5 samples. Large-N retained-heap measurements use 50,000 signals/computeds, 5 samples, and explicit GC. Results are exploratory: process-local timing and heap snapshots are noisy and the cases are run serially.
- Production source and package exports were not changed. Candidate C is a copy in `tests/phase6/fixtures/candidate-c-runtime.ts`. No selector or production flag was introduced.

### A/B/C comparison

| Candidate | Readable/writable structure | Public graph exposure | Findings |
| --- | --- | --- | --- |
| A — current wrapper | Writable: `SignalImpl` + runtime readable + node + V1 protocol. Computed: public computed wrapper + runtime readable + node + protocol. | No raw node on the public value. A writable prototype has `markWatched` / `hasSubscribers`, which are deep-specific. | Correctness baseline; best observed raw-read and hot-computed medians in this exploratory run. |
| B — direct existing runtime | Runtime readable + node + V1 protocol; registration adds the brand to the readable. | Fails the API firewall: own `READABLE_NODE` symbol reveals the node, and `getRenderVersion()` / `subscribeRender()` are public methods. | Diagnostic only. Retained heap was below A; timing mixed. Not suitable for production. |
| C — consolidated readable, hidden node | Public readable + node + protocol. A runtime-local node prototype carries render methods; a WeakMap serves ownership/liveness lookups. No per-signal replacement wrapper. | `Object.keys`, own property names and symbols expose only the expected readable members, brand and V1 protocol. No render methods or raw-node association is discoverable from the readable. | Focused semantics, React tracking, foreign V1 reads in both directions, and deepSignal adapter/pruning checks passed. Retained heap was lowest; timings were mixed and sometimes slower than A/B. |

Representative benchmark medians (operations/second; exploratory, not a release benchmark):

| Case | A | B | C |
| --- | ---: | ---: | ---: |
| Signal raw read | 18.61M | 15.58M | 12.38M |
| Unobserved write | 4.62M | 14.26M | 5.86M |
| Observed write | 1.80M | 1.58M | 1.16M |
| Computed update/read | 1.79M | 2.51M | 1.62M |
| Hot computed read | 10.12M | 9.57M | 6.09M |
| Batch (two observed writes) | 0.38M | 0.54M | 0.44M |
| Effect create/dispose | 1.43M | 2.14M | 1.91M |
| Signal create | 88K | 172K | 188K |
| Computed create | 152K | 132K | 187K |

Create-and-discard also varied: signal 248K/252K/221K and computed 223K/246K/169K for A/B/C respectively. These figures do not show an across-the-board throughput win for C; in particular its reads and observed updates lost to A in this run. Do not infer stable percent changes from a single process run.

Post-GC retained heap medians were approximately:

| Retained instances | A | B | C |
| --- | ---: | ---: | ---: |
| 50K signals, bytes/instance | 1,240 | 1,184 | 872 |
| 50K computeds, bytes/instance | 1,768 | 1,312 | 1,000 |

This is useful directional evidence, not precise object sizing. Structurally, A allocates one additional public wrapper per regular signal/computed compared with B/C. For deepSignal per-key version sources, A has `SignalImpl + readable + node + protocol`; this prototype's B/C adapter has `bridge + readable + node + protocol`, so this experiment does **not** reduce the per-key source count. The deep bridge is a prototype adapter and should be replaced by a narrow engine capability before any migration is considered; Proxy behavior and pruning were left as-is.

### Public object inspection and correctness

- A signal has no own string keys/names, carries the brand and V1 symbols, and inherits `value`, `peek`, `markWatched`, and `hasSubscribers`. A computed has its wrapper's `value`/`peek` own properties.
- B readables own `value`, `peek`, `getRenderVersion`, and `subscribeRender`, as well as brand, V1, and the discoverable runtime-node symbol. The node exposes graph fields including `kind`, `deps`, and `subs`.
- C readables own only `value` and `peek`; own symbols are `SIGNAL_BRAND` and `READABLE_INTEROP_V1`. Its prototype is `Object.prototype`; the runtime's render capability prototype is attached to private graph nodes only.
- The isolated tests cover `value`/setter/`peek`, `Object.is` (`NaN`, `+0`/`-0`), read-only computed behavior, same-copy identity, cross-copy brand validation and malformed brands, V1 protocol presence, foreign signal/computed subscriptions both directions, React tracking of a computed, and deepSignal property notification/pruning.
- These are focused architecture tests, not a duplicate-package build test for candidate C. Cross-package brand fallback is exercised structurally using the stable `Symbol.for` contract; full duplicate-package validation remains required before production migration.

### Bundle size and tree-shaking

`pnpm size` built current production A and checked all seven existing consumer scenarios. Gzip sizes were: `signal-only` 5.91 kB, `core` 6.00 kB, `core+hooks` 7.27 kB, `deep` 10.27 kB, `index-full` 11.46 kB, `jsx-runtime` 8.80 kB, `utils` 7.10 kB. All existing budgets passed, and the structural absence/presence checks verified that deep engine code is shaken from `signal-only`/`core` and retained for `deep`.

The isolated candidate source-harness bundle check also built the same seven imports for A/B/C, with Vite aliases replacing only the core base/deepSignal adapter for B/C. Gzip kB (A/B/C) were: `signal-only` 5.93/5.77/5.79, `core` 6.02/5.79/5.80, `core+hooks` 7.27/7.06/7.06, `deep` 10.30/10.28/10.28, `index-full` 11.48/11.44/11.44, `jsx-runtime` 8.79/8.79/8.81, and `utils` 2.15/7.12/7.12. The script checked the deep and React marker presence/absence controls for each candidate. No production size budgets were changed.

Treat these as relative source-harness comparisons, not release bundle numbers: the source-harness A `utils` result (2.15 kB) differs substantially from the existing packaged consumer measurement (7.10 kB), showing that source resolution and published chunk topology differ for that scenario. The existing `pnpm size` run remains the production budget/tree-shaking authority; verify comparative C sizes again against a package-faithful build before any production migration.

### Initial M0 decision and classification (retained history)

- **Blocker:** none found for C's prototype correctness or JavaScript API firewall. B is rejected as a production design because reflection exposes the raw node.
- **Acceptable trade-off:** C's hidden node prototype and ownership WeakMap are feasible without changing render tracking semantics or adding an ordinary per-signal wrapper. Current deepSignal adapter preserves the existing pruning test, but saves no per-key source object in this prototype.
- **Hardening later:** do not proceed to production migration yet. Stabilize/replicate performance comparisons; compare candidate-specific builds across the seven consumer profiles; test candidate C with an actual duplicate package build; and remove the deep-source bridge without changing the Proxy or pruning algorithm. C currently shows a retained-heap advantage but no dependable throughput advantage, with material slowdowns in some measured cases.
- **Future idea:** if a narrow deep-liveness capability proves necessary, keep it exclusive to deep version sources rather than restoring liveness methods to ordinary signals.

**Initial recommendation:** Candidate C was **not yet suitable to proceed to production migration** based on the single-process exploratory measurements. This was a cautious provisional no-go, not a final architecture rejection; M0.1 is intended to test its basis. No production architecture, public export, size budget, or deepSignal behavior changed in M0.

### M0.1 — targeted hardening findings

#### Scope and environment

- Compared A (production wrapper control), B (direct readable diagnostic), C0 (M0 prototype), and C1 (shared-class readable with private `#node`, runtime-private WeakMap ownership, and node-local copies of shared render method references). C1 was added only as a test/benchmark fixture; production source and exports remain unchanged.
- Node `v24.21.0`, Windows `win32/x64`, AMD64 Family 25 Model 68 Stepping 1 (AuthenticAMD).
- `benchmarks/phase6/run-isolated.ps1` starts a fresh Node process for each candidate/case, rotates candidate order deterministically over three rounds, and collects three timed samples per process after three warmups. This yields nine timed samples per candidate/case. Each timed sample targets at least 120 ms; calibration may overshoot. Heap samples use 50,000 retained signal/computed instances, three samples per process and three processes (nine points per candidate/type), with explicit GC.
- Raw process/sample records are in `benchmarks/phase6/results-m0.1.jsonl`. Rates below are medians of the nine per-sample rates; ranges show P25–P75. These are local measurements, not a release benchmark. Some distributions are wide, so small differences should not be treated as meaningful.

#### Fresh-process throughput

Millions of operations per second (higher is faster):

| Case | A | B | C0 | C1 |
| --- | ---: | ---: | ---: | ---: |
| Signal read | 61.41 (56.08–65.62) | 50.11 (38.95–67.99) | 52.33 (51.57–59.92) | 135.26 (103.45–150.43) |
| Unobserved write | 42.55 (39.95–53.12) | 56.75 (53.24–56.98) | 8.25 (7.42–9.17) | 81.30 (56.45–96.69) |
| Observed write | 8.48 (7.06–8.91) | 7.68 (6.99–8.39) | 3.18 (2.75–4.02) | 11.02 (10.75–11.28) |
| Computed update/read | 4.74 (4.13–4.98) | 5.77 (5.58–5.92) | 3.07 (2.67–3.44) | 8.37 (7.22–8.41) |
| Hot computed read | 21.75 (19.90–28.52) | 32.09 (24.92–37.56) | 37.36 (28.56–40.70) | 58.59 (54.04–71.25) |
| Batch | 1.71 (0.83–1.85) | 1.50 (1.18–1.74) | 1.15 (1.08–1.61) | 2.66 (1.08–2.97) |
| Effect create/dispose | 6.62 (6.25–7.57) | 6.62 (5.33–7.64) | 6.94 (6.75–8.09) | 5.49 (4.86–7.24) |
| Signal create | 0.30 (0.28–0.32) | 0.30 (0.24–0.32) | 0.28 (0.25–0.31) | 0.41 (0.31–0.43) |
| Computed create | 0.30 (0.29–0.32) | 0.31 (0.30–0.36) | 0.29 (0.22–0.29) | 0.40 (0.37–0.43) |
| Signal create/discard | 0.27 (0.23–0.29) | 0.31 (0.28–0.38) | 0.31 (0.23–0.31) | 0.39 (0.31–0.47) |
| Computed create/discard | 0.26 (0.26–0.27) | 0.29 (0.21–0.32) | 0.20 (0.20–0.27) | 0.37 (0.31–0.39) |

C1's median was higher than A in ten of eleven cases, while its effect create/dispose median was lower and its interquartile range overlapped A. These are strong directional local results, but process-to-process variation—especially in batch and creation cases—means they should not be presented as guaranteed application-level gains. The previous M0 single-process no-go is no longer supported as a reason to reject consolidation; performance remains a later-release validation item.

#### Heap, object structure, deep liveness, and cross-copy behavior

Post-GC retained heap per instance, median across nine 50,000-instance samples (bytes):

| Kind | A | B | C0 | C1 |
| --- | ---: | ---: | ---: | ---: |
| Signal | 1,240.5 | 1,184.3 | 872.2 | 448.2 |
| Computed | 1,768.3 | 1,312.2 | 1,000.2 | 632.2 |

These are process heap deltas, not precise shallow object sizes. Structurally, C1 exposes only the readable contract plus brand and V1 protocol symbols; it has no own render methods or reflectively discoverable node association. The runtime retains readable-to-node ownership in a private WeakMap and stores shared render method references on internal nodes. C1 creates no second per-signal wrapper. Its deep source liveness uses runtime-private WeakSets, and the cloned deep-signal engine reaches those capabilities through the source adapter; it no longer calls `markWatched()`/`hasSubscribers()` on every ordinary readable. Proxy behavior and pruning policy were not changed.

The C1 focused candidate suite passed (22 tests). The separate-copy smoke built three independent C1 runtime bundles and passed brand and ReadableInterop V1 checks, foreign signal/computed subscriptions, and both copy directions. Candidate C1 readables also passed the reflection firewall checks. No correctness blocker was found in this prototype.

#### Package-faithful consumer bundle comparison

The candidate was built with the package's tsdown entry layout and dependency bundling, replacing only the base and deep-signal fixtures, then consumed through the same Vite profiles as production. Gzip kB (A → C1):

| Consumer profile | A → C1 gzip kB | Δ |
| --- | ---: | ---: |
| signal-only | 5.94 → 5.95 | +0.01 |
| core | 6.03 → 5.98 | -0.05 |
| core+hooks | 7.30 → 7.19 | -0.11 |
| deep | 10.30 → 10.34 | +0.04 |
| index-full | 11.50 → 11.52 | +0.02 |
| jsx-runtime | 8.80 → 8.97 | +0.17 |
| utils | 7.13 → 7.25 | +0.12 |

The bundle marker controls passed: deep engine code was absent from `signal-only` and `core`, and present for `deep`; React markers followed the corresponding consumer profiles. C1 does not provide a package-size reduction; the measured differences are small and mixed. The ordinary production `pnpm size` check also passed all seven unchanged budgets and tree-shaking controls.

#### M0.1 decision and classification

- **Correctness blocker:** none found in the tested C1 prototype. Focused semantics, render tracking, deepSignal notifications/pruning, encapsulation, V1 interoperability and three-copy smoke passed.
- **Architecture blocker:** none found. B remains rejected because it exposes runtime internals. C1 is the preferred candidate to evaluate in a later production-migration phase; this finding does not authorize or implement that migration.
- **Hardening later:** repeat targeted performance checks on another supported Node/runtime environment before release, and evaluate application-level workloads. Treat the local timing deltas as directional because several cases have broad distributions. Keep package size budgets in force; C1 currently has approximately flat bundle size rather than a size win.
- **Future-version idea:** none added by M0.1.

**M0.1 recommendation:** retain C1 as the candidate design for a future M1 decision, with no production migration now. M0.1 is complete; M1, M2, and M3 remain unstarted. No production source, public API, size budget, or deepSignal behavior changed in this investigation.
