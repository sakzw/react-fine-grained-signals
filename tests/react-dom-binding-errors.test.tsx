/** @jsxImportSource react-alien-signals */
// @vitest-environment jsdom

import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    // while throwing, so a write to either re-triggers the binding's effect.
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

    // Without a local catch, the throwing effect would propagate out of
    // `flush()` and its `finally` would drop the still-queued sibling effect
    // for this cycle — silently, not by throwing on it directly.
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

  it("bindSelectValue's MutationObserver survives its computed source's failure episode and resyncs once it recovers", async () => {
    const shouldFail = signal(false);
    const choice = computed(() => {
      if (shouldFail.value) throw new Error("select boom");
      return "c";
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    function Field() {
      return (
        <select aria-label="late failing choice" value={choice}>
          <option value="a">A</option>
          <option value="b">B</option>
        </select>
      );
    }

    render(<Field />);
    const select = screen.getByLabelText("late failing choice") as HTMLSelectElement;
    // No matching <option> exists yet, so nothing is selected.
    expect(select.value).toBe("");

    act(() => {
      shouldFail.value = true;
    });
    expect(consoleError).toHaveBeenCalledTimes(1);

    // Mutate the option list directly (bypassing React, so the `<select>`'s
    // own JSX/props are never re-evaluated) so only the MutationObserver
    // reacts. Its own `source.peek()` hits the same cached error and must not
    // crash, and — sharing this binding's single episode latch with the
    // effect above — must not log a second time.
    const option = document.createElement("option");
    option.value = "c";
    option.textContent = "C";
    act(() => {
      select.appendChild(option);
    });
    await waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1));
    // The browser's own "no option selected" default (auto-selecting the
    // first option once one exists) applies regardless of our binding — the
    // binding itself wrote nothing, which is what the unchanged call count
    // above already pins.
    expect(select.value).toBe("a");

    // Recovery: the tracked effect re-reads successfully and applies the
    // selection (the now-existing <option value="c"> makes it stick).
    act(() => {
      shouldFail.value = false;
    });
    await waitFor(() => expect(select.value).toBe("c"));
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("does not corrupt bindTextValue's pending buffer when a read fails during an active IME composition", () => {
    const shouldFail = signal(false);
    const raw = signal("abc");
    const text = computed(() => {
      const value = raw.value;
      if (shouldFail.value) throw new Error("text boom");
      return value;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    function Field() {
      return <input aria-label="failing ime field" value={text} />;
    }

    render(<Field />);
    const input = screen.getByLabelText("failing ime field") as HTMLInputElement;
    input.focus();

    fireEvent.compositionStart(input);
    // The browser renders composing IME candidates directly into `.value`.
    input.value = "こんに";

    // A failed read while composing must bail out before touching
    // `pending`/`hasPending` at all, leaving the composing text alone.
    act(() => {
      shouldFail.value = true;
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("こんに");

    fireEvent.compositionEnd(input);
    // No successful read was ever pending, so composition end applies nothing.
    expect(input.value).toBe("こんに");

    // A second failing write during the same episode does not log again.
    fireEvent.compositionStart(input);
    input.value = "ignored candidate";
    act(() => {
      raw.value = "still failing";
    });
    expect(consoleError).toHaveBeenCalledTimes(1);

    // Recovery is what latches as pending, not anything from a failed read.
    act(() => {
      raw.value = "recovered";
      shouldFail.value = false;
    });
    expect(input.value).toBe("ignored candidate");
    fireEvent.compositionEnd(input);
    expect(input.value).toBe("recovered");
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
