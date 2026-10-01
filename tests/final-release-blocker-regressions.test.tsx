/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { Activity, act, useLayoutEffect } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createReactiveRuntime } from "../src/core/reactive-runtime.js";
import { computed, effect, signal, useSignalTracking } from "../src/index.js";
import { useManagedSignals } from "../src/runtime.js";

// Regression coverage for the final targeted v0.2.0 release-blocker validation.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

type Runtime = ReturnType<typeof createReactiveRuntime>;

/** One render attempt that reads `read()` and then commits, as RenderStore does. */
function renderAndCommit<T>(runtime: Runtime, read: () => T, scopePolicy: "managed" | "bare" = "managed"): T {
  const attempt = runtime.renderAdapter.createRenderAttempt();
  let value!: T;
  runtime.renderAdapter.withRenderScope(attempt, () => { value = read(); }, scopePolicy);
  expect(runtime.renderAdapter.promoteRenderAttempt(attempt)).toBe(true);
  return value;
}

describe("a computed first read in a render after an unobserved source write", () => {
  for (const scopePolicy of ["managed", "bare"] as const) {
    it(`follows a write back to the source's previous value (${scopePolicy} scope)`, () => {
      const runtime = createReactiveRuntime();
      const darkMode = runtime.signal(false);
      darkMode.value = true;
      const theme = runtime.computed(() => (darkMode.value ? "dark" : "light"));

      expect(renderAndCommit(runtime, () => theme.value, scopePolicy)).toBe("dark");
      darkMode.value = false;
      expect(theme.peek()).toBe("light");
      darkMode.value = true;
      expect(theme.peek()).toBe("dark");
    });
  }

  it("follows the write when the computed was created before the unobserved write", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal("A");
    const value = runtime.computed(() => source.value);
    source.value = "B";

    expect(renderAndCommit(runtime, () => value.value)).toBe("B");
    source.value = "A";
    expect(value.peek()).toBe("A");
  });

  it("follows the write when the source had a subscriber that went away before the write", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal("A");
    const dispose = runtime.effect(() => { void source.value; });
    dispose();
    source.value = "B";
    const value = runtime.computed(() => source.value);

    expect(renderAndCommit(runtime, () => value.value)).toBe("B");
    source.value = "A";
    expect(value.peek()).toBe("A");
  });

  it("re-runs an effect that subscribes to the promoted computed", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal("A");
    source.value = "B";
    const value = runtime.computed(() => source.value);
    renderAndCommit(runtime, () => value.value);
    const seen: string[] = [];
    const dispose = runtime.effect(() => { seen.push(value.value); });

    source.value = "A";
    expect(seen).toEqual(["B", "A"]);
    dispose();
  });

  it("settles a source read through a nested computed chain", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(1);
    source.value = 2;
    const doubled = runtime.computed(() => source.value * 2);
    const label = runtime.computed(() => `${source.value}:${doubled.value}`);

    expect(renderAndCommit(runtime, () => label.value)).toBe("2:4");
    source.value = 1;
    expect(label.peek()).toBe("1:2");
    expect(doubled.peek()).toBe(2);
  });

  it("keeps the promoted value memoized while the source is unchanged", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(1);
    source.value = 2;
    let evaluations = 0;
    const value = runtime.computed(() => { evaluations += 1; return source.value * 10; });

    expect(renderAndCommit(runtime, () => value.value)).toBe(20);
    expect(evaluations).toBe(1);
    expect(value.peek()).toBe(20);
    expect(evaluations).toBe(1);
  });

  it("notifies a source's other subscribers through the settled write", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal("A");
    // A cold computed keeps a link to the source without watching it.
    const other = runtime.computed(() => `other:${source.value}`);
    expect(other.peek()).toBe("other:A");
    source.value = "B";
    const value = runtime.computed(() => source.value);

    expect(renderAndCommit(runtime, () => value.value)).toBe("B");
    source.value = "A";
    expect(value.peek()).toBe("A");
    expect(other.peek()).toBe("other:A");
    source.value = "B";
    expect(other.peek()).toBe("other:B");
    expect(value.peek()).toBe("B");
  });

  it("does not promote over a computed dependency that a write left pending", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(1);
    const inner = runtime.computed(() => source.value * 2);
    expect(inner.peek()).toBe(2);
    const outer = runtime.computed(() => inner.value + 1);
    const attempt = runtime.renderAdapter.createRenderAttempt();
    runtime.renderAdapter.withRenderScope(attempt, () => { expect(outer.value).toBe(3); });
    source.value = 2;

    expect(runtime.renderAdapter.promoteRenderAttempt(attempt)).toBe(false);
    expect(outer.peek()).toBe(5);
    source.value = 3;
    expect(outer.peek()).toBe(7);
  });

  it("re-renders when a computed dependency changes between render and commit", () => {
    const source = signal(1);
    const inner = computed(() => source.value * 2);
    expect(inner.peek()).toBe(2);
    const outer = computed(() => inner.value + 1);
    function Writer() {
      useLayoutEffect(() => { source.value = 2; }, []);
      return null;
    }
    function Reader() {
      useSignalTracking();
      return <span>{outer.value}</span>;
    }

    const view = render(<><Writer /><Reader /></>);
    expect(view.container.textContent).toBe("5");
    act(() => { source.value = 3; });
    expect(view.container.textContent).toBe("7");
  });

  it("does not promote when the source changed between render and commit", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal("A");
    source.value = "B";
    const value = runtime.computed(() => source.value);
    const attempt = runtime.renderAdapter.createRenderAttempt();
    runtime.renderAdapter.withRenderScope(attempt, () => { expect(value.value).toBe("B"); });
    source.value = "C";

    expect(runtime.renderAdapter.promoteRenderAttempt(attempt)).toBe(false);
    expect(value.peek()).toBe("C");
    source.value = "B";
    expect(value.peek()).toBe("B");
  });

  it("recovers from a cached error once the source is written back", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(0);
    source.value = 1;
    const value = runtime.computed(() => {
      if (source.value === 1) throw new Error("one");
      return source.value;
    });

    const attempt = runtime.renderAdapter.createRenderAttempt();
    runtime.renderAdapter.withRenderScope(attempt, () => {
      expect(() => value.value).toThrow("one");
    });
    expect(runtime.renderAdapter.promoteRenderAttempt(attempt)).toBe(true);
    source.value = 0;
    expect(value.peek()).toBe(0);
  });

  for (const hook of ["useSignalTracking", "useManagedSignals"] as const) {
    it(`re-renders a ${hook}() component when the source is written back`, () => {
      const darkMode = signal(false);
      darkMode.value = true;
      const theme = computed(() => (darkMode.value ? "dark" : "light"));

      function BareTheme() {
        useSignalTracking();
        return <span>{theme.value}</span>;
      }
      function ManagedTheme() {
        const scope = useManagedSignals();
        try {
          return <span>{theme.value}</span>;
        } finally {
          scope.finish();
        }
      }
      const Theme = hook === "useSignalTracking" ? BareTheme : ManagedTheme;

      const view = render(<Theme />);
      expect(view.container.textContent).toBe("dark");
      act(() => { darkMode.value = false; });
      expect(view.container.textContent).toBe("light");
      expect(theme.peek()).toBe("light");
      act(() => { darkMode.value = true; });
      expect(view.container.textContent).toBe("dark");
    });
  }

  it("is unaffected when the first read is in an effect", () => {
    const source = signal("A");
    source.value = "B";
    const value = computed(() => source.value);
    const seen: string[] = [];
    const dispose = effect(() => { seen.push(value.value); });
    source.value = "A";
    expect(seen).toEqual(["B", "A"]);
    dispose();
  });
});

/** Writes the signal off-render, then re-renders the owner with the plain value. */
function switchToPlain<T>(
  initial: T,
  written: T,
  plain: T,
  element: (value: T | ReturnType<typeof signal<T>>) => React.ReactElement,
) {
  const source = signal(initial);
  function App({ bound }: { bound: boolean }) {
    return element(bound ? source : plain);
  }
  const view = render(<App bound />);
  const node = view.container.firstElementChild as HTMLElement;
  act(() => { source.value = written; });
  view.rerender(<App bound={false} />);
  expect(view.container.firstElementChild).toBe(node);
  return { source, node };
}

describe("a host prop switched from a signal binding back to a plain value", () => {
  it("re-enables a button whose plain value equals the render-time snapshot", () => {
    const { node } = switchToPlain(false, true, false, (disabled) => <button disabled={disabled as boolean}>test</button>);
    expect((node as HTMLButtonElement).disabled).toBe(false);
  });

  it("restores a className whose plain value equals the render-time snapshot", () => {
    const { node } = switchToPlain("x", "y", "x", (className) => <p className={className as string}>x</p>);
    expect(node.className).toBe("x");
  });

  it("restores a style whose plain value equals the render-time snapshot", () => {
    const { node } = switchToPlain<Record<string, string>>(
      { color: "red" },
      { color: "blue", fontWeight: "bold" },
      { color: "red" },
      (style) => <p style={style as Record<string, string>}>x</p>,
    );
    expect(node.getAttribute("style")).toBe("color: red;");
  });

  it("hands a text input's value to a plain value equal to the render-time snapshot", () => {
    const { node } = switchToPlain("a", "b", "a", (value) => <input value={value as string} onChange={() => {}} />);
    expect((node as HTMLInputElement).value).toBe("a");
  });

  it("hands a checkbox's checked state to a plain value equal to the render-time snapshot", () => {
    const { node } = switchToPlain(false, true, false, (checked) => <input type="checkbox" checked={checked as boolean} onChange={() => {}} />);
    expect((node as HTMLInputElement).checked).toBe(false);
  });

  it("writes a plain value that differs from the render-time snapshot", () => {
    const { node } = switchToPlain("x", "y", "z", (className) => <p className={className as string}>x</p>);
    expect(node.className).toBe("z");
  });

  it("stops following the signal after the switch", async () => {
    const { node, source } = switchToPlain("x", "y", "x", (className) => <p className={className as string}>x</p>);
    await act(async () => { await Promise.resolve(); });
    act(() => { source.value = "ignored"; });
    expect(node.className).toBe("x");
  });

  it("uses the snapshot of the latest committed render, not the first", () => {
    const disabled = signal(false);
    const bump = signal(0);
    function App({ bound }: { bound: boolean }) {
      useSignalTracking();
      void bump.value;
      return <button disabled={bound ? disabled : true}>test</button>;
    }
    const view = render(<App bound />);
    const button = view.container.querySelector("button")!;
    act(() => { disabled.value = true; });
    // The owner re-renders with `true` as React's snapshot of the prop.
    act(() => { bump.value++; });
    expect(button.disabled).toBe(true);
    act(() => { disabled.value = false; });
    expect(button.disabled).toBe(false);

    view.rerender(<App bound={false} />);
    expect(view.container.querySelector("button")).toBe(button);
    expect(button.disabled).toBe(true);
  });

  it("keeps the element, its children's state, and focus across the switch", () => {
    const className = signal("x");
    const mounts: number[] = [];
    function Child() {
      useLayoutEffect(() => { mounts.push(1); }, []);
      return <input data-testid="field" />;
    }
    function App({ bound }: { bound: boolean }) {
      return <div className={bound ? className : "x"}><Child /></div>;
    }
    const view = render(<App bound />);
    const host = view.container.firstElementChild as HTMLElement;
    const field = view.getByTestId("field") as HTMLInputElement;
    field.value = "typed";
    field.focus();
    act(() => { className.value = "y"; });

    view.rerender(<App bound={false} />);
    expect(view.container.firstElementChild).toBe(host);
    expect(host.className).toBe("x");
    expect(view.getByTestId("field")).toBe(field);
    expect(field.value).toBe("typed");
    expect(document.activeElement).toBe(field);
    expect(mounts).toHaveLength(1);

    view.rerender(<App bound />);
    expect(host.className).toBe("y");
    act(() => { className.value = "z"; });
    expect(host.className).toBe("z");
  });

  it("keeps following a signal that replaced another one", () => {
    const first = signal("x");
    const second = signal("x");
    function App({ useSecond }: { useSecond: boolean }) {
      return <p className={useSecond ? second : first}>x</p>;
    }
    const view = render(<App useSecond={false} />);
    const node = view.container.firstElementChild as HTMLElement;
    act(() => { first.value = "y"; });
    view.rerender(<App useSecond />);
    expect(node.className).toBe("x");
    act(() => { second.value = "z"; });
    expect(node.className).toBe("z");
  });

  it("forwards a stable user ref once across the switch", () => {
    const className = signal("x");
    const attachments: (Element | null)[] = [];
    const userRef = (node: Element | null) => { attachments.push(node); };
    function App({ bound }: { bound: boolean }) {
      return <p ref={userRef} className={bound ? className : "x"}>x</p>;
    }
    const view = render(<App bound />);
    const node = view.container.firstElementChild as HTMLElement;
    act(() => { className.value = "y"; });
    view.rerender(<App bound={false} />);
    expect(node.className).toBe("x");
    expect(attachments).toEqual([node, null, node]);
  });

  it("applies a plain value set while an Activity boundary hides the element", async () => {
    const className = signal("x");
    function App({ mode, bound }: { mode: "visible" | "hidden"; bound: boolean }) {
      return (
        <Activity mode={mode}>
          <p className={bound ? className : "x"}>x</p>
        </Activity>
      );
    }
    const view = render(<App mode="visible" bound />);
    const node = view.container.querySelector("p")!;
    act(() => { className.value = "y"; });
    view.rerender(<App mode="hidden" bound />);
    await act(async () => { await Promise.resolve(); });
    view.rerender(<App mode="hidden" bound={false} />);
    view.rerender(<App mode="visible" bound={false} />);
    expect(view.container.querySelector("p")).toBe(node);
    expect(node.className).toBe("x");
  });

  it("re-applies the current value when an Activity boundary reveals a bound element", async () => {
    const className = signal("x");
    function App({ mode }: { mode: "visible" | "hidden" }) {
      return (
        <Activity mode={mode}>
          <p className={className}>x</p>
        </Activity>
      );
    }
    const view = render(<App mode="visible" />);
    const node = view.container.querySelector("p")!;
    act(() => { className.value = "y"; });
    view.rerender(<App mode="hidden" />);
    await act(async () => { await Promise.resolve(); });
    act(() => { className.value = "z"; });
    view.rerender(<App mode="visible" />);
    expect(node.className).toBe("z");
    act(() => { className.value = "w"; });
    expect(node.className).toBe("w");
  });
});
