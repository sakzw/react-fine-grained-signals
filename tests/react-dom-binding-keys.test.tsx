/** @jsxImportSource react-alien-signals */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signal } from "../src/index.js";

// Filters a console.error spy's calls down to React's dev-mode "Each child in
// a list should have a unique key prop" warning, so tests pinning that
// specific warning don't accidentally also match an unrelated console.error
// (e.g. this library's own "direct signal binding" failure report).
function missingKeyWarnings(calls: readonly (readonly unknown[])[]) {
  return calls.filter(
    ([message]) => typeof message === "string" && message.includes("unique") && message.includes("key"),
  );
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Direct DOM binding: missing-key warnings", () => {
  // A signal-bound host element is routed through the `ReactiveHost` wrapper
  // (see createJsxWrapper in src/runtime/jsx.ts), which used to reconstruct
  // its children outside the path React's dev-mode key validation actually
  // runs on — so *any* signal-bound host element with 2+ static, unkeyed JSX
  // children spuriously tripped React's "Each child in a list should have a
  // unique key prop" warning, even though the identical JSX without a signal
  // binding never did. These four tests pin the fix: static children stay
  // silent (the case that used to false-positive), a genuinely unkeyed
  // dynamic array still warns (so the fix isn't a blanket suppression), and
  // the binding's real behavior (DOM structure, value binding, ref/cleanup)
  // keeps working. Filtered to "unique"+"key" so an unrelated console.error
  // (e.g. this module's own "direct signal binding" failure report) is never
  // mistaken for this warning.

  it("does not warn about a missing key for a signal-bound host element's static, unkeyed children", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const status = signal("active");

    // "section"/"article" (not "select"/"option", already exercised unkeyed
    // and reactively-bound by many earlier tests in this file) — React's
    // dev-mode missing-key warning is deduped per parent-component-name for
    // the whole process, so reusing an already-tripped pair here would pass
    // this assertion regardless of whether the fix actually works.
    function Field() {
      return (
        <section aria-label="unkeyed status" data-state={status}>
          <article>first</article>
          <article>second</article>
        </section>
      );
    }

    render(<Field />);
    expect(missingKeyWarnings(consoleError.mock.calls)).toHaveLength(0);
  });

  it("does not warn about a missing key for a signal-bound div's static, unkeyed children", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const highlight = signal("on");

    function Box() {
      return (
        <div aria-label="unkeyed box" className={highlight}>
          <span>first</span>
          <span>second</span>
        </div>
      );
    }

    render(<Box />);
    expect(missingKeyWarnings(consoleError.mock.calls)).toHaveLength(0);
  });

  it("still warns about a missing key for a signal-bound host element's genuinely unkeyed dynamic array of children", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const highlight = signal("on");
    const rows = ["x", "y", "z"];

    function List() {
      return (
        <ul aria-label="dynamic list" className={highlight}>
          {/* Deliberately unkeyed: this test pins that React's real, valid
              warning for a genuinely dynamic array still fires. */}
          {/* oxlint-disable-next-line react/jsx-key */}
          {rows.map((row) => <li>{row}</li>)}
        </ul>
      );
    }

    render(<List />);
    // This array is built by the test's own `.map()`, not static JSX syntax —
    // React's real, valid warning for this footgun must still fire.
    expect(missingKeyWarnings(consoleError.mock.calls)).toHaveLength(1);
  });

  it("keeps DOM structure, value binding, and ref cleanup working for a signal-bound select with multiple unkeyed children", () => {
    const choice = signal("b");
    const setups = vi.fn();
    const cleanups = vi.fn();

    function Field() {
      return (
        <select
          aria-label="unkeyed choice with ref"
          value={choice}
          onChange={(event) => { choice.value = event.target.value; }}
          ref={(node) => {
            if (!node) return;
            setups();
            return cleanups;
          }}
        >
          <option value="a">A</option>
          <option value="b">B</option>
          <option value="c">C</option>
        </select>
      );
    }

    const view = render(<Field />);
    const select = screen.getByLabelText("unkeyed choice with ref") as HTMLSelectElement;
    expect(select.options.length).toBe(3);
    expect(select.value).toBe("b");
    expect(setups).toHaveBeenCalledTimes(1);

    fireEvent.change(select, { target: { value: "c" } });
    expect(choice.value).toBe("c");
    expect(select.value).toBe("c");

    view.unmount();
    expect(cleanups).toHaveBeenCalledTimes(1);
  });
});
