/** @jsxImportSource react-fine-grained-signals/lite */
// @vitest-environment jsdom

import { act, StrictMode, Suspense, createElement, type ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signal } from "../src/index.js";
import { createElement as liteCreateElement } from "../src/lite.js";
import { jsx as liteJsx } from "../src/lite-jsx-runtime.js";
import { jsxDEV as liteJsxDEV } from "../src/lite-jsx-dev-runtime.js";
import { jsx as fullJsx } from "../src/jsx-runtime.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

function mount(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

function Label({ children }: { children: ReactNode }) {
  return <strong>{children}</strong>;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("lite JSX runtime", () => {
  it("updates Signal children without rerendering their parent under StrictMode", () => {
    const count = signal(0);
    let parentRenders = 0;
    function App() {
      parentRenders++;
      return <main><output>{count}</output></main>;
    }

    const container = mount(<StrictMode><App /></StrictMode>);
    const committedRenderCount = parentRenders;
    expect(container.textContent).toBe("0");
    act(() => { count.value = 1; });
    expect(container.textContent).toBe("1");
    expect(parentRenders).toBe(committedRenderCount);
  });

  it("normalizes nested array children and Fragments while passing React components through", () => {
    const first = signal("first");
    const second = signal("second");
    const container = mount(<>
      <div>{[first, [" / ", second]]}</div>
      <Label><span>component child</span></Label>
    </>);
    expect(container.textContent).toBe("first / secondcomponent child");
    act(() => { second.value = "updated"; });
    expect(container.textContent).toBe("first / updatedcomponent child");
  });

  it("throws clear runtime errors for binding props and Signal-valued host attributes", () => {
    const source = signal("value");
    expect(() => liteJsx("input", { bindValue: source }, undefined)).toThrow(/form bindings require the default JSX runtime/);
    expect(() => liteJsx("div", { title: source }, undefined)).toThrow(/Signal-valued title props/);
    expect(() => liteJsx("div", { style: { color: source } }, undefined)).toThrow(/Signal-valued style\.color/);
  });

  it("supports the classic createElement fallback for Signal children", () => {
    const source = signal("classic");
    const container = mount(liteCreateElement("output", null, source));
    expect(container.textContent).toBe("classic");
    act(() => { source.value = "updated"; });
    expect(container.textContent).toBe("updated");
  });

  it("supports the development jsxDEV entry for Signal children", () => {
    const source = signal("development");
    const container = mount(liteJsxDEV("output", { children: source }, undefined, false, { fileName: "lite.tsx", lineNumber: 1, columnNumber: 1 }, undefined));
    expect(container.textContent).toBe("development");
    act(() => { source.value = "updated"; });
    expect(container.textContent).toBe("updated");
  });

  it("renders to string and hydrates Signal children without a mismatch", async () => {
    const source = signal("server");
    function App() { return <output>{source}</output>; }
    const html = renderToString(<App />);
    expect(html).toContain("server");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, <App />);
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toBe("server");
    await act(async () => { source.value = "client"; });
    expect(container.textContent).toBe("client");
    expect(consoleError).not.toHaveBeenCalled();
    root.unmount();
    container.remove();
    consoleError.mockRestore();
  });

  it("retries through Suspense and subscribes only after the child commits", async () => {
    const source = signal("committed");
    let ready = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    function Deferred() {
      if (!ready) throw gate;
      return <output>{source}</output>;
    }

    const container = mount(<Suspense fallback={<p>waiting</p>}><Deferred /></Suspense>);
    expect(container.textContent).toBe("waiting");
    await act(async () => {
      ready = true;
      release();
      await gate;
    });
    expect(container.textContent).toBe("committed");
    act(() => { source.value = "updated"; });
    expect(container.textContent).toBe("updated");
  });

  it("allows lite and full JSX runtimes to coexist in one React tree", () => {
    const source = signal("lite");
    const fullElement = fullJsx("span", { children: source });
    const container = mount(createElement("section", null, <output>{source}</output>, fullElement));
    expect(container.textContent).toBe("litelite");
    act(() => { source.value = "shared"; });
    expect(container.textContent).toBe("sharedshared");
  });
});
