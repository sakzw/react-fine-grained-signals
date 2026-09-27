export const RUNTIME_BASELINE_SHA = "c5d1796cfa2063db7eecb99e537209de185a530c";
export const RELEASED_TAG = "v0.1.1";
export const RELEASED_COMMIT = "0e12bbf46ab098fbb2388704ab85c3c406189cbb";
export const CURRENT_PACKAGE_VERSION = "0.1.1";
export const ALIEN_VERSION = "3.2.1";
export const VUE_PACKAGE_VERSION = "3.6.0-rc.9";
export const VUE_CORE_COMMIT = "5be279570a844b953dd44b56bdc2426f7421aecd";

export const runtimes = [
  { id: "rfsg-v0.1.1", version: "0.1.1", package: "react-fine-grained-signals@0.1.1" },
  { id: "rfsg-current", version: CURRENT_PACKAGE_VERSION, package: "workspace runtime at c5d1796" },
  { id: "alien-signals", version: ALIEN_VERSION, package: "alien-signals@3.2.1" },
  { id: "vue-reactivity", version: VUE_PACKAGE_VERSION, package: "@vue/reactivity@3.6.0-rc.9" },
];

const balancedRuntimeOrderIds = [
  ["rfsg-v0.1.1", "rfsg-current", "vue-reactivity", "alien-signals"],
  ["rfsg-current", "alien-signals", "rfsg-v0.1.1", "vue-reactivity"],
  ["alien-signals", "vue-reactivity", "rfsg-current", "rfsg-v0.1.1"],
  ["vue-reactivity", "rfsg-v0.1.1", "alien-signals", "rfsg-current"],
];

const runtimesById = new Map(runtimes.map((runtime) => [runtime.id, runtime]));

export function runtimeOrderForRound(roundNumber) {
  if (!Number.isSafeInteger(roundNumber) || roundNumber < 1) {
    throw new Error("roundNumber must be a positive integer.");
  }
  const scheduledIds = balancedRuntimeOrderIds[(roundNumber - 1) % balancedRuntimeOrderIds.length];
  return scheduledIds.map((id) => {
    const runtime = runtimesById.get(id);
    if (!runtime) throw new Error(`Balanced runtime schedule references unknown runtime: ${id}`);
    return runtime;
  });
}

export const commonCases = [
  { id: "source/create", kind: "source-create", iterations: 20_000 },
  { id: "source/read", kind: "source-read", iterations: 100_000 },
  { id: "source/unobserved-write", kind: "source-unobserved-write", iterations: 50_000 },
  { id: "source/write-read", kind: "source-write-read", iterations: 50_000 },
  { id: "effect/create", kind: "effect-create", iterations: 5_000 },
  { id: "effect/create-dispose", kind: "effect-create-dispose", iterations: 5_000 },
  { id: "effect/observed-write", kind: "effect-observed-write", iterations: 10_000 },
  { id: "effect/fanout", kind: "effect-fanout", iterations: 2_000, sizes: [1, 16, 64] },
  { id: "effect/dynamic-dependencies", kind: "effect-dynamic", iterations: 5_000 },
  { id: "computed/create", kind: "computed-create", iterations: 5_000 },
  { id: "computed/dirty-read", kind: "computed-dirty-read", iterations: 10_000 },
  { id: "computed/dirty-unread", kind: "computed-dirty-unread", iterations: 10_000 },
  { id: "computed/equality-suppression", kind: "computed-equality", iterations: 10_000 },
  { id: "computed/source-to-many", kind: "computed-fanout", iterations: 2_000, sizes: [1, 16, 64] },
  { id: "computed/many-to-one", kind: "computed-fanin", iterations: 5_000, sizes: [1, 16, 64] },
  { id: "batch/two-writes-one-reaction", kind: "batch-two-writes", iterations: 5_000 },
  { id: "diagnostic/adapter-read-dispatch", kind: "adapter-read-diagnostic", iterations: 100_000 },
];

export const rfsgCases = [
  { id: "rfsg/deepSignal-read", kind: "deep-read", iterations: 50_000, runtimes: ["rfsg-v0.1.1", "rfsg-current"] },
  { id: "rfsg/deepSignal-watched-leaf-write", kind: "deep-watched-write", iterations: 5_000, runtimes: ["rfsg-v0.1.1", "rfsg-current"] },
  { id: "rfsg/react-bare-tracking", kind: "bare", iterations: 250, runtimes: ["rfsg-v0.1.1", "rfsg-current"], react: true },
  { id: "rfsg/react-managed-tracking", kind: "managed", iterations: 250, runtimes: ["rfsg-v0.1.1", "rfsg-current"], react: true },
  { id: "rfsg/react-useSignalValue", kind: "useSignalValue", iterations: 250, runtimes: ["rfsg-v0.1.1", "rfsg-current"], react: true },
  { id: "rfsg/react-jsx-direct-binding", kind: "jsx-binding", iterations: 250, runtimes: ["rfsg-v0.1.1", "rfsg-current"], react: true },
];

export const smokeCases = new Set([
  "source/create",
  "source/read",
  "source/unobserved-write",
  "source/write-read",
  "effect/create-dispose",
  "effect/create",
  "effect/observed-write",
  "effect/fanout",
  "effect/dynamic-dependencies",
  "computed/create",
  "computed/dirty-read",
  "computed/dirty-unread",
  "computed/equality-suppression",
  "computed/source-to-many",
  "computed/many-to-one",
  "batch/two-writes-one-reaction",
  "diagnostic/adapter-read-dispatch",
  "rfsg/deepSignal-read",
  "rfsg/deepSignal-watched-leaf-write",
  "rfsg/react-bare-tracking",
  "rfsg/react-managed-tracking",
  "rfsg/react-useSignalValue",
  "rfsg/react-jsx-direct-binding",
]);

export const allocationWorkloadIds = [
  "signal-computed-effect-graph",
  "one-source-many-effects",
  "deep-watched-leaves",
];
