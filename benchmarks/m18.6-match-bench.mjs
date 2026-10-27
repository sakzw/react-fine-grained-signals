// Run `pnpm build:runtime && node benchmarks/m18.6-match-bench.mjs`.
// This is a small JSDOM comparison; use a browser profiler for product-level claims.
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { signal, useComputed, useSignalTracking } from "../dist/index.js";
import { Match, Switch } from "../dist/utils.js";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost" });
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const h = React.createElement;
const samples = Number(process.env.SAMPLES ?? 20);
const strategies = ["parent-read", "useComputed", "match-equals"];

function run(strategy) {
  const source = signal(0);
  const metrics = { parentRenders: 0, branchRenders: 0 };

  function ParentRead() {
    metrics.parentRenders += 1;
    useSignalTracking();
    return h(Switch, {
      children: [
        h(Match, {
          when: source.value === 0,
          children: () => {
            metrics.branchRenders += 1;
            return h("p", null, "list");
          },
        }),
        h(Match, {
          when: source.value === 1,
          children: () => {
            metrics.branchRenders += 1;
            return h("p", null, "details");
          },
        }),
      ],
    });
  }

  function ComputedParent() {
    metrics.parentRenders += 1;
    const isList = useComputed(() => source.value === 0, []);
    const isDetails = useComputed(() => source.value === 1, []);
    return h(Switch, {
      children: [
        h(Match, {
          when: isList,
          children: () => {
            metrics.branchRenders += 1;
            return h("p", null, "list");
          },
        }),
        h(Match, {
          when: isDetails,
          children: () => {
            metrics.branchRenders += 1;
            return h("p", null, "details");
          },
        }),
      ],
    });
  }

  function EqualsParent() {
    metrics.parentRenders += 1;
    return h(Switch, {
      children: [
        h(Match, {
          when: source,
          equals: 0,
          children: () => {
            metrics.branchRenders += 1;
            return h("p", null, "list");
          },
        }),
        h(Match, {
          when: source,
          equals: 1,
          children: () => {
            metrics.branchRenders += 1;
            return h("p", null, "details");
          },
        }),
      ],
    });
  }

  const Parent = strategy === "parent-read" ? ParentRead : strategy === "useComputed" ? ComputedParent : EqualsParent;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const initialStart = performance.now();
  React.act(() => root.render(h(Parent)));
  const initialMs = performance.now() - initialStart;
  const parentBefore = metrics.parentRenders;
  const updateStart = performance.now();
  React.act(() => {
    source.value = 1;
  });
  const updateMs = performance.now() - updateStart;
  const parentDelta = metrics.parentRenders - parentBefore;
  const selected = container.textContent;
  const unmountStart = performance.now();
  React.act(() => root.unmount());
  const unmountMs = performance.now() - unmountStart;
  container.remove();
  return { initialMs, updateMs, unmountMs, parentDelta, branchRenders: metrics.branchRenders, selected };
}

for (const strategy of strategies) {
  for (let i = 0; i < 3; i += 1) run(strategy);
  const results = Array.from({ length: samples }, () => run(strategy));
  const summarize = (key) => {
    const ordered = results.map((result) => result[key]).toSorted((a, b) => a - b);
    return {
      median: Number(ordered[Math.floor(ordered.length / 2)].toFixed(3)),
      min: Number(ordered[0].toFixed(3)),
      max: Number(ordered.at(-1).toFixed(3)),
    };
  };
  console.log(
    JSON.stringify({
      strategy,
      samples,
      initialMs: summarize("initialMs"),
      updateMs: summarize("updateMs"),
      unmountMs: summarize("unmountMs"),
      parentRenderDelta: results.map((result) => result.parentDelta),
      branchCallbacks: results.map((result) => result.branchRenders),
      selected: [...new Set(results.map((result) => result.selected))],
    }),
  );
}
