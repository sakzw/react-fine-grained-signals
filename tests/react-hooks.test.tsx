/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  batch,
  computed,
  signal,
  useComputed,
  useSignalValue,
  useSignals,
} from "../src/index.js";

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

  it("keeps a single useSignalValue effect subscription across unrelated re-renders", () => {
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
    // recreate the underlying effect subscription: `subscribe` is memoized on
    // `source` alone (via useMemo, mirroring useDeepSignalValue's store
    // construction), so an unchanged `source` should keep the same effect
    // running instead of resubscribing on every render.
    view.rerender(<Leaf tick={1} />);
    view.rerender(<Leaf tick={2} />);
    expect(evaluate).toHaveBeenCalledTimes(1);

    act(() => {
      source.value = 5;
    });
    expect(screen.getByLabelText("stable subscription").textContent).toBe("2:10");
    expect(evaluate).toHaveBeenCalledTimes(2);
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

  it("reports a useComputed dependency-mode switch instead of crashing obscurely", () => {
    const source = signal(2);

    function Switcher({ withDependencies }: { withDependencies: boolean }) {
      const value = useComputed(
        () => source.value * 2,
        withDependencies ? [source] : undefined,
      );
      return <output aria-label="switcher">{useSignalValue(value)}</output>;
    }

    // Starting without deps and then passing them used to quietly build a
    // second computed with a fresh identity mid-lifetime; the reverse handed
    // back `undefined` typed as `ReadonlySignal<T>`, so the failure surfaced
    // at the call site as "Cannot read properties of undefined".
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<Switcher withDependencies={false} />);
    expect(screen.getByLabelText("switcher").textContent).toBe("4");
    expect(() => view.rerender(<Switcher withDependencies />)).toThrow(
      /dependency-array mode changed between renders/,
    );
    errorSpy.mockRestore();

    // ...and the same error in the other direction.
    const reverseErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reverse = render(<Switcher withDependencies />);
    expect(() => reverse.rerender(<Switcher withDependencies={false} />)).toThrow(
      /dependency-array mode changed between renders/,
    );
    reverseErrorSpy.mockRestore();
  });
});
