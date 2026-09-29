/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactiveRuntime } from "../src/core/reactive-runtime.js";
import { createAlienDerivedReactAdapter } from "../src/react/react-adapter.mjs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => cleanup());

describe("React adapter contracts", () => {
  it("subscribes per readable and snapshots values through React hooks", () => {
    const runtime = createReactiveRuntime();
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

  it("rejects unknown modes and always finishes managed callbacks", () => {
    const runtime = createReactiveRuntime();
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
