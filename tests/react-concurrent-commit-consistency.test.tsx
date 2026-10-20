/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

// A transition render yields between components. A signal written during such
// a yield must not reach the screen as a mixed commit, where components rendered
// before the write show the old value and the rest show the new one. React's
// guarantee for `useSyncExternalStore` is a render-end consistency check that
// calls each rendered `getSnapshot` again before committing; these tests record
// every commit (not just the settled DOM) to pin that each hook takes part in it.
//
// `act()` drains a transition without yielding, so these run with the act
// environment off and wait for React's real scheduler instead.
import { startTransition, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computed,
  deepSignal,
  signal,
  useDeepSignalValue,
  useSignalTracking,
  useSignalValue,
} from "../src/index.js";

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
let previousActEnvironment: boolean | undefined;
beforeEach(() => {
  previousActEnvironment = (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = false;
});

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

/** Spins past React's 5 ms frame so the work loop yields after this component. */
function spin(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* busy wait */ }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits for React's scheduler to reach a state, then a little longer so a
 * stray follow-up commit would still be recorded before the assertions.
 */
async function settle(reached: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!reached() && performance.now() < deadline) await wait(5);
  await wait(50);
}

const IDS = ["A", "B", "C", "D"] as const;

interface Harness {
  /** Each commit's layout-phase values, in commit order. */
  readonly commits: string[][];
  /** The DOM text right after each commit. */
  readonly screens: string[];
  /** The value each `Read` rendered with, including renders React discarded. */
  readonly renders: string[];
  /** Arms one write that runs while React yields after `A` renders. */
  armWrite(write: () => void): void;
  /** Renders `value` from inside the calling component; the read stays in its own render. */
  useCommitRecord(id: string, value: number): ReactNode;
  mount(children: () => ReactNode): Root;
}

function createHarness(): Harness {
  const commits: string[][] = [];
  const screens: string[] = [];
  const renders: string[] = [];
  const pending: string[] = [];
  let pendingWrite: (() => void) | undefined;
  let container: HTMLElement | undefined;

  function useCommitRecord(id: string, value: number): ReactNode {
    renders.push(`${id}${value}`);
    if (id === "A") {
      // The write lands in the microtask checkpoint at the yield, after A
      // rendered and before B does: a genuine mid-render external update.
      const write = pendingWrite;
      pendingWrite = undefined;
      if (write !== undefined) queueMicrotask(write);
      spin(8);
    }
    useLayoutEffect(() => {
      // Layout effects of one commit run synchronously together; a microtask
      // closes the group so a follow-up commit is recorded separately.
      if (pending.length === 0) {
        queueMicrotask(() => {
          commits.push([...pending]);
          screens.push(container?.textContent ?? "");
          pending.length = 0;
        });
      }
      pending.push(`${id}${value}`);
    });
    return <i>{value}</i>;
  }

  return {
    commits,
    screens,
    renders,
    armWrite(write) { pendingWrite = write; },
    useCommitRecord,
    mount(children) {
      container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      startTransition(() => root.render(<>{children()}</>));
      return root;
    },
  };
}

function expectConsistentCommits(harness: Harness, expected: string): void {
  expect(harness.commits.length, "at least one commit").toBeGreaterThan(0);
  for (const commit of harness.commits) {
    const values = new Set(commit.map((entry) => entry.slice(1)));
    expect(values.size, `mixed commit ${JSON.stringify(harness.commits)}`).toBe(1);
  }
  expect(harness.screens.at(-1)).toBe(expected);
}

/** Proves the write did happen mid-render, so a passing test is not vacuous. */
function expectWriteLandedMidRender(harness: Harness): void {
  expect(harness.renders[0]).toBe("A0");
  expect(harness.renders).toContain("B1");
}

/**
 * The torn transition render is discarded and redone once, synchronously, with
 * the new value: no partial follow-up commit and no further renders.
 */
const CORRECTED_RENDERS = ["A0", "B1", "C1", "D1", "A1", "B1", "C1", "D1"];
const CORRECTED_COMMITS = [["A1", "B1", "C1", "D1"]];

describe("transition mount with a signal written while React yields", () => {
  it("useSignalTracking never commits a mixed snapshot", async () => {
    const count = signal(0);
    const harness = createHarness();
    function Tracked({ id }: { id: string }) {
      useSignalTracking();
      return harness.useCommitRecord(id, count.value);
    }
    harness.armWrite(() => { count.value = 1; });
    harness.mount(() => IDS.map((id) => <Tracked key={id} id={id} />));
    await settle(() => harness.screens.at(-1) === "1111");
    expectWriteLandedMidRender(harness);
    expectConsistentCommits(harness, "1111");
    expect(harness.renders).toEqual(CORRECTED_RENDERS);
    expect(harness.commits).toEqual(CORRECTED_COMMITS);
  });

  it("useSignalTracking detects a change behind a computed read", async () => {
    const count = signal(0);
    const doubled = computed(() => count.value * 2);
    const harness = createHarness();
    function Tracked({ id }: { id: string }) {
      useSignalTracking();
      return harness.useCommitRecord(id, doubled.value / 2);
    }
    harness.armWrite(() => { count.value = 1; });
    harness.mount(() => IDS.map((id) => <Tracked key={id} id={id} />));
    await settle(() => harness.screens.at(-1) === "1111");
    expectWriteLandedMidRender(harness);
    expectConsistentCommits(harness, "1111");
    expect(harness.renders).toEqual(CORRECTED_RENDERS);
    expect(harness.commits).toEqual(CORRECTED_COMMITS);
  });

  it("useDeepSignalValue never commits a mixed snapshot", async () => {
    const state = deepSignal({ n: 0 });
    const harness = createHarness();
    function Selected({ id }: { id: string }) {
      const n = useDeepSignalValue(state, (value) => value.n);
      return harness.useCommitRecord(id, n);
    }
    harness.armWrite(() => { state.value.n = 1; });
    harness.mount(() => IDS.map((id) => <Selected key={id} id={id} />));
    await settle(() => harness.screens.at(-1) === "1111");
    expectWriteLandedMidRender(harness);
    expectConsistentCommits(harness, "1111");
    expect(harness.renders).toEqual(CORRECTED_RENDERS);
    expect(harness.commits).toEqual(CORRECTED_COMMITS);
  });

  it("useSignalValue keeps its consistent commit", async () => {
    const count = signal(0);
    const harness = createHarness();
    function Leaf({ id }: { id: string }) {
      const value = useSignalValue(count);
      return harness.useCommitRecord(id, value);
    }
    harness.armWrite(() => { count.value = 1; });
    harness.mount(() => IDS.map((id) => <Leaf key={id} id={id} />));
    await settle(() => harness.screens.at(-1) === "1111");
    expectWriteLandedMidRender(harness);
    expectConsistentCommits(harness, "1111");
    expect(harness.renders).toEqual(CORRECTED_RENDERS);
    expect(harness.commits).toEqual(CORRECTED_COMMITS);
  });

  it("a mixed tree of all three hooks commits one consistent value", async () => {
    const count = signal(0);
    const state = deepSignal({ n: 0 });
    const harness = createHarness();
    function Tracked({ id }: { id: string }) {
      useSignalTracking();
      return harness.useCommitRecord(id, count.value);
    }
    function Selected({ id }: { id: string }) {
      const n = useDeepSignalValue(state, (value) => value.n);
      return harness.useCommitRecord(id, n);
    }
    function Leaf({ id }: { id: string }) {
      const value = useSignalValue(count);
      return harness.useCommitRecord(id, value);
    }
    harness.armWrite(() => { count.value = 1; state.value.n = 1; });
    harness.mount(() => [
      <Tracked key="A" id="A" />,
      <Selected key="B" id="B" />,
      <Leaf key="C" id="C" />,
      <Selected key="D" id="D" />,
    ]);
    await settle(() => harness.screens.at(-1) === "1111");
    expectWriteLandedMidRender(harness);
    expectConsistentCommits(harness, "1111");
    expect(harness.renders).toEqual(CORRECTED_RENDERS);
    expect(harness.commits).toEqual(CORRECTED_COMMITS);
  });
});

describe("transition update with a signal written while React yields", () => {
  for (const kind of ["tracking", "deep", "leaf"] as const) {
    it(`${kind}: every commit is consistent and the final screen is current`, async () => {
      const count = signal(0);
      const state = deepSignal({ n: 0 });
      const harness = createHarness();
      function TrackedItem({ id }: { id: string; tick: number }) {
        useSignalTracking();
        return harness.useCommitRecord(id, count.value);
      }
      function DeepItem({ id }: { id: string; tick: number }) {
        const n = useDeepSignalValue(state, (value) => value.n);
        return harness.useCommitRecord(id, n);
      }
      function LeafItem({ id }: { id: string; tick: number }) {
        const value = useSignalValue(count);
        return harness.useCommitRecord(id, value);
      }
      const Item = { tracking: TrackedItem, deep: DeepItem, leaf: LeafItem }[kind];
      const root = harness.mount(() => IDS.map((id) => <Item key={id} id={id} tick={0} />));
      await settle(() => harness.commits.length > 0);
      harness.commits.length = 0;
      harness.screens.length = 0;
      harness.renders.length = 0;
      harness.armWrite(() => { count.value = 1; state.value.n = 1; });
      startTransition(() => root.render(<>{IDS.map((id) => <Item key={id} id={id} tick={1} />)}</>));
      await settle(() => harness.screens.at(-1) === "1111");
      expectWriteLandedMidRender(harness);
      expectConsistentCommits(harness, "1111");
      expect(harness.screens.at(-1)).toBe("1111");
    });
  }
});

describe("transition renders without a concurrent write", () => {
  for (const kind of ["tracking", "deep", "leaf"] as const) {
    it(`${kind}: mount and update render each component once and commit once`, async () => {
      const count = signal(0);
      const state = deepSignal({ n: 0 });
      const doubled = computed(() => count.value * 2);
      const harness = createHarness();
      function TrackedItem({ id }: { id: string; tick: number }) {
        useSignalTracking();
        return harness.useCommitRecord(id, count.value + doubled.value);
      }
      function DeepItem({ id }: { id: string; tick: number }) {
        const n = useDeepSignalValue(state, (value) => value.n);
        return harness.useCommitRecord(id, n);
      }
      function LeafItem({ id }: { id: string; tick: number }) {
        const value = useSignalValue(count);
        return harness.useCommitRecord(id, value);
      }
      const Item = { tracking: TrackedItem, deep: DeepItem, leaf: LeafItem }[kind];
      const root = harness.mount(() => IDS.map((id) => <Item key={id} id={id} tick={0} />));
      await settle(() => harness.commits.length > 0);
      expect(harness.renders).toEqual(["A0", "B0", "C0", "D0"]);
      expect(harness.commits).toEqual([["A0", "B0", "C0", "D0"]]);

      harness.renders.length = 0;
      harness.commits.length = 0;
      startTransition(() => root.render(<>{IDS.map((id) => <Item key={id} id={id} tick={1} />)}</>));
      await settle(() => harness.commits.length > 0);
      expect(harness.renders).toEqual(["A0", "B0", "C0", "D0"]);
      expect(harness.commits).toEqual([["A0", "B0", "C0", "D0"]]);
    });
  }
});

describe("subscriptions after concurrent commits", () => {
  for (const kind of ["tracking", "deep", "leaf"] as const) {
    it(`${kind}: a re-render forced by the consistency check leaves no subscription after unmount`, async () => {
      const count = signal(0);
      const state = deepSignal({ n: 0 });
      let evaluations = 0;
      const observed = computed(() => {
        evaluations += 1;
        return count.value + state.value.n;
      });
      const harness = createHarness();
      function TrackedItem({ id }: { id: string }) {
        useSignalTracking();
        return harness.useCommitRecord(id, observed.value);
      }
      function DeepItem({ id }: { id: string }) {
        const n = useDeepSignalValue(state, (value) => {
          evaluations += 1;
          return value.n + count.value;
        });
        return harness.useCommitRecord(id, n);
      }
      function LeafItem({ id }: { id: string }) {
        const value = useSignalValue(observed);
        return harness.useCommitRecord(id, value);
      }
      const Item = { tracking: TrackedItem, deep: DeepItem, leaf: LeafItem }[kind];
      harness.armWrite(() => { count.value = 1; });
      const root = harness.mount(() => IDS.map((id) => <Item key={id} id={id} />));
      await settle(() => harness.screens.at(-1) === "1111");
      expectConsistentCommits(harness, "1111");

      // Still live after the corrective render.
      state.value.n = 1;
      await settle(() => harness.screens.at(-1) === "2222");
      expect(harness.screens.at(-1)).toBe("2222");

      root.unmount();
      roots.splice(roots.indexOf(root), 1);
      await wait(10);
      const before = evaluations;
      count.value = 5;
      state.value.n = 5;
      await wait(10);
      // Nothing observes `observed` any more: a write no longer evaluates it.
      expect(evaluations).toBe(before);
    });
  }
});
