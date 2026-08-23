/** @jsxImportSource react-alien-signals */
// @vitest-environment jsdom

import { StrictMode, Suspense, act, useLayoutEffect } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computed, deepSignal, signal } from "../src/index.js";
import { useSignals as useManagedSignals } from "../src/runtime.js";

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

describe("managed useSignals render scope", () => {
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
    const gate = new Promise<void>((resolve) => { release = resolve; });
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

    render(<Suspense fallback={<output aria-label="managed fallback">loading</output>}><Reader /></Suspense>);
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

    const view = render(<StrictMode><Reader /></StrictMode>);
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

    render(<><Writer /><Reader /></>);

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
});
