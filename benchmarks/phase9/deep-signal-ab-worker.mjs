import { loadAdapter } from "./adapters.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const input = JSON.parse(process.argv[2] ?? "{}");
const { runtimeId, workload, iterations, size = 1, warmups, samples } = input;
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

if (!runtimeId || !workload || !Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error("Worker needs runtimeId, workload, and a positive iterations count.");
}
if (!Number.isSafeInteger(warmups) || warmups < 0 || !Number.isSafeInteger(samples) || samples < 1) {
  throw new Error("Worker needs non-negative warmups and positive samples counts.");
}
if (typeof global.gc !== "function") throw new Error("DeepSignal measurements require --expose-gc.");

let api;
if (/^rfsg-(?:W0|P[0-2])$/.test(runtimeId)) {
  const name = runtimeId.slice("rfsg-".length);
  const variant = await import(pathToFileURL(resolve(import.meta.dirname, `source-hot-path/variants/${name}/dist/index.js`)));
  api = {
    runtimeId,
    signal: variant.signal,
    read: (source) => source.value,
    write: (source, value) => { source.value = value; },
    computed: variant.computed,
    readComputed: (value) => value.value,
    effect: variant.effect,
    dispose: (stop) => stop(),
    batch: variant.batch,
    supportsBatch: true,
    deepSignal: variant.deepSignal,
  };
} else {
  api = await loadAdapter(runtimeId);
}
if (typeof api.deepSignal !== "function") throw new Error(`${runtimeId} does not provide deepSignal.`);

function verifyDeepSignalSemantics() {
  const disposers = [];
  try {
    const nested = api.deepSignal({ user: { profile: { name: "Ada" }, name: "Ada", age: 36 } });
    let nestedRuns = 0;
    disposers.push(api.effect(() => { nested.value.user.profile.name; nestedRuns += 1; }));
    assert(nestedRuns === 1, "Nested subscriber did not run on creation.");
    nested.value.user.profile.name = "Grace";
    assert(nestedRuns === 2, "Nested property update did not rerun its subscriber.");

    let siblingRuns = 0;
    disposers.push(api.effect(() => { nested.value.user.name; siblingRuns += 1; }));
    nested.value.user.age += 1;
    assert(siblingRuns === 1, "Unread sibling update reran a name-only subscriber.");

    const keys = api.deepSignal({ record: {} });
    let valueRuns = 0;
    let existenceRuns = 0;
    let iterationRuns = 0;
    disposers.push(api.effect(() => { keys.value.record.count; valueRuns += 1; }));
    disposers.push(api.effect(() => { "count" in keys.value.record; existenceRuns += 1; }));
    disposers.push(api.effect(() => { Object.keys(keys.value.record).join(","); iterationRuns += 1; }));
    keys.value.record.count = 1;
    assert(valueRuns === 2 && existenceRuns === 2 && iterationRuns === 2, "Adding a property did not invalidate value/existence/iteration dependencies exactly once.");
    delete keys.value.record.count;
    assert(valueRuns === 3 && existenceRuns === 3 && iterationRuns === 3, "Property deletion did not invalidate value/existence/iteration dependencies exactly once.");

    const array = api.deepSignal({ items: ["first"] });
    let indexRuns = 0;
    let lengthRuns = 0;
    disposers.push(api.effect(() => { array.value.items[1]; indexRuns += 1; }));
    disposers.push(api.effect(() => { array.value.items.length; lengthRuns += 1; }));
    array.value.items[1] = "second";
    assert(indexRuns === 2 && lengthRuns === 2, "Array index extension did not invalidate index and length subscribers.");
    array.value.items.length = 1;
    assert(indexRuns === 3 && lengthRuns === 3, "Array length truncation did not invalidate index and length subscribers.");

    const shared = { count: 1 };
    const rawCycle = { left: shared, right: shared };
    rawCycle.self = rawCycle;
    const aliases = api.deepSignal(rawCycle);
    assert(aliases.value.left === aliases.value.right && aliases.value.self === aliases.value, "DeepSignal did not preserve aliases/cycles.");
    let aliasRuns = 0;
    disposers.push(api.effect(() => { aliases.value.left.count; aliasRuns += 1; }));
    aliases.value.right.count = 2;
    assert(aliasRuns === 2, "An aliased property update did not notify its subscriber.");

    const disposed = api.deepSignal({ value: 0 });
    let disposedRuns = 0;
    const stop = api.effect(() => { disposed.value.value; disposedRuns += 1; });
    api.dispose(stop);
    disposed.value.value = 1;
    assert(disposedRuns === 1, "Disposed effect continued observing DeepSignal.");
  } finally {
    for (const dispose of disposers) api.dispose(dispose);
  }
}

function makeRepresentativeState(index) {
  return {
    user: { profile: { name: `Ada-${index}`, age: 36 }, active: true },
    items: [{ id: index, value: index }, { id: index + 1, value: index + 1 }],
  };
}

function makeWorkload() {
  if (workload === "deepSignal/create") {
    const inputs = Array.from({ length: iterations }, (_, index) => makeRepresentativeState(index));
    const outputs = Array.from({ length: iterations });
    return {
      run() {
        for (let index = 0; index < iterations; index += 1) outputs[index] = api.deepSignal(inputs[index]);
      },
      verify() {
        assert(outputs.length === iterations && outputs.at(-1)?.value.user.profile.name === `Ada-${iterations - 1}`, "DeepSignal creation returned an invalid root.");
      },
      dispose() { outputs.fill(undefined); inputs.fill(undefined); },
    };
  }

  if (workload === "rfsg/deepSignal-read") {
    const state = api.deepSignal({ branch: { leaf: 7 } });
    let sum = 0;
    return {
      run() {
        sum = 0;
        for (let index = 0; index < iterations; index += 1) sum += state.value.branch.leaf;
      },
      verify() { assert(sum === iterations * 7, "DeepSignal read checksum is wrong."); },
    };
  }

  if (workload === "rfsg/deepSignal-watched-leaf-write") {
    const state = api.deepSignal({ branch: { leaf: 0 } });
    let runs = 0;
    const stop = api.effect(() => { state.value.branch.leaf; runs += 1; });
    return {
      run() {
        for (let index = 0; index < iterations; index += 1) state.value.branch.leaf = index + 1;
      },
      verify() {
        assert(state.value.branch.leaf === iterations, "DeepSignal watched write ended with a wrong value.");
        assert(runs === iterations + 1, `Expected ${iterations + 1} exact reactions, got ${runs}.`);
      },
      dispose() { api.dispose(stop); },
    };
  }

  if (workload === "deepSignal/nested-tracked-read") {
    const state = api.deepSignal({ user: { profile: { name: "Ada", age: 36 } } });
    const trigger = api.signal(0);
    let runs = 0;
    let checksum = 0;
    const stop = api.effect(() => {
      api.read(trigger);
      checksum += state.value.user.profile.name.length;
      runs += 1;
    });
    return {
      run() {
        for (let index = 1; index <= iterations; index += 1) api.write(trigger, index);
      },
      verify() {
        assert(runs === iterations + 1, `Nested tracked read expected ${iterations + 1} effect runs, got ${runs}.`);
        assert(checksum === (iterations + 1) * 3, "Nested tracked read checksum is wrong.");
      },
      dispose() { api.dispose(stop); },
    };
  }

  if (workload === "deepSignal/unwatched-sibling-write") {
    const state = api.deepSignal({ user: { name: "Ada", age: 36 } });
    let runs = 0;
    const stop = api.effect(() => { state.value.user.name; runs += 1; });
    return {
      run() {
        for (let index = 0; index < iterations; index += 1) state.value.user.age = index + 37;
      },
      verify() {
        assert(state.value.user.age === iterations + 36, "Sibling-write final value is wrong.");
        assert(runs === 1, `Unread sibling write reran the subscriber ${runs - 1} times.`);
      },
      dispose() { api.dispose(stop); },
    };
  }

  if (workload === "deepSignal/many-watched-leaves") {
    if (!Number.isSafeInteger(size) || size < 1) throw new Error("Many-leaf workload needs a positive size.");
    const state = api.deepSignal({ leaves: Array.from({ length: size }, () => ({ value: 0 })) });
    const runs = Array.from({ length: size }, () => 0);
    const stops = Array.from({ length: size }, (_, leaf) => api.effect(() => {
      state.value.leaves[leaf].value;
      runs[leaf] += 1;
    }));
    return {
      run() {
        for (let index = 0; index < iterations; index += 1) {
          const leaf = index % size;
          state.value.leaves[leaf].value = index + 1;
        }
      },
      verify() {
        for (let leaf = 0; leaf < size; leaf += 1) {
          const expected = 1 + Math.floor(iterations / size) + (leaf < iterations % size ? 1 : 0);
          assert(runs[leaf] === expected, `Leaf ${leaf} expected ${expected} exact effect runs, got ${runs[leaf]}.`);
        }
      },
      dispose() { for (const stop of stops) api.dispose(stop); },
    };
  }

  throw new Error(`Unknown DeepSignal A/B workload: ${workload}`);
}

function execute(timed) {
  const sample = makeWorkload();
  try {
    if (!timed) {
      sample.run();
      sample.verify();
      return { durationNs: 0 };
    }
    const startedAt = performance.now();
    sample.run();
    const durationNs = Math.round((performance.now() - startedAt) * 1e6);
    sample.verify();
    return { durationNs };
  } finally {
    sample.dispose?.();
  }
}

try {
  verifyDeepSignalSemantics();
  global.gc();
  execute(false);
  for (let index = 0; index < warmups; index += 1) {
    global.gc();
    execute(false);
  }
  const measured = [];
  for (let sample = 0; sample < samples; sample += 1) {
    global.gc();
    const result = execute(true);
    measured.push({ sample: sample + 1, durationNs: result.durationNs });
  }
  process.stdout.write(JSON.stringify({
    status: "ok",
    semanticAssertions: "passed",
    preflight: "passed",
    gcExposed: true,
    operationCount: iterations,
    measured,
  }));
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
