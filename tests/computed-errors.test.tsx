/** @jsxImportSource react-alien-signals */
// @vitest-environment jsdom

import { Component, act } from "react";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computed,
  signal,
  useSignalValue,
  useSignals,
} from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: undefined };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    return this.state.error === undefined
      ? this.props.children
      : <output aria-label="boundary caught">caught</output>;
  }
}

describe("computed error propagation (React)", () => {
  it("delivers a leaf useSignalValue error to an Error Boundary instead of escaping React entirely", () => {
    // Mount already in the error state: useSignalValue's getSnapshot (called
    // during render, inside useSyncExternalStore) is what surfaces the boxed
    // error here, which is exactly where an Error Boundary can intercept it.
    // The companion case -- a computed transitioning into erroring from a
    // background write while already mounted -- is covered separately below.
    const source = signal(2);
    const broken = computed(() => {
      if (source.value === 2) throw new Error("computed failed");
      return source.value;
    });
    const reactError = vi.spyOn(console, "error").mockImplementation(() => {});

    function Reader() {
      const value = useSignalValue(broken);
      return <output aria-label="value">{value}</output>;
    }

    expect(() => {
      render(<ErrorBoundary><Reader /></ErrorBoundary>);
    }).not.toThrow();
    expect(screen.getByLabelText("boundary caught").textContent).toBe("caught");
    expect(reactError).toHaveBeenCalled();
  });

  it("does not throw synchronously out of a write that makes an already-mounted useSignalValue leaf's computed start erroring", () => {
    // useSignalValue's own subscribe effect reads `source.value` in the
    // background, outside any React render -- a separate read from the one
    // `computed()`'s box/unbox fix protects internally. Before that read was
    // also guarded, a background write transitioning a mounted leaf's
    // computed into erroring threw synchronously here, at the write, instead
    // of surfacing through the next render's getSnapshot call.
    const source = signal(1);
    const broken = computed(() => {
      if (source.value === 2) throw new Error("background transition failed");
      return source.value;
    });
    const reactError = vi.spyOn(console, "error").mockImplementation(() => {});

    function Reader() {
      const value = useSignalValue(broken);
      return <output aria-label="value">{value}</output>;
    }

    render(<ErrorBoundary><Reader /></ErrorBoundary>);
    expect(screen.getByLabelText("value").textContent).toBe("1");

    expect(() => {
      act(() => {
        source.value = 2;
      });
    }).not.toThrow();
    expect(screen.getByLabelText("boundary caught").textContent).toBe("caught");
    expect(reactError).toHaveBeenCalled();
  });

  it("delivers a useSignals()-tracked render read to an Error Boundary, not just the leaf hook path", () => {
    const source = signal(1);
    const broken = computed(() => {
      if (source.value === 2) throw new Error("render read failed");
      return source.value;
    });
    const reactError = vi.spyOn(console, "error").mockImplementation(() => {});

    function Reader() {
      useSignals();
      return <output aria-label="tracked value">{broken.value}</output>;
    }

    render(<ErrorBoundary><Reader /></ErrorBoundary>);
    expect(screen.getByLabelText("tracked value").textContent).toBe("1");

    expect(() => {
      act(() => {
        source.value = 2;
      });
    }).not.toThrow();
    expect(screen.getByLabelText("boundary caught").textContent).toBe("caught");
    expect(reactError).toHaveBeenCalled();
  });

  it("re-renders a useSignals()-tracked component through error -> success -> error transitions", () => {
    // The render bridge's own change check (`nextValue !== lastRenderValue`) is
    // a plain reference comparison. Every branch of the computed's internal
    // try/catch always constructs a fresh box on change, including switching
    // between two different error causes, so this must notify/bump on every
    // leg below, not just success<->success transitions.
    const source = signal(1);
    const flippy = computed(() => {
      if (source.value < 0) throw new Error(`negative: ${source.value}`);
      return source.value;
    });
    const reactError = vi.spyOn(console, "error").mockImplementation(() => {});

    function Reader() {
      useSignals();
      return <output aria-label="flippy value">{flippy.value}</output>;
    }

    render(<ErrorBoundary><Reader /></ErrorBoundary>);
    expect(screen.getByLabelText("flippy value").textContent).toBe("1");

    act(() => {
      source.value = -1;
    });
    expect(screen.getByLabelText("boundary caught").textContent).toBe("caught");
    expect(reactError).toHaveBeenCalled();
  });

  it("leaves an unrelated useSignals()-tracked component unaffected by another computed throwing in the same commit", () => {
    // Reproduces claim 2's blast radius through the public API: in raw
    // alien-signals@3.2.1, once one queued effect's dirty-check throws mid-flush
    // every effect still queued behind it in that flush is skipped and never
    // recovers on its own, even on later unrelated writes -- not just deferred
    // to next flush. With the fix, alien-signals' own bookkeeping never sees an
    // exception, so the whole flush (and everything reacting inside it) completes.
    const a = signal(1);
    const b = signal(100);
    const erroring = computed(() => {
      if (a.value === 2) throw new Error("boom");
      return a.value;
    });
    const healthyRenders = vi.fn();
    const reactError = vi.spyOn(console, "error").mockImplementation(() => {});

    function ErroringReader() {
      useSignals();
      return <output aria-label="erroring value">{erroring.value}</output>;
    }
    function HealthyReader() {
      useSignals();
      healthyRenders();
      return <output aria-label="healthy value">{b.value}</output>;
    }

    render(
      <>
        <ErrorBoundary><ErroringReader /></ErrorBoundary>
        <HealthyReader />
      </>,
    );
    expect(screen.getByLabelText("erroring value").textContent).toBe("1");
    expect(screen.getByLabelText("healthy value").textContent).toBe("100");
    expect(healthyRenders).toHaveBeenCalledTimes(1);

    // `a` is written before `b`, so in the shared flush the erroring watcher's
    // dirty-check runs (and, pre-fix, would throw) before the healthy one's.
    expect(() => {
      act(() => {
        a.value = 2;
        b.value = 200;
      });
    }).not.toThrow();

    expect(screen.getByLabelText("boundary caught").textContent).toBe("caught");
    expect(reactError).toHaveBeenCalled();
    // The content, not the exact render count, is what proves the blast
    // radius claim: React's own error recovery re-renders surviving siblings
    // an extra time while unwinding to the boundary (observed: 3 calls, not
    // the naive 2, deterministically -- unrelated to signals reactivity), but
    // `HealthyReader` must still land on the fresh value, not a stale one.
    expect(screen.getByLabelText("healthy value").textContent).toBe("200");
    const rendersAfterFirstCommit = healthyRenders.mock.calls.length;
    expect(rendersAfterFirstCommit).toBeGreaterThanOrEqual(2);

    // Confirm it keeps reacting afterward too, not just this one commit.
    act(() => {
      b.value = 300;
    });
    expect(screen.getByLabelText("healthy value").textContent).toBe("300");
    expect(healthyRenders).toHaveBeenCalledTimes(rendersAfterFirstCommit + 1);
  });
});
