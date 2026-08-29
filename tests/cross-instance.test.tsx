/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { isSignal, signal, type ReadonlySignal } from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Spelled out rather than imported: the literal string is the cross-instance
// wire format, so a second copy of the package can only agree by matching it.
const SIGNAL_BRAND = Symbol.for("react-fine-grained-signals.signal");

/**
 * Stands in for a signal owned by a second copy of this package: the brand and
 * the `{ value, peek() }` contract are all this instance can see, which is the
 * situation duplicate resolution or a realm boundary actually produces. The
 * reads delegate to a local signal so the JSX runtime has something to react
 * to; a genuine duplicate keeps reactivity only while the alien-signals core
 * underneath is shared.
 */
function foreignSignal<T>(source: ReadonlySignal<T>): ReadonlySignal<T> {
  const foreign: ReadonlySignal<T> = {
    get value(): T {
      return source.value;
    },
    peek: () => source.peek(),
  };
  Object.defineProperty(foreign, SIGNAL_BRAND, {
    value: 1,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return foreign;
}

afterEach(() => {
  cleanup();
});

describe("signals from a second package instance", () => {
  it("is recognized without this instance having created it", () => {
    const foreign = foreignSignal(signal(1));

    expect(isSignal(foreign)).toBe(true);
    expect(Object.keys(foreign)).toEqual(["value", "peek"]);
    expect(Object.getOwnPropertySymbols({ ...foreign })).toEqual([]);
  });

  it("renders a foreign signal child through a reactive leaf", () => {
    const source = signal("one");
    const foreign = foreignSignal(source);

    render(<output aria-label="label">{foreign}</output>);

    expect(screen.getByLabelText("label").textContent).toBe("one");
    act(() => {
      source.value = "two";
    });
    expect(screen.getByLabelText("label").textContent).toBe("two");
  });

  it("binds a foreign signal directly to a host prop", () => {
    const source = signal("initial title");
    const foreign = foreignSignal(source);

    render(<input aria-label="field" title={foreign} data-state={foreign} />);

    const input = screen.getByLabelText("field") as HTMLInputElement;
    expect(input.title).toBe("initial title");
    expect(input.dataset.state).toBe("initial title");
    act(() => {
      source.value = "updated title";
    });
    expect(input.title).toBe("updated title");
    expect(input.dataset.state).toBe("updated title");
  });
});
