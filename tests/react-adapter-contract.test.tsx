/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { act, useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAlienDerivedRenderAdapter } from "../src/core/render-runtime.mjs";
import { createReactiveRuntime } from "../src/core/reactive-runtime.js";
import { createAlienDerivedReactAdapter } from "../src/react/react-adapter.mjs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => cleanup());

function createRenderRuntime() {
  const runtime = createReactiveRuntime();
  runtime.initializeRenderAdapter(createAlienDerivedRenderAdapter);
  return runtime;
}

describe("React adapter contracts", () => {
  it("subscribes per readable and snapshots values through React hooks", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal("before");
    const { createReactAdapter } = createAlienDerivedReactAdapter(runtime, runtime.renderAdapter);
    const adapter = createReactAdapter({ mode: "per-readable" });

    function Reader() {
      const scope = adapter.useManagedSignals();
      try {
        return <output>{adapter.useSignalValue(source)}</output>;
      } finally {
        scope.finish();
      }
    }

    render(<Reader />);
    expect(screen.getByText("before")).toBeTruthy();
    act(() => { source.value = "after"; });
    expect(screen.getByText("after")).toBeTruthy();
  });

  it("replaces per-readable subscriptions when a managed render switches sources", () => {
    const runtime = createRenderRuntime();
    const first = runtime.signal("first");
    const second = runtime.signal("second");
    const { createReactAdapter } = createAlienDerivedReactAdapter(runtime, runtime.renderAdapter);
    const adapter = createReactAdapter({ mode: "per-readable" });
    let selectSecond!: () => void;

    function Reader() {
      const [useSecond, setUseSecond] = useState(false);
      selectSecond = () => setUseSecond(true);
      const scope = adapter.useManagedSignals();
      try {
        return <output>{useSecond ? adapter.useSignalValue(second) : adapter.useSignalValue(first)}</output>;
      } finally {
        scope.finish();
      }
    }

    render(<Reader />);
    act(() => { selectSecond(); });
    expect(screen.getByText("second")).toBeTruthy();

    act(() => { first.value = "stale source"; });
    expect(screen.getByText("second")).toBeTruthy();
    act(() => { second.value = "current source"; });
    expect(screen.getByText("current source")).toBeTruthy();
  });

  it("does not recreate a combined subscription for stable dependencies", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal(0);
    const subscribe = vi.spyOn(runtime.renderAdapter, "subscribeReadables");
    const { createReactAdapter } = createAlienDerivedReactAdapter(runtime, runtime.renderAdapter);
    const adapter = createReactAdapter();
    let rerenderParent!: () => void;

    function Reader() {
      const [tick, setTick] = useState(0);
      rerenderParent = () => setTick((value) => value + 1);
      adapter.useSignalTracking();
      return <output>{source.value + tick}</output>;
    }

    render(<Reader />);
    expect(subscribe).toHaveBeenCalledOnce();

    act(() => rerenderParent());
    expect(screen.getByText("1")).toBeTruthy();
    expect(subscribe).toHaveBeenCalledOnce();

    act(() => { source.value = 1; });
    expect(screen.getByText("2")).toBeTruthy();
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("rejects unknown modes and always finishes managed callbacks", () => {
    const runtime = createRenderRuntime();
    const factory = createAlienDerivedReactAdapter(runtime, runtime.renderAdapter);
    expect(() => factory.createReactAdapter({ mode: "other" as "combined" })).toThrow(
      "Unknown render subscription mode: other",
    );

    const finish = vi.fn();
    expect(() => factory.managed({ finish, getSnapshot: () => 0 }, () => {
      throw new Error("managed callback");
    })).toThrow("managed callback");
    expect(finish).toHaveBeenCalledOnce();
  });
});
