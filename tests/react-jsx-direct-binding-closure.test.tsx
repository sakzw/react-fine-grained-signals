/** @jsxImportSource react-fine-grained-signals/jsx */
// @vitest-environment jsdom

import { StrictMode, act, useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { coreRuntime } from "../src/core/core-runtime.js";
import { signal } from "../src/index.js";

// Regression coverage for the final direct-binding closure of 4622aee: when a
// host element keeps one signal binding, its ref is replaced (detach -> React
// diff -> attach) rather than dropped, and the re-attach must not refresh a
// binding that the new render removed or replaced.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.replaceChildren();
});

function mount(node: ReactNode, strict = false): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(strict ? <StrictMode>{node}</StrictMode> : node));
  return { container, root };
}

/** Lets deferred binding teardown (a microtask) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/** Every value the `class` attribute took while `run` ran, in order. */
function recordClassWrites(node: Element, run: () => void): string[] {
  const observer = new MutationObserver(() => {});
  observer.observe(node, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
  run();
  const records = observer.takeRecords();
  observer.disconnect();
  // Each record carries the value before the write; the value a write left is
  // the next record's old value, or the attribute's final value for the last.
  return records.map((_, index) => records[index + 1]?.oldValue ?? node.getAttribute("class") ?? "");
}

type Style = Record<string, unknown>;

const STRICT_MODES = [false, true] as const;

describe("a binding removed or replaced while a sibling binding keeps the ref alive", () => {
  for (const strict of STRICT_MODES) {
    it(`prop signal -> plain: React's plain value wins over the stale signal (strict=${strict})`, async () => {
      const cls = signal("from-signal");
      const style = signal<Style>({ color: "red" });
      let setPlain!: (plain: boolean) => void;
      function App() {
        const [plain, setPlainState] = useState(false);
        setPlain = setPlainState;
        return <div style={style as never} className={(plain ? "plain" : cls) as never} />;
      }
      const { container } = mount(<App />, strict);
      const box = container.firstChild as HTMLElement;
      expect(box.className).toBe("from-signal");

      act(() => setPlain(true));
      await settle();
      expect(container.firstChild).toBe(box);
      expect(box.className).toBe("plain");
      expect(coreRuntime.hasSubscribers(cls)).toBe(false);

      act(() => { cls.value = "late"; });
      expect(box.className).toBe("plain");

      // The sibling style binding was kept and still follows its signal.
      expect(coreRuntime.hasSubscribers(style)).toBe(true);
      act(() => { style.value = { color: "blue", width: 4 }; });
      expect(box.style.cssText).toBe("color: blue; width: 4px;");
      expect(box.className).toBe("plain");
    });

    it(`style signal -> plain: React's plain style wins over the stale signal (strict=${strict})`, async () => {
      const cls = signal("keep");
      const style = signal<Style>({ color: "red", width: 10 });
      let setPlain!: (plain: boolean) => void;
      function App() {
        const [plain, setPlainState] = useState(false);
        setPlain = setPlainState;
        return <div className={cls as never} style={(plain ? { color: "blue" } : style) as never} />;
      }
      const { container } = mount(<App />, strict);
      const box = container.firstChild as HTMLElement;
      expect(box.style.cssText).toBe("color: red; width: 10px;");

      act(() => setPlain(true));
      await settle();
      expect(container.firstChild).toBe(box);
      expect(box.style.cssText).toBe("color: blue;");
      expect(coreRuntime.hasSubscribers(style)).toBe(false);

      act(() => { style.value = { color: "pink", height: 3 }; });
      expect(box.style.cssText).toBe("color: blue;");

      expect(coreRuntime.hasSubscribers(cls)).toBe(true);
      act(() => { cls.value = "next"; });
      expect(box.className).toBe("next");
      expect(box.style.cssText).toBe("color: blue;");
    });
  }

  it("prop signal -> plain equal to the render snapshot after an off-render write", async () => {
    // The signal moved away from the value React was handed; the plain value
    // React now gets equals that old snapshot, so React's diff skips it and
    // only the detach's restore puts it back. A refresh must not undo that.
    const cls = signal("snapshot");
    const style = signal<Style>({ color: "red" });
    let setPlain!: (plain: boolean) => void;
    function App() {
      const [plain, setPlainState] = useState(false);
      setPlain = setPlainState;
      return <div style={style as never} className={(plain ? "snapshot" : cls) as never} />;
    }
    const { container } = mount(<App />);
    const box = container.firstChild as HTMLElement;

    act(() => { cls.value = "moved"; });
    expect(box.className).toBe("moved");
    act(() => setPlain(true));
    await settle();
    expect(box.className).toBe("snapshot");
    act(() => { cls.value = "late"; });
    expect(box.className).toBe("snapshot");
  });

  it("style signal -> plain equal to the render snapshot after an off-render write", async () => {
    const cls = signal("keep");
    const style = signal<Style>({ color: "red" });
    let setPlain!: (plain: boolean) => void;
    function App() {
      const [plain, setPlainState] = useState(false);
      setPlain = setPlainState;
      return <div className={cls as never} style={(plain ? { color: "red" } : style) as never} />;
    }
    const { container } = mount(<App />);
    const box = container.firstChild as HTMLElement;

    act(() => { style.value = { color: "green", width: 2 }; });
    act(() => setPlain(true));
    await settle();
    expect(box.style.cssText).toBe("color: red;");
  });

  for (const strict of STRICT_MODES) {
    it(`signal A -> B: A is never refreshed during the switch and B owns the prop (strict=${strict})`, async () => {
      const a = signal("a");
      const b = signal("b");
      const style = signal<Style>({ color: "red" });
      let useB!: (value: boolean) => void;
      function App() {
        const [isB, setIsB] = useState(false);
        useB = setIsB;
        return <div style={style as never} className={(isB ? b : a) as never} />;
      }
      const { container } = mount(<App />, strict);
      const box = container.firstChild as HTMLElement;

      const writes = recordClassWrites(box, () => act(() => useB(true)));
      await settle();
      expect(writes).not.toContain("a");
      expect(box.className).toBe("b");
      expect(container.firstChild).toBe(box);
      expect(coreRuntime.hasSubscribers(a)).toBe(false);

      act(() => { a.value = "late-a"; });
      expect(box.className).toBe("b");
      act(() => { b.value = "b2"; });
      expect(box.className).toBe("b2");
      act(() => { style.value = { color: "blue" }; });
      expect(box.style.cssText).toBe("color: blue;");
    });
  }

  it("a signal moving to another prop does not refresh into the prop it left", async () => {
    // The same signal moves from a prop to a different prop: the old binding's
    // name disappears, so it must not refresh into the old attribute.
    const value = signal("v1");
    const style = signal<Style>({ color: "red" });
    let move!: (moved: boolean) => void;
    function App() {
      const [moved, setMoved] = useState(false);
      move = setMoved;
      return moved
        ? <div style={style as never} className="plain" title={value as never} />
        : <div style={style as never} className={value as never} />;
    }
    const { container } = mount(<App />);
    const box = container.firstChild as HTMLElement;

    act(() => move(true));
    await settle();
    expect(container.firstChild).toBe(box);
    expect(box.className).toBe("plain");
    expect(box.title).toBe("v1");
    act(() => { value.value = "v2"; });
    expect(box.className).toBe("plain");
    expect(box.title).toBe("v2");
  });

  for (const strict of STRICT_MODES) {
    it(`a kept style binding still clears the incoming snapshot's keys while a sibling switches to plain (strict=${strict})`, async () => {
      const cls = signal("from-signal");
      const style = signal<Style>({ color: "red" });
      let pending: Style | undefined;
      // A descendant's layout effect drops a key in the owner's re-render
      // commit, before the host's ref re-attaches (see the B'1 regressions).
      function LayoutWriter() {
        useLayoutEffect(() => {
          if (pending === undefined) return;
          const next = pending;
          pending = undefined;
          style.value = next;
        });
        return null;
      }
      let setPlain!: (plain: boolean) => void;
      function App() {
        const [plain, setPlainState] = useState(false);
        setPlain = setPlainState;
        return (
          <div style={style as never} className={(plain ? "plain" : cls) as never}>
            <LayoutWriter />
          </div>
        );
      }
      const { container } = mount(<App />, strict);
      const box = container.firstChild as HTMLElement;

      act(() => { style.value = { color: "red", width: 10 }; });
      pending = { color: "red" };
      act(() => setPlain(true));
      await settle();
      expect(box.style.cssText).toBe("color: red;");
      expect(box.className).toBe("plain");

      act(() => { style.value = { color: "blue", padding: 2 }; });
      expect(box.style.cssText).toBe("color: blue; padding: 2px;");
      act(() => { cls.value = "late"; });
      expect(box.className).toBe("plain");
      expect(container.firstChild).toBe(box);
    });
  }
});
