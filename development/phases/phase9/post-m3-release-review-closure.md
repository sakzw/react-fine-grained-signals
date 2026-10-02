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
- bound `title`/`id` updated to `null` leave an empty attribute instead of removing it (present since v0.1)
- `auto` mode does not detect destructured reads (`const { value } = count`)
- `auto` mode does not credit a keyed callback's reads (`items.map(parts.Row)`, or a destructured `Row`) to its caller. This is now documented as a README limitation; the callback itself is safely kept off a boundary.
- the "anonymous default export left untransformed" warning also fires for files that read no signal
- `include`/`exclude` receive raw bundler IDs (path separators differ by bundler on Windows)
- render-callback detection beyond `map`/`flatMap`/`forEach`, `Array.from`'s `mapFn`, and one-step destructuring of a keyed slot: re-assigned aliases (`const Alias = Row`, already a documented limitation), deeper patterns, and render props

No release-blocking defect outside the six items was found while working. The final pre-release follow-up below found and fixed two more.

## Final pre-release follow-up

This follow-up was done after the closure commit `5d6370b` was pushed and its Test/E2E runs succeeded. It had three parts:
- correct the cross-generation migration wording;
- investigate two transform callback gaps as possible release blockers;
- clean up review findings that are documentation- or comment-only.

### Cross-generation migration wording

**Reproduction.** A probe rendered the published v0.1.1 package next to the v0.2 sources under jsdom, in both directions:

| Use of the other generation's signal | Result |
| --- | --- |
| JSX child | Throws "Objects are not valid as a React child" |
| Host prop | Passed through as an ordinary value: `class`, `title`, and `value` become `"[object Object]"`; `hidden` and `disabled` are set while the signal holds `false`; a later write changes nothing |
| `Show` `when`, `Match` `when` | The object is truthy, so the content renders for a `signal(false)` |

**Change.** `docs/migration/v0.2.md` and `docs/migration/v0.2.ja.md` now state the unsupported status first, then the outcome for each place a signal can be used. No compatibility behavior was added.

### Transform callback gaps (release blockers, fixed)

Both gaps reproduced. The RC transform gave the per-item function its own `useManagedSignals()` boundary:
- `function Star() {…}` passed as `Array.from({ length: 5 }, Star)`;
- `const parts = { Row: () => … }` used as `const { Row } = parts; items.map(Row)`.

Rendered through the existing execution harness, both crashed with "Rendered more hooks than during the previous render" as soon as the length or the item count changed. The same gap applied to `{ Row: Item }` and to a destructured `Row()` plain call.

**Fix** (`transform.ts`):
- `getRenderCallbackArgument` now names the per-item argument slot. It is argument 0 of `map`/`flatMap`/`forEach`, as before, and argument 1 of `Array.from(arrayLike, mapFn)` when the callee object is the identifier `Array`.
- `isRenderCallbackInvocation` and the caller-side read fold both use it. So `Star` stays unwrapped, and `Rating` is transformed and owns its reads, exactly like `items.map(Star)`.
- `getKeyedSlotUses` now also follows one-step destructuring of a keyed slot's last key (`const { Row } = parts` or `{ Row: Item }`) into that binding's references. Both by-key exclusions use this list, the render-callback one and the plain-call one, so `items.map(Row)` and `Row()` are both kept off a boundary.

Deeper patterns and re-assigned aliases are not followed. JSX use of the destructured name (`<Row />`) keeps the boundary.

As with the existing `items.map(parts.Row)`, `auto` mode does not credit the keyed callback's reads to the caller. A caller that reads no signal itself is then left untransformed, so the failure direction is a stale UI, not a crash. This is now listed as a known limitation in both plugin READMEs, with the workarounds (read in the caller, `mode: "all"`, or `@signalTracking` on the caller); a test pins the annotated-caller workaround.

**Regression tests:**
- `tests/react-execution.test.ts`: two cases, each asserting a single boundary and that the DOM renders, survives a length or item-count change, and stays subscribed. All four fail on the RC transform with the hook-count error.
- `tests/transform.test.ts`, a new describe block:
  - `Array.from` mapFn, in `all` mode;
  - argument 0 of `Array.from` and a non-`Array` `.from` stay eligible;
  - shorthand, renamed, and plain-call destructuring;
  - the annotated-caller workaround;
  - JSX use keeps the boundary.

  The two cases that cover the reported gaps fail on the RC transform.

**Documentation.** Both plugin READMEs now list `Array.from`'s `mapFn` and destructured keyed callbacks under render-callback detection, and add the fifth known limitation above.

### Pre-release documentation and comment cleanup

These changes contain no behavior change:
- **ESM wording.** `docs/guides/rendering-optimization.md` (EN/JA) no longer tells readers to avoid `require()`. It says the plugin ships ESM only and that a CommonJS config can still `require()` it through `require(esm)`, linking the plugin README's installation section.
- **Server rendering.** `docs/guides/global-state.md` (EN/JA) now explains why nothing subscribes on the server: `useSyncExternalStore`'s `subscribe`, effects, and refs are never run by `renderToString` or `renderToPipeableStream`. This replaces the nonexistent `useEffect` fallback and the internal `commit()` name.
- **Migration notes** (EN/JA). Signals in array children are keyed by position (`rfgs-signal:${index}`, absent in v0.1.1), and the plugin matches `.TSX`/`.JSX` case-insensitively (`/i`, absent in the v0.1.1 regex).
- **Root README** (EN/JA). The Vite example imports `defineConfig`. A new paragraph states that React 19+ is a peer dependency, that Node.js 22+ is required, and that `moduleResolution` must be `bundler`, `node16`, or `nodenext`, because entry points and types are published through `exports` only.
- **`src/runtime/jsx.ts` comments.** They point to `development/design/direct-binding-value-checked-style.md`, and to `updateComputed` and `reportFailure` in `alien-derived-runtime-core.mts`, instead of the moved doc and the nonexistent `src/core/base.ts`. These are comment-only edits.
- **Guide snippets** (EN/JA).
  - `global-state`: the snippets now declare `Task`, `TaskStore`, and `seedState` and import `useSignalTracking`, `useRef`, `computed`, and `deepSignal`. The three snippets were extracted and type-checked with `tsc --strict` against `src`.
  - `hooks`: the `useSignalValue` signature notes that a deepSignal is rejected at compile time.
  - `rendering-optimization`: "the tracking boundary note" links to its anchor.
  - The `global-state` "Tests" paragraph no longer refers to this repository's tests.
- **Link to `tests/fixtures/consumer-vite`.** The `jsx-bindings` link is kept. It resolves in the repository, and it is the fixture the sentence describes.

The EN and JA code blocks of every edited guide match. Every relative link and anchor in the edited documents resolves.

### Follow-up validation

Production transform code changed, so the complete gate was rerun without worker limits, with thresholds and budgets unchanged:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | passed |
| `pnpm lint` | passed: 0 errors, 96 existing warnings (unchanged) |
| `pnpm test` | passed: runtime 30 files / 370 tests; transform 5 files / 271 passed, 3 skipped (previously 262 / 3) |
| `pnpm test:coverage` | first run: one runtime test, `concurrent.test.tsx` "keeps every sibling of a large fan-out consistent after one transitioned write", timed out at 5623 ms against the 5000 ms default while unrelated local type-check jobs were running. The same test had passed in `pnpm test` minutes earlier. No runtime code changed in this follow-up, only comments in `jsx.ts`. A standalone rerun passed: 370/370 and 271/3. |
| `pnpm build` | passed |
| `pnpm test:phase4-duplicate` | passed |
| `pnpm test:mixed-version` | passed against the published `0.1.1` |
| `pnpm test:consumer` | passed: both packages packed through `prepack` and installed as tarballs |
| `pnpm prepare:e2e` | passed |
| `pnpm --dir examples/react-router run typecheck` | passed |
| `pnpm test:browser` | passed, 27/27 |
| `pnpm size` | passed, no budget change |
| `git diff --check` | passed |

Coverage, from the passing rerun:

| Suite | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| Runtime | 93.99% | 86.65% | 97.56% | 95.27% |
| Transform (thresholds 92/90/92/95) | 92.62% | 90.72% | 95.45% | 96.65% |

Exact gzip sizes (bytes), within budget:

| Scenario | Size |
| --- | ---: |
| signal-only | 7038 |
| core | 7080 |
| core+hooks | 8707 |
| deep | 11979 |
| index-full | 16534 |
| jsx-runtime | 10708 |
| utils | 8549 |

These differ from the closure's numbers only by a byte or two of chunk-hash noise; the runtime source changed only in comments.

## State

- Both manifests are still `0.2.0`.
- `alien-signals` is still exactly `3.2.1`.
- The v0.1 alias is still `npm:react-fine-grained-signals@0.1.1`, and the mixed-version smoke is unchanged.
- The packed transform peer is `^0.2.0`.
- The closure commit `5d6370b` was pushed at the user's request, and its GitHub Actions Test/E2E succeeded. The follow-up is a separate commit and needs its own Test/E2E pass.
- No tag, publish, or GitHub Release was performed.

## Final targeted release-blocker validation

### Starting point and scope

- Starting commit: `05fa6fb2cdea165ca35f078ad4d6035ba69ed3ab` (`fix: close final v0.2.0 pre-release follow-up`). Its GitHub Actions Test and E2E had passed.
- The working tree was clean. Both packages were `0.2.0`, and `alien-signals` was exactly `3.2.1`.
- No `v0.2.0` tag existed, and npm listed only `0.1.0` and `0.1.1` for both packages.

A later review reported three v0.2 regressions. This pass validated exactly those three: P1, P2, and P3 below. Each was reproduced on `05fa6fb` before any production change and compared with the published v0.1.1. All three were confirmed and fixed. Nothing else was investigated or changed, apart from one related form-reset check that the P2 investigation required.

### P1 — a computed first read during a render could stay stale

**Reproduction.**

```ts
const darkMode = signal(false);
darkMode.value = true; // nothing observes darkMode yet
const theme = computed(() => (darkMode.value ? "dark" : "light"));
// A tracked component renders theme.value ("dark") and commits.
darkMode.value = false;
```

| First read of `theme` | v0.1.1 after the write back | `05fa6fb` after the write back |
| --- | --- | --- |
| bare `useSignalTracking()` render | `"light"` | `"dark"` (DOM and `peek()`) |
| managed `useManagedSignals()` render | `"light"` | `"dark"` |
| `peek()` or an ordinary effect | `"light"` | `"light"` |

At runtime level, the failure also occurred when:
- the computed was created before the unobserved write;
- the source had a subscriber that was disposed before the write;
- an effect subscribed to the promoted computed later;
- the render cached an error from the computed.

**Cause.** These are the two halves:
- A render reads a source through `readSource` in `render-runtime.mts`. That returns the source's `pendingValue` without settling a Dirty source.
- At commit, `promoteComputed` linked the new computed to that still-Dirty source. The source's committed `currentValue` was still the value from before the write.

A later write back to that committed value then reached `updateSource` through `checkDirty`. `updateSource` compared the new value with the stale `currentValue`, saw no change, and so the computed kept its speculative value until some other write came along. Alien 3.2.1's own signal read (`signalOper`) settles a Dirty signal before it calls `link()`; promotion did not.

**The same invariant, a second case.** The investigation found a second way to break the same invariant: a computed *dependency* that a write left Pending between render and commit.
- A computed's revision moves only when it re-evaluates, so promotion's revision check passed.
- Promotion then marked the new computed clean on top of a Pending dependency.

Repro through React: `<Writer /><Reader />`, where `Writer`'s layout effect writes the source behind `Reader`'s inner computed. `05fa6fb` rendered `3` and stayed stale; v0.1.1 rendered `5`. This case was fixed with P1 because it lives in the same function and breaks the same invariant: a dependency must be linked in the state the speculative read observed.

**Fix** (`promoteComputed` in `alien-derived-runtime-core.mts`):
- A Dirty local source is settled before it is linked, using `readSourceUntracked`, the existing read half of the graph read.
- Promotion is refused when a local computed dependency is not clean. This is the same currency rule that `isEntryCurrent` already applies when a cached entry is reused. A refused computed stays uninitialized, and the store's existing changed-during-render path re-renders.

The render read path, the speculative cache, and the write path are unchanged.

**Tests** (`tests/final-release-blocker-regressions.test.tsx`): 15 tests. 11 fail on `05fa6fb`. The other 4 are guards:
- a nested chain read through an inner computed;
- memoization of the promoted value;
- a source change between render and commit, which still refuses promotion;
- a first read in an ordinary effect.

**Performance.** Only promotion changed; the read and write paths are code-identical. Bundles of `src/core/reactive-runtime.ts` from `05fa6fb` and from the fix were compared in-process:
- Method: interleaved paired runs, 41 rounds, alternating order, `--expose-gc`, both module load orders, repeated.
- Load order dominated the raw ratios. For example, the code-identical `source/read` measured 3.63 in one order and 0.27 in the other.
- Order-balanced geometric means for unobserved and observed source writes, source reads, clean and dirty computed reads, and observed recomputation were 0.98–1.05.
- The commit-time promotion workloads ranged 0.90–1.04 across repeats, with no consistent direction.

No material regression was found.

**Size.**
- `signal-only` grew from 7036 B to 7054 B gzip (+18), which is 14 B over its 7040 B budget.
- `core` grew from 7079 B to 7094 B (budget 7104).

The two checks are already in minimal form. The `signal-only` budget was raised by one 64-byte step, from 7040 to 7104, the granularity every budget in `scripts/size-budget.json` uses. No other budget changed. The structural checks still pass: no DeepSignal or React-store code in `signal-only` or `core`.

### P2 — switching a host prop from a signal back to a plain value could leave stale DOM

**Reproduction.** `<button disabled={bound ? dis : false}>`. Render with `bound`, write `dis.value = true` off-render, then re-render with `bound = false`:

| Prop | v0.1.1 | `05fa6fb` |
| --- | --- | --- |
| `disabled` (signal → `false`) | enabled | still disabled |
| `className` (`"x"` → write `"y"` → plain `"x"`) | `"x"` | `"y"` |
| `style` (`{color: red}` → write `{color: blue, fontWeight: bold}` → plain `{color: red}`) | `color: red` | `color: blue; font-weight: bold` |

- v0.1.1 got this right only because its wrapper changed the element type and remounted the node.
- A plain value that *differs* from the render-time snapshot was already applied on `05fa6fb`.
- Plain → signal and signal → another signal were already correct.

Real Chromium shows the same `05fa6fb` result. In both builds the node identity, the focus, and a sibling field's typed value were kept.

**Cause.**
- React is handed a render-time snapshot of a bound prop (`readInitialValue`, a `.peek()`). The binding then writes the DOM directly.
- React 19 detaches a host's old ref right before it diffs the host's props (`commitMutationEffectsOnFiber`: `safelyDetachRef`, then `commitHostUpdate`). That diff starts from the snapshot.
- So a plain value equal to the snapshot was skipped, while the binding had already been detached.

**Fix** (`src/runtime/jsx.ts`). The ownership handoff point is that ref detach:
- Each binding tuple carries the snapshot React was handed.
- The `prop` and `style` writers record the last value they applied and expose `restore(snapshot)`.
- On a current (not stale) detach, the binder restores each `prop`/`style` binding to its snapshot. It skips the write when the last applied value already equals the snapshot. React's diff then applies the plain value.
- Two-way kinds (`value`, `checked`, `select`) are untouched. React reads their uncontrolled default only at mount, and on a switch to a controlled plain value React compares against the DOM itself. Guard tests cover both.
- So that the restored snapshot is always the committed one, the binding-ref cache now also matches snapshots: `Object.is` for `prop`, shallow content for `style`, whose snapshot is a fresh copy every render. An owner re-render that hands React a different bound value therefore gets a new ref:
  1. The old ref's detach restores the snapshot.
  2. React writes the new snapshot.
  3. The re-attach refreshes in the same commit.

  Without this, a re-render with a newer snapshot followed by a switch back to that value left the old value. The test "uses the snapshot of the latest committed render, not the first" covers this.

There is no wrapper and no remount, and the element keeps its identity.

**Behavior notes:**
- **Stable user refs.** A stable user ref is now also detached and re-attached within one commit when the owner re-renders with a different bound `prop`/`style` value than its previous render. Before, that happened only when the bindings themselves changed. The `jsx-bindings` guide (EN/JA) now says so.
- **Unmounted nodes.** A node removed by unmount now carries the props React last rendered instead of the binding's last write. Detach cannot tell an unmount from a prop switch, and React diffs right after it. Two existing assertions encoded the old detached value, and they now assert the rendered value. Both still prove that a write after unmount is ignored:
  - `tests/react-signal-elements.test.tsx` "keeps a StrictMode host binding live for one update and inert after unmount";
  - `e2e/browser.spec.ts` "cleans a StrictMode host binding after unmount", in Chromium, Firefox, and WebKit.
- **Hidden Activity or Suspense boundaries.** A hidden boundary detaches refs, so the node is restored while hidden and refreshed on reveal. A plain value rendered while hidden is applied. Tests cover both.

**Tests** (same file): 13 tests. 7 fail on `05fa6fb`. The other 6 are guards:
- `value` and `checked` switches;
- a plain value that differs from the snapshot;
- a switch from one signal to another;
- two Activity cases.

**Size.**
- `jsx-runtime` grew from 10708 B to 10895 B gzip (+187), within its 11264 B budget.
- `index-full` grew from 16533 B to 16758 B (+225), within its 17280 B budget.

### P2 companion — form reset after a user edit (distinct, documented)

This was reproduced in jsdom against the P2 fix, and in Chromium on `05fa6fb` during the review:
1. A bound input, textarea, or checkbox whose `onChange` writes the signal.
2. The user edits it.
3. `form.reset()` or React 19's reset after a `<form action>` then restores the render-time value (`"init"`) while the signal holds the edit.

These cases restore the signal's value:
- a programmatic write, then a reset;
- an edit followed by a programmatic write, then a reset;
- a write made in the action or in `onReset`.

**Cause.** After a change event, React restores the target's controlled state from the fiber's props. That re-applies the render-time `defaultValue`/`defaultChecked` over the default the binding had just synchronized. This is not the ref-detach path, so the P2 fix does not reach it, and a fix would need a separate redesign.

**Decision.** Narrow the claim rather than redesign. These docs now state the actual contract (a reset restores the last value written to the signal, except after a user edit) and the workaround (write the signal in the action or in `onReset`):
- `docs/guides/jsx-bindings.md` and `.ja.md`, "value and checked";
- `docs/migration/v0.2.md` and `.ja.md`, "JSX and hooks".

### P3 — parameter relocation could emit a required parameter after an optional one

**Reproduction.** In a `.ts` or `.tsx` module:

```ts
export function useLabel(prefix?: string, value = count.value) { … }
```

- `05fa6fb` emitted `useLabel(prefix?: string, _param)`.
- A Vite 8.3.1 build (`builtin:vite-transform`, Oxc) then failed with "A required parameter cannot follow an optional parameter": 3 errors for a fixture with three such functions.
- v0.1.1 left the parameter list untouched (it did not relocate parameters), so its output was valid.

**Cause.** `relocateTrackedParameters` replaces each moved parameter with a generated identifier and never marked that identifier optional.

**Fix** (`transform.ts`):
- The generated parameter is marked `?` exactly where TypeScript treats the original as optional:
  - when the original carries `?`;
  - or when it has a default and every parameter after it is optional or a rest element.
- `(value = sig.value, required: number)` therefore keeps a required `_param`.
- The marker is emitted only when the file was parsed with Babel's `typescript` plugin, so JavaScript output is unchanged.

Semantics are unchanged:
- Omitting the argument or passing `undefined` still applies the default, and passing a value still uses it.
- `function.length` is unchanged from `05fa6fb`'s output (the marker is type-only). The pre-existing, documented relocation length change remains: `useLabel` has length 1 in source and 2 after the transform.
- Rest parameters, type annotations, destructuring, and `forwardRef`'s two-parameter shape are unchanged.

**Tests** (`packages/unplugin-react-fine-grained-signals/tests/transform.test.ts`, "parameter optionality after a relocated default"). Each output is also parsed with Vite's `transformWithOxc`. The new tests cover:
- a component and a custom hook in both managed and inject modes;
- eight further TypeScript shapes, including a defaulted parameter followed by a required one;
- a JavaScript guard.

The three TypeScript tests fail on `05fa6fb`. Two existing `.tsx` expectations that asserted a required `_param` after a default now assert `_param?`. A real `vite build` of the fixture fails with the `05fa6fb` plugin and succeeds with the fix.

### Validation

The complete gate ran after the fixes, unmodified and without worker limits, and with no threshold change. The only budget change is the `signal-only` step above.

The first run failed `pnpm test:browser`: 3 of 27, the StrictMode unmount test in each browser, because of the detached-node behavior note under P2. Its lint passed but reported four new warnings from the new tests, and the tests were restructured to remove them. After those changes, `typecheck`, `lint`, `test`, `test:coverage`, `test:browser`, `size`, and `git diff --check` were rerun. The rest of the gate ran on the final production code.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | passed |
| `pnpm lint` | passed: 0 errors, 96 existing warnings (unchanged) |
| `pnpm test` | passed: runtime 31 files / 398 tests (previously 30 / 370); transform 5 files / 275 passed, 3 skipped (previously 271 / 3) |
| `pnpm test:coverage` | passed (see below) |
| `pnpm build` | passed |
| `pnpm test:phase4-duplicate` | passed: 3 independent Alien systems |
| `pnpm test:mixed-version` | passed against the published `0.1.1` |
| `pnpm test:consumer` | passed |
| `pnpm prepare:e2e` | passed |
| `pnpm --dir examples/react-router run typecheck` | passed |
| `pnpm test:browser` | passed, 27/27 |
| `pnpm size` | passed (`signal-only` budget 7104) |
| `git diff --check` | passed |

Coverage, with thresholds unchanged:

| Suite | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| Runtime (thresholds 92/83/96/94) | 94.14% | 86.91% | 97.60% | 95.44% |
| Transform (thresholds 92/90/92/95) | 92.70% | 90.81% | 95.45% | 96.69% |

Exact gzip sizes (bytes):

| Scenario | `05fa6fb` | Now | Budget |
| --- | ---: | ---: | ---: |
| signal-only | 7036 | 7054 | 7104 (was 7040) |
| core | 7079 | 7094 | 7104 |
| core+hooks | 8708 | 8718 | 8768 |
| deep | 11978 | 11998 | 12032 |
| index-full | 16533 | 16758 | 17280 |
| jsx-runtime | 10708 | 10895 | 11264 |
| utils | 8548 | 8567 | 8640 |

### Release notes

A draft of the v0.2.0 GitHub Release notes is in [`v0.2.0-release-notes.md`](./v0.2.0-release-notes.md). Nothing has been released.

### State after the targeted validation

- Both manifests are still `0.2.0`, and `alien-signals` is still exactly `3.2.1`.
- The fixes are one local commit on top of `05fa6fb`. It was not pushed, and it needs its own GitHub Actions Test/E2E pass before tagging.
- No tag, publish, or GitHub Release was performed.

## Core runtime audit remediation

### Starting point and scope

- Starting commit: `7d8799944222f880f95c2c3634c073bc7479afaa` (`fix: close final v0.2.0 release blockers`), the commit the targeted validation above produced. `main` and `origin/main` both pointed to it, and the working tree was clean.
- Both packages were `0.2.0`, and `alien-signals` was exactly `3.2.1`.

An independent release-blocker audit of the core reactive runtime treated `7d87999` as a fresh RC and compared it with the published `0.1.1` and with Alien Signals 3.2.1. It confirmed six blockers (A1–A6) and two related follow-up checks. This pass fixes exactly those. React/JSX binding and transform findings from other audits are not touched here.

The audit used two baselines for `0.1.1`:
- Single-copy behaviour is the published `0.1.1` artifact.
- Multi-copy behaviour is two `0.1.1` copies resolving one shared `alien-signals`. That is what `0.1.1`'s peer dependency produced, and it behaves exactly like one copy in all 25 cross-copy scenarios the audit ran.

### A1 — promoting a speculative computed that read another copy crashed

**Reproduction.**

```ts
const count = library.signal(1);                // another RFSG v0.2 copy
const doubled = computed(() => count.value * 2); // this copy, never read before
// A tracked component renders doubled.value.
```

- `7d87999`: the commit threw `TypeError: Unknown candidate readable` from the layout effect, and the error boundary rendered it.
- `0.1.1`: rendered `doubled=2`, then `doubled=10` after `count.value = 5`.

**Cause.**
1. During the speculative evaluation, the foreign getter publishes its read to the render owner (`owner.add(protocol, revision)`).
2. So the entry's dependency map is keyed by the other copy's `ReadableProtocolV1` object, not by a readable.
3. `promoteComputed` passed every key to `getReadableRevision`, which accepts only readables, and so threw.

`isEntryCurrent` had its own, different protocol assumption.

**Fix.**
- `isReadableProtocol` (in `foreign-readable-v1.mts`) is now the one shape check for this distinction.
- `getDependencyRevision` reads a protocol key's revision from the protocol itself, and a readable key's from its readable. `promoteComputed`, `isEntryCurrent`, and the render adapter's `getRenderVersion` all use it.
- Promotion validates every revision before touching the graph. It then hands a protocol key straight to `ensureForeignNode` while linking. The protocol is never rediscovered through a readable, and revision validation is unchanged.

### A2 — a later render attempt that promoted first could leave an earlier one torn

**Reproduction.**
1. A parent renders a cold `computed(() => a.value * 10)` and gets `10`.
2. React yields, an event writes `a.value = 2`, and the child renders the same computed as `20`.
3. The child's layout effect commits first.

- `7d87999`: the parent committed `10` and the child `20`. Nothing re-rendered the parent.
- `0.1.1`: re-rendered the parent, and both showed `20`.

This was reproduced through real React with `scheduler/unstable_mock`.

**Cause.**
- The child's promotion initialized the computed without advancing `renderRevision`.
- The parent's promotion then returned `true` for an already-initialized node.
- `settleRenderAttempt` only compares an attempt's speculative value with the node's when the recorded revision moved, so the parent settled as stable.

**Fix.** Promotion now participates in the revision model. Initializing a computed is a value change, exactly as in `updateComputed`, so it advances `renderRevision`. Any other attempt that read the computed before it existed then sees a moved revision, and settle compares its value/error state with the node's.

This is the invariant itself, not a special case. It covers equal values (stable), errors (compared by error state), either commit order, a computed that was warm before both renders (already handled by the real evaluation's revision bump), and aborted attempts (never promoted).

### A3 — cross-copy graphs exposed states no write produced

**Reproduction.**

```ts
const qty = library.signal(1);
const subtotal = library.computed(() => qty.value * 10);
const label = computed(() => `${qty.value} items`);
const summary = computed(() => `${label.value} = $${subtotal.value}`);
effect(() => seen.push(summary.value));
qty.value = 2;
qty.value = 3;
```

- `7d87999`: `["1 items = $10", "1 items = $20", "2 items = $20", "2 items = $30", "3 items = $30"]`, 5 runs.
- `0.1.1`: `["1 items = $10", "2 items = $20", "3 items = $30"]`, 3 runs.

The same cause made a read inside the other copy's `batch()` return the value from before that batch's write.

**Cause.**
1. An active bridge (a foreign readable an effect watches) was trusted to be current from its subscription pushes alone. `readComputed` polled only inactive bridges.
2. The other copy delivers those pushes in its own flush order. When `subtotal`'s push arrived first, `summary` re-ran against a `label` that was clean but stale.

While fixing this, two further defects with the same root showed up in the bridge's revision bookkeeping:
- **Lost update.** A read that observed a new revision advanced `pendingRevision` without propagating. The later push for that revision was then ignored. An effect that read the foreign signal directly, inside the other copy's batch, never re-ran: `[0]` instead of `[0, 1]`.
- **Wasted recomputation.** A cold bridge's committed revision never caught up. After one foreign write, its computed re-evaluated on every read.

**Fix.** A bridge is now treated as a source whose value is the other copy's revision:
- Every newly learned revision — pushed, read, polled, or found by the subscription handshake — goes through `advance`. That marks the bridge Dirty and propagates to its subscribers, as a source write does, so `pendingRevision` never advances silently.
- A revision learned by a read or a poll is also settled at once (`observeForeignRevision`): commit, then `shallowPropagate`, as Alien's own signal read settles a pending write. The reader is never invalidated by what it just read, and no spurious re-run is left behind.
- Effects that a read queued run when the push arrives. The push listener now flushes even when the revision is already known.
- `readComputed` and `isComputedClean` poll every bridge reached through a foreign-dependent computed (`refreshForeignDependencies`), active or cold. A newer revision then invalidates the graph between the bridge and the reader before it returns.
- `update()` for a bridge commits the already-propagated `pendingRevision` instead of re-polling.

Local, non-foreign paths are unchanged. Only computeds with foreign dependencies poll, and they poll only when read.

### A4 — computed getters received the previous value and the internal node

**Reproduction.**

```ts
function total(offset = 100) { return s.value + offset; } // valid for () => T
const c = computed(total); // read, s=1, read, s=2, read
```

- `7d87999`: `100, 101, 103`. `this` was the live `RuntimeNode`; writing to it corrupted a later flush.
- `0.1.1`: `100, 101, 102`, with `this` `undefined` and no arguments.

**Cause.**
- `updateComputed` called `withGraphOwner(computed.getter, previousValue, computed)`.
- The speculative path called `node.getter(node.value)`.

**Fix.**
- `withGraphOwner` takes only a callback and calls it as `callback()`. Its argument and `this` plumbing existed only for the getter, and is removed.
- The speculative path calls a local copy of the getter with no arguments.
- The internal getter type is now `() => unknown`.

### A5 — effects created under another copy's owner were never owned

**Reproduction.**

```ts
const stop = appEffect(() => {
  const r = route.value;
  libraryEffect(() => log.push(r + tick.value));
});
route.value = "b"; route.value = "c"; tick.value = 1;
stop(); tick.value = 2;
```

- `7d87999`: `[a0, b0, c0, a1, b1, c1, a2, b2, c2]`. Every child survived its owner's re-runs and disposal, and no cleanup ran.
- `0.1.1`: `[a0, b0, c0, c1]`.

**Cause.** `effect()` linked ownership only to its own copy's `activeSub`. It ignored another copy's graph owner in the shared execution context.

**Fix.** The shared owner protocol gains one optional operation, `own(dispose)`, on `GraphExecutionOwnerV2` (and on `RenderExecutionOwnerV2`, for the follow-up below). Its meaning: register this child so it is disposed when the running owner next re-runs or is disposed.
- `effect()` calls it only when no same-copy owner applies and the current owner belongs to another copy. Same-copy ownership is never doubled.
- The owning copy implements it with `adopt`. A childless stand-in effect takes the child's place in the running subscriber's dependency list, exactly where a local child sits, so the existing child-disposal paths unlink it and its cleanup calls the disposer.
- Only a disposer callback crosses the copy boundary; no node, link, or private function does.
- Detached effects and effects created under `untracked()` stay unowned.
- A child the user already disposed is disposed again harmlessly, because disposal is idempotent.

### A6 — re-subscribing to a foreign readable ran the new effect twice

**Reproduction.** Subscribe to a foreign signal, dispose, write the signal, subscribe a new effect.

- `7d87999`: the new effect ran twice; also through a foreign computed.
- `0.1.1`: once.

**Cause.**
1. The reused inactive bridge got `pendingRevision = observed`, but its committed `revision` stayed stale.
2. The subscription handshake compared the subscription's revision with that stale value.
3. It mistook the current revision for a race, and set the stale-read retry bit.

**Fix.** This follows from the A3 bookkeeping:
- `ensureForeignNode` learns the observed revision through `observeForeignRevision` before it links the reader.
- The handshake compares the subscription's revision with the revision this copy last observed, through `advance`.

The retry still fires when the subscription reports a revision newer than the read, and that case is covered.

The audit's suggested narrower direction was to copy the observed revision into `revision` on reuse. It was not used: with another cold computed still on the bridge, that would hide the change from it.

### Follow-up 1 — effects created by a speculatively evaluated getter

**Before.** A getter's effect created during a speculative render evaluation had no owner. It survived unmount (1 alive versus 0 in `0.1.1`) and survived aborted attempts.

**Fix.** A small extension of A5. `evaluateSpeculatively` runs the getter with no running subscriber and collects every effect it creates, including another copy's through the render owner's `own`. It disposes them when the evaluation returns. A result that created effects is not promoted, so the committed computed runs its getter for real and owns exactly one child.

**Results.**
- An aborted attempt leaves nothing alive.
- A committed one has one owned child.
- Unmount disposes it.
- The speculative child's initial run still happens outside the speculative scope (the deep-read epoch is unchanged).

**Two existing tests pinned the old contract** and were updated:
- `tests/react-deep-signal.test.tsx`, "isolates an initial effect created by a speculative getter";
- the speculative block of `tests/cross-copy-smoke.mjs`.

Both expected the speculative getter's effect to stay alive behind an "already created" guard, and the getter to run only once. That behaviour is exactly this leak: an aborted attempt's effect would survive forever. Both tests now assert the new contract and keep their isolation assertions: one speculative run and its cleanup, one durable owned child, and the deep-read epoch and speculative depth restored. As before, v0.2 may evaluate a getter speculatively and again for real.

### Follow-up 2 — SSR with a foreign dependency

**Reproduction.** A warm local computed over another copy's signal or computed, whose revision moved before the server read.

`7d87999` emitted the stale value from both `renderToString` and `renderToPipeableStream`. On the client, commit-time settling had hidden the same staleness behind an extra render. The server has no commit, so it shipped the stale HTML.

**Fix.** It falls under the A3 invariant. `isComputedClean`, which the render path uses before reusing a computed's value, now polls foreign dependencies first. Both server APIs emit the current value, and the client no longer needs the corrective render.

### Regression coverage

- `tests/core-runtime-audit-regressions.test.tsx` — 43 tests: A1 (managed and bare, foreign signal and computed, adapter and React), A2, A3, A4, A5, A6, both follow-ups, and both SSR APIs. On `7d87999`, 33 fail. The 10 that pass are deliberate guards:
  - the opposite commit order, a warm computed, and equal values;
  - an aborted attempt;
  - a cold bridge read inside a batch, and two cold readers of one bridge;
  - same-copy single disposal, detached effects, and `untracked()`;
  - a genuine handshake race that must still retry.
- `tests/core-runtime-audit-concurrent.test.tsx` — the parent/child tear through real React with `scheduler/unstable_mock`, installed in Node's require cache in that file's own worker. The cold case fails on `7d87999`; the warm case is a guard.

### Performance

Bundles of `7d87999` and of the fix were interleaved in one process, two copies each: alternating order, `--expose-gc`, warmup, and 41/81/81 paired rounds. Ratios are fixed / `7d87999`, as the per-round paired median:

| Path | Ratios across the three runs | Reading |
| --- | --- | --- |
| Local source read/write | 1.00, 1.00, 0.96 | unchanged (code-identical; one 25-round run read 0.81, which is noise) |
| Local computed clean read | 1.00, 1.01, 1.01 | unchanged |
| Local computed dirty recompute | 1.13, 0.99, 1.03 | unchanged (IQR spans 1) |
| Watched local chain + effect | 1.04, 1.07, 0.92 | unchanged |
| Render promotion | 1.12, 1.03, 1.07 | no material change (IQR spans 1). A first version that checked the protocol shape three times per dependency measured 1.18; it was tightened. |
| Foreign-dependent computed read, cold | 1.00, 0.99, 1.00 | unchanged |
| Foreign-dependent computed read, watched | 1.44, 1.33, 1.44 | intended: A3's revision poll on read, about 40 ns per read |
| Foreign effect update | 0.99, 1.02, 0.99 | unchanged |

### Size

Exact gzip bytes:

| Scenario | `7d87999` | Now | Budget |
| --- | ---: | ---: | ---: |
| signal-only | 7054 | 7252 | 7296 (was 7104) |
| core | 7093 | 7291 | 7296 (was 7104) |
| core+hooks | 8718 | 8903 | 8960 (was 8768) |
| deep | 11998 | 12190 | 12224 (was 12032) |
| index-full | 16758 | 16970 | 17280 |
| jsx-runtime | 10895 | 11091 | 11264 |
| utils | 8566 | 8754 | 8768 (was 8640) |

The +185 to +212 bytes are the fixes themselves: bridge advance/settle and polling, cross-copy and speculative ownership, protocol-keyed promotion, and the promotion revision bump.
- The ownership paths were merged into one `adopt`, which saved about 20 bytes.
- The five exceeded budgets were raised to the next 64-byte step above the measured size. That is the file's granularity, and it gives less than the 5% headroom `size:update` would add.
- `index-full` and `jsx-runtime` stayed within budget and were not changed.

### Validation

The complete gate ran on the final code without worker limits, and with no threshold change.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | passed |
| `pnpm lint` | passed: 0 errors, 96 existing warnings (unchanged) |
| `pnpm test` | passed: runtime 33 files / 443 tests (previously 31 / 398); transform 5 files / 275 passed, 3 skipped |
| `pnpm test:coverage` | passed (see below) |
| `pnpm build` | passed |
| `pnpm test:phase4-duplicate` | passed: 3 independent Alien systems |
| `pnpm test:mixed-version` | passed against the published `0.1.1` |
| `pnpm test:consumer` | passed, after the smoke update in follow-up 1 (its first run failed on exactly that pinned assertion) |
| `pnpm prepare:e2e` | passed |
| `pnpm --dir examples/react-router run typecheck` | passed |
| `pnpm test:browser` | passed, 27/27 |
| `pnpm size` | passed with the budgets above |
| `git diff --check` | passed |

Coverage, with thresholds unchanged:

| Suite | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| Runtime (thresholds 92/83/96/94) | 94.41% | 88.09% | 97.86% | 95.65% |
| Transform (thresholds 92/90/92/95) | 92.70% | 90.81% | 95.45% | 96.69% |

### State after the core runtime remediation

- Both manifests are still `0.2.0`, and `alien-signals` is still exactly `3.2.1`.
- The multi-copy contract ("several copies of v0.2 on one page interoperate") now holds for the cases the audit found broken. Nothing in it was narrowed. Cross-copy batches are still not one atomic transaction, as documented; a read inside the other copy's batch now sees that batch's writes.
- The fix is one commit on top of `7d87999`. No tag, publish, or GitHub Release was performed.
