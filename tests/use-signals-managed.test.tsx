/** @jsxImportSource react-fine-grained-signals/jsx */
// @vitest-environment jsdom

import { StrictMode, Suspense, act, memo, useLayoutEffect } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computed, deepSignal, signal, useComputed, useSignalTracking } from "../src/index.js";
import { useManagedSignals, useSignalCapture } from "../src/react/use-signals.js";
import { hasActiveRenderCollector } from "../src/core/render-tracking.js";
import { executionContext } from "../src/core/execution-owner.js";
import { inspectDeepSignalMetadata } from "../src/core/deep-signal.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function managed<T>(renderBody: () => T): T {
  const scope = useManagedSignals();
  try {
    return renderBody();
  } finally {
    scope.finish();
  }
}

describe("managed useManagedSignals render scope", () => {
  it("exposes finish() without the abbreviated f() alias", () => {
    const api = vi.fn();

    function Probe() {
      const store = useManagedSignals();
      try {
        api(typeof store.finish, "f" in store);
        return null;
      } finally {
        store.finish();
      }
    }

    render(<Probe />);
    expect(api).toHaveBeenCalledWith("function", false);
  });

  it("closes synchronously in finally while retaining committed render dependencies", () => {
    const source = signal("before");
    const renders = vi.fn();

    function Reader() {
      return managed(() => {
        renders();
        return <output aria-label="managed shallow">{source.value}</output>;
      });
    }

    render(<Reader />);
    act(() => {
      source.value = "after";
    });
    expect(screen.getByLabelText("managed shallow").textContent).toBe("after");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("uses its own layout finish as a last-resort guard for a forgotten manual finish", () => {
    const source = signal("before");
    const renders = vi.fn();

    function MisusedManualBoundary() {
      useManagedSignals();
      renders();
      return <output aria-label="managed fallback finish">{source.value}</output>;
    }

    render(<MisusedManualBoundary />);
    expect(hasActiveRenderCollector()).toBe(false);
    act(() => {
      source.value = "after";
    });
    expect(screen.getByLabelText("managed fallback finish").textContent).toBe("after");
    expect(renders).toHaveBeenCalledTimes(2);
    expect(hasActiveRenderCollector()).toBe(false);
  });

  it("finishes a scope when render throws, without leaking its collector into a later root", () => {
    const abandoned = signal(0);
    const healthy = signal("healthy");
    const healthyRenders = vi.fn();

    function Throwing() {
      return managed(() => {
        abandoned.value;
        throw new Error("render failed");
      });
    }
    function Healthy() {
      return managed(() => {
        healthyRenders();
        return <output aria-label="healthy root">{healthy.value}</output>;
      });
    }

    expect(() => render(<Throwing />)).toThrow("render failed");
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

  it("discards dependencies captured by a suspended render attempt", async () => {
    const source = signal("before");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let suspended = true;
    const renders = vi.fn();

    function Reader() {
      return managed(() => {
        const value = source.value;
        renders(value);
        if (suspended) throw gate;
        return <output aria-label="suspense managed value">{value}</output>;
      });
    }

    render(
      <Suspense fallback={<output aria-label="managed fallback">loading</output>}>
        <Reader />
      </Suspense>,
    );
    expect(screen.getByLabelText("managed fallback").textContent).toBe("loading");

    // This is an abandoned attempt, so the write must not publish a stale
    // subscription. The retry reads the current value once the gate resolves.
    act(() => {
      source.value = "during suspension";
    });
    suspended = false;
    await act(async () => {
      release();
      await gate;
    });
    expect(screen.getByLabelText("suspense managed value").textContent).toBe("during suspension");
    expect(renders).toHaveBeenCalled();
  });

  it("keeps sibling and multiple-root collectors isolated", () => {
    const state = deepSignal({ left: "L", right: "R" });
    const firstRenders = vi.fn();
    const secondRenders = vi.fn();

    function First() {
      return managed(() => {
        firstRenders();
        return <output aria-label="managed first">{state.value.left}</output>;
      });
    }
    function Second() {
      return managed(() => {
        secondRenders();
        return <output aria-label="managed second">{state.value.right}</output>;
      });
    }

    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    render(<First />, { container: firstRoot });
    render(<Second />, { container: secondRoot });

    act(() => {
      state.value.left = "L2";
    });
    expect(firstRoot.textContent).toBe("L2");
    expect(secondRoot.textContent).toBe("R");
    expect(firstRenders).toHaveBeenCalledTimes(2);
    expect(secondRenders).toHaveBeenCalledTimes(1);
    act(() => {
      state.value.right = "R2";
    });
    expect(secondRoot.textContent).toBe("R2");
    expect(firstRenders).toHaveBeenCalledTimes(2);
    expect(secondRenders).toHaveBeenCalledTimes(2);
  });

  it("replaces dynamic dependencies collected by a managed render", () => {
    const state = deepSignal({ useFirst: true, first: "A", second: "B" });
    const renders = vi.fn();

    function Reader() {
      return managed(() => {
        renders();
        const value = state.value.useFirst ? state.value.first : state.value.second;
        return <output aria-label="managed branch">{value}</output>;
      });
    }

    render(<Reader />);
    act(() => {
      state.value.useFirst = false;
    });
    const rendersAfterSwitch = renders.mock.calls.length;
    act(() => {
      state.value.first = "stale";
    });
    expect(renders).toHaveBeenCalledTimes(rendersAfterSwitch);
    act(() => {
      state.value.second = "B2";
    });
    expect(screen.getByLabelText("managed branch").textContent).toBe("B2");
  });

  it("balances managed dependencies across StrictMode replay and unmount", () => {
    const source = signal(0);
    const renders = vi.fn();

    function Reader() {
      return managed(() => {
        renders();
        return <output aria-label="managed strict">{source.value}</output>;
      });
    }

    const view = render(
      <StrictMode>
        <Reader />
      </StrictMode>,
    );
    act(() => {
      source.value = 1;
    });
    expect(screen.getByLabelText("managed strict").textContent).toBe("1");
    view.unmount();
    const rendersAtUnmount = renders.mock.calls.length;
    act(() => {
      source.value = 2;
    });
    expect(renders).toHaveBeenCalledTimes(rendersAtUnmount);
  });

  it("re-renders a computed reader when a sibling layout effect writes before its commit", () => {
    const source = signal(1);
    const doubled = computed(() => source.value * 2);
    const renders = vi.fn();

    function Writer() {
      useLayoutEffect(() => {
        source.value = 2;
      }, []);
      return null;
    }

    function Reader() {
      return managed(() => {
        renders();
        return <output aria-label="managed computed race">{doubled.value}</output>;
      });
    }

    render(
      <>
        <Writer />
        <Reader />
      </>,
    );

    expect(screen.getByLabelText("managed computed race").textContent).toBe("4");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("does not loop forever reading a computed that returns a fresh array each evaluation", () => {
    const source = signal([1, 2, 3]);
    const doubled = computed(() => source.value.map((n) => n * 2));
    const renders = vi.fn();

    function Reader() {
      return managed(() => {
        renders();
        return <output aria-label="managed array computed">{doubled.value.join(",")}</output>;
      });
    }

    render(<Reader />);
    expect(screen.getByLabelText("managed array computed").textContent).toBe("2,4,6");
    act(() => {
      source.value = [4, 5];
    });
    expect(screen.getByLabelText("managed array computed").textContent).toBe("8,10");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("tracks deep properties read by a computed during its speculative render", () => {
    const state = deepSignal({ tasks: [{ done: false }] });
    const renders = vi.fn();

    function Reader() {
      const remaining = useComputed(() => state.value.tasks.filter((task) => !task.done).length, [state]);
      return managed(() => {
        renders();
        return <output aria-label="managed deep computed">{remaining.value}</output>;
      });
    }

    render(<Reader />);
    expect(screen.getByLabelText("managed deep computed").textContent).toBe("1");

    act(() => {
      state.value.tasks[0]!.done = true;
    });

    expect(screen.getByLabelText("managed deep computed").textContent).toBe("0");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("tracks signal reads made by a managed custom hook in its parent JSX", () => {
    const source = signal("before");

    function useManagedValue() {
      return managed(() => source.value);
    }

    function Parent() {
      return <output aria-label="managed custom hook">{useManagedValue()}</output>;
    }

    render(<Parent />);
    expect(screen.getByLabelText("managed custom hook").textContent).toBe("before");

    act(() => {
      source.value = "after";
    });

    expect(screen.getByLabelText("managed custom hook").textContent).toBe("after");
  });

  it("restores the outer collector across three nested managed scopes", () => {
    const outer = signal("outer-0");
    const middle = signal("middle-0");
    const inner = signal("inner-0");
    const renders = vi.fn();

    function useInnerValue() {
      return managed(() => inner.value);
    }

    function useMiddleValues() {
      return managed(() => `${middle.value}/${useInnerValue()}`);
    }

    function Reader() {
      return managed(() => {
        renders();
        const beforeNestedScope = outer.value;
        const nestedValues = useMiddleValues();
        const afterNestedScope = outer.value;
        return (
          <output aria-label="three nested scopes">{`${beforeNestedScope}/${nestedValues}/${afterNestedScope}`}</output>
        );
      });
    }

    render(<Reader />);
    expect(screen.getByLabelText("three nested scopes").textContent).toBe("outer-0/middle-0/inner-0/outer-0");
    expect(hasActiveRenderCollector()).toBe(false);

    for (const [source, next] of [
      [outer, "outer-1"],
      [middle, "middle-1"],
      [inner, "inner-1"],
    ] as const) {
      act(() => {
        source.value = next;
      });
      expect(screen.getByLabelText("three nested scopes").textContent).toContain(next);
      expect(hasActiveRenderCollector()).toBe(false);
    }
    expect(renders).toHaveBeenCalledTimes(4);
  });

  it("does not absorb a memoized child's read into its finished managed parent scope", () => {
    const parentState = signal(0);
    const childState = signal("A");
    const parentRenders = vi.fn();
    const childRenders = vi.fn();

    const Child = memo(function Child() {
      childRenders();
      return <output aria-label="memoized managed child">{childState.value}</output>;
    });

    function Parent() {
      return managed(() => {
        parentRenders();
        void parentState.value;
        return <Child />;
      });
    }

    render(<Parent />);
    expect(screen.getByLabelText("memoized managed child").textContent).toBe("A");

    act(() => {
      childState.value = "B";
    });

    // The managed parent finished before React invoked Child. Its untracked
    // read must not schedule Parent; this asserts isolation, not an implicit
    // subscription for a child that did not open its own scope.
    expect(parentRenders).toHaveBeenCalledTimes(1);
    expect(childRenders).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("memoized managed child").textContent).toBe("A");
  });

  it("keeps the innermost bare render owner active after the managed parent closes", () => {
    const beforeBare = signal("managed");
    const insideBare = signal("bare");
    const afterBare = signal("still bare");
    const renders = vi.fn();
    let owners: { managed: object; bare: object; afterManagedClose: object | undefined } | undefined;

    function Reader() {
      const managedScope = useManagedSignals();
      const managedOwner = executionContext.owner! as object;
      renders();
      const first = beforeBare.value;

      useSignalTracking();
      const bareOwner = executionContext.owner! as object;
      const middle = insideBare.value;
      const last = afterBare.value;

      try {
        return <output aria-label="managed then bare">{`${first}/${middle}/${last}`}</output>;
      } finally {
        managedScope.finish();
        owners = {
          managed: managedOwner,
          bare: bareOwner,
          afterManagedClose: executionContext.owner as object | undefined,
        };
      }
    }

    render(<Reader />);
    expect(owners?.afterManagedClose).toBe(owners?.bare);
    expect(owners?.managed).not.toBe(owners?.bare);
    expect(screen.getByLabelText("managed then bare").textContent).toBe("managed/bare/still bare");

    act(() => {
      beforeBare.value = "managed updated";
    });
    expect(renders).toHaveBeenCalledTimes(2);
    act(() => {
      insideBare.value = "bare updated";
    });
    expect(renders).toHaveBeenCalledTimes(3);
    act(() => {
      afterBare.value = "still bare updated";
    });
    expect(renders).toHaveBeenCalledTimes(4);
  });

  it("restores the component's own bare parent after a nested managed scope finishes", () => {
    const beforeManaged = signal("bare");
    const insideManaged = signal("managed");
    const afterManaged = signal("bare again");
    const renders = vi.fn();
    let owners: { bare: object; managed: object; ownerAfterManaged: object | undefined } | undefined;

    function Reader() {
      useSignalTracking();
      const bareOwner = executionContext.owner! as object;
      renders();
      const first = beforeManaged.value;

      const managedScope = useManagedSignals();
      const managedOwner = executionContext.owner! as object;
      let middle: string;
      let ownerAfterManaged: object | undefined;
      try {
        middle = insideManaged.value;
      } finally {
        managedScope.finish();
        ownerAfterManaged = executionContext.owner as object | undefined;
      }
      const last = afterManaged.value;
      owners = { bare: bareOwner, managed: managedOwner, ownerAfterManaged };
      return <output aria-label="bare then managed">{`${first}/${middle}/${last}`}</output>;
    }

    render(<Reader />);
    expect(owners?.ownerAfterManaged).toBe(owners?.bare);
    expect(owners?.bare).not.toBe(owners?.managed);
    expect(screen.getByLabelText("bare then managed").textContent).toBe("bare/managed/bare again");

    act(() => {
      beforeManaged.value = "bare updated";
    });
    expect(renders).toHaveBeenCalledTimes(2);
    act(() => {
      insideManaged.value = "managed updated";
    });
    expect(renders).toHaveBeenCalledTimes(3);
    act(() => {
      afterManaged.value = "bare resumed";
    });
    expect(renders).toHaveBeenCalledTimes(4);
    expect(screen.getByLabelText("bare then managed").textContent).toBe("bare updated/managed updated/bare resumed");
  });

  it("keeps a useSignalTracking() window open across a capture hook", () => {
    const count = signal(1);
    const other = signal("o0");
    function useCount() {
      const c = useSignalCapture();
      return c.capture(() => count.value);
    }
    function Comp() {
      useSignalTracking();
      const n = useCount();
      return (
        <b aria-label="capture hook">
          {n}:{other.value}
        </b>
      );
    }
    render(<Comp />);
    expect(screen.getByLabelText("capture hook").textContent).toBe("1:o0");
    act(() => {
      other.value = "o1";
    });
    expect(screen.getByLabelText("capture hook").textContent).toBe("1:o1");
    act(() => {
      count.value = 2;
    });
    expect(screen.getByLabelText("capture hook").textContent).toBe("2:o1");
  });

  it("keeps deep-proxy reads after a capture hook tracked in a useSignalTracking() row", () => {
    const task = deepSignal({ done: false });
    const theme = signal("light");
    function useTheme() {
      const c = useSignalCapture();
      return c.capture(() => theme.value);
    }
    function Row({ item }: { item: { done: boolean } }) {
      useSignalTracking();
      const t = useTheme();
      return (
        <i aria-label="row">
          {t}:{item.done ? "done" : "todo"}
        </i>
      );
    }
    render(<Row item={task.value} />);
    expect(screen.getByLabelText("row").textContent).toBe("light:todo");
    act(() => {
      task.value.done = true;
    });
    expect(screen.getByLabelText("row").textContent).toBe("light:done");
  });

  it("keeps a useSignalTracking() window open across a hand-written managed hook", () => {
    const count = signal(1);
    const other = signal("o0");
    function useCount() {
      const scope = useManagedSignals();
      try {
        return count.value;
      } finally {
        scope.finish();
      }
    }
    function Comp() {
      useSignalTracking();
      const n = useCount();
      return (
        <b aria-label="managed hook">
          {n}:{other.value}
        </b>
      );
    }
    render(<Comp />);
    act(() => {
      other.value = "o1";
    });
    expect(screen.getByLabelText("managed hook").textContent).toBe("1:o1");
  });

  // React exposes no component identity, so a capture cannot tell a previous
  // sibling's still-open bare window from its own component's window. It
  // suspends either one rather than closing it (closing the component's own
  // window loses its later reads). A leftover sibling window can therefore
  // collect an uncaptured read: at most an extra sibling render, never stale UI.
  it("lets a previous sibling's bare window over-collect past a nested capture hook without going stale", () => {
    const own = signal("a");
    const hidden = signal("h");
    const siblingRenders = vi.fn();
    function Sibling() {
      useSignalTracking();
      siblingRenders();
      return <span>{own.value}</span>;
    }
    function useCaptured() {
      const c = useSignalCapture();
      return c.capture(() => 1);
    }
    function Capturing() {
      const n = useCaptured();
      return (
        <span>
          {n}
          {hidden.value}
        </span>
      );
    }
    render(
      <>
        <Sibling />
        <Capturing />
      </>,
    );
    const before = siblingRenders.mock.calls.length;
    act(() => {
      hidden.value = "changed";
    });
    expect(siblingRenders.mock.calls.length).toBeLessThanOrEqual(before + 1);
    act(() => {
      own.value = "b";
    });
    expect(screen.getAllByText("b").length).toBeGreaterThan(0);
  });

  it("recovers the render collector after managed scopes close", () => {
    const state = deepSignal({ overlapped: "before" });

    function SelfOverlapping() {
      const store = useManagedSignals();
      try {
        return <output aria-label="self overlapping">{state.value.overlapped}</output>;
      } finally {
        store.finish();
      }
    }

    render(<SelfOverlapping />);
    expect(screen.getByLabelText("self overlapping").textContent).toBe("before");
    expect(hasActiveRenderCollector()).toBe(false);

    // The surviving scope is still the real one: this component keeps tracking.
    act(() => {
      state.value.overlapped = "after";
    });
    expect(screen.getByLabelText("self overlapping").textContent).toBe("after");
    expect(hasActiveRenderCollector()).toBe(false);

    // A later, ordinary start()/finish() cycle leaves the collector clean too,
    // rather than inheriting a leaked one.
    const untracked = deepSignal({ leaked: 0 });
    function Ordinary() {
      return managed(() => <output aria-label="ordinary">{untracked.value.leaked}</output>);
    }
    render(<Ordinary />);
    expect(hasActiveRenderCollector()).toBe(false);
    expect(inspectDeepSignalMetadata(untracked.peek())?.properties).toEqual(["leaked"]);

    // Nothing is collecting now, so a read outside a render mints no metadata.
    const idle = deepSignal({ a: 1, b: 2 });
    idle.value.a;
    idle.value.b;
    expect(inspectDeepSignalMetadata(idle.peek())?.properties).toEqual([]);
  });
});

describe("useSignalCapture iterate", () => {
  it("tracks reads in the source, built-in steps, and custom next/done/value/return getters", () => {
    const list = signal(["a"]);
    const limit = signal(1);
    const prefix = signal("p");
    const nextTag = signal(0);
    const closeTag = signal(0);
    const custom = {
      [Symbol.iterator]() {
        let index = 0;
        return {
          get next() {
            void nextTag.value;
            return () => {
              const step = ++index;
              return {
                get done() {
                  return step > limit.value;
                },
                get value() {
                  return prefix.value + step;
                },
              };
            };
          },
          get return() {
            void closeTag.value;
            return () => ({ done: true, value: undefined });
          },
        };
      },
    };
    const renders = vi.fn();
    function Reader() {
      const scope = useSignalCapture();
      renders();
      let out = "";
      for (const item of scope.iterate(() => list.value)) out += item;
      for (const item of scope.iterate(() => custom)) out += item;
      for (const item of scope.iterate(() => custom)) {
        out += `|${item}`;
        break;
      }
      return <output aria-label="iterated">{out}</output>;
    }
    render(<Reader />);
    const read = () => screen.getByLabelText("iterated").textContent;
    expect(read()).toBe("ap1|p1");
    act(() => {
      list.value = ["a", "b"];
    });
    expect(read()).toBe("abp1|p1");
    act(() => {
      limit.value = 2;
    });
    expect(read()).toBe("abp1p2|p1");
    act(() => {
      prefix.value = "q";
    });
    expect(read()).toBe("abq1q2|q1");
    const before = renders.mock.calls.length;
    act(() => {
      nextTag.value = 1;
    });
    act(() => {
      closeTag.value = 1;
    });
    expect(renders.mock.calls.length).toBe(before + 2);
  });

  it("tracks getter reads on results a generator delegates with yield*", () => {
    const tag = signal("a");
    const custom = {
      [Symbol.iterator]() {
        let step = 0;
        return {
          next: () => {
            step += 1;
            return {
              done: false,
              get value() {
                return tag.value + step;
              },
            };
          },
        };
      },
    };
    function* delegate() {
      yield* custom;
    }
    function Reader() {
      const scope = useSignalCapture();
      let out = "";
      for (const item of scope.iterate(() => delegate())) {
        out += item;
        break;
      }
      return <output aria-label="delegated">{out}</output>;
    }
    render(<Reader />);
    expect(screen.getByLabelText("delegated").textContent).toBe("a1");
    act(() => {
      tag.value = "b";
    });
    expect(screen.getByLabelText("delegated").textContent).toBe("b1");
  });

  it("keeps a capture-only component fresh when a sibling's bare scope is still open", () => {
    const own = signal("a");
    const hidden = signal("h");
    const siblingRenders = vi.fn();
    function Sibling() {
      useSignalTracking();
      siblingRenders();
      return <span>{own.value}</span>;
    }
    function Capturing() {
      useSignalCapture();
      // A read the transform could not capture.
      return <span>{hidden.value}</span>;
    }
    render(
      <>
        <Sibling />
        <Capturing />
      </>,
    );
    const before = siblingRenders.mock.calls.length;
    act(() => {
      hidden.value = "changed";
    });
    expect(siblingRenders.mock.calls.length).toBeLessThanOrEqual(before + 1);
    act(() => {
      own.value = "b";
    });
    expect(screen.getAllByText("b").length).toBeGreaterThan(0);
  });

  it("matches native errors and closing for malformed iterators", () => {
    let scope!: ReturnType<typeof useSignalCapture>;
    function Holder() {
      scope = useSignalCapture();
      return null;
    }
    render(<Holder />);
    const loop = (iterable: unknown) => {
      const seen: unknown[] = [];
      for (const item of scope.iterate(() => iterable as Iterable<unknown>)) {
        seen.push(item);
        break;
      }
      return seen;
    };
    expect(() => loop({ [Symbol.iterator]: () => 1 })).toThrow(TypeError);
    expect(() => loop({ [Symbol.iterator]: () => ({ next: () => 1 }) })).toThrow(TypeError);
    // No `return` method: breaking out simply stops.
    expect(loop({ [Symbol.iterator]: () => ({ next: () => ({ done: false, value: 7 }) }) })).toEqual([7]);
    expect(() =>
      loop({ [Symbol.iterator]: () => ({ next: () => ({ done: false, value: 1 }), return: () => 1 }) }),
    ).toThrow(TypeError);
  });

  it("throws a native-style TypeError for a source that is not iterable", () => {
    let scope!: ReturnType<typeof useSignalCapture>;
    function Holder() {
      scope = useSignalCapture();
      return null;
    }
    render(<Holder />);
    const loop = (iterable: unknown) => {
      for (const _ of scope.iterate(() => iterable as Iterable<unknown>)) void _;
    };
    expect(() => loop({})).toThrow(/object is not iterable/);
    expect(() => loop(undefined)).toThrow(/undefined is not iterable/);
    expect(() => loop(5)).toThrow(/5 is not iterable/);
  });
});

describe("useSignalCapture forIn", () => {
  it("tracks key enumeration, keeps inherited keys, and skips keys deleted before their turn", () => {
    const state = deepSignal({ errors: { a: 1 } as Record<string, number> });
    function Reader() {
      const scope = useSignalCapture();
      const keys: string[] = [];
      for (const key of scope.forIn(() => state.value.errors)) keys.push(key);
      const proto = { inherited: 1 };
      const object: Record<string, number> = Object.create(proto);
      object.a = 1;
      object.b = 2;
      object.c = 3;
      const seen: string[] = [];
      for (const key of scope.forIn(() => object)) {
        seen.push(key);
        if (key === "a") delete object.b;
      }
      for (const key of scope.forIn(() => null)) seen.push(key);
      for (const key of scope.forIn(() => "ab")) seen.push(key);
      return <output aria-label="keys">{keys.join(",") + "|" + seen.join(",")}</output>;
    }
    render(<Reader />);
    const read = () => screen.getByLabelText("keys").textContent;
    expect(read()).toBe("a|a,c,inherited,0,1");
    act(() => {
      state.value.errors.x = 1;
    });
    expect(read()).toBe("a,x|a,c,inherited,0,1");
  });
});

describe("useSignalCapture forIn matches the native loop's trap calls", () => {
  // A Proxy over an object whose prototype is also a Proxy: every trap the
  // engine calls during enumeration lands in the log, in order.
  function logged(log: string[], throwOn?: string): Record<string, number> {
    const traps = (prefix: string, throwKey?: string): ProxyHandler<object> => ({
      ownKeys(target) {
        log.push(`${prefix}ownKeys`);
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        log.push(`${prefix}gOPD ${String(key)}`);
        if (key === throwKey) throw new Error(`gOPD ${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf(target) {
        log.push(`${prefix}getPrototypeOf`);
        return Reflect.getPrototypeOf(target);
      },
      has(target, key) {
        log.push(`${prefix}has ${String(key)}`);
        return Reflect.has(target, key);
      },
      deleteProperty(target, key) {
        log.push(`${prefix}delete ${String(key)}`);
        return Reflect.deleteProperty(target, key);
      },
    });
    const proto = new Proxy({ p: 1 }, traps("proto."));
    const base = Object.create(proto) as Record<string, number>;
    base.a = 1;
    base.b = 2;
    base.c = 3;
    return new Proxy(base, traps("", throwOn)) as Record<string, number>;
  }
  type Loop = (
    keys: (object: Record<string, number>) => Iterable<string>,
    object: Record<string, number>,
    out: string[],
  ) => void;
  const loops: Record<string, Loop> = {
    all: (keys, object, out) => {
      for (const key of keys(object)) out.push(key);
    },
    breakFirst: (keys, object, out) => {
      for (const key of keys(object)) {
        out.push(key);
        break;
      }
    },
    deleteAhead: (keys, object, out) => {
      for (const key of keys(object)) {
        out.push(key);
        if (key === "a") delete object.b;
      }
    },
    continueThenThrow: (keys, object, out) => {
      for (const key of keys(object)) {
        if (key === "a") continue;
        out.push(key);
        if (key === "c") throw new Error("body");
      }
    },
  };
  // The same loops written with `for...in`.
  const native: Record<string, (object: Record<string, number>, out: string[]) => void> = {
    all: (object, out) => {
      for (const key in object) out.push(key);
    },
    breakFirst: (object, out) => {
      for (const key in object) {
        out.push(key);
        break;
      }
    },
    deleteAhead: (object, out) => {
      for (const key in object) {
        out.push(key);
        if (key === "a") delete object.b;
      }
    },
    continueThenThrow: (object, out) => {
      for (const key in object) {
        if (key === "a") continue;
        out.push(key);
        if (key === "c") throw new Error("body");
      }
    },
  };
  const outcome = (run: (object: Record<string, number>, out: string[]) => void, throwOn?: string) => {
    const log: string[] = [];
    const out: string[] = [];
    let error: string | undefined;
    try {
      run(logged(log, throwOn), out);
    } catch (caught) {
      error = (caught as Error).message;
    }
    return { out, error, log };
  };

  it.each(
    Object.keys(loops).flatMap(
      (name) =>
        [
          [name, undefined],
          [name, "b"],
        ] as Array<[string, string | undefined]>,
    ),
  )("%s (getOwnPropertyDescriptor throws on: %s)", (name, throwOn) => {
    let scope!: ReturnType<typeof useSignalCapture>;
    function Holder() {
      scope = useSignalCapture();
      return null;
    }
    render(<Holder />);
    const captured = outcome(
      (object, out) => loops[name]!((source) => scope.forIn(() => source), object, out),
      throwOn,
    );
    expect(captured).toEqual(outcome(native[name]!, throwOn));
  });
});

describe("per-read useSignalCapture prototype", () => {
  it("tracks shallow and deep reads while restoring the render context after each capture", () => {
    const shallow = signal("before");
    const deep = deepSignal({ profile: { name: "Ada" } });
    const renders = vi.fn();

    function Reader() {
      const scope = useSignalCapture();
      renders();
      const shallowValue = scope.capture(() => shallow.value);
      const deepValue = scope.capture(() => deep.value.profile.name);
      expect(hasActiveRenderCollector()).toBe(false);
      return <output aria-label="per read values">{`${shallowValue}/${deepValue}`}</output>;
    }

    render(<Reader />);
    act(() => {
      shallow.value = "after";
      deep.value.profile.name = "Grace";
    });
    expect(screen.getByLabelText("per read values").textContent).toBe("after/Grace");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("restores the render context synchronously when a captured read throws", () => {
    const abandoned = signal("abandoned");
    const healthy = signal("healthy");
    const healthyRenders = vi.fn();

    function Throwing() {
      const scope = useSignalCapture();
      scope.capture(() => {
        abandoned.value;
        throw new Error("capture failed");
      });
      return null;
    }
    function Healthy() {
      const scope = useSignalCapture();
      healthyRenders();
      return <output aria-label="capture healthy">{scope.capture(() => healthy.value)}</output>;
    }

    expect(() => render(<Throwing />)).toThrow("capture failed");
    expect(hasActiveRenderCollector()).toBe(false);
    render(<Healthy />);
    act(() => {
      abandoned.value = "changed";
    });
    expect(healthyRenders).toHaveBeenCalledTimes(1);
    act(() => {
      healthy.value = "updated";
    });
    expect(screen.getByLabelText("capture healthy").textContent).toBe("updated");
  });

  it("does not collect reads made through a capture handle after commit", () => {
    const source = signal("render");
    const late = signal("late");
    const renders = vi.fn();
    let capture!: <T>(callback: () => T) => T;

    function Reader() {
      capture = useSignalCapture().capture;
      renders();
      return <output aria-label="capture after commit">{capture(() => source.value)}</output>;
    }

    render(<Reader />);
    const readAfterCommit = capture(() => late.value);
    expect(readAfterCommit).toBe("late");
    act(() => {
      late.value = "changed";
    });
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => {
      source.value = "updated";
    });
    expect(screen.getByLabelText("capture after commit").textContent).toBe("updated");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("keeps StrictMode capture subscriptions live through replay and disposes them on unmount", () => {
    const source = signal("strict mount");
    const renders = vi.fn();

    function Reader() {
      const capture = useSignalCapture();
      renders();
      return <output aria-label="strict capture">{capture.capture(() => source.value)}</output>;
    }

    const view = render(
      <StrictMode>
        <Reader />
      </StrictMode>,
    );
    expect(screen.getByLabelText("strict capture").textContent).toBe("strict mount");
    const mountedRenderCount = renders.mock.calls.length;
    act(() => {
      source.value = "strict update";
    });
    expect(screen.getByLabelText("strict capture").textContent).toBe("strict update");
    expect(renders.mock.calls.length).toBeGreaterThan(mountedRenderCount);

    view.unmount();
    const unmountedRenderCount = renders.mock.calls.length;
    act(() => {
      source.value = "after unmount";
    });
    expect(renders).toHaveBeenCalledTimes(unmountedRenderCount);
  });

  it("renders captured reads on the server without leaving an active collector", () => {
    const source = signal("server capture");

    function Reader() {
      const capture = useSignalCapture();
      return <output>{capture.capture(() => source.value)}</output>;
    }

    expect(renderToString(<Reader />)).toContain("server capture");
    expect(hasActiveRenderCollector()).toBe(false);
  });
});
