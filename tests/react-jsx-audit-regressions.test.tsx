/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import {
  Activity,
  Component,
  StrictMode,
  Suspense,
  act,
  memo,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { computed, signal, type Signal } from "../src/index.js";

// Regression coverage for the React / JSX release audit of v0.2.0:
// B1 — a throwing user ref must not leak the element's direct bindings;
// B2 — a new `style={signal}` binding must clear keys React wrote from its
// render-time snapshot.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Lets the deferred binding teardown (a microtask after detach) run. */
const flushMicrotasks = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

type Mounted = { container: HTMLElement; root: Root; caught: unknown[] };
const mountedRoots: Mounted[] = [];

/** A root whose caught errors are recorded rather than logged. */
function mount(element: ReactNode): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const caught: unknown[] = [];
  const root = createRoot(container, { onCaughtError: (error) => { caught.push(error); } });
  act(() => root.render(element));
  const mounted = { container, root, caught };
  mountedRoots.push(mounted);
  return mounted;
}

afterEach(() => {
  for (const { container, root } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <output id="fallback">failed</output> : this.props.children;
  }
}

/**
 * A bound source that counts its evaluations: a computed with no subscriber is
 * lazy, so a write to `base` re-evaluates it only while a binding still
 * subscribes to it.
 */
function countedSource(initial: string) {
  const base = signal(initial);
  let evaluations = 0;
  const source = computed(() => {
    evaluations += 1;
    return base.value;
  });
  return { base, source, evaluations: () => evaluations };
}

describe("B1: a throwing user ref does not leak the element's bindings", () => {
  it("cleans up when the user's ref cleanup throws on unmount", async () => {
    const { base, source, evaluations } = countedSource("a");
    const boom = new Error("ref cleanup boom");
    const userRef = (node: Element | null) => {
      if (node) return () => { throw boom; };
    };
    let setVisible!: (visible: boolean) => void;
    function App() {
      const [visible, set] = useState(true);
      setVisible = set;
      return visible ? <div id="target" className={source} ref={userRef} /> : null;
    }
    const { container, caught } = mount(<Boundary><App /></Boundary>);
    const node = container.querySelector("#target")!;
    base.value = "b";
    expect(node.className).toBe("b");

    act(() => setVisible(false));
    await flushMicrotasks();
    expect(caught).toEqual([boom]);

    const before = evaluations();
    base.value = "after-unmount";
    expect(node.className).not.toBe("after-unmount");
    expect(evaluations()).toBe(before);
  });

  it("cleans up when the user's ref cleanup throws as a signal prop switches to a plain value", async () => {
    const { base, source, evaluations } = countedSource("a");
    const boom = new Error("ref cleanup boom");
    const userRef = (node: Element | null) => {
      if (node) return () => { throw boom; };
    };
    let setBound!: (bound: boolean) => void;
    function App() {
      const [bound, set] = useState(true);
      setBound = set;
      return <div id="target" className={bound ? source : "plain"} ref={userRef} />;
    }
    const { container, caught } = mount(<Boundary><App /></Boundary>);
    const node = container.querySelector("#target")!;

    act(() => setBound(false));
    await flushMicrotasks();
    // The swap attaches the user's ref again through the new binding ref, so
    // the boundary's unmount of the subtree runs (and throws from) it once more.
    expect(caught.length).toBeGreaterThan(0);
    for (const error of caught) expect(error).toBe(boom);
    expect(container.querySelector("#fallback")).not.toBeNull();

    const before = evaluations();
    const className = node.className;
    base.value = "after-switch";
    expect(node.className).toBe(className);
    expect(evaluations()).toBe(before);
  });

  it("cleans up when the user's ref throws while attaching", async () => {
    const { base, source, evaluations } = countedSource("a");
    const boom = new Error("ref attach boom");
    let attached: Element | null = null;
    const userRef = (node: Element | null) => {
      if (node) {
        attached = node;
        throw boom;
      }
    };
    const { container, caught } = mount(<Boundary><div id="target" className={source} ref={userRef} /></Boundary>);
    await flushMicrotasks();
    expect(caught).toEqual([boom]);
    expect(container.querySelector("#fallback")).not.toBeNull();

    const node = attached as Element | null;
    expect(node).not.toBeNull();
    const before = evaluations();
    base.value = "after-fallback";
    expect(node!.className).toBe("a");
    expect(evaluations()).toBe(before);
  });

  it("keeps StrictMode's attach, detach, attach, detach cycle working", async () => {
    const { base, source, evaluations } = countedSource("a");
    const log: string[] = [];
    const userRef = (node: Element | null) => {
      if (!node) return;
      log.push("attach");
      return () => { log.push("cleanup"); };
    };
    let setVisible!: (visible: boolean) => void;
    function App() {
      const [visible, set] = useState(true);
      setVisible = set;
      return visible ? <div id="target" className={source} ref={userRef} /> : null;
    }
    const { container } = mount(<StrictMode><App /></StrictMode>);
    const node = container.querySelector("#target")!;
    await flushMicrotasks();
    expect(log).toEqual(["attach", "cleanup", "attach"]);

    base.value = "b";
    expect(node.className).toBe("b");

    act(() => setVisible(false));
    await flushMicrotasks();
    expect(log).toEqual(["attach", "cleanup", "attach", "cleanup"]);
    const before = evaluations();
    base.value = "after-unmount";
    expect(node.className).not.toBe("after-unmount");
    expect(evaluations()).toBe(before);
  });

  for (const [label, throwingCleanup] of [["replayed", 1], ["final", 2]] as const) {
    it(`cleans up when the user's ref cleanup throws during StrictMode's ${label} detach`, async () => {
      const { base, source, evaluations } = countedSource("a");
      const boom = new Error(`strict ${label} cleanup boom`);
      let cleanups = 0;
      let attached: Element | null = null;
      const userRef = (node: Element | null) => {
        if (!node) return;
        attached = node;
        return () => {
          cleanups += 1;
          if (cleanups === throwingCleanup) throw boom;
        };
      };
      let setVisible!: (visible: boolean) => void;
      function App() {
        const [visible, set] = useState(true);
        setVisible = set;
        return visible ? <div id="target" className={source} ref={userRef} /> : null;
      }
      const { caught } = mount(<StrictMode><Boundary><App /></Boundary></StrictMode>);
      await flushMicrotasks();
      // A replayed-detach error unmounts the subtree right away; otherwise
      // the final detach comes from unmounting the element.
      if (throwingCleanup === 2) act(() => setVisible(false));
      await flushMicrotasks();
      expect(caught).toEqual([boom]);

      const node = attached as Element | null;
      expect(node).not.toBeNull();
      const before = evaluations();
      base.value = "after-unmount";
      expect(node!.className).not.toBe("after-unmount");
      expect(evaluations()).toBe(before);
    });
  }
});

type Style = Record<string, string>;

/** Writes `next` to `source` from a layout effect that runs before the bound element's ref attaches. */
function WriteBeforeAttach({ source, next, when = true }: { source: Signal<Style>; next: Style; when?: boolean }) {
  useLayoutEffect(() => {
    if (when) source.value = next;
  }, [source, next, when]);
  return null;
}

describe("B2: a new style binding clears keys React wrote from its snapshot", () => {
  it("clears a snapshot key the signal dropped between render and the initial attach", () => {
    const style = signal<Style>({ color: "red", display: "grid" });
    const { container } = mount(
      <>
        <WriteBeforeAttach source={style} next={{ color: "blue" }} />
        <div id="target" style={style} />
      </>,
    );
    const node = container.querySelector<HTMLElement>("#target")!;
    expect(node.style.color).toBe("blue");
    expect(node.style.display).toBe("");
  });

  it("clears a custom property the signal dropped between render and the initial attach", () => {
    const style = signal<Style>({ "--x": "1", color: "red" });
    const { container } = mount(
      <>
        <WriteBeforeAttach source={style} next={{ color: "blue" }} />
        <div id="target" style={style} />
      </>,
    );
    const node = container.querySelector<HTMLElement>("#target")!;
    expect(node.style.color).toBe("blue");
    expect(node.style.getPropertyValue("--x")).toBe("");
  });

  it("adds and removes keys across later writes", () => {
    const style = signal<Style>({ color: "red" });
    const { container } = mount(<div id="target" style={style} />);
    const node = container.querySelector<HTMLElement>("#target")!;

    style.value = { color: "red", display: "grid" };
    expect(node.style.display).toBe("grid");
    style.value = { color: "green" };
    expect(node.getAttribute("style")).toBe("color: green;");
  });

  it("clears stale keys when a plain style switches to a signal on the same node", () => {
    const style = signal<Style>({ color: "red", display: "grid" });
    let setBound!: (bound: boolean) => void;
    function App() {
      const [bound, set] = useState(false);
      setBound = set;
      return (
        <>
          <WriteBeforeAttach source={style} next={{ color: "blue" }} when={bound} />
          <div id="target" style={bound ? style : { color: "red", display: "grid" }}>
            <input defaultValue="" />
          </div>
        </>
      );
    }
    const { container } = mount(<App />);
    const node = container.querySelector<HTMLElement>("#target")!;
    const child = node.querySelector("input")!;
    child.value = "typed";

    act(() => setBound(true));
    expect(container.querySelector("#target")).toBe(node);
    expect(child.value).toBe("typed");
    expect(node.getAttribute("style")).toBe("color: blue;");
  });

  it("clears keys from the previous signal when switching to a signal with fewer keys", () => {
    const a = signal<Style>({ color: "red", display: "grid" });
    const b = signal<Style>({ color: "blue" });
    let setUseB!: (useB: boolean) => void;
    function App() {
      const [useB, set] = useState(false);
      setUseB = set;
      return <div id="target" style={useB ? b : a} />;
    }
    const { container } = mount(<App />);
    const node = container.querySelector<HTMLElement>("#target")!;
    // A key React never saw, written by the binding after render.
    a.value = { color: "red", display: "grid", fontWeight: "bold" };

    act(() => setUseB(true));
    expect(container.querySelector("#target")).toBe(node);
    expect(node.getAttribute("style")).toBe("color: blue;");
  });

  it("clears a key dropped while an Activity boundary hid an element whose owner does not re-render", async () => {
    const style = signal<Style>({ color: "red", display: "grid" });
    const Box = memo(() => <div id="target" style={style} />);
    let setMode!: (mode: "visible" | "hidden") => void;
    function App() {
      const [mode, set] = useState<"visible" | "hidden">("visible");
      setMode = set;
      return <Activity mode={mode}><Box /></Activity>;
    }
    const { container } = mount(<App />);
    const node = container.querySelector<HTMLElement>("#target")!;

    act(() => setMode("hidden"));
    await flushMicrotasks();
    style.value = { color: "blue" };
    act(() => setMode("visible"));
    await flushMicrotasks();

    expect(node.getAttribute("style")).toBe("color: blue;");
    style.value = { color: "green" };
    expect(node.getAttribute("style")).toBe("color: green;");
  });

  it("clears a key dropped while a Suspense boundary hid the element", async () => {
    const style = signal<Style>({ display: "flex", color: "red" });
    let resolve!: () => void;
    let pending: Promise<void> | undefined;
    let resolved = false;
    function MaybeSuspend() {
      if (pending !== undefined && !resolved) throw pending;
      return null;
    }
    let setAttempt!: (attempt: number) => void;
    function App() {
      const [attempt, set] = useState(0);
      setAttempt = set;
      return (
        <Suspense fallback={<span id="fallback">loading</span>}>
          <div id="target" style={style} />
          <MaybeSuspend key={attempt} />
        </Suspense>
      );
    }
    const { container } = mount(<App />);
    const node = container.querySelector<HTMLElement>("#target")!;

    style.value = { display: "grid", color: "blue" };
    pending = new Promise<void>((done) => {
      resolve = () => {
        resolved = true;
        done();
      };
    });
    act(() => setAttempt(1));
    await flushMicrotasks();
    expect(container.querySelector("#fallback")).not.toBeNull();

    style.value = { color: "green" };
    await act(async () => {
      resolve();
      await pending;
    });
    await flushMicrotasks();

    expect(container.querySelector("#fallback")).toBeNull();
    expect(node.style.display).toBe("");
    expect(node.style.color).toBe("green");
  });
});
