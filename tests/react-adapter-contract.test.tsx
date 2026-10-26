/** @jsxImportSource react-fine-grained-signals/jsx */
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
});
