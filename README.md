# react-alien-signals

[English](README.md) | [日本語](README.ja.md)

An experimental React binding for [alien-signals](https://www.npmjs.com/package/alien-signals). It provides small reactive primitives, React hooks, and an opt-in JSX runtime for a deliberately narrow set of direct DOM bindings.

**Requires React 19 or newer.** The JSX runtime uses callback-ref cleanup, which is unavailable in React 18.

## Documentation

- [Core primitives](docs/core-primitives.md) — `signal`, `computed`, `effect`, `batch`, `untracked`, and `deepSignal`.
- [React hooks](docs/hooks.md) — `useSignals`, `useSignal`, `useDeepSignal`, `useComputed`, `useSignalEffect`, and the low-level selector hooks.
- [Rendering optimization](docs/rendering-optimization.md) — explicit `useSignals()` tracking vs. the build plugin's automatic insertion.
- [JSX signal children and host bindings](docs/jsx-bindings.md) — the custom JSX runtime's direct DOM bindings and their constraints.
- [JSX control-flow utilities](docs/control-flow.md) — `Show`, `Switch`/`Match`, `For`, and `Index`.

Design investigation memos for still-open or historical implementation decisions live under [`docs/design/`](docs/design/); see [`docs/README.md`](docs/README.md) for the full index.

## Development

Workspace development uses Node.js 24.19.0, pnpm 11, and React 19 or newer. The private root manifest accepts Node.js `^24.19.0`; `.node-version` is the current Node 24 LTS patch and CI reads that file directly. This is a repository-tooling guard while the package is private, not a public runtime compatibility claim. Before publication, the distributed package's Node.js runtime floor must be tested separately and must not inherit the stricter test/build-tool requirement by accident.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

To verify the packed ESM packages from a clean Vite consumer (without workspace
aliases), run:

```sh
pnpm test:consumer
```

The browser proof of concept renders the app on the server, hydrates it with React 19, and exercises direct signal bindings in Chromium:

```sh
pnpm exec playwright install --only-shell chromium
pnpm test:browser
```

Run `pnpm dev:browser` to build the transform package and inspect the same example at `http://127.0.0.1:4173`.

## Benchmarks

Benchmarks are manual diagnostics and are not CI performance gates. They measure built output, run correctness checks outside the timed region, and report the median and interquartile timings after warmup.

```sh
pnpm bench
pnpm bench:deep
pnpm bench:react
pnpm bench:transform
```

Core results compare raw `alien-signals`, this package, and `@preact/signals-core`. Compare numbers only on the same machine and Node.js version; hosted CI timing is too variable for a reliable regression threshold.

`bench:react` mounts a small React tree in jsdom and compares three variants for a counter shared above N unrelated sibling rows: unmemoized hooks (every sibling re-renders on every update), `React.memo`-wrapped hooks (siblings render once, but the update still walks their fibers to bail out), and signals (the owning component never re-renders, so siblings are never revisited). It reports sibling render counts and wall-clock update throughput for each.

`bench:transform` builds first, then measures the distributed Vite adapter's
parse, scope, rewrite, source-map, and code-generation path for small and
large TSX modules. It includes a pass-through lower bound and a no-candidate
Babel case, so it can be used later to compare a compatible SWC or Oxc
implementation against the same corpus.
