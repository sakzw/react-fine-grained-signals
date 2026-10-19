/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { Component, StrictMode, Suspense, act, startTransition, useState, type ComponentType, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signal, useSignalEffect } from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function SuspenseTransitionApp({ Observer }: { Observer: ComponentType<{ label: string }> }) {
  const [label, setLabel] = useState("committed");
  return <>
    <button onClick={() => startTransition(() => setLabel("pending"))}>suspend update</button>
    <Suspense fallback={<span>loading</span>}><Observer label={label} /></Suspense>
  </>;
}

describe("useSignalEffect", () => {
  it("runs useSignalEffect on changes and disposes it on unmount", () => {
    const source = signal(0);
    const seen: number[] = [];
    const cleanups: number[] = [];

    function Observer() {
      useSignalEffect(() => {
        seen.push(source.value);
        return () => cleanups.push(source.value);
      });
      return null;
    }

    const view = render(<Observer />);
    expect(seen).toEqual([0]);
    act(() => {
      source.value = 1;
    });
    expect(seen).toEqual([0, 1]);
    view.unmount();
    expect(cleanups.length).toBeGreaterThanOrEqual(1);
    const runsAfterUnmount = seen.length;
    act(() => {
      source.value = 2;
    });
    expect(seen).toHaveLength(runsAfterUnmount);
  });

  it("does not restart an inline useSignalEffect after an unrelated render", () => {
    const source = signal(0);
    const setups = vi.fn();
    const cleanups = vi.fn();

    function Observer({ label }: { label: string }) {
      useSignalEffect(() => {
        source.value;
        setups(label);
        return cleanups;
      });
      return <span>{label}</span>;
    }

    const view = render(<Observer label="first" />);
    view.rerender(<Observer label="second" />);

    expect(setups).toHaveBeenCalledTimes(1);
    expect(setups).toHaveBeenLastCalledWith("first");
    expect(cleanups).not.toHaveBeenCalled();

    act(() => {
      source.value = 1;
    });
    expect(setups).toHaveBeenCalledTimes(2);
    expect(setups).toHaveBeenLastCalledWith("first");
  });

  it("reconnects useSignalEffect when an explicit React dependency changes", () => {
    const source = signal(0);
    const setups = vi.fn();
    const cleanups = vi.fn();

    function Observer({ label }: { label: string }) {
      useSignalEffect(() => {
        source.value;
        setups(label);
        return () => cleanups(label);
      }, [label]);
      return null;
    }

    const view = render(<Observer label="first" />);
    view.rerender(<Observer label="second" />);

    expect(setups).toHaveBeenCalledTimes(2);
    expect(setups).toHaveBeenLastCalledWith("second");
    expect(cleanups).toHaveBeenCalledWith("first");

    act(() => {
      source.value = 1;
    });
    expect(setups).toHaveBeenCalledTimes(3);
    expect(setups).toHaveBeenLastCalledWith("second");
  });

  it("keeps the committed effect active while a dependency update is suspended", async () => {
    const source = signal(0);
    const setups: string[] = [];
    const cleanups: string[] = [];
    let allowPending = false;
    let resolvePending!: () => void;
    const pending = new Promise<void>((resolve) => { resolvePending = resolve; });

    function Observer({ label }: { label: string }) {
      useSignalEffect(() => {
        source.value;
        setups.push(label);
        return () => cleanups.push(label);
      }, [label]);
      if (label === "pending" && !allowPending) throw pending;
      return <output>{label}</output>;
    }

    render(<SuspenseTransitionApp Observer={Observer} />);
    expect(setups).toEqual(["committed"]);
    await act(async () => {
      screen.getByText("suspend update").click();
      await Promise.resolve();
    });
    expect(cleanups).toEqual([]);
    expect(screen.getByText("committed")).toBeTruthy();

    act(() => { source.value = 1; });
    expect(setups).toEqual(["committed", "committed"]);
    expect(cleanups).toEqual(["committed"]);

    allowPending = true;
    await act(async () => { resolvePending(); await Promise.resolve(); });
    expect(screen.getByText("pending")).toBeTruthy();
    expect(setups).toEqual(["committed", "committed", "pending"]);
    expect(cleanups).toEqual(["committed", "committed"]);
  });

  it.each([
    { label: "grows", before: [1], after: [1, 2] },
    { label: "shrinks", before: [1, 2], after: [1] },
    { label: "grows from empty", before: [], after: [1] },
    { label: "shrinks to empty", before: [1], after: [] },
  ])("rejects a useSignalEffect dependency length change ($label)", ({ before, after }) => {
    const source = signal(0);
    const setups: string[] = [];
    const cleanups: string[] = [];

    function Observer({ label, dependencies }: { label: string; dependencies: number[] }) {
      useSignalEffect(() => {
        source.value;
        setups.push(label);
        return () => cleanups.push(label);
      }, dependencies);
      return <span>{label}</span>;
    }

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<Observer label="before" dependencies={before} />);
    expect(setups).toEqual(["before"]);
    expect(() => view.rerender(<Observer label="after" dependencies={after} />)).toThrow(
      /dependencies length changed/,
    );
    errorSpy.mockRestore();
  });

  it("cleans up after a dependency-contract error and reconnects after boundary recovery", () => {
    const source = signal(0);
    const setups: string[] = [];
    const cleanups: string[] = [];

    class ErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
      state = { error: false };

      static getDerivedStateFromError() {
        return { error: true };
      }

      render() {
        return this.state.error
          ? <button onClick={() => this.setState({ error: false })}>retry</button>
          : this.props.children;
      }
    }

    function Observer({ label, dependencies }: { label: string; dependencies: number[] }) {
      useSignalEffect(() => {
        source.value;
        setups.push(label);
        return () => cleanups.push(label);
      }, dependencies);
      return <output>{label}</output>;
    }

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<ErrorBoundary><Observer label="initial" dependencies={[1]} /></ErrorBoundary>);
    expect(setups).toEqual(["initial"]);
    view.rerender(<ErrorBoundary><Observer label="invalid" dependencies={[1, 2]} /></ErrorBoundary>);
    expect(screen.getByText("retry")).toBeTruthy();
    expect(cleanups).toEqual(["initial"]);

    view.rerender(<ErrorBoundary key="recovered"><Observer label="recovered" dependencies={[3]} /></ErrorBoundary>);
    expect(screen.getByText("recovered")).toBeTruthy();
    expect(setups).toEqual(["initial", "recovered"]);
    act(() => { source.value = 1; });
    expect(setups).toEqual(["initial", "recovered", "recovered"]);
    view.unmount();
    expect(cleanups).toEqual(["initial", "recovered", "recovered"]);
    errorSpy.mockRestore();
  });

  it("treats omitted dependencies and an explicit empty array identically", () => {
    const source = signal(0);
    const setups: string[] = [];
    const cleanups: string[] = [];

    function Observer({ label, explicit }: { label: string; explicit: boolean }) {
      useSignalEffect(() => {
        source.value;
        setups.push(label);
        return () => cleanups.push(label);
      }, explicit ? [] : undefined);
      return <span>{label}</span>;
    }

    const view = render(<Observer label="initial" explicit={false} />);
    view.rerender(<Observer label="updated" explicit />);
    expect(setups).toEqual(["initial"]);
    expect(cleanups).toEqual([]);
    act(() => { source.value = 1; });
    expect(setups).toEqual(["initial", "initial"]);
    view.unmount();
    expect(cleanups).toEqual(["initial", "initial"]);
  });

  it("cleans every StrictMode signal effect subscription", () => {
    const source = signal(0);
    const setups = vi.fn();
    const cleanups = vi.fn();

    function StrictObserver() {
      useSignalEffect(() => {
        source.value;
        setups();
        return cleanups;
      });
      return null;
    }

    const view = render(
      <StrictMode>
        <StrictObserver />
      </StrictMode>,
    );
    expect(setups).toHaveBeenCalled();
    view.unmount();
    expect(cleanups).toHaveBeenCalledTimes(setups.mock.calls.length);
    act(() => {
      source.value++;
    });
    expect(cleanups).toHaveBeenCalledTimes(setups.mock.calls.length);
  });
});
