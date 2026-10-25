/** @jsxImportSource react-fine-grained-signals/jsx */
// @vitest-environment jsdom

import { Component, StrictMode, Suspense, act, startTransition, useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  batch,
  computed,
  signal,
  useComputed, useWritableComputed,
  useSignalValue,
  useSignalTracking,
} from "../src/index.js";
import type { FormBindableSignal, ReadonlySignal } from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("React leaf hooks (useSignalValue, useComputed)", () => {
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

  it("forwards a structural readable's background evaluation error to an Error Boundary", () => {
    const invalidation = signal(0);
    let shouldThrow = false;
    const structural = {
      get value(): string {
        void invalidation.value;
        if (shouldThrow) throw new Error("structural read failed");
        return "ready";
      },
    } as ReadonlySignal<string>;
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
          : <output aria-label="structural error">caught</output>;
      }
    }

    function Reader() {
      return <output aria-label="structural value">{useSignalValue(structural)}</output>;
    }

    render(<ErrorBoundary><Reader /></ErrorBoundary>);
    expect(screen.getByLabelText("structural value").textContent).toBe("ready");
    expect(() => {
      act(() => {
        shouldThrow = true;
        invalidation.value += 1;
      });
    }).not.toThrow();
    expect(screen.getByLabelText("structural error").textContent).toBe("caught");
    expect(reactError).toHaveBeenCalled();
  });

  it("does not add an explicit leaf subscription to an ancestor useSignalTracking scope", () => {
    const parentSource = signal("parent");
    const leafSource = signal("before");
    const parentRenders = vi.fn();
    const leafRenders = vi.fn();

    function Leaf() {
      leafRenders();
      return <span>{useSignalValue(leafSource)}</span>;
    }

    function Parent() {
      useSignalTracking();
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

  // These tests cover useSignalValue's per-component V1 subscription path. alien-signals
  // already dedupes a shared computed's evaluation across subscribers
  // (checkDirty/shallowPropagate), so sharing one watcher across leaves would
  // only trim notification overhead, not getter evaluations.
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

    // A live V1 watcher would dirty-check the computed synchronously on this
    // write even with nothing left to read its value. The unchanged call count
    // confirms the subscription was released.
    act(() => {
      source.value = 2;
    });
    expect(evaluate).toHaveBeenCalledTimes(evaluationsAtMount);
  });

  it("keeps a single useSignalValue subscription across unrelated re-renders", () => {
    const source = signal(1);
    const evaluate = vi.fn((value: number) => value * 2);
    const doubled = computed(() => evaluate(source.value));

    function Leaf({ tick }: { tick: number }) {
      const value = useSignalValue(doubled);
      return <output aria-label="stable subscription">{`${tick}:${value}`}</output>;
    }

    const view = render(<Leaf tick={0} />);
    expect(evaluate).toHaveBeenCalledTimes(1);

    // Re-rendering with an unrelated prop change must not tear down and
    // recreate the underlying subscription: `subscribe` is memoized on
    // `source` alone, so an unchanged source keeps the same watcher.
    view.rerender(<Leaf tick={1} />);
    view.rerender(<Leaf tick={2} />);
    expect(evaluate).toHaveBeenCalledTimes(1);

    act(() => {
      source.value = 5;
    });
    expect(screen.getByLabelText("stable subscription").textContent).toBe("2:10");
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("keeps structural readables on the compatibility subscription and releases it on unmount", () => {
    const backing = signal("before");
    const reads = vi.fn();
    const structural: ReadonlySignal<string> = {
      get value() {
        reads();
        return backing.value;
      },
      peek() {
        return backing.peek();
      },
    };

    function Reader({ version }: { version: number }) {
      return <output aria-label="structural readable">{`${version}:${useSignalValue(structural)}`}</output>;
    }

    const view = render(<Reader version={1} />);
    expect(screen.getByLabelText("structural readable").textContent).toBe("1:before");
    expect(reads).toHaveBeenCalled();

    act(() => {
      backing.value = "after";
    });
    expect(screen.getByLabelText("structural readable").textContent).toBe("1:after");

    view.rerender(<Reader version={2} />);
    expect(screen.getByLabelText("structural readable").textContent).toBe("2:after");

    view.unmount();
    const readsAfterUnmount = reads.mock.calls.length;
    act(() => {
      backing.value = "ignored";
    });
    expect(reads).toHaveBeenCalledTimes(readsAfterUnmount);
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

  it.each([
    { label: "getter grows", writable: false, before: [2], after: [2, 3] },
    { label: "getter shrinks", writable: false, before: [2, 3], after: [2] },
    { label: "getter grows from empty", writable: false, before: [], after: [2] },
    { label: "getter shrinks to empty", writable: false, before: [2], after: [] },
    { label: "writable getter grows", writable: true, before: [2], after: [2, 3] },
    { label: "writable getter shrinks", writable: true, before: [2, 3], after: [2] },
    { label: "writable getter grows from empty", writable: true, before: [], after: [2] },
    { label: "writable getter shrinks to empty", writable: true, before: [2], after: [] },
  ])("rejects a useComputed dependency length change ($label)", ({ writable, before, after }) => {
    const source = signal(1);
    function ReadonlyProduct({ b, dependencies }: { b: number; dependencies: number[] }) {
      const product = useComputed(() => source.value * 2 + b, dependencies);
      return <output aria-label="length guarded computed">{useSignalValue(product)}</output>;
    }
    function WritableProduct({ b, dependencies }: { b: number; dependencies: number[] }) {
      const product = useWritableComputed({
        get: () => source.value * 2 + b,
        set: (next: number) => { source.value = (next - b) / 2; },
      }, dependencies);
      return <output aria-label="length guarded computed">{useSignalValue(product)}</output>;
    }

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const initialB = before.length === 2 ? 3 : 0;
    const nextB = after.length === 2 ? 3 : 0;
    const Product = writable ? WritableProduct : ReadonlyProduct;
    const view = render(<Product b={initialB} dependencies={before} />);
    expect(screen.getByLabelText("length guarded computed").textContent).toBe(String(2 + initialB));
    expect(() => view.rerender(<Product b={nextB} dependencies={after} />)).toThrow(
      /dependencies length changed/,
    );
    errorSpy.mockRestore();
  });

  it("keeps a writable useComputed stable and forwards writes to its setter", () => {
    const source = signal(2);
    let writable: FormBindableSignal<number> | undefined;
    const renders = vi.fn();

    function Writable({ label }: { label: string }) {
      renders();
      writable = useWritableComputed({
        get: () => source.value * 2,
        set: (next) => { source.value = next / 2; },
      });
      return <output aria-label="writable computed" data-label={label}>{useSignalValue(writable)}</output>;
    }

    const view = render(<Writable label="first" />);
    const initial = writable;
    expect(screen.getByLabelText("writable computed").textContent).toBe("4");
    view.rerender(<Writable label="second" />);
    expect(writable).toBe(initial);

    act(() => { writable!.value = 10; });
    expect(source.value).toBe(5);
    expect(screen.getByLabelText("writable computed").textContent).toBe("10");
  });

  it("updates writable useComputed getter and setter together when dependencies change", () => {
    const source = signal(2);
    let writable: FormBindableSignal<number> | undefined;

    function Product({ factor }: { factor: number }) {
      writable = useWritableComputed({
        get: () => source.value * factor,
        set: (next) => { source.value = next / factor; },
      }, [factor]);
      return <output aria-label="writable product">{useSignalValue(writable)}</output>;
    }

    const view = render(<Product factor={2} />);
    const first = writable;
    expect(screen.getByLabelText("writable product").textContent).toBe("4");

    view.rerender(<Product factor={4} />);
    expect(writable).not.toBe(first);
    expect(screen.getByLabelText("writable product").textContent).toBe("8");

    act(() => { writable!.value = 20; });
    expect(source.value).toBe(5);
    expect(screen.getByLabelText("writable product").textContent).toBe("20");
  });

  it("does not let a suspended useComputed render replace the committed getter or setter", async () => {
    const source = signal(2);
    const suspendRenders = vi.fn();
    let releaseSuspense!: () => void;
    const pending = new Promise<void>((resolve) => { releaseSuspense = resolve; });
    let canShowFive = false;
    let committed: FormBindableSignal<number> | undefined;

    function Product({ factor }: { factor: number }) {
      const product = useWritableComputed({
        get: () => source.value * factor,
        set: (next) => { source.value = next / factor; },
      }, [factor]);
      useLayoutEffect(() => { committed = product; }, [product]);
      if (factor === 5 && !canShowFive) {
        suspendRenders();
        throw pending;
      }
      return <output aria-label="suspended product">{useSignalValue(product)}</output>;
    }

    function App() {
      const [factor, setFactor] = useState(2);
      return <>
        <button onClick={() => startTransition(() => setFactor(5))}>change factor</button>
        <Suspense fallback={<span>loading</span>}><Product factor={factor} /></Suspense>
      </>;
    }

    render(<App />);
    const oldCommitted = committed;
    expect(screen.getByLabelText("suspended product").textContent).toBe("4");

    await act(async () => {
      screen.getByText("change factor").click();
      await Promise.resolve();
    });
    expect(suspendRenders).toHaveBeenCalled();
    expect(committed).toBe(oldCommitted);

    act(() => { committed!.value = 20; });
    expect(source.value).toBe(10);
    expect(screen.getByLabelText("suspended product").textContent).toBe("20");

    canShowFive = true;
    await act(async () => { releaseSuspense(); await Promise.resolve(); });
    expect(screen.getByLabelText("suspended product").textContent).toBe("50");
    act(() => { committed!.value = 100; });
    expect(source.value).toBe(20);
    expect(screen.getByLabelText("suspended product").textContent).toBe("100");
  });

  it("batches source notifications made by a writable useComputed setter", () => {
    const left = signal(1);
    const right = signal(2);
    const renders = vi.fn();

    let total: FormBindableSignal<number> | undefined;
    function Capture() {
      total = useWritableComputed({
        get: () => left.value + right.value,
        set: (next) => batch(() => {
          left.value = next / 2;
          right.value = next / 2;
        }),
      });
      renders();
      return <output aria-label="writable total">{useSignalValue(total)}</output>;
    }

    render(<Capture />);
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => { total!.value = 10; });
    expect(left.value).toBe(5);
    expect(right.value).toBe(5);
    expect(renders).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("writable total").textContent).toBe("10");
  });

  it("reports a useComputed dependency length change instead of crashing obscurely", () => {
    const source = signal(2);

    function Switcher({ dependencies }: { dependencies: readonly unknown[] | undefined }) {
      const value = useComputed(() => source.value * 2, dependencies as unknown[] | undefined);
      return <output aria-label="switcher">{useSignalValue(value)}</output>;
    }

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<Switcher dependencies={undefined} />);
    expect(screen.getByLabelText("switcher").textContent).toBe("4");
    expect(() => view.rerender(<Switcher dependencies={[source]} />)).toThrow(
      /dependencies length changed from 0 to 1/,
    );
    errorSpy.mockRestore();

    const reverseErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reverse = render(<Switcher dependencies={[source]} />);
    expect(() => reverse.rerender(<Switcher dependencies={undefined} />)).toThrow(
      /dependencies length changed from 1 to 0/,
    );
    reverseErrorSpy.mockRestore();
  });

  it.each([
    { label: "omitted to empty", before: undefined, after: [] },
    { label: "empty to omitted", before: [], after: undefined },
  ])("treats omitted and empty dependencies of useComputed as the same ($label)", ({ before, after }) => {
    const source = signal(2);
    const identities: unknown[] = [];
    function Reader({ dependencies }: { dependencies: number[] | undefined }) {
      const value = useComputed(() => source.value, dependencies);
      identities.push(value);
      return <output aria-label="computed mode">{useSignalValue(value)}</output>;
    }
    const view = render(<Reader dependencies={before} />);
    view.rerender(<Reader dependencies={after} />);
    expect(screen.getByLabelText("computed mode").textContent).toBe("2");
    expect(new Set(identities).size).toBe(1);
  });

  it("treats omitted and empty dependencies of useWritableComputed as the same", () => {
    const source = signal(2);
    const identities: unknown[] = [];
    function Reader({ dependencies }: { dependencies: number[] | undefined }) {
      const value = useWritableComputed(
        { get: () => source.value, set: (next: number) => { source.value = next; } },
        dependencies,
      );
      identities.push(value);
      return <output aria-label="writable mode">{useSignalValue(value)}</output>;
    }
    const view = render(<Reader dependencies={undefined} />);
    view.rerender(<Reader dependencies={[]} />);
    expect(new Set(identities).size).toBe(1);
  });

  it("reports a useWritableComputed dependency length change", () => {
    const source = signal(2);
    function Reader({ dependencies }: { dependencies: number[] }) {
      const value = useWritableComputed(
        { get: () => source.value, set: (next: number) => { source.value = next; } },
        dependencies,
      );
      return <output>{useSignalValue(value)}</output>;
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<Reader dependencies={[1]} />);
    expect(() => view.rerender(<Reader dependencies={[1, 2]} />)).toThrow(
      /useWritableComputed: dependencies length changed from 1 to 2/,
    );
    errorSpy.mockRestore();
  });

});
