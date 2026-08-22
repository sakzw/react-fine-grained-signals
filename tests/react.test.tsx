/** @jsxImportSource react-alien-signals */
// @vitest-environment jsdom

import { createRef, StrictMode, act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsx, jsxs } from "../src/jsx-runtime.js";
import { jsxDEV } from "../src/jsx-dev-runtime.js";
import {
  signal,
  useComputed,
  useDeepSignal,
  useSignal,
  useSignalValue,
  useSignalEffect,
} from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("React bindings", () => {
  // The render-read subscription is intentionally kept as an explicit
  // acceptance contract. Implementations that only expose leaf subscriptions
  // can enable this once useSignals has a supported no-argument mode.
  it.todo("rerenders a component that reads a useSignal through useSignals");

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
