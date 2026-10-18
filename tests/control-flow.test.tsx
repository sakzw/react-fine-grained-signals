// @vitest-environment jsdom

import { act, createContext, Fragment, StrictMode, Suspense, useContext, useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computed, deepSignal, signal, useComputed, useSignalTracking } from "../src/index.js";
import { coreRuntime } from "../src/core/core-runtime.js";
import { For, Index, Match, Show, Switch } from "react-fine-grained-signals/utils";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

describe("JSX control flow utilities", () => {
  it("keeps parent closures and context current and cleans up the collection subscription", async () => {
    const rows = signal(["row"]);
    const LabelContext = createContext("initial");
    let setLabel!: (label: string) => void;
    function Label() {
      const label = useContext(LabelContext);
      return <output>{label}</output>;
    }
    function App() {
      const [label, updateLabel] = useState("initial");
      setLabel = updateLabel;
      return (
        <LabelContext.Provider value={label}>
          <For each={rows} by={(row) => row}>{(row) => <><li>{`${label}:${row}`}</li><Label /></>}</For>
        </LabelContext.Provider>
      );
    }

    const view = render(<App />);
    expect(coreRuntime.hasSubscribers(rows)).toBe(true);
    act(() => setLabel("updated"));
    expect(view.getByText("updated")).toBeTruthy();
    expect(view.getByText("updated:row")).toBeTruthy();
    view.unmount();
    await waitFor(() => expect(coreRuntime.hasSubscribers(rows)).toBe(false));
  });

  it("cleans up Index's collection subscription after unmount", async () => {
    const rows = signal(["row"]);
    const view = render(<Index each={rows}>{(item) => <span>{item()}</span>}</Index>);
    expect(coreRuntime.hasSubscribers(rows)).toBe(true);

    view.unmount();
    await waitFor(() => expect(coreRuntime.hasSubscribers(rows)).toBe(false));
  });

  it("updates Show locally and renders its fallback", () => {
    const visible = signal(false);
    const parentRenders = vi.fn();

    function Parent() {
      parentRenders();
      return (
        <Show when={visible} fallback={<p>hidden</p>}>
          {(value) => <p>shown:{String(value)}</p>}
        </Show>
      );
    }

    render(<Parent />);
    expect(screen.getByText("hidden")).toBeTruthy();
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      visible.value = true;
    });
    expect(screen.getByText("shown:true")).toBeTruthy();
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      visible.value = false;
    });
    expect(screen.getByText("hidden")).toBeTruthy();
  });

  it("keeps utility subscriptions live through Strict Mode replay", () => {
    const visible = signal(false);
    const items = signal(["Ada"]);

    const view = render(
      <StrictMode>
        <Show when={visible} fallback={<p data-testid="strict-visible">hidden</p>}>
          <p data-testid="strict-visible">visible</p>
        </Show>
        <ul>
          <For each={items} by={(item) => item} fallback={<li>empty</li>}>
            {(item) => <li>{item}</li>}
          </For>
        </ul>
      </StrictMode>,
    );

    act(() => {
      visible.value = true;
      items.value = ["Ada", "Bea"];
    });
    expect(screen.getByTestId("strict-visible").textContent).toBe("visible");
    expect(view.container.querySelectorAll("li")).toHaveLength(2);

    view.unmount();
    act(() => {
      visible.value = false;
      items.value = [];
    });
  });

  it("uses the first truthy Match and supports fragments", () => {
    const primary = signal(false);
    const secondary = signal(false);

    render(
      <Switch fallback={<p>fallback</p>}>
        <Match when={primary}><p>primary</p></Match>
        <Fragment>
          <Match when={secondary}>{(value) => <p>secondary:{String(value)}</p>}</Match>
        </Fragment>
        <Match when={false}><p>later branch</p></Match>
      </Switch>,
    );

    expect(screen.getByText("fallback")).toBeTruthy();
    expect(screen.queryByText("later branch")).toBeNull();

    act(() => {
      secondary.value = true;
    });
    expect(screen.getByText("secondary:true")).toBeTruthy();

    act(() => {
      primary.value = true;
    });
    expect(screen.getByText("primary")).toBeTruthy();
    expect(screen.queryByText("secondary:true")).toBeNull();
    expect(coreRuntime.hasSubscribers(secondary)).toBe(false);

    act(() => {
      primary.value = false;
      secondary.value = false;
    });
    expect(screen.getByText("fallback")).toBeTruthy();
  });

  it("compares Match equals values with Object.is and preserves omitted truthy matching", () => {
    const value = signal<unknown>("list");
    const view = render(
      <Switch fallback={<p data-testid="equal-fallback">fallback</p>}>
        <Match when={value} equals="list"><p data-testid="equal-result">list</p></Match>
        <Match when={value} equals={0}><p data-testid="equal-result">zero</p></Match>
        <Match when={value} equals={false}><p data-testid="equal-result">false</p></Match>
        <Match when={value} equals=""><p data-testid="equal-result">empty string</p></Match>
        <Match when={value} equals={null}><p data-testid="equal-result">null</p></Match>
        <Match when={value} equals={undefined}><p data-testid="equal-result">undefined</p></Match>
        <Match when={value} equals={Number.NaN}><p data-testid="equal-result">nan</p></Match>
        <Match when={value} equals={-0}><p data-testid="equal-result">negative zero</p></Match>
      </Switch>,
    );

    expect(screen.getByTestId("equal-result").textContent).toBe("list");
    for (const [next, expected] of [
      [0, "zero"],
      [false, "false"],
      ["", "empty string"],
      [null, "null"],
      [undefined, "undefined"],
      [Number.NaN, "nan"],
      [-0, "negative zero"],
    ] as const) {
      act(() => { value.value = next; });
      expect(screen.getByTestId("equal-result").textContent).toBe(expected);
    }

    act(() => { value.value = +0; });
    expect(screen.getByTestId("equal-result").textContent).toBe("zero");
    view.unmount();

    const signedZero = signal(-0);
    const signedZeroView = render(
      <Switch fallback={<p data-testid="signed-zero-fallback">fallback</p>}>
        <Match when={signedZero} equals={+0}><p>positive zero</p></Match>
      </Switch>,
    );
    expect(screen.getByTestId("signed-zero-fallback").textContent).toBe("fallback");
    act(() => { signedZero.value = +0; });
    expect(screen.getByText("positive zero")).toBeTruthy();
    signedZeroView.unmount();

    const undefinedValue = signal<undefined>(undefined);
    render(
      <Switch fallback={<p>fallback</p>}>
        <Match when={undefinedValue}><p>legacy truthy</p></Match>
      </Switch>,
    );
    expect(screen.getByText("fallback")).toBeTruthy();
  });

  it("runs Match equals subscriptions inside Switch without rerendering the parent", () => {
    const viewValue = signal<"list" | "details">("list");
    const parentRenders = vi.fn();
    const branchRenders = vi.fn();

    function Parent() {
      parentRenders();
      return <Switch>
        <Match when={viewValue} equals="list"><p data-testid="selected">list</p></Match>
        <Match when={viewValue} equals="details"><Details /></Match>
      </Switch>;
    }
    function Details() {
      branchRenders();
      return <p data-testid="selected">details</p>;
    }

    const view = render(<Parent />);
    expect(parentRenders).toHaveBeenCalledTimes(1);
    expect(coreRuntime.hasSubscribers(viewValue)).toBe(true);
    act(() => { viewValue.value = "details"; });
    expect(screen.getByTestId("selected").textContent).toBe("details");
    expect(parentRenders).toHaveBeenCalledTimes(1);
    expect(branchRenders).toHaveBeenCalledTimes(1);
    act(() => { viewValue.value = "list"; });
    expect(screen.getByTestId("selected").textContent).toBe("list");
    expect(parentRenders).toHaveBeenCalledTimes(1);
    view.unmount();
    return waitFor(() => expect(coreRuntime.hasSubscribers(viewValue)).toBe(false));
  });

  it("re-evaluates the first equal Match when the Match order changes", () => {
    const active = signal<"shared">("shared");
    function App({ reverse }: { reverse: boolean }) {
      const branches = [
        <Match key="first" when={active} equals="shared"><p>first branch</p></Match>,
        <Match key="second" when={active} equals="shared"><p>second branch</p></Match>,
      ];
      return <Switch>{reverse ? [branches[1], branches[0]] : branches}</Switch>;
    }

    const view = render(<App reverse={false} />);
    expect(screen.getByText("first branch")).toBeTruthy();
    view.rerender(<App reverse />);
    expect(screen.getByText("second branch")).toBeTruthy();
    expect(screen.queryByText("first branch")).toBeNull();
  });

  it("distinguishes parent reads, useComputed conditions, and Match equals subscription boundaries", async () => {
    const source = signal<"list" | "details">("list");
    const directParentRenders = vi.fn();
    function DirectParent() {
      directParentRenders();
      useSignalTracking();
      return <Switch>
        <Match when={source.value === "list"}><p>list</p></Match>
        <Match when={source.value === "details"}><p>details</p></Match>
      </Switch>;
    }
    const direct = render(<DirectParent />);
    act(() => { source.value = "details"; });
    expect(directParentRenders.mock.calls.length).toBeGreaterThan(1);
    direct.unmount();
    await waitFor(() => expect(coreRuntime.hasSubscribers(source)).toBe(false));

    const list = computed(() => source.value === "list");
    const details = computed(() => source.value === "details");
    const computedParentRenders = vi.fn();
    function ComputedParent() {
      computedParentRenders();
      return <Switch>
        <Match when={list}><p>list</p></Match>
        <Match when={details}><p>details</p></Match>
      </Switch>;
    }
    const computedView = render(<ComputedParent />);
    const computedParentCount = computedParentRenders.mock.calls.length;
    act(() => { source.value = "list"; });
    expect(computedParentRenders.mock.calls.length).toBe(computedParentCount);
    computedView.unmount();
    await waitFor(() => expect(coreRuntime.hasSubscribers(source)).toBe(false));

    const equalsParentRenders = vi.fn();
    function EqualsParent() {
      equalsParentRenders();
      return <Switch>
        <Match when={source} equals="list"><p>list</p></Match>
        <Match when={source} equals="details"><p>details</p></Match>
      </Switch>;
    }
    const equalsView = render(<EqualsParent />);
    const equalsParentCount = equalsParentRenders.mock.calls.length;
    act(() => { source.value = "details"; });
    expect(screen.getByText("details")).toBeTruthy();
    expect(equalsParentRenders.mock.calls.length).toBe(equalsParentCount);
    equalsView.unmount();
    await waitFor(() => expect(coreRuntime.hasSubscribers(source)).toBe(false));

    const hookParentRenders = vi.fn();
    function HookComputedParent() {
      hookParentRenders();
      const viewState = useComputed(() => source.value, []);
      return <Switch>
        <Match when={viewState} equals="list"><p>list</p></Match>
        <Match when={viewState} equals="details"><p>details</p></Match>
      </Switch>;
    }
    const hookView = render(<HookComputedParent />);
    expect(screen.getByText("details")).toBeTruthy();
    const hookParentCount = hookParentRenders.mock.calls.length;
    act(() => { source.value = "list"; });
    expect(screen.getByText("list")).toBeTruthy();
    expect(hookParentRenders.mock.calls.length).toBe(hookParentCount);
    hookView.unmount();
  });

  it("switches between signal and plain Match inputs, nests Switch, and cleans branch state", async () => {
    const source = signal<"a" | "b">("a");
    const childMount = vi.fn();
    function Child() {
      childMount();
      return <p>branch A</p>;
    }
    function App({ useSignalValue, plain }: { useSignalValue: boolean; plain: "a" | "b" }) {
      const when = useSignalValue ? source : plain;
      return <Switch fallback={<p>outer fallback</p>}>
        <Match when={when} equals="a">
          <Switch><Match when="a" equals="a"><Child /></Match></Switch>
        </Match>
        <Match when={when} equals="b"><p>branch B</p></Match>
      </Switch>;
    }

    const view = render(<App useSignalValue plain="b" />);
    expect(screen.getByText("branch A")).toBeTruthy();
    act(() => { source.value = "b"; });
    expect(screen.getByText("branch B")).toBeTruthy();
    expect(screen.queryByText("branch A")).toBeNull();
    view.rerender(<App useSignalValue={false} plain="a" />);
    expect(screen.getByText("branch A")).toBeTruthy();
    view.rerender(<App useSignalValue={false} plain="b" />);
    expect(screen.getByText("branch B")).toBeTruthy();
    view.rerender(<App useSignalValue plain="a" />);
    expect(coreRuntime.hasSubscribers(source)).toBe(true);
    view.unmount();
    await waitFor(() => expect(coreRuntime.hasSubscribers(source)).toBe(false));
    expect(childMount.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps Switch equals reactive under StrictMode and renders the same server and hydrated branch", async () => {
    const current = signal<"list" | "details">("list");
    const parentRenders = vi.fn();
    function App() {
      parentRenders();
      return <StrictMode><Switch>
        <Match when={current} equals="list"><p data-testid="strict-match">list</p></Match>
        <Match when={current} equals="details"><p data-testid="strict-match">details</p></Match>
      </Switch></StrictMode>;
    }

    const view = render(<App />);
    const before = parentRenders.mock.calls.length;
    act(() => { current.value = "details"; });
    expect(screen.getByTestId("strict-match").textContent).toBe("details");
    expect(parentRenders.mock.calls.length).toBe(before);
    view.unmount();
  });

  it("closes the Switch tracking scope when a concurrent branch suspends or is abandoned", async () => {
    const mode = signal<"ready" | "suspend">("ready");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let shouldSuspend = false;
    function App() {
      return <Suspense fallback={<p>pending branch</p>}>
        <Switch>
          <Match when={mode} equals="suspend">{() => {
            if (shouldSuspend) throw pending;
            return <p>stale suspended branch</p>;
          }}</Match>
          <Match when={mode} equals="ready"><p>ready branch</p></Match>
        </Switch>
      </Suspense>;
    }

    const view = render(<App />);
    shouldSuspend = true;
    act(() => { mode.value = "suspend"; });
    expect(screen.getByText("pending branch")).toBeTruthy();
    act(() => { mode.value = "ready"; });
    expect(screen.getByText("ready branch")).toBeTruthy();
    await act(async () => {
      release();
      await pending;
    });
    expect(screen.getByText("ready branch")).toBeTruthy();
    expect(screen.queryByText("stale suspended branch")).toBeNull();
    view.unmount();
    await waitFor(() => expect(coreRuntime.hasSubscribers(mode)).toBe(false));
  });

  it("renders a deep-signal array, its fallback, and keyed reorders", () => {
    const items = deepSignal([
      { id: "a", label: "Ada" },
      { id: "b", label: "Bea" },
      { id: "c", label: "Cy" },
    ]);

    const keyCalls = vi.fn((item: { id: string }) => item.id);

    function Row({ item }: { item: { id: string; label: string } }) {
      useSignalTracking();
      const [mountedFor] = useState(item.id);
      return <li data-testid={item.id}>{`${mountedFor}:${item.label}`}</li>;
    }

    const view = render(
      <ul>
        <For each={items} by={keyCalls} fallback={<li>empty</li>}>
          {(item) => <Row item={item} />}
        </For>
      </ul>,
    );
    const list = view.container.querySelector("ul")!;
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["a:Ada", "b:Bea", "c:Cy"]);

    act(() => {
      items.value = [items.value[2]!, items.value[0]!, items.value[1]!];
    });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["c:Cy", "a:Ada", "b:Bea"]);
    const callsBeforeLeafUpdate = keyCalls.mock.calls.length;

    act(() => {
      items.value[0]!.label = "Cyra";
    });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["c:Cyra", "a:Ada", "b:Bea"]);
    expect(keyCalls).toHaveBeenCalledTimes(callsBeforeLeafUpdate);

    act(() => {
      items.value = [];
    });
    expect(within(list).getByText("empty")).toBeTruthy();
  });

  it("renders For's fallback for a null or undefined collection", () => {
    const items = signal<string[] | null | undefined>(["Ada"]);

    render(
      <ul>
        <For each={items} by={(item) => item} fallback={<li>empty</li>}>{(item) => <li>{item}</li>}</For>
      </ul>,
    );
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Ada"]);

    act(() => {
      items.value = null;
    });
    expect(screen.getByText("empty")).toBeTruthy();

    act(() => {
      items.value = undefined;
    });
    expect(screen.getByText("empty")).toBeTruthy();

    act(() => {
      items.value = ["Bea"];
    });
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Bea"]);
  });

  it("renders Map and Set inputs after immutable collection replacement", () => {
    const tags = signal(new Set(["react"]));
    const users = signal(new Map([["ada", { name: "Ada" }]]));

    render(
      <>
        <ul data-testid="tags">
          <For each={tags} by={(tag) => tag}>{(tag) => <li>{tag}</li>}</For>
        </ul>
        <ul data-testid="users">
          <For each={users} by={([id]) => id}>
            {([id, user]) => <li>{`${id}:${user.name}`}</li>}
          </For>
        </ul>
      </>,
    );

    expect(within(screen.getByTestId("tags")).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["react"]);
    expect(within(screen.getByTestId("users")).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["ada:Ada"]);

    act(() => {
      tags.value = new Set(["signals", "react"]);
      users.value = new Map([
        ["bea", { name: "Bea" }],
        ["ada", { name: "Ada Lovelace" }],
      ]);
    });
    expect(within(screen.getByTestId("tags")).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["signals", "react"]);
    expect(within(screen.getByTestId("users")).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["bea:Bea", "ada:Ada Lovelace"]);
  });

  it("keeps Index row state at a position while its item changes", () => {
    const items = deepSignal([
      { id: "ada", name: "Ada" },
      { id: "bea", name: "Bea" },
    ]);

    function Row({ item }: { item: () => { id: string; name: string } }) {
      useSignalTracking();
      const current = item();
      const [positionOwner] = useState(current.id);
      return <li>{`${positionOwner}:${current.name}`}</li>;
    }

    const view = render(
      <ul>
        <Index each={items} fallback={<li>empty</li>}>
          {(item) => <Row item={item} />}
        </Index>
      </ul>,
    );
    const list = view.container.querySelector("ul")!;
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["ada:Ada", "bea:Bea"]);

    act(() => {
      items.value = [items.value[1]!, items.value[0]!];
    });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["ada:Bea", "bea:Ada"]);

    act(() => {
      items.value[0]!.name = "Beatrice";
    });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["ada:Beatrice", "bea:Ada"]);

    act(() => {
      items.value = [];
    });
    expect(within(list).getByText("empty")).toBeTruthy();
  });

  it("does not leak For's render scope onto a later sibling", () => {
    const rows = signal(["a"]);
    const orphan = signal("before");
    const forRenders = vi.fn();

    // Deliberately has no `useSignalTracking()`: its render-time read belongs to
    // nobody. With `For` on the best-effort boundary, `For`'s scope was still
    // open when this sibling rendered, so the read was collected into `For`'s
    // store and writing `orphan` re-rendered `For` instead.
    function Orphan() {
      return <output aria-label="orphan">{orphan.value}</output>;
    }

    function Parent() {
      return (
        <>
          <For each={rows} by={(row) => row}>
            {(row) => {
              forRenders();
              return <span>{row}</span>;
            }}
          </For>
          <Orphan />
        </>
      );
    }

    render(<Parent />);
    expect(forRenders).toHaveBeenCalledTimes(1);

    act(() => {
      orphan.value = "after";
    });
    expect(forRenders).toHaveBeenCalledTimes(1);

    // `For` itself still tracks what it actually read.
    act(() => {
      rows.value = ["a", "b"];
    });
    expect(forRenders).toHaveBeenCalledTimes(3);
  });

  it("gives Index accessors the current value rather than the render snapshot", () => {
    const rows = signal(["a", "b"]);
    let firstAccessor: (() => string) | undefined;

    function Row({ item }: { item: () => string }) {
      firstAccessor ??= item;
      return <li>{item()}</li>;
    }

    const view = render(
      <ul>
        <Index each={rows}>{(item) => <Row item={item} />}</Index>
      </ul>,
    );
    const list = view.container.querySelector("ul")!;
    expect(within(list).getAllByRole("listitem").map((entry) => entry.textContent))
      .toEqual(["a", "b"]);

    act(() => {
      rows.value = ["z", "b"];
    });
    // The accessor captured on the first render is what a child would keep in
    // an event handler; it must read back through `each`, not through the
    // array snapshot it was created with.
    expect(firstAccessor?.()).toBe("z");
  });
});
