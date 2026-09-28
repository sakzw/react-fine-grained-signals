// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runtime from "./alien-derived-runtime-render.mjs";
import { createReactAdapter } from "./react-adapter.mjs";
import { deepSignalFactory } from "./alien-derived-deep-signal-engine.ts";

const hooks = createReactAdapter(runtime);
const deepSignal = deepSignalFactory.deepSignal;
const h = React.createElement;

function useDeepSignalValue(source, selector) {
  const selected = React.useMemo(
    () => runtime.computedClassBrandHelper(() => selector(source.value)),
    [source, selector],
  );
  return hooks.useSignalValue(selected);
}

afterEach(cleanup);

describe("M1.5 DeepSignal with candidate React leaf adapter", () => {
  it("updates a primitive selector when its exact nested property changes", () => {
    const state = deepSignal({ user: { name: "Ada", age: 36 } });
    const selectName = (value) => value.user.name;
    const renders = vi.fn();
    function Reader() {
      renders();
      return h("output", { "aria-label": "deep-name" }, useDeepSignalValue(state, selectName));
    }
    render(h(Reader));
    act(() => { state.value.user.name = "Grace"; });
    expect(screen.getByLabelText("deep-name").textContent).toBe("Grace");
    const renderCount = renders.mock.calls.length;
    act(() => { state.value.user.age += 1; });
    expect(renders).toHaveBeenCalledTimes(renderCount);
  });

  it("reconciles dynamic selector branches", () => {
    const state = deepSignal({ chooseLeft: true, left: "L", right: "R" });
    const selectChosen = (value) => value.chooseLeft ? value.left : value.right;
    function Reader() {
      return h("output", { "aria-label": "deep-branch" }, useDeepSignalValue(state, selectChosen));
    }
    render(h(Reader));
    act(() => { state.value.chooseLeft = false; });
    expect(screen.getByLabelText("deep-branch").textContent).toBe("R");
    act(() => { state.value.left = "L2"; });
    expect(screen.getByLabelText("deep-branch").textContent).toBe("R");
    act(() => { state.value.right = "R2"; });
    expect(screen.getByLabelText("deep-branch").textContent).toBe("R2");
  });
});
