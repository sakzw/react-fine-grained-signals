# Global state

[English](global-state.md) | [日本語](global-state.ja.md)

A signal is an ordinary value that lives wherever you put it, so a global store needs no provider, no context, and no selector API. Create the signals at module scope and import them:

```ts
// store.ts
import { deepSignal, signal } from "react-fine-grained-signals";

export const theme = signal<"light" | "dark">("light");
export const board = deepSignal({ filter: "all", tasks: [] as Task[] });
```

```tsx
import { board, theme } from "./store.js";

function FilterBadge() {
  useSignals();
  return <span className={theme.value}>{board.value.filter}</span>;
}
```

`useSignals()` tracks reads, not ownership: a `.value` read during render becomes a dependency of the component that made it, no matter where the signal was created. Module scope, a factory, a closure, and `useSignal()` all behave identically, and per-property tracking is unaffected — the component above rereads when `filter` changes, not when a task's title does.

For a client-only app this is the whole story, and it is the one place where signals replace a store library outright. Everything below is about the cases where module scope is the wrong place to put the state.

## Server rendering

Module scope is per process, not per request. The module is evaluated once in the server process, and every request that process handles then shares the same signal instances. There is no request-scoped store in this library — no `AsyncLocalStorage` binding, no per-render registry — so a write is simply visible to whoever reads next:

- A write during request A's render (or in a loader, an action, or a route handler) is seen by request B, including one belonging to a different user.
- Concurrent requests interleave. `renderToPipeableStream` yields between chunks, so two in-flight renders read and write the same signals in an order neither of them controls.
- Hydration starts from a clean module. The client bundle evaluates `store.ts` fresh, with the initial values, so any server-side write produces markup the client cannot reproduce — a hydration mismatch, and React may discard the server HTML for that subtree.

Development can hide all three: a dev server invalidates and re-evaluates modules on edit, which shortens the window over which requests share state. The leak is a production-shaped bug.

### What does not leak

Subscriptions do not. A server render never commits — the tracking hook's commit-phase layout effect falls back to `useEffect` on the server, and React does not run effects during `renderToString` or `renderToPipeableStream` — so `commit()` never runs and nothing ever subscribes to a signal on the server. Render tracking on the server is inert bookkeeping; it is the values that cross the request boundary, not the listeners.

The exception is `effect()` called at module scope. That runs at import time, on the server too, and its disposer is never called, so it holds its dependencies for the life of the process. Keep module-scope effects out of code that is loaded on the server, or start them from `useSignalEffect()` instead.

### Per-request stores

Export a factory rather than the signals, create it once per request, and pass it down:

```ts
export function createTaskStore() {
  const state = deepSignal(seedState());
  const remaining = computed(() => state.value.tasks.filter((task) => !task.done).length);
  return { state, remaining };
}

export function useTaskStore(): TaskStore {
  const storeRef = useRef<TaskStore | undefined>(undefined);
  if (storeRef.current === undefined) storeRef.current = createTaskStore();
  return storeRef.current;
}
```

The `useRef` guard is the same stability `useSignal()` and `useDeepSignal()` use internally, applied to a composite store: one instance per mount on the client, one per render pass on the server, never one per process. Distribute it with React context (or the router's own context) and read it from the components that need it. [`examples/react-router/`](../examples/react-router/) is built this way — see [`app/lib/task-store.ts`](../examples/react-router/app/lib/task-store.ts) and its `useOutletContext<TaskStore>()` consumers.

The seed must be deterministic. The server and the client's first render have to produce identical markup, so a store created per request cannot seed itself from `Date.now()`, `Math.random()`, or `crypto.randomUUID()`.

A module-scope signal is still fine under SSR when nothing writes to it per request: configuration fixed at import time, a feature-flag snapshot, a constant lookup table. The hazard is per-request data in process-lifetime storage, not module scope itself.

## Other module-scope hazards

**Hot module replacement.** Replacing `store.ts` constructs new signals with their initial values, so the state resets on save. Worse, a component module that was not itself replaced keeps its binding to the old signals and stops seeing writes. Accept the reset, or add an `import.meta.hot.accept` handler that preserves the store across replacements.

**A store in its own package.** Reactivity requires one shared `alien-signals` instance, because dependency tracking lives in that module's own global state. If a store package resolves its own copy, reads still return correct values and updates silently stop propagating. This is why `alien-signals` is a peer dependency; see [the packaging note](design/packaging.md) and [Core primitives](core-primitives.md#issignal). Deduplicate it in the workspace, and check for duplicates first when a global store updates in one place but not another.

**Tests.** Vitest gives each test *file* a fresh module registry, not each test, so a module-scope signal carries its value from one `it()` to the next within a file. Reset it in `beforeEach`, or create the state inside the test — the tests in this repository create their signals inside each `it()` for exactly this reason.

See also: [React hooks](hooks.md), [Core primitives](core-primitives.md), [Rendering optimization](rendering-optimization.md).
