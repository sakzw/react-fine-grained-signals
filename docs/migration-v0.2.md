# Migrating to v0.2

This guide covers the public API and dependency changes when upgrading from v0.1.1 to v0.2.

## Render tracking hooks

v0.1.1 exposed two different hooks with the same name. Their import paths identify two different tracking contracts; migrate them separately.

### Root API: bare, best-effort tracking

The root `useSignals()` became the root `useSignalTracking()`:

```tsx
// v0.1.1
import { useSignals } from "react-fine-grained-signals";
```

```tsx
// v0.2
import { useSignalTracking } from "react-fine-grained-signals";

function Counter() {
  useSignalTracking();
  // Read signals during render.
}
```

This is the small, best-effort tracking boundary.

### `/runtime` API: managed, exact tracking

The separate `/runtime` `useSignals()` alias became `/runtime` `useManagedSignals()`:

```tsx
// v0.1.1
import { useSignals } from "react-fine-grained-signals/runtime";
```

```tsx
// v0.2
import { useManagedSignals } from "react-fine-grained-signals/runtime";

function Counter() {
  const scope = useManagedSignals();
  try {
    return <output>{count.value}</output>;
  } finally {
    scope.finish();
  }
}
```

This is the managed, exact render-tracking boundary. When the transform plugin is available, its default `transform: "managed"` mode is the recommended exact boundary and inserts this `try/finally` scope automatically. Manual `useManagedSignals()` is the plugin-free alternative. The advanced `transform: "inject"` mode inserts the root best-effort `useSignalTracking()` boundary instead.

## Managed scope method

`ManagedSignalsStore.f()` has been removed. Replace `scope.f()` with `scope.finish()`.

## Alien Signals dependency

`alien-signals` changed from a peer dependency to a normal dependency of RFSG. If your application installed it only to satisfy RFSG v0.1.1's peer dependency, you can remove that direct dependency. Keep it in your own dependencies if your application imports Alien Signals directly. RFSG still uses `alien-signals/system` internally.

## Related guides

- [Core primitives](core-primitives.md)
- [React hooks](hooks.md)
- [Rendering optimization](rendering-optimization.md)
- [JSX signal children and host bindings](jsx-bindings.md)
