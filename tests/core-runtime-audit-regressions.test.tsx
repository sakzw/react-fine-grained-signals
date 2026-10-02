/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { act } from "react";
import { renderToPipeableStream, renderToString } from "react-dom/server";
import { PassThrough } from "node:stream";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReadableInteropV1 } from "../src/core/interop.js";
import { createReactiveRuntime } from "../src/core/reactive-runtime.js";
import { computed, effect, signal, useSignalTracking } from "../src/index.js";
import { useManagedSignals } from "../src/runtime.js";

// Regression coverage for the v0.2.0 core runtime release audit (A1-A6) and
// its two follow-up checks. Two `createReactiveRuntime()` instances stand in
// for two installed package copies: each owns its own graph and they meet
// only through the shared execution owner and ReadableInterop V1.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

type Runtime = ReturnType<typeof createReactiveRuntime>;
type Attempt = ReturnType<Runtime["renderAdapter"]["createRenderAttempt"]>;

function renderAttempt<T>(runtime: Runtime, read: () => T, scopePolicy: "managed" | "bare" = "managed") {
  const attempt = runtime.renderAdapter.createRenderAttempt();
  let value!: T;
  runtime.renderAdapter.withRenderScope(attempt, () => { value = read(); }, scopePolicy);
  return { attempt, value };
}

const subscriptions: Array<() => void> = [];
afterEach(() => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
});

/**
 * Commits an attempt as RenderStore.commit does -- promote, subscribe to its
 * local dependencies, settle -- and reports whether it must re-render.
 */
function commitNeedsRerender(runtime: Runtime, attempt: Attempt): boolean {
  let changed = !runtime.renderAdapter.promoteRenderAttempt(attempt);
  const local = [...attempt.dependencies.keys()].filter((dependency) => runtime.getNodeForReadable(dependency as never) !== undefined);
  if (local.length > 0) subscriptions.push(runtime.renderAdapter.subscribeReadables(local, () => {}));
  if (!runtime.renderAdapter.settleRenderAttempt(attempt)) changed = true;
  return changed;
}

describe("A1: promoting a speculative computed that read another copy", () => {
  for (const scopePolicy of ["managed", "bare"] as const) {
    it(`promotes over a foreign signal and follows it afterwards (${scopePolicy} scope)`, () => {
      const app = createReactiveRuntime();
      const library = createReactiveRuntime();
      const count = library.signal(1);
      const doubled = app.computed(() => count.value * 2);

      const { attempt, value } = renderAttempt(app, () => doubled.value, scopePolicy);
      expect(value).toBe(2);
      expect(() => app.renderAdapter.promoteRenderAttempt(attempt)).not.toThrow();
      expect(app.renderAdapter.settleRenderAttempt(attempt)).toBe(true);

      const seen: number[] = [];
      const stop = app.effect(() => { seen.push(doubled.value); });
      count.value = 5;
      expect(seen).toEqual([2, 10]);
      stop();
      count.value = 6;
      expect(doubled.value).toBe(12);
    });

    it(`promotes over a foreign computed and follows it afterwards (${scopePolicy} scope)`, () => {
      const app = createReactiveRuntime();
      const library = createReactiveRuntime();
      const count = library.signal(1);
      const tripled = library.computed(() => count.value * 3);
      const label = app.computed(() => `n=${tripled.value}`);

      const { attempt, value } = renderAttempt(app, () => label.value, scopePolicy);
      expect(value).toBe("n=3");
      expect(commitNeedsRerender(app, attempt)).toBe(false);

      const seen: string[] = [];
      const stop = app.effect(() => { seen.push(label.value); });
      count.value = 2;
      expect(seen).toEqual(["n=3", "n=6"]);
      stop();
    });
  }

  it("does not promote when the foreign revision moved before commit", () => {
    const app = createReactiveRuntime();
    const library = createReactiveRuntime();
    const count = library.signal(1);
    const doubled = app.computed(() => count.value * 2);

    const { attempt } = renderAttempt(app, () => doubled.value);
    count.value = 4;
    expect(app.renderAdapter.promoteRenderAttempt(attempt)).toBe(false);
    expect(doubled.value).toBe(8);
  });

  for (const hook of ["useSignalTracking", "useManagedSignals"] as const) {
    it(`mounts and updates a ${hook}() component reading a local computed over a foreign signal`, () => {
      const library = createReactiveRuntime();
      const count = library.signal(1);
      const doubled = computed(() => count.value * 2);

      function Bare() {
        useSignalTracking();
        return <p>{`doubled=${doubled.value}`}</p>;
      }
      function Managed() {
        const scope = useManagedSignals();
        try {
          return <p>{`doubled=${doubled.value}`}</p>;
        } finally {
          scope.finish();
        }
      }
      const View = hook === "useSignalTracking" ? Bare : Managed;

      const view = render(<View />);
      expect(view.container.textContent).toBe("doubled=2");
      act(() => { count.value = 5; });
      expect(view.container.textContent).toBe("doubled=10");
    });
  }
});

describe("A2: render attempts that observed different values of one computed", () => {
  it("re-renders the earlier attempt when a later attempt promoted first", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(1);
    const scaled = runtime.computed(() => source.value * 10);

    const parent = renderAttempt(runtime, () => scaled.value);
    source.value = 2;
    const child = renderAttempt(runtime, () => scaled.value);
    expect([parent.value, child.value]).toEqual([10, 20]);

    expect(commitNeedsRerender(runtime, child.attempt)).toBe(false);
    expect(commitNeedsRerender(runtime, parent.attempt)).toBe(true);
    expect(scaled.value).toBe(20);
  });

  it("re-renders the earlier attempt when it commits first", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(1);
    const scaled = runtime.computed(() => source.value * 10);

    const parent = renderAttempt(runtime, () => scaled.value);
    source.value = 2;
    const child = renderAttempt(runtime, () => scaled.value);

    expect(commitNeedsRerender(runtime, parent.attempt)).toBe(true);
    expect(commitNeedsRerender(runtime, child.attempt)).toBe(false);
  });

  it("re-renders the earlier attempt over a computed that was warm before both", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(1);
    const scaled = runtime.computed(() => source.value * 10);
    expect(scaled.value).toBe(10);
    source.value = 5;

    const parent = renderAttempt(runtime, () => scaled.value);
    source.value = 2;
    const child = renderAttempt(runtime, () => scaled.value);
    expect([parent.value, child.value]).toEqual([50, 20]);

    expect(commitNeedsRerender(runtime, child.attempt)).toBe(false);
    expect(commitNeedsRerender(runtime, parent.attempt)).toBe(true);
  });

  it("keeps both attempts stable when they observed equal values", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(1);
    const parity = runtime.computed(() => source.value % 2);

    const parent = renderAttempt(runtime, () => parity.value);
    source.value = 3;
    const child = renderAttempt(runtime, () => parity.value);

    expect(commitNeedsRerender(runtime, child.attempt)).toBe(false);
    expect(commitNeedsRerender(runtime, parent.attempt)).toBe(false);
  });

  it("re-renders an attempt that saw a value once another promoted an error", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(1);
    const checked = runtime.computed(() => {
      if (source.value > 1) throw new Error("too large");
      return source.value;
    });

    const parent = renderAttempt(runtime, () => checked.value);
    source.value = 2;
    const child = renderAttempt(runtime, () => { try { return checked.value; } catch { return "error"; } });
    expect([parent.value, child.value]).toEqual([1, "error"]);

    expect(commitNeedsRerender(runtime, child.attempt)).toBe(false);
    expect(commitNeedsRerender(runtime, parent.attempt)).toBe(true);
  });

  it("is unaffected by an aborted attempt that never commits", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(1);
    const scaled = runtime.computed(() => source.value * 10);

    renderAttempt(runtime, () => scaled.value);
    source.value = 2;
    const committed = renderAttempt(runtime, () => scaled.value);
    expect(commitNeedsRerender(runtime, committed.attempt)).toBe(false);
    source.value = 3;
    expect(scaled.value).toBe(30);
  });
});

describe("A3: cross-copy graphs expose only states a write produced", () => {
  it("runs one coherent effect per write through a mixed diamond", () => {
    const app = createReactiveRuntime();
    const library = createReactiveRuntime();
    const qty = library.signal(1);
    const subtotal = library.computed(() => qty.value * 10);
    const label = app.computed(() => `${qty.value} items`);
    const summary = app.computed(() => `${label.value} = $${subtotal.value}`);

    const seen: string[] = [];
    const stop = app.effect(() => { seen.push(summary.value); });
    qty.value = 2;
    qty.value = 3;
    expect(seen).toEqual(["1 items = $10", "2 items = $20", "3 items = $30"]);
    stop();
  });

  it("recomputes a diamond whose sides live in different copies once per write", () => {
    const app = createReactiveRuntime();
    const library = createReactiveRuntime();
    const source = library.signal(1);
    const left = app.computed(() => source.value + 1);
    const right = library.computed(() => source.value * 2);
    let evaluations = 0;
    const sum = app.computed(() => { evaluations += 1; return left.value + right.value; });

    const seen: number[] = [];
    const stop = app.effect(() => { seen.push(sum.value); });
    source.value = 2;
    source.value = 3;
    expect(seen).toEqual([4, 7, 10]);
    expect(evaluations).toBe(3);
    stop();
  });

  it("follows a chain that crosses copies twice", () => {
    const app = createReactiveRuntime();
    const library = createReactiveRuntime();
    const source = app.signal(1);
    const middle = library.computed(() => source.value + 1);
    const outer = app.computed(() => `${source.value}/${middle.value}`);

    const seen: string[] = [];
    const stop = app.effect(() => { seen.push(outer.value); });
    source.value = 2;
    source.value = 3;
    expect(seen).toEqual(["1/2", "2/3", "3/4"]);
    stop();
  });

  for (const watched of [true, false]) {
    it(`reads its own write inside the other copy's batch (${watched ? "active" : "cold"} bridge)`, () => {
      const app = createReactiveRuntime();
      const library = createReactiveRuntime();
      const source = library.signal(0);
      const scaled = app.computed(() => source.value * 10);
      const stop = watched ? app.effect(() => { void scaled.value; }) : () => {};
      expect(scaled.value).toBe(0);

      const reads: number[] = [];
      library.batch(() => {
        source.value = 1;
        reads.push(scaled.value);
        source.value = 2;
        reads.push(scaled.value);
      });
      expect(reads).toEqual([10, 20]);
      expect(scaled.value).toBe(20);
      stop();
    });
  }

  it("still notifies an effect on the bridge after a read learned the revision first", () => {
    const app = createReactiveRuntime();
    const library = createReactiveRuntime();
    const source = library.signal(0);
    const mirror = app.computed(() => source.value);
    const seen: number[] = [];
    const stop = app.effect(() => { seen.push(source.value); });

    library.batch(() => {
      source.value = 1;
      expect(mirror.value).toBe(1);
    });
    expect(seen).toEqual([0, 1]);
    stop();
  });

  it("does not re-evaluate a cold foreign-dependent computed on every read", () => {
    const app = createReactiveRuntime();
    const library = createReactiveRuntime();
    const source = library.signal(0);
    let evaluations = 0;
    const mirror = app.computed(() => { evaluations += 1; return source.value; });

    expect(mirror.value).toBe(0);
    source.value = 1;
    expect(mirror.value).toBe(1);
    const settled = evaluations;
    expect([mirror.value, mirror.value, mirror.value]).toEqual([1, 1, 1]);
    expect(evaluations).toBe(settled);
    source.value = 2;
    expect(mirror.value).toBe(2);
  });

  it("keeps two cold readers of one bridge current when only one re-reads", () => {
    const app = createReactiveRuntime();
    const library = createReactiveRuntime();
    const source = library.signal(0);
    const first = app.computed(() => source.value + 1);
    const second = app.computed(() => source.value + 2);
    const outer = app.computed(() => second.value * 10);

    expect([first.value, outer.value]).toEqual([1, 20]);
    source.value = 5;
    expect(first.value).toBe(6);
    expect(outer.value).toBe(70);
  });
});

describe("A4: computed getters are called as () => T", () => {
  it("passes no arguments and no this on the graph path", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(0);
    const calls: Array<{ self: unknown; count: number }> = [];
    const value = runtime.computed(function (this: unknown, ...args: unknown[]) {
      calls.push({ self: this, count: args.length });
      return source.value;
    });

    value.value;
    source.value = 1;
    value.value;
    source.value = 2;
    value.value;
    expect(calls).toEqual([
      { self: undefined, count: 0 },
      { self: undefined, count: 0 },
      { self: undefined, count: 0 },
    ]);
  });

  it("applies a default parameter on every recomputation", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(0);
    function total(offset = 100) { return source.value + offset; }
    const value = runtime.computed(total);

    const seen = [value.value];
    for (const next of [1, 2, 3]) {
      source.value = next;
      seen.push(value.value);
    }
    expect(seen).toEqual([100, 101, 102, 103]);
  });

  it("passes no arguments and no this on a speculative render's first read", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(1);
    const calls: Array<{ self: unknown; count: number }> = [];
    function total(this: unknown, offset = 100) {
      calls.push({ self: this, count: arguments.length });
      return source.value + offset;
    }
    const value = runtime.computed(total);

    const first = renderAttempt(runtime, () => value.value);
    expect(first.value).toBe(101);
    expect(commitNeedsRerender(runtime, first.attempt)).toBe(false);
    source.value = 2;
    const second = renderAttempt(runtime, () => value.value);
    expect(second.value).toBe(102);
    expect(calls.every(({ self, count }) => self === undefined && count === 0)).toBe(true);
  });

  it("matches v0.1.1 in a tracked component's first render", () => {
    const source = signal(1);
    function total(offset = 100) { return source.value + offset; }
    const value = computed(total);
    function View() {
      useSignalTracking();
      return <p>{value.value}</p>;
    }

    const view = render(<View />);
    expect(view.container.textContent).toBe("101");
    act(() => { source.value = 2; });
    expect(view.container.textContent).toBe("102");
    act(() => { source.value = 3; });
    expect(view.container.textContent).toBe("103");
  });
});

describe("A5: effects created under another copy's owner", () => {
  for (const direction of ["A owns B", "B owns A"] as const) {
    it(`are disposed when the owner re-runs or is disposed (${direction})`, () => {
      const first = createReactiveRuntime();
      const second = createReactiveRuntime();
      const [owner, child] = direction === "A owns B" ? [first, second] : [second, first];
      const route = owner.signal("a");
      const tick = child.signal(0);
      const log: string[] = [];
      let cleanups = 0;

      const stop = owner.effect(() => {
        const current = route.value;
        child.effect(() => {
          log.push(`${current}${tick.value}`);
          return () => { cleanups += 1; };
        });
      });
      route.value = "b";
      route.value = "c";
      expect(cleanups).toBe(2);
      tick.value = 1;
      expect(log).toEqual(["a0", "b0", "c0", "c1"]);
      expect(cleanups).toBe(3);

      stop();
      expect(cleanups).toBe(4);
      tick.value = 2;
      expect(log).toEqual(["a0", "b0", "c0", "c1"]);
      expect(child.hasSubscribers(tick)).toBe(false);
    });
  }

  it("are disposed when an owning computed re-evaluates or loses its last subscriber", () => {
    const app = createReactiveRuntime();
    const library = createReactiveRuntime();
    const source = app.signal(0);
    const tick = library.signal(0);
    const log: string[] = [];
    let cleanups = 0;
    const owner = app.computed(() => {
      const current = source.value;
      library.effect(() => {
        log.push(`${current}:${tick.value}`);
        return () => { cleanups += 1; };
      });
      return current;
    });

    const stop = app.effect(() => { void owner.value; });
    source.value = 1;
    tick.value = 1;
    expect(log).toEqual(["0:0", "1:0", "1:1"]);
    expect(cleanups).toBe(2);
    stop();
    expect(cleanups).toBe(3);
    tick.value = 2;
    expect(log).toEqual(["0:0", "1:0", "1:1"]);
  });

  it("disposes a same-copy child exactly once", () => {
    const runtime = createReactiveRuntime();
    const route = runtime.signal(0);
    let cleanups = 0;
    const stop = runtime.effect(() => {
      void route.value;
      runtime.effect(() => () => { cleanups += 1; });
    });
    route.value = 1;
    expect(cleanups).toBe(1);
    stop();
    expect(cleanups).toBe(2);
  });

  it("leaves a foreign child the user disposed alone on the owner's next run", () => {
    const app = createReactiveRuntime();
    const library = createReactiveRuntime();
    const route = app.signal(0);
    let cleanups = 0;
    let disposeChild: (() => void) | undefined;
    const stop = app.effect(() => {
      void route.value;
      disposeChild = library.effect(() => () => { cleanups += 1; });
    });
    disposeChild!();
    expect(cleanups).toBe(1);
    route.value = 1;
    expect(cleanups).toBe(1);
    stop();
    expect(cleanups).toBe(2);
  });

  it("does not own a detached effect", () => {
    const app = createReactiveRuntime();
    const library = createReactiveRuntime();
    const route = app.signal(0);
    const tick = library.signal(0);
    const log: number[] = [];
    let disposeDetached: (() => void) | undefined;
    const stop = app.effect(() => {
      void route.value;
      disposeDetached ??= library.detachedEffect(() => { log.push(tick.value); });
    });
    route.value = 1;
    stop();
    tick.value = 1;
    expect(log).toEqual([0, 1]);
    disposeDetached!();
  });

  it("does not own an effect created under untracked()", () => {
    const app = createReactiveRuntime();
    const library = createReactiveRuntime();
    const route = app.signal(0);
    const tick = library.signal(0);
    const log: number[] = [];
    let disposeChild: (() => void) | undefined;
    const stop = app.effect(() => {
      void route.value;
      disposeChild ??= app.untracked(() => library.effect(() => { log.push(tick.value); }));
    });
    route.value = 1;
    stop();
    tick.value = 1;
    expect(log).toEqual([0, 1]);
    disposeChild!();
  });
});

describe("A6: re-subscribing to a foreign readable", () => {
  it("runs a new effect on a reused foreign signal once", () => {
    const app = createReactiveRuntime();
    const library = createReactiveRuntime();
    const source = library.signal(0);
    let runs = 0;
    app.effect(() => { void source.value; runs += 1; })();
    source.value = 1;

    const seen: number[] = [];
    const stop = app.effect(() => { runs += 1; seen.push(source.value); });
    expect(runs).toBe(2);
    source.value = 2;
    expect(seen).toEqual([1, 2]);
    stop();
  });

  it("runs a new effect on a reused foreign computed once", () => {
    const app = createReactiveRuntime();
    const library = createReactiveRuntime();
    const source = library.signal(0);
    const doubled = library.computed(() => source.value * 2);
    const seen: number[] = [];
    let stop = app.effect(() => { seen.push(doubled.value); });
    stop();
    source.value = 1;
    stop = app.effect(() => { seen.push(doubled.value); });
    source.value = 2;
    stop();
    source.value = 3;
    stop = app.effect(() => { seen.push(doubled.value); });
    expect(seen).toEqual([0, 2, 4, 6]);
    stop();
  });

  it("still retries a reused bridge whose subscription reports a newer revision", () => {
    const runtime = createReactiveRuntime();
    let revision = 0;
    let subscribedAt = 0;
    let notify: ((next: number) => void) | undefined;
    const protocol: ReadableInteropV1 = {
      version: 1,
      runtimeToken: {},
      getRevision: () => revision,
      subscribe(listener) {
        notify = listener;
        return { unsubscribe: () => { notify = undefined; }, revision: subscribedAt };
      },
    };
    let runs = 0;
    runtime.effect(() => { runs += 1; runtime.graphOwner.add(protocol, revision); })();
    expect(runs).toBe(1);

    // The read observes revision 1, but the source moved to 2 before subscribing.
    revision = 1;
    subscribedAt = 2;
    const stop = runtime.effect(() => {
      runs += 1;
      runtime.graphOwner.add(protocol, revision);
      revision = 2;
    });
    expect(runs).toBe(3);
    revision = 3;
    notify!(3);
    expect(runs).toBe(4);
    stop();
  });
});

describe("follow-up: effects created by a speculatively evaluated getter", () => {
  it("disposes them when the attempt is aborted", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(0);
    const tick = runtime.signal(0);
    let live = 0;
    const owner = runtime.computed(() => {
      runtime.effect(() => { void tick.value; live += 1; return () => { live -= 1; }; });
      return source.value;
    });

    renderAttempt(runtime, () => owner.value);
    expect(live).toBe(0);
    tick.value = 1;
    expect(live).toBe(0);
  });

  it("leaves exactly one owned child once the computed is committed", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(0);
    const tick = runtime.signal(0);
    let live = 0;
    let runs = 0;
    const owner = runtime.computed(() => {
      runtime.effect(() => { void tick.value; runs += 1; live += 1; return () => { live -= 1; }; });
      return source.value;
    });

    const { attempt } = renderAttempt(runtime, () => owner.value);
    commitNeedsRerender(runtime, attempt);
    const stop = runtime.effect(() => { void owner.value; });
    expect(live).toBe(1);
    const before = runs;
    tick.value = 1;
    expect(runs).toBe(before + 1);
    source.value = 1;
    expect(live).toBe(1);
    stop();
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    expect(live).toBe(0);
  });

  it("disposes another copy's effect created by the speculative getter", () => {
    const app = createReactiveRuntime();
    const library = createReactiveRuntime();
    const tick = library.signal(0);
    let live = 0;
    const owner = app.computed(() => {
      library.effect(() => { void tick.value; live += 1; return () => { live -= 1; }; });
      return 1;
    });

    renderAttempt(app, () => owner.value);
    expect(live).toBe(0);
    expect(library.hasSubscribers(tick)).toBe(false);
  });

  it("leaves no child alive after a tracked component unmounts", async () => {
    const source = signal(0);
    const tick = signal(0);
    let live = 0;
    const owner = computed(() => {
      effect(() => { void tick.value; live += 1; return () => { live -= 1; }; });
      return source.value;
    });
    function View() {
      useSignalTracking();
      return <p>{owner.value}</p>;
    }

    const view = render(<View />);
    expect(live).toBe(1);
    for (const next of [1, 2, 3]) act(() => { source.value = next; });
    expect(live).toBe(1);
    view.unmount();
    await Promise.resolve();
    expect(live).toBe(0);
  });
});

/** A warm local computed whose foreign dependency moved before the server read. */
function setup(foreignComputed: boolean) {
  const library = createReactiveRuntime();
  const source = library.signal(1);
  const tripled = library.computed(() => source.value * 3);
  const value = computed(() => (foreignComputed ? tripled.value : source.value) * 2);
  expect(value.value).toBe(foreignComputed ? 6 : 2);
  source.value = 5; // the foreign revision moves after the warm read
  function View() {
    useSignalTracking();
    return <p>{value.value}</p>;
  }
  return { View, expected: String(foreignComputed ? 30 : 10) };
}

describe("follow-up: server rendering a local computed over another copy", () => {
  for (const foreignComputed of [false, true]) {
    const kind = foreignComputed ? "computed" : "signal";

    it(`renderToString emits the current value over a foreign ${kind}`, () => {
      const { View, expected } = setup(foreignComputed);
      expect(renderToString(<View />)).toBe(`<p>${expected}</p>`);
    });

    it(`renderToPipeableStream emits the current value over a foreign ${kind}`, async () => {
      const { View, expected } = setup(foreignComputed);
      const html = await new Promise<string>((resolve, reject) => {
        const sink = new PassThrough();
        let text = "";
        sink.on("data", (chunk: Buffer) => { text += chunk.toString(); });
        sink.on("end", () => resolve(text));
        const stream = renderToPipeableStream(<View />, {
          onAllReady() { stream.pipe(sink); },
          onError: reject,
        });
      });
      expect(html).toBe(`<p>${expected}</p>`);
    });
  }
});
