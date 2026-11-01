// @vitest-environment jsdom

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deepSignal, effect, useDeepSignalValue, type DeepSignal } from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useDeepSignalValue checks and reads its source like useSignalValue", () => {
  it.each([
    ["a plain object", { user: { name: "Ada" } }],
    ["null", null],
  ])("throws a TypeError during render for %s", (_label, source) => {
    const selector = vi.fn((value: { user: { name: string } }) => value.user.name);
    function Reader() {
      return createElement(
        "output",
        null,
        useDeepSignalValue(source as unknown as DeepSignal<{ user: { name: string } }>, selector),
      );
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(createElement(Reader))).toThrow(
      new TypeError("useDeepSignalValue expects a deep signal created by react-fine-grained-signals"),
    );
    expect(selector).not.toHaveBeenCalled();
  });

  it("does not attach the selector's reads to an effect that renders synchronously", () => {
    const state = deepSignal({ user: { name: "Ada" } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Reader() {
      return createElement(
        "output",
        null,
        useDeepSignalValue(state, (value) => value.user.name),
      );
    }
    const runs = vi.fn();
    const dispose = effect(() => {
      runs();
      flushSync(() => root.render(createElement(Reader)));
    });
    expect(container.textContent).toBe("Ada");
    expect(runs).toHaveBeenCalledTimes(1);
    state.value.user.name = "Grace";
    // Only the component's own subscription follows the write.
    expect(runs).toHaveBeenCalledTimes(1);
    dispose();
    flushSync(() => root.unmount());
    container.remove();
  });
});
