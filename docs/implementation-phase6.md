# Phase 6 — Public Signal / Runtime Object Consolidation

## Status

Phase 5 is complete and frozen. Phase 6 is a separate investigation into whether the public API firewall can remain stable without allocating a second public wrapper object for each signal and computed.

**M0 — architecture prototype and measurement** is complete. Its historical candidate B is rejected because it exposes runtime internals. The initial M0 no-go recommendation was provisional; M0.1 supplied the additional evidence used to approve the C1-style production migration.

**M0.1 — targeted performance, deep-liveness, bundle, and duplicate-package hardening** is complete. Candidate C1 passed the focused correctness, encapsulation, cross-copy, and bridge-free deepSignal checks. Its fresh-process measurements and package-faithful sizes supported the production migration.

**M1 — core object consolidation**, **M2 — deepSignal adapter/liveness separation**, and **M3 — stabilization, cleanup, and freeze** are complete. Phase 6 is frozen at the production architecture and validation described below.

## Phase 6 investigation question and decision basis

M0/M0.1 investigated whether the public API firewall could remain stable without requiring a second public wrapper object.

Phase 6 is not synonymous with wrapper removal. The decision must weigh throughput, creation cost, allocation and retained memory, bundle size and tree-shaking, API exposure and encapsulation, deepSignal coupling, interop and brand complexity, cross-copy behavior, test and maintenance cost, and future runtime replacement flexibility. A small throughput gain may justify consolidation if it materially reduces object, forwarding, bundle, or maintenance costs. A fast design that exposes graph internals is unacceptable.

## Current production architecture

Writable signals and computeds use one public/runtime readable, one graph node, and the existing V1 protocol:

```text
signal() / computed()
    → branded RuntimeSignalReadable / RuntimeComputedReadable
        → private #node
            → local graph node
                → alien-signals/system
```

The public/runtime readable owns `value`, `peek()`, `SIGNAL_BRAND`, and `READABLE_INTEROP_V1`. A runtime-private `WeakMap<readable, node>` supports operations that start from a readable; hot reads use the private `#node` directly. Render methods are attached to internal graph nodes and are passed to React render collection as `RenderDependency` values. Reflection of the readable does not expose graph state, render methods, or deep liveness.

```text
DeepSignalImpl / Proxy facade
    → consolidated internal runtime source
        → private graph node

deep per-key version source
    → consolidated internal runtime source
        → private graph node

deep liveness
    → runtime-private adapter operations and WeakSets
```

`DeepSignalImpl` remains because it represents the public deep Proxy/value abstraction. It is not a generic forwarding layer between a public signal and a runtime readable. Public deep signals retain their brand and V1 protocol; their internal root and per-key sources do not need the public signal brand.

## Historical M0 candidates

The following candidates and A/B/C labels describe the M0 investigation only. They are not the current production architecture and their executable implementations have been retired after M3.

### A — wrapper architecture (historical control)

```text
public SignalImpl / computed wrapper → runtime readable → runtime node
```

This was the Phase 5 production architecture and the M0 behavioral, performance, allocation, size, and exposure baseline. Its main advantage was the API firewall: graph representation and render capabilities remained behind the public wrapper. Its costs included an extra public object, forwarding, duplicate interop/brand plumbing, and deep-only liveness members on writable signals.

### B — direct existing runtime readable (historical diagnostic)

```text
signal() → existing RuntimeSignal object
```

This diagnostic control estimated a simple wrapper-free throughput and allocation ceiling. It was rejected for production: that version exposed render methods and a reflectively discoverable symbol leading to the raw node and graph metadata.

### C/C1 — consolidated public readable with hidden capability (historical candidate; C1 migrated to production)

```text
public readable object
        │ closure / WeakMap / equivalent private association
        ▼
internal RuntimeNode → alien-signals/system
```

The candidate's target public JavaScript surface was approximately:

```text
Writable signal: value, peek(), SIGNAL_BRAND, READABLE_INTEROP_V1
Computed:        readonly value, peek(), SIGNAL_BRAND, READABLE_INTEROP_V1
```

The raw node had to remain undiscoverable through own keys, symbols, prototype methods, or public properties. C1 established the private-node class, runtime ownership map, and node render methods that now underpin production. Candidate C and C1 executable copies have since been removed; recorded measurements and conclusions remain below.

## deepSignal boundary

The production deep engine reads version sources through `value` and `peek()`, while its runtime adapter owns `markWatched()` and `hasSubscribers()` operations. This keeps deep-only liveness off ordinary public readables. Proxy traps, property/iteration semantics, array/Map/Set behavior, normalization, and pruning policy remain unchanged.

## Milestones

### M0 — architecture prototype and measurement (approved)

Compare A/B/C in isolated `benchmarks/phase6/` and `tests/phase6/` work. Do not alter production `signal()`/`computed()` behavior, add a selector or feature flag, or add package exports. Measure identical workloads and environments across candidates: core throughput, creation, structural and measured allocation/retained heap, consumer bundle scenarios, tree-shaking, and reflective public object shape. Add focused correctness evidence for semantics, branding, cross-copy behavior, V1 interop, React render collection, and deepSignal adaptation/liveness. End with a documented go/no-go decision for C; do not force it to win.

### M1 — core object consolidation (complete)

Signals and computeds now use their branded runtime readables directly. `SignalImpl` and the computed forwarding wrapper are removed; V1 is attached to each readable and node/render capabilities remain private.

### M2 — deepSignal adapter/liveness separation (complete)

The narrow runtime adapter owns deep-source liveness and the same consolidated readable backs roots and per-key sources. The Proxy and pruning behavior are preserved.

### M3 — stabilization and freeze (complete)

Production regression tests replaced the candidate comparison suite; duplicate runtime/engine copies and their one-off benchmark harnesses are retired. The docs are synchronized with production, full validation passed, and Phase 6 is frozen.

## Non-goals

Phase 6 does not include React subscription consolidation, direct runtime subscriptions for `useSignalValue`, removal of the JSX effect bridge, deepSignal Proxy or pruning redesign, ReadableInterop V2, a shared cross-runtime graph/scheduler or atomic batch, a redesign of bare `useSignalTracking()` or the managed transform, high-level alien-signals as the production core, Svelte-style API changes, or RSC-specific work. If M0 shows one is required, record a blocker or future dependency instead of expanding scope.

## Historical M0 decision gate

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

**Initial M0 recommendation (superseded):** Candidate C was **not yet suitable to proceed to production migration** based on the single-process exploratory measurements. This was a cautious provisional no-go, not a final architecture rejection. M0.1 supplied the additional evidence, and M1/M2 later migrated the accepted C1 design to production.

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

**M0.1 recommendation at the time:** retain C1 as the production-oriented candidate for a later migration decision. M1 and M2 have since completed, and M3 has frozen the migrated production architecture; this historical recommendation is superseded.

### M1/M2 implementation validation history (pre-M3)

#### Production architecture

- `signal()` and `computed()` now return the runtime readable directly after brand registration. The public forwarding `SignalImpl` and computed wrapper are removed; no temporary M1 compatibility bridge was needed.
- `RuntimeSignalReadable` and `RuntimeComputedReadable` each own a private JavaScript `#node` reference. Runtime ownership remains in a private `WeakMap`; shared render capability methods are attached to graph nodes, so ordinary readable reflection cannot discover graph nodes or render methods.
- ReadableInterop V1 remains the protocol for cross-runtime reads/subscriptions. No V2 or public export was added.
- Public writable signals expose `value`, `peek()`, the signal brand, and V1 protocol; computeds expose readonly `value`, `peek()`, the brand, and V1 protocol. Deep-only liveness methods are not on either readable prototype.
- `deepSignal` version sources now use the same consolidated runtime readable. The engine adapter owns `markWatched` and `hasSubscribers`; runtime-private WeakSets hold deep-source membership and watched-since-write state. The old `SignalImpl` and forwarding bridge are absent from production.
- Proxy behavior, normalization, and metadata pruning policy were unchanged.

#### Deep write-path trade-off

The shared signal write path checks private `deepSignalNodes` membership and clears the watched state for deep sources before the existing equality check. This is one WeakSet membership check per write to preserve watched-since-write behavior even for an `Object.is`-equal assignment. A separate deep-specific node/write path would add runtime complexity or allocations, so the simpler C1 mechanism is retained as an acceptable trade-off for later hardening review.

#### Validation

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:phase4-duplicate`, and `pnpm test:consumer` passed. Full tests: runtime 288 passed; transform 221 passed, 3 skipped. Lint completed with warnings only.
- Runtime reflection, core semantics, React tracking, and Phase 6 candidate checks passed within the full runtime suite. The genuine duplicate-package smoke passed with three independent Alien systems; consumer package smoke passed.
- `pnpm size` passed all unchanged budgets and tree-shaking checks. Gzip sizes: signal-only 5.87 kB, core 5.92 kB, core+hooks 7.18 kB, deep 10.28 kB, index-full 11.46 kB, jsx-runtime 8.91 kB, utils 7.20 kB.
- `pnpm bench` and `pnpm bench:deep` passed on Node v24.20.0 / Windows x64 / AMD Ryzen 7 PRO 6850U. The core benchmark's local medians were 39.83M signal reads/s, 19.00M writes/s, 5.10M observed writes/s, 4.86M computed update/reads/s, and 2.75M two-write batches/s. Deep cases ranged from 21.68K array pushes/s to 307.57K nested reads/s. These single-machine measurements are diagnostic, not release guarantees.
- `pnpm bench:react` also completed with all render-count assertions intact. It covered 500 sibling rows and 300 updates across hook, signal, managed-runtime, production, and JSX paths; this is a smoke/diagnostic run, not a comparable pre-migration performance result.
- Focused Phase 6/runtime/React/deepSignal tests passed again after M2 (4 files, 112 tests).
- Build-related checks were run sequentially after an initial concurrent build collision invalidated one benchmark/size attempt; the final build, size check, and core/deep benchmarks all passed.

### M3 — stabilization and freeze

#### Prototype classification and cleanup

| Files / infrastructure | Classification | M3 decision |
| --- | --- | --- |
| `candidate-b-*`, `candidate-c-*`, `candidate-c1-*`, `candidate-deep-signal-engine.ts`, `candidates.ts` | Obsolete duplicate implementation | Deleted after migrating C1 to production. |
| `candidates.test.tsx` | Historical comparison plus production-surface assertions | Replaced by `tests/runtime-surface.test.ts` against the shipped production API. |
| `build-candidates.mjs`, `bundle-size.mjs`, `package-bundle-size.mjs`, `run.mjs`, `run-isolated.ps1`, `worker.mjs`, `benchmark-entry.ts` | Reusable only for candidate-comparison benchmark infrastructure | Deleted; normal production benchmarks remain in `benchmarks/`. |
| `results-m0.1.jsonl` | Historical raw measurement evidence | Removed after keeping summarized results and methodology in this document. |
| `tests/phase6/duplicate-copy-smoke.mjs` | Candidate-specific duplicate smoke | Deleted; production cross-copy coverage remains in `tests/cross-copy-smoke.mjs` and `pnpm test:phase4-duplicate`. |
| Core, runtime, React, deepSignal and cross-copy production tests | Production regression coverage | Retained. Added reflection/render-capability/internal-source tests and strengthened real-package cross-copy assertions. |

The genuine production cross-copy smoke and existing three-system runtime duplicate smoke remain. Historical measurements and conclusions remain in this document; future production code no longer has to synchronize four alternative runtime implementations.

#### Internal deep-source brand decision

Internal root and per-key runtime sources are held behind `DeepSignalImpl` and the engine's private metadata maps. The production deep engine does not call `isSignal()` on those sources; it calls the predicate only when classifying values from user state. Cross-copy consumers only receive the separately branded public `DeepSignalImpl`, which owns the same V1 protocol as its internal root. Branding internal sources was therefore redundant identity work. `createDeepSignal()` sources remain runtime-owned and V1-readable without `SIGNAL_BRAND`; the public deep signal remains branded and `isSignal()` compatible. Production tests verify both public identity and internal-source unbranded V1 behavior.

#### Final trade-offs and freeze decision

- Retained the private `deepSignalNodes.has(node)` check on the shared source-write path. It clears watched state before the equality check, including equal writes, and avoids another wrapper or a more complex write path.
- Runtime ownership remains a `WeakMap<readable, node>` for operations beginning at a readable. `deepSignalNodes` separates deep sources from ordinary sources; `deepWatchedNodes` retains watched-since-write state. Each structure serves a distinct operation and remains.
- ReadableInterop V1 is unchanged. There is no public graph node, `runtimeToken`, graph links, render capability, or deep liveness member on the public readable.
- No Phase 7 work is included. Any later cross-Node or application workload benchmarking is outside the Phase 6 freeze and is not a release claim from these local microbenchmarks.

#### Validation after M3 cleanup

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:phase4-duplicate`, `pnpm test:consumer`, and `pnpm size` passed. Lint exited successfully with existing scoping/React-hook warnings only. Tests: runtime 269 passed; transform 221 passed, 3 skipped.
- `tests/runtime-surface.test.ts` passed the actual production reflection checks and verified React receives a private graph dependency. Deep-source tests verified an internal runtime source remains unbranded, V1-readable, and reactive, while public `DeepSignal` remains branded.
- The genuine production cross-copy smoke built three independent package copies. It passed local/foreign signal, computed and public deepSignal brand checks; foreign signal/computed dependencies; signal updates in both copy directions; deep property updates/disposal; and the existing local-batch semantics (`[0, 2]`). The separate three-system duplicate-runtime smoke also passed.
- `pnpm size` passed all unchanged gzip budgets and marker controls. Gzip results: signal-only 5.87 kB; core 5.92 kB; core+hooks 7.18 kB; deep 10.29 kB; index-full 11.46 kB; jsx-runtime 8.91 kB; utils 7.20 kB. Deep engine and React code were absent/present in the expected profiles.
- `pnpm bench`, `pnpm bench:deep`, and `pnpm bench:react` completed on Node v24.20.0 / Windows x64 / AMD Ryzen 7 PRO 6850U. The latest core medians were 59.86M reads/s, 37.81M writes/s, 6.20M observed writes/s, 4.54M computed update/reads/s, and 2.43M two-write batches/s. The repeated deep run measured 1.54M nested reads/s, 475K observed leaf writes/s, 1.48M sibling-isolation writes/s, 69K parent replacements/s, and 22K array pushes/s. The React benchmark preserved all render-count assertions (for example, 301 counter renders and 500 sibling renders for both signals and managed signals across 300 updates). These local measurements varied between runs; they are directional and showed no clear regression attributable to M3 cleanup.
- A transient slower array-push and core sample was not repeatable: the same Node 24.20 deep benchmark returned to 22K array pushes/s, in line with the previous M1/M2 run, and the second core run had computed/batch values close to that earlier run. No benchmark budget or threshold was changed.

#### Final Phase 6 status

| Milestone | Status |
| --- | --- |
| M0 | Complete |
| M0.1 | Complete |
| M1 | Complete |
| M2 | Complete |
| M3 | Complete |
| Phase 6 | Frozen |

The final architecture is the production design in [Current production architecture](#current-production-architecture). Historical candidate measurements above remain context only; production tests and benchmarks now exercise the shipped implementation.
