# Phase 9 post-M3 release review closure

## Starting point and why the RC was reopened

- Starting commit: `602087069c7fa7aa1148630fec6303b5253ecdd6` (`release: freeze v0.2.0 candidate`, the [M3 freeze](./m3.md)). Its full M3 gate had passed locally, and GitHub Actions Test/E2E had passed for it.
- At the start the working tree was clean. Both packages were `0.2.0`, and `alien-signals` was exactly `3.2.1`. No `v0.2.0` tag existed (the only tags, local and remote, were `v0.1.0` and `v0.1.1`), and npm listed only `0.1.0` and `0.1.1` for both packages.

After the freeze, an independent pre-release review of the RC found six problems:

- Two migration documentation gaps would break v0.1 users silently.
- One v0.2 runtime regression.
- One transform defect that can inject an invalid hook.
- One older deepSignal defect that can delete the wrong array element.
- A pack path that depended on the publisher remembering to build first.

The RC was reopened only to close those six items. Nothing else was redesigned. The M3 record above is historical evidence of the original freeze and is left as it was.

## Findings

### 1. Transform annotation rename (documentation)

- **Finding:** v0.2 renamed the transform comments:
  - `@useSignals` became `@signalTracking`.
  - `@noUseSignals` became `@noSignalTracking`.

  The migration guide did not mention this. The v0.2 transform matches only the new names (`transform.ts`, `useSignalTrackingComment` / `noSignalTrackingComment`) and does not warn about the old ones.
- **Reproduction:** The published `unplugin-react-fine-grained-signals@0.1.1` tarball matches `/(^|\s)@useSignals(\s|$)/` and `/(^|\s)@noUseSignals(\s|$)/`. The v0.2 source has neither.
- **Consequences:**
  - A `mode: "manual"` opt-in written as `@useSignals` stops being transformed, so the component stops re-rendering.
  - An `@noUseSignals` opt-out is transformed again. This matters for code that must not get a hook boundary, such as React Server Components.
- **Decision:** Document the rename. Do not restore the old names: no concrete compatibility reason came up, and aliases would keep the v0.1 annotation API alive.
- **Changes:** A new "Transform plugin" section in `docs/migration/v0.2.md` and `docs/migration/v0.2.ja.md`, with a rename table and both consequences. The plugin READMEs point to it from the installation section.

### 2. Runtime and plugin must be upgraded together (documentation)

- **Finding:** The migration guide asked readers to upgrade "every package that bundles or depends on RFSG together", but never named the concrete incompatibility.
- **Reproduction:** The published 0.1.1 plugin's managed mode builds an import from `${importSource}/runtime` and closes the scope with `t.memberExpression(store, t.identifier("f"))`; inject mode imports the root `useSignals`. v0.2 removed `/runtime` `useSignals`, the root `useSignals`, and `ManagedSignalsStore.f()`. The 0.1.1 plugin declares the peer range `react-fine-grained-signals: ^0.1.1`, which excludes 0.2.0.
- **Changes:**
  - Both migration guides now explain that a v0.1.1 plugin's output fails against the v0.2 runtime, and that its peer range makes the package manager report the mismatch.
  - Both migration guides now cover custom `importSource` wrappers. A wrapper must re-export the root `useSignalTracking` (inject mode) and the `/runtime` `useManagedSignals` (managed mode, the default), whose scope the generated code closes with `finish()`.
  - Both plugin READMEs say to use the plugin and the runtime from the same release line. Their `importSource` option entry now lists the two exports a wrapper needs.
  - The npm-published plugin README links to the guide with an absolute GitHub URL, so the link also works on npmjs.com.

### 3. A top-level self-invalidating `effect()` ran twice on creation (v0.2 regression, fixed)

**Reproduction.** Run against the built RC `dist` and the published v0.1.1, using `effect(() => { runs++; if (s.value < 3) s.value++; })`:

| Case | RC creation | RC later rerun | v0.1.1 creation | v0.1.1 later rerun |
| --- | ---: | ---: | ---: | ---: |
| top-level | 2 | 1 | 1 | 1 |
| inside `batch()` | 1 | 1 | 1 | 1 |

**Why the path exists.** `effect()` re-ran a new effect after setup if it was `Dirty | Pending`. Alien 3.2.1's own `effect()` has no such step. The rerun came in with the M1.5 port (`c72bacd`, `53ea180`).

Removing the line fails exactly one test: `tests/reactive-runtime.test.ts` "turns a read-to-subscribe revision mismatch into a bounded local retry". That test covers the ReadableInterop V1 handshake:
1. The effect reads a foreign readable at one revision.
2. Activating the bridge subscribes to it.
3. The subscription reports a newer revision.

The foreign adapter calls `propagate()` while the effect is still running. Alien's `propagate` then marks a `RecursedCheck` subscriber with a valid link as `Recursed | Pending` and does not notify it. The post-creation check is what turned that into a retry.

**Distinguishing the two cases.** A write the first run makes to its own dependency leaves exactly the same `Recursed | Pending` flags, and so does a write it causes through another effect that it flushes. The flags cannot tell the cases apart. `Dirty` cannot either: when a source with several subscribers changes, Alien's `checkDirty` calls `shallowPropagate`, which also sets `Dirty` on a running effect that is already `Pending`. A variant that keyed the retry on `Dirty` failed the nested-ownership and cascade tests.

The scheduler therefore records the one genuinely external source of staleness on the effect itself, as an RFSG-only flag bit (`128`; Alien uses bits up to `64`):
- `activateForeignNode` now returns `true` when the subscription reports a revision newer than the one that was read.
- `ensureForeignNode` then sets bit `128` on the effect that just read the bridge.
- After setup, `effect()` re-runs a top-level new effect only when that bit is set, instead of on `Dirty | Pending`.
- `runEffect` reassigns `flags` at the start of the next run, which clears the bit. A disposal sets `None`.

This adds no global state, no epoch, and nothing on the write path. Two cases are unchanged from the RC, which did not retry them either:
- A nested child effect's stale first read (its creation skips the check while `runDepth > 0`).
- An effect created inside `batch()`.

Earlier drafts used a module-level boolean set through a new adapter callback. That was functionally equivalent and passed every test, but cost 45 B gzip in `signal-only`; see Size below.

**Result.** The built `dist` now matches v0.1.1 in every probed case. That includes a cascade: an effect writes `a`, which flushes another effect that writes `b`, which the first effect had already read. The RC re-ran the first effect there; v0.1.1 and Alien 3.2.1 do not, and v0.2 now does not either. The foreign retry test passes unchanged.

**Regression tests** (`tests/post-m3-review-regressions.test.ts`). Each was also run against the RC's `src/core` with the final test file:

| Test | Result on the RC |
| --- | --- |
| top-level self-write runs once | failed |
| same pattern in `batch()` runs once | passed (guard) |
| a later external write re-runs exactly once | failed |
| cleanup: none on creation, one per re-run, one on dispose | failed |
| nested ownership: one live child per owner run, child disposed with the owner | failed |
| a write caused through another effect counts as the effect's own | failed |
| a self-write and a stale foreign handshake in the same first run still re-run once | passed (guard) |

**Performance.** The creation path now tests bit `128` where it used to test `Dirty | Pending`, and nothing else on the effect or write paths changed. In-process interleaved paired runs compared the RC source with the final source, built the same way: 41 rounds, alternating order, `--expose-gc`, and both module load orders. The values are median control/variant ratios, where >1 means the fix is faster:

| Workload (20,000 ops) | Load order A | Load order B |
| --- | ---: | ---: |
| `effect/create-dispose` | 1.044 (26/41) | 1.059 (26/41) |
| `effect/create` | 1.009 (23/41) | 1.038 (23/41) |
| `source/observed-write` | 1.081 (24/41) | 1.070 (26/41) |
| `effect/fanout-16-write` | 1.034 (31/41) | 1.064 (36/41) |

No ratio is below 1. The small gains are not attributable to the fix and are treated as noise. An earlier run of the boolean draft showed `effect/create` at 0.948 in one load order and 1.042 in the other, which is consistent with order and JIT noise. No material regression was found.

**Size.** `signal-only` and `core` bundle the whole graph core, so any byte here counts against the tightest budget. The RC measured 7025 B in `signal-only` against a budget of 7040 B (15 B of headroom), and 7068 B in `core` against 7104 B.

| Variant | `signal-only` gzip | `core` gzip |
| --- | ---: | ---: |
| module boolean + adapter callback, reset at creation start | 7070 (over) | 7109 (over) |
| same, no reset at start | 7060 (over) | 7100 |
| `Dirty` mark (incorrect, see above) | 7031 | 7074 |
| dependency scan for a `Dirty` external bridge | 7056 (over) | 7099 |
| bit `128`, named constant | 7043–7046 (over) | 7085–7087 |
| **bit `128` as a commented literal (final)** | **7038** | **7081** |

The minified bundle keeps `//#region dist/<chunk>-<hash>.js` comments, so a few bytes of every measurement move with the content hash. With that noise removed, the fix itself is about 18 B gzip. The final form fits with no budget change; a comment at the literal explains why it is not a named constant.

### 4. Class fields received an automatic hook boundary (transform defect, fixed)

**Reproduction.** On the RC, this module was rewritten in `auto` and `all` mode:

```tsx
class Page extends Component {
  Header = () => <h1>{count.value}</h1>;
  static Cell = () => <p>{count.value}</p>;
  useThing = () => count.value;
  render() { return this.Header(); }
}
```

All three fields got `const _signals = _useManagedSignals(); try { … } finally { _signals.finish(); }`. A `@signalTracking` comment on a class field was honoured in `manual` mode too. `this.Header()` then calls a hook inside a class component's `render()`, which React rejects; `items.map(this.Row)` runs one per item. `ClassProperty` was a candidate (`isComponentCandidatePosition`) and was named by its key (`getKeyedIdentityName`). But `getKeyedAccessPath` already documented that a class field is reached only through an instance, which the use-site walks (`isPlainCalledComponent`, `isKeyedRenderCallback`) cannot follow. That is the same reason `this.Row = …` was already excluded.

**Decision.** Remove class fields from automatic candidacy and from keyed naming. This covers instance and `static` fields, arrow and function values, and PascalCase and `useX` keys. No new instance or control-flow analysis is attempted. A `@signalTracking` comment on a class field now reaches the existing "annotation is ignored" warning instead of injecting a hook. Unchanged:
- object properties
- object-literal methods
- static member assignments (`Card.Header = …`)
- ordinary components, hooks, and HOCs
- the existing `this.Row = …` exclusion

**Documentation.** Both plugin READMEs no longer list `class Holder { Row = … }` as recognised. They now say that class fields and `this.Row = …` are never transformed and that an annotation on them is reported and ignored. They also explain why: a hook boundary in `this.Header()` or `items.map(this.Row)` runs inside the class render. The old README advice that a `this`-bound renderer "needs an explicit `useSignalTracking()` call or `@signalTracking` comment" was wrong on both counts:
- The annotation is ignored there.
- A hand-written hook is only valid if the function is rendered as an element.

It now says exactly that: only a function rendered as `<this.Row />` may call `useSignalTracking()` itself. A source comment in `transform.ts` had the same claim and was corrected.

**Regression tests** (`packages/unplugin-react-fine-grained-signals/tests/transform.test.ts`). The three new tests all fail on the RC transform:
- Instance, `static`, arrow, function, and `useX` class fields are left untouched in `auto` and `all`.
- An annotated class field is left untouched and the ignored-annotation warning is reported.
- Object-property, object-method, and member-assignment slots in the same module are still transformed (three boundaries) while the class field is not.

The earlier test "names a component held in an object-literal namespace or a class field" asserted the unsafe class-field boundaries. Its namespace half is kept unchanged as "names a component held in an object-literal namespace"; its class-field half is replaced by the tests above. The existing `this.Row = …` exclusion test and every other candidacy test pass unchanged.

### 5. deepSignal array identity lookups missed raw objects (pre-existing since v0.1, fixed)

**Reproduction.** On the RC, with `const a = { id: 1 }, b = { id: 2 }; const state = deepSignal({ items: [a, b] })`:
- `items.includes(a)` was `false`, and `indexOf(a)` and `lastIndexOf(a)` were `-1`.
- `items.splice(items.indexOf(a), 1)` removed `b`, leaving `[{ id: 1 }]`.

Elements are stored raw but read through the proxy as proxies, so the native identity comparison sees `proxy(a) !== a`. The published v0.1.1 behaves the same. This is not a v0.2 regression; it is fixed now because the failure mode silently deletes the wrong element.

**Fix** (`src/core/deep-signal-engine.ts`). A narrow raw-retry on the existing per-array method cache, in the shape of Vue 3.6's `searchProxy`, covering only `includes`, `indexOf`, and `lastIndexOf`:
1. The proxied search runs first, exactly as before: same tracked reads, same native result, including `fromIndex` and `NaN` handling.
2. Only when it misses and the argument is an object does the wrapper search again with the raw argument on the raw array (`toRaw`). The retry is untracked, because the proxied pass has already read every index it could match and `length`.

Mutator batching and untracking are unchanged, and no other array method is wrapped.

**Regression tests** (`tests/post-m3-review-regressions.test.ts`). Five of the seven fail on the RC; the proxy and primitive tests are guards:
- raw objects with `includes`, `indexOf`, and `lastIndexOf`, including duplicates and a non-member
- a root array, and an element pushed later
- the proxy an element reads as
- primitives, including `NaN` (`includes` true, `indexOf` -1), `undefined`, and duplicates
- positive and negative `fromIndex` for all three methods
- `splice(indexOf(raw), 1)` removes the right element
- a lookup inside an effect re-runs on push and on index writes, and a lookup is not batched

**Documentation.** A bullet in the migration guide's deepSignal section, in both languages.

**Performance.** Measured in-process and interleaved over 31 rounds on a 100-element deep array, 2,000 `indexOf` calls per sample, in four runs that covered both load orders. The values are control/variant ratios, where >1 means the fix is faster:
- A proxy-element hit: 0.968–1.065.
- A primitive search: 0.936–1.028.
- An object miss, which also pays the raw retry: 0.902–1.008.

The directions are mixed, so this is noise plus at most a few percent for the extra wrapper call on these three methods. They are not on any measured hot path, and reads, writes, and mutators are unchanged.

**Size.** `deep` measured 11978 B gzip against its 12032 B budget; the RC measured 11833 B. The entries without DeepSignal are unaffected.

### 6. Pack and publish could package a stale `dist` (fixed)

- **Finding:** Neither package had a lifecycle build. `pnpm pack` and `pnpm publish` packed whatever `dist` already held, so a forgotten build or a stale one would be published as-is. `tests/consumer-smoke.mjs` guarded against a missing build, but not a stale one.
- **Changes:**
  - **Runtime:** `prepack: pnpm build:runtime`. It builds only the runtime, so there is no workspace-wide build and no recursion.
  - **Transform:** `prepack: pnpm build`, the package's own `tsdown && node tests/build-smoke.mjs`. It also runs the existing build smoke, which includes the `require()` check of every entry.
  - The transform's `prepublishOnly` pnpm guard is kept: `workspace:^` must still be rewritten by pnpm.
  - The release tool is unchanged (`pnpm publish`), and no release workflow was added.
- **Consumer smoke:** Its prebuilt-`dist` guard is obsolete now that packing builds, so it was removed. Its comment now explains that packing rebuilds. `pnpm test:consumer` is now just `node tests/consumer-smoke.mjs`, because the packs themselves build and a preceding `pnpm build` would only duplicate that. The CI step comment in `test.yml` is updated; the CI steps themselves are unchanged. In CI the consumer smoke rebuilds `dist` while the test suites may still be running. That is safe:
  - The runtime suite reads no `dist`.
  - The transform suite does not need the root `dist`: with the root `dist` moved aside, `react-execution` and `react-compiler` still passed, 25/25.
  - The size check, which does read `dist`, has already finished by then.

**Lifecycle verification.**
- Both `dist` directories were deleted, and `pnpm pack` was run in each package directory. The output shows `prepack$ pnpm build:runtime` and `prepack$ pnpm build`, and both tarballs contained a complete freshly built `dist`.
- A marker file was then planted in each `dist` and both packages were packed again. The marker was absent from both tarballs, because tsdown cleans before building.
- `pnpm publish --dry-run --no-git-checks` showed the same order in each package: for the transform, `prepublishOnly` (the pnpm guard) then `prepack`; for the runtime, `prepack`. Nothing was published.
- The packed manifests:

| Package | `version` | peer | dependencies |
| --- | --- | --- | --- |
| runtime | `0.2.0` | `react: >=19.0.0` | `alien-signals: 3.2.1` |
| transform | `0.2.0` | `react-fine-grained-signals: ^0.2.0` (from `workspace:^`) | `@babel/core ^8.0.6`, `@babel/helper-plugin-utils ^8.0.1`, `@babel/types ^8.0.6`, `unplugin ^3.4.0` |

- `pnpm test:consumer` installed those freshly packed tarballs into the clean consumer and passed.

## Validation

The complete gate was run after the final change, unmodified, without worker limits, and with no change to thresholds or budgets. An earlier full run of a draft failed `pnpm size` (`signal-only` 7070 B > 7040 B, `core` 7109 B > 7104 B) and `git diff --check`. The diff-check failure came from CRLF endings on the 26 lines inserted into `deep-signal-engine.ts`, a file whose committed lines are mixed CRLF/LF. Both were fixed:
- the inserted lines are LF, so the diff touches only those 26 lines;
- the size fix is described in finding 3.

The table is the rerun.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | passed (runtime and transform) |
| `pnpm lint` | passed: 0 errors, 96 existing warnings (unchanged from M3; none from the new tests) |
| `pnpm test` | passed: runtime 30 files / 370 tests (M3: 29 / 356); transform 5 files / 262 passed, 3 skipped (M3: 259 / 3) |
| `pnpm test:coverage` | passed (see below) |
| `pnpm build` | passed, including the transform build smoke |
| `pnpm test:phase4-duplicate` | passed: 3 independent Alien systems |
| `pnpm test:mixed-version` | passed against the published `0.1.1`: `isSignal` is rejected and JSX children throw in both directions |
| `pnpm test:consumer` | passed: both packages packed through `prepack` and installed as tarballs into the clean consumer |
| `pnpm prepare:e2e` | passed |
| `pnpm --dir examples/react-router run typecheck` | passed |
| `pnpm test:browser` | passed, 27/27 |
| `pnpm size` | passed, no budget change |
| `git diff --check` | passed |

Coverage, with thresholds unchanged:

| Suite | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| Runtime (thresholds 92/83/96/94) | 93.99% | 86.65% | 97.56% | 95.27% |
| Transform | 92.89% | 90.71% | 95.36% | 96.72% |

Package size, in exact gzip bytes. The budgets are unchanged, and the structural marker checks passed:

| Scenario | M3 | Now | Budget |
| --- | ---: | ---: | ---: |
| signal-only | 7025 | 7038 | 7040 |
| core | 7068 | 7081 | 7104 |
| core+hooks | 8696 | 8710 | 8768 |
| deep | 11833 | 11977 | 12032 |
| index-full | 16397 | 16532 | 17280 |
| jsx-runtime | 10695 | 10707 | 11264 |
| utils | 8539 | 8549 | 8640 |

About 13 B of every entry is the effect fix. `deep` and `index-full` add the lookup wrapper (about 130 B). The rest is chunk-hash noise in the region comments. `signal-only` is now 2 B under its budget. The next change that touches the graph core will need a deliberate budget decision.

## Deferred review findings

These items from the same review are deliberately not part of this closure. They are recorded for after v0.2.0:
- deepSignal Map/Set redesign
- bound `value`/`checked` not snapping back when `onChange` rejects input (controlled-input semantics)
- effect error reporting through both `console.error` and `reportError`
- public JSDoc cleanup (thin hook docs, internal terms in `.d.ts`, `NotDeepSignal` not exported)
- Babel parser syntax: standard decorators after `export`, Flow, and source-phase imports
- Vite `cacheDir` outside `node_modules`, and no hook `filter`
- CommonJS input files receiving an ESM import
- warnings sent through `console.warn` rather than the bundler warning API
- docs terminology and internal links into `development/`
- runtime `require()` support (`default` export conditions)
- `devEngines` exact pin breaking `npm pack`
- production `NODE_ENV` stripping
- benchmark artifact cleanup
- helper class renaming (`HelperBrandSignal`)
- `useSignal(() => value)` lazy initializer

No release-blocking defect outside the six items was found while working.

## State

- Both manifests are still `0.2.0`.
- `alien-signals` is still exactly `3.2.1`.
- The v0.1 alias is still `npm:react-fine-grained-signals@0.1.1`, and the mixed-version smoke is unchanged.
- The packed transform peer is `^0.2.0`.
- No tag, push, publish, or GitHub Release was performed.
- The final RC needs a fresh GitHub Actions Test/E2E pass on the closure commit before it can be tagged.
