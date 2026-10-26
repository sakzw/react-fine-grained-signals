/** @jsxImportSource react-fine-grained-signals/jsx */
// @vitest-environment jsdom

// Characterizes how a signal in this package is subscribed to by
// `useSignalValue` and by direct JSX bindings, using only public APIs. The
// cross-copy protocol is not involved, so these tests hold before and after
// that protocol is removed.

import { Component, act } from "react";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computed, signal, useSignalTracking, useSignalValue } from "../src/index.js";
import { coreRuntime } from "../src/core/core-runtime.js";

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
    expect(coreRuntime.hasSubscribers(source)).toBe(true);
    view.unmount();
    expect(coreRuntime.hasSubscribers(source)).toBe(false);
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

describe("useSignalTracking subscription", () => {
  it("releases a source the component stopped reading, and everything on unmount", async () => {
    const first = signal(1);
    const second = signal(10);
    function View({ useSecond }: { useSecond: boolean }) {
      useSignalTracking();
      return <output data-testid="out">{(useSecond ? second : first).value}</output>;
    }
    const view = render(<View useSecond={false} />);
    expect(coreRuntime.hasSubscribers(first)).toBe(true);

    view.rerender(<View useSecond />);
    expect(screen.getByTestId("out").textContent).toBe("10");
    expect(coreRuntime.hasSubscribers(first)).toBe(false);
    expect(coreRuntime.hasSubscribers(second)).toBe(true);

    act(() => { first.value = 2; });
    expect(screen.getByTestId("out").textContent).toBe("10");

    view.unmount();
    // Disposal is deferred a microtask so a hidden-then-shown tree can reuse it.
    await Promise.resolve();
    expect(coreRuntime.hasSubscribers(second)).toBe(false);
  });
});
