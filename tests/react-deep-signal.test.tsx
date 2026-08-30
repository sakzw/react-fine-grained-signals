/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { Component, StrictMode, act } from "react";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deepSignal,
  signal,
  useComputed,
  useDeepSignal,
  useDeepSignalValue,
  useSignalValue,
  useSignals,
} from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Deep signal selection (useDeepSignal, useDeepSignalValue)", () => {
  it("does not add a selected deep leaf to an ancestor useSignals scope", () => {
    const parentSource = signal("parent");
    const state = deepSignal({ user: { name: "Ada" } });
    const parentRenders = vi.fn();
    const leafRenders = vi.fn();

    function Leaf() {
      leafRenders();
      return <span>{useDeepSignalValue(state, (value) => value.user.name, [])}</span>;
    }

    function Parent() {
      useSignals();
      parentRenders();
      return <section data-parent={parentSource.value}><Leaf /></section>;
    }

    render(<Parent />);
    act(() => {
      state.value.user.name = "Grace";
    });

    expect(screen.getByText("Grace")).toBeTruthy();
    expect(parentRenders).toHaveBeenCalledTimes(1);
    expect(leafRenders).toHaveBeenCalledTimes(2);
  });

  it("keeps a useDeepSignal identity stable while nested state updates", () => {
    let source: ReturnType<typeof useDeepSignal<{ user: { name: string } }>> | undefined;
    const renders = vi.fn();

    function Profile() {
      const state = useDeepSignal({ user: { name: "Ada" } });
      const name = useSignalValue(useComputed(() => state.value.user.name));
      source = state;
      renders();
      return <output aria-label="deep name">{name}</output>;
    }

    render(<Profile />);
    const initialSource = source;
    expect(screen.getByLabelText("deep name").textContent).toBe("Ada");

    act(() => {
      source!.value.user.name = "Grace";
    });
    expect(screen.getByLabelText("deep name").textContent).toBe("Grace");
    expect(source).toBe(initialSource);
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("does not recreate useDeepSignal or adopt a new initial value on parent rerender", () => {
    let source: ReturnType<typeof useDeepSignal<{ user: { name: string } }>> | undefined;
    const renders = vi.fn();

    function Profile({ initial, parentVersion }: {
      initial: { user: { name: string } };
      parentVersion: number;
    }) {
      const state = useDeepSignal(initial);
      source = state;
      renders();
      return <output aria-label="deep parent rerender">{`${parentVersion}:${state.value.user.name}`}</output>;
    }

    const view = render(<Profile initial={{ user: { name: "Ada" } }} parentVersion={1} />);
    const initialSource = source;
    view.rerender(<Profile initial={{ user: { name: "Grace" } }} parentVersion={2} />);

    expect(source).toBe(initialSource);
    expect(screen.getByLabelText("deep parent rerender").textContent).toBe("2:Ada");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("evaluates a useDeepSignal factory only during initialization", () => {
    const initialize = vi.fn(() => ({ items: [] as string[] }));

    function List({ parentVersion }: { parentVersion: number }) {
      const state = useDeepSignal(initialize);
      return <output aria-label="deep factory">{`${parentVersion}:${state.value.items.length}`}</output>;
    }

    const view = render(<List parentVersion={1} />);
    view.rerender(<List parentVersion={2} />);

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("deep factory").textContent).toBe("2:0");
  });

  it("keeps a useDeepSignal subscription live through StrictMode replay", () => {
    let source: ReturnType<typeof useDeepSignal<{ user: { name: string } }>> | undefined;

    function Profile({ parentVersion }: { parentVersion: number }) {
      const state = useDeepSignal({ user: { name: "Ada" } });
      const name = useSignalValue(useComputed(() => state.value.user.name));
      source = state;
      return <output aria-label="strict deep name">{`${parentVersion}:${name}`}</output>;
    }

    const view = render(
      <StrictMode>
        <Profile parentVersion={1} />
      </StrictMode>,
    );
    const committedSource = source;
    act(() => {
      source!.value.user.name = "Grace";
    });
    expect(screen.getByLabelText("strict deep name").textContent).toBe("1:Grace");

    view.rerender(
      <StrictMode>
        <Profile parentVersion={2} />
      </StrictMode>,
    );
    expect(source).toBe(committedSource);
    expect(screen.getByLabelText("strict deep name").textContent).toBe("2:Grace");
  });

  it("rerenders a selected deep leaf while isolating sibling writes", () => {
    let state: ReturnType<typeof useDeepSignal<{ user: { name: string; age: number } }>> | undefined;
    const renders = vi.fn();

    function Name() {
      state = useDeepSignal({ user: { name: "Ada", age: 36 } });
      const name = useDeepSignalValue(state, (value) => value.user.name, []);
      renders();
      return <output aria-label="selected name">{name}</output>;
    }

    render(<Name />);
    act(() => {
      state!.value.user.age = 37;
    });
    expect(renders).toHaveBeenCalledTimes(1);

    act(() => {
      state!.value.user.name = "Grace";
    });
    expect(screen.getByLabelText("selected name").textContent).toBe("Grace");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["mutable object", () => ({ name: "Ada" })],
    ["deep proxy", (value: { user: { name: string } }) => value.user],
    ["function", () => () => "Ada"],
  ])("rejects a %s returned by a deep selector at runtime", (_label, selector) => {
    const state = deepSignal({ user: { name: "Ada" } });

    function InvalidSelection() {
      useDeepSignalValue(state, selector as never, []);
      return null;
    }

    expect(() => render(<InvalidSelection />)).toThrowError(
      new TypeError(
        "useDeepSignalValue selector must return a primitive snapshot; objects, Proxies, and functions are not supported",
      ),
    );
  });

  it.each([
    [
      "an invalid selector result",
      (value: { fail: boolean }) => value.fail ? value : "ready",
      (state: ReturnType<typeof deepSignal<{ fail: boolean }>>) => {
        state.value.fail = true;
      },
    ],
    [
      "a selector exception",
      (value: { fail: boolean }) => {
        if (value.fail) throw new Error("selector failed");
        return "ready";
      },
      (state: ReturnType<typeof deepSignal<{ fail: boolean }>>) => {
        state.value.fail = true;
      },
    ],
  ])(
    "delivers %s from an update to an Error Boundary instead of the writer",
    (_label, selector, write) => {
      const state = deepSignal({ fail: false });
      const reactError = vi.spyOn(console, "error").mockImplementation(() => {});

      class ErrorBoundary extends Component<
        { children: ReactNode },
        { error: unknown }
      > {
        state: { error: unknown } = { error: undefined };

        static getDerivedStateFromError(error: unknown) {
          return { error };
        }

        render() {
          return this.state.error === undefined
            ? this.props.children
            : <output aria-label="selector error">caught</output>;
        }
      }

      function Selection() {
        const value = useDeepSignalValue(state, selector as never, []);
        return <output aria-label="selector value">{String(value)}</output>;
      }

      render(<ErrorBoundary><Selection /></ErrorBoundary>);
      expect(screen.getByLabelText("selector value").textContent).toBe("ready");

      expect(() => {
        act(() => {
          write(state);
        });
      }).not.toThrow();
      expect(screen.getByLabelText("selector error").textContent).toBe("caught");
      expect(reactError).toHaveBeenCalled();
    },
  );

  it("surfaces the latest selector error across consecutive failures", () => {
    const state = deepSignal({ fail: false, attempt: 0 });
    const reactError = vi.spyOn(console, "error").mockImplementation(() => {});

    class ErrorBoundary extends Component<
      { children: ReactNode },
      { error: unknown }
    > {
      state: { error: unknown } = { error: undefined };

      static getDerivedStateFromError(error: unknown) {
        return { error };
      }

      render() {
        return this.state.error === undefined
          ? this.props.children
          : <output aria-label="selector error">{(this.state.error as Error).message}</output>;
      }
    }

    function Selection() {
      const value = useDeepSignalValue(
        state,
        (current) => {
          if (current.fail) throw new Error(`attempt ${current.attempt}`);
          return "ready";
        },
        [],
      );
      return <output aria-label="selector value">{value}</output>;
    }

    render(<ErrorBoundary><Selection /></ErrorBoundary>);
    expect(screen.getByLabelText("selector value").textContent).toBe("ready");

    // Both writes land inside the same reactive flush, so the store evaluates
    // a first ("attempt 0") and then a second ("attempt 1") selector error
    // before React ever commits the boundary's fallback and unsubscribes.
    act(() => {
      state.value.fail = true;
      state.value.attempt = 1;
    });

    expect(screen.getByLabelText("selector error").textContent).toBe("attempt 1");
    expect(reactError).toHaveBeenCalled();
  });

  it("reconnects a selected deep leaf after its parent object is replaced", () => {
    let state: ReturnType<typeof useDeepSignal<{ user: { name: string } }>> | undefined;

    function Name() {
      state = useDeepSignal({ user: { name: "Ada" } });
      return <output aria-label="replacement name">{
        useDeepSignalValue(state, (value) => value.user.name, [])
      }</output>;
    }

    render(<Name />);
    act(() => {
      state!.value.user = { name: "Grace" };
      state!.value.user.name = "Lin";
    });
    expect(screen.getByLabelText("replacement name").textContent).toBe("Lin");
  });

  it("reconnects a selected deep leaf after the root is replaced", () => {
    const state = deepSignal({ user: { name: "Ada" } });

    function Name() {
      const name = useDeepSignalValue(state, (value) => value.user.name, []);
      return <output aria-label="root replacement name">{name}</output>;
    }

    render(<Name />);
    act(() => {
      state.value = { user: { name: "Grace" } };
      state.value.user.name = "Lin";
    });
    expect(screen.getByLabelText("root replacement name").textContent).toBe("Lin");
  });

  it("switches subscriptions when its deep state prop changes", () => {
    const first = deepSignal({ user: { name: "Ada" } });
    const second = deepSignal({ user: { name: "Grace" } });

    function Name({ state }: { state: typeof first }) {
      return <output aria-label="state prop name">{
        useDeepSignalValue(state, (value) => value.user.name, [])
      }</output>;
    }

    const view = render(<Name state={first} />);
    view.rerender(<Name state={second} />);
    expect(screen.getByLabelText("state prop name").textContent).toBe("Grace");

    act(() => {
      first.value.user.name = "ignored";
    });
    expect(screen.getByLabelText("state prop name").textContent).toBe("Grace");
    act(() => {
      second.value.user.name = "Lin";
    });
    expect(screen.getByLabelText("state prop name").textContent).toBe("Lin");
  });

  it("updates a selector that captures a prop when dependencies change", () => {
    function Label({ prefix }: { prefix: string }) {
      const state = useDeepSignal({ user: { name: "Ada" } });
      const label = useDeepSignalValue(state, (value) => `${prefix}: ${value.user.name}`, [prefix]);
      return <output aria-label="captured prop label">{label}</output>;
    }

    const view = render(<Label prefix="User" />);
    view.rerender(<Label prefix="Member" />);
    expect(screen.getByLabelText("captured prop label").textContent).toBe("Member: Ada");
  });

  it("switches dynamic selector dependencies without retaining the old branch", () => {
    const state = deepSignal({ useFirst: true, first: "A", second: "B" });
    const renders = vi.fn();

    function Selected() {
      const value = useDeepSignalValue(
        state,
        (current) => current.useFirst ? current.first : current.second,
        [],
      );
      renders();
      return <output aria-label="dynamic selection">{value}</output>;
    }

    render(<Selected />);
    act(() => {
      state.value.first = "A2";
    });
    expect(screen.getByLabelText("dynamic selection").textContent).toBe("A2");

    act(() => {
      state.value.useFirst = false;
    });
    expect(screen.getByLabelText("dynamic selection").textContent).toBe("B");
    const rendersAfterSwitch = renders.mock.calls.length;

    act(() => {
      state.value.first = "ignored";
    });
    expect(renders).toHaveBeenCalledTimes(rendersAfterSwitch);
    act(() => {
      state.value.second = "B2";
    });
    expect(screen.getByLabelText("dynamic selection").textContent).toBe("B2");
    expect(renders).toHaveBeenCalledTimes(rendersAfterSwitch + 1);
  });

  it("compares selected snapshots with Object.is semantics", () => {
    const state = deepSignal({ value: 0 });
    const renders = vi.fn();

    function Selected() {
      const value = useDeepSignalValue(state, (current) => current.value, []);
      renders(value);
      const label = Number.isNaN(value) ? "NaN" : Object.is(value, -0) ? "-0" : String(value);
      return <output aria-label="object is selection">{label}</output>;
    }

    render(<Selected />);
    act(() => {
      state.value.value = 0;
    });
    expect(renders).toHaveBeenCalledTimes(1);

    act(() => {
      state.value.value = -0;
    });
    expect(screen.getByLabelText("object is selection").textContent).toBe("-0");
    expect(renders).toHaveBeenCalledTimes(2);

    act(() => {
      state.value.value = Number.NaN;
    });
    expect(screen.getByLabelText("object is selection").textContent).toBe("NaN");
    expect(renders).toHaveBeenCalledTimes(3);
    act(() => {
      state.value.value = Number.NaN;
    });
    expect(renders).toHaveBeenCalledTimes(3);
  });

  it("keeps subscribing after selector dependencies change", () => {
    const state = deepSignal({ count: 1 });

    function Product({ multiplier }: { multiplier: number }) {
      const product = useDeepSignalValue(
        state,
        (current) => current.count * multiplier,
        [multiplier],
      );
      return <output aria-label="selected product">{product}</output>;
    }

    const view = render(<Product multiplier={1} />);
    view.rerender(<Product multiplier={2} />);
    expect(screen.getByLabelText("selected product").textContent).toBe("2");
    act(() => {
      state.value.count = 2;
    });
    expect(screen.getByLabelText("selected product").textContent).toBe("4");
  });

  it("reports a useDeepSignalValue dependencies length change instead of silently degrading", () => {
    // useMemo's own dependency array (built internally as
    // `[source, ...dependencies]`) must stay a fixed length across renders.
    // A caller passing a `dependencies` array whose length changes used to
    // only surface as React's silent "changed size between renders" dev
    // warning while quietly rebuilding the store on every render thereafter.
    // Mirrors the useComputed dependency-mode-switch test above: a violation
    // must be a loud, actionable error instead.
    const state = deepSignal({ count: 1 });

    function Selected({ dependencies }: { dependencies: number[] }) {
      const value = useDeepSignalValue(
        state,
        (current) => current.count,
        dependencies,
      );
      return <output aria-label="dependency length guard">{value}</output>;
    }

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<Selected dependencies={[]} />);
    expect(screen.getByLabelText("dependency length guard").textContent).toBe("1");

    expect(() => view.rerender(<Selected dependencies={[1]} />)).toThrow(
      /`dependencies` array length changed between renders/,
    );
    errorSpy.mockRestore();
  });

  it("cleans a selected deep subscription during StrictMode unmount", () => {
    const state = deepSignal({ user: { name: "Ada" } });
    const renders = vi.fn();

    function Name() {
      const name = useDeepSignalValue(state, (value) => value.user.name, []);
      renders();
      return <output aria-label="strict selected name">{name}</output>;
    }

    const view = render(
      <StrictMode>
        <Name />
      </StrictMode>,
    );
    act(() => {
      state.value.user.name = "Grace";
    });
    expect(screen.getByLabelText("strict selected name").textContent).toBe("Grace");

    view.unmount();
    const rendersAtUnmount = renders.mock.calls.length;
    act(() => {
      state.value.user.name = "Grace";
    });
    expect(renders).toHaveBeenCalledTimes(rendersAtUnmount);
  });
});
