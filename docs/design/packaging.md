# Packaging

[English](packaging.md) | [日本語](packaging.ja.md)

**Status:** Settled. This note records why the package is shipped the way it is. Every decision below is implemented and guarded by a check; nothing here is open design work.

## `alien-signals` is a peer dependency

`alien-signals` is a **peer dependency**, not a direct dependency. Its dependency tracking lives in module-global state (`getActiveSub` / `setActiveSub`), so two copies in one application do not merely waste bytes: reads tracked by one copy are invisible to the other, and nothing throws. Declaring it as a peer makes the package manager resolve a single instance, and `pnpm test:consumer` asserts the published manifest keeps it that way.

## `"sideEffects": false`

The package sets `"sideEffects": false`. Bundlers that infer side effects from the module graph already shake this package correctly without it — importing only `signal` costs under a third of the whole entry (the `signal-only` and `index-full` scenarios in `pnpm size`, which reports the current figures), and under Vite/Rolldown the flag moves the smaller number by about 40 bytes and the larger one not at all. It is kept for bundlers that trust the declaration instead of proving it (webpack's `sideEffects` optimization), and because it pins the guarantee: adding a top-level side effect later fails a check rather than silently costing every consumer.

```sh
pnpm size
```

`scripts/check-size.mjs` bundles representative consumer import graphs, reports gzip and brotli sizes against `scripts/size-budget.json`, and asserts that code which must be shaken out really is absent. The absence checks are paired with positive controls, so a renamed marker string fails the check instead of quietly making it vacuous. Run `pnpm size:update` when growth is intentional.

## What the published package contains

The tarball is `dist` plus the READMEs and LICENSE. The `.js` source maps ship and embed `sourcesContent`, so they resolve on their own inside `node_modules`.

Declaration maps do not ship. They would point at `../src/*.ts`, which `files: ["dist"]` does not publish, so an editor following one would land on a path that is not there. Of 190 packages in this repository's own `node_modules`, four ship `.d.ts.map` and only one of those (`entities`, which publishes `src` alongside `dist`) ships maps that resolve — including a broken one in TypeScript itself, so this is a common accident rather than a practice worth copying.

Turning them off takes two steps, because `tsdown`'s `dts.sourcemap: false` stops the files but not the `//# sourceMappingURL` comment: the declaration pass inherits the top-level `sourcemap: true` that the `.js` maps need. `scripts/strip-dts-sourcemap-comments.mjs` removes the dead pointers after each build, and fails if a declaration map is ever emitted again rather than silently breaking a real one.

## Releases go through `pnpm publish`

Releases must go through `pnpm publish` rather than plain `npm publish`, so the `workspace:*` peer range on `react-fine-grained-signals` gets rewritten to a real semver range before publishing; `unplugin-react-fine-grained-signals`'s `prepublishOnly` script enforces this.
