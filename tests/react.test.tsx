/** @jsxImportSource react-alien-signals */
// @vitest-environment jsdom

import { Component, createRef, StrictMode, Suspense, act } from "react";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsx, jsxs } from "../src/jsx-runtime.js";
import { jsxDEV } from "../src/jsx-dev-runtime.js";
import { hasActiveRenderCollector } from "../src/core/render-tracking.js";
import {
  batch,
  computed,
  deepSignal,
  signal,
  useComputed,
  useDeepSignal,
  useDeepSignalValue,
  useSignal,
  useSignalValue,
  useSignalEffect,
  useSignals,
  untracked,
} from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("React bindings", () => {
  it("tracks shallow and multiple deep reads made after useSignals", () => {
    const title = signal("one");
    const state = deepSignal({ profile: { name: "Ada", role: "admin", unread: 0 } });
    const renders = vi.fn();

    function Profile() {
      useSignals();
      renders();
      return <output aria-label="tracked profile">{
        `${title.value}:${state.value.profile.name}:${state.value.profile.role}`
      }</output>;
    }

    render(<Profile />);
    expect(screen.getByLabelText("tracked profile").textContent).toBe("one:Ada:admin");

    act(() => {
      title.value = "two";
    });
    expect(screen.getByLabelText("tracked profile").textContent).toBe("two:Ada:admin");
    act(() => {
      state.value.profile.name = "Grace";
      state.value.profile.role = "owner";
    });
    expect(screen.getByLabelText("tracked profile").textContent).toBe("two:Grace:owner");
    const rendersAfterTrackedWrites = renders.mock.calls.length;

    act(() => {
      state.value.profile.unread = 1;
    });
    expect(renders).toHaveBeenCalledTimes(rendersAfterTrackedWrites);
  });

  it("releases an old dynamic branch collected after useSignals", () => {
    const state = deepSignal({ useFirst: true, first: "A", second: "B" });
    const renders = vi.fn();

    function Selection() {
      useSignals();
      renders();
      const selected = state.value.useFirst ? state.value.first : state.value.second;
      return <output aria-label="tracked branch">{selected}</output>;
    }

    render(<Selection />);
    act(() => {
      state.value.first = "A2";
    });
    expect(screen.getByLabelText("tracked branch").textContent).toBe("A2");
    act(() => {
      state.value.useFirst = false;
    });
    expect(screen.getByLabelText("tracked branch").textContent).toBe("B");
    const rendersAfterSwitch = renders.mock.calls.length;

    act(() => {
      state.value.first = "ignored";
    });
    expect(renders).toHaveBeenCalledTimes(rendersAfterSwitch);
    act(() => {
      state.value.second = "B2";
    });
    expect(screen.getByLabelText("tracked branch").textContent).toBe("B2");
  });

  it("keeps StrictMode useSignals subscriptions live through update and disposes them on unmount", () => {
    const source = signal(0);
    const state = deepSignal({ value: 0 });
    const renders = vi.fn();

    function Reader() {
      useSignals();
      renders();
      return <output aria-label="strict tracked values">{`${source.value}:${state.value.value}`}</output>;
    }

    const view = render(
      <StrictMode>
        <Reader />
      </StrictMode>,
    );
    act(() => {
      source.value = 1;
      state.value.value = 2;
    });
    expect(screen.getByLabelText("strict tracked values").textContent).toBe("1:2");

    view.unmount();
    const rendersAtUnmount = renders.mock.calls.length;
    act(() => {
      source.value = 3;
      state.value.value = 4;
    });
    expect(renders).toHaveBeenCalledTimes(rendersAtUnmount);
  });

  // Bare useSignals() only closes its collector deterministically from the
  // commit-phase layout effect; a render that never commits (throws, or is
  // discarded by Suspense) instead relies on a microtask fallback scheduled
  // by ensureFinalCleanup() (see docs/rendering-optimization.md's "best-effort"
  // section). These two tests pin that documented fallback path itself, not
  // just its externally visible effect: start() also self-heals a dangling
  // collector the moment any *later* useSignals() call runs, which would
  // mask a broken fallback microtask if these tests only asserted behavior
  // after mounting something else. hasActiveRenderCollector() lets each test
  // observe the collector closing while nothing else has run start() yet.
  it("closes a thrown render's collector via the fallback microtask, without leaking into a later root", async () => {
    const abandoned = signal(0);
    const healthy = signal("healthy");
    const healthyRenders = vi.fn();

    function Throwing(): never {
      useSignals();
      abandoned.value;
      throw new Error("render failed");
    }
    function Healthy() {
      useSignals();
      healthyRenders();
      return <output aria-label="healthy root">{healthy.value}</output>;
    }

    expect(() => render(<Throwing />)).toThrow("render failed");
    // The layout effect that normally closes the collector never ran, so it
    // is still the active collector right after the throw.
    expect(hasActiveRenderCollector()).toBe(true);
    // Nothing else calls useSignals() here, so only the microtask fallback
    // (not start()'s self-heal on a later call) can close it at this point.
    await Promise.resolve();
    expect(hasActiveRenderCollector()).toBe(false);

    render(<Healthy />);
    act(() => {
      abandoned.value = 1;
    });
    expect(healthyRenders).toHaveBeenCalledTimes(1);
    act(() => {
      healthy.value = "updated";
    });
    expect(screen.getByLabelText("healthy root").textContent).toBe("updated");
  });

  it("discards dependencies read by a suspended render attempt, closing via the fallback microtask while idle", async () => {
    const source = signal("before");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let suspended = true;
    const renders = vi.fn();

    function Reader() {
      useSignals();
      const value = source.value;
      renders(value);
      if (suspended) throw gate;
      return <output aria-label="suspense value">{value}</output>;
    }

    render(
      <Suspense fallback={<output aria-label="suspense fallback">loading</output>}>
        <Reader />
      </Suspense>,
    );
    expect(screen.getByLabelText("suspense fallback").textContent).toBe("loading");
    // The fallback tree doesn't call useSignals(), and the gate is still
    // pending so no retry (and thus no self-heal) can have happened yet;
    // only the microtask fallback can close the abandoned attempt from here.
    expect(hasActiveRenderCollector()).toBe(true);
    await Promise.resolve();
    expect(hasActiveRenderCollector()).toBe(false);

    const rendersWhileSuspended = renders.mock.calls.length;
    // This write targets a dependency only the abandoned attempt read. Since
    // that attempt's commit() never ran, it must hold no live subscription,
    // so the write must not cause a stray render while still suspended.
    act(() => {
      source.value = "during suspension";
    });
    expect(renders).toHaveBeenCalledTimes(rendersWhileSuspended);

    suspended = false;
    await act(async () => {
      release();
      await gate;
    });
    expect(screen.getByLabelText("suspense value").textContent).toBe("during suspension");

    // The retry's successful commit must subscribe for real.
    act(() => {
      source.value = "after resolution";
    });
    expect(screen.getByLabelText("suspense value").textContent).toBe("after resolution");
  });

  it("does not mix tracked dependencies between sibling components", () => {
    const state = deepSignal({ left: "L", right: "R" });
    const leftRenders = vi.fn();
    const rightRenders = vi.fn();

    function Left() {
      useSignals();
      leftRenders();
      return <output aria-label="tracked left">{state.value.left}</output>;
    }
    function Right() {
      useSignals();
      rightRenders();
      return <output aria-label="tracked right">{state.value.right}</output>;
    }

    render(<><Left /><Right /></>);
    act(() => {
      state.value.left = "L2";
    });
    expect(screen.getByLabelText("tracked left").textContent).toBe("L2");
    expect(leftRenders).toHaveBeenCalledTimes(2);
    expect(rightRenders).toHaveBeenCalledTimes(1);
    act(() => {
      state.value.right = "R2";
    });
    expect(screen.getByLabelText("tracked right").textContent).toBe("R2");
    expect(leftRenders).toHaveBeenCalledTimes(2);
    expect(rightRenders).toHaveBeenCalledTimes(2);
  });

  it("keeps a cached computed live across unrelated parent rerenders", () => {
    const source = signal(2);
    const doubled = computed(() => source.value * 2);

    function Value({ label }: { label: string }) {
      useSignals();
      return <output aria-label="tracked computed">{`${label}:${doubled.value}`}</output>;
    }

    const view = render(<Value label="first" />);
    view.rerender(<Value label="second" />);
    act(() => {
      source.value = 3;
    });
    expect(screen.getByLabelText("tracked computed").textContent).toBe("second:6");
  });

  it("does not loop forever reading a computed that returns a fresh array each evaluation", () => {
    const source = signal([1, 2, 3]);
    const doubled = computed(() => source.value.map((n) => n * 2));
    const renders = vi.fn();

    function Value() {
      useSignals();
      renders();
      return <output aria-label="array computed">{doubled.value.join(",")}</output>;
    }

    render(<Value />);
    expect(screen.getByLabelText("array computed").textContent).toBe("2,4,6");
    act(() => {
      source.value = [4, 5];
    });
    expect(screen.getByLabelText("array computed").textContent).toBe("8,10");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("does not collect reads made through untracked or computed peek", () => {
    const tracked = signal(0);
    const ignored = signal(0);
    const source = signal(1);
    const derived = computed(() => source.value * 2);
    const renders = vi.fn();

    function Value() {
      useSignals();
      renders();
      return <output aria-label="untracked render reads">{
        `${tracked.value}:${untracked(() => ignored.value)}:${derived.peek()}`
      }</output>;
    }

    render(<Value />);
    act(() => {
      ignored.value = 1;
      source.value = 2;
    });
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => {
      tracked.value = 1;
    });
    expect(screen.getByLabelText("untracked render reads").textContent).toBe("1:1:4");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("keeps direct host effects isolated from a trailing render collector", () => {
    const value = signal("component");
    const title = signal("before");
    const readerRenders = vi.fn();

    function Reader() {
      useSignals();
      readerRenders();
      return <output aria-label="isolated reader">{value.value}</output>;
    }

    render(
      <>
        <span aria-label="isolated binding" title={title}>host</span>
        <Reader />
      </>,
    );
    act(() => {
      title.value = "after";
    });
    expect((screen.getByLabelText("isolated binding") as HTMLSpanElement).title).toBe("after");
    expect(readerRenders).toHaveBeenCalledTimes(1);
  });

  it("renders a useSignal through an explicit leaf hook", () => {
    const source = signal("before");
    const parentRenders = vi.fn();
    const leafRenders = vi.fn();

    function Leaf() {
      leafRenders();
      return <span>{useSignalValue(source)}</span>;
    }

    function Parent() {
      parentRenders();
      return <Leaf />;
    }

    render(<Parent />);
    expect(screen.getByText("before")).toBeTruthy();
    expect(parentRenders).toHaveBeenCalledTimes(1);
    expect(leafRenders).toHaveBeenCalledTimes(1);
    act(() => {
      source.value = "after";
    });
    expect(screen.getByText("after")).toBeTruthy();
    expect(parentRenders).toHaveBeenCalledTimes(1);
    expect(leafRenders).toHaveBeenCalledTimes(2);
  });

  it("does not add an explicit leaf subscription to an ancestor useSignals scope", () => {
    const parentSource = signal("parent");
    const leafSource = signal("before");
    const parentRenders = vi.fn();
    const leafRenders = vi.fn();

    function Leaf() {
      leafRenders();
      return <span>{useSignalValue(leafSource)}</span>;
    }

    function Parent() {
      useSignals();
      parentRenders();
      return <section data-parent={parentSource.value}><Leaf /></section>;
    }

    render(<Parent />);
    act(() => {
      leafSource.value = "after";
    });

    expect(screen.getByText("after")).toBeTruthy();
    expect(parentRenders).toHaveBeenCalledTimes(1);
    expect(leafRenders).toHaveBeenCalledTimes(2);
  });

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

  // These four pin useSignalValue's per-component-effect contract: alien-signals
  // already dedupes a shared computed's evaluation across subscribers
  // (checkDirty/shallowPropagate), so sharing one effect across leaves would
  // only trim effect-run overhead, not getter evaluations. See the design
  // discussion that measured this before deciding not to share subscriptions.
  it("evaluates a shared computed once for one write, regardless of leaf count", () => {
    const source = signal(1);
    const evaluate = vi.fn((value: number) => value * 2);
    const doubled = computed(() => evaluate(source.value));

    function Leaf({ label }: { label: string }) {
      return <span aria-label={label}>{useSignalValue(doubled)}</span>;
    }

    render(
      <>
        <Leaf label="a" />
        <Leaf label="b" />
        <Leaf label="c" />
      </>,
    );
    expect(evaluate).toHaveBeenCalledTimes(1);

    act(() => {
      source.value = 2;
    });

    expect(screen.getByLabelText("a").textContent).toBe("4");
    expect(screen.getByLabelText("b").textContent).toBe("4");
    expect(screen.getByLabelText("c").textContent).toBe("4");
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("renders a leaf hook once for multiple writes made inside batch", () => {
    const left = signal(1);
    const right = signal(2);
    const total = computed(() => left.value + right.value);
    const renders = vi.fn();

    function Leaf() {
      renders();
      return <output aria-label="batched total">{useSignalValue(total)}</output>;
    }

    render(<Leaf />);
    expect(screen.getByLabelText("batched total").textContent).toBe("3");
    expect(renders).toHaveBeenCalledTimes(1);

    act(() => {
      batch(() => {
        left.value = 10;
        right.value = 20;
      });
    });

    expect(screen.getByLabelText("batched total").textContent).toBe("30");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("converges without looping when a StrictMode leaf resubscribes to an identity-unstable computed", () => {
    const items = signal([1, 2, 3]);
    // `.slice()` returns a new array identity on every evaluation, which is the
    // shape that lost its Object.is memoization on a cold resubscribe and
    // looped forever before RenderStore started diffing commits (see the
    // comment in src/react/use-signals.ts). A leaf hook resubscribes on every
    // mount, so StrictMode's extra mount/unmount pass exercises that same cold
    // path here.
    const doubled = computed(() => items.value.slice().map((value) => value * 2));
    const renders = vi.fn();

    function Leaf() {
      renders();
      return <output aria-label="strict doubled">{useSignalValue(doubled).join(",")}</output>;
    }

    render(
      <StrictMode>
        <Leaf />
      </StrictMode>,
    );

    expect(screen.getByLabelText("strict doubled").textContent).toBe("2,4,6");

    act(() => {
      items.value = [4, 5, 6];
    });
    expect(screen.getByLabelText("strict doubled").textContent).toBe("8,10,12");
    const rendersAfterWrite = renders.mock.calls.length;

    // A cold resubscribe may cost one bounded extra render here (see the
    // comment in src/react/use-signals.ts on Object.is memoization loss), but
    // it must settle. A resubscribe-driven loop would keep scheduling more
    // renders instead of going quiet on this empty commit.
    act(() => {});
    expect(renders).toHaveBeenCalledTimes(rendersAfterWrite);
  });

  it("stops evaluating a computed after its last leaf subscriber unmounts", () => {
    const source = signal(1);
    const evaluate = vi.fn((value: number) => value * 2);
    const doubled = computed(() => evaluate(source.value));

    function Leaf() {
      return <output aria-label="unmounted leaf">{useSignalValue(doubled)}</output>;
    }

    const view = render(<Leaf />);
    expect(screen.getByLabelText("unmounted leaf").textContent).toBe("2");
    const evaluationsAtMount = evaluate.mock.calls.length;

    view.unmount();

    // alien-signals effects are eager: a live subscriber would rerun `doubled`
    // synchronously on this write even with nothing left to read its value. An
    // unchanged call count is therefore evidence the effect was disposed, not
    // just evidence nothing rendered.
    act(() => {
      source.value = 2;
    });
    expect(evaluate).toHaveBeenCalledTimes(evaluationsAtMount);
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

  it("exposes useComputed to an explicit leaf hook", () => {
    const source = signal(2);

    function Doubled() {
      const doubled = useComputed(() => source.value * 2);
      return <output aria-label="doubled">{useSignalValue(doubled)}</output>;
    }

    render(<Doubled />);
    expect(screen.getByLabelText("doubled").textContent).toBe("4");
    act(() => {
      source.value = 5;
    });
    expect(screen.getByLabelText("doubled").textContent).toBe("10");
  });

  it("rebuilds useComputed when a React prop dependency changes", () => {
    const source = signal(2);

    function Product({ factor }: { factor: number }) {
      const product = useComputed(() => source.value * factor, [factor]);
      return <output aria-label="product">{useSignalValue(product)}</output>;
    }

    const view = render(<Product factor={2} />);
    expect(screen.getByLabelText("product").textContent).toBe("4");
    view.rerender(<Product factor={3} />);
    expect(screen.getByLabelText("product").textContent).toBe("6");
  });

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

  it("binds a signal directly to host DOM props", () => {
    function Field() {
      const disabled = useSignal(true);
      const title = useSignal("initial title");
      const hidden = useSignal(false);
      const dataState = useSignal("initial-state");
      return (
        <>
          <button
            aria-label="toggle"
            onClick={() => {
              disabled.value = !disabled.value;
              title.value = "updated title";
              hidden.value = true;
              dataState.value = "updated-state";
            }}
          >
            toggle
          </button>
          <input
            aria-label="bound field"
            disabled={disabled}
            hidden={hidden}
            title={title}
            data-state={dataState}
          />
        </>
      );
    }

    render(<Field />);
    const input = screen.getByLabelText("bound field") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.hidden).toBe(false);
    expect(input.title).toBe("initial title");
    expect(input.dataset.state).toBe("initial-state");
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(input.disabled).toBe(false);
    expect(input.hidden).toBe(true);
    expect(input.title).toBe("updated title");
    expect(input.dataset.state).toBe("updated-state");
  });

  it("binds an aria-* prop directly to a signal without rerendering its owner", () => {
    const expanded = signal(false);
    const parentRenders = vi.fn();

    function Disclosure() {
      parentRenders();
      return (
        <button aria-label="disclosure" aria-expanded={expanded}>
          toggle
        </button>
      );
    }

    render(<Disclosure />);
    const button = screen.getByLabelText("disclosure");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      expanded.value = true;
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(parentRenders).toHaveBeenCalledTimes(1);
  });

  it("removes a false disabled attribute from an unsupported host binding", () => {
    const disabled = signal(true);

    render(jsx("div", { "aria-label": "unsupported disabled host", disabled }, undefined));
    const host = screen.getByLabelText("unsupported disabled host");
    expect(host.getAttribute("disabled")).toBe("true");

    act(() => {
      disabled.value = false;
    });
    expect(host.getAttribute("disabled")).toBeNull();
  });

  it("binds a signal directly to the style prop, clearing keys dropped from a later value", () => {
    const style = signal<Record<string, string | number>>({ color: "red", width: 10 });
    const parentRenders = vi.fn();

    function Box() {
      parentRenders();
      return <div aria-label="styled box" style={style} />;
    }

    render(<Box />);
    const box = screen.getByLabelText("styled box");
    expect(box.style.color).toBe("red");
    expect(box.style.width).toBe("10px");
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      style.value = { background: "blue" };
    });
    expect(box.style.color).toBe("");
    expect(box.style.width).toBe("");
    expect(box.style.background).toBe("blue");
    expect(parentRenders).toHaveBeenCalledTimes(1);
  });

  it("treats known-unitless CSS properties and CSS custom properties correctly", () => {
    const style = signal<Record<string, string | number>>({ opacity: 0.5, "--gap": 4 });

    render(<div aria-label="unitless box" style={style} />);
    const box = screen.getByLabelText("unitless box");
    expect(box.style.opacity).toBe("0.5");
    expect(box.style.getPropertyValue("--gap")).toBe("4");

    act(() => {
      style.value = { opacity: 1 };
    });
    expect(box.style.opacity).toBe("1");
    expect(box.style.getPropertyValue("--gap")).toBe("");
  });

  it("binds a signal directly to a text input's value without React controlling it", () => {
    const text = signal("initial");

    function Field() {
      return <input aria-label="field" value={text} onChange={(event) => { text.value = event.target.value; }} />;
    }

    render(<Field />);
    const input = screen.getByLabelText("field") as HTMLInputElement;
    expect(input.value).toBe("initial");

    fireEvent.change(input, { target: { value: "typed" } });
    expect(text.value).toBe("typed");
    expect(input.value).toBe("typed");

    act(() => {
      text.value = "external update";
    });
    expect(input.value).toBe("external update");
  });

  it("does not let an unrelated re-render move the caret on a direct-bound value", () => {
    const text = signal("abc");
    const bump = signal(0);

    function Field() {
      useSignals();
      void bump.value;
      return <input aria-label="field" value={text} onChange={(event) => { text.value = event.target.value; }} />;
    }

    render(<Field />);
    const input = screen.getByLabelText("field") as HTMLInputElement;

    // Write from outside a React commit, the way another part of the app
    // (or this same effect on a prior keystroke) would.
    act(() => {
      text.value = "xyz";
    });
    input.focus();
    input.setSelectionRange(1, 1);

    // A re-render for an unrelated reason must not touch `value` at all: it
    // was substituted with `defaultValue`, which React only applies at mount.
    // (React 19's own controlled-`value` commit path already guards against
    // a same-value native write, so this specific assertion does not by
    // itself distinguish the two prop-handling strategies — see the caveat
    // recorded in docs/direct-binding-value-checked-style.md. The substitution
    // is still correct to keep: it avoids relying on that internal guard and
    // the per-render reconciliation work React would otherwise do here.)
    act(() => {
      bump.value++;
    });
    expect(input.value).toBe("xyz");
    expect(input.selectionStart).toBe(1);
  });

  it("defers a forced value write until an in-progress IME composition ends", () => {
    const text = signal("abc");

    function Field() {
      return <input aria-label="ime field" value={text} onChange={(event) => { text.value = event.target.value; }} />;
    }

    render(<Field />);
    const input = screen.getByLabelText("ime field") as HTMLInputElement;
    input.focus();

    fireEvent.compositionStart(input);
    // The browser renders composing IME candidates directly into `.value`
    // without necessarily running them through `onChange` on every keystroke.
    input.value = "こんに";

    // Another subscriber of the same signal writing back mid-composition —
    // not the input's own onChange — must not stomp the composing text.
    act(() => {
      text.value = "external update";
    });
    expect(input.value).toBe("こんに");

    fireEvent.compositionEnd(input);
    expect(input.value).toBe("external update");
  });

  it("binds a signal directly to a checkbox's checked state without React controlling it", () => {
    const checked = signal(false);
    const bump = signal(0);

    function Field() {
      useSignals();
      void bump.value;
      return (
        <input
          type="checkbox"
          aria-label="agree"
          checked={checked}
          onChange={(event) => { checked.value = event.target.checked; }}
        />
      );
    }

    render(<Field />);
    const input = screen.getByLabelText("agree") as HTMLInputElement;
    expect(input.checked).toBe(false);

    fireEvent.click(input);
    expect(checked.value).toBe(true);
    expect(input.checked).toBe(true);

    // An unrelated re-render must not revert the DOM to the value React
    // controlled at mount time.
    act(() => {
      bump.value++;
    });
    expect(input.checked).toBe(true);
  });

  it("binds a signal directly to a select element's value", () => {
    const choice = signal("b");

    function Field() {
      return (
        <select aria-label="choice" value={choice} onChange={(event) => { choice.value = event.target.value; }}>
          <option value="a">A</option>
          <option value="b">B</option>
          <option value="c">C</option>
        </select>
      );
    }

    render(<Field />);
    const select = screen.getByLabelText("choice") as HTMLSelectElement;
    expect(select.value).toBe("b");

    fireEvent.change(select, { target: { value: "c" } });
    expect(choice.value).toBe("c");
    expect(select.value).toBe("c");
  });

  it("binds a signal directly to a multi-select's value via per-option selection", () => {
    const choices = signal<string[]>(["a", "c"]);

    function Field() {
      return (
        <select
          multiple
          aria-label="choices"
          value={choices}
          onChange={(event) => {
            choices.value = Array.from(event.target.selectedOptions).map((option) => option.value);
          }}
        >
          <option value="a">A</option>
          <option value="b">B</option>
          <option value="c">C</option>
        </select>
      );
    }

    render(<Field />);
    const select = screen.getByLabelText("choices") as HTMLSelectElement;
    const optionStates = () => Array.from(select.options).map((option) => option.selected);
    expect(optionStates()).toEqual([true, false, true]);

    act(() => {
      choices.value = ["b"];
    });
    expect(optionStates()).toEqual([false, true, false]);
  });

  it("resyncs a bound select's value once a matching <option> is added later", async () => {
    const choice = signal("c");
    const showOptionC = signal(false);

    function Field() {
      useSignals();
      return (
        <select aria-label="late choice" value={choice} onChange={(event) => { choice.value = event.target.value; }}>
          <option value="a">A</option>
          <option value="b">B</option>
          {showOptionC.value ? <option value="c">C</option> : null}
        </select>
      );
    }

    render(<Field />);
    const select = screen.getByLabelText("late choice") as HTMLSelectElement;
    // No matching <option> exists yet, so nothing is selected — the bound
    // signal did not change, only the DOM's option list will.
    expect(select.value).toBe("");

    act(() => {
      showOptionC.value = true;
    });
    // The MutationObserver delivers its callback as a microtask, so the
    // resync lands a tick after the option is actually in the DOM.
    await waitFor(() => expect(select.value).toBe("c"));
  });

  it("keeps a direct style binding's last DOM value and reports its computed source's failures once per episode", () => {
    const shouldFail = signal(false);
    const raw = signal("red");
    // Reading both signals unconditionally keeps them both dependencies even
    // while throwing, so a write to either re-triggers the binding's effect.
    const styleColor = computed(() => {
      const value = raw.value;
      if (shouldFail.value) throw new Error(`style boom: ${value}`);
      return { color: value };
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    function Box() {
      return <div aria-label="styled box" style={styleColor} />;
    }

    render(<Box />);
    const box = screen.getByLabelText("styled box");
    expect(box.style.color).toBe("red");

    // The computed starts throwing only after the binding is already mounted.
    // The triggering write itself must not throw, and the DOM keeps its last
    // successfully applied value.
    expect(() => {
      act(() => {
        shouldFail.value = true;
      });
    }).not.toThrow();
    expect(box.style.color).toBe("red");
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toMatch(/direct signal binding/i);
    expect((consoleError.mock.calls[0]?.[1] as { cause?: unknown } | undefined)?.cause).toBeInstanceOf(Error);

    // A further write that keeps the computed erroring (same episode) must
    // not log a second time.
    act(() => {
      raw.value = "green";
    });
    expect(box.style.color).toBe("red");
    expect(consoleError).toHaveBeenCalledTimes(1);

    // Recovery resumes DOM updates and clears the latch.
    act(() => {
      shouldFail.value = false;
    });
    expect(box.style.color).toBe("green");
    expect(consoleError).toHaveBeenCalledTimes(1);

    // A later, distinct failure episode logs again.
    act(() => {
      shouldFail.value = true;
    });
    expect(box.style.color).toBe("green");
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it("keeps an unrelated direct binding updating despite a sibling binding throwing in the same flush", () => {
    const shouldFail = signal(false);
    const raw = signal("red");
    const styleColor = computed(() => {
      const value = raw.value;
      if (shouldFail.value) throw new Error("boom");
      return { color: value };
    });
    const label = signal("first");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    function Widget() {
      return (
        <>
          <div aria-label="styled" style={styleColor} />
          <div aria-label="labeled" data-state={label} />
        </>
      );
    }

    render(<Widget />);
    const styled = screen.getByLabelText("styled");
    const labeled = screen.getByLabelText("labeled");
    expect(styled.style.color).toBe("red");
    expect(labeled.dataset.state).toBe("first");

    // Without a local catch, the throwing effect would propagate out of
    // `flush()` and its `finally` would drop the still-queued sibling effect
    // for this cycle — silently, not by throwing on it directly.
    expect(() => {
      act(() => {
        batch(() => {
          shouldFail.value = true;
          label.value = "second";
        });
      });
    }).not.toThrow();

    expect(styled.style.color).toBe("red");
    expect(labeled.dataset.state).toBe("second");
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("bindSelectValue's MutationObserver survives its computed source's failure episode and resyncs once it recovers", async () => {
    const shouldFail = signal(false);
    const choice = computed(() => {
      if (shouldFail.value) throw new Error("select boom");
      return "c";
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    function Field() {
      return (
        <select aria-label="late failing choice" value={choice}>
          <option key="a" value="a">A</option>
          <option key="b" value="b">B</option>
        </select>
      );
    }

    render(<Field />);
    const select = screen.getByLabelText("late failing choice") as HTMLSelectElement;
    // No matching <option> exists yet, so nothing is selected.
    expect(select.value).toBe("");

    act(() => {
      shouldFail.value = true;
    });
    // Filtered to this fix's own message: a signal-bound host element is
    // rendered through a `ReactiveHost` wrapper (see createJsxWrapper in
    // src/runtime/jsx.ts) that reconstructs its children outside the
    // key-validated static-JSX-children path, so React's unrelated "missing
    // key" dev warning also fires here for unkeyed children — pre-existing,
    // unrelated to this fix, and orthogonal to what this test pins. The
    // explicit `key`s above route around it; this filter is a second layer of
    // defense against the same warning appearing for any other reason.
    const ownMessages = consoleError.mock.calls.filter(([message]) =>
      typeof message === "string" && message.includes("direct signal binding"),
    );
    expect(ownMessages).toHaveLength(1);

    // Mutate the option list directly (bypassing React, so the `<select>`'s
    // own JSX/props are never re-evaluated) so only the MutationObserver
    // reacts. Its own `source.peek()` hits the same cached error and must not
    // crash, and — sharing this binding's single episode latch with the
    // effect above — must not log a second time.
    const option = document.createElement("option");
    option.value = "c";
    option.textContent = "C";
    act(() => {
      select.appendChild(option);
    });
    await waitFor(() =>
      expect(
        consoleError.mock.calls.filter(([message]) =>
          typeof message === "string" && message.includes("direct signal binding"),
        ),
      ).toHaveLength(1),
    );
    // The browser's own "no option selected" default (auto-selecting the
    // first option once one exists) applies regardless of our binding — the
    // binding itself wrote nothing, which is what the unchanged call count
    // above already pins.
    expect(select.value).toBe("a");

    // Recovery: the tracked effect re-reads successfully and applies the
    // selection (the now-existing <option value="c"> makes it stick).
    act(() => {
      shouldFail.value = false;
    });
    await waitFor(() => expect(select.value).toBe("c"));
    expect(
      consoleError.mock.calls.filter(([message]) =>
        typeof message === "string" && message.includes("direct signal binding"),
      ),
    ).toHaveLength(1);
  });

  it("does not corrupt bindTextValue's pending buffer when a read fails during an active IME composition", () => {
    const shouldFail = signal(false);
    const raw = signal("abc");
    const text = computed(() => {
      const value = raw.value;
      if (shouldFail.value) throw new Error("text boom");
      return value;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    function Field() {
      return <input aria-label="failing ime field" value={text} />;
    }

    render(<Field />);
    const input = screen.getByLabelText("failing ime field") as HTMLInputElement;
    input.focus();

    fireEvent.compositionStart(input);
    // The browser renders composing IME candidates directly into `.value`.
    input.value = "こんに";

    // A failed read while composing must bail out before touching
    // `pending`/`hasPending` at all, leaving the composing text alone.
    act(() => {
      shouldFail.value = true;
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("こんに");

    fireEvent.compositionEnd(input);
    // No successful read was ever pending, so composition end applies nothing.
    expect(input.value).toBe("こんに");

    // A second failing write during the same episode does not log again.
    fireEvent.compositionStart(input);
    input.value = "ignored candidate";
    act(() => {
      raw.value = "still failing";
    });
    expect(consoleError).toHaveBeenCalledTimes(1);

    // Recovery is what latches as pending, not anything from a failed read.
    act(() => {
      raw.value = "recovered";
      shouldFail.value = false;
    });
    expect(input.value).toBe("ignored candidate");
    fireEvent.compositionEnd(input);
    expect(input.value).toBe("recovered");
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("unchecks radio siblings backed by independent computed signals when another is selected", () => {
    const selected = signal("a");
    const isA = computed(() => selected.value === "a");
    const isB = computed(() => selected.value === "b");

    function Field() {
      return (
        <fieldset>
          <input
            type="radio"
            name="choice"
            aria-label="option a"
            checked={isA}
            onChange={() => { selected.value = "a"; }}
          />
          <input
            type="radio"
            name="choice"
            aria-label="option b"
            checked={isB}
            onChange={() => { selected.value = "b"; }}
          />
        </fieldset>
      );
    }

    render(<Field />);
    const optionA = screen.getByLabelText("option a") as HTMLInputElement;
    const optionB = screen.getByLabelText("option b") as HTMLInputElement;
    expect(optionA.checked).toBe(true);
    expect(optionB.checked).toBe(false);

    fireEvent.click(optionB);
    expect(selected.value).toBe("b");
    expect(optionA.checked).toBe(false);
    expect(optionB.checked).toBe(true);
  });

  it("preserves focus and caret across StrictMode's double-invoked ref setup for a bound value", () => {
    const text = signal("abc");
    const bump = signal(0);

    function Field() {
      useSignals();
      void bump.value;
      return (
        <StrictMode>
          <input aria-label="strict field" value={text} onChange={(event) => { text.value = event.target.value; }} />
        </StrictMode>
      );
    }

    render(<Field />);
    const input = screen.getByLabelText("strict field") as HTMLInputElement;
    input.focus();
    input.setSelectionRange(1, 1);

    // StrictMode double-invokes the ref (setup, cleanup, setup) once at mount.
    // If that double-invoke left two live subscriptions instead of one, an
    // unrelated re-render would write `value` twice and could still move the
    // caret even though the first write leaves it untouched.
    act(() => {
      bump.value++;
    });
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("abc");
    expect(input.selectionStart).toBe(1);
  });

  it("updates a signal child without rerendering its parent", () => {
    const source = signal("before");
    const parentRenders = vi.fn();

    function Parent() {
      parentRenders();
      return <span>{source}</span>;
    }

    render(<Parent />);
    expect(screen.getByText("before")).toBeTruthy();
    expect(parentRenders).toHaveBeenCalledTimes(1);
    act(() => {
      source.value = "after";
    });
    expect(screen.getByText("after")).toBeTruthy();
    expect(parentRenders).toHaveBeenCalledTimes(1);
  });

  it("updates an SVG signal child without rerendering its parent", () => {
    const source = signal("before");
    const parentRenders = vi.fn();

    function Parent() {
      parentRenders();
      return (
        <svg aria-label="signal chart">
          <text>{source}</text>
        </svg>
      );
    }

    const view = render(<Parent />);
    const text = view.container.querySelector("text");
    expect(text?.textContent).toBe("before");
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      source.value = "after";
    });
    expect(text?.textContent).toBe("after");
    expect(parentRenders).toHaveBeenCalledTimes(1);
  });

  it("updates an array-valued signal child without rerendering its parent", () => {
    const items = signal(["a", "b"]);
    const parentRenders = vi.fn();

    function Parent() {
      parentRenders();
      return <ul aria-label="signal list">{items}</ul>;
    }

    render(<Parent />);
    expect(screen.getByLabelText("signal list").textContent).toBe("ab");
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      items.value = ["c", "d", "e"];
    });
    expect(screen.getByLabelText("signal list").textContent).toBe("cde");
    expect(parentRenders).toHaveBeenCalledTimes(1);
  });

  it("updates a signal child nested inside another signal without rerendering its parent", () => {
    const inner = signal("leaf");
    const outer = signal<string | typeof inner>(inner);
    const parentRenders = vi.fn();

    function Parent() {
      parentRenders();
      return <span aria-label="nested signal child">{outer}</span>;
    }

    render(<Parent />);
    expect(screen.getByLabelText("nested signal child").textContent).toBe("leaf");
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      inner.value = "changed";
    });
    expect(screen.getByLabelText("nested signal child").textContent).toBe("changed");
    expect(parentRenders).toHaveBeenCalledTimes(1);
  });

  it("updates className safely on a tag shared by the HTML and SVG namespaces", () => {
    const className = signal("before");

    render(
      <svg aria-label="shared namespace host">
        <a aria-label="svg link" className={className} />
      </svg>,
    );
    const link = screen.getByLabelText("svg link");
    expect(link.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(link.getAttribute("class")).toBe("before");

    act(() => {
      className.value = "after";
    });
    expect(link.getAttribute("class")).toBe("after");
  });

  it("does not unwrap a signal passed as a React component prop", () => {
    const source = signal("value");
    const childRenders = vi.fn();

    function Child({ value }: { value: typeof source }) {
      childRenders();
      return <output data-testid="component-prop">{value === source ? "signal" : "unwrapped"}</output>;
    }

    function Parent() {
      return <Child value={source} />;
    }

    render(<Parent />);
    expect(screen.getByTestId("component-prop").textContent).toBe("signal");
    expect(childRenders).toHaveBeenCalledTimes(1);
    act(() => {
      source.value = "changed";
    });
    expect(screen.getByTestId("component-prop").textContent).toBe("signal");
    expect(childRenders).toHaveBeenCalledTimes(1);
  });

  it("passes a signal child to a custom component without changing identity", () => {
    const source = signal("child");
    const childRenders = vi.fn();

    function Child({ children }: { children?: unknown }) {
      childRenders();
      return <output aria-label="child-identity">{children === source ? "same" : "different"}</output>;
    }

    render(<Child>{source}</Child>);
    expect(screen.getByLabelText("child-identity").textContent).toBe("same");
    expect(childRenders).toHaveBeenCalledTimes(1);
    act(() => {
      source.value = "updated";
    });
    expect(screen.getByLabelText("child-identity").textContent).toBe("same");
    expect(childRenders).toHaveBeenCalledTimes(1);
  });

  it("stops host signal prop updates after unmount", () => {
    const title = signal("attached");

    function Host() {
      return <span aria-label="detached host" title={title}>host</span>;
    }

    const view = render(<Host />);
    const node = screen.getByLabelText("detached host") as HTMLSpanElement;
    expect(node.title).toBe("attached");
    view.unmount();
    title.value = "after unmount";
    expect(node.title).toBe("attached");
  });

  it("balances callback ref setup and cleanup for a host signal binding", () => {
    const title = signal("attached");
    const setups = vi.fn();
    const cleanups = vi.fn();

    function Host() {
      return (
        <span
          aria-label="ref host"
          title={title}
          ref={(node) => {
            if (!node) return;
            setups();
            return cleanups;
          }}
        >
          host
        </span>
      );
    }

    const view = render(<Host />);
    expect(setups).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(cleanups).toHaveBeenCalledTimes(setups.mock.calls.length);
  });

  it("keeps a StrictMode host binding live for one update and inert after unmount", () => {
    const title = signal("before");
    const setups = vi.fn();
    const cleanups = vi.fn();

    function Host() {
      return (
        <StrictMode>
          <span
            aria-label="strict host"
            title={title}
            ref={(node) => {
              if (!node) return;
              setups();
              return cleanups;
            }}
          >
            host
          </span>
        </StrictMode>
      );
    }

    const view = render(<Host />);
    const node = screen.getByLabelText("strict host") as HTMLSpanElement;
    expect(node.title).toBe("before");
    act(() => {
      title.value = "after";
    });
    expect(node.title).toBe("after");

    view.unmount();
    const cleanupCount = cleanups.mock.calls.length;
    title.value = "after unmount";
    expect(node.title).toBe("after");
    expect(cleanups).toHaveBeenCalledTimes(setups.mock.calls.length);
    expect(cleanupCount).toBe(setups.mock.calls.length);
  });

  it("sets an object ref to the host node and clears it on unmount", () => {
    const title = signal("attached");
    const userRef = createRef<HTMLSpanElement>();

    const view = render(
      <span aria-label="object ref host" title={title} ref={userRef}>
        host
      </span>,
    );
    expect(userRef.current).not.toBeNull();
    expect(userRef.current?.title).toBe("attached");

    view.unmount();
    expect(userRef.current).toBeNull();
  });

  it("preserves factory keys and signal identity for custom component props and children", () => {
    const source = signal("child");

    function Child(_props: { value: typeof source; children: typeof source }) {
      return null;
    }

    const single = jsx(Child, { value: source, children: source }, "single-key");
    const many = jsxs(Child, { value: source, children: [source, "tail"] }, "many-key");
    const dev = jsxDEV(
      Child,
      { value: source, children: source },
      "dev-key",
      false,
      undefined,
      undefined,
    );
    const readProps = (element: { props: unknown }) => element.props as {
      value: typeof source;
      children: unknown;
    };
    const singleProps = readProps(single);
    const manyProps = readProps(many);
    const devProps = readProps(dev);

    expect(single.key).toBe("single-key");
    expect(singleProps.value).toBe(source);
    expect(singleProps.children).toBe(source);
    expect(many.key).toBe("many-key");
    expect(manyProps.value).toBe(source);
    expect((manyProps.children as unknown[])[0]).toBe(source);
    expect(dev.key).toBe("dev-key");
    expect(devProps.value).toBe(source);
    expect(devProps.children).toBe(source);
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
