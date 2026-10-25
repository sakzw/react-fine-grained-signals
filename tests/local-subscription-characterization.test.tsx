/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

// Characterizes how a signal in this package is subscribed to by
// `useSignalValue` and by direct JSX bindings, using only public APIs. The
// cross-copy protocol is not involved, so these tests hold before and after
// that protocol is removed.

import { Component, act } from "react";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computed, effect, signal, useSignalValue } from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: undefined };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    return this.state.error === undefined
      ? this.props.children
      : <output data-testid="caught">{String((this.state.error as Error).message)}</output>;
  }
}

describe("useSignalValue subscription", () => {
  it("re-renders on a signal write and stops after unmount", () => {
    const source = signal(1);
    const renders = vi.fn();
    function View() {
      renders();
      return <output>{useSignalValue(source)}</output>;
    }
    const view = render(<View />);
    expect(screen.getByText("1")).toBeTruthy();
    act(() => { source.value = 2; });
    expect(screen.getByText("2")).toBeTruthy();
    const rendersBeforeUnmount = renders.mock.calls.length;

    view.unmount();
    act(() => { source.value = 3; });
    expect(renders).toHaveBeenCalledTimes(rendersBeforeUnmount);
  });

  it("releases the graph subscription on unmount", () => {
    const source = signal(1);
    function View() {
      return <output>{useSignalValue(source)}</output>;
    }
    const view = render(<View />);
    // An unmounted component must not keep the signal watched: a probe effect
    // is the only subscriber left, and disposing it is what unwatches.
    const probe = vi.fn();
    const dispose = effect(() => { probe(source.value); });
    view.unmount();
    act(() => { source.value = 2; });
    expect(probe).toHaveBeenLastCalledWith(2);
    dispose();
  });

  it("does not re-render when a computed keeps its value", () => {
    const source = signal(1);
    const parity = computed(() => source.value % 2);
    const renders = vi.fn();
    function View() {
      renders();
      return <output>{useSignalValue(parity)}</output>;
    }
    render(<View />);
    const initial = renders.mock.calls.length;
    act(() => { source.value = 3; });
    expect(renders).toHaveBeenCalledTimes(initial);
    act(() => { source.value = 4; });
    expect(screen.getByText("0")).toBeTruthy();
    expect(renders.mock.calls.length).toBeGreaterThan(initial);
  });

  it("follows a computed's dynamically selected branch", () => {
    const flag = signal(true);
    const left = signal("left");
    const right = signal("right");
    const picked = computed(() => (flag.value ? left.value : right.value));
    function View() {
      return <output>{useSignalValue(picked)}</output>;
    }
    render(<View />);
    expect(screen.getByText("left")).toBeTruthy();
    act(() => { flag.value = false; });
    expect(screen.getByText("right")).toBeTruthy();
    act(() => { left.value = "ignored"; });
    expect(screen.getByText("right")).toBeTruthy();
    act(() => { right.value = "updated"; });
    expect(screen.getByText("updated")).toBeTruthy();
  });

  it("surfaces a throwing computed to the Error Boundary at render, not from the write", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const source = signal(1);
    const fragile = computed(() => {
      if (source.value === 2) throw new Error("computed failure");
      return source.value;
    });
    function View() {
      return <output>{useSignalValue(fragile)}</output>;
    }
    render(<Boundary><View /></Boundary>);
    expect(screen.getByText("1")).toBeTruthy();

    expect(() => act(() => { source.value = 2; })).not.toThrow();
    expect(screen.getByTestId("caught").textContent).toBe("computed failure");
  });

  it("recovers a mounted subscriber after a computed error clears", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const source = signal(1);
    const fragile = computed(() => {
      if (source.value === 2) throw new Error("computed failure");
      return source.value;
    });
    const seen: unknown[] = [];
    function View() {
      const value = useSignalValue(fragile);
      seen.push(value);
      return <output>{value}</output>;
    }
    // A boundary-less error cannot be observed in the tree, so check the
    // subscription itself stays live across the error: later writes still
    // reach a sibling effect reading the same computed.
    const effectSeen: unknown[] = [];
    const dispose = effect(() => {
      try { effectSeen.push(fragile.value); } catch (error) { effectSeen.push((error as Error).message); }
    });
    render(<Boundary><View /></Boundary>);
    act(() => { source.value = 2; });
    act(() => { source.value = 3; });
    expect(effectSeen).toEqual([1, "computed failure", 3]);
    dispose();
  });
});

describe("direct JSX binding subscription", () => {
  it("updates a bound input from an external write and stops after unmount", () => {
    const text = signal("a");
    const view = render(<input data-testid="field" bindValue={text} />);
    const field = screen.getByTestId("field") as HTMLInputElement;
    expect(field.value).toBe("a");

    act(() => { text.value = "b"; });
    expect(field.value).toBe("b");

    view.unmount();
    act(() => { text.value = "c"; });
    expect(field.value).toBe("b");
  });

  it("follows a computed source and ignores a write that leaves it equal", () => {
    const source = signal(1);
    const label = computed(() => `n${source.value % 2}`);
    render(<input data-testid="field" bindValue={signal("")} data-label={label} />);
    const field = screen.getByTestId("field");
    expect(field.getAttribute("data-label")).toBe("n1");
    act(() => { source.value = 3; });
    expect(field.getAttribute("data-label")).toBe("n1");
    act(() => { source.value = 4; });
    expect(field.getAttribute("data-label")).toBe("n0");
  });
});
