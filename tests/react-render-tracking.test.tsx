/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { StrictMode, Suspense, act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasActiveRenderCollector } from "../src/core/render-tracking.js";
import {
  computed,
  deepSignal,
  signal,
  useSignals,
  untracked,
} from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useSignals render tracking", () => {
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

  // Pins the documented boundary hazard (docs/hooks.md's "Tracking boundary"
  // section): a sibling that reads a signal without calling useSignals()
  // itself gets that read attributed to whichever collector is still open,
  // not its own (nonexistent) one. This is a regression pin on the current
  // best-effort behavior, not an assertion that it's correct.
  it("misattributes an unguarded sibling's read to the still-open preceding collector", () => {
    const guarded = signal("X");
    const unguarded = signal("Y");
    const guardedRenders = vi.fn();
    const unguardedRenders = vi.fn();

    function Guarded() {
      useSignals();
      guardedRenders();
      return <output aria-label="guarded sibling">{guarded.value}</output>;
    }
    function Unguarded() {
      // Deliberately omits useSignals().
      unguardedRenders();
      return <output aria-label="unguarded sibling">{unguarded.value}</output>;
    }

    render(<><Guarded /><Unguarded /></>);
    expect(screen.getByLabelText("guarded sibling").textContent).toBe("X");
    expect(screen.getByLabelText("unguarded sibling").textContent).toBe("Y");

    act(() => {
      unguarded.value = "Y2";
    });
    // Misattributed: Unguarded's read landed in Guarded's still-open
    // collector, so this update reruns Guarded (whose own displayed value is
    // unaffected) instead of Unguarded, whose DOM is left stale.
    expect(guardedRenders).toHaveBeenCalledTimes(2);
    expect(unguardedRenders).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("unguarded sibling").textContent).toBe("Y");

    act(() => {
      guarded.value = "X2";
    });
    expect(screen.getByLabelText("guarded sibling").textContent).toBe("X2");
    expect(guardedRenders).toHaveBeenCalledTimes(3);
    expect(unguardedRenders).toHaveBeenCalledTimes(1);
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
});
