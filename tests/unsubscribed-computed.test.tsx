/** @jsxImportSource react-fine-grained-signals/jsx */
// @vitest-environment jsdom

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { StrictMode, Suspense, use, useEffect } from "react";
import { renderToString } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { computed, effect, signal, untracked, useComputed, useSignalValue } from "../src/index.js";
import type { ReadonlySignal } from "../src/index.js";
import { coreRuntime } from "../src/core/core-runtime.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

type Readable = { readonly value: unknown; peek(): unknown };
const linkedFromSources = (readable: Readable) => coreRuntime.hasSubscribers(readable);
const linksToSources = (readable: Readable) => coreRuntime.getNodeForReadable(readable)?.deps !== undefined;

let gc: (() => void) | undefined;
async function collectGarbage(): Promise<void> {
  if (gc === undefined) {
    setFlagsFromString("--expose-gc");
    gc = runInNewContext("gc") as () => void;
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  }
}

// A computed nothing subscribes to must not stay reachable from the sources it
// read: before 0.4 it did, keeping its getter closure alive for as long as any
// of them lived.
describe("a computed with no subscriber", () => {
  it("leaves no link from its sources after a read or a peek", () => {
    const source = signal(1);
    const doubled = computed(() => source.value * 2);
    expect(doubled.value).toBe(2);
    expect(linkedFromSources(source)).toBe(false);
    expect(linksToSources(doubled)).toBe(false);
    source.value = 2;
    expect(doubled.peek()).toBe(4);
    expect(untracked(() => doubled.value)).toBe(4);
    expect(linkedFromSources(source)).toBe(false);
  });

  it("caches its value until something it read changes", () => {
    const source = signal(1);
    const unrelated = signal(0);
    let runs = 0;
    const doubled = computed(() => {
      runs += 1;
      return source.value * 2;
    });
    expect(doubled.value).toBe(2);
    expect(doubled.value).toBe(2);
    expect(doubled.peek()).toBe(2);
    expect(runs).toBe(1);
    unrelated.value = 1;
    expect(doubled.value).toBe(2);
    expect(runs).toBe(1);
    source.value = 3;
    expect(runs).toBe(1);
    expect(doubled.value).toBe(6);
    expect(runs).toBe(2);
  });

  it("re-checks a chain in read order and runs only getters whose inputs changed", () => {
    const flag = signal(true);
    const left = signal(1);
    const right = signal(1);
    const runs = { parity: 0, rightSide: 0, pick: 0 };
    const parity = computed(() => {
      runs.parity += 1;
      return left.value % 2;
    });
    const rightSide = computed(() => {
      runs.rightSide += 1;
      return right.value;
    });
    const pick = computed(() => {
      runs.pick += 1;
      return flag.value ? parity.value : rightSide.value;
    });
    expect(pick.value).toBe(1);
    left.value = 3;
    expect(pick.value).toBe(1);
    expect(runs).toEqual({ parity: 2, rightSide: 0, pick: 1 });
    right.value = 5;
    expect(pick.value).toBe(1);
    expect(runs).toEqual({ parity: 2, rightSide: 0, pick: 1 });
    flag.value = false;
    expect(pick.value).toBe(5);
    expect(runs).toEqual({ parity: 2, rightSide: 1, pick: 2 });
    expect(linkedFromSources(left)).toBe(false);
    expect(linkedFromSources(right)).toBe(false);
    expect(linkedFromSources(parity)).toBe(false);
  });

  it("leaves a computed it read unlinked as well", () => {
    const source = signal(1);
    const inner = computed(() => source.value + 1);
    const outer = computed(() => inner.value * 10);
    expect(outer.value).toBe(20);
    expect(linkedFromSources(source)).toBe(false);
    expect(linkedFromSources(inner)).toBe(false);
    expect(linksToSources(inner)).toBe(false);
  });

  it("links without re-running when subscribed, and unlinks dirty when the last subscriber leaves", () => {
    const source = signal(1);
    let innerRuns = 0;
    let outerRuns = 0;
    const inner = computed(() => {
      innerRuns += 1;
      return source.value + 1;
    });
    const outer = computed(() => {
      outerRuns += 1;
      return inner.value * 10;
    });
    expect(outer.value).toBe(20);
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(outer.value);
    });
    expect([innerRuns, outerRuns]).toEqual([1, 1]);
    expect(linkedFromSources(source)).toBe(true);
    expect(linkedFromSources(inner)).toBe(true);
    source.value = 2;
    expect(seen).toEqual([20, 30]);
    expect([innerRuns, outerRuns]).toEqual([2, 2]);
    stop();
    expect(linkedFromSources(source)).toBe(false);
    expect(linkedFromSources(inner)).toBe(false);
    expect(linksToSources(outer)).toBe(false);
    // Unlinking drops the cache, as v0.3 did: the next read runs the getters
    // again, and caches without links from then on.
    expect(outer.value).toBe(30);
    expect([innerRuns, outerRuns]).toEqual([3, 3]);
    expect(outer.value).toBe(30);
    expect([innerRuns, outerRuns]).toEqual([3, 3]);
    expect(linkedFromSources(source)).toBe(false);
    source.value = 3;
    expect(outer.value).toBe(40);
    expect([innerRuns, outerRuns]).toEqual([4, 4]);
  });

  it("links a dependency that lost its own subscribers without a write in between", () => {
    const source = signal(1);
    let innerRuns = 0;
    const inner = computed(() => {
      innerRuns += 1;
      return source.value + 1;
    });
    const outer = computed(() => inner.value * 10);
    // `inner` is subscribed while `outer` caches through it with no link.
    const stopInner = effect(() => {
      void inner.value;
    });
    expect(outer.value).toBe(20);
    // `inner` loses its subscriber: it detaches dirty, with no write.
    stopInner();
    expect(innerRuns).toBe(1);
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(outer.value);
    });
    expect(seen).toEqual([20]);
    // A write still reaches `outer` through `inner`.
    source.value = 2;
    expect(seen).toEqual([20, 30]);
    stop();
    expect(linkedFromSources(source)).toBe(false);
  });

  it("is subscribed through an effect after a write it has not seen yet", () => {
    const source = signal(1);
    const doubled = computed(() => source.value * 2);
    expect(doubled.value).toBe(2);
    source.value = 2;
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(doubled.value);
    });
    source.value = 3;
    expect(seen).toEqual([4, 6]);
    stop();
  });

  it("disposes the effects its getter creates once the read returns", () => {
    const source = signal(0);
    const live: number[] = [];
    const owner = computed(() => {
      effect(() => {
        live.push(source.value);
        return () => live.pop();
      });
      return 1;
    });
    expect(owner.value).toBe(1);
    expect(live).toEqual([]);
    expect(linkedFromSources(source)).toBe(false);
  });

  it("lets its getter closure be collected", async () => {
    const source = signal(1);
    const references: Array<WeakRef<object>> = [];
    for (let index = 0; index < 20; index += 1) {
      const payload = Array.from({ length: 1000 }, () => index);
      references.push(new WeakRef(payload));
      const total = computed(() => source.value + payload.length);
      if (index % 2 === 0) void total.value;
      else void total.peek();
    }
    await collectGarbage();
    // V8 may keep the last iteration's context alive; a leak keeps all of them.
    expect(references.filter((reference) => reference.deref() !== undefined).length).toBeLessThanOrEqual(1);
  });
});

describe("a useComputed with no subscriber", () => {
  it("is not linked from its source when read by an effect's peek or an event handler", () => {
    const source = signal(1);
    let total: Readable | undefined;
    let peeked: unknown;
    function Row() {
      const local = useComputed(() => source.value + 1);
      total = local;
      useEffect(() => {
        peeked = local.peek();
      }, [local]);
      return <button onClick={() => (peeked = local.value)}>row</button>;
    }
    const view = render(<Row />);
    expect(peeked).toBe(2);
    expect(linkedFromSources(source)).toBe(false);
    act(() => {
      source.value = 5;
    });
    fireEvent.click(screen.getByText("row"));
    expect(peeked).toBe(6);
    expect(linkedFromSources(source)).toBe(false);
    expect(linksToSources(total!)).toBe(false);
    view.unmount();
    expect(linkedFromSources(source)).toBe(false);
  });

  it("is linked while useSignalValue subscribes it and unlinked after unmount", () => {
    const source = signal(1);
    let runs = 0;
    function Row() {
      const total = useComputed(() => {
        runs += 1;
        return source.value * 2;
      });
      return <output aria-label="total">{useSignalValue(total)}</output>;
    }
    const view = render(<Row />);
    expect(screen.getByLabelText("total").textContent).toBe("2");
    expect(linkedFromSources(source)).toBe(true);
    const mountRuns = runs;
    act(() => {
      source.value = 2;
    });
    expect(screen.getByLabelText("total").textContent).toBe("4");
    expect(runs).toBe(mountRuns + 1);
    view.unmount();
    expect(linkedFromSources(source)).toBe(false);
  });

  it("keeps its cached value through Strict Mode's effect replay", () => {
    const source = signal(1);
    let runs = 0;
    let total: Readable | undefined;
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
    expect(runs).toBe(1);
    expect(linksToSources(total!)).toBe(false);
    view.unmount();
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
    expect(linkedFromSources(source)).toBe(false);
    view.unmount();
    await collectGarbage();
    expect(references).toHaveLength(10);
    expect(references.filter((reference) => reference.deref() !== undefined)).toHaveLength(0);
  });
});

function makeRow(source: ReadonlySignal<number>, suspend?: Promise<never>) {
  return function Row({ index }: { index: number }) {
    const total = useComputed(() => source.value + index);
    const shown = useSignalValue(total);
    if (suspend !== undefined) use(suspend);
    return <span onClick={() => total.peek()}>{shown}</span>;
  };
}

// A render that never commits runs no effect, so nothing subscribes and
// nothing unmounts: the computed it created must still leave no link behind.
describe("a useComputed computed from a render that never commits", () => {
  it("leaves no link after a server render", () => {
    const source = signal(1);
    const Row = makeRow(source);
    for (let index = 0; index < 5; index += 1) {
      expect(renderToString(<Row index={index} />)).toContain(String(1 + index));
    }
    expect(linkedFromSources(source)).toBe(false);
  });

  it("leaves no link after a mount that suspends and never resolves", async () => {
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
    expect(linkedFromSources(source)).toBe(false);
    view.unmount();
  });
});
