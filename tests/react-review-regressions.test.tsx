/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { act, createRef, startTransition, useEffect, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { renderToString } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computed,
  createElement,
  deepSignal,
  effect,
  signal,
  useSignalEffect,
  useSignalTracking,
} from "../src/index.js";

// Regression coverage for the v0.2.0 release review's React and JSX findings.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("classic createElement fallback (B1)", () => {
  it("compiles a spread followed by key to the package root's createElement", () => {
    // Oxc (Vitest's JSX compiler here, configured with this package as
    // jsxImportSource) emits `createElement` from the package root for this
    // shape, as TypeScript and Babel do. Without the export this throws.
    const title = signal("first");
    const props = { id: "spread" };
    render(<div {...props} key="k" title={title} />);
    const node = document.getElementById("spread")!;
    expect(node.title).toBe("first");
    act(() => {
      title.value = "second";
    });
    expect(node.title).toBe("second");
  });

  it("keeps key semantics and normalizes signal children", () => {
    const label = signal("a");
    function List({ items }: { items: Array<{ id: string; text: string }> }) {
      return (
        <ul>
          {items.map((item) => {
            const rest = { "data-id": item.id };
            return <li {...rest} key={item.id}>{item.text}{label}</li>;
          })}
        </ul>
      );
    }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<List items={[{ id: "1", text: "x" }, { id: "2", text: "y" }]} />);
    const first = view.container.querySelector('[data-id="1"]');
    view.rerender(<List items={[{ id: "2", text: "y" }, { id: "1", text: "x" }]} />);
    // Same keyed node, moved rather than recreated.
    expect(view.container.querySelector('[data-id="1"]')).toBe(first);
    act(() => {
      label.value = "b";
    });
    expect(view.container.textContent).toBe("ybxb");
    expect(errors).not.toHaveBeenCalled();
  });

  it("is the classic signature for direct calls", () => {
    const text = signal("hello");
    render(createElement("p", { id: "direct" }, text));
    expect(document.getElementById("direct")!.textContent).toBe("hello");
    act(() => {
      text.value = "bye";
    });
    expect(document.getElementById("direct")!.textContent).toBe("bye");
  });
});

describe("bare render scope does not leak into synchronous reads (B2)", () => {
  it("lets a descendant layout effect read, write, and re-read a computed", () => {
    const x = signal(1);
    const xc = computed(() => x.value * 10);
    const seen: number[] = [];
    function Child() {
      useLayoutEffect(() => {
        void xc.value;
        x.value = 2;
        seen.push(xc.value);
      }, []);
      return null;
    }
    function Parent() {
      useSignalTracking();
      return <Child />;
    }
    render(<Parent />);
    expect(seen).toEqual([20]);
  });

  it("lets a descendant ref callback do the same", () => {
    const x = signal(1);
    const xc = computed(() => x.value * 10);
    const seen: number[] = [];
    function Parent() {
      useSignalTracking();
      return (
        <div
          ref={() => {
            void xc.value;
            x.value = 3;
            seen.push(xc.value);
          }}
        />
      );
    }
    render(<Parent />);
    expect(seen).toEqual([30]);
  });

  it("does not reuse render-attempt state after renderToString", () => {
    const x = signal(1);
    const xc = computed(() => x.value);
    function Tracked() {
      useSignalTracking();
      return <p>{xc.value}</p>;
    }
    expect(renderToString(<Tracked />)).toContain("1");
    void xc.value;
    x.value = 5;
    expect(xc.value).toBe(5);
  });

  it("still re-renders the tracked component itself", () => {
    const x = signal(1);
    const xc = computed(() => x.value * 2);
    let renders = 0;
    function Tracked() {
      useSignalTracking();
      renders += 1;
      return <p data-testid="tracked">{String(xc.value)}</p>;
    }
    render(<Tracked />);
    act(() => {
      x.value = 2;
    });
    expect(screen.getByTestId("tracked").textContent).toBe("4");
    expect(renders).toBe(2);
  });
});

describe("host identity across signal/plain prop transitions (J1)", () => {
  it("does not remount a host or its children when a prop switches between a signal and a plain value", () => {
    const title = signal("signal title");
    const mounts = vi.fn();
    function Child() {
      useEffect(() => {
        mounts();
      }, []);
      return <input data-testid="field" />;
    }
    function Host({ useSignal }: { useSignal: boolean }) {
      return (
        <div data-testid="host" title={useSignal ? title : "plain"}>
          <Child />
        </div>
      );
    }
    const view = render(<Host useSignal />);
    const host = screen.getByTestId("host");
    const field = screen.getByTestId("field") as HTMLInputElement;
    field.value = "typed";
    field.focus();
    expect(host.title).toBe("signal title");

    view.rerender(<Host useSignal={false} />);
    expect(screen.getByTestId("host")).toBe(host);
    expect(host.title).toBe("plain");
    act(() => {
      title.value = "ignored";
    });
    expect(host.title).toBe("plain");

    view.rerender(<Host useSignal />);
    expect(screen.getByTestId("host")).toBe(host);
    expect(host.title).toBe("ignored");
    act(() => {
      title.value = "live again";
    });
    expect(host.title).toBe("live again");

    expect(mounts).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("field")).toBe(field);
    expect(field.value).toBe("typed");
    expect(document.activeElement).toBe(field);
  });

  it("keeps a spread key on the host element when it has signal props", () => {
    const selected = signal("on");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    function Rows({ ids }: { ids: string[] }) {
      return (
        <ul>
          {/* The key deliberately arrives through the spread. */}
          {/* oxlint-disable-next-line react/jsx-key */}
          {ids.map((id) => {
            const props = { key: id, "data-id": id };
            return <li {...props} className={selected} />;
          })}
        </ul>
      );
    }
    const view = render(<Rows ids={["a", "b"]} />);
    const a = view.container.querySelector('[data-id="a"]');
    view.rerender(<Rows ids={["b", "a"]} />);
    expect(view.container.querySelector('[data-id="a"]')).toBe(a);
    // React's own spread-key warning is expected; the missing-key one is not.
    expect(errors.mock.calls.some((call) => String(call[0]).includes("unique \"key\""))).toBe(false);
  });

  it("forwards a stable user ref once, not on every unrelated re-render", () => {
    const title = signal("t");
    const ref = vi.fn();
    function Host({ count }: { count: number }) {
      return <div title={title} ref={ref} data-count={count} />;
    }
    const view = render(<Host count={0} />);
    view.rerender(<Host count={1} />);
    view.rerender(<Host count={2} />);
    expect(ref.mock.calls.filter(([node]) => node !== null)).toHaveLength(1);
    const objectRef = createRef<HTMLDivElement>();
    function ObjectHost({ count }: { count: number }) {
      return <div title={title} ref={objectRef} data-count={count} />;
    }
    const second = render(<ObjectHost count={0} />);
    second.rerender(<ObjectHost count={1} />);
    expect(objectRef.current).toBeInstanceOf(HTMLDivElement);
    second.unmount();
    expect(objectRef.current).toBeNull();
  });
});

describe("form reset keeps bound value/checked in sync with the signal (J2)", () => {
  it("restores the signal's value on form.reset()", () => {
    const text = signal("init");
    const checked = signal(false);
    render(
      <form data-testid="form">
        <input data-testid="text" value={text} onChange={(event) => { text.value = event.currentTarget.value; }} />
        <input data-testid="box" type="checkbox" checked={checked} onChange={(event) => { checked.value = event.currentTarget.checked; }} />
      </form>,
    );
    const input = screen.getByTestId("text") as HTMLInputElement;
    const box = screen.getByTestId("box") as HTMLInputElement;
    act(() => {
      text.value = "typed";
      checked.value = true;
    });
    (screen.getByTestId("form") as HTMLFormElement).reset();
    expect(input.value).toBe("typed");
    expect(box.checked).toBe(true);
    expect(text.value).toBe("typed");
  });

  it("restores the signal's value after React 19's automatic reset following a form action", async () => {
    const text = signal("init");
    const select = signal("b");
    render(
      <form data-testid="form" action={async () => {}}>
        <input data-testid="text" name="text" value={text} onChange={(event) => { text.value = event.currentTarget.value; }} />
        <select data-testid="select" name="select" value={select} onChange={(event) => { select.value = event.currentTarget.value; }}>
          <option value="a">a</option>
          <option value="b">b</option>
        </select>
        <button type="submit">go</button>
      </form>,
    );
    act(() => {
      text.value = "typed";
      select.value = "a";
    });
    await act(async () => {
      (screen.getByTestId("form") as HTMLFormElement).requestSubmit();
    });
    expect((screen.getByTestId("text") as HTMLInputElement).value).toBe("typed");
    expect((screen.getByTestId("select") as HTMLSelectElement).value).toBe("a");
  });
});

describe("deep signals in host style positions (J3)", () => {
  it("does not let React freeze a deep signal's state through style", () => {
    const style = deepSignal({ color: "red" });
    // `style` is typed against root-only readables; the runtime still has to
    // stay safe for untyped callers.
    render(<div data-testid="styled" style={style as never} />);
    expect(Object.isFrozen(style.peek())).toBe(false);
    act(() => {
      style.value = { color: "blue" };
    });
    expect((screen.getByTestId("styled") as HTMLElement).style.color).toBe("blue");
    expect(() => style.value.color).not.toThrow();
  });
});

describe("signal arrays as children", () => {
  it("does not trigger React's missing-key warning", () => {
    const a = signal("a");
    const b = signal("b");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<p>{[a, b]}</p>);
    expect(view.container.textContent).toBe("ab");
    act(() => {
      b.value = "c";
    });
    expect(view.container.textContent).toBe("ac");
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("library-internal effects stay detached from user effects", () => {
  it("keeps a useSignalEffect alive when its commit runs inside a user effect", () => {
    const outer = signal(0);
    const watched = signal(0);
    const seen: number[] = [];
    let show: ((value: boolean) => void) | undefined;
    function Watcher() {
      useSignalEffect(() => {
        seen.push(watched.value);
      });
      return null;
    }
    function App() {
      const [visible, setVisible] = useState(false);
      show = setVisible;
      return visible ? <Watcher /> : null;
    }
    render(<App />);
    const stop = effect(() => {
      if (outer.value === 1) flushSync(() => show?.(true));
    });
    act(() => {
      outer.value = 1;
    });
    expect(seen).toEqual([0]);
    act(() => {
      outer.value = 2;
    });
    act(() => {
      watched.value = 1;
    });
    expect(seen).toEqual([0, 1]);
    stop();
  });

  it("keeps a direct binding alive across a transition commit inside a user effect", () => {
    const outer = signal(0);
    const title = signal("t0");
    let show: ((value: boolean) => void) | undefined;
    function App() {
      const [visible, setVisible] = useState(false);
      show = setVisible;
      return visible ? <div data-testid="bound" title={title} /> : null;
    }
    render(<App />);
    const stop = effect(() => {
      if (outer.value === 1) flushSync(() => show?.(true));
    });
    act(() => {
      outer.value = 1;
    });
    act(() => {
      outer.value = 2;
      startTransition(() => {});
    });
    act(() => {
      title.value = "t1";
    });
    expect((screen.getByTestId("bound") as HTMLElement).title).toBe("t1");
    stop();
  });
});
