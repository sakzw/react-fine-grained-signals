/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

// These fill a gap flagged in docs/design/use-signals-boundary-design.md's
// decision criteria: no test exercised startTransition, multiple concurrent
// roots, or cross-mechanism tearing. A genuine mid-fiber yield is not
// reproducible here without scheduler/unstable_mock (an internal React test
// utility, not a dependency of this package), and `act()` was confirmed by
// experiment to drain a transition to completion before returning, so an
// in-flight "torn" frame cannot be observed this way either. What these tests
// pin instead is the guarantee the "tear-free" claim actually rests on: after
// any settled commit, every consumer of the same value agrees, regardless of
// which subscription mechanism it uses, which root it lives in, or whether the
// write that produced it was synchronous, batched, or transitioned.
import { act, startTransition, useTransition } from "react";
import { createRoot } from "react-dom/client";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  batch,
  computed,
  effect,
  signal,
  useSignalValue,
  useSignals,
} from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

describe("concurrent rendering", () => {
  it("schedules a signal write made inside startTransition at transition priority", () => {
    // If the signal's synchronous, effect-based notify forced a synchronous
    // commit instead of the scheduled one, React would never render an
    // intermediate isPending=true frame; it would jump straight from `false`
    // to `false` in one render. Capturing isPending during render (rather
    // than reading the DOM after `act` returns, which we've confirmed drains
    // every pending lane) is what makes the intermediate frame observable.
    const heavy = signal(0);
    const pendingDuringRender: boolean[] = [];

    function Heavy() {
      const [isPending, beginTransition] = useTransition();
      pendingDuringRender.push(isPending);
      return (
        <>
          <output aria-label="heavy">{useSignalValue(heavy)}</output>
          <button
            type="button"
            onClick={() => beginTransition(() => { heavy.value = 1; })}
          >
            go
          </button>
        </>
      );
    }

    render(<Heavy />);
    act(() => {
      screen.getByRole("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(pendingDuringRender).toContain(true);
    expect(screen.getByLabelText("heavy").textContent).toBe("1");
  });

  it("keeps a batch atomic for the reactive core even when wrapped in a transition", () => {
    // React 18+ auto-batches synchronous updates regardless of this library's
    // own batch(), so a leaf hook's *rendered* values can't distinguish
    // "batch() worked" from "React's own batching happened to cover it" — a
    // first version of this test passed even with batch() replaced by a plain
    // `fn()` call. What batch() actually controls is the underlying
    // alien-signals effect, which is eager and runs independently of React;
    // observing it directly through the public effect() API is what makes
    // this test meaningful.
    const left = signal(1);
    const right = signal(2);
    const total = computed(() => left.value + right.value);
    const coreEffectRuns: number[] = [];
    const disposeCoreEffect = effect(() => {
      coreEffectRuns.push(total.value);
    });

    function Leaf() {
      return <output aria-label="leaf total">{useSignalValue(total)}</output>;
    }

    render(<Leaf />);
    expect(coreEffectRuns).toEqual([3]);

    act(() => {
      startTransition(() => {
        batch(() => {
          left.value = 10;
          right.value = 20;
        });
      });
    });

    // An unbatched pair of writes would append 12 before 30.
    expect(coreEffectRuns).toEqual([3, 30]);
    expect(screen.getByLabelText("leaf total").textContent).toBe("30");
    disposeCoreEffect();
  });

  it("does not starve a synchronous write to an unrelated signal while a transition is pending", () => {
    const heavy = signal(0);
    const urgent = signal("idle");

    function App() {
      const [, beginTransition] = useTransition();
      return (
        <>
          <output aria-label="heavy">{useSignalValue(heavy)}</output>
          <output aria-label="urgent">{useSignalValue(urgent)}</output>
          <button
            type="button"
            onClick={() => beginTransition(() => { heavy.value = 1; })}
          >
            go
          </button>
        </>
      );
    }

    render(<App />);
    act(() => {
      screen.getByRole("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      urgent.value = "typing";
    });

    expect(screen.getByLabelText("heavy").textContent).toBe("1");
    expect(screen.getByLabelText("urgent").textContent).toBe("typing");
  });

  it("agrees across useSignals render-tracking and a useSignalValue leaf after a transitioned write", () => {
    const source = signal(1);
    const doubled = computed(() => source.value * 2);

    function TrackedConsumer() {
      useSignals();
      return <output aria-label="tracked">{doubled.value}</output>;
    }
    function LeafConsumer() {
      return <output aria-label="leaf">{useSignalValue(doubled)}</output>;
    }

    render(
      <>
        <TrackedConsumer />
        <LeafConsumer />
      </>,
    );
    expect(screen.getByLabelText("tracked").textContent).toBe("2");
    expect(screen.getByLabelText("leaf").textContent).toBe("2");

    act(() => {
      startTransition(() => {
        source.value = 5;
      });
    });

    // The two subscription mechanisms are independent (RenderStore's version
    // counter vs. useSyncExternalStore's snapshot). Both settling on the same
    // value is the actual content of the "no tearing" guarantee.
    expect(screen.getByLabelText("tracked").textContent).toBe("10");
    expect(screen.getByLabelText("leaf").textContent).toBe("10");
  });

  it("keeps every sibling of a large fan-out consistent after one transitioned write", async () => {
    // A wide tree is what actually risks a mid-render yield in a real browser
    // (each component is a unit of scheduler work); this only exercises the
    // wide-fan-out shape, not a guaranteed yield, since jsdom's test scheduler
    // is not paced to trip a 5ms slice boundary deterministically.
    const source = signal(1);
    const SIBLING_COUNT = 200;

    function Sibling({ index }: { index: number }) {
      return <output aria-label={`sibling-${index}`}>{useSignalValue(source)}</output>;
    }

    render(
      <>
        {Array.from({ length: SIBLING_COUNT }, (_, index) => (
          <Sibling key={index} index={index} />
        ))}
      </>,
    );

    act(() => {
      startTransition(() => {
        source.value = 2;
      });
    });
    await waitFor(() => {
      expect(screen.getByLabelText("sibling-0").textContent).toBe("2");
    });

    const values = new Set(
      Array.from({ length: SIBLING_COUNT }, (_, index) =>
        screen.getByLabelText(`sibling-${index}`).textContent,
      ),
    );
    expect(values).toEqual(new Set(["2"]));
  });

  it("shares one signal's updates across two independent React roots", () => {
    const shared = signal("first");
    const containerA = document.createElement("div");
    const containerB = document.createElement("div");
    document.body.append(containerA, containerB);

    function TrackedInRootA() {
      useSignals();
      return <output aria-label="root-a">{shared.value}</output>;
    }
    function LeafInRootB() {
      return <output aria-label="root-b">{useSignalValue(shared)}</output>;
    }

    const rootA = createRoot(containerA);
    const rootB = createRoot(containerB);
    try {
      act(() => {
        rootA.render(<TrackedInRootA />);
        rootB.render(<LeafInRootB />);
      });
      expect(containerA.querySelector("output")?.textContent).toBe("first");
      expect(containerB.querySelector("output")?.textContent).toBe("first");

      // Neither root created `shared`, and neither knows the other rendered
      // it; a signal's subscriber list is what makes both observe the write
      // React's own tree-scoped state and context could not span.
      act(() => {
        shared.value = "second";
      });

      expect(containerA.querySelector("output")?.textContent).toBe("second");
      expect(containerB.querySelector("output")?.textContent).toBe("second");
    } finally {
      act(() => {
        rootA.unmount();
        rootB.unmount();
      });
      containerA.remove();
      containerB.remove();
    }
  });

  it("settles a transitioned write made from one root onto a signal read in another root", async () => {
    const shared = signal(1);
    const containerA = document.createElement("div");
    const containerB = document.createElement("div");
    document.body.append(containerA, containerB);

    function Writer() {
      const [, beginTransition] = useTransition();
      return (
        <button
          type="button"
          onClick={() => beginTransition(() => { shared.value = 99; })}
        >
          go
        </button>
      );
    }
    function Reader() {
      return <output aria-label="cross-root reader">{useSignalValue(shared)}</output>;
    }

    const rootA = createRoot(containerA);
    const rootB = createRoot(containerB);
    try {
      act(() => {
        rootA.render(<Writer />);
        rootB.render(<Reader />);
      });
      expect(containerB.querySelector("output")?.textContent).toBe("1");

      act(() => {
        containerA.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await waitFor(() => {
        expect(containerB.querySelector("output")?.textContent).toBe("99");
      });
    } finally {
      act(() => {
        rootA.unmount();
        rootB.unmount();
      });
      containerA.remove();
      containerB.remove();
    }
  });
});
