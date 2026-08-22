/** @jsxImportSource react-alien-signals */
// @vitest-environment jsdom

import { createRef, StrictMode, act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsx, jsxs } from "../src/jsx-runtime.js";
import { jsxDEV } from "../src/jsx-dev-runtime.js";
import {
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
