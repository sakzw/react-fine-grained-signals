/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { batch, computed, signal } from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Direct DOM binding: error handling", () => {
  it("keeps a direct style binding's last DOM value and reports its computed source's failures once per episode", () => {
    const shouldFail = signal(false);
    const raw = signal("red");
    // Reading both signals unconditionally keeps them both dependencies even
    // while throwing, so a write to either re-triggers the binding update.
    const styleColor = computed(() => {
      const value = raw.value;
      if (shouldFail.value) throw new Error(`style boom: ${value}`);
      return { color: value };
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    function Box() {
      return <div aria-label="styled box" style={styleColor} />;
    }

    render(<Box />);
    const box = screen.getByLabelText("styled box");
    expect(box.style.color).toBe("red");

    // The computed starts throwing only after the binding is already mounted.
    // The triggering write itself must not throw, and the DOM keeps its last
    // successfully applied value.
    expect(() => {
      act(() => {
        shouldFail.value = true;
      });
    }).not.toThrow();
    expect(box.style.color).toBe("red");
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toMatch(/direct signal binding/i);
    expect((consoleError.mock.calls[0]?.[1] as { cause?: unknown } | undefined)?.cause).toBeInstanceOf(Error);

    // A further write that keeps the computed erroring (same episode) must
    // not log a second time.
    act(() => {
      raw.value = "green";
    });
    expect(box.style.color).toBe("red");
    expect(consoleError).toHaveBeenCalledTimes(1);

    // Recovery resumes DOM updates and clears the latch.
    act(() => {
      shouldFail.value = false;
    });
    expect(box.style.color).toBe("green");
    expect(consoleError).toHaveBeenCalledTimes(1);

    // A later, distinct failure episode logs again.
    act(() => {
      shouldFail.value = true;
    });
    expect(box.style.color).toBe("green");
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it("keeps an unrelated direct binding updating despite a sibling binding throwing in the same flush", () => {
    const shouldFail = signal(false);
    const raw = signal("red");
    const styleColor = computed(() => {
      const value = raw.value;
      if (shouldFail.value) throw new Error("boom");
      return { color: value };
    });
    const label = signal("first");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    function Widget() {
      return (
        <>
          <div aria-label="styled" style={styleColor} />
          <div aria-label="labeled" data-state={label} />
        </>
      );
    }

    render(<Widget />);
    const styled = screen.getByLabelText("styled");
    const labeled = screen.getByLabelText("labeled");
    expect(styled.style.color).toBe("red");
    expect(labeled.dataset.state).toBe("first");

    // The failing binding update must stay local so the sibling subscriber
    // still applies its value during the same batched write.
    expect(() => {
      act(() => {
        batch(() => {
          shouldFail.value = true;
          label.value = "second";
        });
      });
    }).not.toThrow();

    expect(styled.style.color).toBe("red");
    expect(labeled.dataset.state).toBe("second");
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

});
