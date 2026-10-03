/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import {
  Activity,
  Component,
  StrictMode,
  Suspense,
  act,
  createRef,
  memo,
  startTransition,
  useLayoutEffect,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coreRuntime } from "../src/core/core-runtime.js";
import { createReactiveRuntime } from "../src/core/reactive-runtime.js";
import { computed, signal, useSignalTracking, type Signal } from "../src/index.js";
import { useManagedSignals } from "../src/runtime.js";

// Regression coverage for the independent B' React / JSX re-audit of aca0d30.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mount(node: ReactNode, strict = false): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(strict ? <StrictMode>{node}</StrictMode> : node));
  return { container, root };
}

/** Lets deferred binding teardown and RenderStore disposal (microtasks) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

type Style = Record<string, unknown>;

/**
 * A child whose layout effect writes `source` once, when armed, during the
 * same commit as the owner's re-render — before the host's ref re-attaches.
 */
function createLayoutWriter<T>(source: Signal<T>) {
  let pending: { value: T } | undefined;
  // No dependency array: it runs in every commit that re-renders it.
  function LayoutWriter() {
    useLayoutEffect(() => {
      if (pending === undefined) return;
      const { value } = pending;
      pending = undefined;
      source.value = value;
    });
    return null;
  }
  return { LayoutWriter, arm: (value: T) => { pending = { value }; } };
}

/** A later sibling that writes `source` during render, after the owner snapshotted it. */
function createRenderWriter<T>(source: Signal<T>) {
  let pending: { value: T } | undefined;
  function RenderWriter() {
    if (pending !== undefined) {
      const { value } = pending;
      pending = undefined;
      source.value = value;
    }
    return null;
  }
  return { RenderWriter, arm: (value: T) => { pending = { value }; } };
}

const STRICT_MODES = [false, true] as const;

const ignoreNode: Ref<HTMLDivElement> = () => {};

function throwOnCleanup(node: Element | null) {
  if (node) {
    return () => {
      throw new Error("cleanup boom");
    };
  }
}

describe("B'1: a kept style binding clears keys from the render snapshot it re-attaches for", () => {
  for (const strict of STRICT_MODES) {
    it(`clears a key a descendant's layout effect drops in the owner's re-render commit (strict=${strict})`, async () => {
      const style = signal<Style>({ color: "red" });
      const writer = createLayoutWriter(style);
      let rerender!: (n: number) => void;
      function App() {
        const [n, setN] = useState(0);
        rerender = setN;
        return <div data-n={n} style={style as never}><writer.LayoutWriter /></div>;
      }
      const { container } = mount(<App />, strict);
      const box = container.firstChild as HTMLElement;

      act(() => { style.value = { color: "red", width: 10 }; });
      expect(box.style.cssText).toBe("color: red; width: 10px;");
      writer.arm({ color: "red" });
      act(() => rerender(1));
      await settle();
      expect(box.style.cssText).toBe("color: red;");

      // Later writes keep following the signal and still clear dropped keys.
      act(() => { style.value = { color: "blue", padding: 2 }; });
      expect(box.style.cssText).toBe("color: blue; padding: 2px;");
      act(() => { style.value = { color: "blue" }; });
      expect(box.style.cssText).toBe("color: blue;");
      expect(container.firstChild).toBe(box);
    });

    for (const transition of [false, true]) {
      it(`clears a key the signal drops between the owner's render and commit (transition=${transition}, strict=${strict})`, async () => {
        const style = signal<Style>({ color: "red" });
        const writer = createRenderWriter(style);
        let rerender!: (n: number) => void;
        function App() {
          const [n, setN] = useState(0);
          rerender = setN;
          return <><div data-n={n} style={style as never} /><writer.RenderWriter /></>;
        }
        const { container } = mount(<App />, strict);
        const box = container.firstChild as HTMLElement;

        act(() => { style.value = { color: "red", width: 10 }; });
        writer.arm({ color: "red" });
        act(() => { if (transition) startTransition(() => rerender(1)); else rerender(1); });
        await settle();
        expect(style.peek()).toEqual({ color: "red" });
        expect(box.style.cssText).toBe("color: red;");
      });
    }
  }

  it("clears a custom property that only the newer snapshot had", async () => {
    const style = signal<Style>({ "--gap": "1px" });
    const writer = createLayoutWriter(style);
    let rerender!: (n: number) => void;
    function App() {
      const [n, setN] = useState(0);
      rerender = setN;
      return <div data-n={n} style={style as never}><writer.LayoutWriter /></div>;
    }
    const { container } = mount(<App />);
    const box = container.firstChild as HTMLElement;

    act(() => { style.value = { "--gap": "1px", "--accent": "red" }; });
    writer.arm({ "--gap": "2px" });
    act(() => rerender(1));
    await settle();
    expect(box.style.getPropertyValue("--accent")).toBe("");
    expect(box.style.getPropertyValue("--gap")).toBe("2px");
  });

  it("keeps the same subscription when the same signal re-attaches for a new snapshot or user ref", async () => {
    const style = signal<Style>({ color: "red" });
    const writer = createLayoutWriter(style);
    const subscribe = vi.spyOn(coreRuntime, "detachedEffect");
    const refB = createRef<HTMLDivElement>();
    let step!: (n: number) => void;
    function App() {
      const [n, setN] = useState(0);
      step = setN;
      return <div ref={n === 2 ? refB : ignoreNode} data-n={n} style={style as never}><writer.LayoutWriter /></div>;
    }
    const { container } = mount(<App />, true);
    const box = container.firstChild as HTMLElement;
    await settle();

    act(() => { style.value = { color: "red", width: 10 }; });
    writer.arm({ color: "green" });
    act(() => step(1));
    await settle();
    expect(box.style.cssText).toBe("color: green;");

    writer.arm({ color: "blue" });
    act(() => step(2));
    await settle();
    expect(refB.current).toBe(box);
    expect(box.style.cssText).toBe("color: blue;");
    expect(container.firstChild).toBe(box);
    // A V1 readable binding subscribes without the effect bridge, and a kept
    // binding never resubscribes.
    expect(subscribe).not.toHaveBeenCalled();
    expect(coreRuntime.hasSubscribers(style)).toBe(true);
  });

  it("switches signal A → B with a same-commit write to B", async () => {
    const a = signal<Style>({ color: "red", margin: 1 });
    const b = signal<Style>({ color: "blue", width: 10 });
    const writer = createLayoutWriter(b);
    let useB!: (value: boolean) => void;
    function App() {
      const [isB, setIsB] = useState(false);
      useB = setIsB;
      return <div data-b={isB} style={(isB ? b : a) as never}><writer.LayoutWriter /></div>;
    }
    const { container } = mount(<App />);
    const box = container.firstChild as HTMLElement;

    writer.arm({ color: "blue" });
    act(() => useB(true));
    await settle();
    expect(box.style.cssText).toBe("color: blue;");
    expect(coreRuntime.hasSubscribers(a)).toBe(false);
    act(() => { a.value = { color: "red", padding: 4 }; });
    expect(box.style.cssText).toBe("color: blue;");
  });

  it("switches plain → signal and signal → plain around a same-commit write", async () => {
    const style = signal<Style>({ color: "red", width: 10 });
    const writer = createLayoutWriter(style);
    let setMode!: (mode: number) => void;
    function App() {
      const [mode, setModeState] = useState(0);
      setMode = setModeState;
      const value = mode === 1 ? style : { color: "red" };
      return <div data-mode={mode} style={value as never}><writer.LayoutWriter /></div>;
    }
    const { container } = mount(<App />);
    const box = container.firstChild as HTMLElement;

    writer.arm({ color: "green" });
    act(() => setMode(1));
    await settle();
    expect(box.style.cssText).toBe("color: green;");

    act(() => { style.value = { color: "green", height: 3 }; });
    act(() => setMode(2));
    await settle();
    expect(box.style.cssText).toBe("color: red;");
    expect(coreRuntime.hasSubscribers(style)).toBe(false);
    act(() => { style.value = { color: "pink" }; });
    expect(box.style.cssText).toBe("color: red;");
  });

  it("keeps a binding re-attached by an Activity reveal in the same task correct", async () => {
    const style = signal<Style>({ color: "red" });
    let setMode!: (mode: "visible" | "hidden") => void;
    let rerender!: (n: number) => void;
    function Box() {
      const [n, setN] = useState(0);
      rerender = setN;
      return <div id="box" data-n={n} style={style as never} />;
    }
    function App() {
      const [mode, setModeState] = useState<"visible" | "hidden">("visible");
      setMode = setModeState;
      return <Activity mode={mode}><Box /></Activity>;
    }
    const { container } = mount(<App />);
    const box = container.querySelector("#box") as HTMLElement;

    act(() => { style.value = { color: "red", width: 10 }; });
    // Hide, re-render with the newer snapshot, drop a key and reveal, all
    // before the deferred teardown runs, so the binding is kept.
    act(() => {
      flushSync(() => setMode("hidden"));
      flushSync(() => rerender(1));
      style.value = { color: "blue" };
      flushSync(() => setMode("visible"));
    });
    await settle();
    expect(box.style.color).toBe("blue");
    expect(box.style.width).toBe("");
  });

  it("clears a key dropped while a Suspense boundary hid an element that re-rendered", async () => {
    const style = signal<Style>({ color: "red" });
    let pending: Promise<void> | undefined;
    let resolve!: () => void;
    function Suspend() {
      if (pending !== undefined) throw pending;
      return null;
    }
    let rerender!: (n: number) => void;
    function App() {
      const [n, setN] = useState(0);
      rerender = setN;
      return <Suspense fallback={<i>loading</i>}><div id="box" data-n={n} style={style as never} /><Suspend /></Suspense>;
    }
    const { container } = mount(<App />);
    const box = container.querySelector("#box") as HTMLElement;

    act(() => { style.value = { color: "red", width: 10 }; });
    pending = new Promise<void>((done) => { resolve = () => { pending = undefined; done(); }; });
    act(() => rerender(1));
    await settle();
    expect(container.textContent).toContain("loading");
    act(() => { style.value = { color: "blue" }; });
    await act(async () => {
      resolve();
      await new Promise((done) => setTimeout(done, 400));
    });
    await settle();
    expect(container.textContent).not.toContain("loading");
    expect(box.style.cssText).toBe("color: blue;");
  });

  describe("with throwing user refs", () => {
    class Boundary extends Component<{ children: ReactNode }, { message: string | null }> {
      override state = { message: null as string | null };
      static getDerivedStateFromError(error: Error) {
        return { message: error.message };
      }
      override render() {
        return this.state.message === null ? this.props.children : <b id="error">{this.state.message}</b>;
      }
    }

    it("disposes a kept style binding whose re-attach throws, without later writes", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const style = signal<Style>({ color: "red" });
      const writer = createLayoutWriter(style);
      let armed = false;
      const ref = (node: Element | null) => {
        if (node && armed) throw new Error("attach boom");
      };
      let rerender!: (n: number) => void;
      function Inner() {
        const [n, setN] = useState(0);
        rerender = setN;
        return <div ref={ref} data-n={n} style={style as never}><writer.LayoutWriter /></div>;
      }
      const { container } = mount(<Boundary><Inner /></Boundary>);
      const box = container.firstChild as HTMLElement;

      act(() => { style.value = { color: "red", width: 10 }; });
      armed = true;
      writer.arm({ color: "red" });
      act(() => rerender(1));
      await settle();
      expect(container.querySelector("#error")?.textContent).toBe("attach boom");
      expect(coreRuntime.hasSubscribers(style)).toBe(false);
      const removed = box.style.cssText;
      act(() => { style.value = { color: "blue", height: 1 }; });
      expect(box.style.cssText).toBe(removed);
    });

    it("disposes a style binding whose user ref cleanup throws on unmount", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const style = signal<Style>({ color: "red" });
      const ref = throwOnCleanup;
      let unmountTarget!: () => void;
      function Inner() {
        const [visible, setVisible] = useState(true);
        unmountTarget = () => setVisible(false);
        return visible ? <div ref={ref} style={style as never} /> : null;
      }
      const { container } = mount(<Boundary><Inner /></Boundary>, true);
      const box = container.firstChild as HTMLElement;

      act(() => { style.value = { color: "red", width: 10 }; });
      act(() => unmountTarget());
      await settle();
      expect(container.querySelector("#error")?.textContent).toBe("cleanup boom");
      expect(coreRuntime.hasSubscribers(style)).toBe(false);
      const removed = box.style.cssText;
      act(() => { style.value = { color: "blue" }; });
      expect(box.style.cssText).toBe(removed);
    });
  });
});

type Scope = "bare" | "managed";
type HideLane = "transition" | "default" | "discrete";

function createReader(scope: Scope, read: () => unknown, memoized: boolean): ComponentType {
  function BareReader() {
    useSignalTracking();
    return <span id="reader">{String(read())}</span>;
  }
  function ManagedReader() {
    const store = useManagedSignals();
    try {
      return <span id="reader">{String(read())}</span>;
    } finally {
      store.finish();
    }
  }
  const Reader = scope === "bare" ? BareReader : ManagedReader;
  return memoized ? memo(Reader) : Reader;
}

function createActivityApp(Reader: ComponentType) {
  const controls: { setMode: (mode: "visible" | "hidden") => void; setShown: (shown: boolean) => void } = {
    setMode() {},
    setShown() {},
  };
  function App() {
    const [mode, setMode] = useState<"visible" | "hidden">("visible");
    const [shown, setShown] = useState(true);
    controls.setMode = setMode;
    controls.setShown = setShown;
    return (
      <>
        <button id="hide" onClick={() => setMode("hidden")}>hide</button>
        <Activity mode={mode}>{shown ? <Reader /> : null}</Activity>
      </>
    );
  }
  return { App, controls };
}

function hide(container: HTMLElement, controls: { setMode: (mode: "visible" | "hidden") => void }, lane: HideLane) {
  act(() => {
    if (lane === "transition") startTransition(() => controls.setMode("hidden"));
    else if (lane === "default") controls.setMode("hidden");
    else (container.querySelector("#hide") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function createProbe() {
  const source = signal(0);
  let evaluations = 0;
  const value = computed(() => {
    evaluations += 1;
    return source.value;
  });
  return { source, value, evaluations: () => evaluations };
}

describe("B'2: a tracked component deleted inside a hidden Activity releases its subscriptions", () => {
  for (const scope of ["bare", "managed"] as const) {
    for (const strict of STRICT_MODES) {
      for (const lane of ["transition", "default", "discrete"] as const) {
        for (const memoized of [false, true]) {
          it(`${scope}, ${lane} hide, memo=${memoized}, strict=${strict}`, async () => {
            const probe = createProbe();
            const { App, controls } = createActivityApp(createReader(scope, () => probe.value.value, memoized));
            const { container, root } = mount(<App />, strict);
            await settle();
            expect(coreRuntime.hasSubscribers(probe.value)).toBe(true);

            hide(container, controls, lane);
            await settle();
            expect(coreRuntime.hasSubscribers(probe.value)).toBe(false);

            act(() => controls.setShown(false));
            await settle();
            let before = probe.evaluations();
            act(() => { probe.source.value = 1; });
            act(() => { probe.source.value = 2; });
            await settle();
            expect(probe.evaluations()).toBe(before);
            expect(coreRuntime.hasSubscribers(probe.value)).toBe(false);

            act(() => root.unmount());
            roots = roots.filter((entry) => entry !== root);
            await settle();
            before = probe.evaluations();
            act(() => { probe.source.value = 3; });
            await settle();
            expect(probe.evaluations()).toBe(before);
          });
        }
      }

      it(`${scope}: hidden but not deleted, written while hidden, reveals the latest value (strict=${strict})`, async () => {
        const probe = createProbe();
        const { App, controls } = createActivityApp(createReader(scope, () => probe.value.value, false));
        const { container } = mount(<App />, strict);
        await settle();

        hide(container, controls, "transition");
        await settle();
        const before = probe.evaluations();
        act(() => { probe.source.value = 7; });
        act(() => { probe.source.value = 8; });
        await settle();
        expect(probe.evaluations()).toBe(before);

        act(() => controls.setMode("visible"));
        await settle();
        expect(container.querySelector("#reader")?.textContent).toBe("8");
        expect(coreRuntime.hasSubscribers(probe.value)).toBe(true);
        act(() => { probe.source.value = 9; });
        await settle();
        expect(container.querySelector("#reader")?.textContent).toBe("9");
      });

      it(`${scope}: a foreign-copy computed is released on hidden deletion and fresh on reveal (strict=${strict})`, async () => {
        const foreign = createReactiveRuntime();
        const source = foreign.signal(0);
        let evaluations = 0;
        const value = foreign.computed(() => {
          evaluations += 1;
          return source.value * 10;
        });
        const { App, controls } = createActivityApp(createReader(scope, () => value.value, false));
        const { container } = mount(<App />, strict);
        await settle();
        expect(container.querySelector("#reader")?.textContent).toBe("0");
        expect(foreign.hasSubscribers(value)).toBe(true);

        // Hidden, then revealed with a fresh value.
        hide(container, controls, "transition");
        await settle();
        expect(foreign.hasSubscribers(value)).toBe(false);
        act(() => { source.value = 1; });
        act(() => controls.setMode("visible"));
        await settle();
        expect(container.querySelector("#reader")?.textContent).toBe("10");
        expect(foreign.hasSubscribers(value)).toBe(true);
        act(() => { source.value = 2; });
        await settle();
        expect(container.querySelector("#reader")?.textContent).toBe("20");

        // Hidden again, then deleted while hidden.
        hide(container, controls, "default");
        await settle();
        act(() => controls.setShown(false));
        await settle();
        expect(foreign.hasSubscribers(value)).toBe(false);
        const before = evaluations;
        act(() => { source.value = 3; });
        await settle();
        expect(evaluations).toBe(before);
      });
    }

    it(`${scope}: a visible re-render after a Strict Mode effect replay keeps the subscription`, async () => {
      const probe = createProbe();
      let rerender!: (n: number) => void;
      const Reader = createReader(scope, () => probe.value.value, false);
      function App() {
        const [n, setN] = useState(0);
        rerender = setN;
        return <><i>{n}</i><Reader /></>;
      }
      const { container } = mount(<App />, true);
      await settle();
      act(() => rerender(1));
      await settle();
      expect(coreRuntime.hasSubscribers(probe.value)).toBe(true);
      act(() => { probe.source.value = 5; });
      await settle();
      expect(container.querySelector("#reader")?.textContent).toBe("5");
    });
  }
});
