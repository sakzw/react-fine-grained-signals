/** @jsxImportSource react-fine-grained-signals/jsx */
// @vitest-environment jsdom

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { StrictMode, Suspense, use, useEffect } from "react";
import { renderToString } from "react-dom/server";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { computed, effect, signal, useComputed, useSignalValue, useWritableComputed } from "../src/index.js";
import type { ReadonlySignal } from "../src/index.js";
import { releaseComputed } from "../src/core/base.js";
import { coreRuntime } from "../src/core/core-runtime.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

type Readable = { readonly value: unknown; peek(): unknown };
const linkedFromSources = (readable: Readable) => coreRuntime.hasSubscribers(readable);
const linksToSources = (readable: Readable) => coreRuntime.getNodeForReadable(readable)?.deps !== undefined;
// The release after an unmount or a deps change waits a microtask.
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

let gc: (() => void) | undefined;
async function collectGarbage(): Promise<void> {
  if (gc === undefined) {
    setFlagsFromString("--expose-gc");
    gc = runInNewContext("gc") as () => void;
  }
  // A released computed is unreachable only after the finalizer that releases
  // it has run, which takes a collection and a task.
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  }
}

// As in Vue 3.6 with no effect scope: a computed read with no subscriber is
// linked to its sources like any other, so it stays cached, and stays
// reachable from them until something releases it.
describe("a computed with no subscriber", () => {
  it("is linked to its sources and caches until something it read changes", () => {
    const source = signal(1);
    const unrelated = signal(0);
    let runs = 0;
    const doubled = computed(() => {
      runs += 1;
      return source.value * 2;
    });
    expect(doubled.value).toBe(2);
    expect(doubled.peek()).toBe(2);
    expect(runs).toBe(1);
    expect(linkedFromSources(source)).toBe(true);
    unrelated.value = 1;
    expect(doubled.value).toBe(2);
    expect(runs).toBe(1);
    source.value = 3;
    expect(doubled.value).toBe(6);
    expect(runs).toBe(2);
  });

  it("is unlinked and left dirty by a release, and links again on the next read", () => {
    const source = signal(1);
    let runs = 0;
    const inner = computed(() => source.value + 1);
    const outer = computed(() => {
      runs += 1;
      return inner.value * 10;
    });
    expect(outer.value).toBe(20);
    releaseComputed(outer);
    expect(linksToSources(outer)).toBe(false);
    // `inner` lost its last subscriber, so it let go of the source too.
    expect(linkedFromSources(inner)).toBe(false);
    expect(linkedFromSources(source)).toBe(false);
    source.value = 2;
    expect(outer.value).toBe(30);
    expect(runs).toBe(2);
    expect(linkedFromSources(source)).toBe(true);
  });

  it("is left linked by a release while something subscribes to it, and unlinked when that goes", () => {
    const source = signal(1);
    const doubled = computed(() => source.value * 2);
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(doubled.value);
    });
    releaseComputed(doubled);
    source.value = 2;
    expect(seen).toEqual([2, 4]);
    stop();
    expect(linkedFromSources(source)).toBe(false);
    expect(linksToSources(doubled)).toBe(false);
  });

  it("is released with the effect that read it", () => {
    const source = signal(1);
    let stop: () => void = () => {};
    for (let index = 0; index < 3; index += 1) {
      stop();
      stop = effect(() => {
        void computed(() => source.value + index).value;
      });
    }
    stop();
    expect(linkedFromSources(source)).toBe(false);
  });
});

describe("a useComputed computed", () => {
  it("read only by an effect's peek is released when the component unmounts", async () => {
    const source = signal(1);
    let total: ReadonlySignal<number> | undefined;
    let peeked: unknown;
    function Row() {
      const local = useComputed(() => source.value + 1);
      total = local;
      useEffect(() => {
        peeked = local.peek();
      }, [local]);
      return <span>row</span>;
    }
    const view = render(<Row />);
    expect(peeked).toBe(2);
    expect(linkedFromSources(source)).toBe(true);
    view.unmount();
    await settle();
    expect(linkedFromSources(source)).toBe(false);
    expect(linksToSources(total!)).toBe(false);
    // Whoever still holds it reads a current value.
    source.value = 5;
    expect(total!.peek()).toBe(6);
  });

  it("releases the computed a deps change replaces", async () => {
    const source = signal(1);
    const created: Array<ReadonlySignal<number>> = [];
    function Row({ offset }: { offset: number }) {
      const local = useComputed(() => source.value + offset, [offset]);
      if (!created.includes(local)) created.push(local);
      useEffect(() => {
        local.peek();
      }, [local]);
      return null;
    }
    const view = render(<Row offset={1} />);
    view.rerender(<Row offset={2} />);
    await settle();
    expect(created).toHaveLength(2);
    expect(linksToSources(created[0]!)).toBe(false);
    expect(linksToSources(created[1]!)).toBe(true);
    view.unmount();
    await settle();
    expect(linkedFromSources(source)).toBe(false);
  });

  it("releases a writable computed too", async () => {
    const source = signal(1);
    let local: ReadonlySignal<number> | undefined;
    function Row() {
      const doubled = useWritableComputed({ get: () => source.value * 2, set: (value) => (source.value = value / 2) });
      local = doubled;
      useEffect(() => {
        doubled.peek();
      }, [doubled]);
      return null;
    }
    const view = render(<Row />);
    expect(linkedFromSources(source)).toBe(true);
    view.unmount();
    await settle();
    expect(linkedFromSources(source)).toBe(false);
    expect(local!.peek()).toBe(2);
  });

  it("keeps working for a subscriber outside the component after it unmounts", async () => {
    const source = signal(1);
    let shared: ReadonlySignal<number> | undefined;
    function Owner() {
      shared = useComputed(() => source.value * 2);
      return null;
    }
    const view = render(<Owner />);
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(shared!.value);
    });
    view.unmount();
    await settle();
    act(() => {
      source.value = 2;
    });
    expect(seen).toEqual([2, 4]);
    stop();
    expect(linkedFromSources(source)).toBe(false);
  });

  it("passed to a child is released when both unmount in one commit, and not before", async () => {
    const source = signal(1);
    const toggle = signal(true);
    function Child({ total }: { total: ReadonlySignal<number> }) {
      return <output aria-label="total">{useSignalValue(total)}</output>;
    }
    function Parent() {
      const total = useComputed(() => source.value * 2);
      return <Child total={total} />;
    }
    function App() {
      return useSignalValue(toggle) ? <Parent /> : null;
    }
    const view = render(<App />);
    act(() => {
      source.value = 2;
    });
    expect(view.container.textContent).toBe("4");
    act(() => {
      toggle.value = false;
    });
    await settle();
    expect(linkedFromSources(source)).toBe(false);
  });

  it("keeps its cached value through Strict Mode's effect replay", async () => {
    const source = signal(1);
    let runs = 0;
    let total: ReadonlySignal<number> | undefined;
    function Row() {
      const local = useComputed(() => {
        runs += 1;
        return source.value + 1;
      });
      total = local;
      useEffect(() => {
        local.peek();
      }, [local]);
      return null;
    }
    const view = render(
      <StrictMode>
        <Row />
      </StrictMode>,
    );
    await settle();
    expect(runs).toBe(1);
    expect(linksToSources(total!)).toBe(true);
    view.unmount();
    await settle();
    expect(linkedFromSources(source)).toBe(false);
  });

  it("lets its getter closure be collected after the component unmounts", async () => {
    const source = signal(1);
    const references: Array<WeakRef<object>> = [];
    function Row({ index }: { index: number }) {
      const payload = useComputed(() => Array.from({ length: 1000 }, () => index));
      const total = useComputed(() => source.value + payload.peek().length);
      useEffect(() => {
        references.push(new WeakRef(payload.peek()));
        total.peek();
      }, [payload, total]);
      return null;
    }
    const view = render(
      <>
        {Array.from({ length: 10 }, (_, index) => (
          <Row key={index} index={index} />
        ))}
      </>,
    );
    expect(linkedFromSources(source)).toBe(true);
    view.unmount();
    await settle();
    await collectGarbage();
    expect(references).toHaveLength(10);
    expect(references.filter((reference) => reference.deref() !== undefined)).toHaveLength(0);
  });
});

// A render that never commits runs no effect, so nothing unmounts: the
// component's computed is released once React drops the render's memo.
describe("a useComputed computed from a render that never commits", () => {
  const countSubscribers = (readable: Readable) => {
    let count = 0;
    for (let link = coreRuntime.getNodeForReadable(readable)?.subs; link !== undefined; link = link.nextSub) {
      count += 1;
    }
    return count;
  };
  function makeRow(source: ReadonlySignal<number>, suspend?: Promise<never>) {
    return function Row({ index }: { index: number }) {
      const total = useComputed(() => source.value + index);
      const shown = useSignalValue(total);
      if (suspend !== undefined) use(suspend);
      // A closure capturing the computed puts it in the context its getter
      // shares, so the computed stays reachable from the source: the release
      // must not wait for the computed itself to be collected.
      return <span onClick={() => total.peek()}>{shown}</span>;
    };
  }

  it("is released after a server render", async () => {
    const source = signal(1);
    const Row = makeRow(source);
    for (let index = 0; index < 5; index += 1) {
      expect(renderToString(<Row index={index} />)).toContain(String(1 + index));
    }
    expect(countSubscribers(source)).toBe(5);
    await collectGarbage();
    expect(countSubscribers(source)).toBe(0);
  });

  it("is released after a mount that suspends and never resolves", async () => {
    const source = signal(1);
    const Row = makeRow(source, new Promise<never>(() => {}));
    const view = render(<Suspense fallback="loading">{null}</Suspense>);
    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        view.rerender(
          <Suspense fallback="loading">
            <Row key={index} index={index} />
          </Suspense>,
        );
      });
    }
    expect(view.container.textContent).toBe("loading");
    expect(countSubscribers(source)).toBeGreaterThanOrEqual(4);
    view.unmount();
    await collectGarbage();
    // React holds on to its last suspended attempt until it renders again.
    expect(countSubscribers(source)).toBeLessThanOrEqual(1);
  });
});
