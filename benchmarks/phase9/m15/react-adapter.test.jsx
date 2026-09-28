import React, { StrictMode, Suspense, startTransition } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runtime from "./alien-derived-runtime-render.mjs";
import { createReactAdapter, managed } from "./react-adapter.mjs";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const h = React.createElement;

for (const mode of ["combined", "per-readable"]) {
  describe(`M1.5 local React adapter (${mode})`, () => {
    const hooks = createReactAdapter(runtime, { mode });
    it("supports useSignalValue as a useSyncExternalStore leaf subscription", () => {
      const source = runtime.signalClassBrandHelper("before");
      const renders = vi.fn();
      function Reader() { renders(); return h("output", { "aria-label": "leaf" }, hooks.useSignalValue(source)); }
      render(h(Reader));
      expect(screen.getByLabelText("leaf").textContent).toBe("before");
      act(() => { source.value = "after"; });
      expect(screen.getByLabelText("leaf").textContent).toBe("after");
      expect(renders).toHaveBeenCalledTimes(2);
    });

    it("tracks only render-time local dependencies and releases the old branch", () => {
      const chooseLeft = runtime.signalClassBrandHelper(true);
      const left = runtime.signalClassBrandHelper("L");
      const right = runtime.signalClassBrandHelper("R");
      const renders = vi.fn();
      function Reader() {
        const scope = hooks.useManagedSignals();
        return managed(scope, () => {
          renders();
          const value = chooseLeft.value ? left.value : right.value;
          return h("output", { "aria-label": "tracked" }, value);
        });
      }
      render(h(Reader));
      act(() => { left.value = "L2"; });
      expect(screen.getByLabelText("tracked").textContent).toBe("L2");
      act(() => { chooseLeft.value = false; });
      expect(screen.getByLabelText("tracked").textContent).toBe("R");
      const committedRenders = renders.mock.calls.length;
      act(() => { left.value = "ignored"; });
      expect(renders).toHaveBeenCalledTimes(committedRenders);
      act(() => { right.value = "R2"; });
      expect(screen.getByLabelText("tracked").textContent).toBe("R2");
    });

    it("does not subscribe a suspended render attempt before commit", async () => {
      const source = runtime.signalClassBrandHelper("before");
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let suspended = true;
      const renders = vi.fn();
      function Reader() {
        const scope = hooks.useManagedSignals();
        return managed(scope, () => {
          const value = source.value;
          renders(value);
          if (suspended) throw gate;
          return h("output", { "aria-label": "resolved" }, value);
        });
      }
      render(h(Suspense, { fallback: h("output", { "aria-label": "fallback" }, "loading") }, h(Reader)));
      expect(screen.getByLabelText("fallback").textContent).toBe("loading");
      await Promise.resolve();
      const attemptsBeforeWrite = renders.mock.calls.length;
      act(() => { source.value = "during suspension"; });
      expect(renders).toHaveBeenCalledTimes(attemptsBeforeWrite);
      suspended = false;
      await act(async () => { release(); await gate; });
      expect(screen.getByLabelText("resolved").textContent).toBe("during suspension");
      act(() => { source.value = "after commit"; });
      expect(screen.getByLabelText("resolved").textContent).toBe("after commit");
    });

    it("keeps speculative computed evaluation out of the live Alien graph", async () => {
      const source = runtime.signalClassBrandHelper(2);
      const derived = runtime.computedClassBrandHelper(() => source.value * 3);
      const before = runtime.getRenderDebugSnapshot(derived);
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let suspended = true;
      function Reader() {
        const scope = hooks.useManagedSignals();
        return managed(scope, () => {
          const value = derived.value;
          if (suspended) throw gate;
          return h("output", { "aria-label": "computed" }, String(value));
        });
      }
      render(h(Suspense, { fallback: h("output", null, "loading") }, h(Reader)));
      const after = runtime.getRenderDebugSnapshot(derived);
      expect(after.flags).toBe(before.flags);
      expect(after.currentValue).toBe(before.currentValue);
      expect(after.deps).toBe(before.deps);
      expect(after.depsTail).toBe(before.depsTail);
      expect(after.subs).toBe(before.subs);
      expect(after.initialized).toBe(before.initialized);
      expect(derived.value).toBe(6);
      suspended = false;
      await act(async () => { release(); await gate; });
    });

    it("detects a source write between render read and layout commit", () => {
      const source = runtime.signalClassBrandHelper(0);
      let mutate = true;
      const renders = vi.fn();
      function Reader() {
        const scope = hooks.useManagedSignals();
        return managed(scope, () => {
          renders();
          const observed = source.value;
          if (mutate) { mutate = false; source.value = 1; }
          return h("output", { "aria-label": "commit check" }, observed);
        });
      }
      render(h(Reader));
      expect(screen.getByLabelText("commit check").textContent).toBe("1");
      expect(renders).toHaveBeenCalledTimes(2);
    });

    it("restores an outer managed collector after a nested scope", () => {
      const outer = runtime.signalClassBrandHelper("outer-0");
      const inner = runtime.signalClassBrandHelper("inner-0");
      const renders = vi.fn();
      function Reader() {
        const outerScope = hooks.useManagedSignals();
        try {
          renders();
          const first = outer.value;
          const innerScope = hooks.useManagedSignals();
          let nested;
          try { nested = inner.value; }
          finally { innerScope.finish(); }
          const last = outer.value;
          return h("output", { "aria-label": "nested scopes" }, `${first}/${nested}/${last}`);
        } finally { outerScope.finish(); }
      }
      render(h(Reader));
      act(() => { inner.value = "inner-1"; });
      expect(screen.getByLabelText("nested scopes").textContent).toBe("outer-0/inner-1/outer-0");
      act(() => { outer.value = "outer-1"; });
      expect(screen.getByLabelText("nested scopes").textContent).toBe("outer-1/inner-1/outer-1");
      expect(renders).toHaveBeenCalledTimes(3);
    });

    it("keeps StrictMode subscriptions live and disposes them on unmount", () => {
      const source = runtime.signalClassBrandHelper(0);
      const renders = vi.fn();
      function Reader() {
        hooks.useSignalTracking();
        renders();
        return h("output", { "aria-label": "strict" }, source.value);
      }
      const view = render(h(StrictMode, null, h(Reader)));
      act(() => { source.value = 1; });
      expect(screen.getByLabelText("strict").textContent).toBe("1");
      view.unmount();
      const committed = renders.mock.calls.length;
      act(() => { source.value = 2; });
      expect(renders).toHaveBeenCalledTimes(committed);
    });

    it("settles tracked and useSyncExternalStore readers consistently after a transition", () => {
      const source = runtime.signalClassBrandHelper(1);
      const derived = runtime.computedClassBrandHelper(() => source.value * 2);
      function Tracked() {
        hooks.useSignalTracking();
        return h("output", { "aria-label": "transition tracked" }, derived.value);
      }
      function Leaf() {
        return h("output", { "aria-label": "transition leaf" }, hooks.useSignalValue(derived));
      }
      render(h(React.Fragment, null, h(Tracked), h(Leaf)));
      act(() => { startTransition(() => { source.value = 5; }); });
      expect(screen.getByLabelText("transition tracked").textContent).toBe("10");
      expect(screen.getByLabelText("transition leaf").textContent).toBe("10");
    });

    it("tracks duplicate-copy source and computed readables through managed and leaf hooks", async () => {
      const foreign = await import("./alien-derived-runtime-render.mjs?react-copy-B");
      const source = foreign.signalClassBrandHelper(2);
      const derived = foreign.computedClassBrandHelper(() => source.value * 5);
      function ManagedReader() {
        const scope = hooks.useManagedSignals();
        return managed(scope, () => h("output", { "aria-label": "foreign managed" }, derived.value));
      }
      function LeafReader() {
        return h("output", { "aria-label": "foreign leaf" }, hooks.useSignalValue(derived));
      }
      render(h(React.Fragment, null, h(ManagedReader), h(LeafReader)));
      expect(screen.getByLabelText("foreign managed").textContent).toBe("10");
      expect(screen.getByLabelText("foreign leaf").textContent).toBe("10");
      act(() => { source.value = 3; });
      expect(screen.getByLabelText("foreign managed").textContent).toBe("15");
      expect(screen.getByLabelText("foreign leaf").textContent).toBe("15");
    });
  });
}
