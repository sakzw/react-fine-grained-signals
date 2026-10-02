// @vitest-environment jsdom

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// A2 through real React: a render yields between a parent and its child, a
// write lands in the gap, and the child (rendered later) commits first. That
// needs a genuine mid-render yield, which only React's mock scheduler gives
// deterministically. react-dom is loaded by Node (not Vite), so the mock is
// installed in its require cache before React loads; Vitest runs each test
// file in its own worker, so no other file sees it.
const requireFromReactDom = createRequire(createRequire(import.meta.url).resolve("react-dom/package.json"));
const schedulerPath = requireFromReactDom.resolve("scheduler");
const mockScheduler = requireFromReactDom("scheduler/unstable_mock") as {
  log(value: unknown): void;
  unstable_clearLog(): unknown[];
  unstable_flushNumberOfYields(count: number): void;
  unstable_flushAllWithoutAsserting(): boolean;
};
requireFromReactDom.cache[schedulerPath] = {
  id: schedulerPath,
  filename: schedulerPath,
  loaded: true,
  exports: mockScheduler,
} as NodeJS.Module;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { computed, signal, useSignalTracking } = await import("../src/index.js");

async function drain(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    mockScheduler.unstable_flushAllWithoutAsserting();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("A2 through a concurrent React render", () => {
  for (const warm of [false, true]) {
    it(`does not commit a parent and child that disagree (${warm ? "warm" : "cold"} computed)`, async () => {
      mockScheduler.unstable_clearLog();
      const source = signal(1);
      const scaled = computed(() => source.value * 10);
      const initial = warm ? scaled.value : 10;
      expect(initial).toBe(10);

      function Child() {
        useSignalTracking();
        const value = scaled.value;
        mockScheduler.log(`child:${value}`);
        return React.createElement("span", { id: "child" }, String(value));
      }
      function Parent() {
        useSignalTracking();
        const value = scaled.value;
        mockScheduler.log(`parent:${value}`);
        return React.createElement("div", null,
          React.createElement("b", { id: "parent" }, String(value)),
          React.createElement(Child));
      }

      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      React.startTransition(() => root.render(React.createElement(Parent)));
      await Promise.resolve();
      await Promise.resolve();
      mockScheduler.unstable_flushNumberOfYields(1);
      expect(mockScheduler.unstable_clearLog()).toEqual(["parent:10"]);

      source.value = 2; // e.g. an event handled while React yields
      await drain();
      const text = (id: string) => container.querySelector(`#${id}`)!.textContent;
      expect([text("parent"), text("child")]).toEqual(["20", "20"]);
      expect(mockScheduler.unstable_clearLog()).toContain("parent:20");

      source.value = 3;
      await drain();
      expect([text("parent"), text("child")]).toEqual(["30", "30"]);
      root.unmount();
      container.remove();
    });
  }
});
